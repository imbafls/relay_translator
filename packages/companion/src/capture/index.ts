import { AudioDeviceInfo, MAX_CAPTURE_CHANNELS } from "@callout-relay/shared";
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
 * interleaved by source when more than one is open (channel 0 = first source).
 */
/**
 * The source ids a capture will actually open, in the order picked.
 *
 * Empty slots are dropped and a device picked twice is collapsed: two channels
 * carrying one voice is the most confusing failure this app has, because both
 * transcribe fine and nothing says why every line is doubled. Order is kept -
 * the speaker tag follows the slot, not the device.
 *
 * This lived inline in start(), where nothing could reach it: start() needs an
 * AudioContext, an AudioWorklet and a real getUserMedia, so the only way to
 * cover the rule was to rewrite it in a test and check the rewrite.
 */
export function captureSources(sources: string | string[]): string[] {
  const list = Array.isArray(sources) ? sources : [sources];
  return list.filter((s, i, a) => !!s && a.indexOf(s) === i).slice(0, MAX_CAPTURE_CHANNELS);
}

/**
 * RMS of one interleaved PCM frame, 0..1 - what the 01 SOURCE meter shows.
 *
 * It used to walk the frame with a stride of 3, on the reasoning that an odd
 * stride feeds both channels of an interleaved stereo frame into the meter.
 * That holds only while the stride and the channel count share no factor: at
 * three sources a stride of three lands on channel 0 every single time, so the
 * meter moves convincingly while two of the three are invisible in it. There
 * is no crash and no log line - the streamer simply cannot see that comms went
 * dead.
 *
 * Every sample now, because there is no stride that is coprime with every
 * channel count, and a frame is 100 ms: 4800 samples at three channels, which
 * is not a cost worth being wrong for.
 */
export function rmsLevel(chunk: Int16Array): number {
  if (chunk.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) {
    const v = chunk[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / chunk.length);
}

/** a capture slot whose device has gone away, and what is left after it */
export interface SourceLost {
  /** slot index, i.e. which of the sources passed to start() */
  index: number;
  /** how many slots still have a live track */
  live: number;
}

/** every audio track across the open streams, in slot order */
const tracksOf = (streams: readonly MediaStream[]): MediaStreamTrack[] =>
  streams.map((s) => s.getAudioTracks()[0]).filter(Boolean);

/** whether anything at all is still being captured */
export function anyTrackLive(streams: readonly MediaStream[]): boolean {
  return tracksOf(streams).some((t) => t.readyState === "live");
}

/**
 * Watch each slot's device and report the ones that go away.
 *
 * Nothing listened for this before. Unplug a USB headset mid-game and its track
 * ends, its merger input feeds digital silence, and everything downstream
 * carries on: the app stays LIVE with the clock running, full-rate interleaved
 * PCM keeps flowing so the engine keeps billing at the full channel rate, and
 * that speaker's captions simply stop. The other channel keeps the level bar
 * moving, so there is nothing on screen to notice.
 *
 * A track that has ALREADY ended is reported immediately: `ended` fired before
 * anyone was listening and will never fire again, and one can end between
 * getUserMedia resolving and the graph being wired.
 */
export function watchSourceTracks(
  streams: readonly MediaStream[],
  onLost: (info: SourceLost) => void,
): void {
  const tracks = tracksOf(streams);
  tracks.forEach((track, index) => {
    const report = (): void => onLost({ index, live: tracks.filter((t) => t.readyState === "live").length });
    if (track.readyState === "ended") {
      report();
      return;
    }
    track.addEventListener("ended", report);
  });
}

/**
 * What to put on screen when a start fails.
 *
 * `String(err.message || err)` was the whole of it, and Chromium leaves
 * `OverconstrainedError.message` EMPTY - so a user whose headset had gone got a
 * banner reading exactly `OverconstrainedError`, naming neither the slot nor
 * the device nor the constraint, while `err.constraint` sat in scope unread.
 */
export function captureErrorText(err: unknown): string {
  const e = err as { name?: string; message?: string; constraint?: string } | undefined;
  if (e?.message) return e.message;
  if (e?.name === "OverconstrainedError") {
    const which = e.constraint === "deviceId" ? "device" : e.constraint || "device";
    return `an audio source is not available any more (${which}) - pick another under 01 SOURCE, or hit RESCAN`;
  }
  if (e?.name === "NotAllowedError") return "microphone access was refused - allow it in Windows privacy settings";
  if (e?.name === "NotFoundError") return "no audio input device was found";
  if (typeof err === "string" && err) return err;
  // never String(err) on an unknown: an object with no name stringifies to
  // "[object Object]", which is worse than saying nothing useful on purpose
  return e?.name || "the audio device could not be opened";
}

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

  /**
   * Called when a captured device goes away - unplugged, disabled, or taken by
   * another application. Set by the app; unset means the loss is invisible,
   * which is exactly what it used to be.
   */
  onSourceLost?: (info: SourceLost & { deviceId: string }) => void;

  /**
   * Whether audio is still coming in. This returned the `active` flag, which
   * only ever means "start() ran and stop() has not", so it stayed true with
   * every device unplugged.
   */
  get capturing(): boolean {
    return this.active && anyTrackLive(this.streams);
  }

  /** channels in the PCM frames the current capture emits (1..MAX_CAPTURE_CHANNELS) */
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
   * @param sources up to MAX_CAPTURE_CHANNELS source ids (see listDevices),
   *   normalised by captureSources().
   */
  async start(sources: string | string[], onPcm: (chunk: Int16Array) => void): Promise<void> {
    if (this.active) this.stop();
    const list = captureSources(sources);
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

    watchSourceTracks(streams, (info) => {
      const id = list[info.index] ?? "";
      this.onSourceLost?.({ ...info, deviceId: id });
    });

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
