import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { startRelay } from "../src/server";
import type { RelayHandle } from "../src/server";

/**
 * The viewer page is served to anyone who asks - that is deliberate, so a link
 * can be opened before a session starts - and the token is enforced at the
 * WebSocket instead. That single check is the whole of what keeps a stream
 * private, and nothing tested it: smoke asserts the page is public and that a
 * *publisher* with a bad token is refused, but never the viewer.
 *
 * Its rotate block is titled "old viewer token dies" and only checks that the
 * token changed.
 */

let relay: RelayHandle;
let dir: string;
const sockets: WebSocket[] = [];

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

const viewerUrl = (token: string): string =>
  `ws://127.0.0.1:${relay.port}/ws/viewer?token=${encodeURIComponent(token)}`;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-viewer-auth-"));
  relay = await startRelay({ port: 0, dataDir: dir, mockStt: true, mockGemini: true });
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    try {
      ws.close();
    } catch {
      /* gone */
    }
  }
  await relay?.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
});

/**
 * A refusal now arrives as close code 4401 on an OPEN socket rather than as a
 * 401 during the handshake. The page cannot tell a refused handshake (1006)
 * from a train tunnel, so it retried for ever and a viewer opening a dead link
 * sat on RECONNECTING with nothing to say the link was simply finished. Same
 * change, same reason, as /ws/uplink in audit finding 24.
 */
function refusalCode(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const timer = setTimeout(() => reject(new Error("no close arrived")), 4000);
    ws.on("close", (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
    // a handshake failure surfaces here, never as a close - which is exactly
    // the shape this stopped doing
    ws.on("error", () => {
      clearTimeout(timer);
      resolve(1006);
    });
  });
}

describe("who may watch", () => {
  it("lets the real token in", async () => {
    const ws = await open(viewerUrl(relay.state.viewerToken));
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("refuses a token that is simply wrong", async () => {
    await expect(refusalCode(viewerUrl("not-the-token"))).resolves.toBe(4401);
  });

  it("refuses a request with no token at all", async () => {
    await expect(refusalCode(`ws://127.0.0.1:${relay.port}/ws/viewer`)).resolves.toBe(4401);
  });

  it("refuses the publisher's token", async () => {
    // the two are separate powers; holding one must not confer the other
    await expect(refusalCode(viewerUrl(relay.state.publisherToken))).resolves.toBe(4401);
  });

  it("refuses a token that is a prefix of the real one", async () => {
    const short = relay.state.viewerToken.slice(0, -4);
    await expect(refusalCode(viewerUrl(short))).resolves.toBe(4401);
  });

  it("still serves the page to anyone, which is the deliberate part", async () => {
    // the link is meant to be openable before a session exists
    const res = await fetch(`http://127.0.0.1:${relay.port}/watch/whatever`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="lines"');
  });
});

describe("rotating the link", () => {
  it("stops the old token working", async () => {
    const old = relay.state.viewerToken;
    await open(viewerUrl(old));

    const next = relay.rotateViewerToken();
    expect(next).not.toBe(old);

    // the assertion the smoke test's own heading promises and does not make
    await expect(refusalCode(viewerUrl(old))).resolves.toBe(4401);
  });

  it("lets the new token in", async () => {
    const next = relay.rotateViewerToken();
    const ws = await open(viewerUrl(next));
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("hangs up on whoever was already watching", async () => {
    const old = relay.state.viewerToken;
    const ws = await open(viewerUrl(old));

    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    relay.rotateViewerToken();

    // rotating is what you do when a link has gone somewhere it should not,
    // so it has to end the session that link already has open
    const code = await Promise.race([
      closed,
      new Promise<number>((r) => setTimeout(() => r(-1), 4000)),
    ]);
    expect(code, "the old viewer was left connected after the link rotated").not.toBe(-1);
  });
});
