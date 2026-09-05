/**
 * Shared types: config schema, wire protocol, control API.
 * Used by relay, companion, standalone app and stream deck plugin.
 */

export type LanguageCode = string;

export interface Languages {
  source: LanguageCode;
  target: LanguageCode;
}

export type OutputTarget = "phone" | "obs" | "both";

export type SttEngine = "cloud" | "local";

export interface AppConfig {
  /** where speech is transcribed: Deepgram (cloud) or a model on this PC (local) */
  sttEngine: SttEngine;
  /** cloud STT model id, e.g. "deepgram-nova-3" */
  stt: string;
  /** local STT model id from LOCAL_STT_MODELS, e.g. "local-zipformer-en-20m" */
  localStt: string;
  /** folder holding downloaded local models; empty = <dataDir>/models */
  modelsDir?: string;
  /** Translation model id, e.g. "gemini-2.5-flash" */
  translation: string;
  /**
   * Primary capture source: "default-mic" | "system-loopback" | a deviceId
   * from enumerateDevices(). Always equals audioSources[0]; kept so old
   * configs and the Stream Deck inspector keep working.
   */
  audioSource: string;
  /** every source mixed into the session (primary first) */
  audioSources: string[];
  /** false until onboarding's OPEN CONSOLE; setup can be re-run any time */
  setupComplete: boolean;
  languages: Languages;
  /** false = relay skips Gemini, viewers get source-language only.
   *  Off by default: a fresh install captions the source language until you
   *  add a Gemini key and switch 03 TRANSLATE on. */
  translationEnabled: boolean;
  /** false = strip latency badges from viewer subtitles (app log keeps them) */
  showLatency: boolean;
  /** "unique" = fresh viewer link every session, "fixed" = stable link */
  linkMode: "unique" | "fixed";
  /** false = never check for updates in the background (manual CHECK still works) */
  autoUpdate: boolean;
  /** static directory serving latest.yml + installers; empty = the GitHub release feed */
  updateFeedUrl?: string;
  /** @deprecated superseded by `output`; kept so old config files still parse */
  obsOverlay: boolean;
  /** where captions are shown: phone link (internet/LAN), OBS browser source, or both */
  output: OutputTarget;

  /** secrets (stored in local config file / env, never shipped) */
  deepgramApiKey?: string;
  geminiApiKey?: string;

  /** "ws://host:port" of a remote relay; empty = run embedded relay */
  relayUrl?: string;
  /** port for the embedded relay (default 8787) */
  relayPort?: number;
  /** override for the viewer link base (e.g. a tunnel URL) */
  publicBaseUrl?: string;
  /** token overrides for remote relay mode (embedded relay manages its own) */
  publisherToken?: string;
  viewerToken?: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  sttEngine: "cloud",
  stt: "deepgram-nova-3",
  localStt: "local-zipformer-en-20m",
  translation: "gemini-3.1-flash-lite",
  audioSource: "default-mic",
  audioSources: ["default-mic"],
  setupComplete: false,
  languages: { source: "en", target: "vi" },
  translationEnabled: false,
  showLatency: true,
  linkMode: "unique",
  autoUpdate: true,
  obsOverlay: false,
  output: "phone",
  relayPort: 8787,
};

export const STT_MODELS = [
  { id: "deepgram-nova-3", label: "Deepgram Nova-3 - fastest, English-first" },
  { id: "deepgram-nova-3-multi", label: "Deepgram Nova-3 Multi - en/es/fr/de/pt/it..." },
  { id: "deepgram-nova-2", label: "Deepgram Nova-2 - wide language incl. vi" },
] as const;

/** the STT model id a session actually runs with (what goes into the publisher hello) */
export function effectiveSttModel(cfg: Pick<AppConfig, "sttEngine" | "stt" | "localStt">): string {
  return cfg.sttEngine === "local" ? cfg.localStt || DEFAULT_CONFIG.localStt : cfg.stt || DEFAULT_CONFIG.stt;
}

/** local model ids carry this prefix; the relay picks the engine from it */
export const LOCAL_STT_PREFIX = "local-";
export function isLocalSttModel(id: string): boolean {
  return id.startsWith(LOCAL_STT_PREFIX);
}

// ---------------------------------------------------------------------------
// Local STT model catalog (sherpa-onnx models, downloaded on demand)
// ---------------------------------------------------------------------------

export type ModelTier = "light" | "medium" | "heavy";

/** streaming = live words as you speak; phrase = one caption per detected phrase */
export type LocalSttMode = "streaming" | "phrase";

/** which sherpa-onnx recognizer config the engine builds from the model folder */
export type LocalSttKind =
  | "online-transducer"
  | "online-transducer-nemotron"
  | "offline-transducer-nemo"
  | "moonshine"
  | "whisper"
  | "sense-voice";

export interface LocalSttModel {
  id: string;
  label: string;
  /** short name for the chain strip */
  short: string;
  tier: ModelTier;
  mode: LocalSttMode;
  kind: LocalSttKind;
  /** archive base name on the sherpa-onnx `asr-models` GitHub release */
  archive: string;
  /** download size, MB */
  sizeMb: number;
  /** ISO 639-1 codes, or "multi" for broad multilingual models */
  languages: string[];
  /** editorial 1-5 ratings (approximate) */
  speed: 1 | 2 | 3 | 4 | 5;
  accuracy: 1 | 2 | 3 | 4 | 5;
  note: string;
}

export const MODEL_RELEASE_BASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";
export const VAD_MODEL_FILE = "silero_vad.onnx";

export const MODEL_TIERS: { id: ModelTier; label: string; blurb: string }[] = [
  { id: "light", label: "LIGHT", blurb: "Runs on any PC, even next to a game. Live words, fewer of them right." },
  { id: "medium", label: "MEDIUM", blurb: "The sweet spot for a 6-core desktop. Better words, still quick." },
  { id: "heavy", label: "HEAVY", blurb: "Near cloud accuracy. Needs a strong CPU that is not busy with a game." },
];

export const LOCAL_STT_MODELS: LocalSttModel[] = [
  {
    id: "local-zipformer-en-20m",
    label: "Zipformer 20M · streaming",
    short: "Zipformer 20M",
    tier: "light",
    mode: "streaming",
    kind: "online-transducer",
    archive: "sherpa-onnx-streaming-zipformer-en-20M-2023-02-17",
    sizeMb: 121,
    languages: ["en"],
    speed: 5,
    accuracy: 2,
    note: "Live word-by-word captions with almost no CPU. Misses names and slang.",
  },
  {
    id: "local-moonshine-tiny",
    label: "Moonshine tiny",
    short: "Moonshine tiny",
    tier: "light",
    mode: "phrase",
    kind: "moonshine",
    archive: "sherpa-onnx-moonshine-tiny-en-int8",
    sizeMb: 102,
    languages: ["en"],
    speed: 5,
    accuracy: 3,
    note: "Whole phrases land a beat after you stop talking. Beats Whisper tiny at the same size.",
  },
  {
    id: "local-whisper-tiny-en",
    label: "Whisper tiny.en",
    short: "Whisper tiny",
    tier: "light",
    mode: "phrase",
    kind: "whisper",
    archive: "sherpa-onnx-whisper-tiny.en",
    sizeMb: 112,
    languages: ["en"],
    speed: 3,
    accuracy: 2,
    note: "The classic. Pads every phrase to 30 s, so slower than its size suggests.",
  },
  {
    id: "local-zipformer-en",
    label: "Zipformer EN · streaming",
    short: "Zipformer EN",
    tier: "medium",
    mode: "streaming",
    kind: "online-transducer",
    archive: "sherpa-onnx-streaming-zipformer-en-2023-06-26",
    sizeMb: 296,
    languages: ["en"],
    speed: 4,
    accuracy: 3,
    note: "Live words with a bigger vocabulary. The pick if you want captions while you speak.",
  },
  {
    id: "local-moonshine-base",
    label: "Moonshine base",
    short: "Moonshine base",
    tier: "medium",
    mode: "phrase",
    kind: "moonshine",
    archive: "sherpa-onnx-moonshine-base-en-int8",
    sizeMb: 239,
    languages: ["en"],
    speed: 4,
    accuracy: 4,
    note: "On par with Whisper small at a fraction of the cost. Good default for phrases.",
  },
  {
    id: "local-whisper-base-en",
    label: "Whisper base.en",
    short: "Whisper base",
    tier: "medium",
    mode: "phrase",
    kind: "whisper",
    archive: "sherpa-onnx-whisper-base.en",
    sizeMb: 198,
    languages: ["en"],
    speed: 2,
    accuracy: 3,
    note: "Familiar output style; noticeably slower per phrase than Moonshine.",
  },
  {
    id: "local-sense-voice",
    label: "SenseVoice · zh en ja ko yue",
    short: "SenseVoice",
    tier: "medium",
    mode: "phrase",
    kind: "sense-voice",
    archive: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09",
    sizeMb: 158,
    languages: ["zh", "en", "ja", "ko", "yue"],
    speed: 4,
    accuracy: 4,
    note: "Fast multilingual model for Chinese, Japanese, Korean, Cantonese and English.",
  },
  {
    id: "local-parakeet-tdt-0.6b-v2",
    label: "Parakeet TDT 0.6B v2",
    short: "Parakeet v2",
    tier: "heavy",
    mode: "phrase",
    kind: "offline-transducer-nemo",
    archive: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    sizeMb: 460,
    languages: ["en"],
    speed: 3,
    accuracy: 5,
    note: "Top of the open English leaderboards. Surprisingly quick for its size.",
  },
  {
    id: "local-parakeet-tdt-0.6b-v3",
    label: "Parakeet TDT 0.6B v3 · 25 languages",
    short: "Parakeet v3",
    tier: "heavy",
    mode: "phrase",
    kind: "offline-transducer-nemo",
    archive: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    sizeMb: 464,
    languages: ["multi"],
    speed: 3,
    accuracy: 5,
    note: "Parakeet for 25 European languages, auto-detected.",
  },
  {
    id: "local-nemotron-streaming-0.6b",
    label: "Nemotron 3.5 streaming 0.6B",
    short: "Nemotron",
    tier: "heavy",
    mode: "streaming",
    kind: "online-transducer-nemotron",
    archive: "sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11",
    sizeMb: 453,
    languages: ["multi"],
    speed: 2,
    accuracy: 5,
    note: "Live words with heavy-tier accuracy, 25 languages. Wants 8+ fast cores.",
  },
  {
    id: "local-whisper-turbo",
    label: "Whisper large-v3 turbo",
    short: "Whisper turbo",
    tier: "heavy",
    mode: "phrase",
    kind: "whisper",
    archive: "sherpa-onnx-whisper-turbo",
    sizeMb: 537,
    languages: ["multi"],
    speed: 1,
    accuracy: 5,
    note: "Whisper's best. Every language, but each phrase takes seconds on a CPU.",
  },
];

export function localSttModel(id: string): LocalSttModel | undefined {
  return LOCAL_STT_MODELS.find((m) => m.id === id);
}

export type ModelState = "missing" | "downloading" | "unpacking" | "ready" | "error";

export interface ModelStatus {
  id: string;
  state: ModelState;
  /** download progress 0-100 */
  percent?: number;
  /** bytes received so far */
  bytes?: number;
  /** short human reason for "error" */
  detail?: string;
  /** absolute folder the model lives in (when ready) */
  dir?: string;
}

export interface LocalSttInfo {
  /** the native engine loaded on this machine */
  available: boolean;
  /** why not, when unavailable */
  detail?: string;
  modelsDir: string;
  models: ModelStatus[];
}

export interface HardwareInfo {
  /** logical CPU threads */
  threads: number;
  cpu: string;
  /** installed RAM, GB (rounded) */
  ramGb: number;
  recommended: ModelTier;
}

/** conservative: a game is usually running on the same CPU */
export function recommendTier(threads: number, ramGb: number): ModelTier {
  if (threads >= 12 && ramGb >= 16) return "heavy";
  if (threads >= 6 && ramGb >= 8) return "medium";
  return "light";
}

export const TRANSLATION_MODELS = [
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite - cheapest, big free quota" },
  { id: "gemini-flash-latest", label: "Gemini Flash (latest) - best quality" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash - legacy (free tier: ~20 req/day)" },
] as const;

export const LANGUAGES: { code: LanguageCode; label: string }[] = [
  { code: "en", label: "English" },
  { code: "vi", label: "Tiếng Việt (Vietnamese)" },
  { code: "es", label: "Español (Spanish)" },
  { code: "pt", label: "Português (Portuguese)" },
  { code: "fr", label: "Français (French)" },
  { code: "de", label: "Deutsch (German)" },
  { code: "ru", label: "Русский (Russian)" },
  { code: "ja", label: "日本語 (Japanese)" },
  { code: "ko", label: "한국어 (Korean)" },
  { code: "zh", label: "中文 (Chinese)" },
  { code: "th", label: "ไทย (Thai)" },
  { code: "id", label: "Bahasa Indonesia" },
];

// ---------------------------------------------------------------------------
// Relay wire protocol
// ---------------------------------------------------------------------------

export interface SubtitleSegment {
  id: number;
  source: string;
  target?: string;
  ts: number;
}

export interface SubtitleLatency {
  /** speech ended -> text finalized (ms) */
  stt?: number;
  /** source final -> translation delivered (ms) */
  translate?: number;
}

export type ServerToViewer =
  | { type: "hello"; languages: Languages; live: boolean; translates: boolean; since?: number }
  | { type: "partial"; id: number; source: string }
  | { type: "subtitle"; id: number; source: string; target?: string; final: boolean; latency?: SubtitleLatency }
  | { type: "status"; live: boolean; message?: string; since?: number }
  | { type: "kicked"; reason: string }
  | { type: "pong" };

export type ViewerToServer = { type: "ping" } | { type: "sync" };

export type ServerToPublisher =
  | { type: "ready"; sampleRate: number }
  | { type: "status"; live: boolean; message?: string }
  | { type: "partial"; id: number; source: string }
  | { type: "subtitle"; id: number; source: string; target?: string; latency?: SubtitleLatency }
  | { type: "error"; message: string }
  | { type: "pong" };

/** Binary frames = raw PCM s16le mono 16 kHz. Text frames = JSON control. */
export type PublisherToServer =
  | {
      type: "hello";
      stt: string;
      translation: string;
      languages: Languages;
      /** false = relay skips Gemini (source-only subtitles) */
      translationEnabled?: boolean;
      /** false = relay strips latency badges from viewer broadcasts */
      latencyVisible?: boolean;
    }
  | { type: "ping" };

// ---------------------------------------------------------------------------
// Uplink protocol (app -> remote relay subtitle fan-out)
// The uplink carries FINISHED subtitles: the remote relay does no STT/translation.
// Auth: publisher token. Mirrors the viewer-facing messages.
// ---------------------------------------------------------------------------

export type UplinkToServer =
  | { type: "hello"; languages: Languages; translates: boolean; since?: number }
  | { type: "subtitle"; id: number; source: string; target?: string; final: boolean; latency?: SubtitleLatency }
  | { type: "status"; live: boolean; message?: string; since?: number }
  | { type: "ping" };

export type ServerToUplink =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "pong" }
  /** number of viewers currently attached to the remote relay */
  | { type: "viewers"; count: number };

// ---------------------------------------------------------------------------
// Local control API (companion process <-> standalone UI <-> Stream Deck)
// ---------------------------------------------------------------------------

export const CONTROL_PORT = 47477;
export const CONTROL_CLIENT_HEADER = "x-callout-relay-client";

export interface AudioDeviceInfo {
  id: string;
  label: string;
  kind: "mic" | "system";
}

export type SessionState = "idle" | "starting" | "live" | "stopping" | "error";

export interface ControlStatus {
  companion: { version: string };
  session: {
    state: SessionState;
    error?: string;
    startedAt?: number;
  };
  relay: {
    mode: "embedded" | "remote";
    url: string;
    viewerUrl?: string;
    /** local OBS/LAN link (embedded relay) - present when the local relay runs */
    localViewerUrl?: string;
    /** internet link (remote relay uplink) - present when configured */
    remoteViewerUrl?: string;
    /** uplink connection state to the remote relay (phone viewers) */
    uplinkState?: "off" | "connecting" | "connected" | "disconnected" | "error";
    /** last measured uplink ping round-trip (ms) */
    uplinkRttMs?: number;
    /** viewers attached to the local relay (OBS + LAN phones) */
    viewers?: number;
    /** viewers attached to the remote relay via the uplink */
    remoteViewers?: number;
  };
  devices: AudioDeviceInfo[];
  config: AppConfig;
  usage?: UsageInfo;
  update?: UpdateStatus;
  localStt?: LocalSttInfo;
  hardware?: HardwareInfo;
}

export interface UsageInfo {
  deepgram: {
    /** STT audio minutes sent to Deepgram by the local relay (this install) */
    sttMinutes: number;
    /** rough USD estimate at nova-3 PAYG (~$0.0043/min) */
    estCostUsd: number;
  };
  local?: {
    /** STT audio minutes transcribed on this PC */
    sttMinutes: number;
  };
  gemini: {
    /** translations issued since relay start */
    count: number;
    /** served from the local translation cache (0 API calls) */
    cacheHits: number;
    tokensIn: number;
    tokensOut: number;
    /** rough USD estimate from model pricing (0 on free tier) */
    estCostUsd?: number;
  };
}

// ---------------------------------------------------------------------------
// Auto-update (desktop app <-> renderer / control API)
// ---------------------------------------------------------------------------

export type UpdateState =
  /** nothing checked yet this run */
  | "idle"
  | "checking"
  /** a newer version exists but is not downloaded yet */
  | "available"
  | "downloading"
  /** downloaded and staged; installs on restart */
  | "ready"
  /** already on the newest version */
  | "current"
  | "error"
  /** this build cannot replace itself (portable exe / unpackaged dev run) */
  | "unsupported";

export interface UpdateStatus {
  state: UpdateState;
  /** version currently running */
  current: string;
  /** newest version seen, when known */
  latest?: string;
  /** download progress, 0-100 */
  percent?: number;
  /** short human reason for "error" / "unsupported" */
  detail?: string;
  /** where to download by hand when self-update is unavailable */
  releaseUrl?: string;
  /** epoch ms of the last completed check */
  checkedAt?: number;
}

/** result of an API-key test request (see standalone `keys:validate`) */
export interface KeyValidation {
  valid: boolean;
  /** short human reason when invalid / unreachable */
  detail?: string;
  /** Deepgram: remaining credit in USD when the API exposes it */
  creditUsd?: number;
}

export interface ControlEvent {
  type: "status";
  status: ControlStatus;
}
