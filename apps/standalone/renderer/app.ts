/**
 * Relay desktop console renderer - "caption console" (DESIGN.md, turns 3 + 4).
 *
 * Layout: top bar · stage (or keys / log / onboarding view) · signal-chain strip · footer.
 * All state lives here; the main process owns config, the local relay and the uplink.
 */
import { BrowserAudioCapture, RelayPublisherClient } from "@callout-relay/companion";
import {
  AppConfig,
  ControlStatus,
  KeyValidation,
  LANGUAGES,
  OutputTarget,
  SessionState,
  STT_MODELS,
  TRANSLATION_MODELS,
  UpdateStatus,
} from "@callout-relay/shared";
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

type View = "stage" | "keys" | "log" | "onboarding";

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
const keyCheck: { deepgram?: KeyValidation | "checking"; gemini?: KeyValidation | "checking" } = {};
let update: UpdateStatus | null = null;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const STT_SHORT: Record<string, string> = {
  "deepgram-nova-3": "Nova-3",
  "deepgram-nova-3-multi": "Nova-3 Multi",
  "deepgram-nova-2": "Nova-2",
};
const STT_TAG: Record<string, string> = {
  "deepgram-nova-3": "FASTEST",
  "deepgram-nova-3-multi": "MULTILINGUAL",
  "deepgram-nova-2": "WIDE LANGUAGE",
};
const TR_SHORT: Record<string, string> = {
  "gemini-3.1-flash-lite": "Flash-Lite",
  "gemini-flash-latest": "Flash",
  "gemini-2.5-flash": "2.5 Flash",
};

function sttShort(id: string): string {
  return STT_SHORT[id] || id.replace(/^deepgram-/, "");
}
function sttFull(id: string): string {
  return `Deepgram ${sttShort(id)}`;
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
function logSubtitle(seg: { source: string; target?: string; latency?: { stt?: number; translate?: number } }): void {
  const t = new Date().toLocaleTimeString();
  const en = document.createElement("div");
  en.className = "sub-en";
  en.textContent = `[${t}] ▸ ${seg.source}${seg.latency?.stt != null ? `  [stt ${seg.latency.stt}ms]` : ""}`;
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
  $("keys").hidden = next !== "keys";
  $("logView").hidden = next !== "log";
  $("onboarding").hidden = next !== "onboarding";
  $("footer").hidden = next === "onboarding";
  $("clock").hidden = next === "onboarding";
  $("stepper").hidden = next !== "onboarding";
  $("keysBtn").classList.toggle("active", next === "keys");
  $("logBtn").classList.toggle("active", next === "log");
  if (next === "keys") renderKeys();
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
  latSrc: HTMLElement;
  latTgt: HTMLElement;
  final: boolean;
}
const rows = new Map<number, Row>();
let interim: Row | null = null;
const MAX_ROWS = 12;
const recentStt: number[] = [];
const recentTr: number[] = [];

function makeRow(id: number, isInterim: boolean): Row {
  const el = document.createElement("div");
  el.className = "row" + (isInterim ? " interim" : "");
  el.innerHTML =
    '<div class="src"><span class="ts"></span><span class="text"></span><span class="lat"></span></div>' +
    '<div class="tgt"><span class="text pending">…</span><span class="lat"></span></div>';
  const row: Row = {
    id,
    el,
    srcText: el.querySelector(".src .text") as HTMLElement,
    tgtText: el.querySelector(".tgt .text") as HTMLElement,
    ts: el.querySelector(".ts") as HTMLElement,
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
  while (lines.children.length > MAX_ROWS) {
    const first = lines.firstElementChild as HTMLElement;
    first.remove();
    for (const [id, r] of rows) if (r.el === first) rows.delete(id);
    if (interim && interim.el === first) interim = null;
  }
}

function markLatest(): void {
  let latest: Row | null = null;
  for (const r of rows.values()) if (r.final && (!latest || r.id > latest.id)) latest = r;
  for (const r of rows.values()) r.el.classList.toggle("latest", r === latest);
}

function clearStage(): void {
  $("lines").innerHTML = "";
  rows.clear();
  interim = null;
  recentStt.length = 0;
  recentTr.length = 0;
  renderAverages();
  renderIdle();
}

function onPartial(seg: { id: number; source: string }): void {
  if (!seg.source.trim() || rows.has(seg.id)) return;
  if (!interim) interim = makeRow(seg.id, true);
  interim.id = seg.id;
  interim.srcText.textContent = seg.source;
  const cur = document.createElement("span");
  cur.className = "cursor";
  interim.srcText.appendChild(cur);
  interim.tgtText.textContent = "…";
  trimRows();
  renderIdle();
}

function onSubtitle(seg: { id: number; source: string; target?: string; latency?: { stt?: number; translate?: number } }): void {
  let row = rows.get(seg.id);
  if (!row) {
    if (interim) {
      // the interim row becomes this final segment
      row = interim;
      interim = null;
      row.el.classList.remove("interim");
      row.id = seg.id;
    } else {
      row = makeRow(seg.id, false);
    }
    rows.set(seg.id, row);
  }
  row.final = true;
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
  const chain = `${sourceLabel(config.audioSource)} → ${sttShort(config.stt)} → ${
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
  let sum = 0;
  let n = 0;
  for (let i = 0; i < chunk.length; i += 4) {
    const v = chunk[i] / 32768;
    sum += v * v;
    n += 1;
  }
  const rms = n ? Math.sqrt(sum / n) : 0;
  level = Math.max(level * 0.85, rms);
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
    if (!config.deepgramApiKey) throw new Error("Add a Deepgram key first (KEYS).");
    clearStage();
    renderStageHeads();

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
    });

    level = 0;
    await capture.start(config.audioSource, (chunk) => {
      feedLevel(chunk);
      relayClient?.sendAudio(chunk.buffer);
    });
    log(`capture started: ${sourceLabel(config.audioSource)}`, "ok");
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
  if (interim) {
    interim.el.remove();
    interim = null;
  }
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
  const entries = devices.map((d) => ({ value: d.id, label: d.label }));
  fillSelect(sel("audioSource"), entries, config.audioSource);
  fillSelect(sel("obAudioSource"), entries, config.audioSource);
  cr.reportDevices(devices);
  renderChain();
  renderIdle();
}

function syncControlsFromConfig(): void {
  syncing = true;
  const langs = LANGUAGES.map((l) => ({ value: l.code, label: langName(l.code) }));
  fillSelect(sel("stt"), STT_MODELS.map((m) => ({ value: m.id, label: sttFull(m.id) })), config.stt);
  fillSelect(sel("translation"), TRANSLATION_MODELS.map((m) => ({ value: m.id, label: trFull(m.id).toUpperCase() })), config.translation);
  fillSelect(sel("langSource"), langs, config.languages.source);
  fillSelect(sel("langTarget"), langs, config.languages.target);
  refitSelects();
  setSeg("outputSeg", config.output || "phone");
  setSeg("obOutputSeg", config.output || "phone");
  setSeg("linkModeSeg", config.linkMode);
  $("badgesToggle").classList.toggle("on", config.showLatency !== false);
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
  keyCheck[provider] = "checking";
  renderChain();
  const res = await cr.validateKey(provider, key);
  keyCheck[provider] = res;
  renderChain();
  if (view === "keys") renderKeyStatuses();
  return res;
}

function keyStateLabel(provider: "deepgram" | "gemini"): { text: string; cls: string } {
  const present = provider === "deepgram" ? !!config.deepgramApiKey : !!config.geminiApiKey;
  const chk = keyCheck[provider];
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
  // onboarding hides these; the console always owns them
  $("translateToggle").hidden = false;
  $("badgesToggle").hidden = false;
  $("addKey").textContent = "ADD KEY";
  const rel = status?.relay;
  const blocks = ["blkSource", "blkStt", "blkTranslate", "blkOutput"];
  for (const id of blocks) $(id).classList.remove("placeholder", "current");
  for (const s of document.querySelectorAll<HTMLSelectElement>("#chain select")) s.disabled = live;
  for (const b of $("chain").querySelectorAll<HTMLElement>(".ob-value")) b.hidden = true;
  for (const b of $("chain").querySelectorAll<HTMLElement>(".select-row, #outputSeg, #translateNeedsKey, #translatePair")) b.hidden = false;

  // 01 SOURCE
  $("sourceKind").textContent = config.audioSource === "system-loopback" ? "SYSTEM" : "MIC";
  $("meter").hidden = !live;
  $("metaSource").hidden = live;
  $("rescan").hidden = live;

  // 02 TRANSCRIBE
  if (live && usage) {
    metaSpans($("metaStt"), [{ text: `${usage.deepgram.sttMinutes.toFixed(1)} MIN` }, { text: usd(usage.deepgram.estCostUsd) }]);
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
  const which = config.output === "obs" ? "obs" : config.output === "both" ? linkChoice : "phone";
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
  $("linkSeg").hidden = config.output !== "both";
  setSeg("linkSeg", linkChoice);
  for (const id of ["copyLink", "openLink"]) ($(id) as HTMLButtonElement).disabled = !showLink;
  ($("rotateLink") as HTMLButtonElement).disabled = !status;
  $("copyLink").classList.toggle("primary", showLink);

  const u = status?.usage;
  $("roStt").textContent = (u?.deepgram.sttMinutes ?? 0).toFixed(1);
  $("roTrn").textContent = String((u?.gemini.count ?? 0) + (u?.gemini.cacheHits ?? 0));
  $("roEst").textContent = usd((u?.deepgram.estCostUsd ?? 0) + (u?.gemini.estCostUsd ?? 0));
  $("roSttWrap").hidden = live;
  $("roTrnWrap").hidden = live || !translationActive();
}

async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    log(`${what} copied`, "ok");
  } catch {
    log(`${what} copy failed`, "err");
  }
}

// ---------------------------------------------------------------------------
// keys & relay view
// ---------------------------------------------------------------------------

function renderKeys(): void {
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
  fieldStatus("dgStatus", inp("deepgramApiKey").value.trim(), keyCheck.deepgram, true);
  fieldStatus("gmStatus", inp("geminiApiKey").value.trim(), keyCheck.gemini, false);
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

async function saveKeys(): Promise<void> {
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
  log("keys & relay saved", "ok");
  setView("stage");
}

// ---------------------------------------------------------------------------
// onboarding (turn 4)
// ---------------------------------------------------------------------------

let obStep: 1 | 2 | 3 = 1;
let obDeepgram: KeyValidation | "checking" | undefined;
let obGemini: KeyValidation | "checking" | undefined;

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
  $("badgesToggle").hidden = true;
  const hasGemini = !!config.geminiApiKey && config.translationEnabled !== false;

  // 01
  if (obStep === 3) {
    $("blkSource").classList.remove("placeholder");
    $("blkSource").classList.add("current");
    obValue("blkSource", sourceLabel(sel("obAudioSource").value || config.audioSource));
    $("sourceKind").textContent = sel("obAudioSource").value === "system-loopback" ? "SYSTEM" : "MIC";
  } else {
    obValue("blkSource", "—");
    $("sourceKind").textContent = "STEP 3";
  }
  // 02
  obValue("blkStt", sttFull(config.stt));
  if (obStep === 1) {
    $("blkStt").classList.remove("placeholder");
    $("blkStt").classList.add("current");
    const v = obDeepgram && obDeepgram !== "checking" && obDeepgram.valid;
    metaSpans($("metaStt"), [v ? { text: "KEY OK" } : { text: "KEY NEEDED", cls: "warn" }]);
  } else {
    $("blkStt").classList.remove("placeholder");
    metaSpans($("metaStt"), [{ text: "KEY OK" }]);
  }
  // 03
  const trMeta = $("metaTranslate");
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
  void trMeta;
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
  $("obStep1").hidden = obStep !== 1;
  $("obStep2").hidden = obStep !== 2;
  $("obStep3").hidden = obStep !== 3;
  if (obStep === 1) {
    $("obStepLabel").textContent = "STEP 1 OF 3 · REQUIRED";
    $("obTitle").textContent = "Relay needs a Deepgram key to hear you.";
    $("obBody").textContent =
      "Deepgram turns your mic or game audio into text. Your key is stored on this PC and never sent anywhere except Deepgram.";
  } else if (obStep === 2) {
    $("obStepLabel").textContent = "STEP 2 OF 3 · OPTIONAL";
    $("obTitle").textContent = "Want captions in another language?";
    $("obBody").textContent =
      "Add a Gemini key and Relay translates each line as it lands. Skip it and viewers get English captions only - you can add it later under KEYS.";
  } else {
    $("obStepLabel").textContent = "STEP 3 OF 3";
    $("obTitle").textContent = "Pick what Relay listens to.";
    $("obBody").textContent = "";
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
  }
  const ok1 = !!(obDeepgram && obDeepgram !== "checking" && obDeepgram.valid);
  ($("obContinue1") as HTMLButtonElement).disabled = !ok1;
  $("obHint1").textContent = ok1 ? "NEXT: TRANSLATION (OPTIONAL)" : "VALIDATES ON PASTE";
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
  keyCheck.deepgram = res;
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
  keyCheck.gemini = res;
  renderObKeyStatus();
}, 500);

async function obGoto(step: 1 | 2 | 3): Promise<void> {
  obStep = step;
  if (step === 3) await refreshDevices();
  renderOnboarding();
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
  $("keysBtn").onclick = () => setView(view === "keys" ? "stage" : "keys");
  $("logBtn").onclick = () => setView(view === "log" ? "stage" : "log");
  $("keysBack").onclick = () => setView("stage");
  $("logBack").onclick = () => setView("stage");

  // chain
  $("rescan").onclick = () => void refreshDevices();
  sel("audioSource").onchange = () => void saveAndApply({ audioSource: sel("audioSource").value }, { restart: true });
  sel("stt").onchange = () => void saveAndApply({ stt: sel("stt").value }, { restart: true });
  sel("translation").onchange = () => void saveAndApply({ translation: sel("translation").value }, { restart: true });
  sel("langSource").onchange = () =>
    void saveAndApply({ languages: { source: sel("langSource").value, target: config.languages.target } }, { restart: true });
  sel("langTarget").onchange = () =>
    void saveAndApply({ languages: { source: config.languages.source, target: sel("langTarget").value } }, { restart: true });
  $("translateToggle").onclick = () => {
    if (session === "live" || session === "starting") return;
    if (!config.geminiApiKey) {
      setView("keys");
      inp("geminiApiKey").focus();
      return;
    }
    void saveAndApply({ translationEnabled: config.translationEnabled === false }, { restart: true });
  };
  $("addKey").onclick = () => {
    if (view === "onboarding") void obGoto(2);
    else {
      setView("keys");
      inp("geminiApiKey").focus();
    }
  };
  $("badgesToggle").onclick = () => {
    if (session === "live" || session === "starting") return;
    void saveAndApply({ showLatency: config.showLatency === false }, { restart: true });
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
  bindSeg("linkModeSeg", () => {});
  $("keysSave").onclick = () => void saveKeys();
  $("checkUpdate").onclick = async () => {
    log("checking for updates…");
    setUpdate(await cr.checkForUpdate());
  };
  $("installUpdate").onclick = () => void cr.installUpdate();
  $("openReleases").onclick = () => void cr.openExternal(update?.releaseUrl || "https://github.com/imbafls/relay_translator/releases/latest");
  $("autoUpdate").onclick = () => void saveAndApply({ autoUpdate: config.autoUpdate === false });
  $("updateChip").onclick = () => {
    if (update?.state === "ready") void cr.installUpdate();
    else setView("keys");
  };
  for (const i of $("keys").querySelectorAll<HTMLInputElement>("input")) {
    i.onkeydown = (e) => {
      if (e.key === "Enter") void saveKeys();
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
  $("obContinue1").onclick = async () => {
    await saveAndApply({ deepgramApiKey: inp("obDeepgramKey").value.trim() });
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
  bindSeg("obOutputSeg", () => renderOnboarding());
  $("obOpenConsole").onclick = async () => {
    const out = (($("obOutputSeg").querySelector("button.active") as HTMLElement | null)?.dataset.value as OutputTarget) || "phone";
    await saveAndApply({ audioSource: sel("obAudioSource").value || config.audioSource, output: out });
    $("translateToggle").hidden = false;
    $("badgesToggle").hidden = false;
    setView("stage");
    log("setup complete - hit START SESSION when ready", "ok");
  };

  // main-process events
  cr.onCommand((cmd) => {
    if (cmd === "start") void startSession({ rotateLink: true });
    else stopSession();
  });
  cr.onConfigChanged((cfg) => {
    if (syncing) return;
    config = cfg;
    syncControlsFromConfig();
  });
  cr.onStatus((s) => {
    status = s;
    renderChain();
    renderFooter();
    if (s.update) setUpdate(s.update);
    if (view === "keys") renderKeyStatuses();
  });

  cr.onUpdate((u) => setUpdate(u));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (view === "keys" || view === "log")) setView("stage");
  });
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  config = await cr.getConfig();
  bind();
  syncControlsFromConfig();
  setInterval(tickClock, 1000);
  setInterval(renderMeter, 100);
  tickClock();
  await refreshDevices();

  if (!config.deepgramApiKey) {
    obStep = 1;
    setView("onboarding");
    log("first run - add a Deepgram key to begin");
  } else {
    setView("stage");
    log("ready - hit START SESSION");
    // silent key checks for the KEY OK readouts
    if (config.deepgramApiKey) void checkKey("deepgram", config.deepgramApiKey);
    if (config.geminiApiKey) void checkKey("gemini", config.geminiApiKey);
  }
}

void boot();
