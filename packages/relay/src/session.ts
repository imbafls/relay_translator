import { Languages, ServerToViewer } from "@callout-relay/shared";
import {
  SAMPLE_RATE,
  createDeepgramStream,
  createMockSttStream,
  SttStream,
} from "./deepgram";
import {
  createGeminiTranslator,
  createMockTranslator,
  Translator,
} from "./gemini";

export interface SessionConfig {
  stt: string;
  translation: string;
  languages: Languages;
}

export interface SessionDeps {
  deepgramApiKey?: string;
  geminiApiKey?: string;
  mockStt?: boolean;
  mockGemini?: boolean;
  /** fan-out to all viewers */
  toViewers(msg: ServerToViewer): void;
  /** echo subtitles to the publisher (in-app live log) */
  toPublisher?(msg: { type: "subtitle"; id: number; source: string; target?: string }): void;
  setLive(live: boolean): void;
  log(level: "info" | "warn" | "error", message: string): void;
}

/**
 * One publisher session: PCM in -> Deepgram finals -> Gemini -> viewer broadcast.
 * Source text goes out immediately (final:true, no target) so viewers see it
 * within the Deepgram budget; the translation patches the same segment id.
 */
export class PublisherSession {
  private segId = 0;
  private stt: SttStream | null = null;
  private translator: Translator | null = null;
  private inflight = 0;
  private geminiErrorLogged = false;
  private closing = false;

  constructor(
    private readonly cfg: SessionConfig,
    private readonly deps: SessionDeps,
  ) {}

  start(): void {
    const { source, target } = this.cfg.languages;

    this.translator =
      this.deps.mockGemini || !this.deps.geminiApiKey
        ? createMockTranslator(target)
        : createGeminiTranslator({
            apiKey: this.deps.geminiApiKey!,
            model: this.cfg.translation || "gemini-2.5-flash",
            source,
            target,
          });

    const events = {
      onOpen: () => {
        this.deps.log("info", `stt open (${this.cfg.stt}, ${source})`);
        this.deps.toViewers({ type: "status", live: true });
        this.deps.setLive(true);
      },
      onPartial: (text: string) => {
        this.deps.toViewers({ type: "partial", id: this.segId + 1, source: text });
      },
      onFinal: (text: string) => {
        const id = ++this.segId;
        this.deps.toViewers({ type: "subtitle", id, source: text, final: true });
        this.deps.toPublisher?.({ type: "subtitle", id, source: text });
        this.inflight += 1;
        this.translator!
          .translate(text)
          .then((targetText) => {
            this.deps.toViewers({ type: "subtitle", id, source: text, target: targetText, final: true });
            this.deps.toPublisher?.({ type: "subtitle", id, source: text, target: targetText });
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
      },
      onClose: () => {
        if (!this.closing) {
          this.deps.log("warn", "stt closed unexpectedly");
          this.deps.toViewers({ type: "status", live: false, message: "speech pipeline lost" });
          this.deps.setLive(false);
        }
      },
    };

    this.stt =
      this.deps.mockStt || !this.deps.deepgramApiKey
        ? createMockSttStream(events)
        : createDeepgramStream(
            {
              apiKey: this.deps.deepgramApiKey,
              model: this.cfg.stt || "deepgram-nova-3",
              language: source,
            },
            events,
          );
  }

  /** sample rate expected from the publisher */
  get sampleRate(): number {
    return SAMPLE_RATE;
  }

  audio(chunk: Buffer): void {
    this.stt?.sendAudio(chunk);
  }

  get busy(): boolean {
    return this.stt !== null;
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
}
