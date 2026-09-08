/**
 * Shared types: config schema, wire protocol, control API.
 * Used by the relay, the companion, the desktop app and the hosted relay.
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
   * what an older config carries,
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
  /**
   * Minutes of unbroken silence before the relay stops paying to transcribe
   * it; 0 disables. Required, like `showLatency` and `profanityFilter`: as
   * `?:` this typed `undefined` and forced a `?? 0` fallback in session.ts
   * whose meaning ("no default at all -> gate disabled") was the opposite of
   * the intended safe default (60). It was only correct because
   * `DEFAULT_CONFIG` happened to set it - required makes the compiler
   * enforce that rather than trust it.
   */
  idleBillingStopMinutes: number;
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
  /** what viewers are told this stream is called; blank means unbranded */
  brandName?: string;
  /** `#rrggbb` accent for the viewer's header only, never for caption text */
  brandColor?: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  stt: "deepgram-nova-3",
  translation: "gemini-3.1-flash-lite",
  audioSource: "default-mic",
  languages: { source: "en", target: "vi" },
  translationEnabled: false,
  showLatency: true,
  profanityFilter: true,
  idleBillingStopMinutes: 60,
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

/**
 * What to do with the update feed, given the configured override and whatever
 * was last handed to electron-updater. Split out from the updater so the
 * decision can be tested without Electron: the updater only executes it.
 *
 * `restart-needed` is the one that is not a full answer. electron-updater has
 * no public way to go back to the packaged `app-update.yml` once `setFeedURL`
 * has replaced it, so clearing the override takes a relaunch - and the caller
 * has to say so out loud rather than leaving the old feed silently in place.
 */
export type UpdateFeedAction =
  | { action: "none" }
  | { action: "set"; url: string }
  | { action: "refused"; url: string }
  | { action: "restart-needed" };

export function updateFeedAction(configured: string | undefined, applied: string | undefined): UpdateFeedAction {
  const next = configured?.trim() || undefined;
  if (!next) return applied ? { action: "restart-needed" } : { action: "none" };
  if (!isAllowedUpdateFeed(next)) return { action: "refused", url: next };
  return next === applied ? { action: "none" } : { action: "set", url: next };
}

/**
 * The relay the app claims a room on when the user asks for a link that works
 * outside their network. A Cloudflare Worker, one Durable Object per room; it
 * does no transcription and no translation and holds no keys - it only fans
 * finished captions out to whoever has the link.
 *
 * The apex, not a `relay.` subdomain: the Worker serves the landing page at `/`
 * and the viewer at `/watch/<token>`, and the viewer link is the most-shared
 * thing this project makes - `textrelay.cc/watch/<token>` says what it is.
 *
 * `relay.supr.systems` still answers and still passes both verify scripts, so
 * rooms claimed before this changed keep working. Moving is a release, not a
 * deploy, which is the point of keeping both.
 */
export const HOSTED_RELAY_URL = "wss://textrelay.cc";

/**
 * Where to POST to get a room, given the relay address the app stores.
 *
 * The stored address is a WebSocket url because that is what the uplink dials;
 * claiming is ordinary HTTP to the same origin. Undefined for anything that is
 * not a bare `ws://host` or `wss://host` - the same rule `httpOriginOfRelayUrl`
 * applies in the app, kept identical on purpose, because a half-accepted
 * address is how the footer ends up quietly handing out the LAN link.
 */
export function claimUrlFor(relayUrl: string | undefined): string | undefined {
  const m = (relayUrl || "").match(/^(wss?):\/\/([^/]+)\/?$/i);
  if (!m) return undefined;
  const scheme = m[1].toLowerCase() === "wss" ? "https" : "http";
  return `${scheme}://${m[2]}/claim`;
}

/** what POST /claim answers with: one room, two tokens */
export interface RoomClaim {
  publisherToken: string;
  viewerToken: string;
}

export function isRoomClaim(value: unknown): value is RoomClaim {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.publisherToken === "string" && v.publisherToken.length > 0 &&
    typeof v.viewerToken === "string" && v.viewerToken.length > 0;
}

/**
 * Hide the token inside a viewer link, keeping the shape of the URL.
 *
 * A viewer link is `<origin>/watch/<viewerToken>`, and that token is the whole
 * auth model - no second factor, no expiry, no IP binding - so the link IS the
 * secret. Redacting the `viewerToken` field and printing the URL is the same
 * leak in a different shape, which is why this exists in one place and both the
 * control API and the app's own footer go through it.
 *
 * The origin is deliberately left alone: a masked link the user cannot
 * recognise is not something they will trust, and the origin is not the secret.
 */
export function maskViewerLink(url: string | undefined, mask = "***"): string | undefined {
  if (!url) return url;
  return url.replace(/\/watch\/[^/?#]+/, `/watch/${mask}`);
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
 * Fix-round-2 Finding 3. `idleBillingStopMinutes` is `number` on `AppConfig`
 * (required, per the comment on that field), but `ConfigStore.merge()` in
 * `packages/companion/src/config.ts` writes a hand-edited `config.json`
 * straight into it - `JSON.parse` plus an `as Partial<AppConfig>` cast, with
 * nothing checking the parsed value actually is one. TypeScript trusts the
 * cast, so a typo'd `"abc"` or a stray negative sign reaches `session.ts`
 * typed as a `number` even though it never was one at runtime.
 *
 * That matters here specifically because the field fails open: session.ts's
 * gate only ever fires on `idleMinutes > 0`, and both `"abc" > 0` (NaN,
 * coerced) and `-5 > 0` are `false` - so a broken value does not error, it
 * just silently disables the one setting in this build whose entire purpose
 * is to stop money leaking. `validRelayPort` above is the precedent for not
 * trusting raw JSON as though it had passed through a form; same shape here,
 * with the same explicit-`0`-is-not-a-mistake exception, since `0` is the
 * config's own documented escape hatch and must keep disabling the bound.
 */
export function validIdleBillingStopMinutes(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_CONFIG.idleBillingStopMinutes;
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
 * what an older config carries, so preferring it would silently drop a third
 * source for anyone upgrading.
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

/** the longest brand name a viewer page will render */
export const MAX_BRAND_NAME = 24;

/**
 * What a stream calls itself, as shown to viewers.
 *
 * Separate from `MAX_SPEAKER_TAG`: a speaker tag is drawn on every caption and
 * has to stay short, while this appears once in the header and can afford a
 * real name. Reusing one number for both would tie two unrelated layouts
 * together.
 */
export function safeBrandName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().slice(0, MAX_BRAND_NAME);
  return v.length > 0 ? v : undefined;
}

/**
 * Publisher-chosen identity for a stream, shown in the viewer's header and
 * nowhere else. Untrusted: it arrives over a socket from whoever holds the
 * publish token.
 */
export interface Brand {
  brandName?: string;
  brandColor?: string;
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

/**
 * How long the stream has been live, stamped by the relay as it sends.
 *
 * `since` is the STREAMER's `Date.now()`, forwarded verbatim, and a viewer
 * computing `Date.now() - since` on its own clock showed every bit of skew
 * between the two machines as duration error - and a viewer whose clock ran
 * behind clamped to a session timer frozen at 00:00:00. Elapsed milliseconds do
 * not care whose clock produced them. `since` stays for older viewers.
 */
export interface SessionElapsed {
  since?: number;
  elapsedMs?: number;
}

export type ServerToViewer =
  | ({ type: "hello"; languages: Languages; live: boolean; translates: boolean } & SessionElapsed & Brand)
  | ({ type: "partial"; id: number; source: string } & SpeakerTag)
  | ({ type: "subtitle"; id: number; source: string; target?: string; final: boolean; latency?: SubtitleLatency } & SpeakerTag)
  | ({ type: "status"; live: boolean; message?: string } & SessionElapsed)
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
      /** what viewers are told this stream is called */
      brandName?: string;
      /** `#rrggbb` accent for the viewer header */
      brandColor?: string;
    }
  | { type: "ping" };

// ---------------------------------------------------------------------------
// Uplink protocol (app -> remote relay subtitle fan-out)
// The uplink carries FINISHED subtitles: the remote relay does no STT/translation.
// Auth: publisher token. Mirrors the viewer-facing messages.
// ---------------------------------------------------------------------------

export type UplinkToServer =
  | ({ type: "hello"; languages: Languages; translates: boolean; since?: number; live?: boolean } & Brand)
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
// App status (main process -> renderer)
//
// `ControlStatus` keeps its name because it is what the whole app calls this
// shape. It was the payload of a loopback HTTP API the Stream Deck plugin read;
// that plugin and that API are both gone, and this is now purely what the main
// process hands its own renderer over IPC.
// ---------------------------------------------------------------------------


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
    /** whether the speech pipeline is currently connected; absent on a remote relay */
    sttLive?: boolean;
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

// ---------------------------------------------------------------------------
// Log redaction - runs on the client, before a log ever leaves the machine
// ---------------------------------------------------------------------------

/**
 * Strip anything that could authenticate or identify this install out of
 * `relay.log` before it can be attached to a feedback report and uploaded.
 *
 * This has to live here, in `packages/shared`, and has to run before the
 * upload exists - not in the Worker that would receive it. Redacting
 * server-side would mean the secret had already left the machine, and
 * "Keys never leave your machine, and neither does your audio."
 * (packages/viewer/public/home.html) would be false in the only sense that
 * matters. There is no telemetry and no account either - this is the only
 * thing standing between a pasted API key and someone else's inbox.
 *
 * Rule order, and why it is not arbitrary:
 *
 * 1. `token=` / `key=` / `secret=` / `auth=` / `password=` / `sig=` /
 *    `signature=` query parameters are redacted whole, first, by POSITION
 *    rather than by the shape of the value. The name may carry a prefix
 *    (`access_token`, `apiKey`, `publisherToken` all match - the parameter
 *    name only has to *end* in one of those words) since a shape rule can't
 *    be relied on to recognise every value shape this build will ever see.
 *    `CLAUDE.md` records a past redaction that masked a token FIELD and left
 *    the same token sitting in a URL elsewhere in the payload - the fix
 *    there was to give query parameters their own rule, and the same
 *    reasoning applies to ordering here: if a shape-specific rule
 *    (hex-length, `AIza`-prefix) ran first and the value in the URL doesn't
 *    fit that shape exactly - longer, shorter, or a token format this build
 *    has never seen - the shape-specific rule simply won't match it, and it
 *    would sail through untouched. Matching by position (immediately after
 *    the parameter name, up to the next URL delimiter) can't be fooled that
 *    way. The value alternation also recognises an already-placed
 *    `<redacted>` marker, so redacting an already-redacted line is a no-op
 *    instead of prepending a second marker - see point 5 below for why that
 *    mattered.
 * 2. `/watch/<token>` paths are redacted whole next, mirroring
 *    `maskViewerLink` above: a hosted-relay viewer link's token IS the whole
 *    auth model (see that function's comment), and `/watch/` is the one
 *    place that token is guaranteed to show up as an opaque URL path segment
 *    rather than inside a header or a JSON body.
 * 3. Basic-auth credentials embedded in a URL (`//user:pass@host`) are
 *    redacted next, again by position - matched to the LAST `@` in the
 *    authority (a greedy, slash-bounded value class that backtracks to find
 *    it), the way a URL parser resolves the userinfo/host boundary. Matching
 *    the first `@` instead - which a value class that excludes `@` from both
 *    the user and password pieces is forced to do - leaves a fragment of the
 *    password glued onto the host whenever the password itself contains an
 *    `@` (`https://u:p@ss@example.com` used to come out
 *    `//<redacted>@ss@example.com`): a partial mask, which is exactly what
 *    the invariant below forbids.
 * 4. Windows account names in a path are redacted next, before the generic
 *    hex/key rules below. An account name that happens to be hex-looking
 *    would otherwise be swallowed by the 32-hex relay-token rule and come
 *    out mislabelled `<redacted>` instead of `<user>` - still hidden, but
 *    the wrong marker, and it stops the username rule from ever running
 *    (there is nothing 32-hex left in the path for it to see). Every
 *    context-qualified name on the line is collected first, from the
 *    original text, then each one is redacted everywhere it appears via a
 *    single pass - a per-user subfolder derived from the same name, a
 *    second mention, or a second, different account name entirely, would
 *    otherwise survive. That single pass (rather than writing the `<user>`
 *    marker and then re-scanning for bare occurrences of the name) is also
 *    what keeps this idempotent for an account literally named "user": a
 *    second scan's boundary-anchored "user" would otherwise match the "user"
 *    text inside the marker it had just written, producing `<<user>>`.
 *
 *    That boundary is a Unicode-aware lookaround
 *    (`(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])`, `u` flag), not `\b`. `\b` only
 *    anchors at a transition between a word character (`[A-Za-z0-9_]`) and a
 *    non-word one, so an account name whose first or last character falls
 *    outside that class - an accented letter, a CJK name, a trailing "." -
 *    means the transition never happens on that side and the whole
 *    alternation fails to match, leaving the name on the line everywhere,
 *    not just at the boundary. A lookaround needs no transition, only the
 *    absence of a letter/digit/underscore on the outside, so it anchors
 *    regardless of what script the matched name is in - the same reasoning
 *    as the hex rules' alphanumeric lookaround in point 5 below, widened
 *    from ASCII alphanumerics to `\p{L}`/`\p{N}` so it covers any script.
 * 5. RFC1918 addresses, Gemini-shaped keys, Deepgram-shaped keys and bare
 *    32-hex relay tokens follow. The two hex-length rules cannot collide
 *    with each other: hex characters are a subset of `[0-9A-Za-z]`, so an
 *    alphanumeric lookaround only anchors at the very start and end of a hex
 *    run, never in the middle of one - a 40-hex Deepgram key has no internal
 *    boundary for the 32-hex rule to match against once this rule's own
 *    40-hex pass has already consumed it.
 *
 *    That boundary is deliberately an alphanumeric lookaround, not `\b`
 *    (word-character) as it used to be. `\b` treats `_` as part of the
 *    "word", so `\b[0-9a-f]{32}\b` could never anchor inside a value like
 *    the hosted relay's own `p1_<rid>_<secret>` / `v1_<rid>_<secret>` tokens
 *    (`apps/hosted-relay/src/tokens.ts`) - the secret half is exactly 32 hex
 *    characters, but the `_` on either side is a word character too, so the
 *    whole token used to sail through untouched wherever it appeared: a
 *    `/watch/` path (also covered by point 2 above, independently), a
 *    `Bearer` header, a JSON body, or an env-shaped line. That gap is the
 *    *same property* that made `\b` safe against internal collisions in a
 *    contiguous hex run: both are consequences of where `\b` refuses to
 *    anchor. Restricting the boundary to alphanumeric characters keeps the
 *    collision-safety (hex characters are still a subset of alphanumeric, so
 *    there is still no internal boundary inside a pure hex run) while
 *    treating `_` as a real delimiter, so an underscore-delimited secret is
 *    found wherever it sits.
 *
 * Every replacement is a fixed marker - `<redacted>`, `<user>`, `<lan-ip>` -
 * never a partial mask. A mask that keeps a few characters of a 32-hex token
 * visible has not redacted it, it has published most of it.
 */
export function redactLog(text: string): string {
  let out = text;

  // 1. token=/key=/secret=/auth=/password=/sig=/signature= query parameters,
  // redacted whole regardless of shape. [\w-]* lets the name carry a prefix
  // (access_token, apiKey, publisherToken); the value alternation also
  // matches an already-placed marker so re-running this rule on an
  // already-redacted line is a no-op instead of prepending a second marker.
  out = out.replace(
    /([?&])([\w-]*(?:token|key|secret|auth|password|sig|signature))=(?:<redacted>|[^&\s"'<>]+)/gi,
    "$1$2=<redacted>",
  );

  // 2. /watch/<token> paths - the hosted relay's viewer link IS the secret
  // (see maskViewerLink above); mirrors that function's own rule.
  out = out.replace(/(\/watch\/)[^/?#\s"'<>]+/g, "$1<redacted>");

  // 3. Basic-auth credentials embedded in a URL: scheme://user:pass@host.
  // The authority-scoped value class ([^/\s]*, bounded by the next "/" or
  // whitespace) is greedy, so it backtracks to the LAST "@" in the
  // authority, matching how a URL parser finds the userinfo/host boundary -
  // not the first. The old rule's [^/\s:@]+ / [^/\s@]+ pair couldn't cross
  // an "@", so a password containing one (https://u:p@ss@example.com/x)
  // took the FIRST "@" and left a fragment ("ss") glued onto the host: a
  // partial mask, which is exactly what the invariant below forbids.
  out = out.replace(/\/\/[^/\s]*@/g, "//<redacted>@");

  // 4. Windows account name in a path, e.g.
  // C:\Users\omert\AppData\Local\... -> C:\Users\<user>\AppData\Local\...
  // Runs before the hex/key rules below - see the ordering note above.
  // Both separators because a file:// URL (Node/Electron emit these in some
  // stack traces) renders the same path with forward slashes, and because a
  // macOS-style /Users/<name>/... path (no drive letter) uses the forward
  // slash exclusively. Two alternative contexts, with two different case
  // rules:
  //  - a drive letter, a UNC prefix, or a bare backslash immediately before
  //    Users/users, matched case-insensitively on "Users" itself, so a
  //    lowercase c:\users\<name> is caught too;
  //  - OR a bare "/" or "\" immediately before *capitalized* "Users" only,
  //    with no drive-letter/UNC/backslash context required, so a
  //    forward-slash path (/Users/<name>/Library/...) is caught too without
  //    also matching an unrelated lowercase REST path segment like
  //    /users/<id> (e.g. a GitHub API URL) - that path has neither a drive
  //    letter nor a backslash before its "users" segment, and its "users"
  //    is lowercase, so it fails both alternatives.
  // Every context-qualified account name is collected first, from the
  // ORIGINAL text, without mutating `out` - not just the first one, so a
  // second, different name elsewhere on the same line is also redacted. All
  // collected names are then redacted in a SINGLE combined-alternation
  // pass, not one `.replace()` call per name. A per-name loop runs each
  // replace against the output of the previous one, so once any earlier
  // name's replacement has written a "<user>" marker, a later name that
  // happens to be literally "user" would match the "user" text inside that
  // marker ("<" and ">" are non-word characters, so \b anchors right next
  // to them) and produce "<<user>>" - the same failure as writing the
  // marker and then re-scanning for it, just reached through a second
  // account name instead of the same one. Matching every name in one pass
  // finds all of them against the original text at once, before any marker
  // exists to collide with.
  const windowsUserRe =
    /(?:(?:[A-Za-z]:[\\/]|\\\\[^\\/\r\n]+[\\/]|\\)[Uu]sers[\\/]|[\\/]Users[\\/])([^\\/\r\n]+)/g;
  const windowsUsers = new Set<string>();
  for (const m of out.matchAll(windowsUserRe)) {
    windowsUsers.add(m[1]);
  }
  if (windowsUsers.size > 0) {
    // Longest first. JS alternation takes the FIRST branch that succeeds, not
    // the longest, so with "bob" ahead of "bob-smith" the pattern matches "bob"
    // inside "bob-smith" - the trailing \b succeeds because "-" is non-word -
    // and never backtracks to the longer branch, publishing "-smith" in the
    // clear. A directory listing hands back names alphabetically, so the bad
    // order is the ordinary one, and "jane-smith" is an ordinary account name.
    const alternation = [...windowsUsers]
      .sort((a, b) => b.length - a.length)
      .map((user) => user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    // Fix-round-3 Finding 2. `\b` only anchors at a transition between a
    // word character ([A-Za-z0-9_]) and a non-word one. An account name
    // whose first or last character falls outside that class - an accented
    // letter, a CJK name, a trailing "." - means that transition never
    // happens on that side, so the whole alternation fails to match and the
    // name survives everywhere on the line, not just at the boundary. A
    // lookaround-based boundary doesn't need a transition, only the absence
    // of a letter/digit/underscore on the outside, so it anchors correctly
    // regardless of what the matched name itself starts or ends with - the
    // same reasoning already used for the hex rules below (see point 5
    // above), extended from ASCII alphanumerics to `\p{L}`/`\p{N}` so it
    // covers a name in any script, not just ASCII.
    out = out.replace(
      new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternation})(?![\\p{L}\\p{N}_])`, "gu"),
      "<user>",
    );
  }

  // 5a. RFC1918 private addresses: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16.
  out = out.replace(
    /\b(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})\b/g,
    "<lan-ip>",
  );

  // 5b. Gemini-shaped API key: "AIza" + 35 or more [A-Za-z0-9_-] characters
  // (Google's documented format is 39 total, but nothing in this codebase
  // validates a pasted Gemini key's length - `validateKey` in
  // apps/standalone/src/main.ts round-trips it to Google instead of checking
  // its shape). No trailing `\b` and no upper bound: the base64url alphabet
  // AIza keys are drawn from includes "-", so roughly 1 in 64 real keys end
  // in one, and a trailing `\b` right after a non-word character that is
  // itself followed by another non-word character can never anchor - the
  // whole key used to sail through verbatim, not just a fragment of it. An
  // upper bound has the identical failure mode for any key even one
  // character longer than the cap. 35 consecutive [\w-] after the literal
  // "AIza" is already the signal, and an unbounded greedy match can't run
  // away past the next real delimiter (whitespace, quote, line end).
  out = out.replace(/AIza[\w-]{35,}/g, "<redacted>");

  // 5c. Deepgram-shaped API key: 40 hex characters. Bounded by an
  // alphanumeric lookaround, not `\b` - see the ordering note above for why.
  out = out.replace(/(?<![0-9A-Za-z])[0-9a-f]{40}(?![0-9A-Za-z])/gi, "<redacted>");

  // 5d. Relay token: 32 hex characters (generateToken() in
  // packages/relay/src/config.ts is 16 random bytes, hex-encoded - also the
  // secret half of a hosted-relay p1_/v1_ token, apps/hosted-relay/src/tokens.ts).
  out = out.replace(/(?<![0-9A-Za-z])[0-9a-f]{32}(?![0-9A-Za-z])/gi, "<redacted>");

  return out;
}
