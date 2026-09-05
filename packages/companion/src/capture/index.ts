import { AudioDeviceInfo } from "@callout-relay/shared";
import { PCM_WORKLET_SOURCE } from "./workletSource";

export const TARGET_SAMPLE_RATE = 16000;
export const SOURCE_DEFAULT_MIC = "default-mic";
export const SOURCE_SYSTEM_LOOPBACK = "system-loopback";

/** de-duplicate a source list, keeping order; never empty */
export function normalizeSources(sources: readonly string[] | string | undefined): string[] {
  const list = typeof sources === "string" ? [sources] : sources || [];
  const out: string[] = [];
  for (const s of list) {
    const id = String(s || "").trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out.length ? out : [SOURCE_DEFAULT_MIC];
}

/**
 * Renderer-side audio capture: mic (getUserMedia) or system loopback
 * (getDisplayMedia - Electron main must install a display-media request
 * handler with audio: 'loopback' for the system option to work).
 *
 * Several sources can run at once: each gets its own MediaStream and all of
 * them feed the same worklet input, where Web Audio sums them - so the relay
 * still receives one mono 16 kHz s16le PCM stream.
 */
export class BrowserAudioCapture {
  private ctx: AudioContext | null = null;
  private streams: MediaStream[] = [];
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

  /** `sources` = one id or several; all of them are mixed into the PCM stream */
  async start(sources: string | readonly string[], onPcm: (chunk: Int16Array) => void): Promise<void> {
    if (this.active) this.stop();
    const ids = normalizeSources(sources);

    const streams: MediaStream[] = [];
    for (const id of ids) {
      try {
        streams.push(await this.openSource(id));
      } catch (err) {
        for (const s of streams) s.getTracks().forEach((t) => t.stop());
        const what = id === SOURCE_SYSTEM_LOOPBACK ? "system audio" : id === SOURCE_DEFAULT_MIC ? "default microphone" : "microphone";
        throw new Error(`${what}: ${String((err as Error).message || err)}`);
      }
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

    // every source fans into the same worklet input; Web Audio sums them
    for (const stream of streams) ctx.createMediaStreamSource(stream).connect(node);
    // keep the graph pulling (and processing while the window is hidden)
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(ctx.destination);

    this.ctx = ctx;
    this.streams = streams;
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
    for (const s of this.streams) s.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.node = null;
    this.sink = null;
    this.ctx = null;
    this.streams = [];
  }
}
