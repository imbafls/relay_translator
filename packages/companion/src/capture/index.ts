import { AudioDeviceInfo } from "@callout-relay/shared";
import { PCM_WORKLET_SOURCE } from "./workletSource";

export const TARGET_SAMPLE_RATE = 16000;
export const SOURCE_DEFAULT_MIC = "default-mic";
export const SOURCE_SYSTEM_LOOPBACK = "system-loopback";

/**
 * Renderer-side audio capture: mic (getUserMedia) or system loopback
 * (getDisplayMedia - Electron main must install a display-media request
 * handler with audio: 'loopback' for the system option to work).
 * Emits s16le mono 16 kHz PCM chunks ready for the relay.
 */
export class BrowserAudioCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private workletUrl: string | null = null;
  private active = false;

  async listDevices(): Promise<AudioDeviceInfo[]> {
    let mics: AudioDeviceInfo[] = [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      mics = devices
        .filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default")
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

  async start(source: string, onPcm: (chunk: Int16Array) => void): Promise<void> {
    if (this.active) this.stop();

    let stream: MediaStream;
    if (source === SOURCE_SYSTEM_LOOPBACK) {
      // Electron main auto-approves via setDisplayMediaRequestHandler (loopback audio)
      stream = await navigator.mediaDevices.getDisplayMedia({
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
    } else if (source === SOURCE_DEFAULT_MIC) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: source },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    }

    const ctx = new AudioContext();
    if (!this.workletUrl) {
      this.workletUrl = URL.createObjectURL(
        new Blob([PCM_WORKLET_SOURCE], { type: "text/javascript" }),
      );
    }
    await ctx.audioWorklet.addModule(this.workletUrl);

    const node = new AudioWorkletNode(ctx, "pcm-downsampler", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { targetRate: TARGET_SAMPLE_RATE },
    });
    node.port.onmessage = (ev: MessageEvent) => {
      const data = ev.data as { type: string; buffer?: ArrayBuffer };
      if (data?.type === "pcm" && data.buffer) onPcm(new Int16Array(data.buffer));
    };

    const srcNode = ctx.createMediaStreamSource(stream);
    // keep the graph pulling (and processing while the window is hidden)
    const sink = ctx.createGain();
    sink.gain.value = 0;
    srcNode.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);

    this.ctx = ctx;
    this.stream = stream;
    this.node = node;
    this.sink = sink;
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
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.node = null;
    this.sink = null;
    this.ctx = null;
    this.stream = null;
  }
}
