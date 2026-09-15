import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { startRelay } from "../src/server";
import type { RelayHandle } from "../src/server";

/**
 * Viewers key their caption rows by segment id, and nothing tells them to start
 * again. A session that restarts its numbering therefore hands out ids the
 * viewer is already showing, and the next caption rewrites an existing row in
 * place rather than adding one.
 *
 * A settings change mid-stream is enough to rebuild the session, and it does
 * not kick anyone - so the rows survive while the counter does not.
 */

let relay: RelayHandle;
let dir: string;
const sockets: WebSocket[] = [];

function connect(url: string): Promise<{ ws: WebSocket; seen: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const seen: Record<string, unknown>[] = [];
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

async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`${what} never happened within ${ms}ms`);
    await settle(25);
  }
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-segids-"));
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

const hello = (target: string) =>
  JSON.stringify({
    type: "hello",
    stt: "deepgram-nova-3",
    translation: "gemini-3.1-flash-lite",
    languages: { source: "en", target },
    translationEnabled: true,
    channels: 1,
  });

/** 2 s of 16 kHz mono: the mock STT emits one final per 2 s */
const utterance = (): Buffer => Buffer.alloc(16000 * 2 * 2, 1);

/** one entry per utterance - the source emission, before its translation patch */
const captions = (seen: Record<string, unknown>[]): Record<string, unknown>[] =>
  seen.filter((m) => m.type === "subtitle" && m.final === true && m.target === undefined);

async function speakUntil(ws: WebSocket, seen: Record<string, unknown>[], want: number): Promise<void> {
  const timer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(utterance());
  }, 60);
  try {
    await until(() => captions(seen).length >= want, `${want} captions`);
  } finally {
    clearInterval(timer);
  }
}

describe("segment ids across a session rebuild", () => {
  it("keeps numbering where the last session stopped", async () => {
    const viewer = await connect(`ws://127.0.0.1:${relay.port}/ws/viewer?token=${relay.state.viewerToken}`);
    const pub = await connect(`ws://127.0.0.1:${relay.port}/ws/publisher?token=${relay.state.publisherToken}`);

    pub.ws.send(hello("vi"));
    await speakUntil(pub.ws, viewer.seen, 2);
    const before = captions(viewer.seen).map((m) => m.id as number);

    // a settings change: same socket, new session, viewers not kicked
    pub.ws.send(hello("ja"));
    await settle(250);
    await speakUntil(pub.ws, viewer.seen, before.length + 1);

    const after = captions(viewer.seen).map((m) => m.id as number);
    const fresh = after.slice(before.length);
    expect(fresh.length).toBeGreaterThan(0);
    // an id the viewer already has on screen rewrites that row in place
    for (const id of fresh) {
      expect(before, `id ${id} was reused after the rebuild`).not.toContain(id);
    }
  });

  it("never repeats an id across the whole stream", async () => {
    const viewer = await connect(`ws://127.0.0.1:${relay.port}/ws/viewer?token=${relay.state.viewerToken}`);
    const pub = await connect(`ws://127.0.0.1:${relay.port}/ws/publisher?token=${relay.state.publisherToken}`);

    pub.ws.send(hello("vi"));
    await speakUntil(pub.ws, viewer.seen, 2);
    pub.ws.send(hello("ja"));
    await settle(250);
    await speakUntil(pub.ws, viewer.seen, 3);
    pub.ws.send(hello("ko"));
    await settle(250);
    await speakUntil(pub.ws, viewer.seen, 4);

    const ids = captions(viewer.seen).map((m) => m.id as number);
    expect(new Set(ids).size, `ids repeated: ${ids.join(", ")}`).toBe(ids.length);
  });

  it("still starts from the beginning for a genuinely new publisher", async () => {
    // a fresh relay has nothing on any viewer's screen to collide with
    const pub = await connect(`ws://127.0.0.1:${relay.port}/ws/publisher?token=${relay.state.publisherToken}`);
    const viewer = await connect(`ws://127.0.0.1:${relay.port}/ws/viewer?token=${relay.state.viewerToken}`);
    pub.ws.send(hello("vi"));
    await speakUntil(pub.ws, viewer.seen, 1);
    expect(captions(viewer.seen)[0].id).toBe(1);
  });
});

/**
 * The other half of the same problem, and the half carrying the counter cannot
 * reach: a relay that has itself restarted has no counter to carry. `publisher`
 * is gone, `carryOver` is zero, and the ids begin again at 1 while a viewer is
 * still holding rows 1..N from the stream before.
 *
 * So viewers are told which numbering domain the ids belong to. The field is
 * minted beside the carry-over itself rather than from any clock, because that
 * is the only place that knows the answer: `since` is cleared and re-minted on
 * every STT reconnect inside a live session, where the numbering never paused.
 */
describe("the numbering domain a viewer is told about", () => {
  const hellos = (seen: Record<string, unknown>[]): Record<string, unknown>[] =>
    seen.filter((m) => m.type === "hello");
  const latestEpoch = (seen: Record<string, unknown>[]): unknown => hellos(seen).pop()?.epoch;

  it("holds steady across a rebuild that carries the ids over", async () => {
    const viewer = await connect(`ws://127.0.0.1:${relay.port}/ws/viewer?token=${relay.state.viewerToken}`);
    const pub = await connect(`ws://127.0.0.1:${relay.port}/ws/publisher?token=${relay.state.publisherToken}`);

    pub.ws.send(hello("vi"));
    await speakUntil(pub.ws, viewer.seen, 2);
    const first = latestEpoch(viewer.seen);
    expect(typeof first, "no numbering domain reached the viewer at all").toBe("number");

    // a settings change: same socket, new session, ids carry over, and the rows
    // a viewer is holding must therefore survive
    pub.ws.send(hello("ja"));
    await settle(250);
    await speakUntil(pub.ws, viewer.seen, 3);

    expect(
      latestEpoch(viewer.seen),
      "a rebuild that kept the numbering told viewers it had restarted, which wipes their transcript",
    ).toBe(first);
  });

  it("changes for a publisher whose numbering starts again", async () => {
    const viewer = await connect(`ws://127.0.0.1:${relay.port}/ws/viewer?token=${relay.state.viewerToken}`);
    const first = await connect(`ws://127.0.0.1:${relay.port}/ws/publisher?token=${relay.state.publisherToken}`);

    first.ws.send(hello("vi"));
    await speakUntil(first.ws, viewer.seen, 1);
    const before = latestEpoch(viewer.seen);
    expect(typeof before, "no numbering domain reached the viewer at all").toBe("number");

    // the app closes and comes back: nothing is left to carry over, so the next
    // caption is id 1 again while the viewer still has the old id 1 on screen
    first.ws.close();
    await settle(200);
    const second = await connect(`ws://127.0.0.1:${relay.port}/ws/publisher?token=${relay.state.publisherToken}`);
    second.ws.send(hello("vi"));
    await speakUntil(second.ws, viewer.seen, 2);

    expect(captions(viewer.seen).map((m) => m.id as number), "the ids did not in fact restart, so this proves nothing").toContain(1);
    expect(
      latestEpoch(viewer.seen),
      "the ids started again and viewers were told nothing had changed",
    ).not.toBe(before);
  });

  it("greets a viewer who joins later with the domain already running", async () => {
    const pub = await connect(`ws://127.0.0.1:${relay.port}/ws/publisher?token=${relay.state.publisherToken}`);
    pub.ws.send(hello("vi"));
    await settle(250);

    // this hello is hand-built rather than passed through stamp(), so it is its
    // own way of getting the field wrong
    const late = await connect(`ws://127.0.0.1:${relay.port}/ws/viewer?token=${relay.state.viewerToken}`);
    await until(() => hellos(late.seen).length > 0, "the greeting hello");

    expect(typeof latestEpoch(late.seen), "a viewer joining mid-stream was told no domain").toBe("number");
  });
});
