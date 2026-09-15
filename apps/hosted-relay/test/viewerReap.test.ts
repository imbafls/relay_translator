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
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

function socket(tag: string, beat: Date | null): Sock {
  return {
    tags: [tag],
    seen: [],
    closed: [],
    beat,
    send(data: string) {
      this.seen.push(JSON.parse(data) as Frame);
    },
    close(code?: number, reason?: string) {
      this.closed.push({ code, reason });
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

  const ctx = {
    storage: {
      get: async () => undefined,
      put: async () => undefined,
    },
    acceptWebSocket: () => undefined,
    getWebSockets: (tag?: string) => (tag ? all.filter((s) => s.tags.includes(tag)) : all),
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
    /** the count this room last told the app */
    reported: (): number | undefined =>
      uplink.seen.filter((m) => m.type === "viewers").pop()?.count,
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
