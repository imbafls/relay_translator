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
 * exist under apps/standalone/test/, neither imports main.ts).
 *
 * Fix-round-3 Finding 3: this comment used to end "so that half is verified
 * by reading the call site instead" - but nothing below actually did that
 * reading. Deleting `idleBillingStopMinutes: cfg.idleBillingStopMinutes`
 * from main.ts's `startRelay({...})` call silently reinstates "a user's
 * setting does nothing" - exactly the bug this file exists to guard against
 * - and every test in this repo, this one included, still passed. The repo
 * already reads main.ts as source text elsewhere (`speakerTag.test.ts`,
 * `prepareOrder.test.ts`); the describe block below is that same reading,
 * actually encoded as a check this time.
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

/**
 * Fix-round-3 Finding 4. The spec requires the idle-billing pause be
 * surfaced in the app, not only written to relay.log. session.test.ts pins
 * the hook firing at the PublisherSession level; this proves the OTHER end
 * of the wire is actually connected - a real relay's RelayHandle.billingPaused()
 * over a real publisher socket, the same end-to-end shape as the
 * RelayOptions describe block above.
 */
describe("RelayHandle.billingPaused() reflects the idle-billing gate", () => {
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-billing-paused-"));
    logs = [];
    relay = await startRelay({
      port: 0,
      dataDir: dir,
      mockStt: true,
      mockGemini: true,
      idleBillingStopMinutes: 0.0015, // 90ms, same as the wiring test above
      log: (level, message) => logs.push({ level, message }),
    });
  });

  const loudFrame = (): Buffer => {
    const b = Buffer.alloc(SAMPLE_RATE * 2 * 0.1);
    for (let i = 0; i < b.length; i += 2) b.writeInt16LE(20000, i);
    return b;
  };

  it("flips true when the bound trips and false when audio resumes", async () => {
    expect(relay.billingPaused(), "paused before any session even connected").toBe(false);

    const ws = await connect(`ws://127.0.0.1:${relay.port}/ws/publisher?token=${relay.state.publisherToken}`);
    ws.send(JSON.stringify({ type: "hello", languages: { source: "en", target: "vi" } }));
    await settle(20);

    for (let i = 0; i < 20; i++) {
      ws.send(silentFrame(), { binary: true });
      await settle(15);
    }
    await until(
      () => relay.billingPaused(),
      "RelayHandle.billingPaused() never went true - the session's onBillingPaused hook is not reaching the relay handle",
    );

    ws.send(loudFrame(), { binary: true });
    await until(
      () => !relay.billingPaused(),
      "RelayHandle.billingPaused() stayed true after audio resumed",
    );
  });
});

/**
 * Fix-round-3 Finding 3. The other half - main.ts actually threading
 * `cfg.idleBillingStopMinutes` into its own `startRelay({...})` call -  had
 * no guard of any kind, only a comment claiming it was "verified by reading
 * the call site". Read it for real: extract the call's argument literal and
 * assert it names the field. A rename of `startEmbeddedRelay` or its
 * `startRelay({...})` call breaks this loudly, which is the right failure -
 * same reasoning as `prepareOrder.test.ts`'s own narrow source read.
 */
describe("apps/standalone/src/main.ts actually threads idleBillingStopMinutes into startRelay", () => {
  const root = path.resolve(__dirname, "..", "..", "..");
  const main = fs.readFileSync(path.join(root, "apps/standalone/src/main.ts"), "utf8");

  /** the argument object of startEmbeddedRelay's `relay = await startRelay({...})` call */
  function startRelayCallLiteral(): string {
    const marker = "relay = await startRelay(";
    const at = main.indexOf(marker);
    if (at < 0) {
      throw new Error("startEmbeddedRelay's startRelay(...) call is gone - this guard needs re-pointing");
    }
    const open = main.indexOf("{", at);
    if (open < 0) throw new Error("startRelay(...) call has no object literal argument to read");
    let depth = 0;
    for (let i = open; i < main.length; i += 1) {
      if (main[i] === "{") depth += 1;
      else if (main[i] === "}") {
        depth -= 1;
        if (depth === 0) return main.slice(open, i + 1);
      }
    }
    throw new Error("unbalanced braces reading the startRelay(...) call");
  }

  it("still finds the call this guard reads", () => {
    // guards the guard: if this stops matching, the assertion below would be
    // reading an empty/wrong literal and passing for the wrong reason
    expect(startRelayCallLiteral()).toContain("port: cfg.relayPort");
  });

  it("names idleBillingStopMinutes, not just the session's own 60-minute default", () => {
    expect(
      startRelayCallLiteral(),
      "main.ts's startRelay({...}) call no longer threads cfg.idleBillingStopMinutes - deleting it silently reinstates 'a user's setting does nothing'",
    ).toMatch(/\bidleBillingStopMinutes\s*:\s*cfg\.idleBillingStopMinutes\b/);
  });
});
