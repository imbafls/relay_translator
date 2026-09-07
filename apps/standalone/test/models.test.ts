import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SttModelInfo } from "@callout-relay/shared";
import { ModelStore, publishRetry } from "../src/models";

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
