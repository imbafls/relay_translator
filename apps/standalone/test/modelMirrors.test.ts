import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { SttModelInfo } from "@callout-relay/shared";
import { fileSources, mirrorLabel, mirrorUrl } from "@callout-relay/shared";
import { ModelStore, describeError } from "../src/models";

/**
 * The mirror chain: every local model as plain files, each fetched from the
 * first source in its chain that delivers the catalogue's exact bytes, resumed
 * from its `.part` across sources and across launches, with the GitHub archive
 * as the last resort for an archive model. Why: docs/LOG-REVIEW-2026-10.md -
 * on the reporting PC every archive died in the bz2 decoder while plain files
 * installed in the same session.
 *
 * The real ModelStore runs against a real disk. Only `fetch` is stood in for,
 * as in models.test.ts, and the stand-in honours `Range` the way Hugging Face
 * and GitHub do, so the resume is exercised rather than assumed.
 */

const A = "https://huggingface.co/imbafls/callout-relay-models/resolve/0123456789abcdef0123456789abcdef01234567/m/model.onnx";
const B = "https://huggingface.co/upstream/repo/resolve/89abcdef0123456789abcdef0123456789abcdef/model.onnx";
const SIZE = 64 * 1024;
const BYTES = Buffer.from(Array.from({ length: SIZE }, (_, i) => (i * 7 + 3) & 0xff));
const SHA = createHash("sha256").update(BYTES).digest("hex");

/** archive fixture from models.test.ts: pkg/src-encoder.onnx (64 B), pkg/src-tokens.txt (32 B) */
const FIXTURE = Buffer.from(
  "QlpoOTFBWSZTWZjC1b8AALv/qs6AAARAA/8EAgVEQH6p3sQAIAACAAIICCAAkgyoZRtNTRkGahkyYRjRkG1IobQmhkYgaNGQaGhh4umPww1MrgR7ggQqaG8lRMiQ1DEQITJHFx0XWGHYqIJSsklA36HoDlbbmAyz7nRDJ3N75D7QV2BKjaA+E+DCLjEdbDdSLf+icNK4DmlpbHFA3Vd/Lns58ZV+CnBZcgo7L4PKBKxhBA3F3JFOFCQmMLVvwA==",
  "base64",
);
const ARCHIVE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/pkg.tar.bz2";

type Behaviour =
  | { status: number }
  | { bytes: Buffer; dieAfter?: number; ignoreRange?: boolean };

let dir: string;
let logs: { level: string; message: string }[];
let requests: { url: string; range: string | null }[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-mirrors-"));
  logs = [];
  requests = [];
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
 * Serve each URL by its behaviour. `dieAfter` is a byte offset INTO THE FILE
 * that this source never gets past: every response errors there, and a resume
 * from it errors at once - a mirror that never gets further - so the only way
 * past it is another source. (Its retries cost the real ~6.6 s backoff.)
 */
function serve(routes: Record<string, Behaviour>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const range = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
    requests.push({ url, range });
    const how = routes[url];
    if (!how) return new Response("not found", { status: 404 });
    if ("status" in how) return new Response("nope", { status: how.status });
    const from = range && !how.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    const body = how.bytes.subarray(from);
    const stop = how.dieAfter === undefined ? Infinity : Math.max(0, how.dieAfter - from);
    // pull-driven, one chunk at a time: erroring a stream discards what is still
    // queued in it, so an eager start() would deliver nothing before dying
    let at = 0;
    const stream = new ReadableStream({
      pull(c) {
        if (at >= stop) {
          c.error(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }));
          return;
        }
        if (at >= body.length) {
          c.close();
          return;
        }
        c.enqueue(new Uint8Array(body.subarray(at, Math.min(at + 4096, body.length))));
        at += 4096;
      },
    });
    return new Response(stream, { status: from > 0 ? 206 : 200 });
  }) as typeof fetch;
}

function fileModel(mirrors: string[], url = ""): SttModelInfo {
  return {
    id: "m",
    label: "Test Model",
    provider: "local",
    kind: "streaming",
    engine: "zipformer-online",
    sizeMb: 1,
    tier: "light",
    files: [{ name: "model.onnx", url, mirrors, size: SIZE, sha256: SHA }],
  };
}

function store(info: SttModelInfo): ModelStore {
  return new ModelStore(dir, () => {}, (level, message) => logs.push({ level, message }), [info], () => 10e9);
}

const failure = (): string => logs.find((l) => l.level === "error")?.message ?? "";
const installed = (name = "model.onnx"): Buffer | null => {
  const p = path.join(dir, "m", name);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
};

describe("the catalogue's mirror chain", () => {
  it("tries the project mirror before the upstream file, when there is one", () => {
    const own = mirrorUrl("local-x", "a.onnx", "f".repeat(40));
    expect(own).toBe(`https://huggingface.co/imbafls/callout-relay-models/resolve/${"f".repeat(40)}/local-x/a.onnx`);
    expect(fileSources({ name: "a.onnx", url: B, size: 1, mirrors: [own!] })).toEqual([own, B]);
    expect(mirrorUrl("local-x", "a.onnx", null), "no revision must mean no mirror, not a moving one").toBeNull();
  });

  it("names a mirror by repo or host, never by its full URL", () => {
    expect(mirrorLabel(A)).toBe("hf:imbafls/callout-relay-models");
    expect(mirrorLabel(ARCHIVE)).toBe("github");
  });
});

describe("a file with more than one source", () => {
  it("installs from the second source when the first answers 404, and says which served it", async () => {
    serve({ [A]: { status: 404 }, [B]: { bytes: BYTES } });
    await store(fileModel([A], B)).download("m");

    expect(failure()).toBe("");
    expect(installed()?.equals(BYTES)).toBe(true);
    const text = logs.map((l) => l.message).join("\n");
    expect(text).toMatch(/failed on hf:imbafls\/callout-relay-models - HTTP 404 - trying the next mirror/);
    expect(text, "the log does not say which mirror served the file").toMatch(/served by hf:upstream\/repo/);
  });

  it("throws away a source's wrong bytes before trying the next one", async () => {
    const wrong = Buffer.alloc(SIZE, 1);
    serve({ [A]: { bytes: wrong }, [B]: { bytes: BYTES } });
    await store(fileModel([A], B)).download("m");

    expect(failure()).toBe("");
    expect(installed()?.equals(BYTES), "the substituted bytes leaked into the published file").toBe(true);
    expect(logs.map((l) => l.message).join("\n")).toMatch(/failed on hf:imbafls\/callout-relay-models - .*SHA-256/);
  });

  it("carries on from the bytes a broken source delivered instead of starting again", async () => {
    serve({ [A]: { bytes: BYTES, dieAfter: 3 * 4096 }, [B]: { bytes: BYTES } });
    await store(fileModel([A], B)).download("m");

    expect(failure()).toBe("");
    expect(installed()?.equals(BYTES)).toBe(true);
    const toB = requests.filter((r) => r.url === B);
    expect(toB.length).toBe(1);
    expect(toB[0]!.range, "the second source was asked for the whole file again").toMatch(/^bytes=\d+-$/);
    expect(Number(/bytes=(\d+)-/.exec(toB[0]!.range!)![1])).toBeGreaterThanOrEqual(3 * 4096);
  });
});

describe("a download interrupted by closing the app", () => {
  it("resumes from the .part the last launch left, asking only for the rest", async () => {
    fs.mkdirSync(path.join(dir, "m"), { recursive: true });
    fs.writeFileSync(path.join(dir, "m", "model.onnx.part"), BYTES.subarray(0, 40000));
    serve({ [A]: { bytes: BYTES } });
    await store(fileModel([A])).download("m");

    expect(failure()).toBe("");
    expect(installed()?.equals(BYTES)).toBe(true);
    expect(requests.map((r) => r.range), "the download started over and threw the .part away").toEqual(["bytes=40000-"]);
    expect(fs.existsSync(path.join(dir, "m", "model.onnx.part"))).toBe(false);
  });

  it("still gets the file right when the host ignores the Range and starts over", async () => {
    fs.mkdirSync(path.join(dir, "m"), { recursive: true });
    fs.writeFileSync(path.join(dir, "m", "model.onnx.part"), BYTES.subarray(0, 40000));
    serve({ [A]: { bytes: BYTES, ignoreRange: true } });
    await store(fileModel([A])).download("m");

    expect(failure()).toBe("");
    expect(installed()?.equals(BYTES), "replayed bytes were appended to the .part").toBe(true);
  });
});

describe("an archive model with a mirror", () => {
  const archiveModel = (sources: Record<string, string[]>): SttModelInfo => ({
    id: "m",
    label: "Test Archive Model",
    provider: "local",
    kind: "streaming",
    engine: "zipformer-online",
    sizeMb: 1,
    tier: "light",
    files: [
      { name: "encoder.onnx", url: "", mirrors: sources["encoder.onnx"], size: 64, sha256: ENC_SHA },
      { name: "tokens.txt", url: "", mirrors: sources["tokens.txt"], size: 32, sha256: TOK_SHA },
    ],
    archive: {
      url: ARCHIVE,
      size: FIXTURE.length,
      sha256: "e36e73e6d61ffddbcff19f68a58d03c386c5325068850fff5f8ab5d26e63a69f",
      pick: { "encoder.onnx": "src-encoder.onnx", "tokens.txt": "src-tokens.txt" },
    },
  });
  const ENC = "https://huggingface.co/imbafls/callout-relay-models/resolve/0123456789abcdef0123456789abcdef01234567/m/encoder.onnx";
  const TOK = "https://huggingface.co/imbafls/callout-relay-models/resolve/0123456789abcdef0123456789abcdef01234567/m/tokens.txt";
  // the fixture's two entries, as the mirror holds them
  let ENC_BYTES: Buffer;
  let TOK_BYTES: Buffer;
  let ENC_SHA = "";
  let TOK_SHA = "";

  beforeEach(async () => {
    // unpack the fixture once through the archive path itself to learn its bytes
    serve({ [ARCHIVE]: { bytes: FIXTURE } });
    const probe = new ModelStore(dir, () => {}, () => {}, [archiveModel({})], () => 10e9);
    await probe.download("m");
    ENC_BYTES = fs.readFileSync(path.join(dir, "m", "encoder.onnx"));
    TOK_BYTES = fs.readFileSync(path.join(dir, "m", "tokens.txt"));
    ENC_SHA = createHash("sha256").update(ENC_BYTES).digest("hex");
    TOK_SHA = createHash("sha256").update(TOK_BYTES).digest("hex");
    fs.rmSync(path.join(dir, "m"), { recursive: true, force: true });
    requests = [];
    logs = [];
  });

  it("installs file by file and never touches the archive or its decoder", async () => {
    serve({ [ENC]: { bytes: ENC_BYTES }, [TOK]: { bytes: TOK_BYTES }, [ARCHIVE]: { status: 500 } });
    await store(archiveModel({ "encoder.onnx": [ENC], "tokens.txt": [TOK] })).download("m");

    expect(failure(), logs.map((l) => l.message).join("\n")).toBe("");
    expect(installed("encoder.onnx")?.equals(ENC_BYTES)).toBe(true);
    expect(installed("tokens.txt")?.equals(TOK_BYTES)).toBe(true);
    expect(requests.map((r) => r.url), "the archive was fetched although every file had a mirror").not.toContain(ARCHIVE);
  });

  it("falls back to the GitHub archive when a file fails on every mirror", async () => {
    serve({ [ENC]: { status: 503 }, [TOK]: { bytes: TOK_BYTES }, [ARCHIVE]: { bytes: FIXTURE } });
    await store(archiveModel({ "encoder.onnx": [ENC], "tokens.txt": [TOK] })).download("m");

    expect(failure()).toBe("");
    expect(installed("encoder.onnx")?.equals(ENC_BYTES)).toBe(true);
    const text = logs.map((l) => l.message).join("\n");
    expect(text).toMatch(/falling back to the GitHub archive/);
    expect(text).toMatch(/served by github archive/);
  });

  it("names every source it tried when the fallback fails too", async () => {
    serve({ [ENC]: { status: 404 }, [TOK]: { bytes: TOK_BYTES }, [ARCHIVE]: { status: 404 } });
    await store(archiveModel({ "encoder.onnx": [ENC], "tokens.txt": [TOK] })).download("m");

    const msg = failure();
    expect(msg).toMatch(/Test Archive Model/);
    expect(msg).toMatch(/hf:imbafls\/callout-relay-models: HTTP 404/);
    expect(msg).toMatch(/github archive: HTTP 404/);
  });
});

/**
 * B6's first lesson: "the next failure will say what it was" - and the 2026-10
 * log is what it said, which was a joke from inside a bz2 decoder and "fetch
 * failed", with nothing about what to do. The message a user reads now names
 * the model, the mirror, the status or errno, the bytes and the next step.
 */
describe("what a failed download says", () => {
  it("names the model, every mirror, the status, the bytes received and what to do", async () => {
    serve({ [A]: { bytes: BYTES, dieAfter: 2 * 4096 }, [B]: { status: 403 } });
    await store(fileModel([A], B)).download("m");

    const msg = failure();
    expect(msg).toMatch(/Test Model/);
    expect(msg).toMatch(/hf:imbafls\/callout-relay-models: fetch failed \(ECONNRESET\)/);
    expect(msg).toMatch(/hf:upstream\/repo: HTTP 403/);
    expect(msg).toMatch(/Got \d+\.\d MB of 0\.1 MB|Got \d+ B of 65536 B/);
    expect(msg, "no next step").toMatch(/proxy|firewall|press DOWNLOAD again/i);
    expect(msg).not.toMatch(/^.{0,40}failed$/);
  });

  it("surfaces the errno Node's fetch hides behind 'fetch failed'", () => {
    const err = Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
    expect(describeError(err)).toBe("fetch failed (UND_ERR_CONNECT_TIMEOUT)");
    expect(describeError(new Error("HTTP 404"))).toBe("HTTP 404");
  });

  it("tells a corrupted download apart from a dropped one in what it advises", async () => {
    serve({ [A]: { bytes: Buffer.alloc(SIZE, 2) } });
    await store(fileModel([A])).download("m");
    expect(failure()).toMatch(/not the published file/);
  });
});

/**
 * A failed extract closes the files it was writing before anything deletes
 * them. Checked at the source, and the reason is the runtime: the leak is a
 * Node 20 behaviour (Electron 33's), and this suite runs on Node 22, where the
 * old `tar.x` happened to let go in time. Reproduced on Electron 33 itself with
 * a corrupted archive: before, every staging folder failed `ENOTEMPTY` through
 * 31 s of retries and then `EPERM ... lstat` until the app exited - the exact
 * tail of every failure in the 2026-10 log; after, the folders go at once.
 */
describe("a failed extract lets go of its files", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "models.ts"), "utf8");
  const once = /private async fetchArchiveOnce\([\s\S]*?\n  }\n/.exec(src)?.[0] ?? "";
  const code = once.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("reads fetchArchiveOnce, so the checks below are not vacuous", () => {
    expect(code.length, "fetchArchiveOnce could not be found in models.ts").toBeGreaterThan(1000);
  });

  it("opens the files itself rather than leaving them inside tar.x", () => {
    expect(code, "tar.x is back: it keeps the entry it was writing open when the pipeline fails").not.toMatch(/tar\.x\(/);
    expect(code).toMatch(/fs\.createWriteStream\(/);
  });

  it("closes every one of them before the failure leaves the function", () => {
    const fail = /catch \(err\) \{([\s\S]*?)\n    \}/.exec(code)?.[1] ?? "";
    expect(fail, "the extract's catch block could not be read").not.toBe("");
    const close = fail.indexOf("closeQuietly");
    const firstThrow = fail.indexOf("throw ");
    expect(close, "a failed extract no longer closes the files it opened").toBeGreaterThanOrEqual(0);
    expect(close, "the files are closed only after the error has already been thrown").toBeLessThan(firstThrow);
  });
});
