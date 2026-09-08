import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerToViewer } from "@callout-relay/shared";
import { PublisherSession } from "../src/session";
import type { SttEvents, SttStream } from "../src/deepgram";
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

describe("latency across a stream reopen", () => {
  /**
   * Task 4. `streamWallStart` is stamped once, on the session's first audio
   * frame, and never reset. But Deepgram's word `end` timings - and the local
   * worker's `fed / SAMPLE_RATE` - restart at zero on every new socket, and
   * the reopen ladder builds a new socket without touching `streamWallStart`.
   * So from the first reconnect on, the badge reads the wall-clock age of the
   * whole SESSION, not the age of the caption. An audit reproduced 603000 ms
   * ten minutes in. `silentMs` cannot compensate: `audio()` advances
   * `lastAudioAt` on every chunk whether or not the socket accepted it, so
   * audio arriving through a reconnect records no gap either.
   */

  // only Date is faked; the reopen ladder's own setTimeout runs for real, so
  // this waits on it for real rather than advancing fake timers
  afterEach(() => {
    vi.useRealTimers();
  });

  const finals = (viewers: ServerToViewer[]) =>
    viewers.filter(
      (m): m is Extract<ServerToViewer, { type: "subtitle" }> => m.type === "subtitle" && !!m.final,
    );

  it("measures against the stream in hand, not the whole session's age", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_000_000;
    vi.setSystemTime(t0);

    const viewers: ServerToViewer[] = [];
    let events: SttEvents | undefined;
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
        // a stand-in for the socket - fires onOpen fresh on every call,
        // exactly as Deepgram's own ws "open" does on a reconnect
        makeStt: (ev: SttEvents) => {
          events = ev;
          setImmediate(() => ev.onOpen?.());
          return { sendAudio: () => true, close() {} };
        },
        // a fast ladder: the point is a real reopen, not a twelve-second test
        sttReopenDelaysMs: [10],
        toViewers: (msg: ServerToViewer) => viewers.push(msg),
        setLive: () => {},
        log: () => {},
      },
    );

    session.start();
    await tick(); // let the first stream's onOpen fire
    session.audio(Buffer.alloc(1)); // the session's first audio byte

    // ten minutes pass with the session alive - long enough that the badge
    // reading the SESSION's age, rather than the stream's, is unmistakable
    vi.setSystemTime(t0 + 10 * 60 * 1000);

    // the socket drops; the reopen ladder rebuilds a new one
    events?.onClose?.();
    await tick(50); // the real 10ms ladder delay, then the reopen's own onOpen

    // the new stream's word timings restart near zero, the way Deepgram's and
    // the local worker's both do on a fresh socket
    vi.setSystemTime(t0 + 10 * 60 * 1000 + 100);
    events?.onFinal?.("enemy down mid", { audioEndSec: 0.05, channel: 0 });

    const last = finals(viewers).at(-1);
    expect(last, "no final reached the viewer after the reopen").toBeDefined();
    // ~100 ms real gap between the reopen and the final, not ~10 minutes
    expect(last!.latency?.stt, `latency badge read ${last!.latency?.stt}ms`).toBeLessThan(1000);

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

describe("a speech socket that comes back", () => {
  /**
   * The rest of audit finding 11. Surfacing the death was the first half; there
   * was still no reconnect anywhere in `packages/relay` - only `gemini.ts` has
   * a retry ladder. So a Deepgram socket dropped by a blip, an idle timeout or
   * a brief network fault ended captions for the whole session, and the only
   * way back was for the streamer to notice and restart.
   */

  // only the "keeps trying after the ladder is spent" test below fakes timers,
  // to jump past the endless tail's 30 s interval without a slow real wait;
  // this restores real timers unconditionally so it is a no-op for every test
  // that never touched them
  afterEach(() => {
    vi.useRealTimers();
  });

  function flaky(opts: { failReopens?: number; offline?: boolean } = {}) {
    const viewers: ServerToViewer[] = [];
    const errors: string[] = [];
    const logs: { level: "info" | "warn" | "error"; message: string }[] = [];
    const built: { kill: () => void }[] = [];
    let toFail = opts.failReopens ?? 0;
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
        makeStt: (events: SttEvents) => {
          let open = true;
          const kill = (): void => {
            if (!open) return;
            open = false;
            // opts.offline mirrors a real offline machine, where the socket
            // reports the DNS failure through onError before it reports
            // onClose - this is the ordering Finding 2's byte math was
            // measured against
            if (opts.offline) events.onError?.("getaddrinfo ENOTFOUND relay.example");
            events.onClose?.();
          };
          built.push({ kill });
          // the FIRST stream always opens - the session under test is one that
          // was working and then lost its socket. Only reopens are made to fail.
          if (built.length > 1 && toFail > 0) {
            toFail -= 1;
            setImmediate(kill);
          } else {
            setImmediate(() => events.onOpen?.());
          }
          return { sendAudio: () => open, close: () => { open = false; } };
        },
        // a short ladder: the point is the shape - retry, back off, give up -
        // and the real one takes twelve seconds to reach its end
        sttReopenDelaysMs: [20, 40, 60],
        toViewers: (msg: ServerToViewer) => viewers.push(msg),
        setLive: () => {},
        onSttError: (message: string) => errors.push(message),
        log: (level, message) => logs.push({ level, message }),
      },
    );
    return { session, viewers, errors, logs, built };
  }

  const liveAgain = (viewers: ServerToViewer[]): number =>
    viewers.filter((m) => m.type === "status" && m.live === true).length;

  it("reopens the stream instead of ending the session", async () => {
    const f = flaky();
    f.session.start();
    await tick();
    expect(f.built).toHaveLength(1);

    f.built[0].kill();
    await tick(120);

    expect(f.built.length, "the stream was never reopened").toBeGreaterThan(1);
    expect(liveAgain(f.viewers), "viewers were never told it was back").toBeGreaterThan(1);
    f.session.stop();
  });

  it("keeps trying when the first reopen also fails", async () => {
    const f = flaky({ failReopens: 1 });
    f.session.start();
    await tick();
    f.built[0].kill();
    await tick(200);

    expect(f.built.length, "one failed reopen ended it").toBeGreaterThan(2);
    f.session.stop();
  });

  it("the fast ladder is bounded and hands off to a slow tail instead of hammering", async () => {
    // Renamed by fix-round Finding 1. This used to be named "gives up
    // eventually and says so, rather than retrying for ever" - true of the
    // code this test was written against, false now that the session retries
    // for ever by design (see "keeps trying after the ladder is spent"
    // below). What this test actually exercises hasn't changed: the fast
    // ladder in this test is only 120ms (20+40+60) long, so by 400ms real
    // time it has been walked to its end and handed off to the slow tail.
    const f = flaky({ failReopens: 50 });
    f.session.start();
    await tick();
    f.built[0].kill();
    await tick(400);

    // it must have actually RETRIED across the ladder - asserting only that
    // an error was reported passes against code that never retries at all,
    // because the first close already reports one
    expect(f.built.length, "it never retried, so there was nothing to hand off from").toBeGreaterThan(2);
    // this is really pinning STT_REOPEN_TAIL_MS (30s), not a retry ceiling:
    // real time only advances 400ms here, which is long enough to walk the
    // whole fast ladder but nowhere near long enough for the tail's own 30s
    // interval to fire again. If STT_REOPEN_TAIL_MS ever drops anywhere
    // close to 400ms this assertion starts failing for a reason that has
    // nothing to do with a retry ceiling - there isn't one any more.
    expect(f.built.length, "a reopen came from inside the tail's own interval").toBeLessThan(12);
    expect(f.errors.some((e) => /exhausted/i.test(e)), `errors were: ${f.errors.join(" | ")}`).toBe(true);
    f.session.stop();
  });

  it("does not reopen when a stop lands while a reconnect is armed", async () => {
    // Stopping a HEALTHY session proves nothing: close() does not fire
    // onClose - createDeepgramStream sets closedByUs first - so no reopen is
    // ever armed and the assertion passes against any implementation. The race
    // that matters is a socket that dropped, a reopen scheduled, and the user
    // pressing STOP before it fires.
    const f = flaky();
    f.session.start();
    await tick();
    f.built[0].kill();
    const before = f.built.length;
    f.session.stop();
    await tick(200);

    expect(f.built.length, "a reopen armed before STOP fired into a stopped session").toBe(before);
  });

  it("keeps trying after the ladder is spent", async () => {
    // failReopens is far bigger than the 3-rung test ladder so every reopen -
    // including ones past the ladder's own end - fails and forces another
    vi.useFakeTimers();
    const f = flaky({ failReopens: 10 });
    f.session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.built).toHaveLength(1);

    f.built[0].kill();
    // walk the whole fast ladder (20 + 40 + 60 ms) - every reopen it makes
    // fails too, so this runs STT_REOPEN_DELAYS_MS all the way to its end
    await vi.advanceTimersByTimeAsync(200);
    const afterLadder = f.built.length;
    expect(afterLadder, "the fast ladder was never walked to its end").toBeGreaterThan(3);

    // against current code the ladder running out arms no further timer, so
    // nothing more ever happens from here - jump past the new tail interval
    // and look for one more makeStt call
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.built.length, "no reopen came after the ladder ran out").toBeGreaterThan(afterLadder);

    f.session.stop();
  });

  it("writes the give-up to disk, not only to the app's error channel", async () => {
    const f = flaky({ failReopens: 10 });
    f.session.start();
    await tick();
    f.built[0].kill();
    // walk the fast ladder to exhaustion, same distance as the "gives up
    // eventually" test above
    await tick(200);

    const errorLogs = f.logs.filter((l) => l.level === "error");
    expect(
      errorLogs.some((l) => /exhausted/i.test(l.message)),
      `error-level log lines were: ${errorLogs.map((l) => l.message).join(" | ") || "(none)"}`,
    ).toBe(true);
    f.session.stop();
  });

  it("stops narrating the same outage once the tail takes over, but keeps retrying underneath", async () => {
    // Fix-round Finding 2. The whole cycle - the warn, the viewer broadcast,
    // the give-up line, and (in the real offline case) onError's own line -
    // repeated every 30s forever once the tail took over: ~295 bytes/cycle,
    // about 850 KB/day, enough to evict the give-up line itself, and
    // everything logged before it, from the 1 MB relay.log within about a
    // day. This pins that each of those sources announces the transition
    // once and then goes quiet, while the retry underneath keeps happening
    // regardless - silence must not mean it stopped trying.
    vi.useFakeTimers();
    const f = flaky({ failReopens: 20, offline: true });
    f.session.start();
    await vi.advanceTimersByTimeAsync(0);
    f.built[0].kill();
    // walk the fast ladder (20 + 40 + 60 ms) to exhaustion - this is the
    // real transition into the degraded state, and everything logged here
    // is expected and wanted
    await vi.advanceTimersByTimeAsync(200);
    const errorsAtGiveUp = f.logs.filter((l) => l.level === "error").length;
    const warnsAtGiveUp = f.logs.filter((l) => l.level === "warn").length;
    const lostBroadcastsAtGiveUp = f.viewers.filter((m) => m.type === "status" && m.live === false).length;
    expect(errorsAtGiveUp, "the give-up transition itself produced no error log").toBeGreaterThan(0);
    expect(warnsAtGiveUp, "the ladder's own closes produced no warn log").toBeGreaterThan(0);

    // three more tail cycles (90s into what could be a week-long outage) -
    // none of the above should grow, because nothing new is true that a
    // reader wasn't already told
    await vi.advanceTimersByTimeAsync(3 * 30_000);

    expect(
      f.logs.filter((l) => l.level === "error").length,
      "an error line repeated on every tail cycle instead of announcing the outage once",
    ).toBe(errorsAtGiveUp);
    expect(
      f.logs.filter((l) => l.level === "warn").length,
      `"stt closed unexpectedly" kept repeating into the tail`,
    ).toBe(warnsAtGiveUp);
    expect(
      f.viewers.filter((m) => m.type === "status" && m.live === false).length,
      `"speech pipeline lost" kept broadcasting into the tail`,
    ).toBe(lostBroadcastsAtGiveUp);

    // silence must not mean it stopped trying
    expect(f.built.length, "the tail went quiet AND stopped retrying").toBeGreaterThan(4);

    f.session.stop();
  });

  it("keeps the reopen chain alive even if openStt itself throws synchronously", async () => {
    // Fix-round Finding 4. armReopen's callback called openStt with no
    // try/catch. Every guarded failure inside openStt returns a fail() stub
    // instead of throwing, so this was not reachable through this package's
    // own code - but the guarantee this task now makes is that the reopen
    // chain never terminates, and a synchronous throw out of a custom
    // makeStt (an embedder's own engine, not this package's) is the one way
    // left to end it silently, with reopenTimer already null and nothing
    // re-armed behind it.
    vi.useFakeTimers();
    const logs: { level: "info" | "warn" | "error"; message: string }[] = [];
    let calls = 0;
    // captured from the first makeStt call so the test can kill the stream
    // by hand, the same events object the session itself reuses across
    // every reopen (per its own "rebuilt on every open" comment on start())
    let firstEvents: SttEvents | undefined;
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
        makeStt: (events: SttEvents) => {
          calls += 1;
          if (calls === 1) {
            firstEvents = events;
            setImmediate(() => events.onOpen?.());
            return { sendAudio: () => true, close() {} };
          }
          if (calls === 2) {
            // the reopen ladder's first attempt throws synchronously,
            // instead of going through the normal fail() stub every other
            // failure in this package uses
            throw new Error("synchronous boom from a custom makeStt");
          }
          // the chain recovered and is trying again
          setImmediate(() => events.onOpen?.());
          return { sendAudio: () => true, close() {} };
        },
        sttReopenDelaysMs: [20, 40, 60],
        toViewers: () => {},
        setLive: () => {},
        onSttError: () => {},
        log: (level, message) => logs.push({ level, message }),
      },
    );

    session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls, "the first stream never opened").toBe(1);

    // kill it by hand - this seam has no built[].kill() the way flaky()'s
    // does, since the point here is the throwing makeStt, not the kill path
    firstEvents?.onClose?.();

    // the reopen fires on the ladder's first rung (20ms) and throws inside it
    await vi.advanceTimersByTimeAsync(20);
    expect(calls, "the throwing reopen attempt never happened").toBe(2);

    // nothing at ladder speed should follow a throw - only the tail's 30s
    // re-arm should bring the chain back, so a jump smaller than that must
    // still show nothing
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls, "the throw was swallowed with nothing re-armed behind it").toBe(2);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls, "the chain never came back after openStt threw").toBe(3);

    expect(
      logs.some((l) => l.level === "error" && /threw|boom/i.test(l.message)),
      `logs were: ${logs.map((l) => `${l.level}:${l.message}`).join(" | ")}`,
    ).toBe(true);

    session.stop();
  });
});

describe("a quiet session stops paying for silence", () => {
  /**
   * Task 5. `audio()` billed every chunk the socket accepted, times the
   * channel count, for ever - silence is indistinguishable from speech both
   * here and at Deepgram, which bills streamed audio rather than recognised
   * words. A loopback / Stereo Mix source does not disappear when the game
   * closes; it keeps streaming digital silence at 32 kB/s per channel, and
   * nothing but a person noticing and pressing STOP ever stopped the meter.
   *
   * The gate is locally-measured peak level, not STT finals - a design keyed
   * on finals deadlocks, because no audio forwarded means no final can ever
   * arrive to turn it back on. The detector has to keep running while
   * forwarding is off, which is what the second test below actually pins.
   */

  // only Date is faked - the gate itself has no timers of its own to fake
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 16 kHz mono s16le, 100 ms frame - the size capture actually posts */
  const SR = 16000;
  const silentFrame = (): Buffer => Buffer.alloc(SR * 2 * 0.1, 0);
  /** every sample well above SILENCE_PEAK_FLOOR (150) */
  const loudFrame = (): Buffer => {
    const samples = SR * 0.1;
    const b = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) b.writeInt16LE(20000, i * 2);
    return b;
  };

  function makeGated(idleBillingStopMinutes: number) {
    const sent: Buffer[] = [];
    const logs: { level: "info" | "warn" | "error"; message: string }[] = [];
    const stats = { seconds: 0, localSeconds: 0 };
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
        // a stand-in that always accepts, so a call reaching it is
        // unambiguous - only whether the gate lets audio() call it at all
        // is under test here, not the socket itself
        makeStt: (events: SttEvents) => {
          setImmediate(() => events.onOpen?.());
          return {
            sendAudio: (chunk: Buffer) => {
              sent.push(chunk);
              return true;
            },
            close() {},
          };
        },
        idleBillingStopMinutes,
        sttStats: stats,
        toViewers: () => {},
        setLive: () => {},
        log: (level, message) => logs.push({ level, message }),
      },
    );
    return { session, sent, logs, stats };
  }

  it("stops reaching the STT seam once silence outlasts the configured period, and says why once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    // a 1-minute bound so the test does not need to fake an hour to reach it
    const g = makeGated(1);
    g.session.start();
    await vi.advanceTimersByTimeAsync(0); // let the mock stt's onOpen fire

    g.session.audio(silentFrame()); // seeds the "last loud" clock at t0
    vi.setSystemTime(t0 + 30_000);
    g.session.audio(silentFrame()); // still under the 60s bound
    expect(g.sent.length, "audio under the bound should still reach the seam").toBe(2);
    expect(g.stats.seconds, "audio under the bound should still be billed").toBeGreaterThan(0);
    const billedBeforeTrip = g.stats.seconds;

    vi.setSystemTime(t0 + 65_000); // past the 60s bound
    g.session.audio(silentFrame()); // this is the chunk that trips it

    expect(g.sent.length, "the chunk that tripped the bound still reached the seam").toBe(2);
    expect(g.stats.seconds, "billed seconds kept growing after the bound tripped").toBe(billedBeforeTrip);

    // more silence after the trip must not reach the seam either
    vi.setSystemTime(t0 + 70_000);
    g.session.audio(silentFrame());
    expect(g.sent.length, "silence kept reaching the STT seam after the bound tripped").toBe(2);

    const errors = g.logs.filter((l) => l.level === "error");
    expect(errors.length, `error-level logs were: ${errors.map((e) => e.message).join(" | ") || "(none)"}`).toBe(1);
    expect(errors[0].message).toMatch(/silen/i);
    // names the elapsed time, not just "silence happened"
    expect(errors[0].message).toMatch(/\d+m/);

    g.session.stop();
  });

  it("resumes forwarding the instant a chunk clears the floor again", async () => {
    // This is the test that would have caught a design gated on STT finals:
    // once forwarding is off, no final can ever arrive to turn it back on,
    // so the session would be wedged silent for ever instead of recovering
    // here.
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    const g = makeGated(1);
    g.session.start();
    await vi.advanceTimersByTimeAsync(0);

    g.session.audio(silentFrame());
    vi.setSystemTime(t0 + 65_000);
    g.session.audio(silentFrame()); // trips the bound
    expect(g.sent.length, "setup: the bound should already be tripped here").toBe(1);

    vi.setSystemTime(t0 + 66_000);
    g.session.audio(loudFrame());

    expect(g.sent.length, "a chunk above the floor was not forwarded the instant it arrived").toBe(2);
    expect(g.stats.seconds, "the recovered chunk was not billed").toBeGreaterThan(0);

    g.session.stop();
  });

  it("never cuts off ordinary speech, even past the configured period", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    const g = makeGated(1); // 1-minute bound
    g.session.start();
    await vi.advanceTimersByTimeAsync(0);

    // five chunks of continuous "speech", 20s apart - 80s total, well past
    // the 60s bound, but every chunk resets the "last loud" clock so the
    // bound should never trip
    let at = t0;
    for (let i = 0; i < 5; i++) {
      at += 20_000;
      vi.setSystemTime(at);
      g.session.audio(loudFrame());
    }

    expect(g.sent.length, "speech was cut off even though it never went quiet").toBe(5);
    expect(g.logs.some((l) => l.level === "error"), "an error was logged even though nothing was ever silent").toBe(
      false,
    );

    g.session.stop();
  });

  it("idleBillingStopMinutes: 0 disables the bound entirely", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    const g = makeGated(0);
    g.session.start();
    await vi.advanceTimersByTimeAsync(0);

    g.session.audio(silentFrame());
    vi.setSystemTime(t0 + 3 * 60 * 60 * 1000); // 3 hours of unbroken silence
    g.session.audio(silentFrame());
    vi.setSystemTime(t0 + 6 * 60 * 60 * 1000);
    g.session.audio(silentFrame());

    expect(g.sent.length, "0 should disable the gate, not just delay it").toBe(3);
    expect(g.logs.some((l) => l.level === "error"), "0 should mean no gate at all, not only no logging").toBe(
      false,
    );

    g.session.stop();
  });
});

describe("fix-round finding 4: the floor's value and peak-over-RMS are both pinned", () => {
  /**
   * test/session.test.ts:899-905 (pre-fix-round). Every existing test used
   * loudFrame() at a uniform 20000 and silentFrame() at exact 0.
   * SILENCE_PEAK_FLOOR could be retuned from 150 to 3000 - cutting off a
   * quiet speaker, the exact failure mode the design comment documents - and
   * all four of those tests would still pass. Swapping peakAmplitude for an
   * RMS would not go red either, so the design decision the report defends
   * at length had no guard. These two cases fix both: one frame pins the
   * floor's actual value, the other pins peak over RMS specifically.
   */
  afterEach(() => {
    vi.useRealTimers();
  });

  const SR = 16000;
  const silentFrame = (): Buffer => Buffer.alloc(SR * 2 * 0.1, 0);
  /** every sample at exactly 200 - just above SILENCE_PEAK_FLOOR (150) */
  const justAboveFloorFrame = (): Buffer => {
    const samples = SR * 0.1;
    const b = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) b.writeInt16LE(200, i * 2);
    return b;
  };
  /**
   * ~2s of silence with a single sample at the very end reading 20000 - the
   * onset of a word right after a long pause. Under peak this reads as loud
   * (20000 > SILENCE_PEAK_FLOOR); under RMS the same chunk averages to
   * 20000/sqrt(32000) =~ 112, UNDER the floor - exactly the divergence
   * peakAmplitude's own doc comment defends against.
   */
  const onsetFrame = (): Buffer => {
    const samples = SR * 2; // 2s - long enough for RMS to average the one loud sample away
    const b = Buffer.alloc(samples * 2);
    b.writeInt16LE(20000, (samples - 1) * 2);
    return b;
  };

  function makeGated(idleBillingStopMinutes: number) {
    const sent: Buffer[] = [];
    const logs: { level: "info" | "warn" | "error"; message: string }[] = [];
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
        makeStt: (events: SttEvents): SttStream => {
          setImmediate(() => events.onOpen?.());
          return {
            sendAudio: (chunk: Buffer) => {
              sent.push(chunk);
              return true;
            },
            keepAlive: () => {},
            close() {},
          };
        },
        idleBillingStopMinutes,
        sttStats: { seconds: 0, localSeconds: 0 },
        toViewers: () => {},
        setLive: () => {},
        log: (level, message) => logs.push({ level, message }),
      },
    );
    return { session, sent, logs };
  }

  it("pins the floor's value: a peak just above SILENCE_PEAK_FLOOR counts as audio", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    const g = makeGated(1); // 60s bound
    g.session.start();
    await vi.advanceTimersByTimeAsync(0);

    g.session.audio(silentFrame()); // seeds the clock
    vi.setSystemTime(t0 + 65_000); // past the bound
    g.session.audio(justAboveFloorFrame());

    expect(g.sent.length, "a peak just above the floor was treated as silence and never reached the seam").toBe(2);
    expect(
      g.logs.some((l) => l.level === "error"),
      "the bound tripped even though the peak cleared the floor",
    ).toBe(false);

    g.session.stop();
  });

  it("pins peak over RMS: a single loud sample near the end of an otherwise silent chunk counts as audio", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    const g = makeGated(1);
    g.session.start();
    await vi.advanceTimersByTimeAsync(0);

    g.session.audio(silentFrame()); // seeds the clock
    vi.setSystemTime(t0 + 65_000); // past the bound
    g.session.audio(onsetFrame());

    expect(
      g.sent.length,
      "an RMS average would have read this chunk as silence and tripped the bound - it must not",
    ).toBe(2);
    expect(g.logs.some((l) => l.level === "error")).toBe(false);

    g.session.stop();
  });
});

describe("fix-round finding 3: an isolated impulse must not indefinitely delay the bound", () => {
  /**
   * session.ts:621-623. Peak is right for REOPENING the gate - one real
   * sample is enough, and that immediacy is what recovery requires. But the
   * same single-sample check also RESET the idle timer, and there it was
   * maximally fragile: one sample above SILENCE_PEAK_FLOOR anywhere in
   * ~57.6 million samples per hour restarted the clock. A Windows
   * notification chime, a Discord join blip, a tab that autoplays once an
   * hour, a driver buffer discontinuity - any of them and the bound never
   * tripped at all. It failed in the safe direction (spend simply
   * continued), but silently - nothing logged to say the bound had gone
   * inert in exactly the messy real capture paths it exists for.
   */
  afterEach(() => {
    vi.useRealTimers();
  });

  const SR = 16000;
  const silentFrame = (): Buffer => Buffer.alloc(SR * 2 * 0.1, 0);
  const loudFrame = (): Buffer => {
    const samples = SR * 0.1;
    const b = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) b.writeInt16LE(20000, i * 2);
    return b;
  };

  function makeGated(idleBillingStopMinutes: number) {
    const sent: Buffer[] = [];
    const logs: { level: "info" | "warn" | "error"; message: string }[] = [];
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
        makeStt: (events: SttEvents): SttStream => {
          setImmediate(() => events.onOpen?.());
          return {
            sendAudio: (chunk: Buffer) => {
              sent.push(chunk);
              return true;
            },
            keepAlive: () => {},
            close() {},
          };
        },
        idleBillingStopMinutes,
        sttStats: { seconds: 0, localSeconds: 0 },
        toViewers: () => {},
        setLive: () => {},
        log: (level, message) => logs.push({ level, message }),
      },
    );
    return { session, sent, logs };
  }

  it("still trips the bound when the only 'audio' is isolated single-sample impulses", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    const g = makeGated(1); // 60s bound
    g.session.start();
    await vi.advanceTimersByTimeAsync(0);

    g.session.audio(silentFrame()); // seeds the clock at t0

    // one loud "impulse" every 20s, otherwise pure silence - like a chime or
    // a Discord blip landing on the loopback source once in a while. The
    // pre-fix code treated each impulse as sustained audio and reset the
    // idle clock every time, so the bound never tripped no matter how long
    // this ran.
    let at = t0;
    for (let i = 0; i < 4; i++) {
      at += 20_000;
      vi.setSystemTime(at);
      g.session.audio(loudFrame());
      at += 100;
      vi.setSystemTime(at);
      g.session.audio(silentFrame());
    }

    expect(
      g.logs.some((l) => l.level === "error"),
      "an isolated impulse every 20s kept the bound from ever tripping, over 80s against a 60s bound",
    ).toBe(true);

    g.session.stop();
  });

  it("still reopens billing on a single sample - the impulse fix must not touch recovery", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    const g = makeGated(1);
    g.session.start();
    await vi.advanceTimersByTimeAsync(0);

    g.session.audio(silentFrame());
    vi.setSystemTime(t0 + 65_000);
    g.session.audio(silentFrame()); // trips the bound
    expect(g.sent.length, "setup: the bound should already be tripped here").toBe(1);

    vi.setSystemTime(t0 + 65_100);
    g.session.audio(loudFrame()); // one sample, not a streak

    expect(g.sent.length, "a single above-floor chunk did not reopen billing immediately").toBe(2);

    g.session.stop();
  });
});

describe("fix-round finding 1: the Deepgram socket must not flap while the gate is shut", () => {
  /**
   * deepgram.ts sends no KeepAlive, and a real Deepgram socket that receives
   * no audio closes on its own after roughly ten seconds. Once the
   * idle-billing gate shuts, `audio()` stops calling `sendAudio()` - so with
   * nothing else, the socket idles out, `onClose` fires with `sttDegraded`
   * still false (the last `onOpen` reset it), the session narrates "stt
   * closed unexpectedly", broadcasts "speech pipeline lost" to every viewer,
   * reopens ~300ms later, resets `sttDegraded`, and repeats - every ~10s,
   * for as long as the gate stays shut. Task 1's suppression of repeat
   * narration never arms, because every reopen here succeeds.
   *
   * This fake reproduces exactly the one thing that matters - a socket that
   * closes on its own after a real idle window with no activity - so the fix
   * (a Deepgram KeepAlive sent while the gate is shut) can be proven against
   * a stream that actually behaves the way Deepgram does, not against a mock
   * that would pass whether or not the fix exists.
   */
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeIdleClosingDeepgram(idleTimeoutMs: number) {
    let opens = 0;
    const makeStt = (events: SttEvents): SttStream => {
      opens += 1;
      let open = true;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const arm = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (!open) return;
          open = false;
          events.onClose?.();
        }, idleTimeoutMs);
      };
      setImmediate(() => events.onOpen?.());
      arm();
      return {
        sendAudio: (_chunk: Buffer) => {
          if (!open) return false;
          arm();
          return true;
        },
        keepAlive: () => {
          if (!open) return;
          arm();
        },
        close: () => {
          open = false;
          if (idleTimer) clearTimeout(idleTimer);
        },
      };
    };
    return { makeStt, opensCount: () => opens };
  }

  it("holds the socket open with KeepAlive instead of letting it idle-close for the rest of a gated stretch", async () => {
    vi.useFakeTimers();
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    const idleTimeoutMs = 10_000; // roughly what a real Deepgram socket allows
    const dg = makeIdleClosingDeepgram(idleTimeoutMs);
    const viewers: ServerToViewer[] = [];
    const logs: { level: "info" | "warn" | "error"; message: string }[] = [];
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
        makeStt: dg.makeStt,
        idleBillingStopMinutes: 1,
        sttStats: { seconds: 0, localSeconds: 0 },
        toViewers: (m) => viewers.push(m),
        setLive: () => {},
        log: (level, message) => logs.push({ level, message }),
      },
    );
    session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(dg.opensCount(), "the first stream never opened").toBe(1);

    const silent100 = Buffer.alloc(16000 * 2 * 0.1, 0);

    // trip the 60s bound, one chunk every 2s - capture keeps posting frames
    // whether or not there is anything in them
    for (let i = 0; i < 31; i++) {
      await vi.advanceTimersByTimeAsync(2000);
      session.audio(silent100);
    }
    const errorsAtTrip = logs.filter((l) => l.level === "error").length;
    expect(errorsAtTrip, "the bound never tripped").toBe(1);

    // stay silent for three more Deepgram idle windows - the old code (no
    // KeepAlive) reconnects on every single one of them
    for (let i = 0; i < 15; i++) {
      await vi.advanceTimersByTimeAsync(2000);
      session.audio(silent100);
    }

    expect(
      dg.opensCount(),
      "the socket flapped during the gated stretch - KeepAlive did not hold it open",
    ).toBe(1);
    expect(
      viewers.filter((m) => m.type === "status" && m.live === false).length,
      "the viewer status flapped during the gated stretch",
    ).toBe(0);
    expect(
      logs.filter((l) => l.level === "warn").length,
      "relay.log churned with reconnect warnings during the gated stretch",
    ).toBe(0);

    session.stop();
  });

  it("never sends KeepAlive while forwarding is open - real audio already holds the socket up", async () => {
    vi.useFakeTimers();
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    let keepAlives = 0;
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
        makeStt: (events: SttEvents): SttStream => {
          setImmediate(() => events.onOpen?.());
          return {
            sendAudio: () => true,
            keepAlive: () => {
              keepAlives += 1;
            },
            close() {},
          };
        },
        idleBillingStopMinutes: 1,
        toViewers: () => {},
        setLive: () => {},
        log: () => {},
      },
    );
    session.start();
    await vi.advanceTimersByTimeAsync(0);

    const loud = Buffer.alloc(16000 * 2 * 0.1);
    for (let i = 0; i < loud.length / 2; i++) loud.writeInt16LE(20000, i * 2);

    // continuous loud audio for well over the KeepAlive interval - the gate
    // never shuts, so nothing should ever call keepAlive()
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(2000);
      session.audio(loud);
    }

    expect(keepAlives, "KeepAlive was sent even though real audio was flowing the whole time").toBe(0);
    session.stop();
  });
});

describe("fix-round finding 2: latency after the idle-billing gate reopens", () => {
  /**
   * session.ts:410. During the gate, chunks keep arriving so `lastAudioAt`
   * updates every 100 ms and `silentMs` never grows - the existing mute-gap
   * detector only fires on a real gap BETWEEN calls to `audio()`, and there
   * is none here, capture keeps calling it right on schedule. But no audio
   * reaches the engine while the gate is shut, so the STT clock (Deepgram's
   * word timings, or the local worker's `fed / SAMPLE_RATE`) does not
   * advance either. After a gated stretch and a resume, every caption's
   * `stt` latency figure reads the whole gated span too high.
   */
  afterEach(() => {
    vi.useRealTimers();
  });

  const SR = 16000;
  const silentFrame = (): Buffer => Buffer.alloc(SR * 2 * 0.1, 0);
  const loudFrame = (): Buffer => {
    const samples = SR * 0.1;
    const b = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) b.writeInt16LE(20000, i * 2);
    return b;
  };
  const finals = (viewers: ServerToViewer[]) =>
    viewers.filter(
      (m): m is Extract<ServerToViewer, { type: "subtitle" }> => m.type === "subtitle" && !!m.final,
    );

  it("does not read the gated span as extra latency once forwarding resumes", async () => {
    // full fake timers, not just Date: onOpen fires via a real setImmediate
    // in makeStt below, and racing that against a real setTimeout(0) tick
    // (the ordering between the two is not guaranteed outside an I/O
    // callback) was observed to occasionally resolve the tick first,
    // leaving currentStreamWallStart unstamped and the assertion flaky.
    // advanceTimersByTimeAsync flushes it deterministically instead.
    vi.useFakeTimers();
    const t0 = 1_000_000;
    vi.setSystemTime(t0);

    const viewers: ServerToViewer[] = [];
    let events: SttEvents | undefined;
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
        // a stand-in with no idle-close of its own - Finding 1 already
        // covers that failure mode; this pins the latency arithmetic on a
        // stream that stays open the whole time, exactly what Finding 1's
        // fix produces on the real Deepgram socket
        makeStt: (ev: SttEvents): SttStream => {
          events = ev;
          setImmediate(() => ev.onOpen?.());
          return { sendAudio: () => true, keepAlive: () => {}, close() {} };
        },
        idleBillingStopMinutes: 1,
        toViewers: (m: ServerToViewer) => viewers.push(m),
        setLive: () => {},
        log: () => {},
      },
    );
    session.start();
    await vi.advanceTimersByTimeAsync(0); // flush the deferred onOpen

    // capture keeps posting a 100ms frame whether or not there is anything
    // in it - 70s of unbroken silence trips the 60s bound and keeps the
    // gate shut for another ~10s after that
    let at = t0;
    for (let i = 0; i < 700; i++) {
      at += 100;
      vi.setSystemTime(at);
      session.audio(silentFrame());
    }

    // real audio returns - forwarding resumes inside this very call
    at += 100;
    vi.setSystemTime(at);
    session.audio(loudFrame());

    // the STT clock only ever advanced across the ~60s that was actually
    // forwarded before the trip, never across the gated stretch after it
    events?.onFinal?.("hello again", { audioEndSec: 60, channel: 0 });

    const last = finals(viewers).at(-1);
    expect(last, "no final reached the viewer after recovery").toBeDefined();
    expect(
      last!.latency?.stt,
      `latency badge read ${last!.latency?.stt}ms - it should read the true post-recovery latency, not the gated span`,
    ).toBeLessThan(2000);

    session.stop();
  });
});

describe("fix-round-2 finding 1: an isolated impulse must not re-trip and re-log the same idle period", () => {
  /**
   * session.ts:694/702/718-721 (pre-fix-round-2). SILENCE_RESET_STREAK stops
   * an isolated impulse from resetting `lastAboveFloorAt`, but the same
   * impulse still reopens `billingOpen` for that one chunk - the zero-chunk
   * recovery property is deliberate and must stay untouched. Because the
   * impulse never clears the streak, `lastAboveFloorAt` stays exactly where
   * it was, so the very next silent chunk finds the SAME stale clock already
   * past the bound and re-trips it - logging a second "pausing" error for an
   * idle period that never actually ended. Repeat that every time a chime,
   * a Discord blip or a driver discontinuity lands on the loopback source and
   * relay.log alternates info/error with the stated minute count climbing,
   * even though sound keeps returning.
   */
  afterEach(() => {
    vi.useRealTimers();
  });

  const SR = 16000;
  const silentFrame = (): Buffer => Buffer.alloc(SR * 2 * 0.1, 0);
  const loudFrame = (): Buffer => {
    const samples = SR * 0.1;
    const b = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) b.writeInt16LE(20000, i * 2);
    return b;
  };

  function makeGated(idleBillingStopMinutes: number) {
    const sent: Buffer[] = [];
    const logs: { level: "info" | "warn" | "error"; message: string }[] = [];
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
        makeStt: (events: SttEvents): SttStream => {
          setImmediate(() => events.onOpen?.());
          return {
            sendAudio: (chunk: Buffer) => {
              sent.push(chunk);
              return true;
            },
            keepAlive: () => {},
            close() {},
          };
        },
        idleBillingStopMinutes,
        sttStats: { seconds: 0, localSeconds: 0 },
        toViewers: () => {},
        setLive: () => {},
        log: (level, message) => logs.push({ level, message }),
      },
    );
    return { session, sent, logs };
  }

  it("a single isolated impulse after the gate shuts does not re-log the pause", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    const g = makeGated(1); // 60s bound
    g.session.start();
    await vi.advanceTimersByTimeAsync(0);

    g.session.audio(silentFrame()); // seeds the clock
    vi.setSystemTime(t0 + 65_000);
    g.session.audio(silentFrame()); // trips the bound - the one legitimate pause line
    expect(
      g.logs.filter((l) => l.level === "error").length,
      "setup: the bound should have tripped exactly once",
    ).toBe(1);

    // an isolated impulse - one chunk, well under SILENCE_RESET_STREAK(3) -
    // reopens billing (as it must) and is immediately followed by silence
    // again, the same way a chime or a Discord blip would land on a loopback
    // source and vanish a moment later
    vi.setSystemTime(t0 + 66_000);
    g.session.audio(loudFrame());
    vi.setSystemTime(t0 + 66_100);
    g.session.audio(silentFrame());

    const errors = g.logs.filter((l) => l.level === "error");
    expect(
      errors.length,
      `a single isolated impulse re-logged the pause: ${errors.map((e) => e.message).join(" | ")}`,
    ).toBe(1);

    g.session.stop();
  });

  it("ten isolated impulses a minute apart still produce only the one pause line, not a pair each", async () => {
    // the reviewer's own reproduction, reduced to fake-timer scale: 10
    // isolated impulses against a 60s bound. Pre-fix this alternated
    // info/error 20 times, the stated minute count climbing on each error
    // even though sound kept returning every minute.
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    const g = makeGated(1);
    g.session.start();
    await vi.advanceTimersByTimeAsync(0);

    g.session.audio(silentFrame());
    vi.setSystemTime(t0 + 65_000);
    g.session.audio(silentFrame()); // trips the bound once

    let at = t0 + 65_000;
    for (let i = 0; i < 10; i++) {
      at += 60_000;
      vi.setSystemTime(at);
      g.session.audio(loudFrame()); // isolated impulse - reopens, does not clear the streak
      at += 100;
      vi.setSystemTime(at);
      g.session.audio(silentFrame()); // silence resumes immediately after
    }

    const errors = g.logs.filter((l) => l.level === "error");
    // excludes the one unrelated "stt open" info line onOpen logs at start()
    const resumes = g.logs.filter((l) => l.level === "info" && /resuming/.test(l.message));
    expect(
      errors.length,
      `10 isolated impulses produced ${errors.length} pause lines - the same idle period must not be re-announced: ${errors
        .map((e) => e.message)
        .join(" | ")}`,
    ).toBe(1);
    // one "resuming" line per impulse is the bounded, expected cost of the
    // zero-chunk recovery property staying untouched - it is the repeat
    // ERROR line this finding is about suppressing, not this one
    expect(resumes.length, "each impulse should still log its own resume").toBe(10);

    g.session.stop();
  });

  it("a genuinely new idle period after a real recovery still gets its own pause line", async () => {
    // regression guard: the latch must not go permanently silent. A REAL
    // recovery (the streak actually reaches SILENCE_RESET_STREAK) has to
    // re-arm it so a later, genuinely new idle period is still announced.
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    const g = makeGated(1);
    g.session.start();
    await vi.advanceTimersByTimeAsync(0);

    g.session.audio(silentFrame());
    vi.setSystemTime(t0 + 65_000);
    g.session.audio(silentFrame()); // trip #1

    // a real recovery: three consecutive loud chunks clears the streak and
    // actually moves lastAboveFloorAt
    let at = t0 + 65_000;
    for (let i = 0; i < 3; i++) {
      at += 100;
      vi.setSystemTime(at);
      g.session.audio(loudFrame());
    }

    // silence for another full bound, from the real recovery's own clock
    at += 65_000;
    vi.setSystemTime(at);
    g.session.audio(silentFrame()); // trip #2 - a genuinely new idle period

    const errors = g.logs.filter((l) => l.level === "error");
    expect(errors.length, "a real recovery followed by a real new idle period must log again").toBe(2);

    g.session.stop();
  });
});

describe("fix-round-2 finding 2: a capture stall inside a gated stretch must not double-count silence", () => {
  /**
   * session.ts:700 vs session.ts:673 (pre-fix-round-2). The mute-gap
   * detector at the top of `audio()` runs unconditionally, gate open or
   * shut, and claims any real gap between calls. The gate-close correction
   * used to add the WHOLE gated span as one lump sum on reopen
   * (`now - gateClosedAt`) regardless of what the detector had already
   * claimed for the very same call - so a capture stall or a publisher mute
   * that happened to land inside a gated stretch got counted twice for the
   * same wall-clock span. silentMs never decays, so every later final in the
   * session read `stt` clamped to 0 from then on.
   */
  afterEach(() => {
    vi.useRealTimers();
  });

  const SR = 16000;
  const silentFrame = (): Buffer => Buffer.alloc(SR * 2 * 0.1, 0);
  const loudFrame = (): Buffer => {
    const samples = SR * 0.1;
    const b = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) b.writeInt16LE(20000, i * 2);
    return b;
  };
  const finals = (viewers: ServerToViewer[]) =>
    viewers.filter(
      (m): m is Extract<ServerToViewer, { type: "subtitle" }> => m.type === "subtitle" && !!m.final,
    );

  it("a 5-minute capture stall inside a gated stretch is added to silentMs once, not twice", async () => {
    vi.useFakeTimers();
    const t0 = 1_000_000;
    vi.setSystemTime(t0);

    const viewers: ServerToViewer[] = [];
    let events: SttEvents | undefined;
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
        makeStt: (ev: SttEvents): SttStream => {
          events = ev;
          setImmediate(() => ev.onOpen?.());
          return { sendAudio: () => true, keepAlive: () => {}, close() {} };
        },
        idleBillingStopMinutes: 1, // 60s bound
        toViewers: (m: ServerToViewer) => viewers.push(m),
        setLive: () => {},
        log: () => {},
      },
    );
    session.start();
    await vi.advanceTimersByTimeAsync(0); // flush the deferred onOpen - currentStreamWallStart = t0

    // seed the clock, then trip the bound with a single jump - matches the
    // established style elsewhere in this file (the gate only cares about
    // elapsed wall time between calls, not literal per-chunk cadence)
    session.audio(silentFrame());
    vi.setSystemTime(t0 + 65_000);
    session.audio(silentFrame()); // trips the bound; gate shuts here

    // now the capture genuinely stalls for 5 minutes INSIDE the gated
    // stretch - no calls to audio() at all, not even silent ones, unlike the
    // common case where chunks keep arriving every ~100ms with nothing in
    // them
    vi.setSystemTime(t0 + 65_000 + 5 * 60_000);
    session.audio(loudFrame()); // resume - forwarding reopens inside this call

    // 200ms of real latency after recovery
    vi.setSystemTime(t0 + 65_000 + 5 * 60_000 + 200);
    // audioEndSec: 0 - nothing was ever actually forwarded to the STT engine
    // in this synthetic test (every chunk before this was silent and gated),
    // so the true post-recovery latency is exactly the 200ms wall-clock gap
    // between the resume chunk and this final, with silentMs correctly
    // absorbing the 65,000 + 300,000ms that came before it
    events?.onFinal?.("hello again", { audioEndSec: 0, channel: 0 });

    const last = finals(viewers).at(-1);
    expect(last, "no final reached the viewer after recovery").toBeDefined();
    expect(
      last!.latency?.stt,
      `latency badge read ${last!.latency?.stt}ms - a doubled 5-minute stall clamps this to 0`,
    ).toBe(200);

    session.stop();
  });

  it("every final after a double-counted stall must not stay clamped to 0", async () => {
    // the report's own description of the symptom: silentMs never decays, so
    // once it is inflated by a doubled stall, EVERY later final in the
    // session reads 0, not just the first one after recovery
    vi.useFakeTimers();
    const t0 = 1_000_000;
    vi.setSystemTime(t0);

    const viewers: ServerToViewer[] = [];
    let events: SttEvents | undefined;
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
        makeStt: (ev: SttEvents): SttStream => {
          events = ev;
          setImmediate(() => ev.onOpen?.());
          return { sendAudio: () => true, keepAlive: () => {}, close() {} };
        },
        idleBillingStopMinutes: 1,
        toViewers: (m: ServerToViewer) => viewers.push(m),
        setLive: () => {},
        log: () => {},
      },
    );
    session.start();
    await vi.advanceTimersByTimeAsync(0);

    session.audio(silentFrame());
    vi.setSystemTime(t0 + 65_000);
    session.audio(silentFrame());

    vi.setSystemTime(t0 + 65_000 + 5 * 60_000);
    session.audio(loudFrame());

    // two finals, a second apart, well after recovery - both should read a
    // small, sane latency, not 0
    vi.setSystemTime(t0 + 65_000 + 5 * 60_000 + 200);
    events?.onFinal?.("first", { audioEndSec: 0, channel: 0 });
    vi.setSystemTime(t0 + 65_000 + 5 * 60_000 + 1_200);
    events?.onFinal?.("second", { audioEndSec: 1, channel: 0 });

    const [first, second] = finals(viewers);
    expect(first?.latency?.stt, "first final after recovery read 0 - the stall was double-counted").toBe(200);
    expect(
      second?.latency?.stt,
      "second final after recovery also read 0 - silentMs never decayed from the double count",
    ).toBe(200);

    session.stop();
  });
});

describe("fix-round-2 finding 3: a corrupted idleBillingStopMinutes must not silently disable the gate", () => {
  /**
   * `idleBillingStopMinutes` is `number` on AppConfig, but a hand-edited
   * config.json survives `JSON.parse` + `ConfigStore`'s `as Partial<AppConfig>`
   * cast as whatever was actually typed there - TypeScript trusts the cast,
   * so a typo'd string or a stray negative sign reaches session.ts still
   * typed `number`. `idleMinutes > 0` is false for both a NaN-ish string
   * comparison and a negative number, so the gate silently disables itself -
   * fail-open on the one setting whose entire purpose is stopping a bleed.
   * relayPort has validRelayPort(); this field had nothing.
   */
  afterEach(() => {
    vi.useRealTimers();
  });

  const SR = 16000;
  const silentFrame = (): Buffer => Buffer.alloc(SR * 2 * 0.1, 0);

  function makeGated(idleBillingStopMinutes: number) {
    const sent: Buffer[] = [];
    const logs: { level: "info" | "warn" | "error"; message: string }[] = [];
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
        makeStt: (events: SttEvents): SttStream => {
          setImmediate(() => events.onOpen?.());
          return {
            sendAudio: (chunk: Buffer) => {
              sent.push(chunk);
              return true;
            },
            keepAlive: () => {},
            close() {},
          };
        },
        idleBillingStopMinutes,
        sttStats: { seconds: 0, localSeconds: 0 },
        toViewers: () => {},
        setLive: () => {},
        log: (level, message) => logs.push({ level, message }),
      },
    );
    return { session, sent, logs };
  }

  it("a non-number value (a hand-edited config.json string) falls back to the 60-minute default", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    // JSON.parse('{"idleBillingStopMinutes":"abc"}') survives as the literal
    // string "abc" - ConfigStore's cast, not this test, is what erases the
    // type safety; the cast reproduces exactly that at the SessionDeps seam
    const g = makeGated("abc" as unknown as number);
    g.session.start();
    await vi.advanceTimersByTimeAsync(0);

    g.session.audio(silentFrame()); // seeds the clock

    vi.setSystemTime(t0 + 59 * 60_000); // just under the 60-minute default
    g.session.audio(silentFrame());
    expect(
      g.logs.some((l) => l.level === "error"),
      "tripped before the 60-minute default - not falling back to it",
    ).toBe(false);

    vi.setSystemTime(t0 + 61 * 60_000); // just past the 60-minute default
    g.session.audio(silentFrame());
    expect(
      g.logs.some((l) => l.level === "error"),
      "a non-number idleBillingStopMinutes silently disabled the gate instead of falling back to the default",
    ).toBe(true);

    g.session.stop();
  });

  it("a negative value falls back to the 60-minute default", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    const g = makeGated(-5);
    g.session.start();
    await vi.advanceTimersByTimeAsync(0);

    g.session.audio(silentFrame());
    vi.setSystemTime(t0 + 61 * 60_000);
    g.session.audio(silentFrame());

    expect(
      g.logs.some((l) => l.level === "error"),
      "a negative idleBillingStopMinutes silently disabled the gate instead of falling back to the default",
    ).toBe(true);

    g.session.stop();
  });

  it("a non-finite value (NaN) falls back to the 60-minute default", async () => {
    // NaN is neither > 0 nor < 0 - a validator that only rejects negatives
    // would wrongly accept it as "valid"
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    const g = makeGated(NaN);
    g.session.start();
    await vi.advanceTimersByTimeAsync(0);

    g.session.audio(silentFrame());
    vi.setSystemTime(t0 + 61 * 60_000);
    g.session.audio(silentFrame());

    expect(
      g.logs.some((l) => l.level === "error"),
      "a non-finite idleBillingStopMinutes silently disabled the gate instead of falling back to the default",
    ).toBe(true);

    g.session.stop();
  });

  it("an explicit 0 still disables the bound entirely after the validation change", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    const g = makeGated(0);
    g.session.start();
    await vi.advanceTimersByTimeAsync(0);

    g.session.audio(silentFrame());
    vi.setSystemTime(t0 + 6 * 60 * 60 * 1000); // 6 hours of unbroken silence
    g.session.audio(silentFrame());

    expect(g.sent.length, "explicit 0 must still disable the gate, not fall back to the default").toBe(2);
    expect(
      g.logs.some((l) => l.level === "error"),
      "0 should mean no gate at all, not only no logging",
    ).toBe(false);

    g.session.stop();
  });
});
