import { AudioDeviceInfo } from "@callout-relay/shared";
import { PCM_WORKLET_SOURCE } from "./workletSource";

export const TARGET_SAMPLE_RATE = 16000;
export const SOURCE_DEFAULT_MIC = "default-mic";
export const SOURCE_SYSTEM_LOOPBACK = "system-loopback";

/** ids the platform hands out for "whatever is currently the default" */
const PSEUDO_DEVICE_IDS = new Set(["default", "communications"]);

/**
 * Renderer-side audio capture: mic (getUserMedia) or system loopback
 * (getDisplayMedia - Electron main must install a display-media request
 * handler with audio: 'loopback' for the system option to work).
 *
 * One or two sources: each is downmixed to mono, merged into one graph so
 * they share a clock, and the worklet emits s16le 16 kHz PCM - mono, or
 * interleaved stereo when two sources are open (channel 0 = first source).
 */
export class BrowserAudioCapture {
  private ctx: AudioContext | null = null;
  private streams: MediaStream[] = [];
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private workletUrl: string | null = null;
  private active = false;
  private chans = 1;

  async listDevices(): Promise<AudioDeviceInfo[]> {
    let mics: AudioDeviceInfo[] = [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      mics = devices
        // "default" and "communications" are aliases Windows adds for devices
        // that are already in this list, and the first is offered above anyway.
        // Listing them again gives the picker two entries that are the same
        // input, which is the exact confusion the second source already causes.
        .filter((d) => d.kind === "audioinput" && d.deviceId && !PSEUDO_DEVICE_IDS.has(d.deviceId))
        .map((d, i) => ({
          id: d.deviceId,
          label: d.label || `Microphone ${i + 1}`,
          kind: "mic" as const,
        }));
    } catch {
      mics = [];
    }
    return [
      { id: SOURCE_DEFAULT_MIC, label: "Default microphone", kind: "mic" },
      { id: SOURCE_SYSTEM_LOOPBACK, label: "System audio (game + comms)", kind: "system" },
      ...mics,
    ];
  }

  get capturing(): boolean {
    return this.active;
  }

  /** channels in the PCM frames the current capture emits (1 or 2) */
  get channels(): number {
    return this.chans;
  }

  private async openSource(source: string): Promise<MediaStream> {
    if (source === SOURCE_SYSTEM_LOOPBACK) {
      // Electron main auto-approves via setDisplayMediaRequestHandler (loopback audio)
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      stream.getVideoTracks().forEach((t) => t.stop());
      if (stream.getAudioTracks().length === 0) {
        throw new Error("no system audio track - platform does not support loopback capture");
      }
      return stream;
    }
    if (source === SOURCE_DEFAULT_MIC) {
      return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    }
    return navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: source },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  }

  /**
   * @param sources one or two source ids (see listDevices). The same id twice
   *   is collapsed to one channel.
   */
  async start(sources: string | string[], onPcm: (chunk: Int16Array) => void): Promise<void> {
    if (this.active) this.stop();
    const list = (Array.isArray(sources) ? sources : [sources]).filter((s, i, a) => !!s && a.indexOf(s) === i).slice(0, 2);
    if (list.length === 0) throw new Error("no audio source selected");

    const streams: MediaStream[] = [];
    try {
      for (const src of list) streams.push(await this.openSource(src));
    } catch (err) {
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      throw err;
    }

    const ctx = new AudioContext();
    if (!this.workletUrl) {
      this.workletUrl = URL.createObjectURL(
        new Blob([PCM_WORKLET_SOURCE], { type: "text/javascript" }),
      );
    }
    await ctx.audioWorklet.addModule(this.workletUrl);

    const channels = streams.length;
    const node = new AudioWorkletNode(ctx, "pcm-downsampler", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: channels,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
      processorOptions: { targetRate: TARGET_SAMPLE_RATE, channels },
    });
    node.port.onmessage = (ev: MessageEvent) => {
      const data = ev.data as { type: string; buffer?: ArrayBuffer };
      if (data?.type === "pcm" && data.buffer) onPcm(new Int16Array(data.buffer));
    };

    if (channels === 1) {
      ctx.createMediaStreamSource(streams[0]).connect(node);
    } else {
      // each source -> mono (explicit 1-channel gain downmixes) -> its own merger input
      const merger = ctx.createChannelMerger(channels);
      streams.forEach((stream, i) => {
        const mono = ctx.createGain();
        mono.channelCount = 1;
        mono.channelCountMode = "explicit";
        mono.channelInterpretation = "speakers";
        ctx.createMediaStreamSource(stream).connect(mono);
        mono.connect(merger, 0, i);
      });
      merger.connect(node);
    }

    // keep the graph pulling (and processing while the window is hidden)
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(ctx.destination);

    this.ctx = ctx;
    this.streams = streams;
    this.node = node;
    this.sink = sink;
    this.chans = channels;
    this.active = true;
  }

  setMuted(muted: boolean): void {
    this.node?.port.postMessage({ type: "mute", value: muted });
  }

  stop(): void {
    this.active = false;
    try {
      this.node?.disconnect();
      this.sink?.disconnect();
    } catch {
      /* noop */
    }
    this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    this.ctx?.close().catch(() => {});
    this.node = null;
    this.sink = null;
    this.ctx = null;
    this.streams = [];
    this.chans = 1;
  }
}
