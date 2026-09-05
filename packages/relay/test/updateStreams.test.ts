import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startRelay } from "../src/server";
import type { RelayHandle } from "../src/server";

/**
 * The installer route streams a file to an unauthenticated caller, and a
 * download that is cancelled part way through is completely normal - a phone
 * leaving wifi, an updater retrying, someone closing the tab.
 *
 * The leak is observed through the filesystem rather than through fd counts:
 * Windows will not unlink a file that is still open, so a read stream nobody
 * destroyed keeps its file undeletable. That is the same handle the audit
 * counted, seen from the other side.
 */

let relay: RelayHandle;
let dir: string;
let updates: string;

/** big enough that the stream is still live when the client walks away */
const SIZE = 8 * 1024 * 1024;
const NAME = "CalloutRelay-Setup-9.9.9.exe";

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-streams-"));
  updates = path.join(dir, "updates");
  fs.mkdirSync(updates, { recursive: true });
  fs.writeFileSync(path.join(updates, NAME), Buffer.alloc(SIZE, 7));
  relay = await startRelay({ port: 0, dataDir: dir, updatesDir: updates, mockStt: true, mockGemini: true });
});

afterEach(async () => {
  await relay?.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a leaked handle can keep this locked; the test reports that itself */
  }
});

const url = (): string => `http://127.0.0.1:${relay.port}/updates/${NAME}`;
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** start a download, read one chunk, then walk away */
async function abortPartway(headers?: Record<string, string>): Promise<void> {
  const ctrl = new AbortController();
  const res = await fetch(url(), { signal: ctrl.signal, headers });
  const reader = res.body!.getReader();
  await reader.read();
  ctrl.abort();
  try {
    await reader.cancel();
  } catch {
    /* already aborted */
  }
}

describe("a download the caller abandons", () => {
  it("leaves no read stream behind", () => {
    // Counted in a separate process on purpose: the probe patches CJS `fs`
    // before the relay loads, and that property cannot be redefined on an ESM
    // namespace from in here. An earlier attempt to observe this through the
    // filesystem proved nothing - Windows opens these with FILE_SHARE_DELETE,
    // so the file renames happily while the descriptor is still held.
    const probe = path.resolve(__dirname, "..", "scripts", "leak-probe.cjs");
    let out: string;
    try {
      out = execFileSync(process.execPath, [probe, "12"], { encoding: "utf8", stdio: "pipe" });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    expect(out, out.trim()).toContain("RESULT: no leak");
  }, 60000);

  it("keeps serving normally afterwards", async () => {
    for (let i = 0; i < 5; i += 1) await abortPartway();
    const res = await fetch(url());
    const body = Buffer.from(await res.arrayBuffer());
    expect(res.status).toBe(200);
    expect(body).toHaveLength(SIZE);
  });

  it("still serves a range after a run of aborts", async () => {
    for (let i = 0; i < 5; i += 1) await abortPartway({ Range: "bytes=0-8000000" });
    const res = await fetch(url(), { headers: { Range: "bytes=10-19" } });
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer())).toHaveLength(10);
  });
});

describe("a download that completes", () => {
  it("still arrives whole", async () => {
    const res = await fetch(url());
    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toHaveLength(SIZE);
    expect(body[0]).toBe(7);
    expect(body[SIZE - 1]).toBe(7);
  });

  it("still serves an exact range", async () => {
    const res = await fetch(url(), { headers: { Range: "bytes=10-19" } });
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer())).toHaveLength(10);
  });
});
