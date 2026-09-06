import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

describe("the speaker colours a publisher announces", () => {
  /**
   * The colour ends up in a style attribute on every viewer. The publisher is
   * this app on the embedded relay, but on a hosted one it is whoever holds a
   * publish token - so it is untrusted input on its way into CSS, and the relay
   * is the last place that can stop it reaching a page that trusts the relay.
   *
   * The viewer sanitises independently as well; this is the half that keeps a
   * bad value off the wire in the first place.
   */
  async function firstSubtitle(channelColors: unknown): Promise<Record<string, unknown> | null> {
    const viewer = await open(`ws://127.0.0.1:${handle.port}/ws/viewer?token=${handle.state.viewerToken}`);
    const pub = await open(publisherUrl());
    pub.send(
      JSON.stringify({
        type: "hello",
        stt: "deepgram-nova-3",
        translation: "gemini-3.1-flash-lite",
        languages: { source: "en", target: "vi" },
        translationEnabled: false,
        channels: 2,
        channelLabels: ["YOU", "CHAT"],
        channelColors,
      }),
    );
    await waitFor(viewer, "hello", 4000);
    // the mock emits one line per 2 s of audio, and at most one per send
    pub.send(Buffer.alloc(16000 * 2 * 2 * 2, 1));
    const msg = await waitFor(viewer, "subtitle", 4000);
    pub.close();
    viewer.close();
    return msg;
  }

  it("carries a real one through to viewers", async () => {
    const msg = await firstSubtitle(["#e0a43a", "#7fb6d9"]);
    expect(msg, "no subtitle reached the viewer at all").not.toBeNull();
    expect(msg?.color).toBe("#e0a43a");
  });

  it("drops one that is not a colour instead of passing it on", async () => {
    const msg = await firstSubtitle(["red; background: url(javascript:alert(1))", "#7fb6d9"]);
    expect(msg, "no subtitle reached the viewer at all").not.toBeNull();
    expect(msg?.color, "a publisher's CSS reached the viewer").toBeUndefined();
    // and the rest of the tag still works, so a bad colour is not a bad session
    expect(msg?.speaker).toBe("YOU");
  });

  it("survives channelColors that is not a list", async () => {
    const msg = await firstSubtitle("#e0a43a");
    expect(msg?.speaker).toBe("YOU");
    expect(msg?.color).toBeUndefined();
    expect(await stillUp()).toBe(true);
  });
});

describe("what the relay says once the speech pipeline has died", () => {
  /**
   * Audit finding 11, from the outside. `isLive()` was pure socket presence and
   * `setLive` at the server was `() => {}`, so a publisher whose STT had gone
   * away still made `/health` and every viewer `hello` report live: true. A
   * viewer joining after that showed ON AIR with a running timer while not one
   * caption was being produced.
   *
   * This stands up its own relay so the STT socket can be killed the way
   * Deepgram kills it - the shared one in this file is on the canned mock,
   * which never closes.
   */
  let own: Awaited<ReturnType<typeof startRelay>>;
  let ownDir: string;
  let killStt: (() => void) | undefined;

  beforeEach(async () => {
    ownDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-stt-death-"));
    killStt = undefined;
    own = await startRelay({
      port: 0,
      dataDir: ownDir,
      mockGemini: true,
      makeStt: (events) => {
        let open = true;
        killStt = () => {
          open = false;
          events.onClose?.();
        };
        setImmediate(() => events.onOpen?.());
        return { sendAudio: () => open, close: () => { open = false; } };
      },
    });
  });

  afterEach(async () => {
    await own.close();
    try {
      fs.rmSync(ownDir, { recursive: true, force: true });
    } catch {
      /* disposable */
    }
  });

  const health = async (): Promise<{ live?: boolean }> =>
    (await (await fetch(`http://127.0.0.1:${own.port}/health`)).json()) as { live?: boolean };

  async function publish(): Promise<WebSocket> {
    const ws = await open(`ws://127.0.0.1:${own.port}/ws/publisher?token=${own.state.publisherToken}`);
    ws.send(
      JSON.stringify({
        type: "hello",
        stt: "deepgram-nova-3",
        translation: "gemini-3.1-flash-lite",
        languages: { source: "en", target: "vi" },
        translationEnabled: false,
        channels: 1,
      }),
    );
    await new Promise((r) => setTimeout(r, 80));
    return ws;
  }

  it("reports live while the pipeline is up", async () => {
    const ws = await publish();
    expect((await health()).live).toBe(true);
    ws.close();
  });

  it("stops reporting live once the pipeline is gone", async () => {
    const ws = await publish();
    expect(killStt, "the stand-in stream was never built").toBeTypeOf("function");
    killStt!();
    await new Promise((r) => setTimeout(r, 80));

    expect((await health()).live, "/health still claimed live with no speech pipeline").toBe(false);
    ws.close();
  });

  it("tells a viewer that joins afterwards, rather than showing it ON AIR forever", async () => {
    const ws = await publish();
    killStt!();
    await new Promise((r) => setTimeout(r, 80));

    // the connect hello is sent the instant the socket is accepted, so the
    // listener has to be attached before "open" - waitFor() would miss it
    const viewer = new WebSocket(`ws://127.0.0.1:${own.port}/ws/viewer?token=${own.state.viewerToken}`);
    const hello = await new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 4000);
      viewer.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "hello") {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
    expect(hello, "no hello reached the viewer").not.toBeNull();
    expect(hello?.live, "a viewer joining a dead session was told it was on air").toBe(false);
    viewer.close();
    ws.close();
  });

  it("is live again when the publisher opens a new session", async () => {
    const ws = await publish();
    killStt!();
    await new Promise((r) => setTimeout(r, 80));
    expect((await health()).live).toBe(false);

    const ws2 = await publish();
    expect((await health()).live, "a fresh session stayed marked dead").toBe(true);
    ws.close();
    ws2.close();
  });
});
