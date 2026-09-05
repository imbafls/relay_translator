/**
 * Local STT model store: `<dataDir>/models/<id>/<file>`. Downloads stream to
 * `<file>.part` and rename on completion, so a half-finished model never
 * looks installed. One download at a time per model; offline models also
 * pull the silero VAD the worker needs.
 */
import * as fs from "fs";
import * as path from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { LOCAL_VAD, LocalModelStatus, STT_MODELS, SttModelInfo } from "@callout-relay/shared";

export class ModelStore {
  private active = new Map<string, { controller: AbortController; progress: number }>();
  private errors = new Map<string, string>();

  constructor(
    readonly dir: string,
    private readonly onChange: () => void,
    private readonly log: (level: "info" | "warn" | "error", message: string) => void,
  ) {}

  private hasFiles(info: SttModelInfo): boolean {
    return !!info.files && info.files.every((f) => fs.existsSync(path.join(this.dir, info.id, f.name)));
  }

  isReady(id: string): boolean {
    const info = STT_MODELS.find((m) => m.id === id);
    if (!info || info.provider !== "local") return false;
    if (!this.hasFiles(info)) return false;
    return info.kind !== "offline" || this.hasFiles(LOCAL_VAD);
  }

  status(): LocalModelStatus[] {
    return STT_MODELS.filter((m) => m.provider === "local").map((m) => {
      const run = this.active.get(m.id);
      return {
        id: m.id,
        downloaded: this.isReady(m.id),
        sizeMb: m.sizeMb || 0,
        progress: run ? run.progress : undefined,
        error: this.errors.get(m.id),
      };
    });
  }

  async download(id: string): Promise<void> {
    const info = STT_MODELS.find((m) => m.id === id);
    if (!info || info.provider !== "local" || !info.files) throw new Error(`unknown local model ${id}`);
    if (this.active.has(id)) return;
    const controller = new AbortController();
    const run = { controller, progress: 0 };
    this.active.set(id, run);
    this.errors.delete(id);
    this.onChange();

    const plan: { info: SttModelInfo; file: SttModelInfo["files"] extends (infer F)[] | undefined ? F : never }[] = [];
    for (const f of info.files) plan.push({ info, file: f });
    if (info.kind === "offline") for (const f of LOCAL_VAD.files!) plan.push({ info: LOCAL_VAD, file: f });
    const total = plan.reduce((n, p) => n + p.file.size, 0);
    let doneBytes = 0;
    let lastTick = 0;

    try {
      for (const { info: target, file } of plan) {
        const folder = path.join(this.dir, target.id);
        fs.mkdirSync(folder, { recursive: true });
        const dest = path.join(folder, file.name);
        if (fs.existsSync(dest) && fs.statSync(dest).size === file.size) {
          doneBytes += file.size;
          continue;
        }
        const part = `${dest}.part`;
        this.log("info", `model download: ${target.id}/${file.name} (${Math.round(file.size / 1e6)} MB)`);
        const res = await fetch(file.url, { signal: controller.signal, redirect: "follow" });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${file.name}`);
        const out = fs.createWriteStream(part);
        const body = Readable.fromWeb(res.body as never);
        body.on("data", (chunk: Buffer) => {
          doneBytes += chunk.length;
          const now = Date.now();
          if (now - lastTick > 250) {
            lastTick = now;
            run.progress = Math.min(99, Math.floor((doneBytes / total) * 100));
            this.onChange();
          }
        });
        await pipeline(body, out);
        fs.renameSync(part, dest);
      }
      run.progress = 100;
      this.log("info", `model ready: ${id}`);
    } catch (err) {
      const message = controller.signal.aborted ? "cancelled" : String((err as Error).message || err);
      this.errors.set(id, message);
      this.log("error", `model download failed: ${id} - ${message}`);
    } finally {
      this.active.delete(id);
      this.onChange();
    }
  }

  cancel(id: string): void {
    this.active.get(id)?.controller.abort();
  }

  /** remove every file of a model (the VAD is shared, so it stays) */
  remove(id: string): void {
    const info = STT_MODELS.find((m) => m.id === id);
    if (!info || info.provider !== "local") return;
    this.cancel(id);
    this.errors.delete(id);
    try {
      fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    } catch (err) {
      // Windows keeps the ONNX files locked while a session decodes with them
      this.errors.set(id, `could not remove: ${String((err as Error).message || err)}`);
      this.log("warn", `model remove failed: ${id} - ${String(err)}`);
    }
    this.onChange();
  }
}
