import { describe, expect, it } from "vitest";
import { resolveRoute } from "../src/routes";
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
