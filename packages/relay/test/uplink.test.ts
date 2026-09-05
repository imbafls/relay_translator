import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { startRelay } from "../src/server";
import type { RelayHandle } from "../src/server";

/**
 * The path that carries captions to a phone: the app's local relay fans a
 * subtitle out, the uplink mirrors it to the relay on the VPS, and a viewer
 * attached there sees it. There is a manual script for this
 * (scripts/uplink-e2e.mjs) but it needs a live VPS, a running relay on 8787 and
 * a real %APPDATA%, so nothing runs it.
 *
 * Here both relays are real and in-process. The bridge between them is a raw
 * socket rather than the companion's UplinkClient, because that lives in a
 * package this one does not depend on - so what is under test is the relay half:
 * uplink auth, the uplink message handling, and the fan-out to remote viewers.
 */

let local: RelayHandle;
let remote: RelayHandle;
const dirs: string[] = [];
const sockets: WebSocket[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-uplink-"));
  dirs.push(dir);
  return dir;
}

type Msg = Record<string, unknown>;

interface Conn {
  ws: WebSocket;
  seen: Msg[];
  /** resolve once a message satisfying `match` has arrived (or already has) */
  until(match: (m: Msg) => boolean, what: string, ms?: number): Promise<Msg>;
}

/**
 * Both relays greet a socket the moment it is accepted - "ready" on the uplink,
 * "hello" to a viewer - so the listener has to be attached at construction. Wait
 * for `open` first and those greetings are already gone.
 */
function connect(url: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const seen: Msg[] = [];
    ws.on("message", (data: Buffer) => {
      try {
        seen.push(JSON.parse(data.toString()));
      } catch {
        /* not our frame */
      }
    });
    const conn: Conn = {
      ws,
      seen,
      until(match, what, ms = 4000) {
        const deadline = Date.now() + ms;
        return new Promise((res, rej) => {
          const poll = (): void => {
            const hit = seen.find(match);
            if (hit) return res(hit);
            if (Date.now() > deadline) return rej(new Error(`no ${what} within ${ms}ms`));
            setTimeout(poll, 20);
          };
          poll();
        });
      },
    };
    ws.once("open", () => resolve(conn));
    ws.once("error", reject);
  });
}

const isType = (type: string) => (m: Msg) => m.type === type;

beforeEach(async () => {
  local = await startRelay({ port: 0, dataDir: tmp(), mockStt: true, mockGemini: true });
  remote = await startRelay({ port: 0, dataDir: tmp(), mockStt: true, mockGemini: true });
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  }
  await local?.close();
  await remote?.close();
  while (dirs.length) {
    try {
      fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      /* disposable */
    }
  }
});

const url = (h: RelayHandle, p: string, token: string): string =>
  `ws://127.0.0.1:${h.port}${p}?token=${token}`;

/** wire local -> remote the way the companion's uplink client does */
async function bridge(): Promise<Conn> {
  const up = await connect(url(remote, "/ws/uplink", remote.state.publisherToken));
  local.onBroadcast((msg) => {
    if (up.ws.readyState === WebSocket.OPEN) up.ws.send(JSON.stringify(msg));
  });
  return up;
}

/** start a session on the local relay and return its publisher socket */
async function publish(languages = { source: "en", target: "vi" }): Promise<Conn> {
  const pub = await connect(url(local, "/ws/publisher", local.state.publisherToken));
  pub.ws.send(
    JSON.stringify({
      type: "hello",
      stt: "deepgram-nova-3",
      translation: "gemini-3.1-flash-lite",
      languages,
      translationEnabled: true,
      channels: 1,
    }),
  );
  return pub;
}

/** 2 s of audio: the mock STT emits one final per 2 s of 16 kHz mono */
const utterance = (): Buffer => Buffer.alloc(16000 * 2 * 2, 1);

describe("uplink auth", () => {
  it("rejects a socket carrying the viewer token", async () => {
    await expect(connect(url(remote, "/ws/uplink", remote.state.viewerToken))).rejects.toThrow();
  });

  it("rejects a socket carrying no token", async () => {
    await expect(connect(`ws://127.0.0.1:${remote.port}/ws/uplink`)).rejects.toThrow();
  });

  it("accepts the publisher token and greets it", async () => {
    const up = await connect(url(remote, "/ws/uplink", remote.state.publisherToken));
    await up.until(isType("ready"), "ready");
  });
});

describe("a caption on its way to a phone", () => {
  it("reaches a viewer on the far relay", async () => {
    const phone = await connect(url(remote, "/ws/viewer", remote.state.viewerToken));
    await bridge();
    const pub = await publish();
    // a publisher streams; one buffer can land in the same tick as the hello,
    // before the STT stream reports itself open, and be dropped
    const streaming = setInterval(() => {
      if (pub.ws.readyState === WebSocket.OPEN) pub.ws.send(utterance());
    }, 100);

    const subtitle = await phone
      .until(isType("subtitle"), "subtitle")
      .finally(() => clearInterval(streaming));
    expect(typeof subtitle.source).toBe("string");
    expect((subtitle.source as string).length).toBeGreaterThan(0);
  });

  it("carries the language pair the publisher announced", async () => {
    const phone = await connect(url(remote, "/ws/viewer", remote.state.viewerToken));
    await bridge();
    await publish({ source: "de", target: "ja" });

    const relayed = await phone.until(
      (m) => m.type === "hello" && (m.languages as { source?: string } | undefined)?.source === "de",
      "a hello announcing de",
    );
    expect((relayed.languages as { target?: string }).target).toBe("ja");
  });

  it("tells the far relay how many phones are attached", async () => {
    const up = await bridge();
    await up.until((m) => m.type === "viewers" && m.count === 0, "an empty viewer count");

    await connect(url(remote, "/ws/viewer", remote.state.viewerToken));
    await up.until((m) => m.type === "viewers" && m.count === 1, "a viewer count of 1");
  });
});

describe("when the uplink drops", () => {
  it("tells the phones the stream ended", async () => {
    const phone = await connect(url(remote, "/ws/viewer", remote.state.viewerToken));
    const up = await bridge();
    await up.until(isType("ready"), "ready");

    up.ws.close();
    const status = await phone.until(
      (m) => m.type === "status" && m.live === false,
      "a not-live status",
    );
    expect(status.message).toBeTruthy();
  });
});
