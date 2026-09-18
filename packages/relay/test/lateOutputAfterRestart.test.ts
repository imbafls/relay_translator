import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { startRelay } from "../src/server";
import type { RelayHandle } from "../src/server";
import { createMockSttStream } from "../src/deepgram";
import type { SttEvents } from "../src/deepgram";
import type { ServerToViewer } from "@callout-relay/shared";

/**
 * What a session says after the viewers have been told a new one began.
 *
 * Changing a restart-on-save setting while live - target language, a source,
 * the model - makes the app close its publisher socket and open a new one. The
 * relay builds the new session numbering from zero, mints a new epoch, and
 * every viewer clears its rows on the new hello. The old session is not
 * silent yet: its last line's translation may still be in flight, and a local
 * model's flush final routinely lands seconds after close. Both reached
 * viewers as plain subtitles carrying no epoch, so the page could not tell
 * them from the new session's own: the old line came back at the top of the
 * fresh transcript, marked latest and on the OBS overlay, and held the row the
 * new session's id N later needed - its partials refused, its final written
 * under the OLD translation.
 *
 * The line is not lost by stopping it here: the saved transcript is fed from
 * the publisher path (`onTranscript`), not this one.
 *
 * Driven over real sockets with the STT stood in through `makeStt`, which
 * hands the test each session's event hooks - so a flush final can arrive
 * exactly when a real one does, after the session has been stopped.
 */

let relay: RelayHandle;
let dir: string;
let streams: SttEvents[];
const sockets: WebSocket[] = [];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-late-"));
  streams = [];
  relay = await startRelay({
    port: 0,
    dataDir: dir,
    mockGemini: true,
    makeStt: (events) => {
      streams.push(events);
      return createMockSttStream(events, 1, ["rush B"]);
    },
  });
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

function connect(url: string): Promise<{ ws: WebSocket; seen: ServerToViewer[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const seen: ServerToViewer[] = [];
    ws.on("message", (d: Buffer) => {
      try {
        seen.push(JSON.parse(d.toString()) as ServerToViewer);
      } catch {
        /* binary */
      }
    });
    ws.once("open", () => resolve({ ws, seen }));
    ws.once("error", reject);
  });
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`${what} never happened within ${ms}ms`);
    await settle(20);
  }
}

const hello = JSON.stringify({
  type: "hello",
  stt: "deepgram-nova-3",
  translation: "gemini-3.1-flash-lite",
  languages: { source: "en", target: "vi" },
  translationEnabled: true,
  channels: 1,
});

const publisherUrl = (): string => `ws://127.0.0.1:${relay.port}/ws/publisher?token=${relay.state.publisherToken}`;
const viewerUrl = (): string => `ws://127.0.0.1:${relay.port}/ws/viewer?token=${relay.state.viewerToken}`;

const said = (msgs: ServerToViewer[], text: string): ServerToViewer[] =>
  msgs.filter((m) => m.type === "subtitle" && (m as { source?: string }).source === text);

describe("a session's output after it has been replaced", () => {
  it("does not reach viewers who have already been told a new session began", async () => {
    const viewer = await connect(viewerUrl());
    const broadcast: ServerToViewer[] = [];
    relay.onBroadcast((m) => broadcast.push(m));
    const saved: string[] = [];
    relay.onTranscript((m) => saved.push(m.source));

    const first = await connect(publisherUrl());
    first.ws.send(hello);
    await until(() => streams.length === 1, "the first session");

    // restartIfLive: the old socket closes, a new one says hello
    first.ws.close();
    const second = await connect(publisherUrl());
    second.ws.send(hello);
    await until(() => streams.length === 2, "the second session");
    await until(
      () => viewer.seen.filter((m) => m.type === "hello").length >= 2,
      "viewers being told the new session began",
    );

    // the first session's flush final, landing the way a local model's does
    streams[0]!.onFinal?.("the old last line", { channel: 0 });
    await settle(200);

    expect(
      said(viewer.seen, "the old last line"),
      "a line from the replaced session reached a viewer after that viewer had cleared its rows for the new " +
        "session - it lands at the top of the fresh transcript and takes the row the new session's id needs",
    ).toEqual([]);
    expect(
      said(broadcast, "the old last line"),
      "and it went to the broadcast listeners, which is how it reaches the hosted room and every internet viewer",
    ).toEqual([]);
    // what the streamer said is still kept: the saved transcript is fed from
    // the publisher path, which this does not touch
    expect(saved, "the saved transcript lost a line that was really said").toContain("the old last line");
  });

  it("still reaches them after a STOP, when nothing replaced it", async () => {
    const viewer = await connect(viewerUrl());
    const first = await connect(publisherUrl());
    first.ws.send(hello);
    await until(() => streams.length === 1, "the session");

    first.ws.close();
    await settle(100);
    // the last thing said before STOP: audit finding 17 is about exactly this
    // line arriving, and nothing has cleared the rows it belongs in
    streams[0]!.onFinal?.("the last words before stop", { channel: 0 });

    await until(() => said(viewer.seen, "the last words before stop").length > 0, "the last line reaching the viewer");
  });

  /**
   * A second hello on the same socket rebuilds the session carrying the
   * numbering over, so the epoch - and every row the viewer holds - survives.
   * A line the viewer is already showing as a partial can still be finished by
   * the session that started it. (A late final with no partial behind it would
   * take the new session's first id instead; that is older than this gate and
   * unreachable from the app, whose client says hello only when its socket
   * opens.)
   */
  it("still finishes a line the viewer is showing, after a rebuild that kept its rows", async () => {
    const viewer = await connect(viewerUrl());
    const pub = await connect(publisherUrl());
    pub.ws.send(hello);
    await until(() => streams.length === 1, "the session");
    // say something, so the rebuild carries the numbering over and keeps the epoch
    const timer = setInterval(() => {
      if (pub.ws.readyState === WebSocket.OPEN) pub.ws.send(Buffer.alloc(16000 * 2 * 2, 1));
    }, 60);
    try {
      await until(() => said(viewer.seen, "rush B").length > 0, "a first caption");
    } finally {
      clearInterval(timer);
    }

    // a line under way when the rebuild lands: the viewer is showing its partial
    streams[0]!.onPartial?.("half a line", 0);
    await until(
      () => viewer.seen.some((m) => m.type === "partial" && (m as { source?: string }).source === "half a line"),
      "the partial on the viewer",
    );
    const showing = viewer.seen.filter((m) => m.type === "partial").pop() as unknown as { id: number };

    // a second hello on the same socket: the rows survive, the ids continue
    pub.ws.send(hello);
    await until(() => streams.length === 2, "the rebuilt session");
    streams[0]!.onFinal?.("half a line, finished", { channel: 0 });

    await until(
      () => said(viewer.seen, "half a line, finished").length > 0,
      "the line the viewer was showing being finished",
    );
    const finished = said(viewer.seen, "half a line, finished")[0] as unknown as { id: number };
    expect(finished.id, "the late final did not land on the row the viewer was showing").toBe(showing.id);
  });
});
