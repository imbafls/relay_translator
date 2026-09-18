import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import type { WebSocket as NodeWebSocket } from "ws";
import { forwardsToUplink, UplinkClient } from "../src/uplinkClient";
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
/** every JSON frame any accepted socket has received, in order */
let frames: Record<string, unknown>[] = [];

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
  frames = [];
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss.on("connection", (ws) => {
    accepted.push(ws);
    ws.on("message", (data) => {
      try {
        frames.push(JSON.parse(String(data)));
      } catch {
        /* not our frame */
      }
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
    // The server accepting a socket and the client considering itself connected
    // are two different round trips. Reading `c.state` the instant the server
    // has accepted asserts the client's state off the server's observable, and
    // on a loaded runner the client's own open handler has not run yet - green
    // here, red on CI, and about nothing that matters. Wait for the client.
    await until(() => accepted.length === 2, "a reconnect", 6000);
    await until(() => c.state === "connected", "the client to finish its handshake", 6000);
    expect(accepted.length, "it reconnected without opening a new socket").toBe(2);
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

describe("being displaced by another machine", () => {
  /**
   * Audit finding 24. The relay closes a displaced uplink with 4409.
   * `RelayPublisherClient` handles that code and stops; `UplinkClient`
   * special-cased only 4401 and fell through to `scheduleRetry` - and because
   * `attempt` is reset to 0 on every successful open, the backoff never grew.
   *
   * Two machines sharing one publisher token therefore displaced each other
   * about once a second, forever, with every subtitle produced in each gap
   * dropped on the floor.
   */
  it("stops instead of fighting a replacement", async () => {
    const states: string[] = [];
    const c = makeClient(states);
    c.connect(HELLO);
    await until(() => live().length === 1, "the first connection");

    accepted[0].close(4409, "replaced by new uplink");
    await until(() => c.state === "error", "the error state");

    await settle(2500);
    expect(accepted, "it reconnected and was displaced again").toHaveLength(1);
    expect(c.state).toBe("error");
  });

  it("says it was replaced, not that the connection dropped", async () => {
    const states: string[] = [];
    const c = makeClient(states);
    c.connect(HELLO);
    await until(() => live().length === 1, "the first connection");
    accepted[0].close(4409, "replaced by new uplink");
    await until(() => c.state === "error", "the error state");

    expect(states.join(" ")).not.toContain("disconnected");
    c.disconnect();
  });

  it("still reconnects when the relay simply goes away", async () => {
    // the invariant a "stop retrying" fix could easily break
    const c = makeClient();
    c.connect(HELLO);
    await until(() => live().length === 1, "the first connection");

    // 1001 "going away", not 1006 - an endpoint cannot send a reserved code
    accepted[0].close(1001, "gone");
    await until(() => accepted.length === 2, "the reconnect", 8000);
    c.disconnect();
  });
});

describe("the hello an uplink sends", () => {
  /**
   * Both of these clients rebuild their hello field by field out of
   * `this.hello` rather than spreading it, so a field added to the type alone
   * reaches nothing. That is exactly how `color` went missing on the subtitle
   * path - see speakerTag.test.ts.
   */
  const BRANDED = { ...HELLO, brandName: "Omer's stream", brandColor: "#e0a43a" };

  it("carries the brand on the hello it opens with", async () => {
    const c = makeClient();
    c.connect(BRANDED);
    await until(() => frames.some((f) => f.type === "hello"), "the opening hello");

    const hello = frames.find((f) => f.type === "hello")!;
    expect(hello.brandName).toBe("Omer's stream");
    expect(hello.brandColor).toBe("#e0a43a");
  });

  it("carries it again when the brand changes mid-connection", async () => {
    const c = makeClient();
    c.connect(HELLO);
    await until(() => live().length === 1, "the connection");
    c.sendHello(BRANDED);
    await until(
      () => frames.filter((f) => f.type === "hello").length === 2,
      "a second hello",
    );

    const hello = frames.filter((f) => f.type === "hello")[1];
    expect(hello.brandName).toBe("Omer's stream");
  });
});

describe("whether the hello an uplink sends says anyone is actually streaming", () => {
  /**
   * The room this uplink talks to marks itself live the instant a hello
   * arrives, and `startUplink()` opens this connection at app boot - not at
   * session start. Without this field on the wire, a friend holding the link
   * sees ON AIR from an app that is merely running in the tray. `open()`
   * rebuilds this hello field by field out of `this.hello` rather than
   * spreading it (same shape as the brand test above), so `live` has to be
   * named explicitly or it reaches nothing.
   */
  it("puts live:false on the hello it opens with when no session is running", async () => {
    const c = makeClient();
    c.connect({ ...HELLO, live: false });
    await until(() => frames.some((f) => f.type === "hello"), "the opening hello");

    const hello = frames.find((f) => f.type === "hello")!;
    expect(hello.live).toBe(false);
  });

  it("puts live:true on the hello it opens with when a session is running", async () => {
    const c = makeClient();
    c.connect({ ...HELLO, live: true });
    await until(() => frames.some((f) => f.type === "hello"), "the opening hello");

    const hello = frames.find((f) => f.type === "hello")!;
    expect(hello.live).toBe(true);
  });

  // Cannot fail against a `sendHello` rewritten to drop `live`: it spreads
  // `...hello`, and vitest strips types, so the field rides through this
  // path either way. Kept as a guard against someone rewriting `sendHello`
  // to enumerate its fields by hand the way `open()`'s onopen does - not as
  // coverage for that failure mode, which is what the tests above and the
  // reconnect test below actually exercise.
  it("carries an updated live on the re-hello sendHello sends", async () => {
    const c = makeClient();
    c.connect({ ...HELLO, live: false });
    await until(() => live().length === 1, "the connection");
    c.sendHello({ ...HELLO, live: true });
    await until(
      () => frames.filter((f) => f.type === "hello").length === 2,
      "a second hello",
    );

    const hello = frames.filter((f) => f.type === "hello")[1];
    expect(hello.live).toBe(true);
  });
});

describe("a reconnect after the live state moved on without it", () => {
  /**
   * `open()`'s `ws.onopen` resends `this.hello` verbatim on every reconnect -
   * fine for languages/brand/translates, which really are config and really
   * are harmless to replay stale. `live` is not config, it is time-varying
   * state: `bridgeBroadcasts` in main.ts only forwards a fresh `live` while
   * `uplink.connected` is true, so a session that starts (or ends) during the
   * gap between a drop and the automatic reconnect leaves `this.hello.live`
   * stale for however long that gap lasts - a friend holding the link sees
   * OFF AIR while captions are genuinely scrolling. Finding 3, review round 2.
   */
  it("asks for the current live state on reconnect instead of replaying the cached one", async () => {
    let currentlyLive = false;
    const c = new UplinkClient(`ws://127.0.0.1:${port}`, {
      onState: () => {},
      live: () => currentlyLive,
    });
    clients.push(c);
    c.connect({ ...HELLO, live: false });
    await until(() => frames.some((f) => f.type === "hello"), "the opening hello");

    // a session starts while the socket is down - nothing calls connect() or
    // sendHello() again, exactly like bridgeBroadcasts's forward being gated
    // on `uplink.connected` for the whole length of the drop
    currentlyLive = true;
    accepted[0].close();
    await until(() => accepted.length === 2, "the reconnect");
    await until(() => frames.filter((f) => f.type === "hello").length === 2, "a second hello");

    const secondHello = frames.filter((f) => f.type === "hello")[1];
    expect(
      secondHello.live,
      "the reconnect resent the cached live:false instead of asking for the current value",
    ).toBe(true);
  });
});

describe("the hello a publisher client sends", () => {
  /**
   * relayClient.open had the identical bug as uplinkClient.open above: it
   * rebuilds the hello field by field out of `this.hello` rather than
   * spreading it, so a field added to the type alone reaches nothing. This is
   * the branding sibling of the uplink test above, for the client that serves
   * LAN and OBS viewers directly - the path that works on a fresh install.
   */
  it("carries the brand on the hello it opens with", async () => {
    const c = new RelayPublisherClient(`ws://127.0.0.1:${port}`);
    try {
      c.connect({
        stt: "deepgram-nova-3",
        translation: "gemini-3.1-flash-lite",
        languages: { source: "en", target: "vi" },
        translationEnabled: true,
        latencyVisible: true,
        brandName: "Omer's stream",
        brandColor: "#e0a43a",
      });
      await until(() => frames.some((f) => f.type === "hello"), "the opening hello");

      const hello = frames.find((f) => f.type === "hello")!;
      expect(hello.brandName).toBe("Omer's stream");
      expect(hello.brandColor).toBe("#e0a43a");
    } finally {
      c.disconnect();
    }
  });
});

/**
 * A remote relay that stops answering without closing the socket.
 *
 * `server.ts` fixed exactly this on its own side - audit finding 11c - and
 * says why in place: "a TCP connection whose peer vanished without a FIN - a
 * laptop lid, dropped wifi, a NAT timeout - stays OPEN on this side
 * indefinitely". Its heartbeat terminates a socket that misses one round.
 *
 * Nothing protected the other end. This client pinged every 20 seconds and
 * never looked at whether a pong came back, so a remote relay that went away
 * without a FIN left the app "connected" for as long as the OS kept the socket:
 * subtitles written into a dead pipe, the uplink chip green, and internet
 * viewers receiving nothing. It is the one socket in this product that crosses
 * the internet, which is where a half-open peer actually happens.
 */
describe("a remote relay that goes quiet without closing", () => {
  it("is given up on, so the reconnect that already exists can run", async () => {
    const states: string[] = [];
    // a fast heartbeat so this is a test and not a wait; the shipped period is
    // 20s and the rule is the same either way - two rounds with no answer
    const c = new UplinkClient(`ws://127.0.0.1:${port}`, { onState: (s2) => states.push(s2), pingMs: 60 });
    clients.push(c);
    c.connect(HELLO);
    await until(() => accepted.length === 1, "the first socket was never accepted");
    await until(() => c.state === "connected", "the client never reported connected");

    // the server never answers a ping - the harness records frames and replies
    // to nothing, which is precisely a peer that has stopped listening
    await until(() => accepted.length === 2, "it never gave up on a relay that stopped answering", 4000);
    expect(states, "it never left the connected state").toContain("disconnected");
  });

  /**
   * The test above gives up on a relay that stops answering pings but still
   * answers the Close frame - this harness is a live `ws` server, and it does,
   * at once. A relay that has really gone answers nothing, and closing a
   * socket waits for that answer: 30 s in the `ws` package the app runs on in
   * Electron main, 60 s in Chromium. Everything that recovers - the state, the
   * backoff, the reconnect - hung off the close event, so internet viewers went
   * without captions for that long after the heartbeat had already decided.
   */
  it("reconnects when it gives up, without waiting for a close the dead relay will not finish", async () => {
    // the first relay socket stops reading altogether: no pong, and no answer
    // to the Close frame either, which is what a peer that has gone looks like
    wss.on("connection", (ws) => {
      if (accepted.length === 1) (ws as unknown as { _socket: { pause(): void } })._socket.pause();
    });
    const c = new UplinkClient(`ws://127.0.0.1:${port}`, { pingMs: 60 });
    clients.push(c);
    c.connect(HELLO);
    await until(() => c.state === "connected", "the client never reported connected");

    await until(
      () => accepted.length === 2,
      "it gave up on the silent relay but did not try again - the retry waited on a close handshake " +
        "the dead peer will never finish",
      3000,
    );
  });

  // The same, on the implementation the app actually runs there: Electron's
  // main process is Node 20, which has no global WebSocket, so
  // getWebSocketImpl() falls back to the `ws` package - whose close waits
  // CLOSE_TIMEOUT, 30 s, for the peer's answer.
  it("reconnects the same way on the ws package Electron main runs it on", async () => {
    const real = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = WsWebSocket;
    try {
      wss.on("connection", (ws) => {
        if (accepted.length !== 1) return;
        // it reports a viewer before it goes quiet, so there is a count to reset
        ws.send(JSON.stringify({ type: "viewers", count: 3 }));
        (ws as unknown as { _socket: { pause(): void } })._socket.pause();
      });
      const states: string[] = [];
      const c = new UplinkClient(`ws://127.0.0.1:${port}`, { onState: (s2) => states.push(s2), pingMs: 60 });
      clients.push(c);
      c.connect(HELLO);
      await until(() => c.state === "connected", "the client never reported connected");
      await until(() => c.remoteViewers === 3, "the dead relay's viewer count");
      const dropped = (c as unknown as { ws: { readyState: number } }).ws;

      await until(
        () => accepted.length === 2,
        "on the ws package it gave up and then sat out the 30 s close timeout before trying again",
        3000,
      );
      // dropped outright, not left CLOSING for the 30 s the handshake would take
      expect(dropped.readyState, "the given-up socket is still waiting on a close the dead relay will not answer").toBe(3);
      expect(c.remoteViewers, "the count the dead relay last reported is still being shown").toBe(0);
      // `terminate()` fires the dropped socket's close at once. It was let go
      // of first, so that close is ignored: one give-up is one disconnect, not
      // two, and the backoff does not step twice for one dead relay
      expect(
        states.filter((s2) => s2 === "disconnected"),
        "the dropped socket's own close was counted as a second disconnect",
      ).toHaveLength(1);
    } finally {
      (globalThis as { WebSocket?: unknown }).WebSocket = real;
    }
  });

  /**
   * On the standard WebSocket - Node 22 and later, Chromium - a dropped
   * socket cannot be terminated, only closed, and its close event arrives
   * whenever the dead link finally errors: long after the reconnect has opened
   * a new socket and started its heartbeat. The heartbeat timer is the client's
   * one shared timer, and the dropped socket's onclose stopped it before asking
   * whether that socket was still the current one - so the late close quietly
   * switched off dead-relay detection on the healthy connection. Electron 33's
   * main process runs the `ws` package and terminates at once, so this is the
   * runtime the next Electron upgrade moves the app onto.
   */
  it("keeps the new connection's heartbeat when the dropped socket's close finally arrives", async () => {
    const pings = new Map<number, number>();
    wss.on("connection", (ws) => {
      const n = accepted.length;
      if (n === 1) {
        (ws as unknown as { _socket: { pause(): void } })._socket.pause();
        return;
      }
      // later relays answer every ping and count them
      ws.on("message", (data) => {
        try {
          if (JSON.parse(String(data)).type !== "ping") return;
        } catch {
          return;
        }
        pings.set(n, (pings.get(n) || 0) + 1);
        ws.send(JSON.stringify({ type: "pong" }));
      });
    });
    const c = new UplinkClient(`ws://127.0.0.1:${port}`, { pingMs: 60 });
    clients.push(c);
    c.connect(HELLO);
    await until(() => accepted.length === 2 && c.state === "connected", "the reconnect", 3000);

    // the dead link finally errors, so the dropped socket's close is delivered
    accepted[0].terminate();
    await settle(300);
    const before = pings.get(2) || 0;
    await settle(400);

    expect(
      (pings.get(2) || 0) - before,
      "the dropped socket's late close stopped the new connection's heartbeat - it would never notice this " +
        "relay going quiet either",
    ).toBeGreaterThan(0);
  });

  /**
   * Retiring a socket stops its heartbeat, and that includes `open()`
   * replacing a live one. Its onclose no longer does - it is not current by
   * then - so if `open()` did not, the old socket's timer went on ticking
   * until the new socket opened. Each tick in that window is a ping with no
   * socket to answer it, and two of them "gave up" on the NEW socket while its
   * handshake was still in flight.
   */
  it("does not give up on a socket that is still opening, off the heartbeat of the one it replaced", async () => {
    let n = 0;
    const slow = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      // the replacement's handshake takes a while, the way a remote relay's can
      verifyClient: (_info: unknown, done: (ok: boolean) => void) => {
        n += 1;
        setTimeout(() => done(true), n === 1 ? 0 : 500);
      },
    });
    const slowSockets: NodeWebSocket[] = [];
    slow.on("connection", (ws) => {
      slowSockets.push(ws);
      ws.on("message", (data) => {
        try {
          if (JSON.parse(String(data)).type === "ping") ws.send(JSON.stringify({ type: "pong" }));
        } catch {
          /* not ours */
        }
      });
    });
    await new Promise<void>((r) => slow.once("listening", r));
    const slowPort = (slow.address() as { port: number }).port;
    const states: string[] = [];
    const c = new UplinkClient(`ws://127.0.0.1:${slowPort}`, { onState: (s2) => states.push(s2), pingMs: 60 });
    try {
      c.connect(HELLO);
      await until(() => c.state === "connected", "the first connection");
      await settle(200);

      const from = states.length;
      c.connect(HELLO); // replace the live socket
      await until(() => slowSockets.length === 2 && c.state === "connected", "the replacement to open", 3000);

      expect(
        states.slice(from).filter((s2) => s2 === "disconnected"),
        "the replaced socket's heartbeat went on ticking and gave up on the replacement mid-handshake",
      ).toEqual([]);
    } finally {
      c.disconnect();
      for (const ws of slowSockets) ws.terminate();
      await new Promise<void>((r) => slow.close(() => r()));
    }
  });

  it("stays put while the relay is answering", async () => {
    const c = new UplinkClient(`ws://127.0.0.1:${port}`, { pingMs: 60 });
    clients.push(c);
    // answer every ping, the way a live relay does
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        try {
          if (JSON.parse(String(data)).type === "ping") ws.send(JSON.stringify({ type: "pong" }));
        } catch {
          /* not our frame */
        }
      });
    });
    c.connect(HELLO);
    await until(() => c.state === "connected", "the client never reported connected");

    await settle(600); // ten heartbeat rounds
    expect(accepted.length, "it tore down a connection that was answering").toBe(1);
  });
});

/**
 * What the app sends up the uplink, out of everything its relay broadcasts.
 *
 * A quiet channel produces a wordless final every couple of seconds - one
 * measured 94-minute session carried 3,105 of them against 657 real lines -
 * and every one went up the uplink. On the hosted relay each is an inbound
 * WebSocket message: a billed request, and requests are that service's binding
 * limit. On the far side it did nothing. A wordless final exists to retire the
 * interim row a partial left, and partials never cross this hop, so no hosted
 * viewer ever has one to retire. The two facts only hold together: forward a
 * partial one day and the wordless final has a job again.
 */
describe("what goes up the uplink", () => {
  const subtitle = (source: string, target?: string) =>
    ({ type: "subtitle", id: 1, source, target, final: true }) as const;

  it("sends a line with words, in either language", () => {
    expect(forwardsToUplink(subtitle("enemy down mid"))).toBe(true);
    expect(forwardsToUplink(subtitle("enemy down mid", "hạ một địch ở giữa"))).toBe(true);
    expect(forwardsToUplink(subtitle("", "hạ một địch ở giữa"))).toBe(true);
  });

  // "the translation is not coming" carries the line's own words, and a
  // hosted viewer needs it to take down the "…"
  it("sends a translation that is not coming", () => {
    expect(forwardsToUplink(subtitle("enemy down mid", ""))).toBe(true);
  });

  it("does not send a final with no words in it", () => {
    expect(forwardsToUplink(subtitle("")), "a wordless final went up the uplink - a billed request that does nothing").toBe(
      false,
    );
    expect(forwardsToUplink(subtitle("  ")), "whitespace is no more a line than nothing is").toBe(false);
    expect(forwardsToUplink(subtitle("", ""))).toBe(false);
  });

  it("never sends a partial - the reason the line above is safe", () => {
    expect(forwardsToUplink({ type: "partial", id: 1, source: "enemy do" })).toBe(false);
  });

  it("sends status, and a hello only when it says live", () => {
    expect(forwardsToUplink({ type: "status", live: false })).toBe(true);
    const hello = { type: "hello", languages: { source: "en", target: "vi" }, translates: true } as const;
    expect(forwardsToUplink({ ...hello, live: true })).toBe(true);
    expect(forwardsToUplink({ ...hello, live: false })).toBe(false);
  });

  // the decision lives here, so the app has to go through it: a forward
  // written inline in main.ts would send the wordless finals again
  it("is the gate the app's tee goes through", () => {
    const main = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "apps", "standalone", "src", "main.ts"), "utf8");
    const tee = main.slice(main.indexOf("function bridgeBroadcasts"), main.indexOf("async function refreshUsage"));
    expect(tee, "bridgeBroadcasts is not where this looks for it").toContain("relay.onBroadcast(");
    expect(tee, "the tee no longer asks forwardsToUplink before sending").toMatch(/if \(!forwardsToUplink\(msg\)\) return;/);
  });
});
