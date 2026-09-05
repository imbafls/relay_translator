import { Languages, ServerToViewer, SubtitleLatency, ServerToPublisher, clampChannels, isLocalStt } from "@callout-relay/shared";
import {
  SAMPLE_RATE,
  createDeepgramStream,
  createMockSttStream,
  SttStream,
} from "./deepgram";
import { createLocalSttStream, LocalSttOptions } from "./localStt";
import {
  createGeminiTranslator,
  createMockTranslator,
  Translator,
} from "./gemini";

export interface SessionConfig {
  stt: string;
  translation: string;
  languages: Languages;
  /** false = skip Gemini, source-language subtitles only */
  translationEnabled: boolean;
  /** false = strip latency badges from viewer broadcasts (publisher echo keeps them) */
  latencyVisible: boolean;
  /** 1 or 2 interleaved capture channels */
  channels: number;
  /** speaker tag per channel (only sent when channels > 1) */
  channelLabels?: string[];
}

export interface GeminiStats {
  count: number;
  cacheHits: number;
  tokensIn: number;
  tokensOut: number;
}

export interface SttStats {
  /** seconds of audio billed by Deepgram (channels multiply) */
  seconds: number;
  /** seconds of audio transcribed on this PC */
  localSeconds: number;
}

export interface SessionDeps {
  deepgramApiKey?: string;
  geminiApiKey?: string;
  mockStt?: boolean;
  mockGemini?: boolean;
  /** stand in for Gemini (tests, and any embedder that brings its own engine) */
  translator?: Translator;
  /** where local models live + the worker script; absent = local STT unavailable */
  localStt?: LocalSttOptions;
  /** fan-out to all viewers */
  toViewers(msg: ServerToViewer): void;
  /** echo subtitles to the publisher (in-app live log) */
  toPublisher?(msg: Extract<ServerToPublisher, { type: "subtitle" | "partial" }>): void;
  /** aggregate translation usage (process lifetime) */
  geminiStats?: GeminiStats;
  /** aggregate STT audio (process lifetime) */
  sttStats?: SttStats;
  /** STT engine errors, forwarded to the publisher's app log */
  onSttError?(message: string): void;
  setLive(live: boolean): void;
  log(level: "info" | "warn" | "error", message: string): void;
}

/**
 * One publisher session: PCM in -> STT finals -> Gemini -> viewer broadcast.
 * Source text goes out immediately (final:true, no target) so viewers see it
 * within the STT budget; the translation patches the same segment id.
 *
 * With two capture channels every channel has its own interim segment id so
 * "YOU" and "CHAT" can talk over each other without clobbering one another.
 */
export class PublisherSession {
  private segId = 0;
  /** id reserved for the interim line of each channel */
  private pendingId: (number | undefined)[] = [];
  private stt: SttStream | null = null;
  private translator: Translator | null = null;
  private inflight = 0;
  private geminiErrorLogged = false;
  private closing = false;
  /** wall clock of the first audio byte (STT word timings are relative to it) */
  private streamWallStart = 0;
  /** whether Gemini runs for this session */
  translates = true;
  readonly local: boolean;

  constructor(
    private readonly cfg: SessionConfig,
    private readonly deps: SessionDeps,
  ) {
    this.local = isLocalStt(cfg.stt);
  }

  private tag(channel: number): { channel?: number; speaker?: string } {
    if (this.cfg.channels <= 1) return {};
    return { channel, speaker: this.cfg.channelLabels?.[channel] || `CH${channel + 1}` };
  }

  start(): void {
    const { source, target } = this.cfg.languages;
    const translates = this.cfg.translationEnabled !== false;
    this.translates = translates;

    this.translator = !translates
      ? null
      : this.deps.translator
        ? this.deps.translator
        : this.deps.mockGemini || !this.deps.geminiApiKey
        ? createMockTranslator(target)
        : createGeminiTranslator({
            apiKey: this.deps.geminiApiKey!,
            model: this.cfg.translation || "gemini-3.1-flash-lite",
            source,
            target,
            stats: this.deps.geminiStats
              ? {
                  onUse: (use) => {
                    const s = this.deps.geminiStats!;
                    if (use.cached) s.cacheHits += 1;
                    else {
                      s.count += 1;
                      s.tokensIn += use.tokensIn;
                      s.tokensOut += use.tokensOut;
                    }
                  },
                }
              : undefined,
          });

    const events = {
      onOpen: () => {
        this.deps.log(
          "info",
          `stt open (${this.cfg.stt}, ${source}${this.cfg.channels > 1 ? `, ${this.cfg.channels} channels` : ""})`,
        );
        this.deps.toViewers({ type: "status", live: true });
        this.deps.setLive(true);
      },
      onPartial: (text: string, channel: number) => {
        if (this.closing) return;
        if (this.pendingId[channel] === undefined) this.pendingId[channel] = ++this.segId;
        const id = this.pendingId[channel]!;
        const tag = this.tag(channel);
        this.deps.toViewers({ type: "partial", id, source: text, ...tag });
        this.deps.toPublisher?.({ type: "partial", id, source: text, ...tag });
      },
      onFinal: (text: string, meta: { audioEndSec?: number; channel: number }) => {
        const channel = meta.channel;
        const id = this.pendingId[channel] ?? ++this.segId;
        this.pendingId[channel] = undefined;
        const tag = this.tag(channel);
        const finalAt = Date.now();
        const sttMs =
          meta.audioEndSec !== undefined && this.streamWallStart > 0
            ? Math.max(0, Math.round(finalAt - this.streamWallStart - meta.audioEndSec * 1000))
            : undefined;
        const latency: SubtitleLatency = sttMs !== undefined ? { stt: sttMs } : {};
        const viewerLatency = this.cfg.latencyVisible !== false ? latency : undefined;
        this.deps.toViewers({ type: "subtitle", id, source: text, final: true, latency: viewerLatency, ...tag });
        this.deps.toPublisher?.({ type: "subtitle", id, source: text, latency, ...tag });
        if (!this.translator) return;
        this.inflight += 1;
        this.translator
          .translate(text)
          .then((targetText) => {
            const full: SubtitleLatency = {
              ...latency,
              translate: Math.round(Date.now() - finalAt),
            };
            this.deps.toViewers({
              type: "subtitle",
              id,
              source: text,
              target: targetText,
              final: true,
              latency: this.cfg.latencyVisible !== false ? full : undefined,
              ...tag,
            });
            this.deps.toPublisher?.({ type: "subtitle", id, source: text, target: targetText, latency: full, ...tag });
          })
          .catch((err) => {
            if (!this.geminiErrorLogged) {
              this.geminiErrorLogged = true;
              this.deps.log("error", `translation failed: ${err.message}`);
            }
          })
          .finally(() => {
            this.inflight -= 1;
          });
      },
      onError: (message: string) => {
        this.deps.log("error", `stt error: ${message}`);
        this.deps.onSttError?.(message);
      },
      onClose: () => {
        if (!this.closing) {
          this.deps.log("warn", "stt closed unexpectedly");
          this.deps.toViewers({ type: "status", live: false, message: "speech pipeline lost" });
          this.deps.setLive(false);
        }
      },
    };

    const channels = clampChannels(this.cfg.channels);
    if (this.deps.mockStt) {
      this.stt = createMockSttStream(events, channels);
    } else if (this.local) {
      if (!this.deps.localStt) {
        this.deps.log("error", "local STT requested but this relay has no local model support");
        setImmediate(() => events.onClose());
        this.stt = { sendAudio() {}, close() {} };
      } else {
        this.stt = createLocalSttStream(
          this.deps.localStt,
          { model: this.cfg.stt, language: source, channels },
          events,
        );
      }
    } else if (!this.deps.deepgramApiKey) {
      this.stt = createMockSttStream(events, channels);
    } else {
      this.stt = createDeepgramStream(
        {
          apiKey: this.deps.deepgramApiKey,
          model: this.cfg.stt || "deepgram-nova-3",
          language: source,
          channels,
        },
        events,
      );
    }
  }

  /** sample rate expected from the publisher */
  get sampleRate(): number {
    return SAMPLE_RATE;
  }

  audio(chunk: Buffer): void {
    if (this.streamWallStart === 0) this.streamWallStart = Date.now();
    if (this.deps.sttStats) {
      // bytes -> seconds of (mono-equivalent) audio; Deepgram bills every channel
      const seconds = chunk.length / (SAMPLE_RATE * 2 * Math.max(1, this.cfg.channels));
      if (this.local) this.deps.sttStats.localSeconds += seconds;
      else this.deps.sttStats.seconds += seconds * Math.max(1, this.cfg.channels);
    }
    this.stt?.sendAudio(chunk);
  }

  stop(): void {
    if (this.closing) return;
    this.closing = true;
    try {
      this.stt?.close();
    } catch {
      /* noop */
    }
    this.stt = null;
    this.deps.setLive(false);
  }

  /**
   * Wait for translations that were already in flight when the session stopped.
   * The last thing said before STOP finals late, so its translation is usually
   * still running; without this it races whoever is tearing the session down.
   * Resolves with the number still outstanding, which is 0 unless the timeout
   * won - a wedged translator must not hold a shutdown open.
   */
  async drain(timeoutMs = 5000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.inflight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.inflight;
  }
}
