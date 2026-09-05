/**
 * Shared types: config schema, wire protocol, control API.
 * Used by relay, companion, standalone app and stream deck plugin.
 */

export type LanguageCode = string;

export interface Languages {
  source: LanguageCode;
  target: LanguageCode;
}

export interface AppConfig {
  /** STT model id, e.g. "deepgram-nova-3" */
  stt: string;
  /** Translation model id, e.g. "gemini-2.5-flash" */
  translation: string;
  /** "default-mic" | "system-loopback" | a deviceId from enumerateDevices() */
  audioSource: string;
  languages: Languages;
  /** "unique" = fresh viewer link every session, "fixed" = stable link */
  linkMode: "unique" | "fixed";
  /** viewer link gets ?obs=1 appended for OBS browser source */
  obsOverlay: boolean;

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
  linkMode: "unique",
  obsOverlay: false,
  relayPort: 8787,
};

export const STT_MODELS = [
  { id: "deepgram-nova-3", label: "Deepgram Nova-3 — fastest, English-first" },
  { id: "deepgram-nova-3-multi", label: "Deepgram Nova-3 Multi — en/es/fr/de/pt/it..." },
  { id: "deepgram-nova-2", label: "Deepgram Nova-2 — wide language incl. vi" },
] as const;

export const TRANSLATION_MODELS = [
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite — cheapest, big free quota" },
  { id: "gemini-flash-latest", label: "Gemini Flash (latest) — best quality" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash — legacy (free tier: ~20 req/day)" },
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

export type ServerToViewer =
  | { type: "hello"; languages: Languages; live: boolean }
  | { type: "partial"; id: number; source: string }
  | { type: "subtitle"; id: number; source: string; target?: string; final: boolean }
  | { type: "status"; live: boolean; message?: string }
  | { type: "kicked"; reason: string }
  | { type: "pong" };

export type ViewerToServer = { type: "ping" } | { type: "sync" };

export type ServerToPublisher =
  | { type: "ready"; sampleRate: number }
  | { type: "status"; live: boolean; message?: string }
  | { type: "subtitle"; id: number; source: string; target?: string }
  | { type: "error"; message: string }
  | { type: "pong" };

/** Binary frames = raw PCM s16le mono 16 kHz. Text frames = JSON control. */
export type PublisherToServer =
  | { type: "hello"; stt: string; translation: string; languages: Languages }
  | { type: "ping" };

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
  };
  devices: AudioDeviceInfo[];
  config: AppConfig;
}

export interface ControlEvent {
  type: "status";
  status: ControlStatus;
}
