import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import type { ServerToViewer } from "@callout-relay/shared";
import { startRelay } from "../src/server";
import type { RelayHandle, TranscriptLine } from "../src/server";
import { createMockSttStream } from "../src/deepgram";

/**
 * The desktop app saves a copy of every finished line to disk. The obvious
 * place to take that copy from is `onBroadcast` - main already consumes it for
 * the uplink - and it is the wrong place.
 *
 * `onBroadcast` fires inside `toViewers`, and `toViewers` is handed
 * `forViewers(text)`: the line after HIDE SWEARING has masked it, with latency
 * stripped whenever the badge is turned off. That is correct for viewers and
 * wrong for the streamer's own archive. The raw line only ever went down
 * `toPublisher`, straight onto the publisher socket, where nothing in main
 * could see it.
 *
 * `onTranscript` is that path, made subscribable. Every test here drives a real
 * relay over real sockets; only the STT stands in, through `makeStt`, and it is
 * told to swear - with the default clean callouts, the masking half of this
 * file would pass against a tap that was never wired to the right path.
 */

const SAID = "what the fuck was that shit";
const MASKED = "what the f*** was that s***";

let relay: RelayHandle;
let dir: string;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-tap-"));
  relay = await startRelay({
    port: 0,
    dataDir: dir,
    mockGemini: true,
    makeStt: (events) => createMockSttStream(events, 1, [SAID]),
  });
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

const hello = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: "hello",
    stt: "deepgram-nova-3",
    translation: "gemini-3.1-flash-lite",
    languages: { source: "en", target: "vi" },
    translationEnabled: true,
    channels: 1,
    ...over,
  });

/** 2 s of 16 kHz mono: the mock STT emits one final per 2 s */
const utterance = (): Buffer => Buffer.alloc(16000 * 2 * 2, 1);

async function publisher(over: Record<string, unknown> = {}): Promise<WebSocket> {
  const pub = await connect(`ws://127.0.0.1:${relay.port}/ws/publisher?token=${relay.state.publisherToken}`);
  pub.ws.send(hello(over));
  return pub.ws;
}

async function speakUntil(ws: WebSocket, cond: () => boolean, what: string): Promise<void> {
  const timer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(utterance());
  }, 60);
  try {
    await until(cond, what);
  } finally {
    clearInterval(timer);
  }
}

type ViewerSubtitle = Extract<ServerToViewer, { type: "subtitle" }>;
const viewerSubs = (msgs: ServerToViewer[]): ViewerSubtitle[] =>
  msgs.filter((m): m is ViewerSubtitle => m.type === "subtitle");

describe("onTranscript", () => {
  it("carries the line as heard, while viewers are sent it masked", async () => {
    const lines: TranscriptLine[] = [];
    const broadcast: ServerToViewer[] = [];
    relay.onTranscript((m) => lines.push(m));
    relay.onBroadcast((m) => broadcast.push(m));

    const pub = await publisher(); // profanityFilter defaults ON
    await speakUntil(pub, () => lines.length > 0 && viewerSubs(broadcast).length > 0, "a saved line and a viewer caption");

    for (const l of lines) expect(l.source).toBe(SAID);
    // the contrast is the reason the tap exists: the obvious tee records this
    for (const s of viewerSubs(broadcast)) expect(s.source).toBe(MASKED);
  });

  it("carries only finished lines, never an interim partial", async () => {
    const lines: TranscriptLine[] = [];
    relay.onTranscript((m) => lines.push(m));

    const pub = await publisher();
    await speakUntil(pub, () => lines.length >= 2, "two saved lines");

    for (const l of lines) expect(l.type).toBe("subtitle");
  });

  it("keeps the latency when the viewer badge is hidden", async () => {
    const lines: TranscriptLine[] = [];
    const broadcast: ServerToViewer[] = [];
    relay.onTranscript((m) => lines.push(m));
    relay.onBroadcast((m) => broadcast.push(m));

    const pub = await publisher({ latencyVisible: false, translationEnabled: false });
    await speakUntil(pub, () => lines.length > 0 && viewerSubs(broadcast).length > 0, "a saved line and a viewer caption");

    // viewers asked not to see it, and do not
    for (const s of viewerSubs(broadcast)) expect(s.latency).toBeUndefined();
    // the archive was never asked
    expect(typeof lines[0].latency?.stt).toBe("number");
  });

  /**
   * The double emit the writer has to merge. With translation on, one
   * utterance reaches the tap twice under ONE id - first the line, then the
   * same line again carrying `target`. A writer that treats each emit as a new
   * line records every utterance twice; this pins the shape it must handle.
   */
  it("emits a line then its translation under the same id", async () => {
    const lines: TranscriptLine[] = [];
    relay.onTranscript((m) => lines.push(m));

    const pub = await publisher({ translationEnabled: true });
    await speakUntil(
      pub,
      () => lines.some((l) => l.target !== undefined),
      "a translated line",
    );
    const id = lines.find((l) => l.target !== undefined)!.id;
    await settle(150);

    const forId = lines.filter((l) => l.id === id);
    expect(forId).toHaveLength(2);
    expect(forId[0].target).toBeUndefined();
    expect(typeof forId[1].target).toBe("string");
    expect(forId[1].source).toBe(SAID);
  });

  it("does not let a listener that throws stop captions reaching viewers", async () => {
    relay.onTranscript(() => {
      throw new Error("disk full");
    });
    const viewer = await connect(`ws://127.0.0.1:${relay.port}/ws/viewer?token=${relay.state.viewerToken}`);

    const pub = await publisher();
    await speakUntil(
      pub,
      () => viewer.seen.some((m) => m.type === "subtitle"),
      "a caption on the viewer socket",
    );
  });

  it("stops delivering once unsubscribed", async () => {
    const lines: TranscriptLine[] = [];
    const off = relay.onTranscript((m) => lines.push(m));
    off();
    const broadcast: ServerToViewer[] = [];
    relay.onBroadcast((m) => broadcast.push(m));

    const pub = await publisher();
    await speakUntil(pub, () => viewerSubs(broadcast).length >= 2, "two viewer captions");

    expect(lines).toHaveLength(0);
  });
});
