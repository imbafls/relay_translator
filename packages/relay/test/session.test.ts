import { describe, expect, it } from "vitest";
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
