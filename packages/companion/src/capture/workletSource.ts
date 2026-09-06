import { MAX_CAPTURE_CHANNELS } from "@callout-relay/shared";

/**
 * AudioWorklet processor source (injected as a Blob URL so no bundler asset
 * plumbing is needed). Converts the input to s16le PCM at the target sample
 * rate (16 kHz, what the STT engines expect) and posts buffers to the main
 * thread. With `channels: n` the first n input channels (one per capture
 * source, merged upstream) are downsampled separately and interleaved, so the
 * relay can transcribe each on its own.
 *
 * The cap is interpolated from MAX_CAPTURE_CHANNELS rather than written here,
 * because the relay splits an incoming frame by the count in the publisher
 * hello. If the two numbers ever disagreed the frame would be re-cut on the
 * wrong stride, and every lane after the first would carry a different voice
 * on every frame - audible as nothing, because it still decodes to speech.
 */
export const PCM_WORKLET_SOURCE = `
class PcmDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.channels = Math.max(1, Math.min(${MAX_CAPTURE_CHANNELS}, opts.channels || 1));
    this.step = sampleRate / this.targetRate;
    this.frac = 0;
    this.prev = new Float32Array(this.channels);
    // 100 ms frames per channel, interleaved
    this.out = new Int16Array(1600 * this.channels);
    this.outLen = 0;
    this.muted = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'mute') this.muted = !!e.data.value;
    };
  }

  flushIfFull() {
    if (this.outLen === this.out.length) {
      // hand the buffer over instead of cloning it; allocate the next frame
      const buffer = this.out.buffer;
      this.port.postMessage({ type: 'pcm', buffer }, [buffer]);
      this.out = new Int16Array(1600 * this.channels);
      this.outLen = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;
    const n = this.channels;
    const len = input[0].length;
    // every lane shares one clock (the same AudioContext), so one resampler
    // phase advances them in lockstep and every output frame holds one sample
    // from each - that lockstep is what lets the relay re-cut by stride alone
    const lanes = this.lanes || (this.lanes = new Array(n));
    for (let c = 0; c < n; c++) lanes[c] = input[c] || input[0];
    if (this.muted) {
      for (let c = 0; c < n; c++) this.prev[c] = lanes[c][len - 1];
      return true;
    }
    for (let i = 0; i < len; i++) {
      while (this.frac < 1) {
        for (let c = 0; c < n; c++) {
          const x = lanes[c][i];
          const s = this.prev[c] + (x - this.prev[c]) * this.frac;
          const v = s < -1 ? -1 : s > 1 ? 1 : s;
          this.out[this.outLen++] = v * 32767;
        }
        this.flushIfFull();
        this.frac += this.step;
      }
      this.frac -= 1;
      for (let c = 0; c < n; c++) this.prev[c] = lanes[c][i];
    }
    return true;
  }
}
registerProcessor('pcm-downsampler', PcmDownsampler);
`;
