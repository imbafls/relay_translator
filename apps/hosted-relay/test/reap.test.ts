import { describe, expect, it } from "vitest";
import { markUsed, nextReapCheck, reapTick, shouldReap, UNTOUCHED_ROOM_TTL_MS } from "../src/reap";
import type { ReapableRoom, RoomIo } from "../src/reap";

/**
 * `POST /claim` mints a Durable Object for anyone who asks and nothing ever
 * removed one. Fine while the endpoint was a curl command in a README; not fine
 * now that it is on a domain people are meant to type.
 *
 * The rule is lopsided on purpose, and these tests are mostly about the side
 * that does NOT get reaped - because that is the side where being wrong loses
 * somebody's link, silently, at a moment they did not choose.
 */
const DAY = 24 * 60 * 60 * 1000;
const now = 1_788_000_000_000;

describe("which rooms are junk", () => {
  it("removes one nobody ever published to, once it is old enough", () => {
    expect(shouldReap({ createdAt: now - UNTOUCHED_ROOM_TTL_MS }, now)).toBe(true);
    expect(shouldReap({ createdAt: now - 400 * DAY }, now)).toBe(true);
  });

  it("keeps a young unused one, because claiming and streaming are not the same minute", () => {
    expect(shouldReap({ createdAt: now }, now)).toBe(false);
    expect(shouldReap({ createdAt: now - 1 * DAY }, now)).toBe(false);
    expect(shouldReap({ createdAt: now - 29 * DAY }, now)).toBe(false);
  });

  it("never removes a room that was used, however old", () => {
    // the link may be sitting in somebody's messages. Age is not evidence that
    // it stopped mattering, and there is no way to ask.
    expect(shouldReap({ createdAt: now - 400 * DAY, usedAt: now - 399 * DAY }, now)).toBe(false);
    expect(shouldReap({ createdAt: now - 10 * 365 * DAY, usedAt: now - 10 * 365 * DAY }, now)).toBe(false);
  });

  it("treats used-once-long-ago the same as used-yesterday", () => {
    const ancient = shouldReap({ createdAt: now - 900 * DAY, usedAt: now - 900 * DAY }, now);
    const recent = shouldReap({ createdAt: now - 900 * DAY, usedAt: now - 1 * DAY }, now);
    expect(ancient).toBe(recent);
    expect(ancient).toBe(false);
  });

  it("does not reap on a clock that has gone backwards", () => {
    // a room created "in the future" relative to this wake-up must not be
    // deleted for being old
    expect(shouldReap({ createdAt: now + 10 * DAY }, now)).toBe(false);
  });
});

describe("when to look again", () => {
  it("waits exactly the lifetime out for an unused room", () => {
    expect(nextReapCheck({ createdAt: now })).toBe(now + UNTOUCHED_ROOM_TTL_MS);
  });

  it("asks for no wake-up at all once a room has been used", () => {
    // a used room is kept for ever, so an alarm on it would be a wake-up that
    // can only ever decide to do nothing - and wake-ups are billed
    expect(nextReapCheck({ createdAt: now, usedAt: now })).toBeUndefined();
  });

  it("agrees with shouldReap at the moment it schedules", () => {
    const room = { createdAt: now };
    const at = nextReapCheck(room)!;
    expect(shouldReap(room, at - 1)).toBe(false);
    expect(shouldReap(room, at)).toBe(true);
  });
});

/**
 * The mechanism, not just the policy.
 *
 * An adversarial review of the first version made this point by proving it:
 * three separate mutations to the code that actually deletes user data - never
 * recording use at all, removing the open-socket guard, never arming the alarm
 * - each left the whole suite green. `reap.test.ts` tested two pure functions
 * whose bodies were four lines, and the destructive part was untestable in this
 * suite because there is no workers pool to instantiate a Durable Object in.
 *
 * So the mechanism takes its storage as an argument, and this runs it against a
 * fake. The room is a plain object; the assertions are about what happened to
 * it.
 */
function fakeIo(initial?: ReapableRoom, sockets = 0) {
  let room: ReapableRoom | undefined = initial ? { ...initial } : undefined;
  const calls = { saves: 0, deleteAll: 0, setAlarm: [] as number[], deleteAlarm: 0 };
  const io: RoomIo = {
    load: async () => (room ? { ...room } : undefined),
    save: async (next) => {
      calls.saves += 1;
      room = { ...next };
    },
    deleteAll: async () => {
      calls.deleteAll += 1;
      room = undefined;
    },
    setAlarm: async (at) => {
      calls.setAlarm.push(at);
    },
    deleteAlarm: async () => {
      calls.deleteAlarm += 1;
    },
    openSockets: () => sockets,
  };
  return { io, calls, get room() { return room; } };
}

describe("the reap itself", () => {
  it("deletes an untouched room once it is old enough", async () => {
    const f = fakeIo({ createdAt: now - UNTOUCHED_ROOM_TTL_MS - 1 });
    expect(await reapTick(f.io, now)).toBe("reaped");
    expect(f.calls.deleteAll, "the room was not actually removed").toBe(1);
    expect(f.room).toBeUndefined();
  });

  it("does not delete a room somebody is reading right now", async () => {
    // a viewer link works from the moment of claim, so an untouched room CAN
    // have somebody on it - and that somebody is the whole reason not to delete
    const f = fakeIo({ createdAt: now - UNTOUCHED_ROOM_TTL_MS - 1 }, 1);
    expect(await reapTick(f.io, now)).toBe("in-use");
    expect(f.calls.deleteAll, "deleted a room out from under an open socket").toBe(0);
  });

  it("records the use it just witnessed, instead of only waiting another day", async () => {
    // the first version re-armed 24h and re-read the same unchanged record, so
    // a room survived day 30 and died on day 31 if a phone locked in between
    const f = fakeIo({ createdAt: now - UNTOUCHED_ROOM_TTL_MS - 1 }, 1);
    await reapTick(f.io, now);
    expect(f.room?.usedAt, "an open socket proved use and it was not written down").toBe(now);

    const later = fakeIo(f.room!, 0);
    expect(await reapTick(later.io, now + 10 * UNTOUCHED_ROOM_TTL_MS)).toBe("kept");
    expect(later.calls.deleteAll).toBe(0);
  });

  it("never deletes a room that was touched, however old", async () => {
    const f = fakeIo({ createdAt: now - 900 * DAY, usedAt: now - 899 * DAY });
    expect(await reapTick(f.io, now)).toBe("kept");
    expect(f.calls.deleteAll).toBe(0);
  });

  it("re-reads before deleting, so a touch landing mid-alarm is not overwritten", async () => {
    // a Durable Object can run its alarm concurrently with a request: a
    // publisher connecting during this handler writes usedAt between the
    // decision and the delete
    const f = fakeIo({ createdAt: now - UNTOUCHED_ROOM_TTL_MS - 1 });
    let reads = 0;
    const racing: RoomIo = {
      ...f.io,
      load: async () => {
        reads += 1;
        // the second read is the one taken just before deleting
        return reads === 1 ? { createdAt: now - UNTOUCHED_ROOM_TTL_MS - 1 } : { createdAt: now - UNTOUCHED_ROOM_TTL_MS - 1, usedAt: now };
      },
    };
    expect(await reapTick(racing, now)).toBe("kept");
    expect(f.calls.deleteAll, "deleted a room that was claimed a microsecond earlier").toBe(0);
  });

  it("says so rather than throwing when the room has already gone", async () => {
    const f = fakeIo(undefined);
    expect(await reapTick(f.io, now)).toBe("gone");
    expect(f.calls.deleteAll).toBe(0);
  });
});

describe("recording that somebody is using a room", () => {
  it("writes once and stops the clock", async () => {
    const f = fakeIo({ createdAt: now - DAY });
    expect(await markUsed(f.io, now)).toBe("recorded");
    expect(f.room?.usedAt).toBe(now);
    expect(f.calls.deleteAlarm, "a kept room still costs a wake-up").toBe(1);
  });

  it("writes nothing the second time, so a reconnect loop is not a write loop", async () => {
    const f = fakeIo({ createdAt: now - DAY, usedAt: now - DAY });
    expect(await markUsed(f.io, now)).toBe("already");
    expect(f.calls.saves).toBe(0);
  });

  it("does not resurrect a room that has gone", async () => {
    const f = fakeIo(undefined);
    expect(await markUsed(f.io, now)).toBe("gone");
    expect(f.calls.saves).toBe(0);
  });
});
