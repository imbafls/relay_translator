import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Room } from "../src/room";

/**
 * A publisher that vanished without saying so.
 *
 * The streamer's PC loses power, blue-screens, or drops off the network. Its
 * uplink never sends a close frame, so `webSocketClose` never runs, and the
 * only other things that set a room not-live - the uplink's own `hello` and
 * `status` - need that same uplink to speak. So the room stayed ON AIR: viewers
 * already watching kept a running clock over no captions, every viewer who
 * opened the link later was greeted with `live: true`, and `/health` agreed.
 *
 * The uplink has always beaten - `{"type":"ping"}` every 20 s since before
 * 0.8.1, the exact frame the runtime auto-answers - so the room already had the
 * evidence and read none of it. A viewer's silence was already acted on this
 * way; a publisher's was not.
 *
 * `fetch` is driven here, unlike `room.test.ts`: the late joiner's greeting is
 * the heart of this, so `WebSocketPair` and a 101 `Response` are stood in for,
 * for this file only.
 */

const UPLINK = "uplink";
const VIEWER = "viewer";
const MINUTE = 60_000;

type Frame = Record<string, unknown>;

interface Sock {
  tags: string[];
  seen: Frame[];
  closed: { code?: number; reason?: string }[];
  /** when the runtime last auto-answered this socket's heartbeat; null = never */
  beat: Date | null;
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

function socket(tags: string[], beat: Date | null): Sock {
  return {
    tags,
    seen: [],
    closed: [],
    beat,
    readyState: 1,
    send(data: string) {
      this.seen.push(JSON.parse(data) as Frame);
    },
    close(code?: number, reason?: string) {
      this.closed.push({ code, reason });
      this.readyState = 3;
    },
  };
}

const ago = (ms: number): Date => new Date(Date.now() - ms);

// Node has no WebSocketPair, and its Response refuses a 101. Response is put
// back afterwards; the two WebSocket stand-ins stay installed, as room.test.ts
// leaves WebSocketRequestResponsePair - vitest isolates each file anyway.
const RealResponse = globalThis.Response;
beforeEach(() => {
  (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = class {
    0 = socket([], null);
    1 = socket([], null);
  };
  (globalThis as unknown as { Response: unknown }).Response = function (body: BodyInit | null, init?: ResponseInit) {
    if (init?.status === 101) return { status: 101 };
    return new RealResponse(body, init);
  };
  (globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair = class {
    constructor(
      readonly request: string,
      readonly response: string,
    ) {}
  };
});
afterEach(() => {
  (globalThis as unknown as { Response: unknown }).Response = RealResponse;
});

/** a live room, its uplink last heard from `uplinkBeat` ago, with one viewer watching */
function stand(uplinkBeat: Date | null, opts: { uplinkState?: number; live?: boolean; halfOpen?: boolean } = {}) {
  const uplink = socket([UPLINK], uplinkBeat);
  if (opts.uplinkState) uplink.readyState = opts.uplinkState;
  // a peer that never answers the close: the runtime keeps the socket, CLOSING
  if (opts.halfOpen) {
    uplink.close = (code?: number, reason?: string) => {
      uplink.closed.push({ code, reason });
      uplink.readyState = 2;
    };
  }
  const watching = socket([VIEWER], ago(5_000));
  const all: Sock[] = [uplink, watching];
  const store = new Map<string, unknown>([
    [
      "room",
      {
        publisherSecret: "p",
        viewerSecret: "v",
        languages: { source: "en", target: "vi" },
        translates: true,
        live: opts.live ?? true,
        liveDeclared: opts.live ?? true,
        since: 1_788_000_000_000,
        lastSegId: 0,
        createdAt: 1_788_000_000_000,
        usedAt: 1_788_000_000_000,
      },
    ],
  ]);
  let alarm: number | null = null;

  const ctx = {
    storage: {
      get: async (key: string) => structuredClone(store.get(key)),
      put: async (key: string, value: unknown) => void store.set(key, structuredClone(value)),
      delete: async (key: string) => store.delete(key),
      deleteAll: async () => store.clear(),
      setAlarm: async (at: number | Date) => void (alarm = Number(at)),
      getAlarm: async () => alarm,
      deleteAlarm: async () => void (alarm = null),
    },
    acceptWebSocket: (ws: Sock, tags: string[]) => {
      ws.tags = tags;
      all.push(ws);
    },
    // the runtime stops handing back a socket once it is fully closed
    getWebSockets: (tag?: string) => all.filter((s) => s.readyState !== 3 && (!tag || s.tags.includes(tag))),
    getTags: (ws: Sock) => ws.tags,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
    setWebSocketAutoResponse: () => undefined,
    getWebSocketAutoResponseTimestamp: (ws: Sock) => ws.beat,
  };
  const room = new Room(ctx as unknown as ConstructorParameters<typeof Room>[0], {});
  const req = (op: string, headers: Record<string, string> = {}): Request =>
    new Request(`https://room/?op=${op}&rid=r&secret=${op === "viewer" ? "v" : "p"}`, { headers });

  return {
    uplink,
    watching,
    stored: () => store.get("room") as Frame,
    alarm: () => alarm,
    armed: (at: number) => void (alarm = at),
    /** a phone opening the link now: the greeting is the first thing it is sent */
    lateJoiner: async (): Promise<Frame | undefined> => {
      await room.fetch(req("viewer", { Upgrade: "websocket" }));
      const arrived = all[all.length - 1]!;
      return arrived.seen.find((m) => m.type === "hello");
    },
    /** the desktop app's uplink (re)connecting: every frame the room sends it */
    uplinkArrives: async (): Promise<Frame[]> => {
      await room.fetch(req("uplink", { Upgrade: "websocket" }));
      return all[all.length - 1]!.seen;
    },
    health: async (): Promise<Frame> => (await (await room.fetch(req("health"))).json()) as Frame,
    sync: async (): Promise<Frame | undefined> => {
      await room.webSocketMessage(watching as never, JSON.stringify({ type: "sync" }));
      return watching.seen.filter((m) => m.type === "hello").pop();
    },
    /** the runtime clears an alarm as it fires it; only the handler can set another */
    fireAlarm: (): Promise<void> => {
      alarm = null;
      return room.alarm();
    },
    /** every status the viewer already watching has been sent */
    statuses: (): Frame[] => watching.seen.filter((m) => m.type === "status"),
    status: (live: boolean): Promise<void> =>
      room.webSocketMessage(uplink as never, JSON.stringify({ type: "status", live })),
    /** `live` left out is a hello from an app older than 0.8, which never sent one */
    hello: (live?: boolean): Promise<void> =>
      room.webSocketMessage(
        uplink as never,
        JSON.stringify({
          type: "hello",
          languages: { source: "en", target: "vi" },
          translates: true,
          ...(live === undefined ? {} : { live }),
        }),
      ),
  };
}

describe("a publisher that vanished without a close", () => {
  it("is not what a viewer opening the link is greeted with", async () => {
    const s = stand(ago(5 * MINUTE));

    const hello = await s.lateJoiner();

    expect(hello, "the late joiner was never greeted").toBeDefined();
    expect(
      hello!.live,
      "a viewer opening the link was told the stream is live, from a publisher silent for five minutes",
    ).toBe(false);
    expect(s.uplink.closed, "the silent uplink was left attached").toEqual([{ code: 4408, reason: "no heartbeat" }]);
    expect(s.stored().live, "the room still records a live stream").toBe(false);
  });

  it("is told to viewers already watching, when the room checks on it", async () => {
    const s = stand(ago(5 * MINUTE));

    await s.fireAlarm();

    expect(
      s.watching.seen.filter((m) => m.type === "status").pop(),
      "a viewer watching sat on ON AIR with a running clock over a publisher that was gone",
    ).toMatchObject({ live: false, message: "stream ended" });
    // nothing live is left to check on
    expect(s.alarm()).toBeNull();
  });

  it("is not reported live by /health", async () => {
    const s = stand(ago(5 * MINUTE));
    expect((await s.health()).live).toBe(false);
  });

  it("is not what a viewer catching up after a blip is told", async () => {
    const s = stand(ago(5 * MINUTE));
    expect((await s.sync())?.live).toBe(false);
  });

  // the uplink closed by a takeover but never answered sits in CLOSING, and a
  // room whose only uplink is that one has nobody publishing
  it("does not count an uplink the room already closed", async () => {
    const s = stand(ago(5_000), { uplinkState: 2 });
    expect((await s.lateJoiner())?.live).toBe(false);
  });
});

describe("a publisher that is there", () => {
  it("keeps the room live, attached, and checked on again", async () => {
    const s = stand(ago(15_000));

    expect((await s.lateJoiner())?.live).toBe(true);
    await s.fireAlarm();

    expect(s.uplink.closed, "a publisher that beat fifteen seconds ago was dropped").toEqual([]);
    expect(s.stored().live).toBe(true);
    expect(s.watching.seen.filter((m) => m.type === "status")).toEqual([]);
    const at = s.alarm();
    expect(at, "a live room stopped checking on its publisher").not.toBeNull();
    expect(at! - Date.now()).toBeLessThanOrEqual(2 * MINUTE);
  });

  // three of its rounds late is a slow network, not a dead one: the uplink
  // itself would not have given up yet, and neither may the room
  it("is never one that is only slow", async () => {
    const s = stand(ago(55_000));
    expect((await s.lateJoiner())?.live).toBe(true);
    expect(s.uplink.closed, "a publisher that beat 55 s ago was dropped as gone").toEqual([]);
  });

  // An uplink that has never beaten is one that connected a moment ago and has
  // not yet sent its first ping. Silence only counts against a socket that has
  // spoken, exactly as for viewers.
  it("is never one that has simply not beaten yet", async () => {
    const s = stand(null);
    expect((await s.lateJoiner())?.live).toBe(true);
    expect(s.uplink.closed).toEqual([]);
  });

  // the check runs from an alarm, and something has to set it: a room that goes
  // live is a room that must be looked in on
  it("arms the check when it goes live", async () => {
    const s = stand(ago(5_000));
    await s.hello(true);
    const at = s.alarm();
    expect(at, "going live set no alarm, so a publisher vanishing later would never be noticed").not.toBeNull();
    expect(at! - Date.now()).toBeLessThanOrEqual(2 * MINUTE);
  });

  // a session starting is a status, not a hello: the app connects its uplink
  // at boot and says live only when START is pressed
  it("arms it on a status that says live, too", async () => {
    const s = stand(ago(5_000));
    await s.status(true);
    expect(s.alarm(), "a session started by status set no alarm").not.toBeNull();
  });

  // a room already due to be looked at sooner is left alone: every hello and
  // status would otherwise push the check back, and a publisher that kept
  // reconnecting would never be checked at all
  it("does not push back a check that is already due", async () => {
    const s = stand(ago(5_000));
    const due = Date.now() + 10_000;
    s.armed(due);
    await s.hello(true);
    expect(s.alarm()).toBe(due);
  });
});

describe("a room that is not on air", () => {
  // nothing to end: a silent uplink here is an app that was closed, and the
  // room already says so
  it("is left alone by every check", async () => {
    const s = stand(ago(5 * MINUTE), { live: false });
    await s.lateJoiner();
    await s.health();
    await s.sync();
    await s.fireAlarm();

    expect(s.uplink.closed).toEqual([]);
    expect(s.statuses(), "viewers of a room that was never on air were told the stream ended").toEqual([]);
    expect(s.alarm()).toBeNull();
  });

  // The runtime keeps handing back an uplink this room closed until its peer
  // answers, and the peer this exists for never will. Every later check must
  // not announce the end again.
  it("says stream ended once, however many checks follow", async () => {
    const s = stand(ago(5 * MINUTE), { halfOpen: true });
    await s.fireAlarm();
    await s.lateJoiner();
    await s.health();
    await s.sync();
    await s.fireAlarm();

    expect(s.statuses().filter((m) => m.message === "stream ended")).toHaveLength(1);
    expect(s.uplink.closed).toHaveLength(1);
  });

  it("is not looked in on after a hello or status that says so", async () => {
    const a = stand(ago(5_000));
    await a.hello(false);
    expect(a.alarm()).toBeNull();
    const b = stand(ago(5_000));
    await b.status(false);
    expect(b.alarm()).toBeNull();
  });
});

/**
 * An app from before 0.8, which is still out there until it auto-updates.
 *
 * Its uplink connects at boot and says hello with no `live` field, which this
 * room reads as live - deliberately, so those users kept working the day the
 * field arrived. Arming the alarm on that would cost a billed request a minute
 * for as long as such an app sat in the tray, streaming nothing.
 */
describe("an app from before 0.8", () => {
  it("sitting in the tray starts no alarm", async () => {
    const s = stand(ago(5_000), { live: false });
    await s.hello(undefined);
    expect(s.stored().live, "an older app's hello must still read as live").toBe(true);
    expect(s.alarm(), "an idle older app set the liveness alarm, a billed request a minute all day").toBeNull();
  });

  // its sessions still say so with a status, and those are checked
  it("is still looked in on when a session starts", async () => {
    const s = stand(ago(5_000), { live: false });
    await s.status(true);
    expect(s.alarm()).not.toBeNull();
    await s.fireAlarm();
    expect(s.alarm(), "an older app's running session was checked once and then never again").not.toBeNull();
  });

  // STOP, then the app reconnects while the check is still pending: its hello
  // makes the room read live again, and that must not restart the loop
  it("does not keep the alarm going after a session stops", async () => {
    const s = stand(ago(5_000), { live: false });
    await s.status(true);
    await s.status(false);
    await s.hello(undefined);
    await s.fireAlarm();
    expect(s.alarm(), "an older app's reconnect after STOP kept the minute-by-minute alarm alive").toBeNull();
  });
});

/**
 * A publisher coming back to viewers already there.
 *
 * The uplink reconnects on every network blip, every heartbeat give-up, every
 * app start and every relay setting changed - and the client zeroes its
 * viewer count on each close. The room greeted the new uplink with `ready`
 * and nothing else, and it only ever sends a count when a viewer arrives or
 * leaves. So the app read 0 watching over a room full of readers, and NEW,
 * which asks SURE? only when someone is reading, replaced the link on one
 * press - THIS LINK HAS ENDED on every phone, with no warning to the streamer.
 * The self-hosted relay has always sent the count right after `ready`.
 */
describe("a publisher reconnecting to viewers already there", () => {
  it("is told how many are watching as soon as it connects", async () => {
    const s = stand(ago(5_000));
    await s.lateJoiner();

    const frames = await s.uplinkArrives();

    expect(frames[0]).toEqual({ type: "ready" });
    expect(
      frames.find((m) => m.type === "viewers"),
      "a reconnecting publisher was left believing nobody is watching two readers",
    ).toEqual({ type: "viewers", count: 2 });
  });

  // a reader gone silent is not someone NEW should ask about
  it("is told the number actually there, not the sockets still held", async () => {
    const s = stand(ago(5_000));
    s.watching.beat = ago(5 * MINUTE);

    const frames = await s.uplinkArrives();

    expect(frames.find((m) => m.type === "viewers")).toEqual({ type: "viewers", count: 0 });
  });
});

// A viewer opening the link mid-stream is greeted the same way: with a
// duration measured here, not only the streamer's timestamp (room.test.ts
// holds the relayed hello, the status and the sync reply).
describe("a late joiner's session clock", () => {
  it("is greeted with how long the stream has been on", async () => {
    const s = stand(ago(5_000));
    const hello = await s.lateJoiner();
    const expected = Date.now() - 1_788_000_000_000;
    expect(typeof hello?.elapsedMs, "the greeting carries no elapsedMs, so a phone runs the clock on its own").toBe(
      "number",
    );
    expect(Math.abs((hello?.elapsedMs as number) - expected)).toBeLessThan(5_000);
  });
});

// Counting for /health lets go of a viewer that has gone silent - and threw
// away that it had, so the app went on showing the old number.
describe("a health check that finds a viewer gone", () => {
  it("tells the app the count went down", async () => {
    const s = stand(ago(5_000));
    s.watching.beat = ago(5 * MINUTE);

    const health = await s.health();

    expect(health.viewers).toBe(0);
    expect(
      s.uplink.seen.filter((m) => m.type === "viewers").pop(),
      "the app was never told the silent viewer was let go",
    ).toEqual({ type: "viewers", count: 0 });
  });
});
