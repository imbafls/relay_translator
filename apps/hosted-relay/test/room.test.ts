import { describe, expect, it } from "vitest";
import { MAX_BRAND_NAME, Room } from "../src/room";

/**
 * The room's uplink hello handler, run for real.
 *
 * Everything under this directory tested either a pure function or the router.
 * `sanitise.test.ts` calls `safeBrandName`/`safeColor` in isolation and
 * `speakerTag.test.ts` reads the hello LITERALS in this file - so the two
 * lines that actually put a brand into a room,
 *
 *   room.brandName = safeBrandName(msg.brandName);
 *   room.brandColor = safeColor(msg.brandColor);
 *
 * were covered by nothing. Verified by mutation before this file existed:
 * delete either assignment, or swap either sanitiser for the raw value, and
 * the whole suite stayed green. A future edit dropping one would have the
 * Worker replay `undefined` to every internet viewer for ever, silently -
 * which is the exact failure the whole branding design was shaped to prevent.
 *
 * There is no workers pool here to instantiate a Durable Object in, so the
 * state it runs against is a fake, in the same spirit as `reap.test.ts`'s
 * `fakeIo` and `claim.test.ts`'s stood-in bindings: a hand-written object
 * implementing the slice of `DurableObjectState` this handler touches, not a
 * mocked module. The room is a plain object and the assertions are about what
 * happened to it.
 *
 * `fetch` - the half that greets a viewer arriving later - is not driven here.
 * It needs `WebSocketPair` and a 101 `Response`, neither of which exists in
 * Node, and both are more platform than this is worth standing in for. What it
 * replays from is storage, so storage is what gets asserted: a brand that is
 * in the record is a brand a late joiner is greeted with.
 */

type Frame = Record<string, unknown>;

interface Sock {
  tags: string[];
  seen: Frame[];
  send(data: string): void;
}

const socket = (...tags: string[]): Sock => ({
  tags,
  seen: [],
  send(data: string) {
    this.seen.push(JSON.parse(data) as Frame);
  },
});

/** the tag string room.ts accepts an uplink under; not exported, so pinned here */
const UPLINK = "uplink";
const VIEWER = "viewer";

function stand() {
  const store = new Map<string, unknown>();
  store.set("room", {
    publisherSecret: "p",
    viewerSecret: "v",
    languages: { source: "en", target: "vi" },
    translates: true,
    live: false,
    lastSegId: 0,
    createdAt: 1_788_000_000_000,
  });
  const uplink = socket(UPLINK);
  const viewer = socket(VIEWER);
  const sockets = [uplink, viewer];

  const ctx = {
    storage: {
      // structuredClone on both sides, because a real Durable Object serialises:
      // aliasing the stored object would let `room.brandName = ...` reach the
      // record without `save()`, and a lost save is exactly how a late joiner
      // gets nothing. Without this the `stored()` assertions prove only assignment.
      get: async (key: string) => structuredClone(store.get(key)),
      put: async (key: string, value: unknown) => {
        store.set(key, structuredClone(value));
      },
      delete: async (key: string) => store.delete(key),
      deleteAll: async () => store.clear(),
      setAlarm: async () => undefined,
      getAlarm: async () => null,
      deleteAlarm: async () => undefined,
    },
    acceptWebSocket: () => undefined,
    getWebSockets: (tag?: string) => (tag ? sockets.filter((s) => s.tags.includes(tag)) : sockets),
    getTags: (ws: Sock) => ws.tags,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
  };

  const room = new Room(ctx as unknown as DurableObjectState, {});

  return {
    viewer,
    /** what the record holds between messages - the thing a late joiner is greeted from */
    stored: (): Frame => store.get("room") as Frame,
    /** the last hello this room fanned out to viewers */
    relayed: (): Frame | undefined => viewer.seen.filter((m) => m.type === "hello").pop(),
    hello: (brand: Frame = {}): Promise<void> =>
      room.webSocketMessage(
        uplink as unknown as WebSocket,
        JSON.stringify({
          type: "hello",
          languages: { source: "en", target: "vi" },
          translates: true,
          since: 1_788_000_000_000,
          ...brand,
        }),
      ),
  };
}

describe("a brand arriving on the hosted relay's uplink", () => {
  it("reaches the viewers watching and the record a late joiner is greeted from", async () => {
    const s = stand();
    await s.hello({ brandName: "SuprKernel Callouts", brandColor: "#e0a43a" });

    expect(s.relayed()?.brandName, "viewers watching were never told the name").toBe(
      "SuprKernel Callouts",
    );
    expect(s.relayed()?.brandColor, "viewers watching were never told the colour").toBe("#e0a43a");
    expect(s.stored().brandName, "nothing was stored, so a late joiner gets undefined").toBe(
      "SuprKernel Callouts",
    );
    expect(s.stored().brandColor, "nothing was stored, so a late joiner gets undefined").toBe(
      "#e0a43a",
    );
  });

  it("caps the name rather than passing on whatever arrived", async () => {
    // this Worker is the hop every internet viewer goes through and the one no
    // developer tests against, because the LAN path works
    const s = stand();
    await s.hello({ brandName: "x".repeat(200_000) });

    expect((s.relayed()?.brandName as string).length, "an uncapped name was fanned out").toBe(
      MAX_BRAND_NAME,
    );
    expect((s.stored().brandName as string).length, "an uncapped name was stored").toBe(
      MAX_BRAND_NAME,
    );
  });

  it("drops a colour that is not plainly #rrggbb, rather than escaping it", async () => {
    const s = stand();
    await s.hello({ brandColor: "#fff; background: url(http://evil/)" });

    expect(s.relayed()?.brandColor, "a colour carrying its own CSS was fanned out").toBeUndefined();
    expect(s.stored().brandColor, "a colour carrying its own CSS was stored").toBeUndefined();
  });

  it("clears one the streamer removed, because an absent brand is how they do that", async () => {
    const s = stand();
    await s.hello({ brandName: "SuprKernel Callouts", brandColor: "#e0a43a" });
    await s.hello();

    expect(s.stored().brandName, "a cleared name stayed in the record").toBeUndefined();
    expect(s.stored().brandColor, "a cleared colour stayed in the record").toBeUndefined();
  });
});

describe("whether a hello arriving on the hosted relay's uplink means anyone is streaming", () => {
  /**
   * Before this, `webSocketMessage` did `room.live = true` unconditionally on
   * every hello - so the room was re-marked live on every uplink reconnect,
   * every embedded-relay restart and every settings change while the app sat
   * idle in the tray. A hello is now expected to say so itself.
   */
  it("marks the room live when the hello says so", async () => {
    const s = stand();
    await s.hello({ live: true });

    expect(s.relayed()?.live, "a viewer watching was not told the stream is live").toBe(true);
    expect(s.stored().live, "a late joiner would not be told the stream is live").toBe(true);
  });

  it("leaves the room not-live when the hello says the app is merely running", async () => {
    const s = stand();
    await s.hello({ live: false });

    expect(
      s.relayed()?.live,
      "a viewer watching was told ON AIR by a hello that explicitly said otherwise",
    ).toBe(false);
    expect(
      s.stored().live,
      "a late joiner would be told ON AIR by a hello that explicitly said otherwise",
    ).toBe(false);
  });

  /**
   * `msg.live === true` (the literal in the task brief) would read an older
   * app's hello - which carries no `live` field at all, since the field is
   * new - as `false`, permanently. That is every install on the day this
   * Worker deploys: nobody has auto-updated yet, and this room would go from
   * "always live on a hello" (the old, buggy, but at-least-truthful-for-real-
   * streamers behaviour) to "never live" for every one of them. `translates`
   * a few lines above this handles the identical situation with
   * `msg.translates !== false`; `live` follows the same rule so an absent
   * field reads exactly as it did before this change.
   */
  it("treats an older app's hello with no live field as live, for backward compatibility", async () => {
    const s = stand();
    await s.hello(); // no `live` field at all - what a pre-this-change app sends

    expect(
      s.relayed()?.live,
      "an older app's hello stopped meaning ON AIR the moment this Worker deployed",
    ).toBe(true);
    expect(
      s.stored().live,
      "an older app's hello stopped meaning ON AIR the moment this Worker deployed",
    ).toBe(true);
  });
});
