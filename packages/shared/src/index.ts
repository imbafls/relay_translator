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
  relayPort: 8787,
};

export const STT_MODELS = [
  { id: "deepgram-nova-3", label: "Deepgram Nova-3 - fastest, English-first" },
  { id: "deepgram-nova-3-multi", label: "Deepgram Nova-3 Multi - en/es/fr/de/pt/it..." },
  { id: "deepgram-nova-2", label: "Deepgram Nova-2 - wide language incl. vi" },
] as const;

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
}

export interface UsageInfo {
  deepgram: {
    /** STT audio minutes processed by the local relay (this install) */
    sttMinutes: number;
    /** rough USD estimate at nova-3 PAYG (~$0.0043/min) */
    estCostUsd: number;
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
