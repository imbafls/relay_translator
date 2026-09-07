import { describe, expect, it } from "vitest";
import { nextReapCheck, shouldReap, UNUSED_ROOM_TTL_MS } from "../src/reap";

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
    expect(shouldReap({ createdAt: now - UNUSED_ROOM_TTL_MS }, now)).toBe(true);
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
    expect(nextReapCheck({ createdAt: now })).toBe(now + UNUSED_ROOM_TTL_MS);
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
