import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { startRelay } from "../src/server";
import type { RelayHandle } from "../src/server";
import { SAMPLE_RATE } from "../src/deepgram";

/**
 * Fix-round Finding 6 (controller ruling on Task 5). Task 5 wired
 * `idleBillingStopMinutes` into `PublisherSession`'s own deps and honored it
 * there, but never threaded a user's `AppConfig.idleBillingStopMinutes`
 * through `RelayOptions` / `buildSession()` here or through
 * `apps/standalone/src/main.ts`'s `startRelay({...})` call - so a value a
 * user set would silently do nothing; every session got the shared 60-minute
 * default regardless. The controller ruled: plumb it, don't delete the field,
 * since even a user hand-editing config.json on a build with no successor
 * could otherwise never change the number.
 *
 * This proves the `RelayOptions` half end to end, over a real relay and a
 * real publisher socket - not the session unit alone, which Task 5 already
 * covers. `apps/standalone/src/main.ts`'s half (threading
 * `cfg.idleBillingStopMinutes` into its own `startRelay({...})` call) has no
 * test harness in this repo: main.ts is Electron main-process code with no
 * existing test file (grepped - only models.test.ts and renderer.test.ts
 * exist under apps/standalone/test/, neither imports main.ts), so that half
 * is verified by reading the call site instead.
 */

let relay: RelayHandle;
let dir: string;
let logs: { level: string; message: string }[];
const sockets: WebSocket[] = [];

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, ms = 1500): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`${what} never happened within ${ms}ms`);
    await settle(10);
  }
}

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

/** silence, one real capture-sized 100ms frame */
const silentFrame = (): Buffer => Buffer.alloc(SAMPLE_RATE * 2 * 0.1, 0);

describe("RelayOptions.idleBillingStopMinutes reaches the session", () => {
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-idle-wiring-"));
    logs = [];
    relay = await startRelay({
      port: 0,
      dataDir: dir,
      mockStt: true,
      mockGemini: true,
      // an order of magnitude below the shared default (60 min) so the
      // gate trips inside a test, in real time, in well under a second -
      // if this value is actually honored
      idleBillingStopMinutes: 0.0015, // 90ms
      log: (level, message) => logs.push({ level, message }),
    });
  });

  it("uses the configured bound, not the 60-minute shared default", async () => {
    const ws = await connect(`ws://127.0.0.1:${relay.port}/ws/publisher?token=${relay.state.publisherToken}`);
    ws.send(JSON.stringify({ type: "hello", languages: { source: "en", target: "vi" } }));
    await settle(20);

    // capture keeps posting a frame whether or not there is anything in it
    for (let i = 0; i < 20; i++) {
      ws.send(silentFrame(), { binary: true });
      await settle(15);
    }

    await until(
      () => logs.some((l) => l.level === "error" && /pausing billed transcription/.test(l.message)),
      "the 90ms bound configured via RelayOptions never tripped - idleBillingStopMinutes is not reaching the session",
    );
  });
});
