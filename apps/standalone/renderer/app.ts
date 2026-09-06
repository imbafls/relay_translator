/**
 * Relay desktop console renderer - "caption console" (DESIGN.md, turns 3 + 4).
 *
 * Layout: top bar · stage (or keys / log / onboarding view) · signal-chain strip · footer.
 * All state lives here; the main process owns config, the local relay and the uplink.
 */
import { BrowserAudioCapture, RelayPublisherClient, rmsLevel } from "@callout-relay/companion";
import {
  AppConfig,
  AudioDeviceInfo,
  ControlStatus,
  HardwareInfo,
  KeyValidation,
  LANGUAGES,
  LocalModelStatus,
  MODEL_TIERS,
  ModelTier,
  OutputTarget,
  SessionState,
  FALLBACK_STT,
  STT_MODELS,
  SttModelInfo,
  TRANSLATION_MODELS,
  UpdateStatus,
  isLocalStt,
  sttModel,
  changesSince,
  clampChannels,
  resolveSourceIds,
  safeSpeakerColor,
  SPEAKER_COLORS,
  speakerTags,
  MAX_CAPTURE_CHANNELS,
} from "@callout-relay/shared";
import type { ChangelogEntry } from "@callout-relay/shared";
import type { RendererBridge } from "../src/preload";

declare global {
  interface Window {
    cr: RendererBridge;
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const inp = (id: string): HTMLInputElement => $(id);
const sel = (id: string): HTMLSelectElement => $(id);

const cr = window.cr;
const capture = new BrowserAudioCapture();

type View = "stage" | "settings" | "log" | "onboarding";

let config: AppConfig;
let status: ControlStatus | null = null;
let relayClient: RelayPublisherClient | null = null;
let session: SessionState = "idle";
let sessionError: string | undefined;
let sessionStart: number | undefined;
let view: View = "stage";
let syncing = false;
/** which link the footer shows when output = both */
let linkChoice: "phone" | "obs" = "phone";
/**
 * Validation verdicts, keyed by the string they were earned for.
 *
 * Caching by provider alone silently discarded a pasted key: reopening setup
 * refilled the field from the SAVED config, found a verdict left behind by the
 * string the user had just typed over, showed the old key as VALID, and wrote
 * it back on CONTINUE. `verdictFor` makes a verdict for a different string
 * count as no verdict at all, which is what re-runs the check.
 */
const keyCheck: {
  deepgram?: { key: string; result: KeyValidation | "checking" };
  gemini?: { key: string; result: KeyValidation | "checking" };
} = {};

function verdictFor(
  provider: "deepgram" | "gemini",
  key: string | undefined,
): KeyValidation | "checking" | undefined {
  const cached = keyCheck[provider];
  return cached && key && cached.key === key ? cached.result : undefined;
}
let update: UpdateStatus | null = null;
/** local STT models on disk / downloading (from the main process) */
let localModels: LocalModelStatus[] = [];
/** CPU / RAM of this PC, for the tier recommendation (from the main process) */
let hardware: HardwareInfo | undefined;
/** the cloud model to return to when local turns out too slow */
let lastCloudStt: string = FALLBACK_STT;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const STT_SHORT: Record<string, string> = {
  "deepgram-nova-3": "Nova-3",
  "deepgram-nova-3-multi": "Nova-3 Multi",
  "deepgram-nova-2": "Nova-2",
  "local-zipformer-en-20m": "Zipformer 20M",
  "local-parakeet-tdt-0.6b-v3": "Parakeet 0.6B",
  "local-sense-voice": "SenseVoice",
  "local-moonshine-tiny": "Moonshine Tiny",
  "local-moonshine-base": "Moonshine Base",
  "local-whisper-tiny-en": "Whisper Tiny EN",
  "local-whisper-turbo": "Whisper Turbo",
  "local-zipformer-en": "Zipformer EN",
  "local-parakeet-tdt-0.6b-v2": "Parakeet 0.6B v2",
  "local-nemotron-streaming": "Nemotron 0.6B",
};
const STT_TAG: Record<string, string> = {
  "deepgram-nova-3": "FASTEST",
  "deepgram-nova-3-multi": "MULTILINGUAL",
  "deepgram-nova-2": "WIDE LANGUAGE",
  "local-zipformer-en-20m": "STREAMING · EN",
  "local-parakeet-tdt-0.6b-v3": "BEST · EN +24",
  "local-sense-voice": "ZH EN JA KO",
  "local-moonshine-tiny": "FAST · EN",
  "local-moonshine-base": "ACCURATE · EN",
  "local-whisper-tiny-en": "SMALLEST · EN",
  "local-whisper-turbo": "100 LANGS · SLOW",
  "local-zipformer-en": "STREAMING · EN",
  "local-parakeet-tdt-0.6b-v2": "BEST · EN",
  "local-nemotron-streaming": "STREAMING · EN +24",
};
const TR_SHORT: Record<string, string> = {
  "gemini-3.1-flash-lite": "Flash-Lite",
  "gemini-flash-latest": "Flash",
  "gemini-2.5-flash": "2.5 Flash",
};

function sttShort(id: string): string {
  return STT_SHORT[id] || id.replace(/^(deepgram|local)-/, "");
}
function sttFull(id: string): string {
  return isLocalStt(id) ? `Local ${sttShort(id)}` : `Deepgram ${sttShort(id)}`;
}
function modelState(id: string): LocalModelStatus | undefined {
  return localModels.find((m) => m.id === id);
}
function modelReady(id: string): boolean {
  return !!modelState(id)?.downloaded;
}
/** speech provider the console is set to */
function sttIsLocal(): boolean {
  return isLocalStt(config.stt);
}
function trShort(id: string): string {
  return TR_SHORT[id] || id.replace(/^gemini-/, "");
}
function trFull(id: string): string {
  const short = trShort(id);
  return id === "gemini-3.1-flash-lite" ? "Gemini 3.1 Flash-Lite" : `Gemini ${short}`;
}
function langName(code: string): string {
  const l = LANGUAGES.find((x) => x.code === code);
  return l ? l.label.split(" (")[0] : code.toUpperCase();
}
function outputLabel(o: OutputTarget): string {
  return o === "obs" ? "OBS" : o === "both" ? "Phone + OBS" : "Phone";
}
function translationActive(): boolean {
  return config.translationEnabled !== false && !!config.geminiApiKey;
}
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}
function fmtTs(d: Date): string {
  return `${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function fmtSec(ms: number | undefined): string {
  return ms == null ? "" : `${(ms / 1000).toFixed(1)}s`;
}
function stripUrl(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "");
}
function usd(n: number, digits = 3): string {
  return `$${n.toFixed(digits)}`;
}
function sourceLabel(id: string): string {
  const opt = sel("audioSource").querySelector<HTMLOptionElement>(`option[value="${CSS.escape(id)}"]`);
  return opt?.textContent || (id === "system-loopback" ? "System audio" : "Default microphone");
}
/** devices from the last scan (kept here so labels never wait on the status round-trip) */
let deviceList: AudioDeviceInfo[] = [];
function sourceKind(id: string): "mic" | "system" {
  return deviceList.find((d) => d.id === id)?.kind || status?.devices.find((d) => d.id === id)?.kind || (id === "system-loopback" ? "system" : "mic");
}
/** the sources a session captures, in slot order (deduplicated, capped) */
function activeSources(): string[] {
  return resolveSourceIds(config);
}
/** the three pickers, whatever is in them right now */
const SOURCE_SLOTS = ["audioSource", "audioSource2", "audioSource3"] as const;
function pickedSources(): string[] {
  return SOURCE_SLOTS.map((id) => sel(id).value).filter(Boolean);
}
/**
 * Speaker tag per channel. The role follows the slot, not the device kind: a
 * chat mix off a virtual audio device (Elgato Wave Link, VoiceMeeter, VB-Cable)
 * enumerates as a microphone exactly like a headset does, so the kind cannot
 * tell "me" from "the others". System audio is the exception - it is always
 * the other voices, whichever slot it sits in.
 */
function channelLabels(sources: string[]): string[] {
  return speakerTags(sources.map(sourceKind), config?.sourceLabels);
}
/** the tag colour per slot: what the user picked, else this slot's default */
function channelColors(sources: string[]): string[] {
  return sources.map((_, i) => safeSpeakerColor(config?.sourceColors?.[i]) || SPEAKER_COLORS[i] || SPEAKER_COLORS[0]);
}

/**
 * Paint a speaker tag.
 *
 * This used to be one binary class - "YOU" against everyone else - which was
 * enough while there were two sources and wrong the moment there were three:
 * CHAT and COACH came out the same colour, so the tag named them and the
 * colour did not tell them apart. The colour now rides on the caption, chosen
 * per slot by the streamer, and the class stays as the fallback for a relay
 * that does not send one.
 */
function paintSpeaker(el: HTMLElement, seg: { speaker?: string; color?: string }): void {
  const colour = safeSpeakerColor(seg.color);
  el.style.color = colour || "";
  el.classList.toggle("other", !colour && !!seg.speaker && seg.speaker !== "YOU" && seg.speaker !== "CH1");
}

/** the 01 SOURCE meta: the roles once there are two, the device kind when there is one */
function sourceKindLabel(sources: string[]): string {
  if (sources.length > 1) return channelLabels(sources).join(" + ");
  return sourceKind(sources[0] || "") === "system" ? "SYSTEM" : "MIC";
}
function sourcesSummary(): string {
  const src = activeSources();
  return src.map(sourceLabel).join(" + ");
}
function debounce<T extends (...a: never[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | null = null;
  return ((...args: Parameters<T>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}

// ---------------------------------------------------------------------------
// log (LOG view)
// ---------------------------------------------------------------------------

let logLines = 0;
function log(message: string, cls: "" | "err" | "ok" = ""): void {
  const el = document.createElement("div");
  if (cls) el.className = cls;
  el.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  appendLog(el);
}
function logSubtitle(seg: { source: string; target?: string; speaker?: string; latency?: { stt?: number; translate?: number } }): void {
  const t = new Date().toLocaleTimeString();
  const en = document.createElement("div");
  en.className = "sub-en";
  en.textContent = `[${t}] ▸ ${seg.speaker ? `${seg.speaker}: ` : ""}${seg.source}${seg.latency?.stt != null ? `  [stt ${seg.latency.stt}ms]` : ""}`;
  appendLog(en);
  if (seg.target != null) {
    const vi = document.createElement("div");
    vi.className = "sub-vi";
    vi.textContent = `    ${seg.target}${seg.latency?.translate != null ? `  [+${seg.latency.translate}ms]` : ""}`;
    appendLog(vi);
  }
}
function appendLog(el: HTMLElement): void {
  const box = $("log");
  box.appendChild(el);
  logLines += 1;
  while (box.children.length > 400) box.firstChild?.remove();
  box.scrollTop = box.scrollHeight;
  $("logCount").textContent = `${box.children.length} LINES`;
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

function setView(next: View): void {
  view = next;
  $("app").dataset.view = next;
  $("stage").hidden = next !== "stage";
  $("settings").hidden = next !== "settings";
  $("logView").hidden = next !== "log";
  $("onboarding").hidden = next !== "onboarding";
  $("footer").hidden = next === "onboarding";
  $("clock").hidden = next === "onboarding";
  $("stepper").hidden = next !== "onboarding";
  $("settingsBtn").classList.toggle("active", next === "settings");
  $("logBtn").classList.toggle("active", next === "log");
  if (next === "settings") renderSettings();
  if (next === "onboarding") renderOnboarding();
  else renderChain();
  renderTopbar();
}

// ---------------------------------------------------------------------------
// top bar
// ---------------------------------------------------------------------------

function renderTopbar(): void {
  const st = $("status");
  const text = $("statusText");
  if (view === "onboarding") {
    st.dataset.state = "standby";
    text.textContent = "SETUP";
    return;
  }
  const map: Record<SessionState, [string, string]> = {
    idle: ["standby", "STANDBY"],
    starting: ["starting", "STARTING"],
    live: ["onair", "ON AIR"],
    stopping: ["standby", "STOPPING"],
    error: ["error", "ERROR"],
  };
  const [state, label] = map[session];
  st.dataset.state = state;
  text.textContent = label;
}

function tickClock(): void {
  $("clock").textContent = fmtClock(session === "live" && sessionStart ? Date.now() - sessionStart : 0);
}

// ---------------------------------------------------------------------------
// stage (transcript)
// ---------------------------------------------------------------------------

interface Row {
  id: number;
  el: HTMLElement;
  srcText: HTMLElement;
  tgtText: HTMLElement;
  ts: HTMLElement;
  who: HTMLElement;
  latSrc: HTMLElement;
  latTgt: HTMLElement;
  final: boolean;
}
const rows = new Map<number, Row>();
/** one open interim line per capture channel */
const interims = new Map<number, Row>();
const MAX_ROWS = 12;
const recentStt: number[] = [];
const recentTr: number[] = [];

function makeRow(id: number, isInterim: boolean): Row {
  const el = document.createElement("div");
  el.className = "row" + (isInterim ? " interim" : "");
  el.innerHTML =
    '<div class="src"><span class="ts"></span><span class="body"><span class="who"></span><span class="text"></span></span><span class="lat"></span></div>' +
    '<div class="tgt"><span class="text pending">…</span><span class="lat"></span></div>';
  const row: Row = {
    id,
    el,
    srcText: el.querySelector(".src .text") as HTMLElement,
    tgtText: el.querySelector(".tgt .text") as HTMLElement,
    ts: el.querySelector(".ts") as HTMLElement,
    who: el.querySelector(".who") as HTMLElement,
    latSrc: el.querySelector(".src .lat") as HTMLElement,
    latTgt: el.querySelector(".tgt .lat") as HTMLElement,
    final: false,
  };
  row.ts.textContent = fmtTs(new Date());
  $("lines").appendChild(el);
  return row;
}

function trimRows(): void {
  const lines = $("lines");
  // open interim rows (one per channel) never count against the history budget
  while (lines.querySelectorAll(".row:not(.interim)").length > MAX_ROWS) {
    const first = lines.querySelector(".row:not(.interim)") as HTMLElement;
    first.remove();
    for (const [id, r] of rows) if (r.el === first) rows.delete(id);
  }
}

/** the newest final line is the last one on stage - ids are reserved per channel, so DOM order beats id order */
function markLatest(): void {
  let latest: Row | null = null;
  const els = $("lines").children;
  for (let i = els.length - 1; i >= 0 && !latest; i--) {
    for (const r of rows.values()) if (r.final && r.el === els[i]) latest = r;
  }
  for (const r of rows.values()) r.el.classList.toggle("latest", r === latest);
}

function clearStage(): void {
  $("lines").innerHTML = "";
  rows.clear();
  interims.clear();
  recentStt.length = 0;
  recentTr.length = 0;
  renderAverages();
  renderIdle();
}

type Seg = { id: number; source: string; target?: string; channel?: number; speaker?: string; color?: string; latency?: { stt?: number; translate?: number } };

function onPartial(seg: { id: number; source: string; channel?: number; speaker?: string; color?: string }): void {
  if (!seg.source.trim() || rows.has(seg.id)) return;
  const ch = seg.channel ?? 0;
  let interim = interims.get(ch);
  if (!interim) {
    interim = makeRow(seg.id, true);
    interims.set(ch, interim);
  }
  interim.id = seg.id;
  interim.who.textContent = seg.speaker || "";
  paintSpeaker(interim.who, seg);
  interim.srcText.textContent = seg.source;
  const cur = document.createElement("span");
  cur.className = "cursor";
  interim.srcText.appendChild(cur);
  interim.tgtText.textContent = "…";
  trimRows();
  renderIdle();
}

function onSubtitle(seg: Seg): void {
  let row = rows.get(seg.id);
  if (!row) {
    const ch = seg.channel ?? 0;
    const interim = interims.get(ch);
    if (interim) {
      // the interim row becomes this final segment
      row = interim;
      interims.delete(ch);
      row.el.classList.remove("interim");
      row.id = seg.id;
    } else {
      row = makeRow(seg.id, false);
    }
    rows.set(seg.id, row);
  }
  row.final = true;
  row.who.textContent = seg.speaker || "";
  paintSpeaker(row.who, seg);
  row.srcText.textContent = seg.source;
  if (seg.target != null) {
    row.tgtText.textContent = seg.target;
    row.tgtText.classList.remove("pending");
  }
  if (seg.latency?.stt != null) {
    row.latSrc.textContent = fmtSec(seg.latency.stt);
    if (seg.target == null) pushAvg(recentStt, seg.latency.stt);
  }
  if (seg.latency?.translate != null) {
    row.latTgt.textContent = fmtSec(seg.latency.translate);
    pushAvg(recentTr, seg.latency.translate);
  }
  markLatest();
  trimRows();
  renderAverages();
  renderIdle();
}

function pushAvg(arr: number[], v: number): void {
  arr.push(v);
  if (arr.length > 12) arr.shift();
}
function avg(arr: number[]): number | undefined {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : undefined;
}
function renderAverages(): void {
  const a = avg(recentStt);
  const b = avg(recentTr);
  $("srcAvg").textContent = a != null && !translationActive() ? `avg ${fmtSec(a)}` : "";
  $("tgtAvg").textContent = b != null ? `avg ${fmtSec(b)}` : "";
}

function renderStageHeads(): void {
  const single = !translationActive();
  $("stage").classList.toggle("single", single);
  $("srcHead").textContent = `${langName(config.languages.source).toUpperCase()} · ${single ? "CAPTIONS" : "SOURCE"}`;
  $("tgtHead").textContent = `${langName(config.languages.target).toUpperCase()} · TRANSLATION`;
}

function renderIdle(): void {
  const empty = $("lines").children.length === 0;
  const idle = $("idle");
  idle.hidden = !empty && session !== "error";
  const chain = `${sourcesSummary()} → ${sttShort(config.stt)} → ${
    translationActive() ? `${trShort(config.translation)} → ` : ""
  }${outputLabel(config.output).toLowerCase()}${translationActive() ? "" : ` · ${langName(config.languages.source)} only`}`;
  $("idleChain").textContent = chain;
  $("idleTitle").textContent = session === "error" ? "Could not start" : "Nothing on air";
  const err = $("idleError");
  err.hidden = !sessionError;
  err.textContent = sessionError || "";
  $("idleChain").hidden = !!sessionError;
}

// ---------------------------------------------------------------------------
// level meter (01 SOURCE while live)
// ---------------------------------------------------------------------------

let level = 0;
function feedLevel(chunk: Int16Array): void {
  // rmsLevel reads every lane of the interleave; the stride this used to walk
  // with saw only channel 0 once there were three sources
  level = Math.max(level * 0.85, rmsLevel(chunk));
}
function renderMeter(): void {
  const bars = $("meter").children;
  const db = level > 0 ? 20 * Math.log10(level) : -100;
  const lit = Math.round(Math.min(1, Math.max(0, (db + 50) / 50)) * bars.length);
  for (let i = 0; i < bars.length; i++) bars[i].classList.toggle("on", i < lit);
}

// ---------------------------------------------------------------------------
// session control
// ---------------------------------------------------------------------------

function setState(next: SessionState, error?: string): void {
  session = next;
  sessionError = error;
  $("app").dataset.session = next;
  cr.reportState(next, error);
  if (next === "live" && !sessionStart) sessionStart = Date.now();
  if (next === "idle" || next === "error") sessionStart = undefined;
  $("startText").textContent = next === "live" || next === "starting" ? "STOP" : "START SESSION";
  renderTopbar();
  renderChain();
  renderFooter();
  renderIdle();
  renderCaptionSettings();
  tickClock();
}

async function startSession(opts: { rotateLink: boolean }): Promise<void> {
  if (session === "live" || session === "starting") return;
  setState("starting");
  try {
    if (relayClient) {
      try {
        relayClient.disconnect();
      } catch {
        /* noop */
      }
      relayClient = null;
    }
    const prep = await cr.prepareSession({ rotate: opts.rotateLink });
    config = prep.config;
    if (sttIsLocal()) {
      if (!modelReady(config.stt)) throw new Error(`Download ${sttFull(config.stt)} first (02 TRANSCRIBE → DOWNLOAD).`);
    } else if (!config.deepgramApiKey) {
      throw new Error("Add a Deepgram key first (KEYS), or pick a local model under 02 TRANSCRIBE.");
    }
    clearStage();
    renderStageHeads();

    // the channel count follows the (deduplicated) source list, so the relay
    // can be told before capture opens and no early audio is dropped
    const sources = activeSources();
    // clampChannels, not a literal: this read `sources.length === 2 ? 2 : 1`,
    // so three sources announced ONE channel while capture opened three. The
    // interleave would then have been re-cut on the wrong stride, which decodes
    // to fluent speech from the wrong people. The mismatch check below is what
    // turned that into a refusal to start instead.
    const channels = clampChannels(sources.length);

    relayClient = new RelayPublisherClient(prep.publisherUrl, {
      onState: (clientState, detail) => {
        log(`relay: ${clientState}${detail ? ` - ${detail}` : ""}`, clientState === "connected" ? "ok" : "");
        recomputeState();
      },
      onError: (msg) => log(`relay error: ${msg}`, "err"),
      onSubtitle: (seg) => {
        logSubtitle(seg);
        onSubtitle(seg);
      },
      onPartial: (seg) => onPartial(seg),
    });
    relayClient.connect({
      stt: config.stt,
      translation: config.translation,
      languages: config.languages,
      translationEnabled: translationActive(),
      latencyVisible: config.showLatency !== false,
      profanityFilter: config.profanityFilter !== false,
      channels,
      channelLabels: channels > 1 ? channelLabels(sources) : undefined,
      channelColors: channels > 1 ? channelColors(sources) : undefined,
    });

    level = 0;
    await capture.start(sources, (chunk) => {
      feedLevel(chunk);
      relayClient?.sendAudio(chunk.buffer);
    });
    if (capture.channels !== channels) throw new Error("capture channel count does not match the session");
    log(`capture started: ${sources.map(sourceLabel).join(" + ")}${channels > 1 ? ` (${channels} channels)` : ""}`, "ok");
    recomputeState();
  } catch (err) {
    const message = String((err as Error).message || err);
    log(`start failed: ${message}`, "err");
    stopSession(true);
    setState("error", message);
  }
}

function stopSession(silent = false): void {
  if (session === "idle") return;
  capture.stop();
  relayClient?.disconnect();
  relayClient = null;
  for (const r of interims.values()) r.el.remove();
  interims.clear();
  setState("idle");
  if (!silent) log("session stopped");
}

function recomputeState(): void {
  const relayUp = relayClient?.state === "connected";
  if (relayUp && capture.capturing) setState("live");
  else if (session === "starting") setState("starting");
}

/** settings changes bounce the session without rotating the link */
async function restartIfLive(): Promise<void> {
  if (session === "idle" || session === "error") return;
  log("applying settings - restarting session…");
  stopSession(true);
  await startSession({ rotateLink: false });
}

// ---------------------------------------------------------------------------
// config plumbing
// ---------------------------------------------------------------------------

function fillSelect(box: HTMLSelectElement, entries: { value: string; label: string }[], value: string): void {
  box.innerHTML = "";
  for (const { value: v, label } of entries) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = label;
    if (v === value) opt.selected = true;
    box.appendChild(opt);
  }
}

async function refreshDevices(): Promise<void> {
  const devices = await capture.listDevices();
  deviceList = devices;
  const entries = devices.map((d) => ({ value: d.id, label: d.label }));
  const second = [{ value: "", label: "No second source" }, ...entries];
  fillSelect(sel("audioSource"), entries, resolveSourceIds(config)[0] || "");
  fillSelect(sel("obAudioSource"), entries, config.audioSource);
  const slots = activeSources();
  fillSelect(sel("audioSource2"), second, slots[1] || "");
  fillSelect(sel("audioSource3"), second, slots[2] || "");
  fillSelect(sel("obAudioSource2"), second, slots[1] || "");
  cr.reportDevices(devices);
  renderChain();
  renderIdle();
}

/** 02 TRANSCRIBE: cloud and local models in two groups */
function fillSttSelect(box: HTMLSelectElement, value: string): void {
  box.innerHTML = "";
  const groups: [string, SttModelInfo[]][] = [
    ["CLOUD · DEEPGRAM", STT_MODELS.filter((m) => m.provider === "deepgram")],
    ["LOCAL · THIS PC", STT_MODELS.filter((m) => m.provider === "local")],
  ];
  for (const [label, models] of groups) {
    const g = document.createElement("optgroup");
    g.label = label;
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = sttFull(m.id);
      if (m.id === value) opt.selected = true;
      g.appendChild(opt);
    }
    box.appendChild(g);
  }
}

function syncControlsFromConfig(): void {
  syncing = true;
  const langs = LANGUAGES.map((l) => ({ value: l.code, label: langName(l.code) }));
  fillSttSelect(sel("stt"), config.stt);
  const picked = activeSources();
  sel("audioSource").value = picked[0] || "";
  sel("audioSource2").value = picked[1] || "";
  sel("audioSource3").value = picked[2] || "";
  sel("audioSource2").classList.toggle("set", !!picked[1]);
  sel("audioSource3").classList.toggle("set", !!picked[2]);
  fillSelect(sel("translation"), TRANSLATION_MODELS.map((m) => ({ value: m.id, label: trFull(m.id).toUpperCase() })), config.translation);
  fillSelect(sel("langSource"), langs, config.languages.source);
  fillSelect(sel("langTarget"), langs, config.languages.target);
  refitSelects();
  setSeg("outputSeg", config.output || "phone");
  setSeg("obOutputSeg", config.output || "phone");
  setSeg("linkModeSeg", config.linkMode);
  $("badgesToggle").classList.toggle("on", config.showLatency !== false);
  $("filterToggle").classList.toggle("on", config.profanityFilter !== false);
  syncing = false;
  renderStageHeads();
  renderChain();
  renderFooter();
  renderIdle();
}

/** size a text-styled <select> to its selected option (Chrome pads selects for the arrow) */
let measureEl: HTMLSpanElement | null = null;
function fitSelect(box: HTMLSelectElement): void {
  if (!measureEl) {
    measureEl = document.createElement("span");
    measureEl.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;top:-1000px";
    document.body.appendChild(measureEl);
  }
  const cs = getComputedStyle(box);
  measureEl.style.font = cs.font;
  measureEl.style.letterSpacing = cs.letterSpacing;
  measureEl.style.textTransform = cs.textTransform;
  measureEl.textContent = box.selectedOptions[0]?.textContent || "";
  box.style.width = `${Math.ceil(measureEl.getBoundingClientRect().width) + parseFloat(cs.paddingRight || "0") + 2}px`;
}

/**
 * Widths measured before Archivo loads are too narrow and the value ends up
 * ellipsised, so re-measure once the webfont is actually in.
 */
let fontsPending = true;
function refitSelects(): void {
  for (const id of ["translation", "langSource", "langTarget"]) fitSelect(sel(id));
  if (fontsPending && document.fonts?.status !== "loaded") {
    fontsPending = false;
    void document.fonts.ready.then(() => {
      for (const id of ["translation", "langSource", "langTarget"]) fitSelect(sel(id));
    });
  }
}

function setSeg(id: string, value: string): void {
  for (const b of $(id).querySelectorAll<HTMLButtonElement>("button")) {
    b.classList.toggle("active", b.dataset.value === value);
  }
}

async function saveAndApply(patch: Partial<AppConfig>, opts: { restart?: boolean } = {}): Promise<void> {
  try {
    config = await cr.setConfig(patch);
    syncControlsFromConfig();
    if (opts.restart) await restartIfLive();
  } catch (err) {
    log(`config save failed: ${String(err)}`, "err");
  }
}

// ---------------------------------------------------------------------------
// key validation
// ---------------------------------------------------------------------------

async function checkKey(provider: "deepgram" | "gemini", key: string): Promise<KeyValidation> {
  if (!key) {
    delete keyCheck[provider];
    return { valid: false, detail: "empty" };
  }
  keyCheck[provider] = { key, result: "checking" };
  renderChain();
  const res = await cr.validateKey(provider, key);
  // the field can have moved on while this was in flight; the onboarding
  // checks already guard for that, and this one has to as well or a slow
  // verdict lands on top of a newer key
  if (keyCheck[provider]?.key !== key) return res;
  keyCheck[provider] = { key, result: res };
  renderChain();
  if (view === "settings") renderKeyStatuses();
  return res;
}

function keyStateLabel(provider: "deepgram" | "gemini"): { text: string; cls: string } {
  const saved = provider === "deepgram" ? config.deepgramApiKey : config.geminiApiKey;
  const present = !!saved;
  const chk = verdictFor(provider, saved);
  if (!present) return { text: "KEY NEEDED", cls: "warn" };
  if (chk === "checking") return { text: "CHECKING…", cls: "" };
  if (chk && !chk.valid) return { text: chk.detail === "no connection" || chk.detail === "timed out" ? "KEY ?" : "KEY INVALID", cls: "warn" };
  return { text: "KEY OK", cls: "" };
}

// ---------------------------------------------------------------------------
// chain strip
// ---------------------------------------------------------------------------

function metaSpans(el: HTMLElement, items: { text: string; cls?: string }[]): void {
  el.innerHTML = "";
  for (const it of items) {
    const s = document.createElement("span");
    s.textContent = it.text;
    if (it.cls) s.className = it.cls;
    el.appendChild(s);
  }
}

function renderChain(): void {
  if (!config) return;
  if (view === "onboarding") {
    renderOnboardingChain();
    return;
  }
  const live = session === "live" || session === "starting";
  const ta = translationActive();
  const usage = status?.usage;
  // onboarding hides this; the console always owns it
  $("translateToggle").hidden = false;
  $("addKey").textContent = "ADD KEY";
  const rel = status?.relay;
  const blocks = ["blkSource", "blkStt", "blkTranslate", "blkOutput"];
  for (const id of blocks) $(id).classList.remove("placeholder", "current");
  for (const s of document.querySelectorAll<HTMLSelectElement>("#chain select")) s.disabled = live;
  for (const b of $("chain").querySelectorAll<HTMLElement>(".ob-value")) b.hidden = true;
  for (const b of $("chain").querySelectorAll<HTMLElement>(".select-row, #outputSeg, #translateNeedsKey, #translatePair")) b.hidden = false;

  // 01 SOURCE
  const srcs = activeSources();
  $("sourceKind").textContent = sourceKindLabel(srcs);
  // a slot appears once the one before it holds a device: three empty "+" rows
  // on a fresh install reads as three things gone wrong, not three on offer
  $("source2Row").hidden = live ? !srcs[1] : false;
  $("source3Row").hidden = live ? !srcs[2] : !srcs[1];
  sel("audioSource2").classList.toggle("set", !!srcs[1]);
  sel("audioSource3").classList.toggle("set", !!srcs[2]);
  $("meter").hidden = !live;
  $("metaSource").hidden = live;
  $("rescan").hidden = live;

  // 02 TRANSCRIBE
  renderModelAction();
  renderCloudAction();
  if (live && usage) {
    if (sttIsLocal()) {
      metaSpans($("metaStt"), [{ text: `${(usage.local?.sttMinutes ?? 0).toFixed(1)} MIN` }, { text: "LOCAL · $0.000" }]);
    } else {
      metaSpans($("metaStt"), [{ text: `${usage.deepgram.sttMinutes.toFixed(1)} MIN` }, { text: usd(usage.deepgram.estCostUsd) }]);
    }
  } else if (sttIsLocal()) {
    const m = modelState(config.stt);
    const items: { text: string; cls?: string }[] = [{ text: STT_TAG[config.stt] || "" }, { text: "ON THIS PC" }];
    if (m?.progress != null) items.push({ text: `DOWNLOADING ${m.progress}%` });
    else if (m?.error) items.push({ text: "DOWNLOAD FAILED", cls: "warn" });
    else if (m?.downloaded) items.push({ text: "READY" });
    else items.push({ text: "NOT DOWNLOADED", cls: "warn" });
    metaSpans($("metaStt"), items);
  } else {
    const k = keyStateLabel("deepgram");
    metaSpans($("metaStt"), [
      { text: config.languages.source.toUpperCase() },
      { text: STT_TAG[config.stt] || "" },
      { text: k.text, cls: k.cls },
    ]);
  }

  // 03 TRANSLATE
  const blk = $("blkTranslate");
  const hasKey = !!config.geminiApiKey;
  const on = config.translationEnabled !== false;
  $("translateToggle").classList.toggle("on", ta);
  $("translateToggleText").textContent = ta ? "ON" : "OFF";
  blk.classList.toggle("off", !ta);
  blk.classList.toggle("hatched", !ta);
  blk.classList.toggle("struck", hasKey && !on);
  $("translatePair").hidden = !hasKey;
  $("translateNeedsKey").hidden = hasKey;
  $("addKey").hidden = hasKey;
  const model = sel("translation");
  model.parentElement!.hidden = !hasKey || (live && ta);
  const gk = $("gmKeyState");
  const extra = $("translateExtra");
  extra.className = "";
  if (!hasKey) {
    gk.textContent = "";
    extra.textContent = "FREE TIER";
    extra.className = "mute";
  } else if (!on) {
    gk.textContent = "";
    extra.textContent = usage ? `BYPASSED · ${usd(0)}` : "BYPASSED · $0.000";
    extra.className = "mute";
  } else if (live && usage) {
    gk.textContent = `${usage.gemini.count + usage.gemini.cacheHits} LINES`;
    extra.innerHTML = "";
    for (const t of [`${usage.gemini.cacheHits} CACHED`, usd(usage.gemini.estCostUsd ?? 0)]) {
      const sp = document.createElement("span");
      sp.textContent = t;
      extra.appendChild(sp);
    }
    extra.className = "meta-group";
  } else {
    const k = keyStateLabel("gemini");
    gk.textContent = k.text;
    gk.className = k.cls;
    extra.textContent = "";
  }

  // 04 OUTPUT
  const watching = (rel?.viewers ?? 0) + (rel?.remoteViewers ?? 0);
  $("outputSeg").hidden = live;
  const outLive = $("outputLive");
  outLive.hidden = !live;
  outLive.textContent = `${outputLabel(config.output)} · ${watching} watching`;
  const relaySet = !!config.relayUrl;
  const up = rel?.uplinkState;
  const items: { text: string; cls?: string }[] = [];
  if (config.output === "obs") {
    items.push({ text: live ? "LOCAL" : "LOCAL · NO RELAY NEEDED" });
  } else if (!relaySet) {
    items.push({ text: live ? "LAN ONLY" : "RELAY NOT SET · LAN ONLY", cls: "warn" });
  } else if (up === "connected") {
    items.push({ text: live ? "UPLINK OK" : "RELAY OK" });
    if (rel?.uplinkRttMs != null) items.push({ text: `${rel.uplinkRttMs} MS` });
  } else if (up === "connecting" || up === "disconnected") {
    items.push({ text: "RELAY CONNECTING…" });
  } else {
    items.push({ text: "RELAY ERROR · CHECK KEYS", cls: "warn" });
  }
  metaSpans($("metaOutput"), items);
}

// ---------------------------------------------------------------------------
// footer
// ---------------------------------------------------------------------------

function currentLink(): string | undefined {
  const r = status?.relay;
  if (!r) return undefined;
  // linkChoice is authoritative. It used to be consulted only when output was
  // "both", so on the default output ("phone") there was no way to reach the
  // OBS overlay URL at all - the switcher below was hidden too. A user put the
  // phone link into a browser source and got an opaque page instead of a
  // transparent overlay, which is audit finding 20 seen from the other end.
  const which = linkChoice;
  if (which === "obs") return r.localViewerUrl;
  return r.remoteViewerUrl || r.localViewerUrl?.replace(/\?obs=1$/, "");
}

function renderFooter(): void {
  if (!config) return;
  const live = session === "live" || session === "starting";
  const url = currentLink();
  const showLink = !!url && (live || config.linkMode === "fixed");
  const linkEl = $("linkUrl");
  linkEl.textContent = showLink ? stripUrl(url!) : "— appears on start";
  linkEl.classList.toggle("live", showLink);
  linkEl.title = showLink ? url! : "";
  // always reachable: both destinations exist whatever `output` says, and
  // hiding one is what sent a user to OBS with the wrong URL
  $("linkSeg").hidden = false;
  setSeg("linkSeg", linkChoice);
  for (const id of ["copyLink", "openLink"]) ($(id) as HTMLButtonElement).disabled = !showLink;
  ($("rotateLink") as HTMLButtonElement).disabled = !status;
  $("copyLink").classList.toggle("primary", showLink);

  const u = status?.usage;
  $("roStt").textContent = (sttIsLocal() ? u?.local?.sttMinutes ?? 0 : u?.deepgram.sttMinutes ?? 0).toFixed(1);
  $("roTrn").textContent = String((u?.gemini.count ?? 0) + (u?.gemini.cacheHits ?? 0));
  $("roEst").textContent = usd((u?.deepgram.estCostUsd ?? 0) + (u?.gemini.estCostUsd ?? 0));
  $("roSttWrap").hidden = live;
  $("roTrnWrap").hidden = live || !translationActive();
  // the caption-view button is only usable once there is a link to open
  renderCaptionSettings();
}

async function copyText(text: string, what: string): Promise<void> {
  // through the main process, not navigator.clipboard: the renderer's
  // permission handler denies everything but media, so writeText rejected
  // with NotAllowedError and every copy failed
  try {
    await cr.writeClipboard(text);
    log(`${what} copied`, "ok");
  } catch (err) {
    // the old catch swallowed the reason, which left "link copy failed" as
    // the only trace of a permission denial
    log(`${what} copy failed: ${String((err as Error)?.message || err)}`, "err");
  }
}

// ---------------------------------------------------------------------------
// keys & relay view
// ---------------------------------------------------------------------------

/**
 * The two caption toggles, and the route to the display settings that live on
 * the viewer rather than here.
 *
 * profanityFilter and showLatency travel in the publisher hello
 * (packages/companion/src/relayClient.ts), so a running session cannot pick up
 * a change to either - which is why both handlers return early while live.
 * That was survivable while they were unlabelled chips wedged into the 04
 * OUTPUT header and is not, now that they sit in a panel called SETTINGS: a
 * streamer who wants the mask on mid-match clicks it, watches nothing move,
 * and is told nothing. Disabled with the reason on screen is the honest state.
 */
function renderCaptionSettings(): void {
  const live = session === "live" || session === "starting";
  for (const id of ["filterToggle", "badgesToggle"]) {
    ($(id) as HTMLButtonElement).disabled = live;
  }
  $("captionsLock").hidden = !live;
  renderSourceNames(live);

  // ?settings=1 pins the viewer's HUD. In OBS that HUD is hover-only and a
  // browser source never hovers, so without this the display settings are
  // reachable only by hand-editing the URL - the param appears in no UI.
  const url = currentLink();
  ($("openCaptionView") as HTMLButtonElement).disabled = !url;
  $("captionViewHint").textContent = url
    ? `OPENS THE ${linkChoice === "obs" ? "OBS" : "PHONE"} VIEW`
    : "APPEARS ONCE A SESSION IS RUNNING, OR STRAIGHT AWAY ON A FIXED LINK";
}

/**
 * One row per filled slot: which device it holds, and what viewers will call
 * it. The name travels in the publisher hello like the caption toggles do, so
 * it is locked for the same reason and with the same sentence.
 */
function renderSourceNames(live: boolean): void {
  const ids = activeSources();
  const tags = channelLabels(ids);
  const colours = channelColors(ids);
  $("sourceCount").textContent = ids.length > 1 ? `${ids.length} SOURCES` : "ONE SOURCE - NOT TAGGED";
  for (let i = 0; i < MAX_CAPTURE_CHANNELS; i++) {
    const input = inp(`sourceName${i + 1}`);
    const row = input.closest(".namerow") as HTMLElement | null;
    if (row) row.hidden = !ids[i];
    $(`sourceDevice${i + 1}`).textContent = ids[i] ? sourceLabel(ids[i]) : "";
    // never overwrite what someone is in the middle of typing
    if (document.activeElement !== input) input.value = config?.sourceLabels?.[i] || "";
    input.placeholder = tags[i] || "no tag";
    input.disabled = live;

    const colour = colours[i] || SPEAKER_COLORS[i] || SPEAKER_COLORS[0];
    const picker = inp(`sourceColor${i + 1}`);
    picker.value = colour;
    picker.disabled = live;
    $(`sourceSwatch${i + 1}`).style.background = colour;
    input.style.color = ids.length > 1 ? colour : "";
  }
}

function captionSettingsUrl(): string | undefined {
  const url = currentLink();
  if (!url) return undefined;
  return url + (url.includes("?") ? "&" : "?") + "settings=1";
}

function renderSettings(): void {
  inp("deepgramApiKey").value = config.deepgramApiKey || "";
  inp("geminiApiKey").value = config.geminiApiKey || "";
  inp("relayUrl").value = config.relayUrl || "";
  inp("publisherToken").value = config.publisherToken || "";
  inp("publicBaseUrl").value = config.publicBaseUrl || "";
  inp("relayPort").value = String(config.relayPort || 8787);
  setSeg("linkModeSeg", config.linkMode);
  inp("updateFeedUrl").value = config.updateFeedUrl || "";
  renderKeyStatuses();
  renderUpdate();
  renderCaptionSettings();
  renderModelList($("settingsModels"), { picked: sttIsLocal() ? config.stt : "", pick: (id) => void saveAndApply({ stt: id }, { restart: true }) });
}

// ---------------------------------------------------------------------------
// local models (keys view, onboarding, 02 TRANSCRIBE)
// ---------------------------------------------------------------------------

function fmtMb(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}

/** the local models in one tier, catalog order preserved */
function modelsInTier(tier?: ModelTier): SttModelInfo[] {
  const local = STT_MODELS.filter((x) => x.provider === "local");
  return tier ? local.filter((m) => (m.tier || "medium") === tier) : local;
}

/**
 * Ratings and the note for the model that is picked, under the list. The pane
 * is too short to carry them on every row, and only the picked one is being
 * weighed up anyway.
 */
function renderPickedDetail(): void {
  const box = $("obModelNote");
  box.innerHTML = "";
  const m = sttModel(obModel);
  if (!m) return;
  if (m.speed || m.accuracy) {
    const rates = document.createElement("div");
    rates.className = "rates";
    if (m.speed) rates.appendChild(ratingRow("SPEED", m.speed));
    if (m.accuracy) rates.appendChild(ratingRow("ACCURACY", m.accuracy));
    box.appendChild(rates);
  }
  if (m.note) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = m.note;
    box.appendChild(note);
  }
}

/** a 1-5 rating as five bordered cells, filled ones in ink (DESIGN.md SegmentedBar) */
function ratingRow(label: string, value: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "rate";
  const l = document.createElement("span");
  l.className = "rate-label";
  l.textContent = label;
  const cells = document.createElement("span");
  cells.className = "cells";
  for (let i = 1; i <= 5; i++) {
    const c = document.createElement("i");
    if (i <= value) c.className = "on";
    cells.appendChild(c);
  }
  row.append(l, cells);
  return row;
}

/**
 * One row per local model: pick (radio), download / cancel / remove, progress.
 * Rendering is idempotent so status broadcasts can redraw it freely.
 */
function renderModelList(
  box: HTMLElement,
  opts: { picked: string; pick: (id: string) => void; tier?: ModelTier },
): void {
  box.innerHTML = "";
  for (const m of modelsInTier(opts.tier)) {
    const st = modelState(m.id);
    const row = document.createElement("div");
    row.className = "model-row" + (opts.picked === m.id ? " picked" : "");
    const radio = document.createElement("span");
    radio.className = "radio";
    const body = document.createElement("div");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = sttFull(m.id).replace(/^Local /, "");
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${m.languages || ""} · ${fmtMb(m.sizeMb || 0)} · ${m.kind === "streaming" ? "streaming" : "utterances"}`;
    body.append(name, meta);
    const act = document.createElement("div");
    act.className = "act";
    const btn = (text: string, cls: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.textContent = text;
      b.className = cls;
      b.onclick = (e) => {
        e.stopPropagation();
        onClick();
      };
      return b;
    };
    if (st?.progress != null) {
      const bar = document.createElement("span");
      bar.className = "bar";
      const fill = document.createElement("i");
      fill.style.width = `${st.progress}%`;
      bar.appendChild(fill);
      const pct = document.createElement("span");
      pct.className = "state";
      pct.textContent = `${st.progress}%`;
      act.append(bar, pct, btn("CANCEL", "quiet", () => void cr.cancelModel(m.id).then(setLocalModels)));
    } else if (st?.downloaded) {
      const ready = document.createElement("span");
      ready.className = "state ready";
      ready.textContent = "READY";
      act.append(ready, btn("REMOVE", "quiet", () => void cr.removeModel(m.id).then(setLocalModels)));
    } else {
      if (st?.error) {
        const err = document.createElement("span");
        err.className = "state warn";
        err.textContent = st.error === "cancelled" ? "CANCELLED" : "FAILED";
        err.title = st.error;
        act.appendChild(err);
      }
      act.appendChild(btn(`DOWNLOAD ${fmtMb(m.sizeMb || 0)}`, "", () => void cr.downloadModel(m.id).then(setLocalModels)));
    }
    row.append(radio, body, act);
    row.onclick = () => opts.pick(m.id);
    box.appendChild(row);
  }
}

/**
 * BACK TO CLOUD in the 02 TRANSCRIBE meta line. Local speech can be too slow
 * to live with, and that is only discovered once a session is running - when
 * the strip's selects are all disabled. So this one stays live, and switching
 * restarts the session on Deepgram.
 */
function renderCloudAction(): void {
  const b = $("cloudAction") as HTMLButtonElement;
  if (!sttIsLocal()) {
    b.hidden = true;
    return;
  }
  b.hidden = false;
  const hasKey = !!config.deepgramApiKey;
  b.textContent = hasKey ? "BACK TO CLOUD" : "CLOUD NEEDS A KEY";
  b.className = hasKey ? "ulink-mono" : "ulink-mono warn";
  b.title = hasKey ? `Switch to ${sttFull(lastCloudStt)}` : "Add a Deepgram key to use the cloud";
}

/** DOWNLOAD / CANCEL link in the 02 TRANSCRIBE meta line */
function renderModelAction(): void {
  const b = $("modelAction") as HTMLButtonElement;
  const live = session === "live" || session === "starting";
  if (!sttIsLocal() || live) {
    b.hidden = true;
    return;
  }
  const m = modelState(config.stt);
  b.hidden = false;
  b.className = "ulink-mono";
  if (m?.progress != null) b.textContent = "CANCEL";
  else if (m?.downloaded) b.textContent = "MODELS";
  else {
    b.textContent = `DOWNLOAD ${fmtMb(m?.sizeMb || sttModel(config.stt)?.sizeMb || 0)}`;
    b.classList.add("warn");
  }
}

function setLocalModels(list: LocalModelStatus[] | undefined): void {
  if (!list) return;
  localModels = list;
  renderChain();
  if (view === "settings") renderModelList($("settingsModels"), { picked: sttIsLocal() ? config.stt : "", pick: (id) => void saveAndApply({ stt: id }, { restart: true }) });
  if (view === "onboarding" && obStep === 1) renderOnboarding();
}

function fieldStatus(id: string, key: string, chk: KeyValidation | "checking" | undefined, required: boolean): void {
  const el = $(id);
  el.className = "field-status";
  if (!key) {
    el.textContent = "NOT SET";
    el.classList.add(required ? "warn" : "dim");
  } else if (chk === "checking") {
    el.textContent = "CHECKING…";
    el.classList.add("dim");
  } else if (chk && !chk.valid) {
    el.textContent = chk.detail === "no connection" || chk.detail === "timed out" ? "COULD NOT CHECK" : "INVALID";
    el.classList.add("warn");
  } else if (chk && chk.valid) {
    el.textContent = chk.creditUsd != null ? `VALID · $${chk.creditUsd.toFixed(2)} CREDIT` : "VALID";
  } else {
    el.textContent = "SET";
  }
}

function renderKeyStatuses(): void {
  // required only when the cloud engine is actually in use. Hard-coding true
  // put an amber NOT SET on the Deepgram key for anyone running a local model,
  // flagging a key they do not need and never will
  fieldStatus("dgStatus", inp("deepgramApiKey").value.trim(), verdictFor("deepgram", inp("deepgramApiKey").value.trim()), !sttIsLocal());
  fieldStatus("gmStatus", inp("geminiApiKey").value.trim(), verdictFor("gemini", inp("geminiApiKey").value.trim()), false);
  const relay = inp("relayUrl").value.trim();
  const rs = $("relayStatus");
  rs.className = "field-status";
  if (!relay) {
    rs.textContent = "NOT SET";
    rs.classList.add("warn");
  } else if (!/^wss?:\/\/[^/\s]+\/?$/i.test(relay)) {
    rs.textContent = "USE ws:// OR wss://";
    rs.classList.add("warn");
  } else {
    const up = status?.relay.uplinkState;
    rs.textContent = up === "connected" ? "CONNECTED" : up === "error" ? "ERROR" : "SET";
    if (up === "error") rs.classList.add("warn");
  }
}

async function saveSettings(): Promise<void> {
  const patch: Partial<AppConfig> = {
    deepgramApiKey: inp("deepgramApiKey").value.trim() || undefined,
    geminiApiKey: inp("geminiApiKey").value.trim() || undefined,
    relayUrl: inp("relayUrl").value.trim() || undefined,
    publisherToken: inp("publisherToken").value.trim() || undefined,
    publicBaseUrl: inp("publicBaseUrl").value.trim() || undefined,
    relayPort: Number(inp("relayPort").value) || 8787,
    updateFeedUrl: inp("updateFeedUrl").value.trim() || undefined,
    linkMode: (($("linkModeSeg").querySelector("button.active") as HTMLElement | null)?.dataset.value as AppConfig["linkMode"]) || config.linkMode,
  };
  // ConfigStore.merge skips undefined: clear removed secrets explicitly with ""
  for (const k of ["deepgramApiKey", "geminiApiKey", "relayUrl", "publisherToken", "publicBaseUrl", "updateFeedUrl"] as const) {
    if (patch[k] === undefined && config[k]) (patch as Record<string, unknown>)[k] = "";
  }
  const relayChanged = ["deepgramApiKey", "geminiApiKey", "relayUrl", "publisherToken", "relayPort"].some(
    (k) => (patch as Record<string, unknown>)[k] !== undefined && (patch as Record<string, unknown>)[k] !== (config as unknown as Record<string, unknown>)[k],
  );
  await saveAndApply(patch, { restart: relayChanged });
  log("settings saved", "ok");
  setView("stage");
}

// ---------------------------------------------------------------------------
// onboarding (turn 4)
// ---------------------------------------------------------------------------

let obStep: 1 | 2 | 3 = 1;
let obDeepgram: KeyValidation | "checking" | undefined;
let obGemini: KeyValidation | "checking" | undefined;
/** step 1 choice: cloud (Deepgram key) or local (model on this PC) */
let obMode: "cloud" | "local" = "cloud";
/** local model picked in step 1 */
let obModel = "local-parakeet-tdt-0.6b-v3";
/** tier the step 1 list is filtered to; follows the hardware until the user picks */
let obTier: ModelTier = "medium";
/** true once the user picks a tier themselves, so hardware stops overriding it */
let obTierPicked = false;

/** keep the picked model inside the visible tier, or CONTINUE gates on a hidden row */
function ensureModelInTier(): void {
  if (modelsInTier(obTier).some((m) => m.id === obModel)) return;
  const first = modelsInTier(obTier)[0];
  if (first) obModel = first.id;
}

/**
 * Step 1 opens on the tier of the local model already in use, and otherwise on
 * what this PC can run. A tier the user picked by hand always wins.
 */
function syncTierToHardware(): void {
  if (obTierPicked) return;
  const inUse = isLocalStt(config.stt) ? sttModel(config.stt)?.tier : undefined;
  obTier = inUse || hardware?.recommended || "medium";
  ensureModelInTier();
}

/** mono line naming the CPU, RAM and the tier they suggest */
function renderHardwareLine(): void {
  const el = $("obHardware");
  if (!hardware) {
    el.textContent = "";
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const tier = MODEL_TIERS.find((t) => t.id === hardware!.recommended);
  metaSpans(el, [
    { text: `${hardware.threads} THREADS` },
    { text: `${hardware.ramGb} GB RAM` },
    { text: `SUGGESTS ${tier?.label || hardware.recommended.toUpperCase()}`, cls: "ink" },
  ]);
  el.title = hardware.cpu;
}

/** the tier segmented control, its blurb, and the filtered model list */
function renderTierPicker(): void {
  syncTierToHardware();
  setSeg("obTierSeg", obTier);
  for (const b of $("obTierSeg").querySelectorAll<HTMLButtonElement>("button")) {
    b.classList.toggle("suggested", !!hardware && b.dataset.value === hardware.recommended);
  }
  $("obTierBlurb").textContent = MODEL_TIERS.find((t) => t.id === obTier)?.blurb || "";
  renderHardwareLine();
}

/** the model step 1 will save */
function obSttChoice(): string {
  if (obMode === "local") return obModel;
  return isLocalStt(config.stt) ? "deepgram-nova-3" : config.stt;
}

/** (re)open setup at step 1 with the current values filled in */
function openSetup(): void {
  obStep = 1;
  obMode = isLocalStt(config.stt) ? "local" : "cloud";
  if (isLocalStt(config.stt)) obModel = config.stt;
  // a tier picked in a setup the user abandoned must not outlive it, or the
  // model this PC actually runs is filtered out of the list it reopens on
  obTierPicked = false;
  inp("obDeepgramKey").value = config.deepgramApiKey || "";
  inp("obGeminiKey").value = config.geminiApiKey || "";
  obDeepgram = verdictFor("deepgram", config.deepgramApiKey) === "checking" ? undefined : verdictFor("deepgram", config.deepgramApiKey);
  obGemini = verdictFor("gemini", config.geminiApiKey) === "checking" ? undefined : verdictFor("gemini", config.geminiApiKey);
  if (config.deepgramApiKey && !obDeepgram) obCheckDeepgram();
  // the same repair for Gemini: without it a saved key that has never been
  // checked this run leaves step 2 showing EMPTY with CONTINUE dead, and the
  // only enabled way out is SKIP, which turns off the translation it was for
  if (config.geminiApiKey && !obGemini) obCheckGemini();
  setSeg("obSttSeg", obMode);
  setSeg("obOutputSeg", config.output || "phone");
  setView("onboarding");
}

const SAMPLE_EN = ["Two pushing B main, one's low", "Rotate A, spike's down", "He's one shot, behind the box", "Reloading, cover me"];
const SAMPLE_VI = ["Hai đứa đẩy B main, một đứa yếu máu", "Đảo sang A, spike đã đặt", "Nó còn một viên, sau cái hộp", "Đang nạp đạn, che tôi"];
const SAMPLE_TS = ["00:09", "00:14", "00:21", "00:24"];

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

function previewLines(opts: { size?: "lg"; tone: (i: number) => string; texts: string[]; ts?: boolean }): string {
  return opts.texts
    .map((t, i) => {
      const cls = `pline ${opts.size || ""} ${opts.ts === false ? "bare" : ""} ${opts.tone(i)}`;
      return `<div class="${cls}">${opts.ts === false ? "" : `<span class="ts">${SAMPLE_TS[i]}</span>`}<span class="text">${esc(t)}</span></div>`;
    })
    .join("");
}

function renderOnboardingPreview(): void {
  const box = $("obPreview");
  const target = langName(config.languages.target).toUpperCase();
  if (obStep === 1) {
    const valid = obDeepgram && obDeepgram !== "checking" && obDeepgram.valid;
    box.innerHTML =
      `<div class="preview-head label">WHAT YOU'LL GET</div>` +
      `<div class="preview-lines">${previewLines({
        texts: SAMPLE_EN,
        tone: (i) => (valid ? (i < 2 ? "c-dim" : "c-ink") : "c-mute"),
      })}</div>`;
  } else if (obStep === 2) {
    box.innerHTML =
      `<div class="preview-cols">` +
      `<div class="preview-col"><div class="preview-head label">ENGLISH</div><div class="preview-lines">${previewLines({
        texts: SAMPLE_EN,
        ts: false,
        tone: (i) => (i < 2 ? "c-dim" : "c-ink"),
      })}</div></div>` +
      `<div class="preview-col hatched"><div class="preview-head label c-mute">${esc(target)} · WITH KEY</div><div class="preview-lines">${previewLines({
        texts: SAMPLE_VI,
        ts: false,
        tone: () => "c-mute",
      })}</div></div>` +
      `</div>`;
  } else {
    const withKey = !!config.geminiApiKey && config.translationEnabled !== false;
    if (withKey) {
      box.innerHTML =
        `<div class="preview-cols">` +
        `<div class="preview-col"><div class="preview-head label">ENGLISH · SOURCE</div><div class="preview-lines">${previewLines({
          texts: SAMPLE_EN,
          ts: false,
          tone: (i) => (i < 2 ? "c-dim" : "c-ink"),
        })}</div></div>` +
        `<div class="preview-col"><div class="preview-head label">${esc(target)} · TRANSLATION</div><div class="preview-lines">${previewLines({
          texts: SAMPLE_VI,
          ts: false,
          tone: (i) => (i < 2 ? "c-dim" : "c-ink"),
        })}</div></div>` +
        `</div>`;
    } else {
      box.innerHTML =
        `<div class="preview-head label">ENGLISH · CAPTIONS</div>` +
        `<div class="preview-lines">${previewLines({ size: "lg", texts: SAMPLE_EN, tone: (i) => (i < 2 ? "c-dim" : "c-ink") })}</div>`;
    }
  }
}

function obValue(blockId: string, text: string): void {
  const blk = $(blockId);
  let v = blk.querySelector<HTMLElement>(".ob-value");
  if (!v) {
    v = document.createElement("div");
    v.className = "block-value ob-value";
    blk.querySelector(".block-value")!.after(v);
  }
  v.textContent = text;
  v.hidden = false;
}

function renderOnboardingChain(): void {
  const blocks: [string, string][] = [
    ["blkSource", "metaSource"],
    ["blkStt", "metaStt"],
    ["blkTranslate", "metaTranslate"],
    ["blkOutput", "metaOutput"],
  ];
  for (const [id] of blocks) {
    const b = $(id);
    b.classList.remove("current", "off", "hatched", "struck");
    b.classList.add("placeholder");
    for (const el of b.querySelectorAll<HTMLElement>(".select-row, #outputSeg, #translateNeedsKey, #outputLive")) el.hidden = true;
  }
  $("meter").hidden = true;
  $("metaSource").hidden = false;
  $("rescan").hidden = true;
  $("translateToggle").hidden = true;
  const hasGemini = !!config.geminiApiKey && config.translationEnabled !== false;

  // 01
  $("source2Row").hidden = true;
  $("source3Row").hidden = true;
  if (obStep === 3) {
    $("blkSource").classList.remove("placeholder");
    $("blkSource").classList.add("current");
    const a = sel("obAudioSource").value || config.audioSource;
    const b = sel("obAudioSource2").value;
    obValue("blkSource", b && b !== a ? `${sourceLabel(a)} + ${sourceLabel(b)}` : sourceLabel(a));
    $("sourceKind").textContent = sourceKindLabel([a, b && b !== a ? b : ""].filter(Boolean));
  } else {
    obValue("blkSource", "—");
    $("sourceKind").textContent = "STEP 3";
  }
  // 02
  $("modelAction").hidden = true;
  const choice = obStep === 1 ? obSttChoice() : config.stt;
  obValue("blkStt", sttFull(choice));
  $("blkStt").classList.remove("placeholder");
  if (obStep === 1) $("blkStt").classList.add("current");
  if (isLocalStt(choice)) {
    metaSpans($("metaStt"), [{ text: "ON THIS PC" }, modelReady(choice) ? { text: "READY" } : { text: "NOT DOWNLOADED", cls: "warn" }]);
  } else if (obStep === 1) {
    const v = obDeepgram && obDeepgram !== "checking" && obDeepgram.valid;
    metaSpans($("metaStt"), [v ? { text: "KEY OK" } : { text: "KEY NEEDED", cls: "warn" }]);
  } else {
    metaSpans($("metaStt"), [{ text: "KEY OK" }]);
  }
  // 03
  $("gmKeyState").className = "";
  $("addKey").hidden = true;
  $("translateExtra").className = "";
  sel("translation").parentElement!.hidden = true;
  if (obStep === 1) {
    obValue("blkTranslate", "—");
    $("gmKeyState").textContent = "STEP 2 · OPTIONAL";
    $("translateExtra").textContent = "";
  } else if (obStep === 2) {
    $("blkTranslate").classList.remove("placeholder");
    $("blkTranslate").classList.add("current");
    obValue("blkTranslate", trFull(config.translation));
    $("gmKeyState").textContent = "KEY OPTIONAL";
    $("gmKeyState").className = "warn";
    $("translateExtra").textContent = "";
  } else if (hasGemini) {
    $("blkTranslate").classList.remove("placeholder");
    obValue("blkTranslate", `${langName(config.languages.source)} → ${langName(config.languages.target)}`);
    $("gmKeyState").textContent = "KEY OK";
    $("translateExtra").textContent = "";
  } else {
    $("blkTranslate").classList.remove("placeholder");
    $("blkTranslate").classList.add("off", "hatched");
    obValue("blkTranslate", "No key");
    $("gmKeyState").textContent = "";
    $("addKey").hidden = false;
    $("addKey").textContent = "ADD GEMINI KEY";
    $("translateExtra").textContent = "";
  }
  // 04
  if (obStep === 3) {
    $("blkOutput").classList.remove("placeholder");
    $("blkOutput").classList.add("current");
    const out = (($("obOutputSeg").querySelector("button.active") as HTMLElement | null)?.dataset.value as OutputTarget) || "phone";
    obValue("blkOutput", outputLabel(out));
    metaSpans($("metaOutput"), out === "obs" ? [{ text: "LOCAL" }] : config.relayUrl ? [{ text: "RELAY SET" }] : [{ text: "LAN ONLY", cls: "warn" }]);
  } else {
    obValue("blkOutput", "—");
    metaSpans($("metaOutput"), [{ text: "STEP 3" }]);
  }
}

function renderOnboarding(): void {
  for (const s of $("stepper").querySelectorAll<HTMLElement>("span")) {
    const n = Number(s.dataset.step);
    s.classList.toggle("done", n < obStep);
    s.classList.toggle("current", n === obStep);
    if (n === 1) s.textContent = obStep > 1 ? "1 SPEECH ✓" : "1 SPEECH";
    if (n === 2) {
      s.textContent =
        obStep > 2 ? (config.geminiApiKey && config.translationEnabled !== false ? "2 TRANSLATION ✓" : "2 TRANSLATION SKIPPED") : "2 TRANSLATION";
    }
  }
  // step 1 local turns the right pane into the model browser; the list needs
  // the height, and the left pane keeps the copy and CONTINUE
  const browsing = obStep === 1 && obMode === "local";
  $("obPreview").hidden = browsing;
  $("obModelPane").hidden = !browsing;
  $("obStep1").hidden = obStep !== 1;
  $("obStep2").hidden = obStep !== 2;
  $("obStep3").hidden = obStep !== 3;
  $("obClose").hidden = !config.setupDone;
  if (obStep === 1) {
    $("obStepLabel").textContent = "STEP 1 OF 3 · REQUIRED";
    $("obCloud").hidden = obMode !== "cloud";
    $("obLocal").hidden = obMode !== "local";
    setSeg("obSttSeg", obMode);
    if (obMode === "local") {
      $("obTitle").textContent = "Pick a model to run on this PC.";
      $("obBody").textContent =
        "Local speech-to-text is free and private - nothing leaves your machine. It costs CPU and a download; cloud Deepgram is a little faster.";
      renderTierPicker();
      renderPickedDetail();
      renderModelList($("obModels"), {
        picked: obModel,
        tier: obTier,
        pick: (id) => {
          obModel = id;
          renderOnboarding();
        },
      });
    } else {
      $("obTitle").textContent = "Relay needs a Deepgram key to hear you.";
      $("obBody").textContent =
        "Deepgram turns your mic or game audio into text. Your key is stored on this PC and never sent anywhere except Deepgram. Or switch to Local and skip the key.";
    }
  } else if (obStep === 2) {
    $("obStepLabel").textContent = "STEP 2 OF 3 · OPTIONAL";
    $("obTitle").textContent = "Want captions in another language?";
    $("obBody").textContent =
      "Add a Gemini key and Relay translates each line as it lands. Skip it and viewers get English captions only - you can add it later under KEYS.";
  } else {
    $("obStepLabel").textContent = "STEP 3 OF 3";
    $("obTitle").textContent = "Pick what Relay listens to.";
    $("obBody").textContent = "Add a second source to caption the voice chat next to your own callouts - every line gets a YOU / CHAT tag.";
    const out = (($("obOutputSeg").querySelector("button.active") as HTMLElement | null)?.dataset.value as OutputTarget) || "phone";
    const meta = $("obOutputMeta");
    meta.className = "field-meta mono";
    if (out === "obs") meta.textContent = "OBS READS A LOCAL LINK. NOTHING LEAVES THIS PC.";
    else if (config.relayUrl) meta.textContent = "PHONE LINKS GO THROUGH YOUR RELAY.";
    else {
      meta.textContent = "PHONE LINKS WORK ON YOUR LAN. SET A RELAY URL UNDER KEYS FOR THE INTERNET.";
      meta.classList.add("warn");
    }
  }
  renderObKeyStatus();
  renderOnboardingPreview();
  renderOnboardingChain();
  renderTopbar();
}

function renderObKeyStatus(): void {
  const dg = $("obDgStatus");
  const key = inp("obDeepgramKey").value.trim();
  dg.className = "field-status";
  if (!key) {
    dg.textContent = "WAITING";
    dg.classList.add("mute");
  } else if (obDeepgram === "checking") {
    dg.textContent = "CHECKING…";
    dg.classList.add("dim");
  } else if (obDeepgram && !obDeepgram.valid) {
    dg.textContent = obDeepgram.detail === "no connection" || obDeepgram.detail === "timed out" ? "COULD NOT REACH DEEPGRAM" : "KEY REJECTED";
    dg.classList.add("warn");
  } else if (obDeepgram && obDeepgram.valid) {
    dg.textContent = obDeepgram.creditUsd != null ? `VALID · $${obDeepgram.creditUsd.toFixed(2)} CREDIT` : "VALID";
  } else {
    // a key in the field with no result yet: never leave the previous text
    dg.textContent = "CHECKING…";
    dg.classList.add("dim");
  }
  const keyOk = !!(obDeepgram && obDeepgram !== "checking" && obDeepgram.valid);
  const ms = $("obModelStatus");
  ms.className = "field-status";
  const st = modelState(obModel);
  if (st?.progress != null) {
    ms.textContent = `DOWNLOADING ${st.progress}%`;
    ms.classList.add("dim");
  } else if (st?.downloaded) {
    ms.textContent = "READY";
  } else {
    ms.textContent = "NOT DOWNLOADED";
    ms.classList.add("warn");
  }
  const ok1 = obMode === "local" ? modelReady(obModel) : keyOk;
  ($("obContinue1") as HTMLButtonElement).disabled = !ok1;
  $("obHint1").textContent = ok1
    ? "NEXT: TRANSLATION (OPTIONAL)"
    : obMode === "local"
      ? "DOWNLOAD THE MODEL TO CONTINUE"
      : "VALIDATES ON PASTE";
  $("obHint1").className = ok1 ? "mono dim" : "mono mute";

  const gm = $("obGmStatus");
  const gkey = inp("obGeminiKey").value.trim();
  gm.className = "field-status";
  if (!gkey) {
    gm.textContent = "EMPTY";
    gm.classList.add("mute");
  } else if (obGemini === "checking") {
    gm.textContent = "CHECKING…";
    gm.classList.add("dim");
  } else if (obGemini && !obGemini.valid) {
    gm.textContent = obGemini.detail === "no connection" || obGemini.detail === "timed out" ? "COULD NOT REACH GEMINI" : "KEY REJECTED";
    gm.classList.add("warn");
  } else if (obGemini && obGemini.valid) {
    gm.textContent = "VALID";
  } else {
    gm.textContent = "CHECKING…";
    gm.classList.add("dim");
  }
  const ok2 = !!(obGemini && obGemini !== "checking" && obGemini.valid);
  const c2 = $("obContinue2") as HTMLButtonElement;
  c2.disabled = !ok2;
  c2.className = ok2 ? "ink-btn" : "outline-btn";
}

const obCheckDeepgram = debounce(async () => {
  const key = inp("obDeepgramKey").value.trim();
  if (!key) {
    obDeepgram = undefined;
    renderObKeyStatus();
    return;
  }
  obDeepgram = "checking";
  renderObKeyStatus();
  const res = await cr.validateKey("deepgram", key);
  if (inp("obDeepgramKey").value.trim() !== key) return;
  obDeepgram = res;
  keyCheck.deepgram = { key, result: res };
  renderOnboarding();
}, 500);

const obCheckGemini = debounce(async () => {
  const key = inp("obGeminiKey").value.trim();
  if (!key) {
    obGemini = undefined;
    renderObKeyStatus();
    return;
  }
  obGemini = "checking";
  renderObKeyStatus();
  const res = await cr.validateKey("gemini", key);
  if (inp("obGeminiKey").value.trim() !== key) return;
  obGemini = res;
  keyCheck.gemini = { key, result: res };
  renderObKeyStatus();
}, 500);

async function obGoto(step: 1 | 2 | 3): Promise<void> {
  obStep = step;
  if (step === 3) await refreshDevices();
  renderOnboarding();
}

// ---------------------------------------------------------------------------
// what's new
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<string, string> = { added: "NEW", fixed: "FIXED", changed: "CHANGED" };

function renderWhatsNew(entries: ChangelogEntry[], from: string): void {
  const newest = entries[0];
  $("wnVersion").textContent = newest.version;
  $("wnHeadline").textContent = newest.headline;
  $("wnFrom").textContent = `UPDATED FROM ${from}`;

  const body = $("wnBody");
  body.innerHTML = "";
  for (const entry of entries) {
    const rel = document.createElement("div");
    rel.className = "wn-release";

    // the newest release's headline is already above the list; the older ones
    // in a multi-version jump still need naming
    if (entry !== newest) {
      const head = document.createElement("div");
      head.className = "wn-release-head";
      const ver = document.createElement("span");
      ver.className = "wn-release-ver";
      ver.textContent = entry.version;
      const date = document.createElement("span");
      date.className = "wn-release-date";
      date.textContent = entry.date;
      head.append(ver, date);
      rel.append(head);
    }

    for (const line of entry.changes) {
      const row = document.createElement("div");
      row.className = "wn-line";
      const kind = document.createElement("span");
      kind.className = "wn-kind";
      kind.dataset.kind = line.kind;
      kind.textContent = KIND_LABEL[line.kind] || line.kind.toUpperCase();
      const text = document.createElement("span");
      text.className = "wn-text";
      text.textContent = line.text;
      row.append(kind, text);
      rel.append(row);
    }
    body.append(rel);
  }
  $("whatsnew").hidden = false;
}

/**
 * Show what changed, once, after the app has updated itself.
 *
 * A fresh install has no lastSeenVersion and gets nothing - there is no "what's
 * new" for someone who has never run it - so the version is recorded silently
 * and the panel waits for a real update. The version is written back before the
 * panel is dismissed, so a crash while it is open does not show it twice.
 */
async function showWhatsNewIfUpdated(): Promise<void> {
  const current = await cr.appVersion().catch(() => "");
  if (!current) return;
  const entries = changesSince(config.lastSeenVersion, current);
  // no restart: this touches nothing the relay reads
  if (config.lastSeenVersion !== current) void saveAndApply({ lastSeenVersion: current });
  if (!entries.length) return;
  renderWhatsNew(entries, config.lastSeenVersion || "");
  log(`updated to ${current}`, "ok");
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

function bindSeg(id: string, onPick: (value: string) => void): void {
  for (const b of $(id).querySelectorAll<HTMLButtonElement>("button")) {
    b.onclick = () => {
      setSeg(id, b.dataset.value || "");
      onPick(b.dataset.value || "");
    };
  }
}

/**
 * Update state lives in two places: a footer chip that only appears when there
 * is something to act on, and the full readout in the keys view.
 */
function renderUpdate(): void {
  const u = update;
  const chip = $("updateChip");
  const state = $("updateState");
  const version = $("updateVersion");
  const install = $("installUpdate");
  const releases = $("openReleases");
  const check = $("checkUpdate") as HTMLButtonElement;

  version.textContent = u ? `RUNNING ${u.current}` : "";
  $("autoUpdate").classList.toggle("on", config.autoUpdate !== false);

  if (!u) {
    chip.hidden = true;
    state.textContent = "—";
    return;
  }

  // footer chip: only ready / downloading / a found update earn attention.
  // it shares the readout row, so keep it short - KEYS has the full story
  const chipText =
    u.state === "ready" ? `UPDATE ${u.latest}` :
    u.state === "downloading" ? `UPDATE ${u.percent ?? 0}%` :
    u.state === "available" ? `UPDATE ${u.latest}` :
    "";
  chip.hidden = !chipText;
  chip.textContent = chipText;
  chip.title = u.state === "ready" ? `Version ${u.latest} is ready - click to restart and install` : "";
  chip.classList.toggle("progress", u.state === "downloading");
  // the chip and the STT/TRN figures fight for the same row; the chip wins
  $("app").classList.toggle("has-update", !chip.hidden);

  state.className = "mono update-state";
  install.hidden = u.state !== "ready";
  releases.hidden = u.state !== "unsupported" && u.state !== "error";
  check.disabled = u.state === "checking" || u.state === "downloading";

  switch (u.state) {
    case "checking":
      state.textContent = "CHECKING…";
      break;
    case "downloading":
      state.textContent = `DOWNLOADING ${u.latest ?? ""} · ${u.percent ?? 0}%`;
      break;
    case "available":
      state.textContent = `${u.latest} AVAILABLE`;
      state.classList.add("warn");
      break;
    case "ready":
      state.textContent = `${u.latest} READY - RESTART TO INSTALL`;
      state.classList.add("ready");
      break;
    case "current":
      state.textContent = `UP TO DATE${u.checkedAt ? ` · CHECKED ${new Date(u.checkedAt).toLocaleTimeString()}` : ""}`;
      break;
    case "unsupported":
      state.textContent = `${(u.detail || "").toUpperCase()} - UPDATE BY HAND`;
      break;
    case "error":
      state.textContent = (u.detail || "CHECK FAILED").toUpperCase();
      state.classList.add("warn");
      break;
    default:
      state.textContent = "NOT CHECKED YET";
  }
}

function setUpdate(u: UpdateStatus | undefined): void {
  if (!u) return;
  const wasReady = update?.state === "ready";
  update = u;
  renderUpdate();
  if (u.state === "ready" && !wasReady) log(`update ${u.latest} ready - restart to install`, "ok");
}

function bind(): void {
  // footer
  $("startStop").onclick = () => {
    if (session === "live" || session === "starting") stopSession();
    else void startSession({ rotateLink: true });
  };
  $("copyLink").onclick = () => {
    const url = currentLink();
    if (url) void copyText(url, "link");
  };
  $("openLink").onclick = () => {
    const url = currentLink();
    if (url) void cr.openExternal(url);
  };
  $("rotateLink").onclick = async () => {
    await cr.rotateLink();
    log("links rotated - old links are dead", "ok");
  };
  bindSeg("linkSeg", (v) => {
    linkChoice = v as "phone" | "obs";
    renderFooter();
  });
  // an OBS-only user should still open on the OBS link; they can switch either way
  if (config?.output === "obs") linkChoice = "obs";
  $("settingsBtn").onclick = () => setView(view === "settings" ? "stage" : "settings");
  $("wnClose").onclick = () => {
    $("whatsnew").hidden = true;
  };
  $("settingsSetup").onclick = () => {
    if (session === "live" || session === "starting") stopSession();
    openSetup();
  };
  $("obClose").onclick = () => setView("stage");
  $("logBtn").onclick = () => setView(view === "log" ? "stage" : "log");
  $("settingsBack").onclick = () => setView("stage");
  $("logBack").onclick = () => setView("stage");

  // chain
  $("rescan").onclick = () => void refreshDevices();
  for (const id of SOURCE_SLOTS) {
    // the whole list, not the one slot: dropping a device out of slot 2 has to
    // close the gap, and the legacy pair is mirrored from this by the store
    sel(id).onchange = () => void saveAndApply({ sources: pickedSources() }, { restart: true });
  }
  $("cloudAction").onclick = () => {
    if (!config.deepgramApiKey) {
      setView("settings");
      inp("deepgramApiKey").focus();
      return;
    }
    void saveAndApply({ stt: lastCloudStt }, { restart: true });
  };
  $("modelAction").onclick = () => {
    const m = modelState(config.stt);
    if (m?.progress != null) void cr.cancelModel(config.stt).then(setLocalModels);
    else if (m?.downloaded) setView("settings");
    else void cr.downloadModel(config.stt).then(setLocalModels);
  };
  sel("stt").onchange = () => {
    const next = sel("stt").value;
    if (!isLocalStt(next)) lastCloudStt = next;
    void saveAndApply({ stt: next }, { restart: true });
  };
  sel("translation").onchange = () => void saveAndApply({ translation: sel("translation").value }, { restart: true });
  sel("langSource").onchange = () =>
    void saveAndApply({ languages: { source: sel("langSource").value, target: config.languages.target } }, { restart: true });
  sel("langTarget").onchange = () =>
    void saveAndApply({ languages: { source: config.languages.source, target: sel("langTarget").value } }, { restart: true });
  $("translateToggle").onclick = () => {
    if (session === "live" || session === "starting") return;
    if (!config.geminiApiKey) {
      setView("settings");
      inp("geminiApiKey").focus();
      return;
    }
    void saveAndApply({ translationEnabled: config.translationEnabled === false }, { restart: true });
  };
  $("addKey").onclick = () => {
    if (view === "onboarding") void obGoto(2);
    else {
      setView("settings");
      inp("geminiApiKey").focus();
    }
  };
  for (let i = 0; i < MAX_CAPTURE_CHANNELS; i++) {
    const input = inp(`sourceName${i + 1}`);
    // on change, not on input: this restarts a session, and every keystroke
    // rebuilding the publisher would be its own kind of broken
    input.onchange = () => {
      const labels = [0, 1, 2].map((slot) => inp(`sourceName${slot + 1}`).value.trim());
      void saveAndApply({ sourceLabels: labels }, { restart: true });
    };
    // "change" not "input": a colour picker fires input on every drag of the
    // hue slider, and each one would restart the publisher
    inp(`sourceColor${i + 1}`).onchange = () => {
      const colours = [0, 1, 2].map((slot) => safeSpeakerColor(inp(`sourceColor${slot + 1}`).value) || "");
      void saveAndApply({ sourceColors: colours }, { restart: true });
    };
  }
  $("openCaptionView").onclick = () => {
    const url = captionSettingsUrl();
    if (url) void cr.openExternal(url);
  };
  $("badgesToggle").onclick = () => {
    if (session === "live" || session === "starting") return;
    void saveAndApply({ showLatency: config.showLatency === false }, { restart: true });
  };
  $("filterToggle").onclick = () => {
    if (session === "live" || session === "starting") return;
    void saveAndApply({ profanityFilter: config.profanityFilter === false }, { restart: true });
  };
  bindSeg("outputSeg", (v) => void saveAndApply({ output: v as OutputTarget }));

  // keys view
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-show]")) {
    b.onclick = () => {
      const i = inp(b.dataset.show!);
      i.type = i.type === "password" ? "text" : "password";
      b.textContent = i.type === "password" ? "SHOW" : "HIDE";
    };
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-clear]")) {
    b.onclick = () => {
      const i = inp(b.dataset.clear!);
      i.value = "";
      i.dispatchEvent(new Event("input"));
      i.focus();
    };
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-open]")) {
    b.onclick = () => void cr.openExternal(b.dataset.open!);
  }
  const checkDg = debounce(() => void checkKey("deepgram", inp("deepgramApiKey").value.trim()).then(renderKeyStatuses), 500);
  const checkGm = debounce(() => void checkKey("gemini", inp("geminiApiKey").value.trim()).then(renderKeyStatuses), 500);
  inp("deepgramApiKey").oninput = () => {
    renderKeyStatuses();
    checkDg();
  };
  inp("geminiApiKey").oninput = () => {
    renderKeyStatuses();
    checkGm();
  };
  inp("relayUrl").oninput = () => renderKeyStatuses();
  // persists like every other segmented control. It used to be a no-op, so the
  // pick lived only in the DOM: any other save in this pane called
  // syncControlsFromConfig, which reset the buttons to the STORED value, and
  // SAVE then read the reset DOM and wrote the old value back. A streamer who
  // chose "fixed" so their OBS source would keep working silently got "unique",
  // and the next START rotated the token - putting THIS LINK HAS ENDED on air.
  bindSeg("linkModeSeg", (v) => void saveAndApply({ linkMode: v as AppConfig["linkMode"] }));
  $("settingsSave").onclick = () => void saveSettings();
  $("checkUpdate").onclick = async () => {
    log("checking for updates…");
    setUpdate(await cr.checkForUpdate());
  };
  $("installUpdate").onclick = () => void cr.installUpdate();
  $("openReleases").onclick = () => void cr.openExternal(update?.releaseUrl || "https://github.com/imbafls/relay_translator/releases/latest");
  $("autoUpdate").onclick = () => void saveAndApply({ autoUpdate: config.autoUpdate === false });
  $("updateChip").onclick = () => {
    if (update?.state === "ready") void cr.installUpdate();
    else setView("settings");
  };
  for (const i of $("settings").querySelectorAll<HTMLInputElement>("input")) {
    i.onkeydown = (e) => {
      if (e.key === "Enter") void saveSettings();
    };
  }

  // onboarding
  inp("obDeepgramKey").oninput = () => {
    obDeepgram = undefined;
    renderObKeyStatus();
    obCheckDeepgram();
  };
  inp("obGeminiKey").oninput = () => {
    obGemini = undefined;
    renderObKeyStatus();
    obCheckGemini();
  };
  bindSeg("obSttSeg", (v) => {
    obMode = v === "local" ? "local" : "cloud";
    renderOnboarding();
  });
  bindSeg("obTierSeg", (v) => {
    obTier = v as ModelTier;
    obTierPicked = true;
    ensureModelInTier();
    renderOnboarding();
  });
  $("obContinue1").onclick = async () => {
    const patch: Partial<AppConfig> = { stt: obSttChoice() };
    if (obMode === "cloud") patch.deepgramApiKey = inp("obDeepgramKey").value.trim();
    await saveAndApply(patch);
    await obGoto(2);
  };
  $("obContinue2").onclick = async () => {
    await saveAndApply({ geminiApiKey: inp("obGeminiKey").value.trim(), translationEnabled: true });
    await obGoto(3);
  };
  $("obSkip2").onclick = async () => {
    await saveAndApply({ translationEnabled: false });
    await obGoto(3);
  };
  sel("obAudioSource").onchange = () => renderOnboardingChain();
  sel("obAudioSource2").onchange = () => renderOnboardingChain();
  bindSeg("obOutputSeg", () => renderOnboarding());
  $("obOpenConsole").onclick = async () => {
    const out = (($("obOutputSeg").querySelector("button.active") as HTMLElement | null)?.dataset.value as OutputTarget) || "phone";
    const a = sel("obAudioSource").value || config.audioSource;
    const b = sel("obAudioSource2").value;
    await saveAndApply({ sources: [a, b].filter(Boolean), output: out, setupDone: true });
    $("translateToggle").hidden = false;
    setView("stage");
    log("setup complete - hit START SESSION when ready", "ok");
  };

  // main-process events
  cr.onCommand((cmd) => {
    if (cmd === "start") void startSession({ rotateLink: true });
    else if (cmd === "setup") {
      if (session === "live" || session === "starting") stopSession();
      openSetup();
    } else stopSession();
  });
  cr.onConfigChanged((cfg) => {
    if (syncing) return;
    config = cfg;
    syncControlsFromConfig();
  });
  cr.onStatus((s) => {
    status = s;
    // CPU / RAM never change, so the first broadcast that carries them wins
    if (s.hardware) hardware = s.hardware;
    // setLocalModels re-renders the chain strip itself
    if (s.localModels) setLocalModels(s.localModels);
    else renderChain();
    renderFooter();
    if (s.update) setUpdate(s.update);
    if (view === "settings") renderKeyStatuses();
  });

  cr.onUpdate((u) => setUpdate(u));

  document.addEventListener("keydown", (e) => {
    // the shortcut every desktop app has for this pane; the footer button is
    // the discoverable door, this is the one muscle memory reaches for
    if (e.key === "," && (e.ctrlKey || e.metaKey) && view !== "onboarding") {
      e.preventDefault();
      setView(view === "settings" ? "stage" : "settings");
    }
    if (e.key === "Escape" && (view === "settings" || view === "log")) setView("stage");
    if (e.key === "Escape" && view === "onboarding" && config.setupDone) setView("stage");
  });
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  config = await cr.getConfig();
  // a model can leave the catalogue between versions; never strand the app on one
  if (!sttModel(config.stt)) {
    log(`"${config.stt}" is no longer available - falling back to ${sttFull(lastCloudStt)}`, "err");
    config = await cr.setConfig({ stt: lastCloudStt });
  }
  if (!isLocalStt(config.stt)) lastCloudStt = config.stt;
  bind();
  syncControlsFromConfig();
  setInterval(tickClock, 1000);
  setInterval(renderMeter, 100);
  tickClock();
  localModels = (await cr.modelStatus().catch(() => [])) || [];
  await refreshDevices();

  if (!config.setupDone) {
    openSetup();
    log("first run - pick cloud or local speech to begin");
  } else {
    setView("stage");
    log("ready - hit START SESSION");
    // silent key checks for the KEY OK readouts
    if (config.deepgramApiKey) void checkKey("deepgram", config.deepgramApiKey);
    if (config.geminiApiKey) void checkKey("gemini", config.geminiApiKey);
    void showWhatsNewIfUpdated();
  }
}

void boot();
