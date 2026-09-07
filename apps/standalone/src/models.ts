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

/**
 * Windows says these when something else still has the file open. A scanner
 * working through a freshly written model is the ordinary cause; none of them
 * mean the operation was wrong, only that it was early.
 */
const LOCKED = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

/**
 * Remove a folder, waiting out the same locks a publish waits out.
 *
 * Node's own `maxRetries` backs off 100 ms a go, so the default three retries
 * give it about 300 ms - the same order of budget that was too short upstairs.
 * This is what left an EMPTY `.part` behind after a failed publish: Windows
 * deleted the files and then could not remove a directory whose handles were
 * still held, so the folder stayed and the model looked half-installed.
 */
function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 400 });
}

/**
 * Retry a publish while the filesystem says the files are still held.
 *
 * A model is published by renaming its staging folder into place, and on
 * Windows a directory cannot be renamed while ANY file inside it is open by
 * another process. Defender holds freshly written files while it scans them,
 * and a model is hundreds of megabytes of ONNX.
 *
 * This used to be four attempts at 150/300/450 ms - 900 ms in total. Enough for
 * a small model, and nowhere near enough for a large one: the two models a user
 * could not install were the two largest in the catalogue, 651 MB and 989 MB,
 * while the ones that installed cleanly were 99 MB and 68 MB.
 *
 * Half a minute instead, backing off. An error that waiting cannot fix - a full
 * disk, a missing path - is raised on the first attempt rather than buried
 * under thirty seconds of pointless retrying.
 */
export async function publishRetry(
  rename: () => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const waits = [200, 400, 800, 1200, 1600, 2000, 3000, 4000, 5000, 6000, 8000];
  for (let attempt = 0; ; attempt++) {
    try {
      rename();
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !LOCKED.has(code)) throw err;
      if (attempt >= waits.length) {
        throw new Error(
          `the model downloaded but could not be put in place - its files are still open ` +
            `${Math.round(waits.reduce((a, b) => a + b, 0) / 1000)}s after unpacking. ` +
            `An antivirus scanner reading a large model is the usual cause; try again, ` +
            `or exclude the models folder from real-time scanning (${code})`,
        );
      }
      await sleep(waits[attempt]);
    }
  }
}

/** free bytes on the volume holding `dir`, or -1 if the platform will not say */

/**
 * The archive body, as one continuous stream, across as many connections as it
 * takes.
 *
 * The two models people actually fail on are the two big ones - Whisper Turbo
 * unpacks from a 564 MB archive, Nemotron from 372 MB - and until now a single
 * dropped connection at any point threw all of it away and started again from
 * byte zero. On a flaky line that is not a slow download, it is one that never
 * finishes, because each attempt has to win a ninety-second race outright.
 *
 * So on a transport failure this reconnects and asks for `bytes=<received>-`.
 * GitHub's release asset host answers 206 with a Content-Range, which is what
 * makes it possible; a host that ignores the header and replays from the start
 * is handled by discarding the bytes already delivered, because the decoder
 * downstream is mid-archive and cannot be rewound.
 *
 * **Only transport failures resume.** A body that ends cleanly but short raises
 * nothing to catch and is indistinguishable, at this layer, from a complete
 * one; `fetchArchive` still reports that case from the byte count. Nor is this
 * a resume across app restarts - the bytes are decoded as they arrive and never
 * stored, so there is nothing on disk to continue from.
 *
 * **Parallel range requests were considered and rejected.** They would be
 * faster, and the host supports them. But chunks arrive out of order, and the
 * pipeline here decodes bz2 and untars *while* downloading - so out-of-order
 * chunks mean buffering the whole archive to disk first, which takes peak usage
 * for Whisper Turbo from 989 MB to about 1.55 GB and adds a second failure mode
 * (assembly) to the path already suspected of being the broken one. Resuming
 * fixes the failure; parallelism only shortens the window it happens in.
 */
export interface ResumeOpts {
  signal: AbortSignal;
  /** attempts allowed with no byte delivered between them */
  tries?: number;
  /**
   * a ceiling on attempts however well it is going. Progress resets `tries`,
   * so without this a host that hands over a few bytes and dies, for ever,
   * would be retried for ever.
   */
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  onRetry?: (received: number, detail: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How long to wait before each retry that has made no progress. Short, and
 * deliberately so: the budget below is reset by any byte that arrives, so this
 * bounds a connection that is STUCK, not a download that is going badly.
 */
const RESUME_WAITS = [400, 900, 1800, 3500];

export function resumableBody(url: string, opts: ResumeOpts): Readable {
  const call = opts.fetchImpl ?? fetch;
  const tries = opts.tries ?? RESUME_WAITS.length + 1;
  const maxAttempts = opts.maxAttempts ?? 30;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function* pull(): AsyncGenerator<Buffer> {
    let received = 0;
    /** `received` when this run of failures started; -1 before the first one */
    let mark = -1;
    /** consecutive failures with no byte delivered between them */
    let stuck = 0;
    /** connections opened, however they went */
    let opened = 0;
    for (;;) {
      let skip = 0;
      /**
       * True only while this generator is suspended at `yield`. An error that
       * arrives in that window was thrown INTO it by whoever is reading -
       * `pipeline` destroying this source with the decoder's own error - so it
       * says nothing about the transport.
       */
      let fromConsumer = false;
      opened += 1;
      try {
        const res = await call(url, {
          signal: opts.signal,
          redirect: "follow",
          ...(received > 0 ? { headers: { Range: `bytes=${received}-` } } : {}),
        });
        // asked for the tail of a file we already hold all of
        if (received > 0 && res.status === 416) return;
        if (!res.ok || !res.body) {
          // a 404 is a stale catalog URL, not a flaky line. Retrying one wastes
          // twenty seconds and then reports the timeout instead of the 404.
          const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
          throw Object.assign(new Error(`HTTP ${res.status}`), { noResume: permanent });
        }
        // a host that ignored the Range and started over. Not an error - just
        // bytes the decoder has already seen, so drop them and carry on
        if (received > 0 && res.status !== 206) skip = received;

        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          // A COPY, and it has to stay one. Buffer.from(chunk.buffer, off, len)
          // is a view over memory undici owns and reuses for the next socket
          // read, and this stream is demand-driven: chunks sit queued here and
          // in the decoder's input while the socket keeps going, so an aliasing
          // view gets rewritten underneath them. It surfaced as "Error in
          // bzip2: crc32 do not match" part-way through a large archive that
          // was never corrupt on the server - the old Readable.fromWeb copied,
          // and hand-rolling this loop for Range support lost that quietly.
          let buf = Buffer.from(chunk);
          if (skip > 0) {
            if (buf.length <= skip) {
              skip -= buf.length;
              continue;
            }
            buf = buf.subarray(skip);
            skip = 0;
          }
          received += buf.length;
          fromConsumer = true;
          yield buf;
          fromConsumer = false;
        }
        return;
      } catch (err) {
        // a cancelled download is not a broken one
        if (opts.signal.aborted) throw err;
        // the consumer's own failure, arriving through the yield above. Retrying
        // would re-download a file nothing is reading any more, and announcing
        // it as a lost connection sends the reader at the wrong half.
        if (fromConsumer) throw err;
        if ((err as { noResume?: boolean }).noResume) throw err;
        const detail = String((err as Error).message || err);
        // a failure that arrives after new bytes is a fresh problem, not the
        // same one repeating, and earns the full budget again
        if (received > mark) stuck = 0;
        mark = received;
        stuck += 1;
        if (stuck >= tries || opened >= maxAttempts) {
          const why = stuck >= tries ? `${stuck} attempts with no progress` : `${opened} connections`;
          // tagged, because this carries no errno of its own and the caller
          // classifies by errno - untagged it reads as a corrupt archive,
          // which is the wrong half of the problem to go looking at
          throw Object.assign(new Error(`${detail} (gave up after ${why}, ${received} bytes)`), {
            transport: true,
          });
        }
        opts.onRetry?.(received, detail);
        await sleep(RESUME_WAITS[Math.min(stuck - 1, RESUME_WAITS.length - 1)]);
      }
    }
  }

  return Readable.from(pull(), { objectMode: false });
}

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

  /**
   * In-flight file fetches, keyed by DESTINATION PATH rather than model id.
   * The `active` map below is per model, which is the right shape for a
   * download but the wrong one for the files inside it: two different models
   * legitimately want the same shared VAD, and only this stops them opening two
   * truncating streams on the same path.
   */
  private fetching = new Map<string, Promise<void>>();

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
        // Another model may already be fetching this exact file - every offline
        // model pulls the same shared VAD, and each row has its own DOWNLOAD
        // button. Two truncating streams on one .part is not merely wasteful:
        // the loser's descriptor was opened BEFORE the winner's rename, so it
        // follows the inode and writes a hole into the PUBLISHED file that
        // every offline model then depends on.
        const shared = this.fetching.get(dest);
        if (shared) {
          this.log("info", `model download: ${target.id}/${file.name} is already being fetched, waiting`);
          await shared.catch(() => undefined);
          if (fs.existsSync(dest) && fs.statSync(dest).size === file.size) {
            doneBytes += file.size;
            continue;
          }
          // it failed or was cancelled under us; this model still wants the
          // file, so fall through and fetch it ourselves
        }
        const part = `${dest}.part`;
        this.log("info", `model download: ${target.id}/${file.name} (${Math.round(file.size / 1e6)} MB)`);
        const fetching = (async () => {
          const out = fs.createWriteStream(part);
          // the biggest single file in the catalog is a 652 MB encoder, and a
          // dropped connection anywhere in it used to mean starting over
          const body = resumableBody(file.url, {
            signal: controller.signal,
            onRetry: (at, detail) => {
              const pct = file.size > 0 ? Math.floor((at / file.size) * 100) : 0;
              this.log("warn", `model download: ${target.id}/${file.name} lost the connection at ${pct}% - resuming from byte ${at} (${detail})`);
            },
          });
          body.on("data", tick);
          await pipeline(body, out);
          fs.renameSync(part, dest);
        })();
        this.fetching.set(dest, fetching);
        try {
          await fetching;
        } finally {
          this.fetching.delete(dest);
        }
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
          rmDir(folder);
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
    rmDir(staging);
    fs.mkdirSync(staging, { recursive: true });
    this.log("info", `model download: ${info.id} archive (${Math.round(archive.size / 1e6)} MB)`);

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
    // the catalog's size, not the response's: the body arrives over however
    // many connections it takes now, so there is no single content-length
    const declared = archive.size || 0;
    let received = 0;
    let sourceEnded = false;
    const body = resumableBody(archive.url, {
      signal,
      onRetry: (at, detail) => {
        const pct = declared > 0 ? Math.floor((at / declared) * 100) : 0;
        this.log("warn", `model download: ${info.id} lost the connection at ${pct}% - resuming from byte ${at} (${detail})`);
      },
    });
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
        (err as { transport?: boolean }).transport === true ||
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
    rmDir(folder);
    await publishRetry(() => fs.renameSync(staging, folder));
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
