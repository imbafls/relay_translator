import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
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

/** open a socket, send one text frame verbatim, and let the relay react */
function sendFrame(pathAndToken: string, frame: string): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}${pathAndToken}`);
    const done = (): void => {
      try {
        ws.close();
      } catch {
        /* gone */
      }
      resolve();
    };
    const timer = setTimeout(done, 3000);
    ws.once("open", () => {
      ws.send(frame);
      setTimeout(() => {
        clearTimeout(timer);
        done();
      }, 400);
    });
    ws.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("websocket frames that parse to something that is not an object", () => {
  const bodies: [string, string][] = [
    ["null", "null"],
    ["a bare number", "123"],
    ["a bare string", '"hello"'],
    ["an array", "[]"],
    ["true", "true"],
  ];

  it.each(bodies)("survives %s from the publisher", async (_name, frame) => {
    // JSON.parse succeeds and the property read after it does not - and the
    // hello validator added in turn 4 runs after that read, so it never sees this
    await sendFrame(`/ws/publisher?token=${relay.state.publisherToken}`, frame);
    expect(await stillUp(), `the relay died on a publisher frame of ${frame}`).toBe(true);
  });

  it.each(bodies)("survives %s from the uplink", async (_name, frame) => {
    await sendFrame(`/ws/uplink?token=${relay.state.publisherToken}`, frame);
    expect(await stillUp(), `the relay died on an uplink frame of ${frame}`).toBe(true);
  });

  it.each(bodies)("survives %s from a viewer", async (_name, frame) => {
    // this handler already kept its property reads inside the try
    await sendFrame(`/ws/viewer?token=${relay.state.viewerToken}`, frame);
    expect(await stillUp(), `the relay died on a viewer frame of ${frame}`).toBe(true);
  });

  it("still accepts a real hello afterwards", async () => {
    await sendFrame(`/ws/publisher?token=${relay.state.publisherToken}`, "null");
    await sendFrame(
      `/ws/publisher?token=${relay.state.publisherToken}`,
      JSON.stringify({
        type: "hello",
        stt: "deepgram-nova-3",
        translation: "gemini-3.1-flash-lite",
        languages: { source: "en", target: "vi" },
        translationEnabled: true,
        channels: 1,
      }),
    );
    expect(await stillUp()).toBe(true);
  });
});

describe("nothing throws on those frames, which is the part that matters", () => {
  it("runs clean in a real process", () => {
    // The tests above assert the relay is still answering, and it would be
    // either way: cli.ts has an uncaughtException handler, so the process
    // survives a throw. "Still alive" therefore proves nothing. This looks for
    // the throw itself in the server's stderr - and the embedded relay in the
    // desktop app has no such handler, so a throw here is a dead app there.
    const probe = path.resolve(__dirname, "..", "scripts", "frame-probe.cjs");
    let out: string;
    try {
      out = execFileSync(process.execPath, [probe], { encoding: "utf8", stdio: "pipe" });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    expect(out, out.trim()).toContain("RESULT: nothing threw");
  }, 60000);
});
