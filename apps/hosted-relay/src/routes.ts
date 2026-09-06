/**
 * Where a request goes, decided from the path alone.
 *
 * Pure on purpose: this is the half of the service that can be wrong in a way
 * no amount of Cloudflare-side testing catches quickly, and it has to agree
 * exactly with the single-tenant relay it replaces (packages/relay/src/server.ts
 * lines 469-495) or the viewer breaks in a way that only shows up in OBS.
 *
 * The asset rule is the subtle one. The shipped viewer page references its
 * assets RELATIVELY:
 *
 *   <link rel="stylesheet" href="fonts/fonts.css" />
 *   <link rel="stylesheet" href="style.css" />
 *   <script src="app.js"></script>
 *
 * so a page served at /watch/<token> asks for /watch/style.css. Tokens cannot
 * contain a dot and filenames always do, which is exactly how the existing
 * relay tells them apart. Get this wrong and the overlay serves a bare
 * unstyled page with no script - the failure looks like a broken relay.
 */

export type Route =
  | { kind: "home" }
  | { kind: "viewer-page"; token: string }
  | { kind: "asset"; rel: string }
  | { kind: "ws-uplink" }
  | { kind: "ws-viewer" }
  | { kind: "health" }
  | { kind: "claim" }
  | { kind: "viewer-token" }
  | { kind: "rotate-viewer-token" }
  | { kind: "not-found" };

/** a token is [A-Za-z0-9_-]+ with no dot; a filename always has one */
const TOKEN_PATH = /^\/watch\/([A-Za-z0-9_-]+)$/;

export function resolveRoute(pathname: string, method = "GET"): Route {
  if (pathname === "/health") return { kind: "health" };
  if (pathname === "/ws/uplink") return { kind: "ws-uplink" };
  if (pathname === "/ws/viewer") return { kind: "ws-viewer" };

  if (pathname === "/claim") return method === "POST" ? { kind: "claim" } : { kind: "not-found" };
  if (pathname === "/admin/viewer-token") {
    return method === "GET" ? { kind: "viewer-token" } : { kind: "not-found" };
  }
  if (pathname === "/admin/rotate-viewer-token") {
    return method === "POST" ? { kind: "rotate-viewer-token" } : { kind: "not-found" };
  }

  if (pathname === "/" || pathname === "/watch" || pathname === "/watch/") return { kind: "home" };

  const watch = TOKEN_PATH.exec(pathname);
  if (watch) return { kind: "viewer-page", token: watch[1] };

  // /watch/style.css, /watch/app.js, /watch/fonts/fonts.css
  if (pathname.startsWith("/watch/")) {
    const rel = pathname.slice("/watch/".length);
    return safeRel(rel) ? { kind: "asset", rel } : { kind: "not-found" };
  }
  // the landing page loads fonts from the root, the viewer from /watch/
  if (pathname.startsWith("/fonts/")) {
    const rel = pathname.slice(1);
    return safeRel(rel) ? { kind: "asset", rel } : { kind: "not-found" };
  }

  return { kind: "not-found" };
}

/** no traversal, no absolute paths, no empty segments */
function safeRel(rel: string): boolean {
  if (!rel || rel.startsWith("/")) return false;
  return rel.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}
