import { describe, expect, it } from "vitest";
import { PCM_WORKLET_SOURCE } from "../src/capture/workletSource";

/**
 * The worklet ships as a source string that the browser evaluates inside an
 * AudioWorkletGlobalScope. These tests evaluate that exact string with the
 * three globals it expects, so the resampler under test is the one that ships
 * - not a reimplementation of it.
 */

interface Processor {
  process(inputs: Float32Array[][]): boolean;
  port: { onmessage: ((e: { data: unknown }) => void) | null };
}

interface Harness {
  processor: Processor;
  /** every frame the worklet has posted, as Int16 samples */
  frames: Int16Array[];
  /** feed `len`-sample blocks, the way the audio thread does */
  feed(channels: Float32Array[], blockSize?: number): void;
  /** all posted samples, concatenated */
  all(): Int16Array;
}

function load(deviceRate: number, opts: { channels?: number } = {}): Harness {
  const frames: Int16Array[] = [];

  class FakeAudioWorkletProcessor {
    port = {
      onmessage: null as ((e: { data: unknown }) => void) | null,
      postMessage(msg: { type: string; buffer: ArrayBuffer }) {
        if (msg.type === "pcm") frames.push(new Int16Array(msg.buffer.slice(0)));
      },
    };
  }

  type Ctor = new (o: unknown) => Processor;
  // a holder, so the assignment inside registerProcessor is not narrowed away
  const registered: { cls: Ctor | null } = { cls: null };
  const register = (_name: string, cls: Ctor): void => {
    registered.cls = cls;
  };

  // eslint-disable-next-line no-new-func
  new Function(
    "AudioWorkletProcessor",
    "sampleRate",
    "registerProcessor",
    PCM_WORKLET_SOURCE,
  )(FakeAudioWorkletProcessor, deviceRate, register);

  const Processor = registered.cls;
  if (!Processor) throw new Error("worklet did not register a processor");
  const processor = new Processor({
    processorOptions: { targetRate: 16000, channels: opts.channels ?? 1 },
  });

  return {
    processor,
    frames,
    feed(channels: Float32Array[], blockSize = 128) {
      const total = channels[0].length;
      for (let off = 0; off < total; off += blockSize) {
        const block = channels.map((c) => c.subarray(off, Math.min(off + blockSize, total)));
        processor.process([block]);
      }
    },
    all() {
      const n = frames.reduce((sum, f) => sum + f.length, 0);
      const out = new Int16Array(n);
      let at = 0;
      for (const f of frames) {
        out.set(f, at);
        at += f.length;
      }
      return out;
    },
  };
}

/** a constant-valued channel of `seconds` at `rate` */
const flat = (rate: number, seconds: number, value: number): Float32Array =>
  new Float32Array(Math.round(rate * seconds)).fill(value);

describe("resampling to 16 kHz", () => {
  it.each([
    [48000, "an exact 3:1 ratio"],
    [44100, "a non-integer ratio"],
    [16000, "no resampling at all"],
    [8000, "an upsample"],
  ])("holds the output rate from %i Hz (%s)", (deviceRate) => {
    const seconds = 10;
    const h = load(deviceRate);
    h.feed([flat(deviceRate, seconds, 0.5)]);

    // frames are only posted when full, so allow the tail to be in progress
    const emitted = h.all().length;
    const expected = 16000 * seconds;
    // within one 100 ms frame of the ideal count, with no cumulative drift
    expect(Math.abs(emitted - expected)).toBeLessThanOrEqual(1600);
  });

  it("posts 100 ms frames, which is what the relay's buffering assumes", () => {
    const h = load(48000);
    h.feed([flat(48000, 2, 0.25)]);
    expect(h.frames.length).toBeGreaterThan(0);
    for (const f of h.frames) expect(f.length).toBe(1600);
  });
});

describe("two capture sources", () => {
  it("interleaves without either source bleeding into the other", () => {
    const seconds = 1;
    const a = flat(48000, seconds, 0.5);
    const b = flat(48000, seconds, -0.25);
    const h = load(48000, { channels: 2 });
    h.feed([a, b]);

    const out = h.all();
    expect(out.length).toBeGreaterThan(0);
    expect(out.length % 2).toBe(0);

    // skip the first pair: prev starts at 0, so the very first sample ramps in
    const left = Array.from(out.subarray(2)).filter((_, i) => i % 2 === 0);
    const right = Array.from(out.subarray(2)).filter((_, i) => i % 2 === 1);
    expect(left.every((v) => v === Math.trunc(0.5 * 32767))).toBe(true);
    expect(right.every((v) => v === Math.trunc(-0.25 * 32767))).toBe(true);
  });

  it("keeps both channels the same length, so the interleave never skews", () => {
    const h = load(44100, { channels: 2 });
    h.feed([flat(44100, 3, 0.1), flat(44100, 3, 0.2)]);
    const out = h.all();
    expect(out.length % 2).toBe(0);
    expect(h.frames.every((f) => f.length === 3200)).toBe(true);
  });
});

describe("muting", () => {
  it("does not emit while muted", () => {
    const h = load(48000);
    h.feed([flat(48000, 0.5, 0.5)]);
    const before = h.all().length;

    h.processor.port.onmessage?.({ data: { type: "mute", value: true } });
    h.feed([flat(48000, 2, 0.5)]);
    expect(h.all().length).toBe(before);

    h.processor.port.onmessage?.({ data: { type: "mute", value: false } });
    h.feed([flat(48000, 1, 0.5)]);
    expect(h.all().length).toBeGreaterThan(before);
  });
});
