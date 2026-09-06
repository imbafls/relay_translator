import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerToViewer } from "@callout-relay/shared";
import { PublisherSession } from "../src/session";
import type { Translator } from "../src/gemini";

/**
 * The real PublisherSession runs here: its segment ids, its final-then-patch
 * broadcast order and its stop path are all genuine. Only the two external
 * engines are stood in for - STT through the session's own mockStt seam, and
 * Gemini through a translator whose latency the test controls.
 */

const SAMPLE_RATE = 16000;
/** the mock STT emits one final per 2 s of mono audio */
const oneUtterance = (): Buffer => Buffer.alloc(SAMPLE_RATE * 2 * 2, 1);

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** resolves after `delayMs`, and lets the test see how many calls are pending */
function slowTranslator(delayMs: number): Translator & { pending: number } {
  const t = {
    pending: 0,
    async translate(text: string): Promise<string> {
      t.pending += 1;
      await tick(delayMs);
      t.pending -= 1;
      return `[vi] ${text}`;
    },
  };
  return t;
}

function makeSession(translator: Translator) {
  const viewers: ServerToViewer[] = [];
  const session = new PublisherSession(
    {
      stt: "deepgram-nova-3",
      translation: "gemini-3.1-flash-lite",
      languages: { source: "en", target: "vi" },
      translationEnabled: true,
      latencyVisible: true,
      // off here so these assertions read against the exact mock lines
      profanityFilter: false,
      channels: 1,
    },
    {
      mockStt: true,
      translator,
      toViewers: (msg) => viewers.push(msg),
      setLive: () => {},
      log: () => {},
    },
  );
  return { session, viewers };
}

const translated = (viewers: ServerToViewer[]) =>
  viewers.filter((m): m is Extract<ServerToViewer, { type: "subtitle" }> => m.type === "subtitle" && !!m.target);

describe("source text and translation ordering", () => {
  it("sends the source subtitle before the translation patches it", async () => {
    const { session, viewers } = makeSession(slowTranslator(50));
    session.start();
    await tick();
    session.audio(oneUtterance());

    const sourceFirst = viewers.findIndex((m) => m.type === "subtitle");
    expect(sourceFirst).toBeGreaterThanOrEqual(0);
    const first = viewers[sourceFirst] as Extract<ServerToViewer, { type: "subtitle" }>;
    expect(first.target).toBeUndefined();

    await tick(120);
    const patched = translated(viewers);
    expect(patched).toHaveLength(1);
    // the patch reuses the segment id, so viewers update the row in place
    expect(patched[0].id).toBe(first.id);
    session.stop();
  });

  it("keeps one segment id per utterance so a slow translation cannot reorder rows", async () => {
    const { session, viewers } = makeSession(slowTranslator(30));
    session.start();
    await tick();
    session.audio(oneUtterance());
    session.audio(oneUtterance());

    // both source lines are out before either translation resolves
    const sources = viewers.filter((m) => m.type === "subtitle") as Extract<
      ServerToViewer,
      { type: "subtitle" }
    >[];
    expect(sources).toHaveLength(2);
    expect(sources[0].id).not.toBe(sources[1].id);
    expect(sources.every((s) => s.target === undefined)).toBe(true);

    await tick(120);
    const patched = translated(viewers);
    expect(patched.map((p) => p.id).sort()).toEqual(sources.map((s) => s.id).sort());
    session.stop();
  });
});

describe("stopping while a translation is still running", () => {
  it("stop() returns without waiting for the translation", async () => {
    const translator = slowTranslator(200);
    const { session } = makeSession(translator);
    session.start();
    await tick();
    session.audio(oneUtterance());
    expect(translator.pending).toBe(1);

    session.stop();
    // stop is synchronous: the call is still in flight when it returns
    expect(translator.pending).toBe(1);
    await tick(260);
  });

  it("drain() waits for the outstanding translation", async () => {
    const translator = slowTranslator(150);
    const { session, viewers } = makeSession(translator);
    session.start();
    await tick();
    session.audio(oneUtterance());
    expect(translated(viewers)).toHaveLength(0);

    session.stop();
    const outstanding = await session.drain(2000);

    expect(outstanding).toBe(0);
    expect(translator.pending).toBe(0);
    expect(translated(viewers)).toHaveLength(1);
  });

  it("drain() gives up on a translator that never answers", async () => {
    const stuck: Translator = { translate: () => new Promise<string>(() => {}) };
    const { session } = makeSession(stuck);
    session.start();
    await tick();
    session.audio(oneUtterance());

    session.stop();
    const outstanding = await session.drain(120);
    expect(outstanding).toBe(1);
  });
});

describe("latency across a gap in the audio", () => {
  // only Date is faked, so the session's own async work still runs for real
  afterEach(() => {
    vi.useRealTimers();
  });

  /** one 100 ms frame of 16 kHz mono s16le, the size capture actually posts */
  const frame = (): Buffer => Buffer.alloc(16000 * 2 * 0.1, 1);

  /** feed `seconds` of audio in real 100 ms frames, advancing the clock with it */
  function speak(session: PublisherSession, seconds: number, at: number): number {
    for (let i = 0; i < seconds * 10; i += 1) {
      at += 100;
      vi.setSystemTime(at);
      session.audio(frame());
    }
    return at;
  }

  const latencies = (viewers: ServerToViewer[]) =>
    viewers
      .filter((m): m is Extract<ServerToViewer, { type: "subtitle" }> => m.type === "subtitle")
      .map((m) => m.latency?.stt)
      .filter((v): v is number => v !== undefined);

  it("stays honest after the publisher mutes for half a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_000_000;
    vi.setSystemTime(t0);

    const { session, viewers } = makeSession(slowTranslator(0));
    session.start();
    await tick();

    // two seconds of speech, wall clock and audio clock advancing together
    let at = speak(session, 2, t0);
    const beforeMute = latencies(viewers);
    expect(beforeMute).toHaveLength(1);
    expect(beforeMute[0]).toBeLessThan(500);

    // muted: the worklet emits nothing at all, so no audio arrives for 30 s
    at += 30_000;
    vi.setSystemTime(at);

    // unmute and speak again
    speak(session, 2, at);
    const after = latencies(viewers);
    expect(after).toHaveLength(2);
    // without the gap accounting this reads ~30000 and never recovers
    expect(after[1]).toBeLessThan(500);

    session.stop();
  });
});

describe("the colour a speaker's tag carries", () => {
  /**
   * With three sources the tag is the only thing telling speakers apart, and
   * the viewer coloured them with one binary class - "YOU" against everyone
   * else - so CHAT and COACH came out identical. The colour travels per
   * channel now, chosen by the streamer.
   */
  function coloured(colors?: string[], labels = ["YOU", "CHAT"]) {
    const viewers: ServerToViewer[] = [];
    const session = new PublisherSession(
      {
        stt: "deepgram-nova-3",
        translation: "gemini-3.1-flash-lite",
        languages: { source: "en", target: "vi" },
        translationEnabled: false,
        latencyVisible: true,
        profanityFilter: false,
        channels: 2,
        channelLabels: labels,
        channelColors: colors,
      },
      { mockStt: true, toViewers: (msg) => viewers.push(msg), setLive: () => {}, log: () => {} },
    );
    return { session, viewers };
  }
  const tags = (viewers: ServerToViewer[]) =>
    viewers.filter((m): m is Extract<ServerToViewer, { type: "subtitle" }> => m.type === "subtitle");

  it("puts each channel's colour on its captions", async () => {
    const { session, viewers } = coloured(["#e0a43a", "#7fb6d9"]);
    session.start();
    await tick();
    // the mock emits at most one line per call, alternating channels, so two
    // calls are what it takes to hear from both
    const twoSeconds = Buffer.alloc(SAMPLE_RATE * 2 * 2 * 2, 1);
    session.audio(twoSeconds);
    session.audio(twoSeconds);
    await tick(20);
    session.stop();

    const seen = new Map<number, string | undefined>();
    for (const t of tags(viewers)) seen.set(t.channel ?? 0, t.color);
    expect(seen.get(0)).toBe("#e0a43a");
    expect(seen.get(1)).toBe("#7fb6d9");
  });

  it("leaves the colour off when the publisher named none, so the viewer keeps its own", async () => {
    const { session, viewers } = coloured(undefined);
    session.start();
    await tick();
    session.audio(Buffer.alloc(SAMPLE_RATE * 2 * 2 * 2, 1));
    await tick(20);
    session.stop();
    expect(tags(viewers).length).toBeGreaterThan(0);
    for (const t of tags(viewers)) expect(t.color).toBeUndefined();
  });

  it("still tags the channel and speaker when only some slots have a colour", async () => {
    const { session, viewers } = coloured(["#e0a43a"]);
    session.start();
    await tick();
    const twoSeconds = Buffer.alloc(SAMPLE_RATE * 2 * 2 * 2, 1);
    session.audio(twoSeconds);
    session.audio(twoSeconds);
    await tick(20);
    session.stop();
    const byChannel = new Map<number, Extract<ServerToViewer, { type: "subtitle" }>>();
    for (const t of tags(viewers)) byChannel.set(t.channel ?? 0, t);
    expect(byChannel.get(0)?.color).toBe("#e0a43a");
    expect(byChannel.get(1)?.color).toBeUndefined();
    expect(byChannel.get(1)?.speaker).toBe("CHAT");
  });
});
