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
import * as tar from "tar";
import unbzip2 from "unbzip2-stream";
import { LOCAL_VAD, LocalModelStatus, STT_MODELS, SttModelInfo } from "@callout-relay/shared";
import { localModelReady } from "@callout-relay/relay";

export class ModelStore {
  private active = new Map<string, { controller: AbortController; progress: number }>();
  private errors = new Map<string, string>();

  constructor(
    readonly dir: string,
    private readonly onChange: () => void,
    private readonly log: (level: "info" | "warn" | "error", message: string) => void,
  ) {}

  /** same rule the relay applies before it starts a local session */
  isReady(id: string): boolean {
    return localModelReady(this.dir, id);
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
    // archive models are one download; `files` only says what it unpacks to
    if (!info.archive) for (const f of info.files) plan.push({ info, file: f });
    if (info.kind === "offline") for (const f of LOCAL_VAD.files!) plan.push({ info: LOCAL_VAD, file: f });
    const total = plan.reduce((n, p) => n + p.file.size, 0) + (info.archive?.size || 0);
    let doneBytes = 0;
    let lastTick = 0;
    const tick = (chunk: Buffer): void => {
      doneBytes += chunk.length;
      const now = Date.now();
      if (now - lastTick > 250) {
        lastTick = now;
        run.progress = Math.min(99, Math.floor((doneBytes / total) * 100));
        this.onChange();
      }
    };

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
        body.on("data", tick);
        await pipeline(body, out);
        fs.renameSync(part, dest);
      }
      if (info.archive && !this.isReady(id)) await this.fetchArchive(info, controller.signal, tick);
      run.progress = 100;
      this.log("info", `model ready: ${id}`);
    } catch (err) {
      const message = controller.signal.aborted ? "cancelled" : String((err as Error).message || err);
      this.errors.set(id, message);
      this.log("error", `model download failed: ${id} - ${message}`);
      // a half-unpacked archive must never look like a model on the next launch
      if (info.archive) {
        try {
          fs.rmSync(path.join(this.dir, id), { recursive: true, force: true, maxRetries: 3 });
        } catch (rmErr) {
          this.log("warn", `could not clean up ${id}: ${String((rmErr as Error).message || rmErr)}`);
        }
      }
    } finally {
      this.active.delete(id);
      this.onChange();
    }
  }

  /**
   * Fetch a tar.bz2 model and unpack only the entries it declares, renaming
   * each to the plain name the worker looks for. Nothing is written outside
   * `<dir>/<id>/`, and the archive itself never touches disk.
   */
  private async fetchArchive(info: SttModelInfo, signal: AbortSignal, tick: (chunk: Buffer) => void): Promise<void> {
    const archive = info.archive!;
    const folder = path.join(this.dir, info.id);
    fs.mkdirSync(folder, { recursive: true });
    this.log("info", `model download: ${info.id} archive (${Math.round(archive.size / 1e6)} MB)`);

    const res = await fetch(archive.url, { signal, redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${info.id}`);
    // entry name inside the archive -> the local name the worker wants
    const wanted = new Map<string, string>();
    for (const [local, entry] of Object.entries(archive.pick)) wanted.set(entry, local);

    const body = Readable.fromWeb(res.body as never);
    body.on("data", tick);
    await pipeline(
      body,
      unbzip2(),
      tar.x({
        cwd: folder,
        strip: 1,
        filter: (p: string) => wanted.has(path.posix.basename(p)),
      }),
    );

    for (const [entry, local] of wanted) {
      const from = path.join(folder, entry);
      if (!fs.existsSync(from)) throw new Error(`archive is missing ${entry}`);
      if (entry !== local) fs.renameSync(from, path.join(folder, local));
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
