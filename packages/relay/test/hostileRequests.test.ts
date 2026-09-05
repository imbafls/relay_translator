import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { startRelay } from "../src/server";
import type { RelayHandle } from "../src/server";

/**
 * Request targets that Node's HTTP parser accepts and hands to the application
 * verbatim. `fetch` normalises these away, so they go over a raw socket - which
 * is also how they would arrive from the internet.
 *
 * The relay is on a public host and the handler is reached before any token
 * check, so anything that throws in it is an unauthenticated kill.
 */

let relay: RelayHandle;
let dir: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-hostile-"));
  relay = await startRelay({ port: 0, dataDir: dir, mockStt: true, mockGemini: true });
});

afterEach(async () => {
  await relay?.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
});

/** send one request line verbatim and return the status line, or "" if hung up */
function rawRequest(target: string, method = "GET"): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(relay.port, "127.0.0.1");
    let data = "";
    const done = (v: string): void => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(4000, () => done(""));
    sock.on("connect", () => {
      sock.write(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    sock.on("data", (b) => {
      data += b.toString();
    });
    sock.on("end", () => done(data.split("\r\n")[0] ?? ""));
    sock.on("error", reject);
  });
}

/** the relay is still answering, i.e. the process is alive */
async function stillUp(): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${relay.port}/health`);
  return res.ok;
}

describe("request targets that are not valid URLs", () => {
  it.each([
    ["a bare percent, which reads as an invalid host", "//%25"],
    ["an overlong UTF-8 escape", "/updates/%C0%80"],
    ["a lone percent", "/%"],
    ["a truncated escape", "/updates/%E0%A4"],
    ["a percent in the query", "/watch/abc?x=%ZZ"],
    ["a backslash host", "//%5C%5Cevil"],
  ])("survives %s", async (_name, target) => {
    const status = await rawRequest(target);
    // any answer is fine - 400, 404, 200. What is not fine is the process dying.
    expect(await stillUp(), `the relay died on ${target}`).toBe(true);
    expect(status, `no answer at all for ${target}`).not.toBe("");
  });

  it("keeps serving normal traffic afterwards", async () => {
    await rawRequest("//%25");
    await rawRequest("/updates/%C0%80");

    const res = await fetch(`http://127.0.0.1:${relay.port}/watch/anything`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="lines"');
  });

  it("survives the same target on the websocket upgrade path", async () => {
    // the upgrade handler parses the URL the same way, before any token check
    await new Promise<void>((resolve) => {
      const sock = net.connect(relay.port, "127.0.0.1");
      sock.setTimeout(4000, () => {
        sock.destroy();
        resolve();
      });
      sock.on("connect", () => {
        sock.write(
          "GET //%25 HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      sock.on("data", () => {
        sock.destroy();
        resolve();
      });
      sock.on("close", () => resolve());
      sock.on("error", () => resolve());
    });

    expect(await stillUp(), "the relay died on an upgrade with a bad target").toBe(true);
  });
});
