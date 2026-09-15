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
  /** every storage.put this room made - the thing a Durable Object is billed for */
  let puts = 0;
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
        puts += 1;
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
    /** storage writes so far; `stand()` itself makes none */
    writes: (): number => puts,
    /** every subtitle this room fanned out to viewers, in order */
    captions: (): Frame[] => viewer.seen.filter((m) => m.type === "subtitle"),
    subtitle: (seg: Frame): Promise<void> =>
      room.webSocketMessage(uplink as unknown as WebSocket, JSON.stringify({ type: "subtitle", ...seg })),
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

/**
 * What a silent channel costs the hosted room.
 *
 * Every subtitle carrying a higher segment id drove `this.save(room)`, which is
 * `ctx.storage.put("room", next)`. Wordless finals carry higher ids too - the
 * recogniser emits one every couple of seconds on a quiet channel, deliberately,
 * so a viewer can retire its open interim row - and the uplink forwards them
 * verbatim (`bridgeBroadcasts()` in apps/standalone/src/main.ts has no wordless
 * check). So silence wrote.
 *
 * The measurement is the test. One 94-minute session recorded in this repo
 * carried 3,105 wordless finals against 657 real ones, and those are the numbers
 * driven below: 3,762 writes before, 657 after.
 *
 * **The broadcast must not change.** A remote viewer needs the empty final for
 * exactly the reason a local one does, so every subtitle still has to reach it -
 * that half is asserted here too, and is green either way.
 *
 * Keeping the running maximum in memory instead is not available: `room` is
 * re-read from storage at the top of every `webSocketMessage`, and the Durable
 * Object can be evicted between messages under the hibernation API, so an
 * instance field would not survive either. Not writing is the whole saving.
 */
describe("what a silent channel costs the hosted room in storage writes", () => {
  /** the repo's own measured session: 3,105 wordless finals against 657 real */
  const SPOKEN = 657;
  const WORDLESS = 3105;
  /** wordless finals per real line, with the remainder trailing after the last one */
  const GAP = Math.floor(WORDLESS / SPOKEN);

  /** drive a session shaped like that one, a caption at a time with its silence */
  async function session(s: ReturnType<typeof stand>): Promise<{ lastSpokenId: number }> {
    let id = 0;
    let quiet = 0;
    let lastSpokenId = 0;
    for (let line = 0; line < SPOKEN; line++) {
      for (let q = 0; q < GAP; q++) {
        await s.subtitle({ id: ++id, source: "" });
        quiet += 1;
      }
      await s.subtitle({ id: ++id, source: "rush B" });
      lastSpokenId = id;
    }
    // the session ends on silence, as one does
    while (quiet < WORDLESS) {
      await s.subtitle({ id: ++id, source: "" });
      quiet += 1;
    }
    return { lastSpokenId };
  }

  it("writes once per caption, not once per silent tick", async () => {
    const s = stand();
    await session(s);

    expect(s.writes(), "silence is still driving a storage write on every tick").toBe(SPOKEN);
  });

  it("still fans every subtitle out, wordless ones included", async () => {
    const s = stand();
    await session(s);

    expect(
      s.captions().length,
      "a remote viewer stopped getting the empty final it retires its interim row with",
    ).toBe(SPOKEN + WORDLESS);
  });

  it("records the last caption a viewer actually rendered, not the last tick of silence", async () => {
    const s = stand();
    const { lastSpokenId } = await session(s);

    expect(
      s.stored().lastSegId,
      "the furthest-we-have-got mark counts ids no viewer ever put on screen",
    ).toBe(lastSpokenId);
  });

  it("passes a wordless final through untouched, so it can still retire an interim row", async () => {
    const s = stand();
    await s.subtitle({ id: 7, source: "", channel: 1 });

    const [only] = s.captions();
    expect(only, "the wordless final never reached the viewer at all").toBeTruthy();
    expect(only.id).toBe(7);
    expect(only.source).toBe("");
    expect(only.channel).toBe(1);
    expect(s.writes(), "a wordless final on its own still wrote").toBe(0);
  });

  it("still records a line that carries only a translation", async () => {
    const s = stand();
    await s.subtitle({ id: 3, source: "", target: "đẩy B" });

    expect(s.stored().lastSegId, "a translated line was treated as silence").toBe(3);
  });

  it("does not let a reconnecting uplink's restarted numbering rewind the mark", async () => {
    const s = stand();
    await s.subtitle({ id: 100, source: "rush B" });
    await s.subtitle({ id: 50, source: "they pushed" });

    expect(s.stored().lastSegId, "a rewound id moved the mark backwards").toBe(100);
    expect(s.captions().length, "the rewound line was dropped instead of relayed").toBe(2);
  });
});
