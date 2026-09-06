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
import { resolveRoute } from "./routes";

export { Room };

interface Env {
  ROOM: DurableObjectNamespace;
  /** the shipped viewer page and its fonts, from packages/viewer/public */
  ASSETS: { fetch(req: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = resolveRoute(url.pathname, request.method);

    switch (route.kind) {
      case "home":
        return env.ASSETS.fetch(assetRequest(url, "home.html"));

      case "viewer-page":
        // the page itself is public; the token is checked when its script opens
        // the socket. Serving it unconditionally keeps a wrong link looking like
        // a dead stream rather than a 404, which is what a viewer can act on.
        return env.ASSETS.fetch(assetRequest(url, "index.html"));

      case "asset":
        return env.ASSETS.fetch(assetRequest(url, route.rel));

      case "claim": {
        // no account system: a room is claimed anonymously and is worthless
        // without its secrets. The id is generated here so the caller cannot
        // choose one and squat on somebody else's.
        const rid = newRoomId();
        return roomFetch(env, rid, { op: "claim", rid });
      }

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
