import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SttModelInfo } from "@callout-relay/shared";
import { ModelStore } from "../src/models";

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
