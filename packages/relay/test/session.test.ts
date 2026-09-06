import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerToViewer } from "@callout-relay/shared";
import { PublisherSession } from "../src/session";
import type { SttEvents } from "../src/deepgram";
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

describe("a speech pipeline that dies under a live session", () => {
  /**
   * Audit finding 11. When the STT socket closed on its own - Deepgram 1011, a
   * quota, an idle timeout - the session logged a line, told viewers
   * `live: false`, and called `setLive(false)`, which at the server was
   * `() => {}`. Nothing reached the publisher app: `onSttError` was wired only
   * to `onError`, never to `onClose`. So the desktop stayed ON AIR with the
   * clock running, every chunk was dropped by a readyState guard, and billed
   * seconds kept accruing for audio that never left the process.
   *
   * The app's own socket to the relay is untouched by any of this, which is
   * exactly why nothing noticed.
   */
  function dying() {
    const viewers: ServerToViewer[] = [];
    const errors: string[] = [];
    const liveCalls: boolean[] = [];
    let closeIt: (() => void) | undefined;
    const session = new PublisherSession(
      {
        stt: "deepgram-nova-3",
        translation: "gemini-3.1-flash-lite",
        languages: { source: "en", target: "vi" },
        translationEnabled: false,
        latencyVisible: true,
        profanityFilter: false,
        channels: 1,
      },
      {
        // a stand-in for the socket, not for the session: it hands the test the
        // close callback so the death can happen the way Deepgram's does
        makeStt: (events: SttEvents) => {
          // a closed socket refuses the chunk, the way Deepgram's readyState
          // guard does - a fake that kept accepting would hide the whole bug
          let open = true;
          closeIt = () => {
            open = false;
            events.onClose?.();
          };
          setImmediate(() => events.onOpen?.());
          return { sendAudio: () => open, close: () => { open = false; } };
        },
        toViewers: (msg: ServerToViewer) => viewers.push(msg),
        setLive: (live: boolean) => liveCalls.push(live),
        onSttError: (message: string) => errors.push(message),
        log: () => {},
        sttStats: { seconds: 0, localSeconds: 0 },
      },
    );
    return { session, viewers, errors, liveCalls, kill: () => closeIt?.() };
  }

  it("tells the publisher app, not just the log", async () => {
    const d = dying();
    d.session.start();
    await tick();
    d.kill();
    await tick();
    expect(d.errors.length, "the app was never told the speech pipeline died").toBeGreaterThan(0);
    d.session.stop();
  });

  it("says it is no longer live", async () => {
    const d = dying();
    d.session.start();
    await tick();
    d.kill();
    await tick();
    expect(d.liveCalls).toContain(false);
    expect(d.viewers.some((m) => m.type === "status" && m.live === false)).toBe(true);
    d.session.stop();
  });

  it("stops billing for audio that is no longer going anywhere", async () => {
    const d = dying();
    const stats = { seconds: 0, localSeconds: 0 };
    (d.session as unknown as { deps: { sttStats: typeof stats } }).deps.sttStats = stats;
    d.session.start();
    await tick();
    d.session.audio(Buffer.alloc(SAMPLE_RATE * 2 * 2, 1));
    const billedWhileAlive = stats.seconds;
    expect(billedWhileAlive, "nothing was billed even while it worked").toBeGreaterThan(0);

    d.kill();
    await tick();
    d.session.audio(Buffer.alloc(SAMPLE_RATE * 2 * 2, 1));
    expect(stats.seconds, "billed seconds kept accruing after the stream was gone").toBe(billedWhileAlive);
    d.session.stop();
  });
});

describe("a translation that keeps failing", () => {
  /**
   * Audit finding 22. `geminiErrorLogged` latched for the life of the session
   * and was never reset, and `SessionDeps` had no publisher-facing hook for
   * translation errors at all - unlike `onSttError`.
   *
   * Minute 1: one transient 503 exhausts the retries and burns the latch. One
   * line goes to the Electron main-process console, which in a packaged build
   * goes nowhere. Minute 40: the Gemini quota is hit and every translate()
   * rejects - and the latch suppresses all of it. Viewers keep getting
   * source-only subtitles whose target half sits on the "..." placeholder
   * forever, and neither the app log nor the viewer ever says why. A revoked
   * key and a safety-blocked response are equally silent.
   */
  function failing(reason: string) {
    const viewers: ServerToViewer[] = [];
    const errors: string[] = [];
    const logs: string[] = [];
    const session = new PublisherSession(
      {
        stt: "deepgram-nova-3",
        translation: "gemini-3.1-flash-lite",
        languages: { source: "en", target: "vi" },
        translationEnabled: true,
        latencyVisible: true,
        profanityFilter: false,
        channels: 1,
      },
      {
        mockStt: true,
        translator: { translate: async () => Promise.reject(new Error(reason)) },
        toViewers: (msg: ServerToViewer) => viewers.push(msg),
        setLive: () => {},
        onTranslateError: (message: string) => errors.push(message),
        log: (_level: string, message: string) => logs.push(message),
      },
    );
    return { session, viewers, errors, logs };
  }

  it("tells the app the first time, instead of only the console", async () => {
    const f = failing("429 quota exceeded");
    f.session.start();
    await tick();
    f.session.audio(oneUtterance());
    await tick(60);
    f.session.stop();

    expect(f.errors.length, "the app was never told translation had stopped working").toBeGreaterThan(0);
    expect(f.errors[0]).toContain("429");
  });

  it("tells it again later, rather than latching for the life of the session", async () => {
    // The latch is the defect: one transient failure in minute 1 silenced the
    // quota wall in minute 40. Reporting is rate-limited by wall clock, so the
    // clock is what has to move - a test that only takes 200 ms would see one
    // report either way and prove nothing about the latch.
    const real = Date.now;
    let now = real();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const f = failing("429 quota exceeded");
      f.session.start();
      await tick();
      for (let i = 0; i < 4; i++) {
        f.session.audio(oneUtterance());
        await tick(30);
        now += 40_000; // well past the reporting interval
      }
      f.session.stop();
      expect(f.errors.length, "a permanent failure was reported once and then never again").toBeGreaterThan(1);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it("does not report every single failure, which would be its own noise", async () => {
    const f = failing("429 quota exceeded");
    f.session.start();
    await tick();
    let utterances = 0;
    for (let i = 0; i < 8; i++) {
      f.session.audio(oneUtterance());
      utterances += 1;
      await tick(20);
    }
    f.session.stop();
    expect(f.errors.length).toBeLessThan(utterances);
  });

  it("says nothing when translation is working", async () => {
    const viewers: ServerToViewer[] = [];
    const errors: string[] = [];
    const session = new PublisherSession(
      {
        stt: "deepgram-nova-3",
        translation: "gemini-3.1-flash-lite",
        languages: { source: "en", target: "vi" },
        translationEnabled: true,
        latencyVisible: true,
        profanityFilter: false,
        channels: 1,
      },
      {
        mockStt: true,
        translator: slowTranslator(0),
        toViewers: (msg: ServerToViewer) => viewers.push(msg),
        setLive: () => {},
        onTranslateError: (message: string) => errors.push(message),
        log: () => {},
      },
    );
    session.start();
    await tick();
    session.audio(oneUtterance());
    await tick(60);
    session.stop();
    expect(errors).toEqual([]);
  });
});
