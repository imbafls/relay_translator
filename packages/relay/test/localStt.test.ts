import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LOCAL_VAD, sttModel } from "@callout-relay/shared";
import { createLocalSttStream, localModelReady, localVadReady } from "../src/localStt";

/**
 * These tests drive the REAL createLocalSttStream state machine: its probe
 * child process, its worker thread, its pending-audio queue and its close
 * handshake all run for real. Only the sherpa-onnx engine itself is stood in
 * for, by a worker script that speaks the same message contract -- the native
 * engine is an optional dependency and needs multi-hundred-MB model files that
 * are not in the repo.
 */

/** 100 ms of 16 kHz mono 16-bit PCM, the frame size the capture worklet emits */
const FRAME_BYTES = 16000 * 0.1 * 2;
const frame = (): Buffer => Buffer.alloc(FRAME_BYTES, 1);

const tmpDirs: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-stt-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows can hold a handle briefly; the temp dir is disposable */
    }
  }
});

/** write every file the catalogue says this model needs, so localModelReady passes */
function stageModel(modelsDir: string, id: string, opts: { vad?: boolean } = {}): void {
  const info = sttModel(id);
  if (!info?.files) throw new Error(`no catalogue entry with files for ${id}`);
  const dir = path.join(modelsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of info.files) fs.writeFileSync(path.join(dir, f.name), "stub");
  if (opts.vad) stageVad(modelsDir);
}

function stageVad(modelsDir: string): void {
  const dir = path.join(modelsDir, LOCAL_VAD.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of LOCAL_VAD.files!) fs.writeFileSync(path.join(dir, f.name), "stub");
}

/**
 * A stand-in for localSttWorker.js. Runs in two modes, exactly as the real one
 * does: `--probe` as a spawned child that exits with a code, and otherwise as
 * a worker thread that answers init with ready and counts the audio it gets.
 */
function writeWorker(dir: string, opts: { probeExit: number; probeDelayMs?: number }): string {
  const file = path.join(dir, "fakeWorker.js");
  fs.writeFileSync(
    file,
    `
if (process.argv[2] === "--probe") {
  JSON.parse(process.argv[3]); // the real worker parses its init here too
  setTimeout(() => process.exit(${opts.probeExit}), ${opts.probeDelayMs ?? 0});
} else {
  const { parentPort } = require("worker_threads");
  let frames = 0;
  parentPort.on("message", (msg) => {
    if (msg.type === "init") parentPort.postMessage({ type: "ready" });
    else if (msg.type === "audio") frames += 1;
    else if (msg.type === "close") {
      parentPort.postMessage({ type: "final", text: String(frames), audioEndSec: 0, channel: 0 });
      process.exit(0);
    }
  });
}
`,
  );
  return file;
}

describe("localModelReady", () => {
  it("is false for an id that is not in the catalogue", () => {
    const models = tmp();
    expect(localModelReady(models, "local-whisper-small")).toBe(false);
    expect(localModelReady(models, "deepgram-nova-3")).toBe(false);
  });

  it("does not require the VAD for a streaming model", () => {
    const models = tmp();
    stageModel(models, "local-zipformer-en-20m");
    expect(localVadReady(models)).toBe(false);
    expect(localModelReady(models, "local-zipformer-en-20m")).toBe(true);
  });

  it("requires the VAD for an offline model", () => {
    const models = tmp();
    stageModel(models, "local-sense-voice");
    expect(localModelReady(models, "local-sense-voice")).toBe(false);
    stageVad(models);
    expect(localModelReady(models, "local-sense-voice")).toBe(true);
  });
});

describe("createLocalSttStream probe", () => {
  it("reports a model that aborts the probe instead of taking the process down", async () => {
    const models = tmp();
    stageModel(models, "local-sense-voice", { vad: true });
    const workerPath = writeWorker(models, { probeExit: 127 });

    const errors: string[] = [];
    let opened = false;
    const closed = new Promise<void>((resolve) => {
      const stream = createLocalSttStream(
        { modelsDir: models, workerPath },
        { model: "local-sense-voice", language: "en", channels: 1 },
        {
          onOpen: () => {
            opened = true;
          },
          onError: (m) => errors.push(m),
          onClose: () => resolve(),
        },
      );
      // audio during the probe must not throw
      stream.sendAudio(frame());
    });

    await closed;
    expect(opened).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/could not be loaded on this PC/);
    expect(errors[0]).toContain("127");
  });
});

describe("audio buffered while the model is being prepared", () => {
  it("keeps every frame spoken during the probe and the model load", async () => {
    const models = tmp();
    stageModel(models, "local-zipformer-en-20m");
    // long enough to queue well past the 300-frame cap before the worker is up
    const workerPath = writeWorker(models, { probeExit: 0, probeDelayMs: 300 });

    // 40 s of speech. The probe and the model load are two sequential loads of
    // the same model, so this window is realistic for a heavy model on a busy PC.
    const SPOKEN = 400;
    const errors: string[] = [];
    let delivered: number | null = null;

    let resolveClose!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });

    let stream: ReturnType<typeof createLocalSttStream> | null = null;
    stream = createLocalSttStream(
      { modelsDir: models, workerPath },
      { model: "local-zipformer-en-20m", language: "en", channels: 1 },
      {
        onOpen: () => {
          // the queue is flushed before onOpen returns; close to read the count
          setTimeout(() => stream?.close(), 50);
        },
        onFinal: (text) => {
          delivered = Number(text);
        },
        onError: (m) => errors.push(m),
        onClose: () => resolveClose(),
      },
    );

    for (let i = 0; i < SPOKEN; i += 1) stream.sendAudio(frame());

    await closed;
    expect(errors).toEqual([]);
    expect(delivered).toBe(SPOKEN);
  });

  it("says so out loud when the wait is long enough to overflow the buffer", async () => {
    const models = tmp();
    stageModel(models, "local-moonshine-tiny", { vad: true });
    const workerPath = writeWorker(models, { probeExit: 0, probeDelayMs: 300 });

    // the budget is the probe timeout's worth of audio; go one second past it
    const BUDGET_FRAMES = (180 * 16000 * 2) / FRAME_BYTES;
    const SPOKEN = BUDGET_FRAMES + 10;
    const errors: string[] = [];
    let delivered: number | null = null;

    let resolveClose!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });

    let stream: ReturnType<typeof createLocalSttStream> | null = null;
    stream = createLocalSttStream(
      { modelsDir: models, workerPath },
      { model: "local-moonshine-tiny", language: "en", channels: 1 },
      {
        onOpen: () => {
          setTimeout(() => stream?.close(), 50);
        },
        onFinal: (text) => {
          delivered = Number(text);
        },
        onError: (m) => errors.push(m),
        onClose: () => resolveClose(),
      },
    );

    for (let i = 0; i < SPOKEN; i += 1) stream.sendAudio(frame());

    await closed;
    // everything that fitted still got through
    expect(delivered).toBe(BUDGET_FRAMES);
    // and the loss was reported rather than swallowed
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/1s of speech was dropped/);
  });
});
