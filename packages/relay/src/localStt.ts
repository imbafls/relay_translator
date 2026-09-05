import * as fs from "fs";
import * as path from "path";
import { Worker } from "worker_threads";
import { LOCAL_VAD, sttModel } from "@callout-relay/shared";
import { SttEvents, SttStream } from "./deepgram";
import { spawn } from "child_process";
import type { LocalSttFromWorker, LocalSttInit, LocalSttToWorker } from "./localSttWorker";

export interface LocalSttOptions {
  /** <dataDir>/models - one folder per model id */
  modelsDir: string;
  /** compiled worker script (dist/localSttWorker.js next to the relay bundle) */
  workerPath: string;
}

export interface LocalSttConfig {
  model: string;
  language: string;
  channels: number;
}

/** true when every file of the model (and the VAD it needs) is on disk */
export function localModelReady(modelsDir: string, id: string): boolean {
  const info = sttModel(id);
  if (!info || info.provider !== "local" || !info.files) return false;
  const dir = path.join(modelsDir, id);
  const all = info.files.every((f) => fs.existsSync(path.join(dir, f.name)));
  if (!all) return false;
  if (info.kind === "offline") return localVadReady(modelsDir);
  return true;
}

export function localVadReady(modelsDir: string): boolean {
  return LOCAL_VAD.files!.every((f) => fs.existsSync(path.join(modelsDir, LOCAL_VAD.id, f.name)));
}

/** the default worker location for a plain (non-bundled) relay build */
export function defaultWorkerPath(): string {
  return path.join(__dirname, "localSttWorker.js");
}

/** models whose load has already been proved in this process */
const verified = new Set<string>();

/**
 * Load the model once in a throwaway child process. sherpa-onnx aborts the
 * process outright on some models instead of throwing, which would take the
 * whole app down from a worker thread; here only the child dies and the exit
 * code tells us the model is unusable.
 */
function probeModel(workerPath: string, init: LocalSttInit): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [workerPath, "--probe", JSON.stringify({ ...init, channels: 1 })], {
        // under Electron this makes the app binary behave as plain node
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      return resolve(String((err as Error)?.message || err));
    }
    let tail = "";
    child.stderr?.on("data", (d: Buffer) => {
      tail = (tail + String(d)).slice(-2000);
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve("it took too long to load");
    }, 180000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(String(err?.message || err));
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(null);
      const last = tail.trim().split(/\r?\n/).filter(Boolean).pop();
      resolve(`the speech engine quit with ${signal || code}${last ? `: ${last}` : ""}`);
    });
  });
}

/**
 * Local STT over a worker thread. Audio is handed to the worker with
 * ownership transfer; results come back as partial/final events with the
 * channel they belong to. Errors before "ready" surface through onError and
 * the stream closes.
 */
export function createLocalSttStream(opts: LocalSttOptions, cfg: LocalSttConfig, events: SttEvents): SttStream {
  const info = sttModel(cfg.model);
  const fail = (message: string): SttStream => {
    setImmediate(() => {
      events.onError?.(message);
      events.onClose?.();
    });
    return { sendAudio() {}, close() {} };
  };
  if (!info || info.provider !== "local" || !info.engine) return fail(`unknown local model "${cfg.model}"`);
  if (!localModelReady(opts.modelsDir, cfg.model)) return fail(`model "${info.label}" is not downloaded yet (02 TRANSCRIBE → DOWNLOAD)`);
  if (!fs.existsSync(opts.workerPath)) return fail(`local STT worker missing at ${opts.workerPath} (local models need the desktop app)`);

  let worker: Worker | null = null;
  let ready = false;
  /** close() was called: audio stops, but finals from the worker's flush still count */
  let closing = false;
  /** the worker is gone (or never came up) and onClose has fired */
  let done = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const pending: Buffer[] = [];

  const send = (msg: LocalSttToWorker, transfer?: ArrayBuffer[]): void => {
    try {
      worker?.postMessage(msg, transfer);
    } catch {
      /* worker gone */
    }
  };

  const finish = (): void => {
    if (done) return;
    done = true;
    if (killTimer) clearTimeout(killTimer);
    void worker?.terminate().catch(() => {});
    events.onClose?.();
  };

  const requestClose = (): void => {
    send({ type: "close" });
    // give the flush a moment, then make sure the thread is gone
    killTimer = setTimeout(finish, 4000);
  };

  function startWorker(): void {
    try {
      worker = new Worker(opts.workerPath);
    } catch (err) {
      events.onError?.(`could not start local STT worker: ${String((err as Error).message || err)}`);
      finish();
      return;
    }
    wire(worker);
    send(initMsg);
  }

  function wire(worker: Worker): void {
  worker.on("message", (msg: LocalSttFromWorker) => {
    if (done) return;
    if (msg.type === "ready") {
      ready = true;
      if (!closing) events.onOpen?.();
      for (const b of pending) sendAudio(b);
      pending.length = 0;
      if (closing) requestClose();
    } else if (msg.type === "partial") {
      if (!closing) events.onPartial?.(msg.text, msg.channel);
    } else if (msg.type === "final") events.onFinal?.(msg.text, { audioEndSec: msg.audioEndSec, channel: msg.channel });
    else if (msg.type === "error") events.onError?.(msg.message);
  });
  worker.on("error", (err) => {
    if (done) return;
    events.onError?.(`local STT worker crashed: ${String(err?.message || err)}`);
  });
  worker.on("exit", () => finish());
  }

  const initMsg: LocalSttInit = {
    type: "init",
    engine: info.engine,
    modelDir: path.join(opts.modelsDir, cfg.model),
    vadModel: path.join(opts.modelsDir, LOCAL_VAD.id, LOCAL_VAD.files![0].name),
    channels: cfg.channels,
    melBins: info.melBins,
    language: cfg.language,
    numThreads: Math.max(1, Math.min(4, Math.floor((require("os").cpus()?.length || 4) / 2))),
  };

  // audio that arrives while the probe runs queues up in `pending`, the same
  // way it does while the model is loading
  if (verified.has(cfg.model)) startWorker();
  else {
    void probeModel(opts.workerPath, initMsg).then((problem) => {
      if (done) return;
      if (problem) {
        events.onError?.(`"${info.label}" could not be loaded on this PC (${problem}). Pick another model under 02 TRANSCRIBE.`);
        finish();
        return;
      }
      verified.add(cfg.model);
      startWorker();
    });
  }

  function sendAudio(chunk: Buffer): void {
    if (done) return;
    if (!ready) {
      // a few seconds at most: the model is loading
      if (pending.length < 300) pending.push(Buffer.from(chunk));
      return;
    }
    // copy into a standalone ArrayBuffer so it can be transferred
    const ab = new ArrayBuffer(chunk.length);
    new Uint8Array(ab).set(chunk);
    send({ type: "audio", buffer: ab }, [ab]);
  }

  return {
    sendAudio(chunk: Buffer) {
      if (!closing) sendAudio(chunk);
    },
    close() {
      if (closing || done) return;
      closing = true;
      // not loaded yet: the ready handler flushes the queue and closes.
      // No worker at all (still probing) means there is nothing to flush.
      if (ready) requestClose();
      else if (!worker) finish();
    },
  };
}
