import { describe, expect, it } from "vitest";
import { PCM_WORKLET_SOURCE } from "../src/capture/workletSource";

/**
 * Finding 23 made the capture graph ask the browser for a 16 kHz AudioContext,
 * so Chromium's own windowed-sinc filter does the resampling and this worklet's
 * step is 1. But the worklet still carries a resampler of its own for any rate
 * above that - an AudioContext that does not honour the rate it was asked for,
 * or a caller that builds the graph some other way - and that resampler had no
 * anti-alias filter at all. At 48 kHz its interpolation weight is identically
 * zero: it kept one sample in three, and a 12 kHz tone came out at 4 kHz, in
 * the middle of the band the speech model reads, at full strength.
 *
 * The real processor source runs here. Only the three globals an
 * AudioWorkletGlobalScope provides are stood in for - the browser, not the
 * thing under test.
 */

interface Processor {
  process(inputs: Float32Array[][]): boolean;
}

function load(sampleRate: number, channels = 1): { proc: Processor; posted: Int16Array[] } {
  const posted: Int16Array[] = [];
  let Registered: (new (options: unknown) => Processor) | undefined;
  class AudioWorkletProcessor {
    port = {
      onmessage: null as unknown,
      postMessage: (m: { type: string; buffer: ArrayBuffer }) => {
        if (m.type === "pcm") posted.push(new Int16Array(m.buffer));
      },
    };
  }
  const registerProcessor = (_name: string, cls: new (options: unknown) => Processor): void => {
    Registered = cls;
  };
  new Function("sampleRate", "AudioWorkletProcessor", "registerProcessor", PCM_WORKLET_SOURCE)(
    sampleRate,
    AudioWorkletProcessor,
    registerProcessor,
  );
  if (!Registered) throw new Error("the worklet source registered no processor");
  return { proc: new Registered({ processorOptions: { targetRate: 16000, channels } }), posted };
}

type Signal = (t: number) => number;
const tone =
  (hz: number, amp = 0.5): Signal =>
  (t) =>
    amp * Math.sin(2 * Math.PI * hz * t);

/** feed `lanes` through in 128-sample render quanta; returns what went in (as float32) and each lane out */
function run(sampleRate: number, lanes: Signal[], seconds = 0.6): { input: number[][]; output: number[][]; raw: Int16Array } {
  const n = lanes.length;
  const { proc, posted } = load(sampleRate, n);
  const total = Math.round(sampleRate * seconds);
  const input: number[][] = lanes.map(() => []);
  for (let off = 0; off < total; off += 128) {
    const len = Math.min(128, total - off);
    const blocks = lanes.map((signal, c) => {
      const block = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        block[i] = signal((off + i) / sampleRate);
        input[c].push(block[i]);
      }
      return block;
    });
    proc.process([blocks]);
  }
  const raw = new Int16Array(posted.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of posted) {
    raw.set(p, at);
    at += p.length;
  }
  const output = lanes.map((_, c) => {
    const lane: number[] = [];
    for (let i = c; i < raw.length; i += n) lane.push(raw[i] / 32767);
    return lane;
  });
  return { input, output, raw };
}

/** skip the start: a filter needs its history filled before it says anything true */
const rms = (xs: number[], from = 200): number => {
  let sum = 0;
  let count = 0;
  for (let i = from; i < xs.length; i++) {
    sum += xs[i] * xs[i];
    count += 1;
  }
  return Math.sqrt(sum / Math.max(1, count));
};
/** how much of a tone survives, as a ratio of what went in */
const kept = (sampleRate: number, hz: number): number => {
  const { input, output } = run(sampleRate, [tone(hz)]);
  return rms(output[0]) / rms(input[0], 0);
};

describe("the capture worklet's own resampler", () => {
  /**
   * The path every session actually takes. The filter must not touch it: at
   * step 1 the output is the input, one sample behind, bit for bit.
   */
  it("passes 16 kHz through untouched, which is the rate the graph asks for", () => {
    const { input, raw } = run(16000, [tone(1000)], 0.3);
    expect(raw.length).toBeGreaterThan(3000);
    for (let i = 1; i < raw.length; i++) {
      // `| 0`: Math.trunc of a tiny negative sample is -0, an Int16Array holds
      // 0, and toBe compares with Object.is - which tells the two apart
      expect(raw[i], `sample ${i}`).toBe(Math.trunc(input[0][i - 1] * 32767) | 0);
    }
  });

  it("keeps the speech band when it does have to decimate", () => {
    expect(kept(48000, 1000)).toBeGreaterThan(0.9);
    expect(kept(48000, 3000)).toBeGreaterThan(0.9);
  });

  it("does not fold 8-24 kHz down into the band the model reads", () => {
    for (const hz of [10000, 12000, 20000]) {
      expect(kept(48000, hz), `${hz} Hz at 48 kHz`).toBeLessThan(0.05);
    }
  });

  it("does the same at 44.1 kHz, where the step is not a whole number", () => {
    expect(kept(44100, 1000)).toBeGreaterThan(0.9);
    expect(kept(44100, 12000)).toBeLessThan(0.05);
  });

  it("filters every lane, not only the first", () => {
    const { input, output } = run(48000, [tone(1000), tone(12000)]);
    expect(rms(output[0]) / rms(input[0], 0), "the speech lane").toBeGreaterThan(0.9);
    expect(rms(output[1]) / rms(input[1], 0), "the second lane was left unfiltered").toBeLessThan(0.05);
  });
});
