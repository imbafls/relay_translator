import { describe, expect, it } from "vitest";
import type { ServerToViewer, ServerToPublisher } from "@callout-relay/shared";
import { PublisherSession } from "../src/session";
import type { Translator } from "../src/gemini";

/**
 * The filter's own behaviour is covered exhaustively in
 * packages/shared/test/profanity.test.ts. What this file proves is the WIRING:
 * that a real PublisherSession routes every viewer-bound caption through the
 * mask and deliberately does not mask the publisher echo.
 *
 * The session is real - its ids, its final-then-patch ordering, its stop path.
 * Only the two external engines stand in, through the session's own seams. The
 * mock STT is told what to say, because with the default clean callouts this
 * whole file would pass against a filter that was never wired in at all.
 */

const SAMPLE_RATE = 16000;
const oneUtterance = (): Buffer => Buffer.alloc(SAMPLE_RATE * 2 * 2, 1);
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SAID = "what the fuck was that shit";
const MASKED = "what the f*** was that s***";

/** records every source text Gemini was asked to translate */
function recordingTranslator(): Translator & { seen: string[] } {
  const t = {
    seen: [] as string[],
    async translate(text: string): Promise<string> {
      t.seen.push(text);
      return `[vi] ${text}`;
    },
  };
  return t;
}

function makeSession(opts: { profanityFilter: boolean; lines?: string[] }) {
  const viewers: ServerToViewer[] = [];
  const publisher: Extract<ServerToPublisher, { type: "subtitle" | "partial" }>[] = [];
  const translator = recordingTranslator();
  const session = new PublisherSession(
    {
      stt: "deepgram-nova-3",
      translation: "gemini-3.1-flash-lite",
      languages: { source: "en", target: "vi" },
      translationEnabled: true,
      latencyVisible: true,
      profanityFilter: opts.profanityFilter,
      channels: 1,
    },
    {
      mockStt: opts.lines ?? [SAID],
      translator,
      toViewers: (msg) => viewers.push(msg),
      toPublisher: (msg) => publisher.push(msg),
      setLive: () => {},
      log: () => {},
    },
  );
  return { session, viewers, publisher, translator };
}

const subs = (msgs: ServerToViewer[]) =>
  msgs.filter((m): m is Extract<ServerToViewer, { type: "subtitle" }> => m.type === "subtitle");
const partials = (msgs: ServerToViewer[]) =>
  msgs.filter((m): m is Extract<ServerToViewer, { type: "partial" }> => m.type === "partial");

describe("with the filter on", () => {
  it("masks the source caption sent to viewers", async () => {
    const { session, viewers } = makeSession({ profanityFilter: true });
    session.start();
    await tick();
    session.audio(oneUtterance());
    await tick(60);

    const seen = subs(viewers);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.source).toBe(MASKED);
    session.stop();
  });

  it("masks the interim partial too, so nothing flashes on the broadcast", async () => {
    const { session, viewers } = makeSession({ profanityFilter: true });
    session.start();
    await tick();
    session.audio(oneUtterance());
    await tick(60);

    const seen = partials(viewers);
    expect(seen.length).toBeGreaterThan(0);
    for (const p of seen) expect(p.source).toBe(MASKED);
    session.stop();
  });

  it("leaves the publisher echo as heard, so the streamer sees what the STT got", async () => {
    const { session, publisher } = makeSession({ profanityFilter: true });
    session.start();
    await tick();
    session.audio(oneUtterance());
    await tick(60);

    expect(publisher.length).toBeGreaterThan(0);
    for (const m of publisher) expect(m.source).toBe(SAID);
    session.stop();
  });

  it("still masks the source on the translated patch", async () => {
    const { session, viewers } = makeSession({ profanityFilter: true });
    session.start();
    await tick();
    session.audio(oneUtterance());
    await tick(80);

    const patched = subs(viewers).filter((s) => !!s.target);
    expect(patched.length).toBeGreaterThan(0);
    for (const s of patched) expect(s.source).toBe(MASKED);
    session.stop();
  });

  it("translates what was actually said, not the masked line", async () => {
    // masking before translation would hand Gemini "f***" and get nonsense back
    const { session, translator } = makeSession({ profanityFilter: true });
    session.start();
    await tick();
    session.audio(oneUtterance());
    await tick(80);

    expect(translator.seen.length).toBeGreaterThan(0);
    for (const t of translator.seen) expect(t).toBe(SAID);
    session.stop();
  });

  it("does not touch an ordinary callout", async () => {
    const line = "one enemy on A site, pass the class angle";
    const { session, viewers } = makeSession({ profanityFilter: true, lines: [line] });
    session.start();
    await tick();
    session.audio(oneUtterance());
    await tick(60);

    for (const s of subs(viewers)) expect(s.source).toBe(line);
    session.stop();
  });
});

describe("with the filter off", () => {
  it("sends viewers the line as heard", async () => {
    const { session, viewers } = makeSession({ profanityFilter: false });
    session.start();
    await tick();
    session.audio(oneUtterance());
    await tick(60);

    const seen = subs(viewers);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.source).toBe(SAID);
    session.stop();
  });
});
