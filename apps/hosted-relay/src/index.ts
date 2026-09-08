/**
 * The router. It holds NO state.
 *
 * That is a rule, not a style note: the single-tenant relay's bugs at tenant
 * scale are all module-scope singletons (`currentLanguages`, the one publisher
 * slot). A cached value up here would leak one streamer's captions into
 * another's room, and it would do it only under concurrency, which is the
 * hardest kind of bug to see in testing.
 *
 * Every request that needs room state resolves a Durable Object from the token
 * and forwards. The room id comes out of the TOKEN, never out of the path, so
 * there is no way to address a room you do not hold a credential for.
 */

import { Room } from "./room";
import { newRoomId, parseToken } from "./tokens";
import { insecureRedirect, installerName, resolveRoute } from "./routes";

export { Room };

interface Env {
  ROOM: DurableObjectNamespace;
  /** the shipped viewer page and its fonts, from packages/viewer/public */
  ASSETS: { fetch(req: Request): Promise<Response> };
  /**
   * Rate limit on POST /claim. Optional so `wrangler dev` and the tests run
   * without one; absent means unlimited, which is what production was.
   */
  CLAIM_LIMIT?: RateLimit;
  /** feedback a person chose to send: a message, and optionally their own redacted log */
  FEEDBACK: R2Bucket;
  /**
   * Rate limit on POST /feedback. Optional for the same reason CLAIM_LIMIT
   * is: `wrangler dev` and the tests run without one; absent means unlimited.
   */
  FEEDBACK_LIMIT?: RateLimit;
}

/**
 * Where builds live. The same release the app's own updater reads, so the
 * landing page cannot advertise a version the updater does not know about -
 * one source of truth, not two.
 */
const RELEASE_BASE = "https://github.com/imbafls/relay_translator/releases/latest/download";

/**
 * The landing page reads this for the version, and enables its download button
 * only if it parses. It has to be same-origin: a redirect to GitHub is followed
 * to an origin that sends no CORS headers, so `fetch` rejects and the page
 * disables itself exactly as it did when the route 404ed. So the Worker fetches
 * it and hands the bytes back.
 */
async function updateFeed(): Promise<Response> {
  const res = await fetch(`${RELEASE_BASE}/latest.yml`, { cf: { cacheTtl: 300 } } as RequestInit);
  if (!res.ok) return new Response("no build published yet", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(await res.text(), {
    headers: { "Content-Type": "text/yaml; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}

/**
 * An installer filename we are willing to put in a response header.
 *
 * `installerName` reads whatever the feed says, and a header value carrying a
 * newline splits the response. The real names are electron-builder's, which
 * this matches exactly; anything else is treated as no build rather than
 * sanitised into something that merely looks safe.
 */
const SAFE_INSTALLER = /^[A-Za-z0-9._+-]+$/;

/**
 * The installer named by the feed, streamed through this Worker rather than
 * redirected to.
 *
 * It used to 302 to the release asset, which meant a visitor who clicked
 * Download on textrelay.cc watched their address bar turn into the maintainer's
 * personal account. The bytes are the same either way; the difference is whose
 * name is on the request. `fetch` follows the release redirect and the body is
 * handed straight back, so nothing is buffered in the isolate.
 *
 * The filename is still resolved rather than hardcoded, because it carries the
 * version and would go stale on every release.
 */
export async function downloadInstaller(): Promise<Response> {
  const feed = await fetch(`${RELEASE_BASE}/latest.yml`, { cf: { cacheTtl: 300 } } as RequestInit);
  const name = feed.ok ? installerName(await feed.text()) : undefined;

  // No feed, no build. This used to fall back to the public releases page,
  // which is exactly the leak this function exists to close - so it now says
  // the same thing the landing page says when the feed will not parse.
  if (!name || !SAFE_INSTALLER.test(name)) {
    return new Response("no build published yet", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const asset = await fetch(`${RELEASE_BASE}/${name}`, {
    cf: { cacheEverything: true, cacheTtl: 3600 },
  } as RequestInit);
  if (!asset.ok || !asset.body) {
    return new Response("download unavailable", {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    // without this the browser names the file after the path, which is
    // "download" with no extension - Windows will not run that
    "Content-Disposition": `attachment; filename="${name}"`,
    "Cache-Control": "public, max-age=3600",
  });
  // pass the length through when upstream gave one, so the browser can show a
  // progress bar on an 84 MB file instead of an indeterminate spinner
  const len = asset.headers.get("content-length");
  if (len) headers.set("Content-Length", len);

  return new Response(asset.body, { status: 200, headers });
}

/**
/**
 * The one name this site is published under.
 *
 * Three hostnames answer this Worker and all three serve the same bytes. That
 * is deliberate - see wrangler.toml - but to a crawler it reads as one site at
 * three addresses, and the copy it decides to rank is not necessarily the one
 * on the download button. Everything a crawler is given says textrelay.cc.
 */
export const CANONICAL_ORIGIN = "https://textrelay.cc";

/**
 * robots.txt, decided from the name the request arrived on.
 *
 * On the canonical name: crawl the site, stay out of /watch/, here is the
 * sitemap. On any other name: crawl nothing. A duplicate that is merely
 * canonicalised still has to be fetched to learn that; a duplicate that is
 * disallowed costs nobody anything.
 */
export function robotsTxt(url: URL): string {
  const lines = ["User-agent: *"];
  if (url.origin !== CANONICAL_ORIGIN) {
    lines.push("Disallow: /");
    return lines.join("\n") + "\n";
  }
  // the token in a viewer link is the whole credential, and the pages are
  // minted one per stream - none of it belongs in an index
  lines.push("Disallow: /watch/", "Allow: /", "", `Sitemap: ${CANONICAL_ORIGIN}/sitemap.xml`);
  return lines.join("\n") + "\n";
}

/**
 * The sitemap. One URL today, because one URL is what this site has.
 *
 * Written out rather than generated from the router: the router knows about
 * /health and /claim and /ws/uplink too, and a sitemap that lists an endpoint
 * is worse than no sitemap. What belongs here is a decision, not a derivation.
 */
export function sitemapXml(): string {
  const urls = ["/"];
  const body = urls.map((u) => `  <url><loc>${CANONICAL_ORIGIN}${u}</loc></url>`).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    body,
    "</urlset>",
    "",
  ].join("\n");
}

/**
 * The same response, refusing to be indexed.
 *
 * Rebuilt rather than mutated: what comes back from the asset binding carries
 * an immutable header list, and setting a header on it throws. The header is
 * used as well as the meta tag in the page because it covers the response
 * whatever the markup later says, and because a crawler that only fetched the
 * headers has already been answered.
 */
export function noindex(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** everyone Cloudflare could not name shares one bucket */
const ANON_CLAIMER = "anon";

/**
 * Which bucket a claim counts against.
 *
 * `CF-Connecting-IP` only, never `X-Forwarded-For`. Cloudflare writes the first
 * one on every request and overwrites whatever the caller sent; the second is
 * simply a header the client typed, so keying on it would hand every caller
 * their own private bucket and the limit would count to one forever.
 *
 * With no address at all - `wrangler dev`, a test - everything shares
 * ANON_CLAIMER. A unique key per request would be no limit at all, so sharing
 * one is the safe reading.
 */
export function claimRateKey(request: Request): string {
  return request.headers.get("CF-Connecting-IP")?.trim() || ANON_CLAIMER;
}

// ---------------------------------------------------------------------------
// POST /feedback - a report a person chose to send, written once into R2
// ---------------------------------------------------------------------------

/** a person's own message box has no reason to be bigger than this */
const FEEDBACK_MESSAGE_MAX = 8 * 1024;
/** relay.log caps itself at 1 MB (packages/relay/src/session.ts) - headroom without being unbounded */
const FEEDBACK_LOG_MAX = 1.5 * 1024 * 1024;
/** a version string is "0.6.0", not a payload - every field needs its own cap, not just message */
const FEEDBACK_VERSION_MAX = 64;
/**
 * The `Content-Length` ceiling checked before a single byte of the body is
 * read. Message plus log plus slack for JSON structure, field names and
 * escaping - generous enough that a legitimate report is never bounced on
 * encoding overhead, not so generous that the pre-read check stops meaning
 * anything.
 */
const FEEDBACK_BODY_MAX = FEEDBACK_MESSAGE_MAX + FEEDBACK_LOG_MAX + 64 * 1024;

interface FeedbackReport {
  message: string;
  appVersion: string;
  log?: string;
}

/**
 * A well-formed report, or undefined. Checked by hand rather than trusted -
 * the earlier checks in `handleFeedback` only bound the declared size and the
 * content type, not the shape of what is actually inside.
 */
function parseFeedback(body: unknown): FeedbackReport | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.message !== "string" || typeof b.appVersion !== "string") return undefined;

  const message = b.message.trim();
  const appVersion = b.appVersion.trim();
  if (!message || message.length > FEEDBACK_MESSAGE_MAX) return undefined;
  if (!appVersion || appVersion.length > FEEDBACK_VERSION_MAX) return undefined;

  if (b.log === undefined) return { message, appVersion };
  if (typeof b.log !== "string" || b.log.length > FEEDBACK_LOG_MAX) return undefined;
  return { message, appVersion, log: b.log };
}

/**
 * A short reference id for one feedback report, so a person can quote it if
 * they write in about it. Generated fresh per send from the runtime's own
 * CSPRNG and never derived from anything about the machine - it is not a
 * room token (see tokens.ts, which is about room credentials specifically)
 * and does not need that format, and it is not stored anywhere on the
 * client either.
 */
function newFeedbackId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `YYYY/MM/DD`, UTC - Cloudflare's edge has no local timezone to prefer */
function utcDayPrefix(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, "/");
}

async function handleFeedback(request: Request, env: Env): Promise<Response> {
  // 1. Rate-limit check FIRST, before anything else runs - same reasoning as
  // `claim` above: a refused request has to cost nothing, and an R2 write
  // that happens is a write that bills.
  const allowed = env.FEEDBACK_LIMIT
    ? (await env.FEEDBACK_LIMIT.limit({ key: claimRateKey(request) })).success
    : true;
  if (!allowed) {
    return json({ error: "too much feedback from here - try again in a minute" }, 429);
  }

  // 2. Refuse on the DECLARED size, before a single byte of the body is
  // read. A 413 that has already buffered the body has not saved anything.
  // A missing or non-numeric Content-Length is refused the same as an
  // oversized one, not waved through: this endpoint has exactly one caller
  // (the desktop app's own upload) and a real `fetch()` call with a string
  // body always sets Content-Length on the wire - there is no legitimate
  // chunked-transfer client to make room for. Letting an unreadable length
  // fall through instead would mean the isolate buffers the whole body with
  // nothing bounding it until parseFeedback runs.
  const rawLength = request.headers.get("Content-Length");
  const declaredLength = rawLength === null ? NaN : Number(rawLength);
  if (!Number.isFinite(declaredLength) || declaredLength > FEEDBACK_BODY_MAX) {
    return json({ error: "feedback too large" }, 413);
  }

  // 3. JSON only.
  const contentType = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return json({ error: "expected application/json" }, 415);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const report = parseFeedback(raw);
  if (!report) {
    return json({ error: "invalid feedback" }, 400);
  }

  const id = newFeedbackId();
  const now = new Date();
  const prefix = utcDayPrefix(now);

  // Store nothing that identifies a machine: no IP, no user agent, no
  // install id - just what the person typed, the version they're running,
  // and when. The id lives only in this record; it is generated per send and
  // does not persist anywhere on the client, so it cannot be used to link a
  // later send back to this one.
  try {
    await env.FEEDBACK.put(
      `${prefix}/${id}.json`,
      JSON.stringify({ message: report.message, appVersion: report.appVersion, timestamp: now.toISOString() }),
      { httpMetadata: { contentType: "application/json" } },
    );
  } catch {
    // Nothing was written. Safe for the caller to retry - a retry mints a
    // fresh id, so there is no way for this path to leave a duplicate.
    return json({ error: "feedback could not be stored" }, 502);
  }

  if (report.log !== undefined) {
    try {
      await env.FEEDBACK.put(`${prefix}/${id}.log`, report.log, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
      });
    } catch {
      // The report itself DID get stored, under `id`, one line up. Returning
      // it here (rather than a bare error) and answering 502 instead of 200
      // does two things at once: it tells the caller the log half failed,
      // and it tells them not to retry - a retry would re-send the message
      // that already made it, minting a second id and writing a duplicate
      // report for the sake of the log alone.
      return json({ error: "feedback stored, log upload failed", id }, 502);
    }
  }

  return json({ id });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // before anything else: a viewer token in a cleartext request line is the
    // credential handed to the network
    const secure = insecureRedirect(url, request.headers.get("Upgrade"));
    if (secure) return Response.redirect(secure, 301);

    const route = resolveRoute(url.pathname, request.method);

    switch (route.kind) {
      case "home":
        return env.ASSETS.fetch(assetRequest(url, "home.html"));

      case "sitemap":
        return new Response(sitemapXml(), {
          headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
        });

      case "robots":
        return new Response(robotsTxt(url), {
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
        });

      case "update-feed":
        return updateFeed();

      case "download":
        return downloadInstaller();

      case "viewer-page":
        // the page itself is public; the token is checked when its script opens
        // the socket. Serving it unconditionally keeps a wrong link looking like
        // a dead stream rather than a 404, which is what a viewer can act on.
        return noindex(await env.ASSETS.fetch(assetRequest(url, "index.html")));

      case "asset":
        return env.ASSETS.fetch(assetRequest(url, route.rel));

      case "claim": {
        // Checked BEFORE the room id is minted and before any Durable Object is
        // addressed: a refused claim has to cost nothing, and an object that
        // runs is an object that bills.
        const allowed = env.CLAIM_LIMIT ? (await env.CLAIM_LIMIT.limit({ key: claimRateKey(request) })).success : true;
        if (!allowed) {
          return json({ error: "too many rooms claimed from here - try again in a minute" }, 429);
        }
        // no account system: a room is claimed anonymously and is worthless
        // without its secrets. The id is generated here so the caller cannot
        // choose one and squat on somebody else's.
        const rid = newRoomId();
        return roomFetch(env, rid, { op: "claim", rid });
      }

      case "feedback":
        return handleFeedback(request, env);

      case "health": {
        // per-room when a token is given, so a streamer can check their own;
        // otherwise a liveness answer for the service that wakes nothing
        const parsed = parseToken(url.searchParams.get("token"));
        if (!parsed) return json({ ok: true, live: false, viewers: 0 });
        return roomFetch(env, parsed.rid, {
          op: "health",
          rid: parsed.rid,
          secret: parsed.secret,
        });
      }

      case "ws-uplink":
      case "ws-viewer": {
        const parsed = parseToken(url.searchParams.get("token"));
        const want = route.kind === "ws-uplink" ? "publisher" : "viewer";
        // shape is checked here so a malformed token never wakes an object;
        // whether the secret is RIGHT is the room's business, and it answers
        // with a close code rather than an HTTP status because that is what
        // the desktop client stops retrying on
        if (!parsed || parsed.kind !== want) return unauthorisedSocket(request);
        return roomFetch(
          env,
          parsed.rid,
          { op: route.kind === "ws-uplink" ? "uplink" : "viewer", rid: parsed.rid, secret: parsed.secret },
          request,
        );
      }

      case "viewer-token":
      case "rotate-viewer-token": {
        const parsed = parseToken(bearer(request) || url.searchParams.get("token"));
        if (!parsed || parsed.kind !== "publisher") return json({ error: "forbidden" }, 403);
        return roomFetch(env, parsed.rid, {
          op: route.kind === "viewer-token" ? "viewer-token" : "rotate-viewer-token",
          rid: parsed.rid,
          secret: parsed.secret,
        });
      }

      default:
        return new Response("not found", { status: 404 });
    }
  },
};

/** rewrite the path to the asset the viewer bundle actually contains */
function assetRequest(url: URL, rel: string): Request {
  const target = new URL(url.toString());
  target.pathname = `/${rel}`;
  target.search = "";
  return new Request(target.toString());
}

function roomFetch(
  env: Env,
  rid: string,
  params: Record<string, string>,
  original?: Request,
): Promise<Response> {
  const id = env.ROOM.idFromName(rid);
  const stub = env.ROOM.get(id);
  const target = new URL("https://room.internal/");
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  // the upgrade headers have to survive, so forward the original request
  return stub.fetch(
    new Request(target.toString(), original ? { headers: original.headers } : undefined),
  );
}

/**
 * A refusal the desktop client can act on. It retries an HTTP failure forever
 * but stops on a 4401 close, so an unauthorised socket must be upgraded and
 * then closed rather than rejected outright.
 */
function unauthorisedSocket(request: Request): Response {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  server.close(4401, "bad token");
  return new Response(null, { status: 101, webSocket: client });
}

function bearer(request: Request): string | null {
  const h = request.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
