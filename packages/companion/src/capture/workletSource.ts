/**
 * AudioWorklet processor source (injected as a Blob URL so no bundler asset
 * plumbing is needed). Converts the input to s16le PCM at the target sample
 * rate (16 kHz, what the STT engines expect) and posts buffers to the main
 * thread. With `channels: 2` the first two input channels (one per capture
 * source, merged upstream) are downsampled separately and interleaved, so
 * the relay can transcribe each on its own.
 */
export const PCM_WORKLET_SOURCE = `
class PcmDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.channels = Math.max(1, Math.min(2, opts.channels || 1));
    this.step = sampleRate / this.targetRate;
    this.frac = new Float64Array(this.channels);
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
    if (this.muted) {
      for (let c = 0; c < n; c++) { const ch = input[c] || input[0]; this.prev[c] = ch[ch.length - 1]; }
      return true;
    }
    if (n === 1) {
      const ch = input[0];
      for (let i = 0; i < len; i++) {
        const x = ch[i];
        while (this.frac[0] < 1) {
          const s = this.prev[0] + (x - this.prev[0]) * this.frac[0];
          const v = s < -1 ? -1 : s > 1 ? 1 : s;
          this.out[this.outLen++] = v * 32767;
          this.flushIfFull();
          this.frac[0] += this.step;
        }
        this.frac[0] -= 1;
        this.prev[0] = x;
      }
      return true;
    }
    // two channels share one clock (same AudioContext), so the resampler
    // phase advances in lockstep and every output frame has both samples
    const a = input[0];
    const b = input[1] || input[0];
    for (let i = 0; i < len; i++) {
      const xa = a[i];
      const xb = b[i];
      while (this.frac[0] < 1) {
        const f = this.frac[0];
        const sa = this.prev[0] + (xa - this.prev[0]) * f;
        const sb = this.prev[1] + (xb - this.prev[1]) * f;
        const va = sa < -1 ? -1 : sa > 1 ? 1 : sa;
        const vb = sb < -1 ? -1 : sb > 1 ? 1 : sb;
        this.out[this.outLen++] = va * 32767;
        this.out[this.outLen++] = vb * 32767;
        this.flushIfFull();
        this.frac[0] += this.step;
      }
      this.frac[0] -= 1;
      this.prev[0] = xa;
      this.prev[1] = xb;
    }
    return true;
  }
}
registerProcessor('pcm-downsampler', PcmDownsampler);
`;
