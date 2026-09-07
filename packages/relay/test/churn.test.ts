import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import type { ServerToViewer } from "@callout-relay/shared";
import { startRelay } from "../src/server";
import type { RelayHandle } from "../src/server";

/**
 * What a long session actually looks like: the publisher reconnects, the user
 * changes a setting so the session is rebuilt, a phone comes and goes. None of
 * that should leave a duplicate anywhere - a doubled subtitle is two captions
 * on screen, and a doubled broadcast listener is every caption sent twice to
 * the VPS.
 */

let relay: RelayHandle;
let dir: string;
const sockets: WebSocket[] = [];

function connect(url: string): Promise<{ ws: WebSocket; seen: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const seen: Record<string, unknown>[] = [];
    // both roles are greeted the instant they are accepted
    ws.on("message", (d: Buffer) => {
      try {
        seen.push(JSON.parse(d.toString()));
      } catch {
        /* not ours */
      }
    });
    ws.once("open", () => resolve({ ws, seen }));
    ws.once("error", reject);
  });
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, ms = 6000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`${what} never happened within ${ms}ms`);
    await settle(20);
  }
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-churn-"));
  relay = await startRelay({ port: 0, dataDir: dir, mockStt: true, mockGemini: true });
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    try {
      ws.close();
    } catch {
      /* gone */
    }
  }
  await relay?.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
});

const pubUrl = (): string => `ws://127.0.0.1:${relay.port}/ws/publisher?token=${relay.state.publisherToken}`;
const viewUrl = (): string => `ws://127.0.0.1:${relay.port}/ws/viewer?token=${relay.state.viewerToken}`;

const hello = (source = "en") =>
  JSON.stringify({
    type: "hello",
    stt: "deepgram-nova-3",
    translation: "gemini-3.1-flash-lite",
    languages: { source, target: "vi" },
    translationEnabled: true,
    channels: 1,
  });

/** 2 s of 16 kHz mono: the mock STT emits exactly one final per 2 s */
const utterance = (): Buffer => Buffer.alloc(16000 * 2 * 2, 1);

/**
 * One entry per utterance. A final goes out twice by design - the source
 * immediately, then the translation patching the same segment id - so counting
 * every `final` counts each utterance twice.
 */
const utterances = (seen: Record<string, unknown>[]): Record<string, unknown>[] =>
  seen.filter((m) => m.type === "subtitle" && m.final === true && m.target === undefined);

/** stream until `want` finals have been seen by the viewer, or give up */
async function streamUntil(ws: WebSocket, seen: Record<string, unknown>[], want: number): Promise<void> {
  const finals = (): number => utterances(seen).length;
  const timer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(utterance());
  }, 60);
  try {
    await until(() => finals() >= want, `${want} final subtitles`);
  } finally {
    clearInterval(timer);
  }
}

describe("rebuilding the session mid-stream", () => {
  it("does not start emitting each caption twice", async () => {
    const viewer = await connect(viewUrl());
    const pub = await connect(pubUrl());

    pub.ws.send(hello());
    await streamUntil(pub.ws, viewer.seen, 1);

    // a settings change rebuilds the session on the same socket
    pub.ws.send(hello("de"));
    await settle(200);

    const before = utterances(viewer.seen).length;
    await streamUntil(pub.ws, viewer.seen, before + 1);
    await settle(400);

    // one more utterance means exactly one more caption
    expect(utterances(viewer.seen).length - before).toBe(1);
  });

  it("keeps handing out fresh segment ids rather than reusing them", async () => {
    const viewer = await connect(viewUrl());
    const pub = await connect(pubUrl());
    pub.ws.send(hello());
    await streamUntil(pub.ws, viewer.seen, 2);

    const ids = utterances(viewer.seen).map((m) => m.id as number);
    // a reused id makes a viewer overwrite an earlier line instead of adding one
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("publishers coming and going", () => {
  it("closes the socket of a publisher it replaces", async () => {
    const first = await connect(pubUrl());
    first.ws.send(hello());
    await settle(200);

    const second = await connect(pubUrl());
    second.ws.send(hello());

    await until(() => first.ws.readyState === WebSocket.CLOSED, "the first publisher being dropped");
    expect(second.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("survives a run of connect and disconnect without doubling up", async () => {
    const viewer = await connect(viewUrl());

    for (let i = 0; i < 8; i += 1) {
      const pub = await connect(pubUrl());
      pub.ws.send(hello());
      await settle(40);
      pub.ws.close();
      await settle(40);
    }

    const survivor = await connect(pubUrl());
    survivor.ws.send(hello());
    const before = utterances(viewer.seen).length;
    await streamUntil(survivor.ws, viewer.seen, before + 1);
    await settle(400);

    // eight dead sessions must not each add a copy of every caption
    expect(utterances(viewer.seen).length - before).toBe(1);
  });
});

describe("the broadcast bus", () => {
  it("delivers to one listener once", async () => {
    const got: ServerToViewer[] = [];
    relay.onBroadcast((m) => got.push(m));

    const pub = await connect(pubUrl());
    pub.ws.send(hello());
    await until(() => got.some((m) => m.type === "hello"), "a broadcast");
    const helloCount = got.filter((m) => m.type === "hello").length;
    expect(helloCount).toBe(1);
  });

  it("stops delivering after the unsubscribe is called", async () => {
    const got: ServerToViewer[] = [];
    const off = relay.onBroadcast((m) => got.push(m));

    const pub = await connect(pubUrl());
    pub.ws.send(hello());
    await until(() => got.length > 0, "the first broadcast");

    off();
    const after = got.length;
    pub.ws.send(hello("de"));
    await settle(300);

    expect(got).toHaveLength(after);
  });

  it("does not accumulate listeners across subscribe and unsubscribe cycles", async () => {
    // the app rewires this bridge whenever the relay is rebuilt
    for (let i = 0; i < 10; i += 1) relay.onBroadcast(() => {})();

    const got: ServerToViewer[] = [];
    relay.onBroadcast((m) => got.push(m));

    const pub = await connect(pubUrl());
    pub.ws.send(hello());
    await until(() => got.some((m) => m.type === "hello"), "a broadcast");
    await settle(200);

    expect(got.filter((m) => m.type === "hello")).toHaveLength(1);
  });
});

describe("a peer that stops answering", () => {
  /**
   * The last piece of audit finding 11. The heartbeat is commented "drop dead
   * sockets" and drops nothing: it pings every 30 s, tracks no pongs and never
   * calls `terminate()`. A TCP connection whose peer has vanished without a FIN
   * - a laptop lid, a dropped wifi, a NAT timeout - stays `OPEN` on this side
   * indefinitely, so a half-open publisher holds the session and its viewer
   * count for minutes, and `/health` goes on reporting it.
   *
   * A client that has stopped reading its socket cannot parse a ping, so it
   * never sends the pong - which is exactly what a half-open peer looks like
   * from here.
   */
  let own: Awaited<ReturnType<typeof startRelay>>;
  let ownDir: string;

  beforeEach(async () => {
    ownDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-heartbeat-"));
    own = await startRelay({
      port: 0,
      dataDir: ownDir,
      mockStt: true,
      mockGemini: true,
      // the real one is 30 s; the shape is what is under test, not the number
      heartbeatMs: 60,
    });
  });

  afterEach(async () => {
    await own.close();
    try {
      fs.rmSync(ownDir, { recursive: true, force: true });
    } catch {
      /* disposable */
    }
  });

  const openViewer = (): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${own.port}/ws/viewer?token=${own.state.viewerToken}`);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });

  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it("keeps a viewer that is answering", async () => {
    const ws = await openViewer();
    await settle(400);

    expect(own.viewerCount(), "a healthy viewer was dropped by the heartbeat").toBe(1);
    ws.close();
  });

  it("drops one that has gone silent", async () => {
    const ws = await openViewer();
    expect(own.viewerCount()).toBe(1);

    // stop reading: the client can no longer parse a ping, so no pong goes back
    (ws as unknown as { _socket: { pause(): void } })._socket.pause();
    await settle(500);

    expect(own.viewerCount(), "a half-open socket held its place for ever").toBe(0);
  });
});

describe("what the relay tells a viewer about how long it has been live", () => {
  /**
   * Audit finding 36, from the relay's side. `since` is the streamer's
   * `Date.now()` forwarded verbatim; a viewer subtracting it from its own clock
   * showed every bit of skew between the two machines as duration error, and a
   * viewer running behind froze the timer at zero. `elapsedMs` is stamped here,
   * as the message goes out, so it does not matter whose clock produced it.
   */
  let own: Awaited<ReturnType<typeof startRelay>>;
  let ownDir: string;

  beforeEach(async () => {
    ownDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-elapsed-"));
    own = await startRelay({ port: 0, dataDir: ownDir, mockStt: true, mockGemini: true });
  });

  afterEach(async () => {
    await own.close();
    try {
      fs.rmSync(ownDir, { recursive: true, force: true });
    } catch {
      /* disposable */
    }
  });

  /** capture the connect hello, which is sent the instant the socket opens */
  const firstHello = (): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${own.port}/ws/viewer?token=${own.state.viewerToken}`);
      const timer = setTimeout(() => reject(new Error("no hello")), 4000);
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type !== "hello") return;
        clearTimeout(timer);
        ws.close();
        resolve(msg);
      });
    });

  it("sends an elapsed time a viewer can use without trusting anyone's clock", async () => {
    const pub = new WebSocket(`ws://127.0.0.1:${own.port}/ws/publisher?token=${own.state.publisherToken}`);
    await new Promise((r) => pub.once("open", r));
    // a `since` two minutes in the publisher's past, as the app sends it
    pub.send(
      JSON.stringify({
        type: "hello",
        stt: "deepgram-nova-3",
        translation: "gemini-3.1-flash-lite",
        languages: { source: "en", target: "vi" },
        translationEnabled: false,
        channels: 1,
      }),
    );
    await new Promise((r) => setTimeout(r, 120));

    const hello = await firstHello();
    expect(hello.live).toBe(true);
    expect(typeof hello.elapsedMs, "no elapsed time was sent, so the viewer must guess").toBe("number");
    expect(hello.elapsedMs as number).toBeLessThan(60_000);
    pub.close();
  });

  it("sends none when nothing is live, so a viewer does not start a clock", async () => {
    const hello = await firstHello();
    expect(hello.live).toBe(false);
    expect(hello.elapsedMs).toBeUndefined();
  });
});
