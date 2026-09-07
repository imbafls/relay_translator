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

/**
 * Written at its real size, not as a 4-byte stub. The VAD is a fixed released
 * artifact and the catalogue carries its exact size; a truncated or holed one
 * is the shape audit finding 25 produced, and readiness has to reject it.
 */
function stageVad(modelsDir: string, opts: { truncated?: boolean } = {}): void {
  const dir = path.join(modelsDir, LOCAL_VAD.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of LOCAL_VAD.files!) {
    fs.writeFileSync(path.join(dir, f.name), Buffer.alloc(opts.truncated ? f.size - 1024 : f.size, 7));
  }
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

  /**
   * Audit finding 25's lasting damage. Two models downloading at once opened
   * two truncating streams on the same `silero_vad.onnx.part`, and the loser's
   * descriptor followed the inode through the winner's rename - writing into
   * the PUBLISHED file. Readiness checked existence only, so a holed VAD was
   * accepted for ever, and `remove()` deliberately never deletes it because it
   * is shared. The only way out was to find the file by hand.
   *
   * The collision is fixed at the source now; this is the second lock, so a
   * VAD damaged any other way is re-fetched rather than trusted.
   */
  it("rejects a VAD that is not the size it should be", () => {
    const models = tmp();
    stageModel(models, "local-sense-voice");
    stageVad(models, { truncated: true });

    expect(localVadReady(models), "a truncated VAD was accepted as ready").toBe(false);
    expect(localModelReady(models, "local-sense-voice")).toBe(false);
  });

  it("still accepts one that is exactly right", () => {
    const models = tmp();
    stageVad(models);
    expect(localVadReady(models)).toBe(true);
  });
});

describe("the probe's argv survives a real user's paths", () => {
  /** a models dir under a folder shaped like an actual Windows profile name */
  function awkwardDir(name: string): string {
    const base = tmp();
    const dir = path.join(base, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it.each([
    ["a space in the path", "Ömer Test"],
    ["non-ASCII characters", "Ünïcodé"],
    ["a quote-adjacent name", "it's mine"],
    ["a trailing backslash-ish name", "models dir "],
  ])("loads a model with %s", async (_name, folder) => {
    // the init json goes through argv to a child process; if it does not
    // survive the trip the probe exits non-zero and the model is reported
    // broken on a PC where it would have worked
    const models = awkwardDir(folder);
    stageModel(models, "local-zipformer-en-20m");
    const workerPath = writeWorker(models, { probeExit: 0 });

    const errors: string[] = [];
    let opened = false;
    let resolveClose!: () => void;
    const closed = new Promise<void>((r) => {
      resolveClose = r;
    });

    let stream: ReturnType<typeof createLocalSttStream> | null = null;
    stream = createLocalSttStream(
      { modelsDir: models, workerPath },
      { model: "local-zipformer-en-20m", language: "en", channels: 1 },
      {
        onOpen: () => {
          opened = true;
          setTimeout(() => stream?.close(), 20);
        },
        onError: (m) => errors.push(m),
        onClose: () => resolveClose(),
      },
    );

    await closed;
    expect(errors).toEqual([]);
    expect(opened).toBe(true);
  });

  it("hands the child an init it can parse back", async () => {
    const models = awkwardDir("Ömer's Models");
    stageModel(models, "local-zipformer-en-20m");
    // this worker fails the probe unless the init parses and carries the
    // modelDir it was given, so a mangled argv shows up as a failure
    const workerPath = path.join(models, "checkingWorker.js");
    fs.writeFileSync(
      workerPath,
      `
if (process.argv[2] === "--probe") {
  let init;
  try { init = JSON.parse(process.argv[3]); } catch { process.exit(41); }
  if (typeof init.modelDir !== "string" || !init.modelDir.length) process.exit(42);
  if (init.engine !== "zipformer-online") process.exit(43);
  process.exit(0);
} else {
  const { parentPort } = require("worker_threads");
  parentPort.on("message", (m) => {
    if (m.type === "init") parentPort.postMessage({ type: "ready" });
    else if (m.type === "close") process.exit(0);
  });
}
`,
    );

    const errors: string[] = [];
    let resolveClose!: () => void;
    const closed = new Promise<void>((r) => {
      resolveClose = r;
    });
    let stream: ReturnType<typeof createLocalSttStream> | null = null;
    stream = createLocalSttStream(
      { modelsDir: models, workerPath },
      { model: "local-zipformer-en-20m", language: "en", channels: 1 },
      {
        onOpen: () => setTimeout(() => stream?.close(), 20),
        onError: (m) => errors.push(m),
        onClose: () => resolveClose(),
      },
    );

    await closed;
    expect(errors).toEqual([]);
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

/**
 * Audit finding 34.
 *
 * The probe is a whole second load of the model in a child process - the thing
 * the per-process `verified` cache exists to stop paying twice. But the
 * `.then()` that records the result opened with `if (done) return;`, above
 * `verified.add(cfg.model)`. So a probe that PASSED after the user pressed STOP
 * was thrown away: the model had been proved loadable on this PC, the answer
 * was in hand, and the next start paid the whole probe again. Pressing START
 * and changing your mind is not an unusual thing to do, and a heavy model on a
 * busy machine makes that probe long enough to be the reason you changed it.
 *
 * The bookkeeping has no reason to depend on the session surviving.
 *
 * Counted from outside: the stand-in worker appends a line per probe run, so
 * the assertion is on how many child processes were actually spawned rather
 * than on the private Set.
 */
function writeCountingProbe(dir: string, tally: string, delayMs: number): string {
  const file = path.join(dir, "countingWorker.js");
  fs.writeFileSync(
    file,
    `
if (process.argv[2] === "--probe") {
  require("fs").appendFileSync(${JSON.stringify(tally)}, "x");
  setTimeout(() => process.exit(0), ${delayMs});
} else {
  const { parentPort } = require("worker_threads");
  parentPort.on("message", (msg) => {
    if (msg.type === "init") parentPort.postMessage({ type: "ready" });
    else if (msg.type === "close") process.exit(0);
  });
}
`,
  );
  return file;
}

describe("a probe that comes back after the session stopped", () => {
  const MODEL = "local-nemotron-streaming";

  it("is still worth remembering, so the next start does not pay for it again", async () => {
    const models = tmp();
    stageModel(models, MODEL, { vad: true });
    const tally = path.join(models, "probes.txt");
    const workerPath = writeCountingProbe(models, tally, 250);

    /** one byte per probe child, counted from outside the process */
    const probes = (): number => (fs.existsSync(tally) ? fs.readFileSync(tally, "utf8").length : 0);

    // START, then change your mind while the probe is still running
    const first = createLocalSttStream(
      { modelsDir: models, workerPath },
      { model: MODEL, language: "en", channels: 1 },
      { onError: () => {}, onClose: () => {} },
    );
    first.close();

    // let the probe finish on its own, after the session it belonged to is gone
    await new Promise((r) => setTimeout(r, 600));
    expect(probes(), "the probe never ran, so this test proves nothing").toBe(1);

    // START again: the model was proved loadable a moment ago
    let opened!: () => void;
    const isOpen = new Promise<void>((r) => {
      opened = r;
    });
    const second = createLocalSttStream(
      { modelsDir: models, workerPath },
      { model: MODEL, language: "en", channels: 1 },
      { onOpen: () => opened(), onError: () => {}, onClose: () => {} },
    );
    await isOpen;
    second.close();

    expect(probes(), "the second start paid for a probe that had already passed").toBe(1);
  });

  it("is not remembered when it failed, however the session ended", async () => {
    const models = tmp();
    stageModel(models, "local-whisper-turbo", { vad: true });
    const tally = path.join(models, "probes.txt");
    // a worker that fails its probe - exit 127, the shape of a missing engine
    const file = path.join(models, "failingWorker.js");
    fs.writeFileSync(
      file,
      `require("fs").appendFileSync(${JSON.stringify(tally)}, "x"); setTimeout(() => process.exit(127), 150);`,
    );

    const errors: string[] = [];
    const first = createLocalSttStream(
      { modelsDir: models, workerPath: file },
      { model: "local-whisper-turbo", language: "en", channels: 1 },
      { onError: (m) => errors.push(m), onClose: () => {} },
    );
    first.close();
    await new Promise((r) => setTimeout(r, 500));

    // a model that could not be loaded must be re-probed, not cached as good
    createLocalSttStream(
      { modelsDir: models, workerPath: file },
      { model: "local-whisper-turbo", language: "en", channels: 1 },
      { onError: (m) => errors.push(m), onClose: () => {} },
    );
    await new Promise((r) => setTimeout(r, 500));

    const runs = fs.readFileSync(tally, "utf8").length;
    expect(runs, "a failed probe was cached as a pass").toBe(2);
  });
});

/**
 * Audit finding 17.
 *
 * `close()` posts `{type:"close"}` and hard-terminates the thread 4 s later,
 * flat. But the worker has to drain every queued chunk and then run its flush -
 * `vad.flush()` and a `decodeOffline()` per channel - before the closing finals
 * can come out. On a heavy offline model with two channels that takes longer
 * than four seconds, so the last thing anyone said before STOP never reached a
 * viewer: `finish()` set `done` at t+4000 and the `if (done) return` guard in
 * the message handler dropped every final that arrived after. Nothing was
 * logged. Worse when STOP lands while the model-load backlog is still queued -
 * the buffer deliberately holds up to `PROBE_TIMEOUT_MS` of speech, and all of
 * it got the same four seconds.
 *
 * A flat deadline cannot be right, because the thing being waited for has no
 * flat size. What is bounded is the worker going QUIET: while finals are still
 * arriving it is draining, and the deadline is what happens when they stop.
 *
 * Not fixed here, and worth saying: the close is still posted behind the audio
 * on the same port. Moving it out of band means changing the protocol on both
 * sides, and the worker half needs sherpa-onnx to be exercised at all. With the
 * deadline scaled, a queued close costs the user a slower STOP, not a lost
 * caption.
 */
function writeSlowFlushWorker(dir: string, opts: { finals: number; everyMs: number }): string {
  const file = path.join(dir, "slowFlushWorker.js");
  fs.writeFileSync(
    file,
    `
if (process.argv[2] === "--probe") { process.exit(0); }
const { parentPort } = require("worker_threads");
parentPort.on("message", (msg) => {
  if (msg.type === "init") parentPort.postMessage({ type: "ready" });
  else if (msg.type === "close") {
    // the flush: one final per utterance, each decode taking real time
    let sent = 0;
    const tick = setInterval(() => {
      sent += 1;
      parentPort.postMessage({ type: "final", text: "utterance " + sent, audioEndSec: sent, channel: 0 });
      if (sent === ${opts.finals}) { clearInterval(tick); process.exit(0); }
    }, ${opts.everyMs});
  }
});
`,
  );
  return file;
}

describe("the last thing said before STOP", () => {
  it("survives a flush that takes longer than the old flat deadline", async () => {
    const models = tmp();
    stageModel(models, "local-moonshine-base", { vad: true });
    // 6 finals, 900 ms apart: 5.4 s of draining, comfortably past the flat 4 s
    const workerPath = writeSlowFlushWorker(models, { finals: 6, everyMs: 900 });

    const finals: string[] = [];
    let resolveClose!: () => void;
    const closed = new Promise<void>((r) => {
      resolveClose = r;
    });

    let stream: ReturnType<typeof createLocalSttStream> | null = null;
    stream = createLocalSttStream(
      { modelsDir: models, workerPath },
      { model: "local-moonshine-base", language: "en", channels: 1 },
      {
        onOpen: () => setTimeout(() => stream?.close(), 20),
        onFinal: (text) => finals.push(text),
        onError: () => {},
        onClose: () => resolveClose(),
      },
    );

    await closed;
    expect(finals, "the flush was cut off partway and captions were lost").toHaveLength(6);
    expect(finals[5]).toBe("utterance 6");
  }, 20000);

  /**
   * Found by writing the test above, not by the audit. `close()` requests the
   * flush when the worker is already up, and the `ready` handler requests it
   * when the close arrived mid-load - and STOP pressed the instant the worker
   * comes up hits both. Two close messages means the worker runs its flush
   * twice, so every closing caption is delivered twice and the second pass has
   * nothing left to say. It also leaked a kill timer per call.
   */
  it("asks for the flush once, even when STOP lands exactly as the worker comes up", async () => {
    const models = tmp();
    stageModel(models, "local-zipformer-en", { vad: true });
    const workerPath = writeSlowFlushWorker(models, { finals: 2, everyMs: 50 });

    const finals: string[] = [];
    let resolveClose!: () => void;
    const closed = new Promise<void>((r) => {
      resolveClose = r;
    });

    let stream: ReturnType<typeof createLocalSttStream> | null = null;
    stream = createLocalSttStream(
      { modelsDir: models, workerPath },
      { model: "local-zipformer-en", language: "en", channels: 1 },
      {
        // synchronous, inside onOpen: close() sees ready and requests the
        // flush, then the ready handler that called onOpen sees `closing`
        onOpen: () => stream?.close(),
        onFinal: (text) => finals.push(text),
        onError: () => {},
        onClose: () => resolveClose(),
      },
    );

    await closed;
    expect(finals, "the flush ran twice, so every closing caption was delivered twice").toEqual([
      "utterance 1",
      "utterance 2",
    ]);
  }, 20000);

  it("still gives up on a worker that has gone quiet", async () => {
    const models = tmp();
    stageModel(models, "local-whisper-tiny-en", { vad: true });
    // answers init, then never says anything again - a wedged decode
    const file = path.join(models, "wedgedWorker.js");
    fs.writeFileSync(
      file,
      `
if (process.argv[2] === "--probe") { process.exit(0); }
const { parentPort } = require("worker_threads");
parentPort.on("message", (msg) => { if (msg.type === "init") parentPort.postMessage({ type: "ready" }); });
setInterval(() => {}, 1000);
`,
    );

    const started = Date.now();
    let resolveClose!: () => void;
    const closed = new Promise<void>((r) => {
      resolveClose = r;
    });

    let stream: ReturnType<typeof createLocalSttStream> | null = null;
    stream = createLocalSttStream(
      { modelsDir: models, workerPath: file },
      { model: "local-whisper-tiny-en", language: "en", channels: 1 },
      { onOpen: () => setTimeout(() => stream?.close(), 20), onError: () => {}, onClose: () => resolveClose() },
    );

    await closed;
    const took = Date.now() - started;
    expect(took, "a silent worker now holds the session open indefinitely").toBeLessThan(12000);
  }, 20000);
});

/**
 * Audit finding 8, the producer half.
 *
 * `sendAudio` posts a 100 ms chunk into the worker's port and returns. Node's
 * port queue is unbounded and nothing ever measured its depth: the only drop
 * path, `droppedBytes += chunk.length`, sits inside `if (!ready)` and is dead
 * the moment the worker answers ready. So a decoder running slower than the
 * audio arrives falls further behind every minute, for the rest of the
 * session, with no drop, no warning and no recovery.
 *
 * Reproduced against the real sherpa-onnx engine before this was written:
 * 120 s of speech was accepted in under a second, every frame taken, nothing
 * reported. On that machine the decoder happened to be ten times faster than
 * realtime so it caught up - a slower model, or two channels, and it never
 * would have.
 *
 * The bound is on how far behind the DECODER is, not on bytes queued: the
 * worker stamps every final with the audio position it reached, and the
 * producer knows how much it has sent, so the difference is the backlog in
 * seconds of speech.
 */
function writeDeafWorker(dir: string): string {
  const file = path.join(dir, "deafWorker.js");
  fs.writeFileSync(
    file,
    `
if (process.argv[2] === "--probe") { process.exit(0); }
const { parentPort } = require("worker_threads");
parentPort.on("message", (msg) => {
  // answers init, takes audio, and never finishes a decode: the shape of a
  // model too slow for the machine it is on
  if (msg.type === "init") parentPort.postMessage({ type: "ready" });
  else if (msg.type === "close") process.exit(0);
});
`,
  );
  return file;
}

describe("a speech engine that cannot keep up", () => {
  /** 100 ms frames; 16 kHz mono 16-bit */
  const secondsOf = (n: number): number => Math.round(n * 10);

  /**
   * Feed frames the way a session does - fast, but never getting further ahead
   * of the worker than a live microphone could.
   *
   * A plain `for` loop cannot do this. It hands 6000 messages to the port as
   * fast as the event loop allows, and on a loaded machine the worker thread
   * has not been scheduled by the time the loop is 60 s of audio ahead - so a
   * worker that is perfectly healthy trips the backlog bound, and the test
   * fails for a reason that has nothing to do with what it is checking. It
   * passed on a fast desktop and failed on CI, which is the worst version of
   * that. `consumed` is whatever the stand-in worker reports back, so the pace
   * is set by the worker rather than by how quick the box is.
   */
  async function feedPaced(
    stream: { sendAudio(b: Buffer): boolean },
    total: number,
    consumed: () => number,
  ): Promise<number> {
    let refused = 0;
    /** the worker stopped taking frames; waiting for it again just burns the timeout */
    let stalled = false;
    for (let i = 0; i < total; i += 1) {
      if (!stream.sendAudio(frame())) refused += 1;
      if (!stalled && i % 50 === 0) {
        // 20 s of audio of slack: well inside the 60 s bound, and enough that
        // the pacing itself never becomes the thing under test. Bounded, so a
        // worker that has stopped taking anything ends the feed and lets the
        // assertion below say what went wrong - an unbounded wait here turns
        // every failure into a timeout that names nothing.
        const until = Date.now() + 2000;
        while (i - consumed() > 200 && Date.now() < until) await new Promise((r) => setTimeout(r, 1));
        if (i - consumed() > 200) stalled = true;
      }
    }
    return refused;
  }

  it("stops taking audio once the decoder is minutes behind, and says so", async () => {
    const models = tmp();
    stageModel(models, "local-sense-voice", { vad: true });
    const workerPath = writeDeafWorker(models);

    const errors: string[] = [];
    let opened!: () => void;
    const isOpen = new Promise<void>((r) => {
      opened = r;
    });

    const stream = createLocalSttStream(
      { modelsDir: models, workerPath },
      { model: "local-sense-voice", language: "en", channels: 1 },
      { onOpen: () => opened(), onError: (m) => errors.push(m), onClose: () => {} },
    );
    await isOpen;

    // five minutes of speech into a worker that never decodes any of it
    let taken = 0;
    let refused = 0;
    for (let i = 0; i < secondsOf(300); i += 1) {
      if (stream.sendAudio(frame())) taken += 1;
      else refused += 1;
    }
    stream.close();

    expect(refused, "five minutes of audio went into an unbounded queue with nothing refused").toBeGreaterThan(0);
    expect(taken, "the bound is so tight that ordinary decode lag would trip it").toBeGreaterThan(secondsOf(30));
    expect(errors.join(" "), "audio was dropped without telling anyone").toMatch(/behind|dropped/i);
  });

  it("does not mistake a quiet microphone for an engine falling behind", async () => {
    const models = tmp();
    stageModel(models, "local-moonshine-tiny", { vad: true });
    // keeps up perfectly and has nothing to transcribe, because nobody is
    // talking. Reading progress off finals alone, ten minutes of silence is
    // indistinguishable from ten minutes of backlog - and the session would
    // start dropping the audio it is about to need.
    const file = path.join(models, "silentRoomWorker.js");
    fs.writeFileSync(
      file,
      `
if (process.argv[2] === "--probe") { process.exit(0); }
const { parentPort } = require("worker_threads");
let sec = 0;
parentPort.on("message", (msg) => {
  if (msg.type === "init") parentPort.postMessage({ type: "ready" });
  else if (msg.type === "audio") {
    sec += 0.1;
    parentPort.postMessage({ type: "progress", fedSec: sec });
    // nothing to transcribe, but the test needs to see the frame was taken
    parentPort.postMessage({ type: "partial", text: "", channel: 0 });
  }
  else if (msg.type === "close") process.exit(0);
});
`,
    );

    const errors: string[] = [];
    let opened!: () => void;
    const isOpen = new Promise<void>((r) => {
      opened = r;
    });
    let taken = 0;
    const stream = createLocalSttStream(
      { modelsDir: models, workerPath: file },
      { model: "local-moonshine-tiny", language: "en", channels: 1 },
      {
        onOpen: () => opened(),
        onPartial: () => {
          taken += 1;
        },
        onError: (m) => errors.push(m),
        onClose: () => {},
      },
    );
    await isOpen;

    const refused = await feedPaced(stream, secondsOf(600), () => taken);
    await new Promise((r) => setTimeout(r, 50));
    stream.close();

    expect(refused, "ten minutes of silence was read as ten minutes of backlog").toBe(0);
    expect(taken, "the worker never took a frame, so this test proves nothing").toBeGreaterThan(secondsOf(500));
    expect(errors, "a silent room was reported as an engine that cannot catch up").toEqual([]);
  }, 20000);

  it("keeps taking audio from an engine that is keeping up", async () => {
    const models = tmp();
    stageModel(models, "local-zipformer-en-20m");
    // reports the audio position it has reached, the way the real worker does
    const file = path.join(models, "keepingUpWorker.js");
    fs.writeFileSync(
      file,
      `
if (process.argv[2] === "--probe") { process.exit(0); }
const { parentPort } = require("worker_threads");
let sec = 0;
parentPort.on("message", (msg) => {
  if (msg.type === "init") parentPort.postMessage({ type: "ready" });
  else if (msg.type === "audio") {
    sec += 0.1;
    parentPort.postMessage({ type: "final", text: "keeping up", audioEndSec: sec, channel: 0 });
  } else if (msg.type === "close") process.exit(0);
});
`,
    );

    const errors: string[] = [];
    let answered = 0;
    let opened!: () => void;
    const isOpen = new Promise<void>((r) => {
      opened = r;
    });
    const stream = createLocalSttStream(
      { modelsDir: models, workerPath: file },
      { model: "local-zipformer-en-20m", language: "en", channels: 1 },
      {
        onOpen: () => opened(),
        onFinal: () => {
          answered += 1;
        },
        onError: (m) => errors.push(m),
        onClose: () => {},
      },
    );
    await isOpen;

    // ten minutes of speech, answered as fast as it arrives
    const refused = await feedPaced(stream, secondsOf(600), () => answered);
    await new Promise((r) => setTimeout(r, 50));
    stream.close();

    expect(refused, "a healthy engine had its audio thrown away").toBe(0);
    expect(answered, "the worker answered nothing, so this test proves nothing").toBeGreaterThan(secondsOf(500));
    expect(errors, "a healthy engine was reported as falling behind").toEqual([]);
  }, 20000);
});
