import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { startRelay } from "../src/server";
import type { RelayHandle } from "../src/server";

/**
 * The real relay runs here, over real sockets. The publisher token checks out
 * in every case below - the point is that a caller who is past the door can
 * still send a body that does not match the declared type, from an old build
 * or a broken one, and must not be able to take the process down with it.
 */

let handle: RelayHandle;
let dataDir: string;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-server-test-"));
  handle = await startRelay({ port: 0, dataDir, mockStt: true, mockGemini: true });
});

afterAll(async () => {
  await handle?.close();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
});

const publisherUrl = (): string =>
  `ws://127.0.0.1:${handle.port}/ws/publisher?token=${handle.state.publisherToken}`;

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/** resolve with the first message of `type`, or null if none arrives in time */
function waitFor(ws: WebSocket, type: string, ms = 2000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.off("message", onMsg);
      resolve(null);
    }, ms);
    const onMsg = (data: Buffer): void => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve(msg);
      }
    };
    ws.on("message", onMsg);
  });
}

/** the relay is still answering, i.e. the process did not go down */
async function stillUp(): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
  const body = (await res.json()) as { ok?: boolean };
  return res.ok && body.ok === true;
}

describe("a publisher that is past the token but sends a bad hello", () => {
  it.each([
    ["no languages at all", { type: "hello" }],
    ["languages as a string", { type: "hello", languages: "en" }],
    ["languages missing target", { type: "hello", languages: { source: "en" } }],
    ["languages as null", { type: "hello", languages: null }],
    ["channelLabels as a string", { type: "hello", languages: "en", channelLabels: "YOU" }],
  ])("survives %s", async (_name, payload) => {
    const ws = await open(publisherUrl());
    ws.send(JSON.stringify(payload));
    const err = await waitFor(ws, "error");
    expect(err?.message).toContain("languages");
    expect(await stillUp()).toBe(true);
    ws.close();
  });

  it("still accepts a good hello afterwards", async () => {
    // a good hello reaches viewers as the language broadcast, which is the
    // observable proof that buildSession ran
    const viewer = await open(
      `ws://127.0.0.1:${handle.port}/ws/viewer?token=${handle.state.viewerToken}`,
    );
    const ws = await open(publisherUrl());
    ws.send(JSON.stringify({ type: "hello" }));
    await waitFor(ws, "error");

    const broadcast = waitFor(viewer, "hello", 4000);
    ws.send(
      JSON.stringify({
        type: "hello",
        stt: "deepgram-nova-3",
        translation: "gemini-3.1-flash-lite",
        languages: { source: "de", target: "ja" },
        translationEnabled: true,
        channels: 1,
      }),
    );
    const hello = (await broadcast) as { languages?: { source?: string; target?: string } } | null;
    expect(hello?.languages?.source).toBe("de");
    expect(hello?.languages?.target).toBe("ja");
    expect(await stillUp()).toBe(true);
    ws.close();
    viewer.close();
  });

  it("takes a hello with only languages, filling the rest from defaults", async () => {
    const viewer = await open(
      `ws://127.0.0.1:${handle.port}/ws/viewer?token=${handle.state.viewerToken}`,
    );
    const ws = await open(publisherUrl());

    const broadcast = waitFor(viewer, "hello", 4000);
    ws.send(JSON.stringify({ type: "hello", languages: { source: "fr", target: "ko" } }));
    const hello = (await broadcast) as { languages?: { source?: string } } | null;
    expect(hello?.languages?.source).toBe("fr");
    expect(await stillUp()).toBe(true);
    ws.close();
    viewer.close();
  });
});
