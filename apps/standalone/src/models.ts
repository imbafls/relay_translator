/**
 * Local STT model store: `<dataDir>/models/<id>/<file>`. Per-file downloads
 * stream to `<file>.part` and rename on completion; archive models unpack
 * into `<id>.part/` and are published with one directory rename. Either way a
 * half-finished model never looks installed. One download at a time per
 * model; offline models also pull the silero VAD the worker needs.
 */
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import * as tar from "tar";
import unbzip2 from "unbzip2-stream";
import {
  LOCAL_VAD,
  LocalModelStatus,
  MIRROR_REPO,
  MIRROR_REV,
  STT_MODELS,
  SttModelFile,
  SttModelInfo,
  fileSources,
  mirrorLabel,
  modelDiskBytes,
  redactLog,
} from "@callout-relay/shared";
import { localModelReady } from "@callout-relay/relay";

/**
 * A file that failed on every source in its chain. Carries each source's
 * failure, so the message - and the archive fallback, which adds its own -
 * can name every mirror that was tried and what each one said.
 */
export class FileFailure extends Error {
  constructor(
    readonly model: SttModelInfo,
    readonly file: SttModelFile,
    readonly failures: SourceFailure[],
    /** bytes of the file kept on disk, which the next DOWNLOAD resumes from */
    readonly received: number,
  ) {
    super(
      `${model.label}: ${file.name} failed on every source - ` +
        (failures.length ? failures.map((f) => `${f.mirror}: ${f.reason}`).join("; ") : "it has no source") +
        `. Got ${mb(received)} of ${mb(file.size)}. ${nextStep(failures, received > 0)}`,
    );
  }
}

/** close a write stream and wait until Windows has the handle back */
async function closeQuietly(out: fs.WriteStream): Promise<void> {
  if (out.closed) return;
  await new Promise<void>((resolve) => {
    out.once("close", () => resolve());
    out.destroy();
  });
}

async function sha256OfFile(file: string): Promise<string> {
  const digest = createHash("sha256");
  await pipeline(fs.createReadStream(file), digest);
  return digest.digest("hex");
}

/**
 * Windows says these when something else still has the file open. A scanner
 * working through a freshly written model is the ordinary cause; none of them
 * mean the operation was wrong, only that it was early.
 */
const LOCKED = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

/**
 * Fresh attempts an archive download gets before it is called failed.
 *
 * Bytes can be mangled in transit, and a bz2 stream that fails to decode is
 * not the only shape of corruption: the pinned SHA-256 catches the rest.
 * Retrying is only safe because every attempt gets a staging folder of its
 * own - on Windows a scanner can hold a failed attempt's files, and its
 * folder then cannot be removed, so reusing it would fail the retry too.
 */
const ARCHIVE_ATTEMPTS = 3;

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
      const wait = waits[attempt];
      if (wait === undefined) {
        throw new Error(
          `the model downloaded but could not be put in place - its files are still open ` +
            `${Math.round(waits.reduce((a, b) => a + b, 0) / 1000)}s after unpacking. ` +
            `An antivirus scanner reading a large model is the usual cause; try again, ` +
            `or exclude the models folder from real-time scanning (${code})`,
        );
      }
      await sleep(wait);
    }
  }
}

/**
 * An error's message plus the errno underneath it. Node's fetch reports every
 * network failure as the same two words, "fetch failed", and keeps the part a
 * person can act on - ECONNRESET, a certificate error, a timeout - in `cause`.
 * That is the line the 2026-10 log shows on every retry, saying nothing.
 */
export function describeError(err: unknown): string {
  const e = err as { message?: string; code?: string; cause?: { code?: string; message?: string } };
  const base = String(e?.message || err);
  const code = e?.cause?.code || e?.code;
  if (code && !base.includes(code)) return `${base} (${code})`;
  if (!code && e?.cause?.message && !base.includes(e.cause.message)) return `${base} (${e.cause.message})`;
  return base;
}

/** what went wrong with one source, in the terms the advice is chosen by */
export type FailureKind = "http" | "transport" | "short" | "size" | "checksum" | "decode" | "disk" | "locked" | "other";

export interface SourceFailure {
  /** `mirrorLabel()` of the source, or `github archive` for the fallback */
  mirror: string;
  kind: FailureKind;
  /** the HTTP status, when the failure was one */
  status?: number;
  reason: string;
}

function classify(err: unknown): { kind: FailureKind; status?: number } {
  const e = err as { status?: number; transport?: boolean; code?: string; kind?: FailureKind };
  if (e?.kind) return { kind: e.kind, status: e.status };
  if (typeof e?.status === "number") return { kind: "http", status: e.status };
  if (e?.code === "ENOSPC") return { kind: "disk" };
  if (e?.code && LOCKED.has(e.code)) return { kind: "locked" };
  if (e?.transport) return { kind: "transport" };
  return { kind: "other" };
}

const mb = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${n} B`);

/**
 * The one sentence a person needs after a failed download: what to do next.
 * Chosen by the most specific failure seen, because the last one is often the
 * least informative - a mirror that 404s after another that corrupted the bytes.
 */
export function nextStep(failures: SourceFailure[], resumable: boolean): string {
  const has = (k: FailureKind): SourceFailure | undefined => failures.find((f) => f.kind === k);
  if (has("disk")) return "Free up space on this drive, then press DOWNLOAD again.";
  if (has("locked")) {
    return "Another program is holding the model files - usually an antivirus scan. Wait a minute and press DOWNLOAD again, or exclude the models folder from real-time scanning.";
  }
  if (has("checksum") || has("decode") || has("size")) {
    return "The bytes that arrived were not the published file. Security software that inspects HTTPS downloads is the usual cause: pause it and press DOWNLOAD again, or use COPY DIAGNOSTICS and send the report.";
  }
  const http = has("http");
  if (http?.status === 401 || http?.status === 403 || http?.status === 407) {
    return "Something between this PC and the download refused it - a proxy, firewall or network filter. Try another network, or use COPY DIAGNOSTICS and send the report.";
  }
  if (has("transport") || has("short")) {
    return resumable
      ? "The connection kept dropping. Check the network (or a VPN, proxy or antivirus that scans HTTPS) and press DOWNLOAD again - it carries on from where it stopped."
      : "The connection kept dropping. Check the network (or a VPN, proxy or antivirus that scans HTTPS) and press DOWNLOAD again.";
  }
  if (http) return "The download server answered with an error. Try again later; if it persists, use COPY DIAGNOSTICS and send the report.";
  return "Use COPY DIAGNOSTICS and send the report.";
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
  /**
   * bytes of the file already on disk. The first request then asks for the
   * rest, which is what lets a `.part` left by a closed app, or by a mirror
   * that broke, carry on instead of starting again
   */
  start?: number;
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
const RESUME_WAITS = [400, 900, 1800, 3500] as const;

export function resumableBody(url: string, opts: ResumeOpts): Readable {
  const call = opts.fetchImpl ?? fetch;
  const tries = opts.tries ?? RESUME_WAITS.length + 1;
  const maxAttempts = opts.maxAttempts ?? 30;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function* pull(): AsyncGenerator<Buffer> {
    let received = opts.start ?? 0;
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
          throw Object.assign(new Error(`HTTP ${res.status}`), { noResume: permanent, status: res.status, received });
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
        const detail = describeError(err);
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
            received,
          });
        }
        opts.onRetry?.(received, detail);
        // clamped into the array; the fallback is the first step of the backoff
        // rather than a number invented for the compiler
        await sleep(RESUME_WAITS[Math.min(stuck - 1, RESUME_WAITS.length - 1)] ?? RESUME_WAITS[0]);
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
    /** narrow test seam for the Windows scanner-lock result of archive cleanup */
    private readonly removeArchiveDir: (dir: string) => void = rmDir,
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

  /**
   * Every staging folder an archive download may have left behind for `id`.
   *
   * Attempts are numbered rather than reused, so naming `<id>.part` alone
   * finds only the first: a folder still held when its own attempt tried to
   * clean it up - the exact Windows lock the numbering exists for - is only
   * ever found by looking for the prefix.
   */
  private stagingFor(id: string): string[] {
    const prefix = `${id}.part`;
    try {
      return fs
        .readdirSync(this.dir)
        .filter((name) => name === prefix || name.startsWith(`${prefix}-`))
        .map((name) => path.join(this.dir, name));
    } catch {
      // the model dir need not exist yet; there is then nothing to sweep
      return [];
    }
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

    // the catalogue's own entry when it carries one, so a caller that stands the
    // VAD in for a test describes it the same way it describes every other model
    // - including its digest, which is now checked
    // An injected catalogue may describe the VAD itself, and one that describes
    // it WITHOUT files cannot describe a download - planning zero files there
    // would leave `localVadReady` false for ever with nothing to explain it. The
    // shipped entry stands in for that case. The `!` this replaces hid it: the
    // possibility is real here, because the catalogue is injectable.
    const listed = this.catalogue.find((m) => m.id === LOCAL_VAD.id);
    const vad = listed?.files?.length ? { ...listed, files: listed.files } : LOCAL_VAD;
    // An archive model goes file by file whenever every file it unpacks to has
    // a source of its own - which is what the project mirror gives it. The
    // archive is then the fallback, not the route: the 2026-10 log is a PC on
    // which every archive failed in the bz2 decoder while plain files installed
    // (docs/LOG-REVIEW-2026-10.md).
    const perFile = !info.archive || info.files.every((f) => fileSources(f).length > 0);
    type Step = { info: SttModelInfo; file: SttModelFile };
    const plan: Step[] = [];
    // the shared VAD first: an archive fallback needs it as much as the files do
    if (info.kind === "offline") for (const f of vad.files) plan.push({ info: vad, file: f });
    if (perFile) for (const f of info.files) plan.push({ info, file: f });
    let total = plan.reduce((n, p) => n + p.file.size, 0) + (perFile ? 0 : info.archive?.size || 0);
    let doneBytes = 0;
    let lastTick = 0;
    // set once the archive starts unpacking: only then may cleanup delete the
    // model folder. An offline archive model also pulls the shared VAD first,
    // and a failure there must not wipe an install this run never touched.
    let unpacked = false;
    const credit = (n: number): void => {
      doneBytes += n;
      const now = Date.now();
      if (now - lastTick > 250) {
        lastTick = now;
        run.progress = Math.min(99, Math.floor((doneBytes / Math.max(1, total)) * 100));
        this.onChange();
      }
    };
    const tick = (chunk: Buffer): void => credit(chunk.length);

    try {
      // An archive downloads far less than it installs - whisper turbo fetches
      // 564 MB and leaves 1037 MB - so the download size is no guide to whether
      // it will fit. Running out part way through means a long wait, a failure
      // deep in the extract, and a disk that is now full as well.
      const needed = modelDiskBytes(info);
      const free = this.freeBytes(this.dir);
      if (free >= 0 && free < needed) {
        throw new Error(
          `${info.label}: needs ${Math.round(needed / 1e6)} MB free once unpacked and this drive has ` +
            `${Math.round(free / 1e6)} MB. Free up space on this drive, then press DOWNLOAD again.`,
        );
      }
      let fileFailure: FileFailure | undefined;
      for (const { info: target, file } of plan) {
        try {
          await this.fetchFile(target, file, controller.signal, tick, credit);
        } catch (err) {
          // a model file that failed on every mirror still has the archive
          if (controller.signal.aborted || target !== info || !info.archive || !(err instanceof FileFailure)) throw err;
          fileFailure = err;
          break;
        }
      }
      // after a clean per-file run every file is in place; asking isReady()
      // would also be right for the shipped catalogue, but it judges by that
      // catalogue, not this store's
      if (info.archive && (!perFile || fileFailure) && !this.isReady(id)) {
        if (fileFailure) {
          this.log("warn", `model download: ${id} - ${fileFailure.file.name} failed on every mirror, falling back to the GitHub archive`);
          total = doneBytes + info.archive.size;
        }
        unpacked = true;
        try {
          await this.fetchArchive(info, controller.signal, tick);
        } catch (err) {
          if (controller.signal.aborted) throw err;
          const { kind, status } = classify(err);
          const failures: SourceFailure[] = [
            ...(fileFailure?.failures ?? []),
            { mirror: "github archive", kind, status, reason: describeError(err) },
          ];
          const got = (err as { received?: number }).received ?? 0;
          throw new Error(
            `${info.label}: ${fileFailure ? `${fileFailure.file.name} and the archive` : "the archive"} failed on every source - ` +
              `${failures.map((f) => `${f.mirror}: ${f.reason}`).join("; ")}. ` +
              `Got ${mb(got)} of ${mb(info.archive.size)} from the archive. ${nextStep(failures, false)}`,
          );
        }
      }
      run.progress = 100;
      this.log("info", `model ready: ${id}`);
    } catch (err) {
      const message = controller.signal.aborted ? "cancelled" : String((err as Error).message || err);
      this.errors.set(id, message);
      this.log("error", `model download failed: ${id} - ${message}`);
      // a half-unpacked archive must never look like a model on the next launch
      const stale = info.archive ? this.stagingFor(id) : [];
      // only an archive-only install: after a per-file attempt the folder holds
      // .part files the next DOWNLOAD resumes from
      if (unpacked && !perFile) stale.push(path.join(this.dir, id));
      for (const folder of stale) {
        try {
          this.removeArchiveDir(folder);
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
   * One file into `<dir>/<model>/<name>`, from whichever source in its chain
   * delivers it, sharing an in-flight fetch of the same path.
   */
  private async fetchFile(
    target: SttModelInfo,
    file: SttModelFile,
    signal: AbortSignal,
    tick: (chunk: Buffer) => void,
    credit: (n: number) => void,
  ): Promise<void> {
    const folder = path.join(this.dir, target.id);
    fs.mkdirSync(folder, { recursive: true });
    const dest = path.join(folder, file.name);
    if (fs.existsSync(dest) && fs.statSync(dest).size === file.size) {
      credit(file.size);
      return;
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
        credit(file.size);
        return;
      }
      // it failed or was cancelled under us; this model still wants the
      // file, so fall through and fetch it ourselves
    }
    const fetching = this.fetchFromSources(target, file, dest, signal, tick, credit);
    this.fetching.set(dest, fetching);
    try {
      await fetching;
    } finally {
      this.fetching.delete(dest);
    }
  }

  /**
   * Walk the file's mirror chain. Every source serves the same bytes - the
   * catalogue's size and SHA-256 hold for all of them - so a `.part` one source
   * left behind is continued by the next, and by the next launch of the app.
   * A source that delivers the wrong bytes has them deleted before the next
   * one starts.
   */
  private async fetchFromSources(
    target: SttModelInfo,
    file: SttModelFile,
    dest: string,
    signal: AbortSignal,
    tick: (chunk: Buffer) => void,
    credit: (n: number) => void,
  ): Promise<void> {
    const sources = fileSources(file);
    const part = `${dest}.part`;
    const failures: SourceFailure[] = [];
    let counted = 0;
    for (const [i, url] of sources.entries()) {
      const mirror = mirrorLabel(url);
      let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
      if (have > file.size) {
        fs.rmSync(part, { force: true });
        have = 0;
      }
      // bytes already on disk count towards progress, once
      if (have > counted) credit(have - counted);
      counted = have;
      this.log(
        "info",
        `model download: ${target.id}/${file.name} (${mb(file.size)}) from ${mirror}` +
          (have > 0 ? `, resuming at ${mb(have)}` : ""),
      );
      try {
        await this.fetchFrom(url, part, have, target, file, signal, (chunk) => {
          counted += chunk.length;
          tick(chunk);
        });
        fs.renameSync(part, dest);
        this.log("info", `model download: ${target.id}/${file.name} served by ${mirror}`);
        return;
      } catch (err) {
        if (signal.aborted) throw err;
        const { kind, status } = classify(err);
        failures.push({ mirror, kind, status, reason: describeError(err) });
        const more = i < sources.length - 1 && kind !== "disk";
        this.log(
          "warn",
          `model download: ${target.id}/${file.name} failed on ${mirror} - ${describeError(err)}` +
            (more ? " - trying the next mirror" : ""),
        );
        if (!more) break;
      }
    }
    const received = fs.existsSync(part) ? fs.statSync(part).size : 0;
    throw new FileFailure(target, file, failures, received);
  }

  /** one source, into `part`, starting from the `have` bytes already there */
  private async fetchFrom(
    url: string,
    part: string,
    have: number,
    target: SttModelInfo,
    file: SttModelFile,
    signal: AbortSignal,
    onChunk: (chunk: Buffer) => void,
  ): Promise<void> {
    if (have < file.size) {
      const out = fs.createWriteStream(part, { flags: have > 0 ? "a" : "w" });
      // the biggest single file in the catalog is a 675 MB encoder, and a
      // dropped connection anywhere in it used to mean starting over
      const body = resumableBody(url, {
        signal,
        start: have,
        onRetry: (at, detail) => {
          const pct = file.size > 0 ? Math.floor((at / file.size) * 100) : 0;
          this.log("warn", `model download: ${target.id}/${file.name} lost the connection at ${pct}% - resuming from byte ${at} (${detail})`);
        },
      });
      body.on("data", onChunk);
      // pipeline closes `out` however this ends, so a failed source never
      // leaves the .part held open for the next one, or for the cleanup
      await pipeline(body, out);
    }
    // A body that ends cleanly but short raises nothing for resumableBody to
    // catch. Short bytes are kept: they are a prefix of the right file, and the
    // next source or the next DOWNLOAD carries on from them. Long ones are not.
    const got = fs.statSync(part).size;
    if (got !== file.size) {
      if (got > file.size) fs.rmSync(part, { force: true });
      throw Object.assign(
        new Error(`${target.id}/${file.name} arrived as ${got} B, the catalogue declares ${file.size} B`),
        { kind: got > file.size ? "size" : "short" },
      );
    }
    // Hashed from disk rather than from the stream, because the bytes may have
    // come from several sources over several launches of the app.
    if (file.sha256) {
      const actual = await sha256OfFile(part);
      if (actual !== file.sha256) {
        fs.rmSync(part, { force: true });
        throw Object.assign(
          new Error(
            `${target.id}/${file.name} is not the file the catalogue describes: expected SHA-256 ${file.sha256}, got ${actual}`,
          ),
          { kind: "checksum" },
        );
      }
    }
  }

  /**
   * Fetch a tar.bz2 model and unpack only the entries it declares, under the
   * plain names the worker looks for. The archive itself never touches disk.
   *
   * Everything lands in a staging folder first. `localModelReady()` decides
   * by filename alone, so extracting straight into `<dir>/<id>/` would report
   * the model ready the moment the last file was opened - before its bytes
   * were written - and a crash mid-extract would leave that half-written file
   * looking installed for good. The staging folder is published with a single
   * directory rename once every entry is present and non-empty.
   *
   * A failed attempt is retried in a staging folder of its own, never the one
   * it failed in: on Windows a scanner holding the failed attempt's files
   * keeps that folder from being removed, and a leftover held by an earlier
   * run must not stop the download before it starts.
   */
  private async fetchArchive(info: SttModelInfo, signal: AbortSignal, tick: (chunk: Buffer) => void): Promise<void> {
    const folder = path.join(this.dir, info.id);
    let lastErr: unknown = new Error(`the archive for ${info.id} could not be fetched`);
    // folders are numbered rather than reused: `.part` first, `.part-2` next
    let named = 0;
    for (let attempt = 1; attempt <= ARCHIVE_ATTEMPTS; attempt++) {
      let staging: string | undefined;
      while (!staging) {
        named += 1;
        if (named > ARCHIVE_ATTEMPTS + 2) throw lastErr;
        const candidate = named === 1 ? `${folder}.part` : `${folder}.part-${named}`;
        try {
          this.removeArchiveDir(candidate);
          staging = candidate;
        } catch (err) {
          lastErr = err;
          this.log("warn", `could not clean up ${candidate}: ${String((err as Error).message || err)}`);
        }
      }
      try {
        await this.fetchArchiveOnce(info, staging, signal, tick);
        return;
      } catch (err) {
        lastErr = err;
        try {
          this.removeArchiveDir(staging);
        } catch (rmErr) {
          this.log("warn", `could not clean up ${staging}: ${String((rmErr as Error).message || rmErr)}`);
        }
        if (signal.aborted || !(err as { retryArchive?: boolean }).retryArchive || attempt === ARCHIVE_ATTEMPTS) {
          throw err;
        }
        this.log(
          "warn",
          `model download: ${info.id} archive attempt ${attempt} failed (${String((err as Error).message || err)}) - trying a fresh copy`,
        );
      }
    }
  }

  /** one fresh download, unpack and publish of the archive into `staging` */
  private async fetchArchiveOnce(
    info: SttModelInfo,
    staging: string,
    signal: AbortSignal,
    tick: (chunk: Buffer) => void,
  ): Promise<void> {
    const archive = info.archive!;
    const folder = path.join(this.dir, info.id);
    fs.mkdirSync(staging, { recursive: true });
    this.log("info", `model download: ${info.id} archive (${Math.round(archive.size / 1e6)} MB) from github`);

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
    // the digest covers the COMPRESSED bytes, exactly as the body delivered
    // them, and is the one check a stream that decodes cannot talk its way past
    const checksum = createHash("sha256");
    const body = resumableBody(archive.url, {
      signal,
      onRetry: (at, detail) => {
        const pct = declared > 0 ? Math.floor((at / declared) * 100) : 0;
        this.log("warn", `model download: ${info.id} lost the connection at ${pct}% - resuming from byte ${at} (${detail})`);
      },
    });
    body.on("data", (chunk: Buffer) => {
      received += chunk.length;
      checksum.update(chunk);
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

    // The files being written are opened HERE, not inside tar, so that a
    // failure can close them. `tar.x` kept the entry it was writing open when
    // the pipeline was torn down: under Electron 33's Node 20 the handle stayed
    // until the app exited, so every cleanup waited out its 31 s of retries on
    // ENOTEMPTY and then failed on `EPERM ... lstat` - the exact pair the
    // 2026-10 log ends every failure with, reproduced here with a corrupted
    // archive in Electron (docs/LOG-REVIEW-2026-10.md).
    const writers: fs.WriteStream[] = [];
    const written: Promise<void>[] = [];
    const parser = new tar.Parser({
      strict: true,
      onReadEntry: (entry) => {
        const local = entry.type === "File" ? wanted.get(path.posix.basename(entry.path)) : undefined;
        if (!local) {
          entry.resume();
          return;
        }
        const out = fs.createWriteStream(path.join(staging, local));
        writers.push(out);
        const done = new Promise<void>((resolve, reject) => {
          out.on("finish", resolve);
          out.on("error", reject);
        });
        // observed below, or abandoned with the attempt; never unhandled
        done.catch(() => undefined);
        written.push(done);
        // a write that fails (a full disk, a lock) fails the whole attempt
        // rather than leaving a truncated ONNX to sail through
        out.on("error", (err) => body.destroy(err));
        entry.pipe(out);
      },
    });
    try {
      await pipeline(body, unbzip2(), parser as unknown as NodeJS.WritableStream);
      await Promise.all(written);
    } catch (err) {
      await Promise.all(writers.map(closeQuietly));
      const detail = describeError(err);
      const status = (err as { status?: number }).status;
      if (typeof status === "number") {
        // a 4xx is the catalogue's problem and will not change on a retry
        throw Object.assign(new Error(`HTTP ${status}`), {
          kind: "http",
          status,
          received,
          retryArchive: status >= 500 || status === 408 || status === 429,
        });
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOSPC" || (code && LOCKED.has(code))) {
        throw Object.assign(new Error(`could not write the model (${detail})`), { code, received });
      }
      // Two signals, neither of which is "how many bytes did we pull":
      //  - the error is a stream/socket failure, i.e. the transport broke;
      //  - or the source ENDED and still delivered less than it announced,
      //    which is a server that closed short cleanly and raises nothing.
      // A decoder error on a body that never ended is the archive, whatever
      // the byte count says - and that is the case this was getting wrong.
      const transportish =
        (err as { transport?: boolean }).transport === true ||
        code === "ERR_STREAM_PREMATURE_CLOSE" ||
        code === "ECONNRESET" ||
        code === "ETIMEDOUT" ||
        code === "UND_ERR_SOCKET";
      const endedShort = sourceEnded && declared > 0 && received < declared;
      if (transportish || endedShort) {
        const pct = declared > 0 ? Math.floor((received / declared) * 100) : 100;
        throw Object.assign(
          new Error(`the download stopped early: ${received} of ${declared} bytes (${pct}%) - ${detail}`),
          { kind: "transport", received },
        );
      }
      // a fresh attempt can still be the pinned archive; the digest decides,
      // but only after the stream finishes, so this one is worth retrying
      throw Object.assign(new Error(`the archive would not unpack (${received} bytes read) - ${detail}`), {
        retryArchive: true,
        kind: "decode",
        received,
      });
    }

    // The pinned digest is checked before anything the attempt unpacked is
    // believed: a bz2 stream can decode and still be the wrong bytes, and those
    // bytes must never reach the entry checks or the publish. A mismatch is
    // retryable - the download, not the catalogue, is what a fresh attempt
    // changes - while an entry that is missing after a matched digest is the
    // catalogue's fault and is not.
    const actual = checksum.digest("hex");
    if (actual !== archive.sha256) {
      throw Object.assign(
        new Error(`archive checksum mismatch: expected SHA-256 ${archive.sha256}, got ${actual}`),
        { retryArchive: true, kind: "checksum", received },
      );
    }

    // the catalog carries the exact unpacked size of every entry. A short file
    // is the shape a swallowed write error takes, so it fails the download; a
    // long one only means the catalog drifted, which is not the worker's problem
    const expect = new Map((info.files || []).map((f) => [f.name, f.size]));
    for (const [entry, local] of wanted) {
      const at = path.join(staging, local);
      if (!fs.existsSync(at)) throw new Error(`archive is missing ${entry}`);
      const size = fs.statSync(at).size;
      const want = expect.get(local);
      if (want != null ? size < want : size === 0) {
        throw new Error(`archive entry ${entry} is ${size} B, expected ${want ?? "non-empty"}`);
      }
      if (want != null && size !== want) this.log("warn", `${info.id}/${local} is ${size} B, catalog says ${want}`);
    }
    // only now may the model be seen: one rename, after every file is whole.
    // Windows hands out EPERM/EBUSY when a scanner is still holding a new file,
    // so the publish gets the same few retries the removals get.
    this.removeArchiveDir(folder);
    await publishRetry(() => fs.renameSync(staging, folder));
    this.log("info", `model download: ${info.id} served by github archive`);
  }

  /**
   * COPY DIAGNOSTICS on the model screen: everything a download report needs,
   * in one paste. B6 stayed open for weeks because the one useful line was in a
   * file nobody could find; this puts it, and what surrounds it, on the
   * clipboard. Redacted with the same `redactLog` SEND FEEDBACK uses, so a key
   * in a URL or a user name in a path never leaves with it.
   */
  diagnostics(about: { appVersion: string; runtime: string; logText: string }): string {
    const free = this.freeBytes(this.dir);
    const lines = [
      `Callout Relay ${about.appVersion} - ${about.runtime}`,
      `models folder: ${this.dir} (${free >= 0 ? `${mb(free)} free` : "free space unknown"})`,
      `mirror: ${MIRROR_REV ? `hf:${MIRROR_REPO} @ ${MIRROR_REV}` : "not published yet - archive models come from GitHub"}`,
      "",
    ];
    for (const s of this.status()) {
      const info = this.catalogue.find((m) => m.id === s.id)!;
      const state = s.downloaded ? "ready" : s.progress != null ? `downloading ${s.progress}%` : s.error ? "failed" : "not downloaded";
      lines.push(`${s.id}: ${state}`);
      if (s.error) lines.push(`  error: ${s.error}`);
      const chain = [...new Set((info.files ?? []).flatMap((f) => fileSources(f).map(mirrorLabel)))];
      lines.push(`  sources: ${[...chain, ...(info.archive ? ["github archive"] : [])].join(" > ") || "none"}`);
      // what a failed or interrupted run left behind is often the clearest
      // evidence of where it stopped
      const leftovers: string[] = [];
      for (const staged of this.stagingFor(s.id)) leftovers.push(`${path.basename(staged)}/`);
      try {
        for (const name of fs.readdirSync(path.join(this.dir, s.id))) {
          if (name.endsWith(".part")) leftovers.push(`${name} ${mb(fs.statSync(path.join(this.dir, s.id, name)).size)}`);
        }
      } catch {
        /* no folder yet */
      }
      if (leftovers.length) lines.push(`  on disk: ${leftovers.join(", ")}`);
    }
    const recent = about.logText
      .split(/\r?\n/)
      .filter((l) => /model (download|ready|remove)|could not clean up/.test(l))
      .slice(-60);
    lines.push("", `last ${recent.length} model log lines:`, ...recent);
    return redactLog(lines.join("\n"));
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
    for (const staging of this.stagingFor(id)) {
      try {
        fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
      } catch (err) {
        this.log("warn", `could not remove staging for ${id} - ${String(err)}`);
      }
    }
    this.onChange();
  }
}
