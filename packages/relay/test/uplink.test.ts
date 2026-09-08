import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { startRelay } from "../src/server";
import type { RelayHandle } from "../src/server";
import { MAX_BRAND_NAME } from "@callout-relay/shared";

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
  /**
   * Refused with a close code on an OPEN socket, not with a 401 during the
   * handshake. UplinkClient reads close codes and stops on 4401; a failed
   * handshake reaches it as 1006, which it cannot tell from a dropped network,
   * so a wrong token retried for ever behind "RELAY CONNECTING..." and the
   * RELAY ERROR - CHECK KEYS state could never fire. Audit finding 24.
   */
  const closeCodeFor = (token: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${remote.port}/ws/uplink?token=${token}`);
      const timer = setTimeout(() => reject(new Error("no close arrived")), 4000);
      ws.on("close", (code: number) => {
        clearTimeout(timer);
        resolve(code);
      });
      ws.on("error", () => {
        clearTimeout(timer);
        resolve(1006);
      });
    });

  it("refuses the viewer token with a code the client can act on", async () => {
    await expect(closeCodeFor(remote.state.viewerToken)).resolves.toBe(4401);
  });

  it("refuses a socket carrying no token the same way", async () => {
    await expect(closeCodeFor("")).resolves.toBe(4401);
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

describe("what survives the hop to an internet viewer", () => {
  /**
   * A subtitle is re-emitted by hand at every hop, field by field, and each of
   * those literals is typed `& SpeakerTag` - which HAS `color`. Two of the three
   * simply did not copy it, so per-speaker colour worked on the LAN and silently
   * did nothing for anyone watching over the internet. No error, no log, and
   * TypeScript content throughout, because omitting an optional field is legal.
   *
   * This drives the real relay over real sockets: an uplink publishes a tagged
   * caption, a viewer on that relay reads it back.
   */
  it("carries the speaker's colour, not just their name", async () => {
    const phone = await connect(url(remote, "/ws/viewer", remote.state.viewerToken));
    const up = await connect(url(remote, "/ws/uplink", remote.state.publisherToken));
    await up.until(isType("ready"), "ready");

    up.ws.send(
      JSON.stringify({
        type: "hello",
        languages: { source: "en", target: "vi" },
        translates: true,
        since: 1_788_000_000_000,
      }),
    );
    up.ws.send(
      JSON.stringify({
        type: "subtitle",
        id: 1,
        source: "rotate A, spike is down",
        final: true,
        channel: 1,
        speaker: "OMER",
        color: "#e0a43a",
      }),
    );

    const line = await phone.until(isType("subtitle"), "the caption");
    expect(line.speaker, "the name did not survive either").toBe("OMER");
    expect(line.color, "the colour was dropped on the way to the viewer").toBe("#e0a43a");
  });
});

/**
 * The case the whole branding design is shaped around, and the one test the
 * spec asked for by name that was never written. A brand rides `hello` because
 * `hello` is the only frame a late joiner is guaranteed to receive: somebody
 * opening the link twenty minutes in has to see what somebody there at the
 * start saw.
 *
 * Nothing behavioural covered the uplink -> viewer hello rebuild in
 * `server.ts` before this. `speakerTag.test.ts` reads the hello LITERALS and
 * so cannot see whether the brand was ever stored to spread into them, and
 * that is the half this drives: real relay, real sockets, the brand announced
 * before the viewer that reads it exists.
 */
describe("whose captions a late joiner is looking at", () => {
  /**
   * Announce a brand on the uplink and return the hello a viewer that was
   * ALREADY watching received.
   *
   * The wait is not politeness. Nothing acknowledges an uplink hello, so
   * connecting the late viewer straight after the send would race a socket
   * upgrade against a message and pass or fail on scheduling. A viewer
   * attached beforehand is the relay telling us it has processed the hello.
   */
  async function announced(brand: Record<string, unknown>): Promise<Msg> {
    const watching = await connect(url(remote, "/ws/viewer", remote.state.viewerToken));
    const up = await connect(url(remote, "/ws/uplink", remote.state.publisherToken));
    await up.until(isType("ready"), "ready");
    up.ws.send(
      JSON.stringify({
        type: "hello",
        languages: { source: "en", target: "vi" },
        translates: true,
        since: 1_788_000_000_000,
        ...brand,
      }),
    );
    return watching.until(
      (m) => m.type === "hello" && typeof m.brandName === "string" && (m.brandName as string).length > 0,
      "the announced brand reaching a viewer that was already watching",
    );
  }

  /** the phone that opens the link after the stream started */
  async function lateJoiner(): Promise<Msg> {
    // a second viewer on the same token replaces the first, which is exactly
    // what a friend opening the link a while in looks like from here
    const late = await connect(url(remote, "/ws/viewer", remote.state.viewerToken));
    return late.until(isType("hello"), "the greeting a late joiner gets");
  }

  it("greets a viewer who opened the link afterwards with the brand", async () => {
    await announced({ brandName: "SuprKernel Callouts", brandColor: "#e0a43a" });
    const greeting = await lateJoiner();

    expect(greeting.brandName, "a late joiner was never told whose captions these are").toBe(
      "SuprKernel Callouts",
    );
    expect(greeting.brandColor, "the brand colour was dropped on the way to a late joiner").toBe(
      "#e0a43a",
    );
  });

  it("tells a viewer already watching when the uplink says nobody is actually streaming", async () => {
    const greeting = await announced({ brandName: "SuprKernel Callouts", live: false });
    expect(greeting.live, "the hello rebuild hardcoded live regardless of what the uplink said").toBe(false);
  });

  it("caps and validates that brand, the way the publisher hello already does", async () => {
    // Straight off a socket. Both sibling hops sanitise - `publisherHello()`
    // on the LAN path and the hosted relay's `safeBrandName`/`safeColor` on
    // the internet one - and the relay binary that accepts this socket is
    // built and attached to every release, so the 24-character cap the spec,
    // both sanitisers and the changelog all promise has to hold here too.
    const relayed = await announced({
      brandName: "x".repeat(200_000),
      brandColor: "#fff; background: url(http://evil/)",
    });
    expect(
      (relayed.brandName as string).length,
      "an uncapped name reached a viewer that was already watching",
    ).toBe(MAX_BRAND_NAME);
    expect(
      relayed.brandColor,
      "a colour carrying its own CSS reached a viewer that was already watching",
    ).toBeUndefined();

    const greeting = await lateJoiner();
    expect(
      (greeting.brandName as string).length,
      "the relay stored an uncapped name and replayed it to a late joiner",
    ).toBe(MAX_BRAND_NAME);
    expect(
      greeting.brandColor,
      "the relay stored a colour that is not #rrggbb and replayed it to a late joiner",
    ).toBeUndefined();
  });
});
