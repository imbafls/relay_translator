/**
 * AudioWorklet processor source (injected as a Blob URL so no bundler asset
 * plumbing is needed). Converts the input to mono s16le PCM at the target
 * sample rate (16 kHz, what Deepgram's linear16 expects) and posts buffers
 * to the main thread.
 */
export const PCM_WORKLET_SOURCE = `
class PcmDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.step = sampleRate / this.targetRate;
    this.frac = 0;
    this.prev = 0;
    this.out = new Int16Array(1600);
    this.outLen = 0;
    this.muted = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'mute') this.muted = !!e.data.value;
    };
  }

  push(sample) {
    const s = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    this.out[this.outLen++] = s * 32767;
    if (this.outLen === this.out.length) {
      this.port.postMessage({ type: 'pcm', buffer: this.out.slice().buffer });
      this.outLen = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch || ch.length === 0) return true;
    if (this.muted) { this.prev = ch[ch.length - 1]; return true; }
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      while (this.frac < 1) {
        const s = this.prev + (x - this.prev) * this.frac;
        this.push(s);
        this.frac += this.step;
      }
      this.frac -= 1;
      this.prev = x;
    }
    return true;
  }
}
registerProcessor('pcm-downsampler', PcmDownsampler);
`;
