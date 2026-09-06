import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { startRelay } from "../src/server";
import type { RelayHandle } from "../src/server";
import { SAMPLE_RATE } from "../src/deepgram";

/**
 * A real user's log showed this on EVERY session start, four times in one
 * evening:
 *
 *   relay: connected
 *   relay error: WebSocket was closed before the connection was established
 *
 * The relay was building a throwaway PublisherSession the instant a publisher
 * socket was accepted, on DEFAULT_CONFIG, purely to read a constant sample
 * rate for the `ready` frame. On a machine with a Deepgram key that session
 * dialled Deepgram for real. The publisher's hello arrived about a millisecond
 * later, replaced the session, and closed the still-connecting socket
 * mid-handshake - which `ws` reports as an error, forwarded to the app.
 *
 * The race is one-sided: a loopback hello beats a WAN TLS handshake every
 * time, so it fired on every start and burned a Deepgram connection each time.
 *
 * This asserts the shape that made it possible: no session before the hello.
 * A session existing that early is the bug, whether or not a key happens to be
 * configured on the machine running the test.
 */

let relay: RelayHandle;
let dir: string;
let logs: string[];
const sockets: WebSocket[] = [];

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function connect(url: string): Promise<{ ws: WebSocket; seen: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const seen: Record<string, unknown>[] = [];
    ws.on("message", (d: Buffer) => {
      try {
        seen.push(JSON.parse(d.toString()));
      } catch {
        /* binary */
      }
    });
    ws.once("open", () => resolve({ ws, seen }));
    ws.once("error", reject);
  });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ready-"));
  logs = [];
  relay = await startRelay({
    port: 0,
    dataDir: dir,
    mockStt: true,
    mockGemini: true,
    log: (_level: string, message: string) => logs.push(message),
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

const pubUrl = (): string => `ws://127.0.0.1:${relay.port}/ws/publisher?token=${relay.state.publisherToken}`;

describe("a publisher that has not said hello yet", () => {
  it("is greeted with ready and the real sample rate", async () => {
    const { seen } = await connect(pubUrl());
    await settle(80);

    const ready = seen.find((m) => m.type === "ready");
    expect(ready, "the publisher is greeted the instant it is accepted").toBeDefined();
    expect(ready?.sampleRate).toBe(SAMPLE_RATE);
  });

  it("has no session consuming its audio - that is what dialled Deepgram too early", async () => {
    const { ws, seen } = await connect(pubUrl());
    await settle(50);

    // 4 s of audio, twice what the mock STT needs to emit a caption. A session
    // existing this early would transcribe it on DEFAULT_CONFIG; there should
    // be nothing to transcribe with, because the hello has not arrived.
    ws.send(Buffer.alloc(16000 * 2 * 2 * 2, 1));
    await settle(250);

    const captions = seen.filter((m) => m.type === "subtitle" || m.type === "partial");
    expect(captions, `audio before the hello was transcribed: ${JSON.stringify(captions)}`).toEqual([]);
    expect(logs.filter((l) => l.startsWith("stt open"))).toEqual([]);
  });

  it("gets no error frame while it sits there", async () => {
    const { seen } = await connect(pubUrl());
    await settle(150);

    expect(seen.filter((m) => m.type === "error")).toEqual([]);
  });

  it("builds exactly one session once the hello lands", async () => {
    const { ws, seen } = await connect(pubUrl());
    await settle(50);
    expect(logs.filter((l) => l.startsWith("publisher session:"))).toEqual([]);

    ws.send(
      JSON.stringify({
        type: "hello",
        stt: "deepgram-nova-3",
        translation: "gemini-3.1-flash-lite",
        languages: { source: "en", target: "vi" },
      }),
    );
    await settle(150);

    expect(logs.filter((l) => l.startsWith("publisher session:"))).toHaveLength(1);
    expect(seen.filter((m) => m.type === "error")).toEqual([]);
  });
});
