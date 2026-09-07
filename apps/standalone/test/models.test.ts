import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SttModelInfo } from "@callout-relay/shared";
import * as http from "node:http";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ModelStore, publishRetry, resumableBody } from "../src/models";

/**
 * The real ModelStore runs here: its download plan, the staging folder, the
 * bz2 and tar pipeline, the size gate and the cleanup all execute for real
 * against a real archive on a real disk. Only the transport is stood in for,
 * because the catalogue's URLs point at Hugging Face and the real archives are
 * hundreds of megabytes.
 *
 * FIXTURE is a genuine tar.bz2 holding three entries under one top-level
 * folder, which is the layout `strip: 1` expects:
 *   pkg/src-encoder.onnx  64 B
 *   pkg/src-tokens.txt    32 B
 *   pkg/unwanted.bin     128 B   (not declared, must not be extracted)
 */
const FIXTURE = Buffer.from(
  "QlpoOTFBWSZTWZjC1b8AALv/qs6AAARAA/8EAgVEQH6p3sQAIAACAAIICCAAkgyoZRtNTRkGahkyYRjRkG1IobQmhkYgaNGQaGhh4umPww1MrgR7ggQqaG8lRMiQ1DEQITJHFx0XWGHYqIJSsklA36HoDlbbmAyz7nRDJ3N75D7QV2BKjaA+E+DCLjEdbDdSLf+icNK4DmlpbHFA3Vd/Lns58ZV+CnBZcgo7L4PKBKxhBA3F3JFOFCQmMLVvwA==",
  "base64",
);

const ARCHIVE_URL = "https://models.invalid/pkg.tar.bz2";

/** a streaming model, so the plan does not also pull the shared silero VAD */
function model(over: Partial<SttModelInfo> = {}): SttModelInfo {
  return {
    id: "test-archive-model",
    label: "Test Archive Model",
    provider: "local",
    kind: "streaming",
    engine: "zipformer-online",
    sizeMb: 1,
    tier: "light",
    files: [
      { name: "encoder.onnx", url: "", size: 64 },
      { name: "tokens.txt", url: "", size: 32 },
    ],
    archive: {
      url: ARCHIVE_URL,
      size: FIXTURE.length,
      pick: { "encoder.onnx": "src-encoder.onnx", "tokens.txt": "src-tokens.txt" },
    },
    ...over,
  };
}

let dir: string;
let logs: { level: string; message: string }[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-store-"));
  logs = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
});

/**
 * Answer the archive URL with `body`, announcing `declared` bytes.
 *
 * Chunked, because a real HTTP body is. Serving the whole thing in one
 * `enqueue` meant every byte reached the counter before the decoder could
 * fail, so `received === declared` always - which made the test below
 * ("blames the archive only when every announced byte did arrive") pass
 * whatever the code did. `chunk` is what lets a decode failure happen with
 * bytes still unread, which is the entire case finding 26 is about.
 */
function serve(body: Buffer, opts: { status?: number; declared?: number; chunk?: number } = {}): void {
  globalThis.fetch = (async () => {
    const status = opts.status ?? 200;
    if (status !== 200) return new Response("nope", { status });
    const size = opts.chunk ?? 16;
    const stream = new ReadableStream({
      start(c) {
        for (let at = 0; at < body.length; at += size) {
          c.enqueue(new Uint8Array(body.subarray(at, Math.min(at + size, body.length))));
        }
        c.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-length": String(opts.declared ?? body.length) },
    });
  }) as typeof fetch;
}

function store(info: SttModelInfo = model(), freeBytes?: (dir: string) => number): ModelStore {
  return new ModelStore(
    dir,
    () => {},
    (level, message) => logs.push({ level, message }),
    [info],
    freeBytes,
  );
}

const failure = (): string => logs.find((l) => l.level === "error")?.message ?? "";
const modelDir = (): string => path.join(dir, "test-archive-model");

describe("unpacking an archive model", () => {
  it("extracts the declared entries under the names the worker looks for", async () => {
    serve(FIXTURE);
    await store().download("test-archive-model");

    expect(failure()).toBe("");
    expect(fs.readFileSync(path.join(modelDir(), "encoder.onnx")).length).toBe(64);
    expect(fs.readFileSync(path.join(modelDir(), "tokens.txt")).length).toBe(32);
  });

  it("leaves behind everything the archive holds that the catalogue does not name", async () => {
    serve(FIXTURE);
    await store().download("test-archive-model");
    expect(fs.readdirSync(modelDir()).sort()).toEqual(["encoder.onnx", "tokens.txt"]);
  });

  it("publishes with one rename, leaving no staging folder", async () => {
    serve(FIXTURE);
    await store().download("test-archive-model");
    expect(fs.existsSync(`${modelDir()}.part`)).toBe(false);
  });
});

describe("checking there is room before starting", () => {
  it("refuses when the drive cannot hold the unpacked model", async () => {
    serve(FIXTURE);
    // 96 bytes unpack out of a 190-byte archive; offer 50
    await store(model(), () => 50).download("test-archive-model");

    expect(failure()).toMatch(/needs 0 MB free once unpacked and this drive has 0 MB/);
    // and it did not download anything first
    expect(fs.existsSync(modelDir())).toBe(false);
  });

  it("names both numbers so the message is actionable", async () => {
    serve(FIXTURE);
    const big = model({ files: [{ name: "encoder.onnx", url: "", size: 2_000_000_000 }] });
    await store(big, () => 500_000_000).download("test-archive-model");

    expect(failure()).toMatch(/needs 2000 MB free/);
    expect(failure()).toMatch(/drive has 500 MB/);
  });

  it("goes ahead when there is room", async () => {
    serve(FIXTURE);
    await store(model(), () => 10_000_000_000).download("test-archive-model");

    expect(failure()).toBe("");
    expect(fs.readFileSync(path.join(modelDir(), "encoder.onnx")).length).toBe(64);
  });

  it("goes ahead when the platform will not say how much is free", async () => {
    serve(FIXTURE);
    // statfs is not available everywhere; an unknown answer must not block
    await store(model(), () => -1).download("test-archive-model");

    expect(failure()).toBe("");
    expect(fs.existsSync(modelDir())).toBe(true);
  });
});

describe("a download that stops early", () => {
  it("says how far it got instead of blaming the archive", async () => {
    // the shape of the open bug: the stream ends part way and bz2 reports a
    // crc mismatch, which reads as a corrupt file rather than a short one
    serve(FIXTURE.subarray(0, 120), { declared: FIXTURE.length });
    await store().download("test-archive-model");

    expect(failure()).toMatch(/stopped early/);
    expect(failure()).toMatch(/120 of 190 bytes \(63%\)/);
  });

  it("does not leave a half-model that looks installed", async () => {
    serve(FIXTURE.subarray(0, 120), { declared: FIXTURE.length });
    await store().download("test-archive-model");

    expect(fs.existsSync(modelDir())).toBe(false);
    expect(fs.existsSync(`${modelDir()}.part`)).toBe(false);
  });

  it("blames the archive when the bytes were fine and the archive was not", async () => {
    /**
     * Audit finding 26, and the case the previous version of this test could
     * not reach. `received` counts bytes pulled from a DEMAND-DRIVEN body: when
     * the decoder throws part-way, the pipeline destroys the source with most
     * of it still unread, so `received < declared` and the message blames the
     * transport - "the download stopped early: 48 of 190 bytes (25%)" - for an
     * archive that arrived perfectly and simply was not a bz2 stream.
     *
     * That is the message that has been sent people chasing B6.
     */
    // big enough that the pipeline backpressures: with a 190-byte body every
    // byte reaches the counter before the decoder can object, which is exactly
    // why the old single-chunk test could not fail
    const garbage = Buffer.alloc(512 * 1024, 0x41);
    serve(garbage, { chunk: 4096 });
    await store().download("test-archive-model");

    expect(failure(), "a corrupt archive was reported as a broken download").not.toMatch(/stopped early/);
    expect(failure()).toMatch(/would not unpack/);
  });

  it("blames the transport when the body really did stop short", async () => {
    // 120 of an announced 190, ended cleanly - the server actually did stop
    serve(FIXTURE.subarray(0, 120), { declared: FIXTURE.length, chunk: 16 });
    await store().download("test-archive-model");

    expect(failure()).toMatch(/stopped early/);
    expect(failure()).toMatch(/120 of 190/);
  });

  it("blames the transport when the connection kept breaking, not the archive", async () => {
    // Running the shipped code against a proxy that killed the socket once at
    // 40% of the real 118 MB Whisper Tiny archive reported "the archive would
    // not unpack (47241984 bytes read) - terminated". The archive was perfect.
    // The give-up error carries no errno of its own, so unless it says it is a
    // transport failure it falls through to blaming the file - and that is the
    // message that has been sending this bug to the wrong half all along.
    globalThis.fetch = (async () => {
      const stream = new ReadableStream({
        start(c) {
          c.error(new Error("terminated"));
        },
      });
      return new Response(stream, { status: 200, headers: { "content-length": String(FIXTURE.length) } });
    }) as typeof fetch;

    await store().download("test-archive-model");

    expect(failure(), "a connection that kept dropping was called a corrupt archive").not.toMatch(/would not unpack/);
    expect(failure()).toMatch(/stopped early/);
  });

  it("blames the archive only when every announced byte did arrive", async () => {
    // all 190 bytes, but they are not a valid bz2 stream
    const garbage = Buffer.alloc(FIXTURE.length, 0x41);
    serve(garbage);
    await store().download("test-archive-model");

    expect(failure()).toMatch(/would not unpack \(190 bytes read\)/);
    expect(failure()).not.toMatch(/stopped early/);
  });
});

describe("an archive that does not hold what the catalogue promised", () => {
  it("fails when a declared entry is not in it", async () => {
    serve(FIXTURE);
    const info = model({
      files: [
        { name: "encoder.onnx", url: "", size: 64 },
        { name: "missing.onnx", url: "", size: 10 },
      ],
      archive: {
        url: ARCHIVE_URL,
        size: FIXTURE.length,
        pick: { "encoder.onnx": "src-encoder.onnx", "missing.onnx": "src-missing.onnx" },
      },
    });
    await store(info).download("test-archive-model");

    expect(failure()).toMatch(/missing src-missing\.onnx/);
    expect(fs.existsSync(modelDir())).toBe(false);
  });

  it("fails when an entry unpacks shorter than the catalogue says", async () => {
    serve(FIXTURE);
    // claim the encoder is bigger than the 64 B actually in the archive
    const info = model({
      files: [
        { name: "encoder.onnx", url: "", size: 999_999 },
        { name: "tokens.txt", url: "", size: 32 },
      ],
    });
    await store(info).download("test-archive-model");

    expect(failure()).toMatch(/is 64 B, expected 999999/);
    expect(fs.existsSync(modelDir())).toBe(false);
  });

  it("reports an HTTP failure without touching the disk", async () => {
    serve(FIXTURE, { status: 500 });
    await store().download("test-archive-model");

    expect(failure()).toMatch(/HTTP 500/);
    expect(fs.existsSync(modelDir())).toBe(false);
    expect(fs.existsSync(`${modelDir()}.part`)).toBe(false);
  });
});

describe("two models that need the same shared file", () => {
  /**
   * Audit finding 25. The in-flight guard is `if (this.active.has(id)) return;`
   * - per MODEL id - but every `kind: "offline"` model pushes the same shared
   * silero VAD into its plan, writing to the same
   * `local-vad-silero/silero_vad.onnx.part`. Every row has its own DOWNLOAD
   * button and the IPC handler is fire-and-forget, so two clicks inside the
   * second the VAD takes is all it needs.
   *
   * Both open a truncating write stream on that one path. The winner renames
   * it; the loser's renameSync hits ENOENT, that becomes the model's error and
   * the row shows FAILED - and because the throw lands before the archive
   * fetch, that model downloads nothing at all.
   *
   * Worse, and the reason this is not merely untidy: the loser's stream was
   * opened BEFORE the rename, so its file descriptor follows the inode into the
   * published VAD. Writing on after the rename puts a hole inside the file every
   * offline model depends on - which localVadReady's existence-only check then
   * accepts for ever, and which remove() deliberately never deletes.
   */
  const VAD_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";
  const VAD_SIZE = 643854;

  /** an offline model, so its plan also pulls the shared VAD */
  const offline = (id: string): SttModelInfo =>
    model({ id, kind: "offline", engine: "whisper", archive: { url: ARCHIVE_URL, size: FIXTURE.length, pick: { "encoder.onnx": "src-encoder.onnx", "tokens.txt": "src-tokens.txt" } } });

  /** counts hits per URL and answers the VAD slowly enough for a second click */
  function serveShared(opts: { vadDelayMs?: number; failVad?: boolean } = {}): { hits: Map<string, number> } {
    const hits = new Map<string, number>();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      hits.set(url, (hits.get(url) ?? 0) + 1);
      if (url === VAD_URL) {
        if (opts.failVad) return new Response("nope", { status: 500 });
        const body = Buffer.alloc(VAD_SIZE, 7);
        const stream = new ReadableStream({
          async start(c) {
            c.enqueue(new Uint8Array(body.subarray(0, 1024)));
            await new Promise((r) => setTimeout(r, opts.vadDelayMs ?? 60));
            c.enqueue(new Uint8Array(body.subarray(1024)));
            c.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-length": String(VAD_SIZE) } });
      }
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(FIXTURE));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-length": String(FIXTURE.length) } });
    }) as typeof fetch;
    return { hits };
  }

  const twoStore = (): ModelStore =>
    new ModelStore(dir, () => {}, (level, message) => logs.push({ level, message }), [offline("model-a"), offline("model-b")], () => 10e9);

  const vadFile = (): string => path.join(dir, "local-vad-silero", "silero_vad.onnx");

  it("fetches the shared file once, not twice", async () => {
    const { hits } = serveShared();
    const s = twoStore();
    await Promise.all([s.download("model-a"), s.download("model-b")]);

    expect(hits.get(VAD_URL), "both downloads fetched the shared VAD").toBe(1);
  });

  it("lets both models finish, instead of one failing on a file the other took", async () => {
    serveShared();
    const s = twoStore();
    await Promise.all([s.download("model-a"), s.download("model-b")]);

    expect(logs.filter((l) => l.level === "error").map((l) => l.message)).toEqual([]);
    // status().downloaded goes through localModelReady, which looks the id up
    // in the real catalogue - these two are invented, so it can never be true.
    // What actually matters is on disk.
    for (const id of ["model-a", "model-b"]) {
      expect(fs.existsSync(path.join(dir, id, "encoder.onnx")), `${id} did not unpack`).toBe(true);
    }
  });

  it("leaves the shared file whole, with no hole written into it after the rename", async () => {
    serveShared();
    const s = twoStore();
    await Promise.all([s.download("model-a"), s.download("model-b")]);

    const written = fs.readFileSync(vadFile());
    expect(written.length, "the published VAD is the wrong size").toBe(VAD_SIZE);
    expect(written.every((b) => b === 7), "something wrote a hole into the published VAD").toBe(true);
    expect(fs.existsSync(`${vadFile()}.part`), "a .part was left behind").toBe(false);
  });

  it("does not leave a failed shared fetch poisoning the next model", async () => {
    // the follower must not inherit the leader's failure and give up: it has
    // its own reason to want the file
    const { hits } = serveShared({ failVad: true });
    const s = twoStore();
    await Promise.all([s.download("model-a"), s.download("model-b")]);

    expect(hits.get(VAD_URL), "the second model never tried for itself").toBeGreaterThan(1);
  });
});

/**
 * A model is published by renaming its staging folder into place. On Windows a
 * directory cannot be renamed while ANY file inside it is still open by another
 * process - and Defender holds freshly written files while it scans them.
 *
 * The retry budget for that was four attempts, 150/300/450 ms: **900 ms in
 * total**. That is enough for a small model and nowhere near enough for a
 * large one. The evidence lines up exactly: `local-whisper-tiny-en` (99 MB on
 * disk) and `local-zipformer-en` (68 MB) install cleanly on this machine, while
 * `local-nemotron-streaming` (651 MB) and `local-whisper-turbo` (989 MB) are
 * the two the user cannot install - and Defender real-time scanning is on.
 *
 * It also explains the wreckage. When the publish throws, the catch removes the
 * staging folder; Windows deletes the files but cannot remove a directory whose
 * handles are still held, which leaves exactly what was found in the models
 * directory: an EMPTY `.part`. The warning that says so went to a stdout a
 * packaged app does not have.
 *
 * Not reproduced - a real EPERM needs a real scanner holding a real gigabyte.
 * What is tested is the budget, because a 900 ms wait for a scanner working
 * through a gigabyte is wrong whatever finally turns out to be holding it.
 */
describe("publishing a model past a scanner holding its files", () => {
  const eperm = (): NodeJS.ErrnoException => {
    const e = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
    e.code = "EPERM";
    return e;
  };

  /** every wait the helper asked for, without spending it */
  const spyClock = (): { sleep: (ms: number) => Promise<void>; waits: number[] } => {
    const waits: number[] = [];
    return { waits, sleep: async (ms) => void waits.push(ms) };
  };

  it("keeps trying long enough for a scanner to finish with a large model", async () => {
    const clock = spyClock();
    let calls = 0;
    await publishRetry(
      () => {
        calls += 1;
        if (calls < 9) throw eperm();
      },
      clock.sleep,
    );

    expect(calls, "gave up before the file was released").toBe(9);
    const budget = clock.waits.reduce((a, b) => a + b, 0);
    expect(budget, "the whole budget is under ten seconds, which a gigabyte scan outlasts").toBeGreaterThan(10_000);
  });

  it("returns as soon as it works, without spending the budget", async () => {
    const clock = spyClock();
    let calls = 0;
    await publishRetry(() => {
      calls += 1;
    }, clock.sleep);

    expect(calls).toBe(1);
    expect(clock.waits, "waited even though the first attempt worked").toEqual([]);
  });

  it("gives up on an error that waiting cannot fix", async () => {
    // a full disk is not a lock; retrying it for half a minute wastes the
    // user's time and buries the real reason
    const clock = spyClock();
    const enospc = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
    enospc.code = "ENOSPC";
    let calls = 0;

    await expect(
      publishRetry(() => {
        calls += 1;
        throw enospc;
      }, clock.sleep),
    ).rejects.toThrow(/ENOSPC/);
    expect(calls, "retried something retrying cannot fix").toBe(1);
  });

  it("says what is probably holding the files when it finally gives up", async () => {
    const clock = spyClock();
    await expect(
      publishRetry(() => {
        throw eperm();
      }, clock.sleep),
    ).rejects.toThrow(/still open|scanner|antivirus/i);
  });
});

/**
 * A 564 MB archive is streamed straight through bz2 and tar onto disk, so it is
 * never stored twice. That is the right shape - but it had no answer to the
 * connection dropping. One reset at 90% threw the whole download away and
 * started again from zero, and the two largest models take a minute and a half
 * on a good line, which is a lot of exposure.
 *
 * The fix keeps the stream. The source reconnects on a transport failure and
 * asks for `bytes=<received>-`, so the decoder downstream sees one continuous
 * byte stream and never learns that the socket underneath it changed. GitHub's
 * asset host answers 206 with a Content-Range, which is what makes it possible.
 *
 * Parallel chunks were considered and not built: chunks arrive out of order, so
 * the whole archive would have to land on disk before decoding could start,
 * taking peak usage from 989 MB to 1.55 GB for Whisper Turbo, and adding that
 * complexity to the one path already suspected of failing.
 */
describe("a download that survives the connection dropping", () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  /** serves `payload`, cutting the socket after `cutAfter` bytes, `drops` times */
  const flakyHost = async (payload: Buffer, cutAfter: number, drops: number): Promise<string> => {
    let dropped = 0;
    server = http.createServer((req, res) => {
      const range = /bytes=(\d+)-/.exec(req.headers.range || "");
      const from = range ? Number(range[1]) : 0;
      const slice = payload.subarray(from);
      res.writeHead(from > 0 ? 206 : 200, {
        "Content-Length": String(slice.length),
        "Accept-Ranges": "bytes",
        ...(from > 0 ? { "Content-Range": `bytes ${from}-${payload.length - 1}/${payload.length}` } : {}),
      });
      if (dropped < drops) {
        dropped += 1;
        // the bytes have to REACH the client before the socket dies, or it
        // retries from zero and the resume this is testing never happens
        res.write(slice.subarray(0, cutAfter), () => {
          setTimeout(() => res.socket?.destroy(), 25);
        });
        return;
      }
      res.end(slice);
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    return `http://127.0.0.1:${(server!.address() as { port: number }).port}/archive`;
  };

  const drain = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
    const parts: Buffer[] = [];
    for await (const c of stream) parts.push(c as Buffer);
    return Buffer.concat(parts);
  };

  it("does not report the consumer's own error as a lost connection", async () => {
    /**
     * `yield` sits inside the try, so when `pipeline` destroys this source with
     * the DECODER's error, that error lands in the transport catch and gets
     * announced as a dropped connection. The real log read:
     *
     *   lost the connection at 44% - resuming from byte 52361323
     *     (Error in bzip2: crc32 do not match)
     *
     * A bz2 CRC mismatch is not a dropped connection, and saying so sends
     * whoever reads it at the wrong half of the problem - which is exactly what
     * it did. An error arriving while suspended at `yield` came from the
     * consumer, and there is nothing about the transport to retry.
     */
    const retries: string[] = [];
    const payload = Buffer.alloc(64 * 1024, 7);
    const SIZE = 4096;
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      body: (async function* () {
        for (let off = 0; off < payload.length; off += SIZE) {
          yield new Uint8Array(payload.subarray(off, off + SIZE));
        }
      })(),
    })) as unknown as typeof fetch;

    const body = resumableBody("http://example.invalid/consumer", {
      signal: new AbortController().signal,
      fetchImpl,
      onRetry: (_at, detail) => retries.push(detail),
    });

    const boom = new Transform({
      transform(_c, _e, cb) {
        cb(new Error("Error in bzip2: crc32 do not match"));
      },
    });

    await expect(pipeline(body, boom)).rejects.toThrow(/crc32/);
    expect(retries, "the decoder's error was announced as a dropped connection").toEqual([]);
  });

  it("copies each chunk out of memory the fetch implementation may reuse", async () => {
    /**
     * undici hands back Uint8Arrays that are views over buffers it is free to
     * reuse for the next socket read. The archive pipeline is demand-driven, so
     * chunks sit queued in this stream and in the decoder's input while the
     * socket keeps going - and a view that ALIASES that memory is rewritten
     * underneath them.
     *
     * It surfaces a long way from here, as "Error in bzip2: crc32 do not match"
     * on an archive that was never corrupt on the server, part-way through a
     * download big enough for the reuse to catch up with the queue. Small models
     * finish first and look fine.
     *
     * The stand-in reuses ONE buffer for every chunk, which is the worst case a
     * pooling implementation can present and is exactly what the real bug is.
     */
    const payload = Buffer.alloc(64 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;

    const SIZE = 4096;
    const pool = new ArrayBuffer(SIZE);
    const scratch = new Uint8Array(pool);
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      body: (async function* () {
        for (let off = 0; off < payload.length; off += SIZE) {
          const part = payload.subarray(off, off + SIZE);
          scratch.set(part);
          yield new Uint8Array(pool, 0, part.length);
        }
      })(),
    })) as unknown as typeof fetch;

    const got = await drain(
      resumableBody("http://example.invalid/pooled", {
        signal: new AbortController().signal,
        fetchImpl,
      }),
    );

    expect(got.length, "the wrong number of bytes came out").toBe(payload.length);
    expect(got.equals(payload), "chunks aliased memory the caller went on to reuse").toBe(true);
  });

  it("delivers the whole file even though the socket died mid-way", async () => {
    const payload = Buffer.alloc(400_000, 7);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
    const url = await flakyHost(payload, 120_000, 1);

    const got = await drain(resumableBody(url, { signal: new AbortController().signal }));

    expect(got.length, "the download stopped where the socket did").toBe(payload.length);
    expect(got.equals(payload), "the resumed half did not line up with the first").toBe(true);
  });

  it("resumes from where it stopped instead of starting again", async () => {
    const payload = Buffer.alloc(300_000, 3);
    const ranges: (string | undefined)[] = [];
    const url = await flakyHost(payload, 100_000, 1);
    const wrapped = new Proxy(globalThis.fetch, {
      apply(target, thisArg, args: Parameters<typeof fetch>) {
        ranges.push((args[1]?.headers as Record<string, string>)?.Range);
        return Reflect.apply(target, thisArg, args);
      },
    });

    const got = await drain(resumableBody(url, { signal: new AbortController().signal, fetchImpl: wrapped }));

    expect(got.length).toBe(payload.length);
    expect(ranges[0], "the first request should ask for the whole thing").toBeUndefined();
    expect(ranges[1], "the retry asked for the whole file again, not the rest of it").toBe("bytes=100000-");
  });

  it("survives more than one drop", async () => {
    const payload = Buffer.alloc(250_000, 9);
    const url = await flakyHost(payload, 60_000, 3);

    const got = await drain(resumableBody(url, { signal: new AbortController().signal }));
    expect(got.length).toBe(payload.length);
  });

  it("keeps going through more drops than its retry budget, because each one made progress", async () => {
    // the budget bounds a connection that is STUCK, not a download that is
    // going badly. Every resume that delivers bytes is progress, and progress
    // earns a fresh budget - otherwise a long download on a bad line dies at
    // the same fixed number of drops however much of it has arrived.
    const payload = Buffer.alloc(240_000, 5);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
    const url = await flakyHost(payload, 30_000, 5);

    const got = await drain(resumableBody(url, { signal: new AbortController().signal, tries: 2 }));

    expect(got.length, "gave up while it was still making headway").toBe(payload.length);
    expect(got.equals(payload)).toBe(true);
  });

  it("does not deliver the same bytes twice when a host ignores the Range", async () => {
    // an origin that answers 200 with the whole file however you ask. The
    // decoder downstream is mid-archive and cannot be rewound, so the bytes it
    // has already seen have to be dropped rather than replayed.
    const payload = Buffer.alloc(180_000, 0);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
    let dropped = false;
    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Length": String(payload.length) });
      if (!dropped) {
        dropped = true;
        res.write(payload.subarray(0, 90_000), () => {
          setTimeout(() => res.socket?.destroy(), 25);
        });
        return;
      }
      res.end(payload);
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server!.address() as { port: number }).port}/archive`;

    const got = await drain(resumableBody(url, { signal: new AbortController().signal }));

    expect(got.length, "the replayed prefix was passed on a second time").toBe(payload.length);
    expect(got.equals(payload)).toBe(true);
  });

  it("does not sit through seven retries on a URL that is simply wrong", async () => {
    let calls = 0;
    server = http.createServer((_req, res) => {
      calls += 1;
      res.writeHead(404).end("no such asset");
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server!.address() as { port: number }).port}/gone`;

    await expect(drain(resumableBody(url, { signal: new AbortController().signal }))).rejects.toThrow(/404/);
    expect(calls, "a stale catalog URL was retried as though the network were flaky").toBe(1);
  });

  it("stops even when every attempt delivers a few bytes and then dies", async () => {
    // progress resets the retry budget, so a host that hands over a little and
    // drops - for ever - would be retried for ever. Real hosts honour Range
    // and this cannot happen; a ceiling costs nothing and bounds it anyway.
    const payload = Buffer.alloc(100_000, 4);
    let served = 0;
    server = http.createServer((_req, res) => {
      served += 1;
      res.writeHead(200, { "Content-Length": String(payload.length) });
      res.write(payload.subarray(0, 1000), () => {
        setTimeout(() => res.socket?.destroy(), 15);
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server!.address() as { port: number }).port}/archive`;

    await expect(
      drain(resumableBody(url, { signal: new AbortController().signal, maxAttempts: 4 })),
    ).rejects.toThrow(/4 connections/);
    expect(served, "the ceiling did not hold").toBe(4);
  });

  it("gives up rather than retrying a dead host for ever", async () => {
    await expect(
      drain(resumableBody("http://127.0.0.1:9/nothing", { signal: new AbortController().signal, tries: 2 })),
    ).rejects.toThrow();
  });

  it("stops immediately when the download is cancelled", async () => {
    const payload = Buffer.alloc(200_000, 1);
    const url = await flakyHost(payload, 50_000, 99);
    const ac = new AbortController();
    const stream = resumableBody(url, { signal: ac.signal });
    ac.abort();

    await expect(drain(stream)).rejects.toThrow();
  });
});
