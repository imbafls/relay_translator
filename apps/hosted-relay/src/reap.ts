/**
 * Whether a room has become junk, and when to look again.
 *
 * `POST /claim` mints a Durable Object for anyone who asks, and nothing ever
 * removed one. That was defensible while the only way to reach it was a curl
 * command in a README. It is not now: the endpoint sits on a domain people are
 * meant to type, and the ~24 rooms left over from a cost measurement are still
 * there.
 *
 * The rule is deliberately lopsided, because the two kinds of room are not
 * alike.
 *
 * A room **nobody ever published to** is a test, a measurement, a mistake or an
 * abuse. Nobody holds a link to it that works, because a link is only worth
 * something once captions flow. Removing it costs nothing.
 *
 * A room that **has been used** belongs to a person, and its viewer token may
 * be sitting in somebody's messages. Deleting it breaks a link that its owner
 * believes still works, silently, at a time they did not choose. Unbounded
 * growth in USED rooms is not a problem worth creating that risk for: each one
 * is a real person, the record is tiny, and an idle room costs nothing to keep
 * because the billing is per request.
 *
 * So: reap the never-used, keep the used. The rate limit on /claim is what
 * bounds abuse; this only stops the residue accumulating for ever.
 */

/** how long a room that was never published to is kept before it is removed */
export const UNUSED_ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ReapableRoom {
  createdAt: number;
  /** epoch ms a publisher first connected; absent means the room was never used */
  usedAt?: number;
}

/**
 * True when this room can be deleted.
 *
 * `usedAt` is the whole decision. A room with one is kept for ever, however old
 * it is - age is not evidence that a link has stopped mattering.
 */
export function shouldReap(room: ReapableRoom, now: number): boolean {
  if (room.usedAt !== undefined) return false;
  return now - room.createdAt >= UNUSED_ROOM_TTL_MS;
}

/**
 * When to wake up and check, or undefined if there is nothing to wait for.
 *
 * A used room needs no alarm at all, which is the point: the overwhelming
 * majority of rooms that survive their first month cost nothing to keep,
 * including nothing in wake-ups.
 */
export function nextReapCheck(room: ReapableRoom): number | undefined {
  if (room.usedAt !== undefined) return undefined;
  return room.createdAt + UNUSED_ROOM_TTL_MS;
}
