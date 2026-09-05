import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startRelay } from "../src/server";
import type { RelayHandle } from "../src/server";

/**
 * /updates/ is the auto-update feed: electron-updater reads latest.yml from it
 * and then pulls the installer, resuming with range requests when a download is
 * interrupted. The range handling here is hand-rolled, so this checks it against
 * what RFC 7233 says a client is allowed to ask for.
 */

let relay: RelayHandle;
let dir: string;
let updates: string;

/** 1000 bytes whose value encodes their own offset, so a wrong slice shows up */
const SIZE = 1000;
const BODY = Buffer.from(Array.from({ length: SIZE }, (_, i) => i % 251));

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-updates-"));
  updates = path.join(dir, "updates");
  fs.mkdirSync(updates, { recursive: true });
  fs.writeFileSync(path.join(updates, "CalloutRelay-Setup-9.9.9.exe"), BODY);
  fs.writeFileSync(path.join(updates, "latest.yml"), "version: 9.9.9\n");
  relay = await startRelay({ port: 0, dataDir: dir, updatesDir: updates, mockStt: true, mockGemini: true });
});

afterEach(async () => {
  await relay?.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
});

const setup = (): string => `http://127.0.0.1:${relay.port}/updates/CalloutRelay-Setup-9.9.9.exe`;

async function get(range?: string, method = "GET"): Promise<{ status: number; contentRange: string | null; body: Buffer }> {
  const res = await fetch(setup(), {
    method,
    headers: range ? { Range: range } : undefined,
  });
  return {
    status: res.status,
    contentRange: res.headers.get("content-range"),
    body: Buffer.from(await res.arrayBuffer()),
  };
}

describe("serving the whole installer", () => {
  it("returns it with a byte count and an offer to resume", async () => {
    const res = await fetch(setup());
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BODY);
  });

  it("does not let latest.yml be cached", async () => {
    const res = await fetch(`http://127.0.0.1:${relay.port}/updates/latest.yml`);
    expect(res.headers.get("cache-control")).toContain("no-cache");
  });

  it("answers HEAD without a body", async () => {
    const res = await fetch(setup(), { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(SIZE));
  });
});

describe("resuming a partial download", () => {
  it("serves an explicit span", async () => {
    const { status, contentRange, body } = await get("bytes=0-99");
    expect(status).toBe(206);
    expect(contentRange).toBe(`bytes 0-99/${SIZE}`);
    expect(body).toEqual(BODY.subarray(0, 100));
  });

  it("serves from an offset to the end when no end is given", async () => {
    const { status, contentRange, body } = await get("bytes=900-");
    expect(status).toBe(206);
    expect(contentRange).toBe(`bytes 900-999/${SIZE}`);
    expect(body).toEqual(BODY.subarray(900));
  });

  it("serves the LAST n bytes for a suffix range", async () => {
    // "bytes=-100" means the final 100 bytes. Reading it as 0-100 hands the
    // client the beginning of the installer while telling it that is the range
    // it asked for, so the file it assembles is wrong and nothing reports it.
    const { status, contentRange, body } = await get("bytes=-100");
    expect(status).toBe(206);
    expect(contentRange).toBe(`bytes 900-999/${SIZE}`);
    expect(body).toEqual(BODY.subarray(900));
  });

  it("clamps an end past the file instead of refusing", async () => {
    // a resume that asks for more than is left is not an error: RFC 7233 says
    // an end at or beyond the length means the rest of the file
    const { status, contentRange, body } = await get("bytes=0-999999");
    expect(status).toBe(206);
    expect(contentRange).toBe(`bytes 0-999/${SIZE}`);
    expect(body).toEqual(BODY);
  });

  it("answers HEAD with range headers and no body", async () => {
    const { status, contentRange, body } = await get("bytes=10-19", "HEAD");
    expect(status).toBe(206);
    expect(contentRange).toBe(`bytes 10-19/${SIZE}`);
    expect(body).toHaveLength(0);
  });
});

describe("ranges that cannot be satisfied", () => {
  it("refuses a start past the end of the file", async () => {
    const { status, contentRange } = await get("bytes=2000-2100");
    expect(status).toBe(416);
    expect(contentRange).toBe(`bytes */${SIZE}`);
  });

  it("refuses a backwards range", async () => {
    expect((await get("bytes=500-100")).status).toBe(416);
  });

  it("refuses a suffix of zero bytes", async () => {
    expect((await get("bytes=-0")).status).toBe(416);
  });

  it("ignores a range header it cannot parse and sends the whole file", async () => {
    const { status, body } = await get("furlongs=1-2");
    expect(status).toBe(200);
    expect(body).toEqual(BODY);
  });
});
