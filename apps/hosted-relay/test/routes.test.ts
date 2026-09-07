import { describe, expect, it } from "vitest";
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
