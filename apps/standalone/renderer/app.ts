import { BrowserAudioCapture, RelayPublisherClient } from "@callout-relay/companion";
import {
  AppConfig,
  LANGUAGES,
  SessionState,
  STT_MODELS,
  TRANSLATION_MODELS,
} from "@callout-relay/shared";
import type { RendererBridge } from "../src/preload";

declare global {
  interface Window {
    cr: RendererBridge;
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;
const inp = (id: string): HTMLInputElement => $(id);
const selectEl = (id: string): HTMLSelectElement => $(id);

const cr = window.cr;
const capture = new BrowserAudioCapture();

let config: AppConfig;
let relayClient: RelayPublisherClient | null = null;
const state: { session: SessionState } = { session: "idle" };
let syncing = false;

// ---------------------------------------------------------------------------
// logging + status
// ---------------------------------------------------------------------------

function log(message: string, cls: "" | "err" | "ok" = ""): void {
  const el = document.createElement("div");
  if (cls) el.className = cls;
  const t = new Date().toLocaleTimeString();
  el.textContent = `[${t}] ${message}`;
  const box = $("log");
  box.appendChild(el);
  while (box.children.length > 250) box.firstChild?.remove();
  box.scrollTop = box.scrollHeight;
}

function logSubtitle(seg: { id: number; source: string; target?: string }): void {
  const t = new Date().toLocaleTimeString();
  const box = $("log");
  const en = document.createElement("div");
  en.className = "sub-en";
  en.textContent = `[${t}] ▸ ${seg.source}`;
  box.appendChild(en);
  if (seg.target != null) {
    const vi = document.createElement("div");
    vi.className = "sub-vi";
    vi.textContent = `    ${seg.target}`;
    box.appendChild(vi);
  }
  while (box.children.length > 250) box.firstChild?.remove();
  box.scrollTop = box.scrollHeight;
}

function setState(next: SessionState, error?: string): void {
  state.session = next;
  cr.reportState(next, error);
  const badge = $("sessionState");
  badge.textContent = next;
  badge.className = `session-state ${next}`;

  const btn = $("startStop");
  btn.textContent = next === "live" || next === "starting" ? "Stop session" : "Start session";
  btn.classList.toggle("stop", next === "live" || next === "starting");

  const errBox = $("errorBox");
  if (error) {
    errBox.textContent = error;
    errBox.classList.remove("hidden");
  } else {
    errBox.classList.add("hidden");
  }
}

// ---------------------------------------------------------------------------
// session control
// ---------------------------------------------------------------------------

async function startSession(opts: { rotateLink: boolean }): Promise<void> {
  if (state.session === "live" || state.session === "starting") return;
  setState("starting");
  try {
    const prep = await cr.prepareSession({ rotate: opts.rotateLink });
    config = prep.config;
    if (!config.deepgramApiKey || !config.geminiApiKey) {
      throw new Error(
        "Add your Deepgram and Gemini API keys first — open Settings (API keys & relay) below.",
      );
    }
    inp("viewerUrl").value = prep.viewerUrl || "";

    relayClient = new RelayPublisherClient(prep.publisherUrl, {
      onState: (clientState, detail) => {
        log(
          `relay: ${clientState}${detail ? ` — ${detail}` : ""}`,
          clientState === "connected" ? "ok" : "",
        );
        recomputeState();
      },
      onError: (msg) => log(`relay error: ${msg}`, "err"),
      onSubtitle: (seg) => logSubtitle(seg),
    });
    relayClient.connect({
      stt: config.stt,
      translation: config.translation,
      languages: config.languages,
    });

    await capture.start(config.audioSource, (chunk) => relayClient?.sendAudio(chunk.buffer));
    log(`capture started: ${sourceLabel(config.audioSource)}`, "ok");
    recomputeState();
  } catch (err) {
    const message = String((err as Error).message || err);
    log(`start failed: ${message}`, "err");
    setState("error", message);
    stopSession();
  }
}

function stopSession(): void {
  if (state.session === "idle") return;
  capture.stop();
  relayClient?.disconnect();
  relayClient = null;
  setState("idle");
  log("session stopped");
}

function recomputeState(): void {
  const relayUp = relayClient?.state === "connected";
  if (relayUp && capture.capturing) setState("live");
  else if (state.session === "starting") setState("starting");
}

function sourceLabel(id: string): string {
  const opt = selectEl("audioSource").querySelector<HTMLOptionElement>(
    `option[value="${CSS.escape(id)}"]`,
  );
  return opt?.textContent || id;
}

/** live settings changes bounce the session without rotating the link */
async function restartIfLive(): Promise<void> {
  if (state.session === "idle") return;
  log("applying settings — restarting session…");
  stopSession();
  await startSession({ rotateLink: false });
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

function fillSelect(
  box: HTMLSelectElement,
  entries: { value: string; label: string }[],
  value: string,
): void {
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
  fillSelect(
    selectEl("audioSource"),
    devices.map((d) => ({ value: d.id, label: d.label })),
    config.audioSource,
  );
  cr.reportDevices(devices);
}

function syncControlsFromConfig(): void {
  syncing = true;
  fillSelect(
    selectEl("stt"),
    STT_MODELS.map((m) => ({ value: m.id, label: m.label })),
    config.stt,
  );
  fillSelect(
    selectEl("translation"),
    TRANSLATION_MODELS.map((m) => ({ value: m.id, label: m.label })),
    config.translation,
  );
  fillSelect(
    selectEl("langSource"),
    LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
    config.languages.source,
  );
  fillSelect(
    selectEl("langTarget"),
    LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
    config.languages.target,
  );
  fillSelect(
    selectEl("linkMode"),
    [
      { value: "unique", label: "unique — new link each session" },
      { value: "fixed", label: "fixed — stable link" },
    ],
    config.linkMode,
  );
  inp("obsOverlay").checked = !!config.obsOverlay;
  inp("deepgramApiKey").value = config.deepgramApiKey || "";
  inp("geminiApiKey").value = config.geminiApiKey || "";
  inp("relayUrl").value = config.relayUrl || "";
  inp("relayPort").value = String(config.relayPort || 8787);
  inp("publicBaseUrl").value = config.publicBaseUrl || "";
  syncing = false;
}

function configPatchFromControls(): Partial<AppConfig> {
  return {
    stt: selectEl("stt").value,
    translation: selectEl("translation").value,
    languages: { source: selectEl("langSource").value, target: selectEl("langTarget").value },
    linkMode: selectEl("linkMode").value as AppConfig["linkMode"],
    obsOverlay: inp("obsOverlay").checked,
  };
}

async function saveAndApply(
  patch: Partial<AppConfig>,
  opts: { restart?: boolean } = {},
): Promise<void> {
  try {
    config = await cr.setConfig(patch);
    syncControlsFromConfig();
    await refreshDevices();
    if (opts.restart) await restartIfLive();
  } catch (err) {
    log(`config save failed: ${String(err)}`, "err");
  }
}

async function copyViewerLink(): Promise<void> {
  const url = inp("viewerUrl").value;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    log("link copied", "ok");
  } catch {
    const input = inp("viewerUrl");
    input.select();
    document.execCommand("copy");
    log("link copied (fallback)", "ok");
  }
}

function bind(): void {
  $("startStop").onclick = () => {
    if (state.session === "live" || state.session === "starting") stopSession();
    else void startSession({ rotateLink: true });
  };
  $("copyLink").onclick = () => void copyViewerLink();
  $("openLink").onclick = () => {
    const url = inp("viewerUrl").value;
    if (url) void cr.openExternal(url);
  };
  $("rotateLink").onclick = async () => {
    const url = await cr.rotateLink();
    if (url) inp("viewerUrl").value = url;
    log("viewer link rotated — old link is dead", "ok");
  };
  $("refreshDevices").onclick = () => void refreshDevices();

  for (const id of ["stt", "translation", "langSource", "langTarget", "linkMode"] as const) {
    selectEl(id).onchange = () => void saveAndApply(configPatchFromControls(), { restart: true });
  }
  inp("obsOverlay").onchange = () => void saveAndApply({ obsOverlay: inp("obsOverlay").checked });

  inp("relayUrl").onchange = () =>
    void saveAndApply(
      {
        relayUrl: inp("relayUrl").value.trim() || undefined,
        publicBaseUrl: inp("publicBaseUrl").value.trim() || undefined,
      },
      { restart: true },
    );
  inp("relayPort").onchange = () =>
    void saveAndApply({ relayPort: Number(inp("relayPort").value) || 8787 });
  for (const id of ["deepgramApiKey", "geminiApiKey"] as const) {
    inp(id).onchange = () => void saveAndApply({ [id]: inp(id).value.trim() || undefined });
  }
  inp("publicBaseUrl").onchange = () =>
    void saveAndApply({ publicBaseUrl: inp("publicBaseUrl").value.trim() || undefined });

  cr.onCommand((cmd: "start" | "stop") => {
    if (cmd === "start") void startSession({ rotateLink: true });
    else stopSession();
  });

  cr.onConfigChanged((cfg: AppConfig) => {
    if (syncing) return;
    config = cfg;
    syncControlsFromConfig();
  });
}

async function boot(): Promise<void> {
  config = await cr.getConfig();
  syncControlsFromConfig();
  bind();
  await refreshDevices();
  log("ready — pick an audio source and hit Start");
}

void boot();
