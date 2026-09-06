/**
 * Local STT model store: `<dataDir>/models/<id>/<file>`. Per-file downloads
 * stream to `<file>.part` and rename on completion; archive models unpack
 * into `<id>.part/` and are published with one directory rename. Either way a
 * half-finished model never looks installed. One download at a time per
 * model; offline models also pull the silero VAD the worker needs.
 */
import * as fs from "fs";
import * as path from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import * as tar from "tar";
import unbzip2 from "unbzip2-stream";
import { LOCAL_VAD, LocalModelStatus, STT_MODELS, SttModelInfo, modelDiskBytes } from "@callout-relay/shared";
import { localModelReady } from "@callout-relay/relay";

/** free bytes on the volume holding `dir`, or -1 if the platform will not say */
function defaultFreeBytes(dir: string): number {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bsize) * Number(st.bavail);
  } catch {
    return -1;
  }
}

export class ModelStore {
  private active = new Map<string, { controller: AbortController; progress: number }>();
  private errors = new Map<string, string>();

  constructor(
    readonly dir: string,
    private readonly onChange: () => void,
    private readonly log: (level: "info" | "warn" | "error", message: string) => void,
    /** the models this store knows about; the shipped catalogue unless overridden */
    private readonly catalogue: SttModelInfo[] = STT_MODELS,
    /** free space at a path, or -1 when it cannot be determined */
    private readonly freeBytes: (dir: string) => number = defaultFreeBytes,
  ) {}

  /** same rule the relay applies before it starts a local session */
  isReady(id: string): boolean {
    return localModelReady(this.dir, id);
  }

  status(): LocalModelStatus[] {
    return this.catalogue.filter((m) => m.provider === "local").map((m) => {
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
    const info = this.catalogue.find((m) => m.id === id);
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
    // set once the archive starts unpacking: only then may cleanup delete the
    // model folder. An offline archive model also pulls the shared VAD first,
    // and a failure there must not wipe an install this run never touched.
    let unpacked = false;
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
      // An archive downloads far less than it installs - whisper turbo fetches
      // 564 MB and leaves 1037 MB - so the download size is no guide to whether
      // it will fit. Running out part way through means a long wait, a failure
      // deep in the extract, and a disk that is now full as well.
      const needed = modelDiskBytes(info);
      const free = this.freeBytes(this.dir);
      if (free >= 0 && free < needed) {
        const mb = (n: number): string => `${Math.round(n / 1e6)} MB`;
        throw new Error(
          `needs ${mb(needed)} free once unpacked and this drive has ${mb(free)}`,
        );
      }
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
      if (info.archive && !this.isReady(id)) {
        unpacked = true;
        await this.fetchArchive(info, controller.signal, tick);
      }
      run.progress = 100;
      this.log("info", `model ready: ${id}`);
    } catch (err) {
      const message = controller.signal.aborted ? "cancelled" : String((err as Error).message || err);
      this.errors.set(id, message);
      this.log("error", `model download failed: ${id} - ${message}`);
      // a half-unpacked archive must never look like a model on the next launch
      const stale = info.archive ? [`${path.join(this.dir, id)}.part`] : [];
      if (unpacked) stale.push(path.join(this.dir, id));
      for (const folder of stale) {
        try {
          fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
        } catch (rmErr) {
          this.log("warn", `could not clean up ${folder}: ${String((rmErr as Error).message || rmErr)}`);
        }
      }
    } finally {
      this.active.delete(id);
      this.onChange();
    }
  }

  /**
   * Fetch a tar.bz2 model and unpack only the entries it declares, renaming
   * each to the plain name the worker looks for. The archive itself never
   * touches disk.
   *
   * Everything lands in `<dir>/<id>.part/` first. `localModelReady()` decides
   * by filename alone, so extracting straight into `<dir>/<id>/` would report
   * the model ready the moment tar opened the last file - before its bytes
   * were written - and a crash mid-extract would leave that half-written file
   * looking installed for good. The staging folder is published with a single
   * directory rename once every entry is present and non-empty.
   */
  private async fetchArchive(info: SttModelInfo, signal: AbortSignal, tick: (chunk: Buffer) => void): Promise<void> {
    const archive = info.archive!;
    const folder = path.join(this.dir, info.id);
    const staging = `${folder}.part`;
    // a staging folder left by an earlier crash or cancel is never resumable
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
    fs.mkdirSync(staging, { recursive: true });
    this.log("info", `model download: ${info.id} archive (${Math.round(archive.size / 1e6)} MB)`);

    const res = await fetch(archive.url, { signal, redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${info.id}`);
    // entry name inside the archive -> the local name the worker wants
    const wanted = new Map<string, string>();
    for (const [local, entry] of Object.entries(archive.pick)) wanted.set(entry, local);

    // A stream that stops early and one that arrives corrupted both surface as
    // the same decoder error, which sends you looking at the wrong half. Two
    // things tell them apart, and the byte count is NOT one of them:
    //
    // `received` counts bytes pulled from a demand-driven body, so when the
    // decoder throws part-way the pipeline destroys the source with most of it
    // unread. A 512 KB archive that arrived perfectly and simply was not bz2
    // reported "the download stopped early: 28672 of 524288 bytes (5%) - No
    // magic number found". That message is what has been sending people
    // chasing a network problem that was never there.
    //
    // What does tell them apart is WHERE the error came from. Every error the
    // body raises is tagged, so whichever one `pipeline` surfaces first can be
    // attributed. A server that ends cleanly but short raises nothing, so the
    // byte count still earns its place - as the second question, not the first.
    const declared = Number(res.headers.get("content-length")) || archive.size || 0;
    let received = 0;
    let sourceEnded = false;
    const body = Readable.fromWeb(res.body as never);
    body.on("data", (chunk: Buffer) => {
      received += chunk.length;
      tick(chunk);
    });
    body.on("end", () => {
      sourceEnded = true;
    });
    // deliberately no "which stream errored" flag: when the decoder throws,
    // pipeline destroys the source WITH THAT ERROR, so the body re-emits the
    // decoder's own error and tagging it proves nothing. Tried, and it happily
    // reported a corrupt archive as a broken download all over again.
    body.on("error", () => {
      /* handled by the pipeline; this only stops an unhandled 'error' */
    });
    try {
      await pipeline(
        body,
        unbzip2(),
        tar.x({
          cwd: staging,
          strip: 1,
          // without this a failed write (a full disk, a lock) is only a warning:
          // tar drops the rest of that entry, the pipeline resolves, and a
          // truncated ONNX would sail through as a finished model
          strict: true,
          filter: (p: string) => wanted.has(path.posix.basename(p)),
        }),
      );
    } catch (err) {
      const detail = String((err as Error).message || err);
      // Two signals, neither of which is "how many bytes did we pull":
      //  - the error is a stream/socket failure, i.e. the transport broke;
      //  - or the source ENDED and still delivered less than it announced,
      //    which is a server that closed short cleanly and raises nothing.
      // A decoder error on a body that never ended is the archive, whatever
      // the byte count says - and that is the case this was getting wrong.
      const code = (err as NodeJS.ErrnoException).code;
      const transportish =
        code === "ERR_STREAM_PREMATURE_CLOSE" ||
        code === "ECONNRESET" ||
        code === "ETIMEDOUT" ||
        code === "UND_ERR_SOCKET";
      const endedShort = sourceEnded && declared > 0 && received < declared;
      if (transportish || endedShort) {
        const pct = declared > 0 ? Math.floor((received / declared) * 100) : 100;
        throw new Error(
          `the download stopped early: ${received} of ${declared} bytes (${pct}%) - ${detail}`,
        );
      }
      throw new Error(`the archive would not unpack (${received} bytes read) - ${detail}`);
    }

    // the catalog carries the exact unpacked size of every entry. A short file
    // is the shape a swallowed write error takes, so it fails the download; a
    // long one only means the catalog drifted, which is not the worker's problem
    const expect = new Map((info.files || []).map((f) => [f.name, f.size]));
    for (const [entry, local] of wanted) {
      const from = path.join(staging, entry);
      if (!fs.existsSync(from)) throw new Error(`archive is missing ${entry}`);
      const size = fs.statSync(from).size;
      const want = expect.get(local);
      if (want != null ? size < want : size === 0) {
        throw new Error(`archive entry ${entry} is ${size} B, expected ${want ?? "non-empty"}`);
      }
      if (want != null && size !== want) this.log("warn", `${info.id}/${local} is ${size} B, catalog says ${want}`);
      if (entry !== local) fs.renameSync(from, path.join(staging, local));
    }
    // only now may the model be seen: one rename, after every file is whole.
    // Windows hands out EPERM/EBUSY when a scanner is still holding a new file,
    // so the publish gets the same few retries the removals get.
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(staging, folder);
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
  }

  cancel(id: string): void {
    this.active.get(id)?.controller.abort();
  }

  /** remove every file of a model (the VAD is shared, so it stays) */
  remove(id: string): void {
    const info = this.catalogue.find((m) => m.id === id);
    if (!info || info.provider !== "local") return;
    this.cancel(id);
    this.errors.delete(id);
    try {
      fs.rmSync(path.join(this.dir, id), { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      // Windows keeps the ONNX files locked while a session decodes with them
      this.errors.set(id, `could not remove: ${String((err as Error).message || err)}`);
      this.log("warn", `model remove failed: ${id} - ${String(err)}`);
    }
    // leftover staging is its own problem: it must never block the removal above
    try {
      fs.rmSync(`${path.join(this.dir, id)}.part`, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      this.log("warn", `could not remove staging for ${id} - ${String(err)}`);
    }
    this.onChange();
  }
}
