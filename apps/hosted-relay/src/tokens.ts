/**
 * Room credentials.
 *
 * A token carries the room it belongs to, so the router can find the Durable
 * Object without a lookup table and without trusting the path. Format:
 *
 *   p1_<rid>_<secret>    publisher - authorises the uplink and the admin routes
 *   v1_<rid>_<secret>    viewer    - the token in a /watch/<token> link
 *
 * `rid` is a PUBLIC id: it appears in the object name and in logs, and knowing
 * it grants nothing. `secret` is a bearer credential and is compared against
 * what the room stored.
 *
 * Both secrets are stored random values, not derived. That is what makes them
 * revocable: rotating a viewer link has to actually kill the old one, and an
 * HMAC over a fixed room id cannot be rotated without invalidating every room
 * that shares the signing key.
 *
 * The whole token must survive two existing checks unchanged, or links break:
 *   packages/relay/src/server.ts     /^\/watch\/([A-Za-z0-9_-]+)$/
 *   packages/viewer/public/app.js    /\/watch\/([A-Za-z0-9_-]+)/
 * so the alphabet here is [A-Za-z0-9] plus the underscore separator only. No
 * dots - a dot is how the asset route tells a filename from a token.
 */

export type TokenKind = "publisher" | "viewer";

export interface ParsedToken {
  kind: TokenKind;
  /** public room id; safe to log */
  rid: string;
  /** bearer secret; never log this */
  secret: string;
}

const PREFIX: Record<string, TokenKind> = { p1: "publisher", v1: "viewer" };
const RID = /^[a-z0-9]{16}$/;
const SECRET = /^[a-f0-9]{32}$/;

/** hex, from the Workers runtime's own CSPRNG */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newRoomId(): string {
  // 16 chars of [a-z0-9] - 8 random bytes rendered hex is exactly that
  return randomHex(8);
}

export function newSecret(): string {
  return randomHex(16);
}

export function formatToken(kind: TokenKind, rid: string, secret: string): string {
  return `${kind === "publisher" ? "p1" : "v1"}_${rid}_${secret}`;
}

/**
 * Parse a token, or null if it is not one. Shape only - this says nothing
 * about whether the secret is the room's current one.
 */
export function parseToken(raw: string | null | undefined): ParsedToken | null {
  if (!raw) return null;
  const parts = raw.split("_");
  if (parts.length !== 3) return null;
  const [prefix, rid, secret] = parts;
  const kind = PREFIX[prefix];
  if (!kind) return null;
  if (!RID.test(rid) || !SECRET.test(secret)) return null;
  return { kind, rid, secret };
}

/**
 * Constant-time compare. The secrets are equal length by construction, but a
 * length mismatch must still not short-circuit into a different timing class.
 */
export function secretsMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
