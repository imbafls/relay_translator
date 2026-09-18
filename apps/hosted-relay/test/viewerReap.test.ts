import { describe, expect, it } from "vitest";
import { Room } from "../src/room";

/**
 * The viewer count, and the socket nobody could account for.
 *
 * `apps/hosted-relay/README.md` has carried this under "Still open" since the
 * service went up: the first room the desktop app attached to reported one
 * viewer with nothing watching, a room claimed later reported zero from the
 * same app, and it was never explained. The note says it is cosmetic today but
 * should be chased before anyone relies on the count.
 *
 * A viewer socket that died without a FIN is a complete explanation for it.
 * The count is `getWebSockets("viewer").length`; hibernation means this object
 * holds no timer of its own, so a socket whose phone walked into a tunnel is
 * held until something else closes it, and nothing else ever does. A room that
 * had never been opened would read zero, and the first one - opened once to
 * check it worked - would read one, for ever.
 *
 * That was unfixable cheaply until viewers started beating. Now the runtime
 * records when each socket last auto-responded, so the object can tell a live
 * viewer from a held one at the moment it is already awake, with no alarm and
 * no extra wake-up.
 *
 * The case that must NOT be reaped is a viewer page served before the
 * heartbeat shipped: it never beats, its timestamp is null for ever, and
 * reaping on that would close a healthy reader and put it in a reconnect loop
 * against a room that keeps closing it.
 */

const UPLINK = "uplink";
const VIEWER = "viewer";
const MINUTE = 60_000;

interface Frame {
  type?: string;
  count?: number;
}

interface Sock {
  tags: string[];
  seen: Frame[];
  closed: { code?: number; reason?: string }[];
  /** what the runtime last auto-answered for this socket; null = never has */
  beat: Date | null;
  /** the runtime stops handing back a socket once it is closed, and so does this */
  open: boolean;
  /** 1 OPEN, 2 CLOSING, 3 CLOSED - the WebSocket readyState the runtime reports */
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

function socket(tag: string, beat: Date | null): Sock {
  return {
    tags: [tag],
    seen: [],
    closed: [],
    beat,
    open: true,
    readyState: 1,
    send(data: string) {
      this.seen.push(JSON.parse(data) as Frame);
    },
    close(code?: number, reason?: string) {
      this.closed.push({ code, reason });
      this.open = false;
      this.readyState = 3;
    },
  };
}

function stand(viewers: Sock[]) {
  const uplink = socket(UPLINK, null);
  const all = [uplink, ...viewers];

  (globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
    class {
      constructor(
        readonly request: string,
        readonly response: string,
      ) {}
    };

  const store = new Map<string, unknown>([
    [
      "room",
      {
        publisherSecret: "p",
        viewerSecret: "v",
        languages: { source: "en", target: "vi" },
        translates: true,
        live: true,
        lastSegId: 0,
        createdAt: 1_788_000_000_000,
      },
    ],
  ]);

  const ctx = {
    storage: {
      get: async (key: string) => structuredClone(store.get(key)),
      put: async (key: string, value: unknown) => void store.set(key, structuredClone(value)),
    },
    acceptWebSocket: () => undefined,
    getWebSockets: (tag?: string) =>
      (tag ? all.filter((s) => s.tags.includes(tag)) : all).filter((s) => s.open),
    getTags: (ws: Sock) => ws.tags,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
    setWebSocketAutoResponse: () => undefined,
    getWebSocketAutoResponseTimestamp: (ws: Sock) => ws.beat,
  };

  const room = new Room(ctx as unknown as ConstructorParameters<typeof Room>[0], {});

  return {
    uplink,
    /** drive a viewer disconnecting, which is what recomputes the count */
    aViewerLeaves: (ws: Sock): Promise<void> => room.webSocketClose(ws as never),
    /** one caption off the uplink - the thing that happens while a stream runs */
    caption: (id: number, source: string): Promise<void> =>
      room.webSocketMessage(uplink as never, JSON.stringify({ type: "subtitle", id, source })),
    /** the count this room last told the app */
    reported: (): number | undefined =>
      uplink.seen.filter((m) => m.type === "viewers").pop()?.count,
    /** how many times it has told the app at all */
    countsSent: (): number => uplink.seen.filter((m) => m.type === "viewers").length,
  };
}

const ago = (ms: number): Date => new Date(Date.now() - ms);

describe("a viewer socket nothing ever closed", () => {
  it("is left out of the count the app is shown", async () => {
    const gone = socket(VIEWER, ago(5 * MINUTE));
    const watching = socket(VIEWER, ago(5_000));
    const leaving = socket(VIEWER, ago(1_000));
    const s = stand([gone, watching, leaving]);

    await s.aViewerLeaves(leaving);

    expect(
      s.reported(),
      "the count still includes a viewer that stopped answering minutes ago. That is the number the README " +
        "records as unexplained, and it never comes down on its own - nothing here holds a timer.",
    ).toBe(2);
  });

  it("is closed, so the runtime stops holding it", async () => {
    const gone = socket(VIEWER, ago(5 * MINUTE));
    const watching = socket(VIEWER, ago(5_000));
    const s = stand([gone, watching]);

    await s.aViewerLeaves(watching);

    expect(gone.closed, "the dead socket was dropped from the count but never actually let go").toHaveLength(1);
    expect(
      watching.closed,
      "a viewer that answered five seconds ago was closed as well - this reaps live readers",
    ).toHaveLength(0);
  });

  it("is never a viewer that has simply never beaten", async () => {
    // a page served before the heartbeat shipped: it cannot beat, and closing
    // it would reconnect it into a room that closes it again
    const older = socket(VIEWER, null);
    const leaving = socket(VIEWER, ago(1_000));
    const s = stand([older, leaving]);

    await s.aViewerLeaves(leaving);

    expect(
      older.closed,
      "a viewer that has never sent a heartbeat was treated as dead. A page from before the heartbeat shipped " +
        "never sends one, and this would close it every time anyone else disconnects.",
    ).toHaveLength(0);
    expect(s.reported(), "and it must still be counted - somebody is reading on it").toBe(2);
  });
});

/**
 * The case the sweep above does not reach on its own.
 *
 * `d4f0323` put the sweep in `viewerCount()`, and the count is only recomputed
 * when a viewer arrives or leaves. So a room with one held socket and nobody
 * else joining keeps reporting that viewer for the whole stream - which is
 * exactly the situation the README describes, and exactly when the streamer is
 * looking at the readout.
 *
 * Captions are the thing that is already happening. The object is awake to fan
 * every one of them out, so sweeping there costs a timestamp read per viewer
 * and no wake-up at all.
 */
describe("a stream running with a socket nobody closed", () => {
  it("corrects the count without waiting for another viewer to come or go", async () => {
    const gone = socket(VIEWER, ago(5 * MINUTE));
    const watching = socket(VIEWER, ago(5_000));
    const s = stand([gone, watching]);

    await s.caption(1, "rush B");

    expect(
      s.reported(),
      "a caption went out to a socket that stopped answering minutes ago and the app was still told two people " +
        "are reading. Nothing else will correct it while one reader is watching and nobody else joins.",
    ).toBe(1);
    expect(gone.closed, "the held socket was never let go").toHaveLength(1);
    expect(watching.seen.filter((m) => m.type === "subtitle"), "the live viewer lost its caption").toHaveLength(1);
  });

  it("tells the app once, not once per caption", async () => {
    const gone = socket(VIEWER, ago(5 * MINUTE));
    const watching = socket(VIEWER, ago(5_000));
    const s = stand([gone, watching]);

    await s.caption(1, "one");
    const afterFirst = s.countsSent();
    await s.caption(2, "two");
    await s.caption(3, "three");

    expect(
      s.countsSent(),
      "the room re-announces the viewer count on every caption. A dense stream is one every 2.5 s, and this " +
        "is a billed message to the uplink for a number that has not changed.",
    ).toBe(afterFirst);
  });

  it("says nothing at all when every viewer is answering", async () => {
    const watching = socket(VIEWER, ago(5_000));
    const alsoWatching = socket(VIEWER, ago(2_000));
    const s = stand([watching, alsoWatching]);

    await s.caption(1, "one");
    await s.caption(2, "two");

    expect(
      s.countsSent(),
      "a room where nothing changed still sent the app a viewer count, so this fires on every caption of every " +
        "healthy stream",
    ).toBe(0);
  });
});

/**
 * The publisher that was replaced, and the stream it must not end.
 *
 * One publisher per room: a second uplink closes the first with
 * `CLOSE_REPLACED` and takes over. That is not a stream ending - it is the same
 * stream, carried by a socket that reconnected, which is what happens on every
 * network blip, every embedded-relay restart and every settings change while
 * the app sits in the tray.
 *
 * `webSocketClose` identified an uplink by its tag alone and had no notion of
 * which socket is the current one, so the replaced socket's close marked the
 * room not live and told every viewer "stream ended" - while the publisher that
 * replaced it was connected and streaming.
 *
 * `packages/relay/src/server.ts` had already reached the rule for exactly this
 * event, and says it where it accepts a new uplink: a new uplink has said
 * nothing yet, "not the replaced one's last word, whose own close handler no
 * longer matches `uplink === ws` to clear it". The hosted relay had no such
 * guard.
 */
describe("a publisher replaced by a newer one", () => {
  function twoUplinks() {
    const older = socket(UPLINK, null);
    const newer = socket(UPLINK, null);
    const viewer = socket(VIEWER, new Date());
    const all = [older, newer, viewer];

    (globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
      class {
        constructor(
          readonly request: string,
          readonly response: string,
        ) {}
      };

    const store = new Map<string, unknown>([
      [
        "room",
        {
          publisherSecret: "p",
          viewerSecret: "v",
          languages: { source: "en", target: "vi" },
          translates: true,
          live: true,
          lastSegId: 0,
          createdAt: 1_788_000_000_000,
        },
      ],
    ]);

    const ctx = {
      storage: {
        get: async (key: string) => structuredClone(store.get(key)),
        put: async (key: string, value: unknown) => void store.set(key, structuredClone(value)),
      },
      acceptWebSocket: () => undefined,
      getWebSockets: (tag?: string) =>
        (tag ? all.filter((s) => s.tags.includes(tag)) : all).filter((s) => s.open),
      getTags: (ws: Sock) => ws.tags,
      blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
      setWebSocketAutoResponse: () => undefined,
      getWebSocketAutoResponseTimestamp: (ws: Sock) => ws.beat,
    };

    const room = new Room(ctx as unknown as ConstructorParameters<typeof Room>[0], {});
    return {
      room,
      older,
      newer,
      viewer,
      live: async (): Promise<boolean> =>
        ((await ctx.storage.get("room")) as { live: boolean } | undefined)?.live === true,
    };
  }

  it("does not end the stream the newer one is carrying", async () => {
    const r = twoUplinks();
    // the older socket is closed by the takeover, the way closeAll does it
    r.older.close(4409, "replaced by new publisher");
    await r.room.webSocketClose(r.older as never);

    expect(
      r.viewer.seen.filter((m) => m.type === "status"),
      "every viewer was told the stream ended while the publisher that replaced this socket was connected " +
        "and streaming - which is one blip of the app's network away",
    ).toEqual([]);
    expect(await r.live(), "the room was marked not live under a connected publisher").toBe(true);
  });

  it("still ends it when the last publisher goes", async () => {
    const r = twoUplinks();
    // both uplinks gone: this really is the stream ending
    r.older.close();
    r.newer.close();
    await r.room.webSocketClose(r.newer as never);

    expect(
      r.viewer.seen.filter((m) => m.type === "status").map((m) => (m as { live?: boolean }).live),
      "the last publisher left and nobody watching was told",
    ).toEqual([false]);
    expect(await r.live()).toBe(false);
  });

  /**
   * The replaced socket that never finished closing.
   *
   * Cloudflare's own documentation for `getWebSockets`: it "may still return
   * WebSockets even after `ws.close` has been called" - a server that sent its
   * close and got none back holds that socket in CLOSING until it notices the
   * disconnect. A peer that stopped answering is exactly what a network blip
   * leaves behind, and a network blip is exactly what makes the app reconnect
   * and replace it. So "is any other uplink attached" is true of a corpse, and
   * the real publisher leaving afterwards would be answered by nothing at all:
   * the room kept live, every viewer left under ON AIR with no stream behind it.
   */
  it("still ends it when the one it replaced has not finished closing", async () => {
    const r = twoUplinks();
    // the takeover's close went out and the half-open peer never answered it
    r.older.close(4409, "replaced by new publisher");
    r.older.open = true;
    r.older.readyState = 2;
    // then the publisher that replaced it really does go
    r.newer.close();
    await r.room.webSocketClose(r.newer as never);

    expect(
      r.viewer.seen.filter((m) => m.type === "status").map((m) => (m as { live?: boolean }).live),
      "the last real publisher left and the room kept every viewer on ON AIR, because a socket already " +
        "closed by the takeover was still being handed back in CLOSING",
    ).toEqual([false]);
    expect(await r.live()).toBe(false);
  });
});
