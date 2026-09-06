import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { WebSocket as NodeWebSocket } from "ws";
import { UplinkClient } from "../src/uplinkClient";
import { RelayPublisherClient } from "../src/relayClient";

/**
 * The real UplinkClient against a real WebSocket server. This is the socket the
 * desktop app holds open to the VPS for the whole of a session, across sleeps,
 * dropped wifi and relay restarts, so what matters is how it behaves when the
 * connection does not simply work.
 */

let wss: WebSocketServer;
let port: number;
/** every socket the server has accepted, in order */
let accepted: NodeWebSocket[] = [];
let clients: UplinkClient[] = [];

const live = (): NodeWebSocket[] => accepted.filter((ws) => ws.readyState === ws.OPEN);

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** wait for a condition, or throw saying what never happened */
async function until(cond: () => boolean, what: string, ms = 6000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`${what} never happened within ${ms}ms`);
    await settle(25);
  }
}

beforeEach(async () => {
  accepted = [];
  clients = [];
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss.on("connection", (ws) => {
    accepted.push(ws);
    ws.on("message", () => {
      /* the relay answers hello/ping; nothing here needs to */
    });
  });
  await new Promise<void>((r) => wss.once("listening", r));
  port = (wss.address() as { port: number }).port;
});

afterEach(async () => {
  for (const c of clients) c.disconnect();
  clients = [];
  for (const ws of accepted) {
    try {
      ws.terminate();
    } catch {
      /* already gone */
    }
  }
  await new Promise<void>((r) => wss.close(() => r()));
});

function makeClient(states: string[] = []): UplinkClient {
  const c = new UplinkClient(`ws://127.0.0.1:${port}`, {
    onState: (s) => states.push(s),
  });
  clients.push(c);
  return c;
}

const HELLO = { languages: { source: "en", target: "vi" }, translates: true };

describe("holding exactly one socket open", () => {
  it("does not stack a second connection when connect is called again", async () => {
    const c = makeClient();
    c.connect(HELLO);
    await until(() => live().length === 1, "the first connection");

    // the app calls connect again - a settings change, a session restart
    c.connect(HELLO);
    await settle(300);

    // a second live socket means the VPS is holding a connection nobody owns
    expect(live()).toHaveLength(1);
  });

  it("does not leave an orphan when a retry lands next to a reconnect", async () => {
    const c = makeClient();
    c.connect(HELLO);
    await until(() => live().length === 1, "the first connection");

    // drop it from the server side, which arms the client's retry
    accepted[0].close();
    await until(() => live().length === 0, "the drop");

    // reconnect explicitly while that retry is still pending
    c.connect(HELLO);
    await settle(2000);

    expect(live()).toHaveLength(1);
  });
});

describe("coming back after a drop", () => {
  it("reconnects on its own when the relay goes away", async () => {
    const c = makeClient();
    c.connect(HELLO);
    await until(() => live().length === 1, "the first connection");

    accepted[0].close();
    await until(() => accepted.length === 2, "a reconnect", 6000);
    expect(c.state).toBe("connected");
  });

  it("sends its hello again on the new socket", async () => {
    const seen: string[] = [];
    wss.on("connection", (ws) => ws.on("message", (d: Buffer) => seen.push(String(d))));

    const c = makeClient();
    c.connect({ languages: { source: "de", target: "ja" }, translates: false });
    await until(() => seen.some((m) => m.includes('"hello"')), "the first hello");
    const before = seen.length;

    accepted[0].close();
    await until(
      () => seen.slice(before).some((m) => m.includes('"hello"')),
      "a second hello",
    );
    // the client pings straight after saying hello, so check the hello itself
    const secondHello = seen.slice(before).find((m) => m.includes('"hello"'))!;
    expect(secondHello).toContain('"de"');
    expect(secondHello).toContain('"ja"');
  });
});

describe("the publisher client holds the same shape", () => {
  it("does not stack a second connection either", async () => {
    // relayClient.open had the identical bug, so it gets the identical test
    const c = new RelayPublisherClient(`ws://127.0.0.1:${port}`);
    try {
      c.connect({
        stt: "deepgram-nova-3",
        translation: "gemini-3.1-flash-lite",
        languages: { source: "en", target: "vi" },
        translationEnabled: true,
        latencyVisible: true,
      });
      await until(() => live().length === 1, "the first connection");

      c.connect({
        stt: "deepgram-nova-3",
        translation: "gemini-3.1-flash-lite",
        languages: { source: "en", target: "vi" },
        translationEnabled: true,
        latencyVisible: true,
      });
      await settle(300);

      expect(live()).toHaveLength(1);
    } finally {
      c.disconnect();
    }
  });
});

describe("being told to stop", () => {
  it("stays down after disconnect", async () => {
    const c = makeClient();
    c.connect(HELLO);
    await until(() => live().length === 1, "the first connection");

    c.disconnect();
    await settle(2500);

    expect(live()).toHaveLength(0);
    expect(accepted).toHaveLength(1);
    expect(c.state).toBe("idle");
  });

  it("does not retry after the relay rejects the token", async () => {
    const states: string[] = [];
    const c = makeClient(states);
    c.connect(HELLO);
    await until(() => live().length === 1, "the first connection");

    // 4401 is what the relay sends when the uplink token is wrong
    accepted[0].close(4401, "uplink token rejected");
    await until(() => c.state === "error", "the error state");

    await settle(2500);
    expect(accepted).toHaveLength(1);
    expect(c.state).toBe("error");
  });
});

describe("what the publisher client hands back to the app", () => {
  /**
   * The callback types say `& SpeakerTag`, so widening SpeakerTag looked like
   * it was enough. It was not: this client rebuilds each message field by
   * field, so a new field on the type is simply not copied. `color` was added
   * to SpeakerTag, the relay sent it, viewers painted it - and the desktop
   * console did not, because the field never left this function.
   *
   * Typecheck cannot catch it (an object literal missing an optional field is
   * valid) and no other test could see it, so this asserts the whole tag comes
   * through rather than naming one field.
   */
  async function firstSubtitle(sent: Record<string, unknown>): Promise<Record<string, unknown>> {
    const got: Record<string, unknown>[] = [];
    const c = new RelayPublisherClient(`ws://127.0.0.1:${port}`, {
      onSubtitle: (seg) => got.push(seg as unknown as Record<string, unknown>),
    });
    try {
      c.connect({
        stt: "deepgram-nova-3",
        translation: "gemini-3.1-flash-lite",
        languages: { source: "en", target: "vi" },
        translationEnabled: true,
        latencyVisible: true,
      });
      await until(() => live().length === 1, "the publisher connection");
      live()[0].send(JSON.stringify(sent));
      await until(() => got.length === 1, "the subtitle coming back");
      return got[0];
    } finally {
      c.disconnect();
    }
  }

  it("carries the whole speaker tag, colour included", async () => {
    const seg = await firstSubtitle({
      type: "subtitle",
      id: 7,
      source: "enemy mid",
      final: true,
      channel: 2,
      speaker: "COACH",
      color: "#ff5f9e",
    });
    expect(seg.channel).toBe(2);
    expect(seg.speaker).toBe("COACH");
    expect(seg.color, "the colour was dropped on the way to the console").toBe("#ff5f9e");
  });

  it("leaves the tag off entirely when the relay sent none", async () => {
    const seg = await firstSubtitle({ type: "subtitle", id: 1, source: "solo", final: true });
    expect(seg.speaker).toBeUndefined();
    expect(seg.color).toBeUndefined();
  });
});
