/**
 * Shared types: config schema, wire protocol, control API.
 * Used by relay, companion, standalone app and stream deck plugin.
 */

/** what the app shows after it updates itself */
export * from "./changelog";

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
  /**
   * The capture sources, in slot order, at most MAX_CAPTURE_CHANNELS of them.
   * Each is "default-mic", "system-loopback" or a deviceId from
   * enumerateDevices(). This is the authoritative list; read it through
   * resolveSourceIds(), which folds in the legacy pair below.
   */
  sources?: string[];
  /** `#rrggbb` per slot, parallel to `sources`; blank uses SPEAKER_COLORS */
  sourceColors?: string[];
  /**
   * Speaker tag per slot, parallel to `sources`. A blank entry means "work it
   * out from the slot" - which is what every install had before names existed,
   * and still the right default for someone who never opens the field.
   */
  sourceLabels?: string[];
  /**
   * @deprecated superseded by `sources`. Still written and still read: it is
   * what the Stream Deck property inspector patches through the control API,
   * and what every config.json already on disk contains.
   * "default-mic" | "system-loopback" | a deviceId from enumerateDevices()
   */
  audioSource: string;
  /**
   * @deprecated superseded by `sources`, kept for the same reasons.
   * Optional second source captured alongside `audioSource` (e.g. system
   * loopback for voice chat while the mic is the first). Empty = off. Each
   * source is transcribed on its own channel and captions carry a speaker tag.
   */
  audioSource2?: string;
  languages: Languages;
  /** false = relay skips Gemini, viewers get source-language only.
   *  Off by default: a fresh install captions the source language until you
   *  add a Gemini key and switch 03 TRANSLATE on. */
  translationEnabled: boolean;
  /** false = strip latency badges from viewer subtitles (app log keeps them) */
  showLatency: boolean;
  /** true = mask profanity in the source captions sent to viewers (the app's own
   *  console keeps the words as heard, so you can see what the STT actually got).
   *  Source language only - the translated line is not filtered. */
  profanityFilter: boolean;
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
  /** the version whose changelog has been shown. Absent on a fresh install,
   *  which is how "never run before" is told from "updated since last run". */
  lastSeenVersion?: string;

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
  profanityFilter: true,
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

/**
 * The settings a remote control may change.
 *
 * The control API on 47477 has no credential and its origin check admits
 * `Origin: null`, so a web page can reach it. `configStore.update` merges
 * whatever it is handed, which put the API keys, the relay endpoint, the
 * publisher token and `updateFeedUrl` - the last of which decides which
 * executable the app downloads and runs - inside reach of a POST from a
 * sandboxed iframe.
 *
 * This is what a Stream Deck legitimately changes: what to transcribe, in which
 * languages, from which device, and how it is shown. Nothing here can point the
 * app at a different server or a different binary.
 */
export const CONTROL_PATCHABLE_KEYS = [
  "stt",
  "translation",
  "audioSource",
  "audioSource2",
  "languages",
  "translationEnabled",
  "showLatency",
  "profanityFilter",
  "output",
  "linkMode",
] as const;

/** the part of an untrusted patch that a remote control is allowed to apply */
export function controlConfigPatch(patch: Record<string, unknown> | null | undefined): {
  allowed: Partial<AppConfig>;
  rejected: string[];
} {
  const allowed: Record<string, unknown> = {};
  const rejected: string[] = [];
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { allowed, rejected };
  for (const [key, value] of Object.entries(patch)) {
    if ((CONTROL_PATCHABLE_KEYS as readonly string[]).includes(key)) allowed[key] = value;
    else rejected.push(key);
  }
  return { allowed: allowed as Partial<AppConfig>, rejected };
}

/**
 * Whether an auto-update feed may be used.
 *
 * electron-updater downloads and runs what the feed names, and this build sets
 * no `publisherName`, so its signature check returns early and the only
 * integrity proof is a hash in the feed's own file. Plain http therefore hands
 * a LAN attacker the installer; loopback is allowed because that is a developer
 * serving their own build.
 */
export function isAllowedUpdateFeed(url: string | undefined | null): boolean {
  if (!url) return true; // unset means the packaged GitHub feed
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
}

/** true when the STT model id runs on this PC (sherpa-onnx) instead of Deepgram */
export function isLocalStt(id: string): boolean {
  const info = sttModel(id);
  return info ? info.provider === "local" : id.startsWith("local-");
}

/**
 * How many capture sources one session can carry. Every layer reads this: the
 * worklet interleaves this many lanes, the relay splits a frame by this many,
 * and the app offers this many pickers. Three covers you + the game + comms.
 *
 * The ceiling is cost, not code. Deepgram bills a multichannel stream per
 * channel, so three sources bill roughly three times the per-minute rate, and
 * on a local model it is a third resampler and a third decode on a machine
 * that is also running the game.
 */
export const MAX_CAPTURE_CHANNELS = 3;

/**
 * The viewer link to hand out, given what is available.
 *
 * `localViewerUrl()` hardcoded the OBS flavour and the fallback returned it
 * unchanged. The desktop footer strips `?obs=1` itself; the tray and the Stream
 * Deck property inspector do not - so on a fresh install (`output: "phone"`, no
 * relay URL) both handed out the overlay variant. The recipient opened it on a
 * phone and got a transparent body, white text, no HUD, every history row
 * hidden and no display settings: one line at a time on the browser's own
 * background, with nothing to say why.
 *
 * The overlay flavour is only ever right when the output IS the overlay. It is
 * never a fallback - undefined is better than a link that renders wrong.
 */
export function viewerLinkFor(opts: {
  output: OutputTarget;
  /** local relay, `?obs=1` */
  obsUrl?: string;
  /** local relay, no suffix */
  plainUrl?: string;
  /** through a remote relay, reachable off the LAN */
  remoteUrl?: string;
}): string | undefined {
  if (opts.output === "obs") return opts.obsUrl;
  return opts.remoteUrl || opts.plainUrl;
}

/**
 * The config fields that decide what the embedded relay and the uplink are.
 * Changing any of them means the relay has to be rebuilt.
 */
export const RELAY_CONFIG_KEYS = [
  "deepgramApiKey",
  "geminiApiKey",
  "relayPort",
  "relayUrl",
  "publisherToken",
  "viewerToken",
] as const;

/**
 * A port the embedded relay can actually bind, or undefined.
 *
 * The app read this as `Number(input.value) || 8787`, and the input's min/max
 * are inert - there is no <form> and nothing calls checkValidity(). So 0,
 * 70000 and -1 were all accepted, persisted with a synchronous write, and only
 * then handed to server.listen, which is far too late: by then the working
 * relay had already been torn down.
 */
export function validRelayPort(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value.trim()) : typeof value === "number" ? value : NaN;
  if (!Number.isInteger(n)) return undefined;
  // below 1024 needs privileges the app does not have and should not ask for
  return n >= 1024 && n <= 65535 ? n : undefined;
}

/**
 * The patch that puts the relay-shaped settings back the way they were.
 *
 * Used when a restart fails: the new config has already been written (the
 * write happens before the restart is attempted), so without this a port that
 * cannot be bound becomes the saved port, every START fails with "local relay
 * not ready", and a relaunch re-reads it and fails identically.
 *
 * Only the relay fields. The same save can carry a language change and a port
 * change; reverting the language because the port failed would be its own bug.
 * A field that was CLEARED comes back as "" rather than undefined, because
 * ConfigStore.merge skips undefined and the bad value would simply stay.
 */
export function relayRollbackPatch(before: AppConfig, after: AppConfig): Partial<AppConfig> {
  const patch: Record<string, unknown> = {};
  for (const key of RELAY_CONFIG_KEYS) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    patch[key] = before[key] === undefined ? "" : before[key];
  }
  return patch as Partial<AppConfig>;
}

/** the source every install starts on, and the fallback when nothing is named */
export const DEFAULT_SOURCE = "default-mic";

/**
 * The capture sources a config actually names, in slot order.
 *
 * `sources` wins when it is a usable list; otherwise the legacy
 * audioSource/audioSource2 pair is folded in. That order matters: the pair is
 * what the Stream Deck writes, so preferring it would silently drop a third
 * source every time someone pressed a Stream Deck key.
 *
 * Blanks are dropped and a device named twice is collapsed - two channels
 * carrying one voice is the most confusing failure this app has, because both
 * transcribe fine and nothing says why every line is doubled. Entries that are
 * not strings are ignored rather than coerced: a hand-edited config should not
 * be able to open a channel called "[object Object]".
 */
export function resolveSourceIds(cfg: Partial<AppConfig> | null | undefined): string[] {
  const listed = Array.isArray(cfg?.sources) ? cfg.sources : undefined;
  const raw = listed ?? [cfg?.audioSource ?? "", cfg?.audioSource2 ?? ""];
  const ids = raw
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .filter((s, i, a) => a.indexOf(s) === i)
    .slice(0, MAX_CAPTURE_CHANNELS);
  // a list present but unusable still falls back to the pair before giving up
  if (!ids.length && listed) return resolveSourceIds({ ...cfg, sources: undefined });
  return ids.length ? ids : [DEFAULT_SOURCE];
}

/**
 * Default tag colour per slot. Distinct on purpose: with three speakers the
 * tag is the only thing telling them apart, and two of them sharing a colour
 * is the same as not having one.
 */
export const SPEAKER_COLORS: readonly string[] = ["#e0a43a", "#7fb6d9", "#9ad17f"];

/**
 * A speaker colour, or undefined.
 *
 * This arrives from the publisher and ends up in a style attribute on the
 * viewer. On the embedded relay the publisher is the desktop app; on a hosted
 * one it is whoever holds a publish token. So it is untrusted input on its way
 * into CSS. Anything that is not plainly `#rrggbb` is dropped rather than
 * escaped - there is no reason to accept `red`, `var(--x)` or a URL, and every
 * reason not to try to clean up something that looks like one.
 */
export function safeSpeakerColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(v) ? v : undefined;
}

/** what a device enumerates as; a virtual chat mix is indistinguishable from a headset */
export type SourceKind = "mic" | "system";

/** the longest speaker tag the relay will carry (server.ts slices to this) */
export const MAX_SPEAKER_TAG = 12;

/**
 * The speaker tag shown against each source's captions, in slot order.
 *
 * The role follows the SLOT, not the device kind: a chat mix off a virtual
 * audio device (Wave Link, VoiceMeeter, VB-Cable) enumerates as a microphone
 * exactly like a headset does, so the kind cannot tell "me" from "the others".
 * A system source is the exception - it is always the other voices, whichever
 * slot it sits in.
 *
 * Past the second slot there is no role left to derive. Two microphones are
 * two microphones; nothing in the device list says which one is the coach. So
 * the third defaults to a slot number and the answer is that the streamer
 * names it - which is the whole reason `sourceLabels` exists.
 *
 * One source gets no tag at all: there is nobody to tell it apart from.
 */
export function speakerTags(kinds: readonly SourceKind[], labels?: readonly (string | undefined)[]): string[] {
  if (kinds.length < 2) return [];
  const derived =
    kinds[0] !== kinds[1]
      ? kinds.map((k) => (k === "system" ? "CHAT" : "YOU"))
      : kinds.map((_, i) => (i === 0 ? "YOU" : "CHAT"));
  return kinds.map((_, i) => {
    const given = labels?.[i];
    const name = typeof given === "string" ? given.trim() : "";
    if (name) return name.slice(0, MAX_SPEAKER_TAG);
    return i < 2 ? derived[i] : `CH${i + 1}`;
  });
}

/**
 * Anything the pipeline cannot interleave collapses to mono.
 *
 * Note it does not round an over-count DOWN to the cap. The number is not a
 * preference, it is how many samples every interleaved frame holds: read a
 * 4-channel frame as 3 and every lane after the first is a different voice on
 * every frame. Mono is the only reading that cannot be wrong about which
 * sample belongs to whom.
 */
export function clampChannels(n: unknown): 1 | 2 | 3 {
  if (n === 3) return 3;
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

/**
 * Bytes this model occupies once it is installed, which is not what it
 * downloads. An archive streams through memory and never lands on disk, so the
 * space that has to be free is what it unpacks to - and for the bigger models
 * that is close to twice the download: whisper turbo fetches 564 MB and leaves
 * 1037 MB behind. `sizeMb` answers "how long is this going to take"; this
 * answers "will it fit".
 */
export function modelDiskBytes(info: SttModelInfo): number {
  const files = (info.files ?? []).reduce((n, f) => n + f.size, 0);
  // offline models also need the shared VAD alongside them
  const vad = info.kind === "offline" ? (LOCAL_VAD.files ?? []).reduce((n, f) => n + f.size, 0) : 0;
  return files + vad;
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

/**
 * Stems the caption filter masks. Each also matches the ordinary inflections
 * (-s, -es, -ed, -ing, -er, -ers, -y), so one entry covers "fuck", "fucks",
 * "fucked", "fucking", "fucker".
 *
 * Whole words only. A filter that eats "class", "pass", "assume" or
 * "Scunthorpe" is worse than no filter at all, because the streamer stops
 * trusting it and turns it off - so this errs toward letting a word through
 * rather than mangling ordinary speech. Mild words (damn, hell, crap) are
 * deliberately absent: they are not what a broadcast filter is for.
 */
const PROFANITY_STEMS = [
  "fuck",
  "motherfuck",
  "shit",
  "bullshit",
  "bitch",
  "cunt",
  "cock",
  "dick",
  "pussy",
  "bastard",
  "asshole",
  "arsehole",
  "ass",
  "arse",
  "whore",
  "slut",
  "twat",
  "wank",
  "prick",
  "piss",
  "tit",
  "nigger",
  "nigga",
  "faggot",
  "fag",
  "retard",
  "spastic",
];

/**
 * Built once. `\b` on both ends is what keeps "ass" out of "class" and "bass",
 * and the optional suffix group is inside the boundary so "assassin" cannot
 * match either.
 */
const PROFANITY_RE = new RegExp(
  `\\b(?:${PROFANITY_STEMS.join("|")})(?:s|es|ed|ing|er|ers|y|ies)?\\b`,
  "gi",
);

/**
 * Mask profanity for display, keeping the first letter: "fuck" -> "f***".
 *
 * Length is preserved so the line does not reflow, and the first letter is kept
 * so a reader can tell a mask from a redaction - an all-asterisk blob reads as
 * "something was removed here", which draws more attention than it deflects.
 *
 * This is a courtesy filter, not an adversarial one. It does not chase
 * character substitution ("f*ck", "sh1t") or spaced-out spelling: the STT emits
 * ordinary words, and a filter that guesses at obfuscation starts eating real
 * speech.
 */
export function maskProfanity(text: string): string {
  if (!text) return text;
  return text.replace(PROFANITY_RE, (word) => word[0] + "*".repeat(word.length - 1));
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
  /** `#rrggbb` the tag is painted in; absent means the viewer's own default */
  color?: string;
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
      /** false = relay sends source captions to viewers unmasked (default is masked) */
      profanityFilter?: boolean;
      /** 1 (default) to MAX_CAPTURE_CHANNELS interleaved capture channels, each transcribed separately */
      channels?: 1 | 2 | 3;
      /** speaker tag per channel, e.g. ["YOU", "CHAT"] */
      channelLabels?: string[];
      /** `#rrggbb` per channel, parallel to channelLabels */
      channelColors?: string[];
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
