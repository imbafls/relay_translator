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

describe("who may watch", () => {
  it("lets the real token in", async () => {
    const ws = await open(viewerUrl(relay.state.viewerToken));
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("refuses a token that is simply wrong", async () => {
    await expect(open(viewerUrl("not-the-token"))).rejects.toThrow();
  });

  it("refuses a request with no token at all", async () => {
    await expect(open(`ws://127.0.0.1:${relay.port}/ws/viewer`)).rejects.toThrow();
  });

  it("refuses the publisher's token", async () => {
    // the two are separate powers; holding one must not confer the other
    await expect(open(viewerUrl(relay.state.publisherToken))).rejects.toThrow();
  });

  it("refuses a token that is a prefix of the real one", async () => {
    const short = relay.state.viewerToken.slice(0, -4);
    await expect(open(viewerUrl(short))).rejects.toThrow();
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
    await expect(open(viewerUrl(old))).rejects.toThrow();
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
