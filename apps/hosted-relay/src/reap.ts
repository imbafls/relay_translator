/**
 * Whether a room has become junk, and the mechanism that acts on it.
 *
 * `POST /claim` mints a Durable Object for anyone who asks, and nothing removed
 * one. That was defensible while the only way to reach it was a curl command in
 * a README. It is not now: the endpoint sits on a domain people are meant to
 * type, and the rooms left over from a cost measurement are still there.
 *
 * The rule is lopsided, because the two kinds of room are not alike.
 *
 * A room **somebody is using** belongs to a person, and its viewer token may be
 * sitting in someone's messages. Deleting it breaks a link its owner believes
 * works, silently, at a time they did not choose. Unbounded growth in used
 * rooms is not a problem worth creating that risk for: each is a real person,
 * the record is tiny, and an idle room costs nothing because the billing is per
 * request. Those are kept, for ever.
 *
 * A room **nobody has ever touched** is a test, a measurement, a mistake or an
 * abuse. Those go, thirty days after they were claimed.
 *
 * ## What "used" means, and why the first version was wrong
 *
 * It was: a publisher connected. That was wrong, and dangerously so. A viewer
 * link works from the moment the room is claimed - the viewer branch checks the
 * viewer secret and nothing else - so a friend can open it and sit on OFF AIR
 * before the first stream. Sharing the link ahead of time is the ordinary way
 * to use this. Under the old rule that room was "never used" and was deleted on
 * day thirty, taking a link its owner had already handed out.
 *
 * So use is now ANY authenticated touch: a publisher connecting, a viewer
 * connecting, the owner reading or rotating the viewer token. Each proves a
 * person is on the other end. It is recorded once - the first touch - so a room
 * costs one extra write in its life rather than one per reconnect.
 */

/** how long a room nobody has ever touched is kept before it is removed */
export const UNTOUCHED_ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** how long to wait before looking again at a room that is busy right now */
export const BUSY_RECHECK_MS = 24 * 60 * 60 * 1000;

export interface ReapableRoom {
  createdAt: number;
  /**
   * epoch ms somebody first proved they were using this room, by any
   * authenticated route. Absent means nobody ever has.
   */
  usedAt?: number;
}

/**
 * Everything the reap needs from a Durable Object, so the mechanism can be run
 * against a fake in a test. The object itself was untestable in this suite -
 * there is no workers pool here - which is how three separate mutations to the
 * deleting code once passed the whole suite untouched.
 */
export interface RoomIo {
  load(): Promise<ReapableRoom | undefined>;
  save(room: ReapableRoom): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  /** how many sockets are attached right now */
  openSockets(): number;
}

/**
 * True when this room can be deleted.
 *
 * `usedAt` is the whole decision. A room with one is kept for ever, however old
 * - age is not evidence that a link has stopped mattering, and there is nobody
 * to ask.
 */
export function shouldReap(room: ReapableRoom, now: number): boolean {
  if (room.usedAt !== undefined) return false;
  return now - room.createdAt >= UNTOUCHED_ROOM_TTL_MS;
}

/** when to wake and check, or undefined when the room is already kept for ever */
export function nextReapCheck(room: ReapableRoom): number | undefined {
  if (room.usedAt !== undefined) return undefined;
  return room.createdAt + UNTOUCHED_ROOM_TTL_MS;
}

/**
 * Record that somebody is using this room, and stop the clock.
 *
 * Idempotent and cheap: after the first touch it loads, sees `usedAt`, and
 * writes nothing. Call it from every authenticated path - the cost of calling
 * it once too often is a read, and the cost of missing one is somebody's link.
 */
export async function markUsed(io: RoomIo, now: number): Promise<"recorded" | "already" | "gone"> {
  const room = await io.load();
  if (!room) return "gone";
  if (room.usedAt !== undefined) return "already";
  await io.save({ ...room, usedAt: now });
  // nothing left to wake up for; a kept room should never cost a wake-up again
  await io.deleteAlarm();
  return "recorded";
}

/**
 * The alarm. Decides, and acts.
 *
 * Two things it does that `shouldReap` cannot, because that takes a record and
 * this can see the runtime:
 *
 * 1. **An open socket is proof of use.** Somebody is reading right now. The
 *    first version noticed this and only re-armed for a day - so a room could
 *    survive day thirty and die on day thirty-one because a phone locked inside
 *    a two-second reconnect gap. The evidence was in hand and thrown away.
 * 2. **It re-reads immediately before deleting.** A Durable Object can run an
 *    alarm concurrently with a request, so a publisher connecting during this
 *    handler could write `usedAt` between the decision and the delete. Reading
 *    again narrows that to nothing that matters; the caller additionally runs
 *    the whole tick inside `blockConcurrencyWhile`.
 */
export async function reapTick(io: RoomIo, now: number): Promise<"gone" | "kept" | "in-use" | "reaped"> {
  const room = await io.load();
  if (!room) return "gone";

  if (io.openSockets() > 0) {
    await markUsed(io, now);
    return "in-use";
  }

  if (!shouldReap(room, now)) {
    const at = nextReapCheck(room);
    if (at !== undefined && at > now) await io.setAlarm(at);
    return "kept";
  }

  const fresh = await io.load();
  if (!fresh || !shouldReap(fresh, now)) return "kept";

  // the tokens ARE the state, so removing it is what makes them stop working,
  // and a room with no state answers "no such room" through the path that
  // already exists
  await io.deleteAll();
  return "reaped";
}
