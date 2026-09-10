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
    // the sample each lane contributes this frame, after the low-pass if any
    this.cur = new Float32Array(this.channels);
    // Anti-alias low-pass, built only when this worklet is itself decimating.
    // The graph asks for a 16 kHz context so Chromium's own filter resamples
    // and step is 1 - that path is left exactly as it was. Above 16 kHz the
    // stepping below kept one sample in three at 48 kHz with nothing in front
    // of it, folding 8-24 kHz into the band the speech model reads. A
    // Hann-windowed sinc, cut off just under the output Nyquist.
    this.taps = null;
    if (this.step > 1) {
      const N = 63;
      const fc = (0.45 * this.targetRate) / sampleRate;
      const taps = new Float32Array(N);
      let sum = 0;
      for (let k = 0; k < N; k++) {
        const m = k - (N - 1) / 2;
        const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
        taps[k] = sinc * (0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (N - 1)));
        sum += taps[k];
      }
      for (let k = 0; k < N; k++) taps[k] /= sum;
      this.taps = taps;
      // per lane, twice the length, so the window is always one contiguous run
      this.hist = [];
      for (let c = 0; c < this.channels; c++) this.hist.push(new Float32Array(2 * N));
      this.histAt = 0;
      this.primed = false;
    }
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
      // whatever the filter held is from before the mute; start again on unmute
      this.primed = false;
      return true;
    }
    const taps = this.taps;
    // Start each lane's history from its own first sample, not from silence.
    // Zeros make the first 63 input samples a step, and a windowed sinc
    // answers a step by ringing: 1.3 ms of overshoot at the start of every
    // session and after every unmute, which is sound nobody made.
    if (taps && !this.primed) {
      for (let c = 0; c < n; c++) this.hist[c].fill(lanes[c][0]);
      this.primed = true;
    }
    for (let i = 0; i < len; i++) {
      if (taps) {
        const N = taps.length;
        const at = (this.histAt = (this.histAt + 1) % N);
        for (let c = 0; c < n; c++) {
          const h = this.hist[c];
          const x = lanes[c][i];
          h[at] = x;
          h[at + N] = x;
          let y = 0;
          for (let k = 0; k < N; k++) y += taps[k] * h[at + 1 + k];
          this.cur[c] = y;
        }
      } else {
        for (let c = 0; c < n; c++) this.cur[c] = lanes[c][i];
      }
      while (this.frac < 1) {
        for (let c = 0; c < n; c++) {
          const x = this.cur[c];
          const s = this.prev[c] + (x - this.prev[c]) * this.frac;
          const v = s < -1 ? -1 : s > 1 ? 1 : s;
          this.out[this.outLen++] = v * 32767;
        }
        this.flushIfFull();
        this.frac += this.step;
      }
      this.frac -= 1;
      for (let c = 0; c < n; c++) this.prev[c] = this.cur[c];
    }
    return true;
  }
}
registerProcessor('pcm-downsampler', PcmDownsampler);
`;
