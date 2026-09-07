import { describe, expect, it } from "vitest";
import { finalAudioEndSec, SAMPLE_RATE, dispatchDeepgramMessage } from "../src/deepgram";

/**
 * A real user's session log carried "[stt 0ms]" on roughly 120 consecutive
 * captions, with exactly one reading of 962ms - on the first final of a fresh
 * session, about a second in. That shape is the whole bug: the reported
 * position of the audio was being double-counted, so the badge stayed honest
 * only while the stream was younger than the true latency, then pinned at 0.
 *
 * Deepgram's word timings are already absolute offsets from the start of the
 * stream, on the same clock as `start`. Adding the two roughly doubled the
 * position. Everything here drives the real message handler by feeding frames
 * the way the socket would.
 */

const frame = (opts: { start: number; wordEnd?: number; text?: string }) => ({
  type: "Results",
  is_final: true,
  start: opts.start,
  channel: {
    alternatives: [
      {
        transcript: opts.text ?? "enemy down mid",
        words: opts.wordEnd === undefined ? [] : [{ end: opts.wordEnd }],
      },
    ],
  },
  channel_index: [0],
});

describe("the audio position a final reports", () => {
  it("is the word's own absolute end, not the segment offset plus it", () => {
    // a caption 120 s into a stream, whose last word ends at 122.4 s
    expect(finalAudioEndSec(frame({ start: 120, wordEnd: 122.4 }))).toBe(122.4);
    // the bug added them: 242.4 s, past the end of the audio itself
    expect(finalAudioEndSec(frame({ start: 120, wordEnd: 122.4 }))).not.toBe(242.4);
  });

  it("stays honest deep into a session, which is where the badge died", () => {
    const at = [1, 60, 600, 3600].map((t) => finalAudioEndSec(frame({ start: t, wordEnd: t + 2 })));
    expect(at).toEqual([3, 62, 602, 3602]);
  });

  it("falls back to the segment start when a final carries no word timings", () => {
    expect(finalAudioEndSec(frame({ start: 42 }))).toBe(42);
  });

  it("gives up rather than guessing when there is no clock at all", () => {
    expect(finalAudioEndSec({ channel: { alternatives: [{ words: [] }] } })).toBeUndefined();
  });
});

describe("what the badge would report", () => {
  /**
   * session.ts computes: wallElapsed - silentMs - audioEndSec * 1000, clamped
   * at 0. The arithmetic is reproduced here because it is the thing the user
   * actually saw, and it is the product of the two files together.
   */
  const badge = (wallElapsedMs: number, silentMs: number, audioEndSec: number): number =>
    Math.max(0, Math.round(wallElapsedMs - silentMs - audioEndSec * 1000));

  it("reports a real latency mid-session instead of zero", () => {
    // 600 s into a stream, last word ends at 602 s, final lands 300 ms later
    const wall = 602_300;
    expect(badge(wall, 0, 602)).toBe(300);
    // what the old double-counted value produced
    expect(badge(wall, 0, 600 + 602)).toBe(0);
  });

  it("still reads correctly on the first final, which is all that ever worked", () => {
    // the one honest line in the user's log: ~1 s in, 962 ms
    expect(badge(1962, 0, 1)).toBe(962);
  });

  it("keeps the sample rate the badge's clock assumes", () => {
    expect(SAMPLE_RATE).toBe(16000);
  });

});

describe("an utterance that came to nothing", () => {
  /**
   * Audit finding 35(b). `if (!text) return;` ran before the `is_final` branch,
   * so an EMPTY FINAL never reached `onFinal`. The session reserves a segment
   * id when a channel's first partial arrives and only clears it on a final, so
   * that id was never released - and the viewer kept a blinking half-caption
   * for ever, because `trimRows` excludes `.interim` and nothing ages it out.
   *
   * An empty final is Deepgram saying "that came to nothing", which is exactly
   * the message the reservation was waiting for.
   */
  const results = (over: Record<string, unknown>): Parameters<typeof dispatchDeepgramMessage>[0] => ({
    type: "Results",
    channel: { alternatives: [{ transcript: "", words: [] }] },
    ...over,
  });

  it("passes an empty final through, so the reserved id is released", () => {
    const finals: { text: string; channel: number }[] = [];
    dispatchDeepgramMessage(results({ is_final: true, channel_index: [1, 2] }), {
      onFinal: (text, meta) => finals.push({ text, channel: meta.channel }),
    });
    expect(finals, "an empty final was swallowed and the interim left hanging").toHaveLength(1);
    expect(finals[0]).toEqual({ text: "", channel: 1 });
  });

  it("still ignores an empty partial, which is only silence between words", () => {
    const partials: string[] = [];
    dispatchDeepgramMessage(results({ is_final: false }), { onPartial: (text) => partials.push(text) });
    expect(partials).toEqual([]);
  });

  it("still carries a real final", () => {
    const finals: string[] = [];
    dispatchDeepgramMessage(
      { type: "Results", is_final: true, channel: { alternatives: [{ transcript: " rush B ", words: [] }] } },
      { onFinal: (text) => finals.push(text) },
    );
    expect(finals).toEqual(["rush B"]);
  });

  it("ignores a frame that is not a result at all", () => {
    let called = false;
    dispatchDeepgramMessage({ type: "Metadata", is_final: true }, { onFinal: () => (called = true) });
    expect(called).toBe(false);
  });
});
