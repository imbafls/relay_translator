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

export interface AppConfig {
  /** STT model id, e.g. "deepgram-nova-3" */
  stt: string;
  /** Translation model id, e.g. "gemini-2.5-flash" */
  translation: string;
  /** "default-mic" | "system-loopback" | a deviceId from enumerateDevices() */
  audioSource: string;
  /** optional second source captured alongside `audioSource` (e.g. system
   *  loopback for voice chat while the mic is the first). Empty = off. Each
   *  source is transcribed on its own channel and captions carry a speaker tag. */
  audioSource2?: string;
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
  /** first-run setup finished (it can be re-run any time from KEYS or the tray) */
  setupDone: boolean;

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
  stt: "deepgram-nova-3",
  translation: "gemini-3.1-flash-lite",
  audioSource: "default-mic",
  languages: { source: "en", target: "vi" },
  translationEnabled: false,
  showLatency: true,
  linkMode: "unique",
  autoUpdate: true,
  obsOverlay: false,
  output: "phone",
  setupDone: false,
  relayPort: 8787,
};

/**
 * Where the app lands when the model its config names has left the catalogue.
 * A model can be dropped between versions - whisper-small was, for aborting the
 * process on load - and the app must not strand itself on the missing id. It
 * has to be a cloud model: a fresh fallback cannot assume anything is on disk.
 * The catalogue tests hold both of those properties.
 */
export const FALLBACK_STT = "deepgram-nova-3";

/** true when the STT model id runs on this PC (sherpa-onnx) instead of Deepgram */
export function isLocalStt(id: string): boolean {
  const info = sttModel(id);
  return info ? info.provider === "local" : id.startsWith("local-");
}

/** capture channels are 1 or 2; anything else on the wire collapses to mono */
export function clampChannels(n: unknown): 1 | 2 {
  return n === 2 ? 2 : 1;
}

export interface SttModelFile {
  name: string;
  url: string;
  /** bytes, for progress */
  size: number;
}

/**
 * How much of the machine a local model wants. Setup recommends one from the
 * CPU and RAM it finds, because a game is usually running on the same box.
 */
export type ModelTier = "light" | "medium" | "heavy";

export const MODEL_TIERS: { id: ModelTier; label: string; blurb: string }[] = [
  { id: "light", label: "LIGHT", blurb: "Runs on any PC, even next to a game. Fewer words land right." },
  { id: "medium", label: "MEDIUM", blurb: "The sweet spot for a 6-core desktop. Better words, still quick." },
  { id: "heavy", label: "HEAVY", blurb: "Near cloud accuracy. Wants a strong CPU that a game is not already using." },
];

/**
 * A model shipped as one tar.bz2 on the sherpa-onnx releases page instead of
 * loose files. `pick` maps the local file name the worker expects to the entry
 * inside the archive.
 */
export interface SttModelArchive {
  url: string;
  /** compressed bytes, for progress */
  size: number;
  pick: Record<string, string>;
}

export interface SttModelInfo {
  id: string;
  label: string;
  provider: "deepgram" | "local";
  /** local only: streaming = word-by-word partials, offline = VAD-segmented utterances */
  kind?: "streaming" | "offline";
  /** short human language coverage */
  languages?: string;
  /** local only: download size */
  sizeMb?: number;
  /** local only: files fetched into <dataDir>/models/<id>/ */
  files?: SttModelFile[];
  /** local only: fetched as one archive; `files` then lists what it unpacks to */
  archive?: SttModelArchive;
  /** local only: sherpa-onnx model family */
  engine?: "zipformer-online" | "nemotron-online" | "nemo-transducer" | "sense-voice" | "whisper" | "moonshine";
  /** local only: mel bins the model was exported with (whisper large-v3 and
   *  nemotron use 128; everything else 80) */
  melBins?: 80 | 128;
  /** local only: how much machine it wants */
  tier?: ModelTier;
  /** local only: approximate 1-5 ratings, for the setup picker */
  speed?: 1 | 2 | 3 | 4 | 5;
  accuracy?: 1 | 2 | 3 | 4 | 5;
  /** local only: one line on what the model is good and bad at */
  note?: string;
}

const HF = "https://huggingface.co";
const GH_MODELS = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

/**
 * Local models come from the sherpa-onnx mirrors on Hugging Face, one plain
 * file per entry, so the app can stream them with progress and never needs a
 * tar.bz2 decoder. Sizes are the int8 exports.
 */
export const STT_MODELS: SttModelInfo[] = [
  { id: "deepgram-nova-3", label: "Deepgram Nova-3 - fastest, English-first", provider: "deepgram", languages: "en (+multi)" },
  { id: "deepgram-nova-3-multi", label: "Deepgram Nova-3 Multi - en/es/fr/de/pt/it...", provider: "deepgram", languages: "multilingual" },
  { id: "deepgram-nova-2", label: "Deepgram Nova-2 - wide language incl. vi", provider: "deepgram", languages: "wide incl. vi" },
  {
    id: "local-zipformer-en-20m",
    label: "Zipformer EN 20M - streaming, tiny, word-by-word",
    provider: "local",
    kind: "streaming",
    engine: "zipformer-online",
    languages: "en",
    sizeMb: 44,
    tier: "light",
    speed: 5,
    accuracy: 2,
    note: "Live word-by-word captions for almost no CPU. Misses names and slang.",
    files: [
      { name: "encoder.int8.onnx", url: `${HF}/csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17/resolve/main/encoder-epoch-99-avg-1.int8.onnx`, size: 42845182 },
      { name: "decoder.int8.onnx", url: `${HF}/csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17/resolve/main/decoder-epoch-99-avg-1.int8.onnx`, size: 539499 },
      { name: "joiner.int8.onnx", url: `${HF}/csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17/resolve/main/joiner-epoch-99-avg-1.int8.onnx`, size: 259572 },
      { name: "tokens.txt", url: `${HF}/csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17/resolve/main/tokens.txt`, size: 5048 },
    ],
  },
  {
    id: "local-parakeet-tdt-0.6b-v3",
    label: "Parakeet TDT 0.6B v3 - best accuracy, en + 24 European",
    provider: "local",
    kind: "offline",
    engine: "nemo-transducer",
    languages: "en + 24 European",
    sizeMb: 670,
    tier: "heavy",
    speed: 3,
    accuracy: 5,
    note: "Top of the open leaderboards, and quick for its size. Auto-detects the language.",
    files: [
      { name: "encoder.int8.onnx", url: `${HF}/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/encoder.int8.onnx`, size: 652184281 },
      { name: "decoder.int8.onnx", url: `${HF}/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/decoder.int8.onnx`, size: 11845275 },
      { name: "joiner.int8.onnx", url: `${HF}/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/joiner.int8.onnx`, size: 6355277 },
      { name: "tokens.txt", url: `${HF}/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/tokens.txt`, size: 93939 },
    ],
  },
  {
    id: "local-sense-voice",
    label: "SenseVoice Small - zh/en/ja/ko/yue",
    provider: "local",
    kind: "offline",
    engine: "sense-voice",
    languages: "zh en ja ko yue",
    sizeMb: 240,
    tier: "medium",
    speed: 4,
    accuracy: 4,
    note: "Fast across Chinese, Japanese, Korean, Cantonese and English.",
    files: [
      { name: "model.int8.onnx", url: `${HF}/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx`, size: 239233841 },
      { name: "tokens.txt", url: `${HF}/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt`, size: 315894 },
    ],
  },
  // "local-whisper-small" lived here. sherpa-onnx aborts the process while
  // constructing the recognizer for it - not a catchable error - with files
  // that match Hugging Face byte for byte, under every config we tried, while
  // whisper tiny.en on the same build loads and decodes. Removed rather than
  // shipped as a model that kills the app; the load probe in localStt.ts now
  // contains this class of failure for anything else that misbehaves.

  // --- archive models: one tar.bz2 from the sherpa-onnx releases page -------
  {
    id: "local-moonshine-tiny",
    label: "Moonshine Tiny - fast English utterances",
    provider: "local",
    kind: "offline",
    engine: "moonshine",
    languages: "en",
    sizeMb: 108,
    tier: "light",
    speed: 5,
    accuracy: 3,
    note: "Beats Whisper Tiny at the same size. Whole phrases land a beat after you stop talking.",
    archive: {
      url: `${GH_MODELS}/sherpa-onnx-moonshine-tiny-en-int8.tar.bz2`,
      size: 107600538,
      pick: {
        "preprocess.onnx": "preprocess.onnx",
        "encode.int8.onnx": "encode.int8.onnx",
        "uncached_decode.int8.onnx": "uncached_decode.int8.onnx",
        "cached_decode.int8.onnx": "cached_decode.int8.onnx",
        "tokens.txt": "tokens.txt",
      },
    },
    files: [
      { name: "preprocess.onnx", url: "", size: 6800738 },
      { name: "encode.int8.onnx", url: "", size: 18249187 },
      { name: "uncached_decode.int8.onnx", url: "", size: 53216096 },
      { name: "cached_decode.int8.onnx", url: "", size: 45264830 },
      { name: "tokens.txt", url: "", size: 436688 },
    ],
  },
  {
    id: "local-whisper-tiny-en",
    label: "Whisper Tiny EN - the classic, smallest",
    provider: "local",
    kind: "offline",
    engine: "whisper",
    languages: "en",
    sizeMb: 118,
    tier: "light",
    speed: 3,
    accuracy: 2,
    note: "Familiar Whisper output at the smallest size. Slower than its size suggests.",
    archive: {
      url: `${GH_MODELS}/sherpa-onnx-whisper-tiny.en.tar.bz2`,
      size: 118071777,
      pick: {
        "encoder.int8.onnx": "tiny.en-encoder.int8.onnx",
        "decoder.int8.onnx": "tiny.en-decoder.int8.onnx",
        "tokens.txt": "tiny.en-tokens.txt",
      },
    },
    files: [
      { name: "encoder.int8.onnx", url: "", size: 12937772 },
      { name: "decoder.int8.onnx", url: "", size: 89853865 },
      { name: "tokens.txt", url: "", size: 835554 },
    ],
  },
  {
    id: "local-zipformer-en",
    label: "Zipformer EN - streaming, bigger vocabulary",
    provider: "local",
    kind: "streaming",
    engine: "zipformer-online",
    languages: "en",
    sizeMb: 310,
    tier: "medium",
    speed: 4,
    accuracy: 3,
    note: "Live words with a wider vocabulary. The pick if you want captions while you speak.",
    archive: {
      url: `${GH_MODELS}/sherpa-onnx-streaming-zipformer-en-2023-06-26.tar.bz2`,
      size: 310414022,
      pick: {
        "encoder.int8.onnx": "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
        "decoder.int8.onnx": "decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
        "joiner.int8.onnx": "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
        "tokens.txt": "tokens.txt",
      },
    },
    files: [
      { name: "encoder.int8.onnx", url: "", size: 70108816 },
      { name: "decoder.int8.onnx", url: "", size: 540688 },
      { name: "joiner.int8.onnx", url: "", size: 259416 },
      { name: "tokens.txt", url: "", size: 5048 },
    ],
  },
  {
    id: "local-moonshine-base",
    label: "Moonshine Base - accurate English utterances",
    provider: "local",
    kind: "offline",
    engine: "moonshine",
    languages: "en",
    sizeMb: 251,
    tier: "medium",
    speed: 4,
    accuracy: 4,
    note: "On par with much larger models for English, at a fraction of the CPU.",
    archive: {
      url: `${GH_MODELS}/sherpa-onnx-moonshine-base-en-int8.tar.bz2`,
      size: 250807309,
      pick: {
        "preprocess.onnx": "preprocess.onnx",
        "encode.int8.onnx": "encode.int8.onnx",
        "uncached_decode.int8.onnx": "uncached_decode.int8.onnx",
        "cached_decode.int8.onnx": "cached_decode.int8.onnx",
        "tokens.txt": "tokens.txt",
      },
    },
    files: [
      { name: "preprocess.onnx", url: "", size: 14077290 },
      { name: "encode.int8.onnx", url: "", size: 50311494 },
      { name: "uncached_decode.int8.onnx", url: "", size: 122120451 },
      { name: "cached_decode.int8.onnx", url: "", size: 99983837 },
      { name: "tokens.txt", url: "", size: 436688 },
    ],
  },
  {
    id: "local-parakeet-tdt-0.6b-v2",
    label: "Parakeet TDT 0.6B v2 - best English accuracy",
    provider: "local",
    kind: "offline",
    engine: "nemo-transducer",
    languages: "en",
    sizeMb: 482,
    tier: "heavy",
    speed: 3,
    accuracy: 5,
    note: "The English-only Parakeet. Same accuracy as v3 on English, smaller download.",
    archive: {
      url: `${GH_MODELS}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2`,
      size: 482468385,
      pick: {
        "encoder.int8.onnx": "encoder.int8.onnx",
        "decoder.int8.onnx": "decoder.int8.onnx",
        "joiner.int8.onnx": "joiner.int8.onnx",
        "tokens.txt": "tokens.txt",
      },
    },
    files: [
      { name: "encoder.int8.onnx", url: "", size: 652184296 },
      { name: "decoder.int8.onnx", url: "", size: 7257753 },
      { name: "joiner.int8.onnx", url: "", size: 1739080 },
      { name: "tokens.txt", url: "", size: 9384 },
    ],
  },
  {
    id: "local-nemotron-streaming",
    label: "Nemotron 3.5 Streaming 0.6B - live words, heavy",
    provider: "local",
    kind: "streaming",
    engine: "nemotron-online",
    languages: "en + 24 European",
    sizeMb: 475,
    tier: "heavy",
    speed: 2,
    accuracy: 5,
    note: "Word-by-word captions at heavy-tier accuracy. Wants eight fast cores to keep up.",
    archive: {
      url: `${GH_MODELS}/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11.tar.bz2`,
      size: 475271763,
      pick: {
        "encoder.int8.onnx": "encoder.int8.onnx",
        "decoder.int8.onnx": "decoder.int8.onnx",
        "joiner.int8.onnx": "joiner.int8.onnx",
        "tokens.txt": "tokens.txt",
      },
    },
    files: [
      { name: "encoder.int8.onnx", url: "", size: 657601403 },
      { name: "decoder.int8.onnx", url: "", size: 14978075 },
      { name: "joiner.int8.onnx", url: "", size: 9504438 },
      { name: "tokens.txt", url: "", size: 131440 },
    ],
  },
  {
    id: "local-whisper-turbo",
    melBins: 128,
    label: "Whisper Large v3 Turbo - every language, slowest",
    provider: "local",
    kind: "offline",
    engine: "whisper",
    languages: "~100 incl. vi",
    sizeMb: 564,
    tier: "heavy",
    speed: 1,
    accuracy: 5,
    note: "Whisper's best. Every language, but each phrase takes seconds on a CPU.",
    archive: {
      url: `${GH_MODELS}/sherpa-onnx-whisper-turbo.tar.bz2`,
      size: 563790207,
      pick: {
        "encoder.int8.onnx": "turbo-encoder.int8.onnx",
        "decoder.int8.onnx": "turbo-decoder.int8.onnx",
        "tokens.txt": "turbo-tokens.txt",
      },
    },
    files: [
      { name: "encoder.int8.onnx", url: "", size: 674716297 },
      { name: "decoder.int8.onnx", url: "", size: 361080764 },
      { name: "tokens.txt", url: "", size: 816730 },
    ],
  },
];

/** what this PC can comfortably run - a game is usually on the same CPU */
export interface HardwareInfo {
  /** logical CPU threads */
  threads: number;
  cpu: string;
  /** installed RAM, GB (rounded) */
  ramGb: number;
  recommended: ModelTier;
}

export function recommendTier(threads: number, ramGb: number): ModelTier {
  if (threads >= 12 && ramGb >= 16) return "heavy";
  if (threads >= 6 && ramGb >= 8) return "medium";
  return "light";
}

/** silero VAD - segments speech for every offline local model */
export const LOCAL_VAD: SttModelInfo = {
  id: "local-vad-silero",
  label: "Silero VAD",
  provider: "local",
  kind: "offline",
  sizeMb: 1,
  files: [
    { name: "silero_vad.onnx", url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx", size: 643854 },
  ],
};

export function sttModel(id: string): SttModelInfo | undefined {
  return STT_MODELS.find((m) => m.id === id);
}

/** download state of one local model (desktop app -> renderer / control API) */
export interface LocalModelStatus {
  id: string;
  downloaded: boolean;
  sizeMb: number;
  /** 0-100 while a download runs */
  progress?: number;
  error?: string;
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

/** which capture channel a line came from, when two sources are on */
export interface SpeakerTag {
  /** 0-based capture channel */
  channel?: number;
  /** short label shown before the line, e.g. "YOU" / "CHAT" */
  speaker?: string;
}

export type ServerToViewer =
  | { type: "hello"; languages: Languages; live: boolean; translates: boolean; since?: number }
  | ({ type: "partial"; id: number; source: string } & SpeakerTag)
  | ({ type: "subtitle"; id: number; source: string; target?: string; final: boolean; latency?: SubtitleLatency } & SpeakerTag)
  | { type: "status"; live: boolean; message?: string; since?: number }
  | { type: "kicked"; reason: string }
  | { type: "pong" };

export type ViewerToServer = { type: "ping" } | { type: "sync" };

export type ServerToPublisher =
  | { type: "ready"; sampleRate: number }
  | { type: "status"; live: boolean; message?: string }
  | ({ type: "partial"; id: number; source: string } & SpeakerTag)
  | ({ type: "subtitle"; id: number; source: string; target?: string; latency?: SubtitleLatency } & SpeakerTag)
  | { type: "error"; message: string }
  | { type: "pong" };

/**
 * Binary frames = raw PCM s16le 16 kHz, mono, or interleaved stereo when the
 * hello said `channels: 2`. Text frames = JSON control.
 */
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
      /** 1 (default) or 2 interleaved capture channels, each transcribed separately */
      channels?: 1 | 2;
      /** speaker tag per channel, e.g. ["YOU", "CHAT"] */
      channelLabels?: string[];
    }
  | { type: "ping" };

// ---------------------------------------------------------------------------
// Uplink protocol (app -> remote relay subtitle fan-out)
// The uplink carries FINISHED subtitles: the remote relay does no STT/translation.
// Auth: publisher token. Mirrors the viewer-facing messages.
// ---------------------------------------------------------------------------

export type UplinkToServer =
  | { type: "hello"; languages: Languages; translates: boolean; since?: number }
  | ({ type: "subtitle"; id: number; source: string; target?: string; final: boolean; latency?: SubtitleLatency } & SpeakerTag)
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
  /** download state of the local STT models (desktop app only) */
  localModels?: LocalModelStatus[];
  /** CPU / RAM of the machine running the app, for the model recommendation */
  hardware?: HardwareInfo;
}

export interface UsageInfo {
  deepgram: {
    /** STT audio minutes billed by Deepgram (each channel counts) */
    sttMinutes: number;
    /** rough USD estimate at nova-3 PAYG (~$0.0043/min) */
    estCostUsd: number;
  };
  /** minutes transcribed on this PC (free) */
  local?: {
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
