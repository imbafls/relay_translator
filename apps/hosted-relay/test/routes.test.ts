import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { insecureRedirect, installerName, resolveRoute } from "../src/routes";
import { formatToken, newRoomId, newSecret, parseToken, secretsMatch } from "../src/tokens";

/**
 * The router and the token format, which are the two halves of this service
 * that can be wrong in a way Cloudflare will not tell you about quickly: a
 * routing mistake serves an unstyled page, and a token mistake either breaks
 * every existing link or hands one room's captions to another.
 *
 * Both are pure, so they are tested here against the same rules the shipped
 * single-tenant relay and the shipped viewer already enforce.
 */

describe("serving the viewer page and its assets", () => {
  it("treats a token path as the page", () => {
    const r = resolveRoute("/watch/v1_abcdef0123456789_0123456789abcdef0123456789abcdef");
    expect(r.kind).toBe("viewer-page");
  });

  it("treats a filename under /watch/ as an asset, because the page asks relatively", () => {
    // index.html says href="style.css", so a page at /watch/<token> requests
    // /watch/style.css. Getting this wrong serves a bare page with no script.
    for (const f of ["style.css", "app.js", "fonts/fonts.css"]) {
      const r = resolveRoute(`/watch/${f}`);
      expect(r.kind, `${f} should be an asset`).toBe("asset");
      if (r.kind === "asset") expect(r.rel).toBe(f);
    }
  });

  it("tells them apart by the dot, exactly as the existing relay does", () => {
    // a token can never contain a dot; a filename always does
    expect(resolveRoute("/watch/abc123").kind).toBe("viewer-page");
    expect(resolveRoute("/watch/abc.123").kind).toBe("asset");
  });

  it("serves the landing page at the root and at bare /watch", () => {
    for (const p of ["/", "/watch", "/watch/"]) expect(resolveRoute(p).kind).toBe("home");
  });

  it("serves root-relative fonts, which the landing page uses", () => {
    const r = resolveRoute("/fonts/fonts.css");
    expect(r.kind).toBe("asset");
    if (r.kind === "asset") expect(r.rel).toBe("fonts/fonts.css");
  });

  it("refuses traversal out of the asset directory", () => {
    for (const p of ["/watch/../wrangler.toml", "/watch/a/../../x", "/watch//etc/passwd", "/fonts/../x"]) {
      expect(resolveRoute(p).kind, `${p} escaped`).toBe("not-found");
    }
  });
});

describe("the endpoints the desktop app already calls", () => {
  it("routes the uplink and viewer sockets", () => {
    expect(resolveRoute("/ws/uplink").kind).toBe("ws-uplink");
    expect(resolveRoute("/ws/viewer").kind).toBe("ws-viewer");
  });

  it("keeps /health, which the project uses to diagnose production", () => {
    expect(resolveRoute("/health").kind).toBe("health");
  });

  it("honours the method on the admin routes", () => {
    expect(resolveRoute("/admin/viewer-token", "GET").kind).toBe("viewer-token");
    expect(resolveRoute("/admin/viewer-token", "POST").kind).toBe("not-found");
    expect(resolveRoute("/admin/rotate-viewer-token", "POST").kind).toBe("rotate-viewer-token");
    expect(resolveRoute("/admin/rotate-viewer-token", "GET").kind).toBe("not-found");
    expect(resolveRoute("/claim", "POST").kind).toBe("claim");
    expect(resolveRoute("/claim", "GET").kind).toBe("not-found");
  });

  it("routes POST /feedback and refuses every other method", () => {
    expect(resolveRoute("/feedback", "POST").kind).toBe("feedback");
    expect(resolveRoute("/feedback", "GET").kind).toBe("not-found");
    expect(resolveRoute("/feedback", "PUT").kind).toBe("not-found");
  });
});

describe("room credentials", () => {
  const rid = newRoomId();
  const secret = newSecret();

  it("round-trips", () => {
    const t = formatToken("viewer", rid, secret);
    const p = parseToken(t);
    expect(p).toEqual({ kind: "viewer", rid, secret });
  });

  it("stays inside the alphabet every existing link check allows", () => {
    // packages/relay/src/server.ts and packages/viewer/public/app.js both match
    // /watch/([A-Za-z0-9_-]+) - a token outside that is an unreachable link
    for (const kind of ["publisher", "viewer"] as const) {
      const t = formatToken(kind, newRoomId(), newSecret());
      expect(t, `${kind} token has a character a /watch/ link cannot carry`).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(t, "a dot would be read as a filename by the asset route").not.toContain(".");
    }
  });

  it("survives the viewer's own token regex", () => {
    const t = formatToken("viewer", rid, secret);
    const m = `/watch/${t}`.match(/\/watch\/([A-Za-z0-9_-]+)/);
    expect(m?.[1]).toBe(t);
  });

  it("distinguishes a publisher token from a viewer token", () => {
    expect(parseToken(formatToken("publisher", rid, secret))?.kind).toBe("publisher");
    expect(parseToken(formatToken("viewer", rid, secret))?.kind).toBe("viewer");
  });

  it("rejects anything malformed rather than guessing", () => {
    for (const bad of [
      "",
      null,
      undefined,
      "nonsense",
      "p1_short_" + secret,
      "p1_" + rid + "_short",
      "x1_" + rid + "_" + secret,
      "p1_" + rid,
      "p1_" + rid + "_" + secret + "_extra",
      "p1_" + rid.toUpperCase() + "_" + secret,
    ]) {
      expect(parseToken(bad as string | null), `${String(bad)} parsed`).toBeNull();
    }
  });

  it("gives every room a different id and secret", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRoomId()));
    const secrets = new Set(Array.from({ length: 200 }, () => newSecret()));
    expect(ids.size).toBe(200);
    expect(secrets.size).toBe(200);
  });

  it("compares secrets without short-circuiting on the first difference", () => {
    expect(secretsMatch(secret, secret)).toBe(true);
    expect(secretsMatch(secret, newSecret())).toBe(false);
    expect(secretsMatch(secret, secret.slice(0, -1))).toBe(false);
    expect(secretsMatch(secret, undefined)).toBe(false);
    expect(secretsMatch(undefined, secret)).toBe(false);
  });
});

/**
 * A viewer link is `<origin>/watch/<viewerToken>`, and that token is the whole
 * credential - there is no password, no expiry and no device check. Over plain
 * HTTP it crosses the wire in the request line, in clear.
 *
 * Nothing was redirecting. `http://textrelay.cc/watch/<token>` answered 200
 * with the real page, on all three names, with no HSTS. The app itself always
 * builds `https://` (it stores `wss://` and derives the origin), so this is not
 * how a link is normally produced - but a link retyped without a scheme, or
 * pasted into something that defaults to http, hands the token to the network.
 *
 * Doing it in the Worker rather than with Cloudflare's zone setting means it
 * travels with the code and covers every name the Worker answers on, including
 * ones added later.
 */
describe("plain HTTP does not carry a viewer token in clear", () => {
  const at = (raw: string, upgrade: string | null = null): string | undefined =>
    insecureRedirect(new URL(raw), upgrade);

  it("sends a viewer link to https, keeping the token in the path", () => {
    const to = at("http://textrelay.cc/watch/v1_abcdef0123456789_0123456789abcdef0123456789abcdef");
    expect(to).toBe("https://textrelay.cc/watch/v1_abcdef0123456789_0123456789abcdef0123456789abcdef");
  });

  it("redirects every other page too, not just the one with the token in it", () => {
    expect(at("http://textrelay.cc/")).toBe("https://textrelay.cc/");
    expect(at("http://textrelay.cc/health")).toBe("https://textrelay.cc/health");
    expect(at("http://relay.supr.systems/watch/app.js")).toBe("https://relay.supr.systems/watch/app.js");
  });

  it("keeps the query string, which is where the room token goes on /health", () => {
    expect(at("http://textrelay.cc/health?token=v1_abcdef0123456789_0123456789abcdef0123456789abcdef")).toBe(
      "https://textrelay.cc/health?token=v1_abcdef0123456789_0123456789abcdef0123456789abcdef",
    );
  });

  it("leaves https alone", () => {
    expect(at("https://textrelay.cc/watch/v1_abcdef0123456789_0123456789abcdef0123456789abcdef")).toBeUndefined();
  });

  it("does not redirect a websocket upgrade, which cannot follow one", () => {
    // a 301 on an upgrade turns a working socket into a silent failure, and the
    // app dials wss:// anyway - this would only ever hit a hand-made ws:// client
    expect(at("http://textrelay.cc/ws/viewer?token=abc", "websocket")).toBeUndefined();
    expect(at("http://textrelay.cc/ws/viewer?token=abc", "WebSocket")).toBeUndefined();
  });

  it("leaves local development alone", () => {
    // `wrangler dev` serves over http on loopback; redirecting it to a
    // certificate that does not exist would make the thing unrunnable locally
    expect(at("http://localhost:8787/health")).toBeUndefined();
    expect(at("http://127.0.0.1:8787/watch/app.js")).toBeUndefined();
    expect(at("http://[::1]:8787/")).toBeUndefined();
  });
});

/**
 * A visitor who types `textrelay.cc` gets the product page, and its only call to
 * action was a greyed-out button reading "No build published yet" - for a
 * product on 0.5.9.
 *
 * `home.html` asks `/updates/latest.yml` for the version and links `/download`.
 * Both are routes the single-tenant Node relay serves from its own data dir
 * (`server.ts`), and the Worker never inherited them: it answered 404, the fetch
 * rejected, and the page disabled its own button. It failed soft, which is why
 * nobody noticed - it advertised the product as unreleased instead of erroring.
 *
 * The Worker has no data dir and should not have one. The builds live on the
 * GitHub release, which is also where the app's own updater reads them, so
 * these two routes point at the same place rather than inventing a second
 * source of truth.
 */
describe("the landing page can offer the build it is advertising", () => {
  it("routes the update feed the page asks for", () => {
    expect(resolveRoute("/updates/latest.yml").kind).toBe("update-feed");
  });

  it("routes the download the button points at", () => {
    expect(resolveRoute("/download").kind).toBe("download");
  });

  it("does not turn /updates/ into a general file server", () => {
    // the Node relay serves a directory here; the Worker has no directory, and
    // a path that looked like one would be a way to probe for one
    expect(resolveRoute("/updates/").kind).toBe("not-found");
    expect(resolveRoute("/updates/CalloutRelay-Setup-0.5.9.exe").kind).toBe("not-found");
    expect(resolveRoute("/updates/../secret").kind).toBe("not-found");
  });

  it("still serves everything it served before", () => {
    expect(resolveRoute("/").kind).toBe("home");
    expect(resolveRoute("/health").kind).toBe("health");
    expect(resolveRoute("/claim", "POST").kind).toBe("claim");
    expect(resolveRoute("/watch/v1_abcdef0123456789_0123456789abcdef0123456789abcdef").kind).toBe("viewer-page");
    expect(resolveRoute("/watch/app.js").kind).toBe("asset");
  });
});

describe("reading the installer out of the update feed", () => {
  /** the shape electron-builder writes, taken from the live v0.5.9 feed */
  const feed = [
    "version: 0.5.9",
    "files:",
    "  - url: CalloutRelay-Setup-0.5.9.exe",
    "    sha512: abc==",
    "    size: 88234378",
    "path: CalloutRelay-Setup-0.5.9.exe",
    "sha512: abc==",
    "releaseDate: '2026-09-07T08:31:00.000Z'",
  ].join("\n");

  it("finds the installer the feed names", () => {
    expect(installerName(feed)).toBe("CalloutRelay-Setup-0.5.9.exe");
  });

  it("reads the top-level path, not the indented url that comes before it", () => {
    // both lines carry the same filename today, but `url:` is nested under
    // `files:` and matching it would break the day they differ
    expect(installerName("files:\n  - url: WRONG.exe\npath: RIGHT.exe")).toBe("RIGHT.exe");
  });

  it("survives the CRLF a Windows build can write", () => {
    expect(installerName("version: 0.5.9\r\npath: CalloutRelay-Setup-0.5.9.exe\r\n")).toBe(
      "CalloutRelay-Setup-0.5.9.exe",
    );
  });

  it("gives back nothing rather than a guess when the feed is not one", () => {
    expect(installerName("")).toBeUndefined();
    expect(installerName("<!doctype html><title>404</title>")).toBeUndefined();
    expect(installerName("version: 0.5.9")).toBeUndefined();
  });
});

describe("what a crawler is allowed to ask for", () => {
  /**
   * A new domain has to hand a crawler three things before any of the writing
   * matters: a sitemap it can find, a robots file that points at it, and a
   * clear refusal on the pages that must never be indexed.
   *
   * These are routes rather than files in the asset directory on purpose.
   * `packages/viewer/public` is also the bundle the desktop app ships, and a
   * robots.txt naming textrelay.cc has no business inside somebody's local
   * relay on port 8787.
   */
  it("serves a sitemap and a robots file from the root", () => {
    expect(resolveRoute("/sitemap.xml").kind).toBe("sitemap");
    expect(resolveRoute("/robots.txt").kind).toBe("robots");
  });

  it("serves the images a link preview and a browser tab ask for at the root", () => {
    // home.html points at absolute /og.png and /favicon.svg; without a root
    // asset rule every one of them 404s and the page ships broken references.
    for (const f of ["og.png", "favicon.svg", "favicon.ico", "apple-touch-icon.png"]) {
      const r = resolveRoute(`/${f}`);
      expect(r.kind, `/${f} should be an asset`).toBe("asset");
      if (r.kind === "asset") expect(r.rel).toBe(f);
    }
  });

  it("does not turn the root into a file server", () => {
    // only the named files. Anything else at the root is still a 404, so a
    // new file dropped into the viewer bundle is never silently published.
    for (const p of ["/app.js", "/style.css", "/index.html", "/home.html", "/secrets.json"]) {
      expect(resolveRoute(p).kind, `${p} should not be served`).toBe("not-found");
    }
  });
});

/**
 * The three things that have to agree about an asset: the page that asks for
 * it, the router that decides whether it is servable, and the bundle it is
 * supposed to come out of.
 *
 * `check-renderer-ids.mjs` exists because a re-layout can drop an element while
 * the script still asks for it, and the page then fails silently in a browser
 * nobody is watching. This is the same failure one level out. A root-absolute
 * reference is served only if it is on the router's allowlist, so adding
 * `<link rel="icon" href="/icon-192.png">` and shipping the file is not enough
 * - the router 404s it, the icon quietly does not appear, and no test here
 * notices. The reverse is just as quiet: `og:image` points at `/og.png`, and if
 * that file left the bundle every shared link would lose its preview card while
 * every route test still passed.
 *
 * The references are read out of the shipped HTML rather than listed, so a new
 * one is covered the day it is added.
 */
describe("what the shipped pages ask the router for", () => {
  const publicDir = path.resolve(__dirname, "..", "..", "..", "packages", "viewer", "public");

  /** every root-absolute local reference in the shipped pages, with its page */
  function rootRefs(): { page: string; ref: string }[] {
    const out: { page: string; ref: string }[] = [];
    for (const page of ["index.html", "home.html"]) {
      const html = fs.readFileSync(path.join(publicDir, page), "utf8");
      const refs = [
        ...[...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? ""),
        // og:image and friends are absolute URLs; only this origin's own count
        ...[...html.matchAll(/content="https:\/\/textrelay\.cc(\/[^"]*)"/g)].map((m) => m[1] ?? ""),
      ];
      for (const ref of refs) {
        if (!ref.startsWith("/")) continue; // relative ones are served under /watch/
        out.push({ page, ref });
      }
    }
    return out;
  }

  it("is something the router will serve", () => {
    const lost = rootRefs()
      .filter(({ ref }) => resolveRoute(ref).kind === "not-found")
      .map(({ page, ref }) => `${page} asks for ${ref} and the router does not serve it`);
    expect(lost, lost.join("\n")).toEqual([]);
  });

  it("is something the bundle actually contains, when it comes from the bundle", () => {
    const missing = rootRefs()
      .map(({ page, ref }) => ({ page, ref, route: resolveRoute(ref) }))
      .filter((r) => r.route.kind === "asset")
      .filter((r) => !fs.existsSync(path.join(publicDir, (r.route as { rel: string }).rel)))
      .map((r) => `${r.page} asks for ${r.ref} and it is not in packages/viewer/public`);
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("found references on both pages, so the two assertions above are about something", () => {
    const refs = rootRefs();
    expect(refs.filter((r) => r.page === "home.html").length).toBeGreaterThan(3);
    // the social card is the one that fails most invisibly - nothing in the
    // product breaks, only every link anybody shares
    expect(refs.map((r) => r.ref)).toContain("/og.png");
  });
});

/**
 * The one line that makes every routing test above mean anything.
 *
 * With an `[assets]` directory configured, Cloudflare serves any path matching
 * a file BEFORE the Worker runs, unless `run_worker_first` says otherwise. The
 * comment beside it in `wrangler.toml` records what that cost: "/" answered
 * with index.html - the viewer page - instead of letting the router serve
 * home.html, and /watch/<token> was reaching the page by luck rather than by
 * routing. It was "caught by deploying", because the behaviour lives in the
 * platform rather than in the code.
 *
 * The behaviour still cannot be tested from here, and this does not pretend
 * to. What it pins is the setting, which is the part that lives in this repo:
 * delete that line and `resolveRoute` stops being consulted for anything that
 * happens to match a filename, the four-name root allowlist becomes
 * decorative, and every assertion in this file passes while describing a
 * service that no longer behaves that way. A failure that costs a deploy to
 * notice is worth a test that costs a second.
 */
describe("the deploy config the router depends on", () => {
  const wrangler = fs.readFileSync(path.resolve(__dirname, "..", "wrangler.toml"), "utf8");

  /** `key = value` in the [assets] table, comments and blank lines ignored */
  function assetsTable(): Record<string, string> {
    const section = /^\[assets\]\s*$([\s\S]*?)(?=^\[|\Z)/m.exec(wrangler)?.[1] ?? "";
    const out: Record<string, string> = {};
    for (const line of section.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (m && m[1] && m[2]) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  }

  it("lets the Worker decide every path, rather than the file system", () => {
    expect(
      assetsTable().run_worker_first,
      "without run_worker_first the platform answers before resolveRoute is ever called, " +
        "and every routing assertion in this file describes something that is no longer true",
    ).toBe("true");
  });

  it("points the asset binding at the viewer bundle that is actually shipped", () => {
    const dir = assetsTable().directory;
    expect(dir, "the [assets] table names no directory").toBeTruthy();
    const resolved = path.resolve(__dirname, "..", dir ?? "");
    expect(fs.existsSync(path.join(resolved, "index.html")), `${dir} is not the viewer bundle`).toBe(true);
    expect(fs.existsSync(path.join(resolved, "home.html")), `${dir} has no landing page`).toBe(true);
  });

  it("read the table at all, so the two assertions above are about something", () => {
    // a regex that matched nothing would leave every lookup undefined and the
    // first assertion would fail loudly - but the directory one would not, so
    // this says plainly that the section was found
    expect(Object.keys(assetsTable()).length).toBeGreaterThan(1);
  });
});

/**
 * The root files the landing page asks for, against the ones this router will
 * serve.
 *
 * `run_worker_first = true`, so this Worker decides every path before
 * Cloudflare's asset handling gets a look. A subresource the router does not
 * recognise is a 404 on textrelay.cc, whatever is sitting in the asset
 * directory - and `ROOT_ASSETS` is a hand-written Set, so adding an icon to
 * `home.html` without touching it is a silent miss on the most public page this
 * project has.
 *
 * Read off the page rather than listed here, for the reason the Set itself
 * demonstrates: a second list would go stale the same way the first could.
 *
 * **The single-tenant relay deliberately does not do this**, and the difference
 * is worth knowing before anyone makes them match. Its `/watch/<rest>` branch
 * has always served any file in the bundle, so an allowlist at its root would
 * be theatre while that stays open. This Worker starts closed and the
 * allowlist is what keeps it closed - the comment on `ROOT_ASSETS` says so:
 * "a rule like serve any file at the root publishes whatever lands in it next".
 */
describe("what the landing page asks for at the root", () => {
  const publicDir = path.resolve(__dirname, "..", "..", "..", "packages", "viewer", "public");
  const home = fs.readFileSync(path.join(publicDir, "home.html"), "utf8");

  /** root-absolute subresources only: `<a href>` is a click, not a fetch */
  const rootRefs = (): string[] => {
    const out = new Set<string>();
    for (const m of home.matchAll(/<(?:link|script|img)\b[^>]*?(?:href|src)="(\/[^"]+)"/g)) out.add(m[1] ?? "");
    return [...out];
  };

  it("finds some, so the check below is not vacuous", () => {
    expect(rootRefs().length, "home.html asks for nothing at the root any more").toBeGreaterThan(2);
  });

  it("routes every one of them to the asset handler", () => {
    const unrouted = rootRefs().filter((ref) => resolveRoute(ref).kind !== "asset");
    expect(
      unrouted,
      "home.html asks for these at the root and the router does not recognise them. run_worker_first means " +
        "this Worker answers before the asset directory is consulted, so each is a 404 on textrelay.cc no " +
        "matter what is sitting in that directory",
    ).toEqual([]);
  });

  it("still refuses a root path the page does not ask for", () => {
    // The allowlist is the point: it must not have quietly become a prefix
    // rule. `/fonts/` is deliberately not in this list - it has a rule of its
    // own, carrying the same comment as the relay's, because the landing page
    // loads fonts from the root and the viewer loads them from /watch/.
    for (const p of ["/style.css", "/app.js", "/index.html"]) {
      expect(resolveRoute(p).kind, `${p} became servable at the root`).not.toBe("asset");
    }
  });
});
