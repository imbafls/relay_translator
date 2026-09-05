import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import {
  LOCAL_STT_MODELS,
  LocalSttInfo,
  LocalSttModel,
  MODEL_RELEASE_BASE,
  ModelStatus,
  VAD_MODEL_FILE,
  localSttModel,
} from "@callout-relay/shared";
import { needsVad, resolveModelFiles } from "./files";

export interface ModelManagerOptions {
  /** where models live; created on first download */
  modelsDir: string;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  /** called whenever any status changes (progress included, throttled) */
  onChange?: () => void;
}

/**
 * Whether the sherpa-onnx native addon loads on this machine / in this build.
 * Cached: loading it is a few hundred ms and never changes for the process.
 */
let engineProbe: { available: boolean; detail?: string } | null = null;
export function probeLocalEngine(): { available: boolean; detail?: string } {
  if (engineProbe) return engineProbe;
  try {
    // plain require so bundlers keep it external and SEA builds simply fail here
    const mod = require("sherpa-onnx-node") as { version?: string };
    engineProbe = { available: true, detail: mod.version ? `sherpa-onnx ${mod.version}` : undefined };
  } catch (err) {
    const msg = String((err as Error).message || err).split("\n")[0];
    engineProbe = { available: false, detail: msg.slice(0, 160) };
  }
  return engineProbe;
}

/**
 * Downloads and locates local STT models. One download at a time; a failed or
 * cancelled download removes its partial folder so `statuses()` never reports
 * a half model as ready.
 */
export class ModelManager {
  private readonly log: NonNullable<ModelManagerOptions["log"]>;
  private active: { id: string; ctl: AbortController; status: ModelStatus } | null = null;
  private errors = new Map<string, string>();
  private lastEmit = 0;

  constructor(private readonly opts: ModelManagerOptions) {
    this.log = opts.log || (() => {});
  }

  get modelsDir(): string {
    return this.opts.modelsDir;
  }

  /** folder a catalog model resolves from: `<modelsDir>/<id>` or `<modelsDir>/<archive>` */
  modelDir(model: LocalSttModel): string | undefined {
    for (const cand of [path.join(this.modelsDir, model.id), path.join(this.modelsDir, model.archive)]) {
      if (resolveModelFiles(model.kind, cand)) return cand;
    }
    return undefined;
  }

  vadFile(): string | undefined {
    const file = path.join(this.modelsDir, VAD_MODEL_FILE);
    return fs.existsSync(file) ? file : undefined;
  }

  status(id: string): ModelStatus {
    const model = localSttModel(id);
    if (!model) return { id, state: "error", detail: "unknown model" };
    if (this.active && this.active.id === id) return { ...this.active.status };
    const dir = this.modelDir(model);
    if (dir && (!needsVad(model.kind) || this.vadFile())) return { id, state: "ready", dir };
    const err = this.errors.get(id);
    if (err) return { id, state: "error", detail: err };
    return { id, state: "missing" };
  }

  statuses(): ModelStatus[] {
    return LOCAL_STT_MODELS.map((m) => this.status(m.id));
  }

  info(): LocalSttInfo {
    const probe = probeLocalEngine();
    return { available: probe.available, detail: probe.detail, modelsDir: this.modelsDir, models: this.statuses() };
  }

  /** true when `id` can start a session right now */
  ready(id: string): boolean {
    return this.status(id).state === "ready";
  }

  private emit(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < 250) return;
    this.lastEmit = now;
    try {
      this.opts.onChange?.();
    } catch {
      /* listener errors must not break a download */
    }
  }

  /**
   * Fetch the model archive and unpack it into `<modelsDir>/<id>`; phrase
   * models also fetch the VAD once. Resolves when the model is ready.
   */
  async download(id: string): Promise<ModelStatus> {
    const model = localSttModel(id);
    if (!model) throw new Error(`unknown local model: ${id}`);
    if (this.active) throw new Error(`already downloading ${this.active.id}`);
    if (this.ready(id)) return this.status(id);

    const ctl = new AbortController();
    const status: ModelStatus = { id, state: "downloading", percent: 0, bytes: 0 };
    this.active = { id, ctl, status };
    this.errors.delete(id);
    this.emit(true);

    const dest = path.join(this.modelsDir, id);
    /** only a folder this call created is removed on failure */
    let createdDest = false;
    try {
      fs.mkdirSync(this.modelsDir, { recursive: true });
      if (needsVad(model.kind) && !this.vadFile()) {
        this.log("info", `fetching ${VAD_MODEL_FILE}`);
        await this.fetchFile(`${MODEL_RELEASE_BASE}/${VAD_MODEL_FILE}`, path.join(this.modelsDir, VAD_MODEL_FILE), ctl.signal);
      }
      if (!this.modelDir(model)) {
        fs.rmSync(dest, { recursive: true, force: true, maxRetries: 3 });
        fs.mkdirSync(dest, { recursive: true });
        createdDest = true;
        this.log("info", `downloading ${model.archive} (${model.sizeMb} MB)`);
        await this.fetchArchive(`${MODEL_RELEASE_BASE}/${model.archive}.tar.bz2`, dest, model.sizeMb, status, ctl.signal);
        if (!resolveModelFiles(model.kind, dest)) {
          throw new Error("archive did not contain the expected model files");
        }
      }
      this.log("info", `model ready: ${id}`);
    } catch (err) {
      const detail = ctl.signal.aborted ? "cancelled" : String((err as Error).message || err).slice(0, 160);
      if (createdDest) {
        // a half-written folder must never look like a model; a delete that
        // fails (file still open, Explorer, antivirus) is logged, not fatal
        try {
          fs.rmSync(dest, { recursive: true, force: true, maxRetries: 3 });
        } catch (rmErr) {
          this.log("warn", `could not remove partial model folder ${dest}: ${String((rmErr as Error).message || rmErr)}`);
        }
      }
      if (!ctl.signal.aborted) {
        this.errors.set(id, detail);
        this.log("error", `model download failed (${id}): ${detail}`);
      }
      throw new Error(detail);
    } finally {
      this.active = null;
      this.emit(true);
    }
    return this.status(id);
  }

  cancel(): boolean {
    if (!this.active) return false;
    this.active.ctl.abort();
    return true;
  }

  remove(id: string): void {
    const model = localSttModel(id);
    if (!model) return;
    if (this.active?.id === id) this.cancel();
    for (const cand of [path.join(this.modelsDir, model.id), path.join(this.modelsDir, model.archive)]) {
      fs.rmSync(cand, { recursive: true, force: true });
    }
    this.errors.delete(id);
    this.emit(true);
  }

  private async fetchFile(url: string, file: string, signal: AbortSignal): Promise<void> {
    const res = await fetch(url, { signal, redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`http ${res.status} for ${path.basename(file)}`);
    const tmp = `${file}.part`;
    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp));
    fs.renameSync(tmp, file);
  }

  private async fetchArchive(url: string, dest: string, sizeMb: number, status: ModelStatus, signal: AbortSignal): Promise<void> {
    const res = await fetch(url, { signal, redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`http ${res.status}`);
    const total = Number(res.headers.get("content-length")) || sizeMb * 1048576;
    let received = 0;
    const progress = new (require("stream").Transform)({
      transform: (chunk: Buffer, _enc: string, cb: (err?: Error | null, data?: Buffer) => void) => {
        received += chunk.length;
        status.bytes = received;
        status.percent = Math.min(99, Math.floor((received / total) * 100));
        this.emit();
        cb(null, chunk);
      },
    });
    // tar + bunzip2 are pure JS, so the archive never touches the disk twice
    const unbzip2 = require("unbzip2-stream") as () => NodeJS.ReadWriteStream;
    const tar = require("tar") as { x: (opts: { cwd: string; strip: number }) => NodeJS.WritableStream };
    const onAbort = (): void => {
      progress.destroy(new Error("cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await pipeline(Readable.fromWeb(res.body as never), progress, unbzip2(), tar.x({ cwd: dest, strip: 1 }));
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    status.state = "unpacking";
    status.percent = 100;
    this.emit(true);
  }
}
