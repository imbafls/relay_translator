import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Worker } from "worker_threads";
import { localSttModel } from "@callout-relay/shared";
import { SttEvents, SttStream } from "../deepgram";
import { needsVad, resolveModelFiles } from "./files";
import { ModelManager } from "./models";
import type { FromWorker, ToWorker } from "./protocol";

export interface LocalSttConfig {
  /** catalog id, e.g. "local-zipformer-en-20m" */
  model: string;
  language: string;
  models: ModelManager;
  /** explicit worker script (packaged builds); otherwise found next to this file */
  workerFile?: string;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

/**
 * The worker script lives next to this module in the tsc build
 * (dist/localStt/worker.js) and as a sibling bundle when esbuild has inlined
 * the relay into another entry (dist/localStt-worker.js).
 */
export function resolveWorkerFile(explicit?: string): string | undefined {
  const candidates = [
    explicit,
    process.env.CALLOUT_LOCAL_STT_WORKER,
    path.join(__dirname, "worker.js"),
    path.join(__dirname, "localStt-worker.js"),
    path.join(__dirname, "localStt", "worker.js"),
  ].filter((f): f is string => !!f);
  return candidates.find((f) => {
    try {
      return fs.existsSync(f);
    } catch {
      return false;
    }
  });
}

/** leave the game some cores: half the threads, at most 6 */
export function defaultThreads(): number {
  const n = os.cpus().length || 2;
  return Math.max(1, Math.min(6, Math.floor(n / 2)));
}

/**
 * SttStream backed by a sherpa-onnx worker thread. Mirrors the Deepgram
 * stream's events so PublisherSession does not care which it got.
 */
export function createLocalSttStream(cfg: LocalSttConfig, events: SttEvents): SttStream {
  const log = cfg.log || (() => {});
  const model = localSttModel(cfg.model);
  let worker: Worker | null = null;
  let closed = false;

  const fail = (message: string): void => {
    events.onError?.(message);
    if (!closed) {
      closed = true;
      events.onClose?.();
    }
  };

  const dir = model ? cfg.models.modelDir(model) : undefined;
  const files = model && dir ? resolveModelFiles(model.kind, dir) : undefined;
  const vadFile = model && needsVad(model.kind) ? cfg.models.vadFile() : undefined;
  const workerFile = resolveWorkerFile(cfg.workerFile);

  if (!model) setImmediate(() => fail(`unknown local model: ${cfg.model}`));
  else if (!files) setImmediate(() => fail(`model not downloaded: ${model.label}`));
  else if (needsVad(model.kind) && !vadFile) setImmediate(() => fail("voice activity model missing - download the model again"));
  else if (!workerFile) setImmediate(() => fail("local STT worker not found in this build"));
  else {
    try {
      worker = new Worker(workerFile);
    } catch (err) {
      setImmediate(() => fail(`local STT worker failed: ${String((err as Error).message || err)}`));
    }
  }

  if (worker && model && files) {
    worker.on("message", (msg: FromWorker) => {
      if (msg.type === "open") {
        log("info", `local stt ready: ${model.label} (${model.mode})`);
        events.onOpen?.();
      } else if (msg.type === "partial") events.onPartial?.(msg.text);
      else if (msg.type === "final") events.onFinal?.(msg.text, { audioEndSec: msg.audioEndSec });
      else if (msg.type === "error") fail(msg.message);
      else if (msg.type === "closed") void worker?.terminate();
    });
    worker.on("error", (err) => fail(`local stt crashed: ${err.message}`));
    worker.on("exit", () => {
      if (!closed) {
        closed = true;
        events.onClose?.();
      }
    });
    const init: ToWorker = {
      type: "init",
      kind: model.kind,
      mode: model.mode,
      files,
      vadFile,
      language: cfg.language,
      numThreads: defaultThreads(),
    };
    worker.postMessage(init);
  }

  return {
    sendAudio(chunk: Buffer) {
      if (!worker || closed) return;
      // copy: the relay reuses socket buffers, and the worker takes ownership
      const copy = new ArrayBuffer(chunk.length - (chunk.length % 2));
      new Uint8Array(copy).set(chunk.subarray(0, copy.byteLength));
      worker.postMessage({ type: "audio", buffer: copy } satisfies ToWorker, [copy]);
    },
    close() {
      closed = true;
      if (!worker) return;
      const w = worker;
      worker = null;
      try {
        w.postMessage({ type: "close" } satisfies ToWorker);
      } catch {
        /* noop */
      }
      // the worker answers "closed" and is terminated; hard stop as a backstop
      setTimeout(() => void w.terminate(), 3000).unref();
    },
  };
}
