import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  session,
  desktopCapturer,
  ipcMain,
  powerSaveBlocker,
  shell,
  clipboard,
} from "electron";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { claimHostedRoom, ConfigStore, defaultDataDir, openFileLog, sendFeedback, UplinkClient } from "@callout-relay/companion";
import type { FeedbackPayload } from "@callout-relay/companion";
import { startRelay, RelayHandle, tryLoadDotenv } from "@callout-relay/relay";
import {
  AppConfig,
  AudioDeviceInfo,
  ControlStatus,
  KeyValidation,
  ServerToViewer,
  SessionState,
  HardwareInfo,
  recommendTier,
  UpdateStatus,
  UsageInfo,
  HOSTED_RELAY_URL,
  RELAY_CONFIG_KEYS,
  relayRollbackPatch,
  viewerLinkFor,
} from "@callout-relay/shared";
import { RELEASES_URL, Updater } from "./updater";
import { ModelStore } from "./models";

// dev convenience: pick up DEEPGRAM_API_KEY / GEMINI_API_KEY from repo .env
tryLoadDotenv([path.resolve(__dirname, "..", "..", "..")]);

/**
 * CPU and RAM do not change while the app runs, so the model-tier
 * recommendation is worked out once at startup and rides along with status.
 */
/**
 * The worker runs both as a thread and as the model-load probe, and the probe
 * is a real child process, so it needs a path outside the asar. electron-builder
 * unpacks it (see asarUnpack); fall back to the packed path in dev.
 */
function sttWorkerPath(): string {
  const packed = path.join(__dirname, "localSttWorker.js");
  const unpacked = packed.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return unpacked !== packed && fs.existsSync(unpacked) ? unpacked : packed;
}

const hardware: HardwareInfo = (() => {
  const cpus = os.cpus();
  const threads = cpus.length || 4;
  const ramGb = Math.max(1, Math.round(os.totalmem() / 1024 ** 3));
  return {
    threads,
    cpu: (cpus[0]?.model || "Unknown CPU").replace(/\s+/g, " ").trim(),
    ramGb,
    recommended: recommendTier(threads, ramGb),
  };
})();

const APP_VERSION = app.getVersion();
const APP_NAME = "Callout Relay";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let relay: RelayHandle | null = null;
let quitting = false;
let uplink: UplinkClient | null = null;
let uplinkState: NonNullable<ControlStatus["relay"]["uplinkState"]> = "off";
let usageCache: UsageInfo | undefined;
let unsubscribeBroadcast: (() => void) | null = null;
let updater: Updater | null = null;

const configStore = new ConfigStore(defaultDataDir());
const modelsDir = path.join(defaultDataDir(), "models");
const models = new ModelStore(modelsDir, () => broadcastStatus(), log);

let sessionState: SessionState = "idle";
let sessionError: string | undefined;
let sessionStartedAt: number | undefined;
let devices: AudioDeviceInfo[] = [];
let powerBlockerId: number | null = null;

/** keep the app + audio capture awake while live (no mid-game throttling) */
function setPowerBlock(on: boolean): void {
  if (on && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start("prevent-app-suspension");
  } else if (!on && powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * A packaged Electron app has no console attached, so this used to discard
 * every reason it ever produced. The model store records exactly why a download
 * failed and nobody could read it afterwards - which is why B6 stayed open and
 * unreproducible for days. It goes to a file in the data dir now, next to the
 * config, so a user who hits it has something to send.
 */
const fileLog = openFileLog(defaultDataDir());

function log(level: "info" | "warn" | "error", message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
  fileLog(level, message);
}

function config(): AppConfig {
  return configStore.get();
}

/** ws(s)://host[:port] -> http(s)://host[:port]; keeps TLS intact */
function httpOriginOfRelayUrl(relayUrl: string): string | null {
  const m = relayUrl.match(/^(wss?):\/\/([^/]+)\/?$/i);
  if (!m) return null;
  const scheme = m[1].toLowerCase() === "wss" ? "https" : "http";
  return `${scheme}://${m[2]}`;
}

/**
 * LAN viewer link from the local embedded relay.
 *
 * The `obs` flavour carries `?obs=1` and renders as a transparent single-line
 * overlay. It used to be the only thing this returned, which is how the tray
 * and the tray ended up handing it to people's phones.
 */
function localViewerUrl(obs = true): string | undefined {
  if (!relay) return undefined;
  return relay.viewerUrl(relay.state.viewerToken, obs);
}

/** internet viewer link - remote relay, if configured */
function phoneUrl(): string | undefined {
  const cfg = config();
  const token = cfg.viewerToken;
  if (!cfg.relayUrl || !token) return undefined;
  const base = cfg.publicBaseUrl || httpOriginOfRelayUrl(cfg.relayUrl);
  if (!base) return undefined;
  return `${base}/watch/${token}`;
}

/** the link shown front-and-center (footer, tray): follows the OUTPUT choice */
function viewerUrl(): string | undefined {
  return viewerLinkFor({
    output: config().output,
    obsUrl: localViewerUrl(true),
    plainUrl: localViewerUrl(false),
    remoteUrl: phoneUrl(),
  });
}

function publisherWsUrl(): string | undefined {
  // local-first: the publisher always streams to the embedded relay
  if (!relay) return undefined;
  return `ws://127.0.0.1:${relay.port}/ws/publisher?token=${encodeURIComponent(relay.state.publisherToken)}`;
}

async function startEmbeddedRelay(): Promise<void> {
  const cfg = config();
  if (relay) return;
  relay = await startRelay({
    port: cfg.relayPort,
    dataDir: defaultDataDir(),
    deepgramApiKey: cfg.deepgramApiKey,
    geminiApiKey: cfg.geminiApiKey,
    // the worker is bundled next to main.js (see build.mjs)
    localStt: { modelsDir, workerPath: sttWorkerPath() },
    // Fix-round Finding 6 (Task 5): without this a user's setting did
    // nothing - every session got the shared 60-minute default regardless
    // of what AppConfig.idleBillingStopMinutes said
    idleBillingStopMinutes: cfg.idleBillingStopMinutes,
    log,
    onViewers: () => broadcastStatus(),
  });
  log("info", `local relay up on :${relay.port}`);
  startUplink();
  bridgeBroadcasts();
  void refreshUsage();
}

async function restartEmbeddedRelay(): Promise<void> {
  if (relay) {
    await relay.close();
    relay = null;
  }
  await startEmbeddedRelay();
}

// ---------------------------------------------------------------------------
// uplink: mirror local subtitles to the remote relay (phone viewers)
// ---------------------------------------------------------------------------

function startUplink(): void {
  const cfg = config();
  stopUplink();
  if (!cfg.relayUrl || !cfg.publisherToken || !relay) {
    uplinkState = "off";
    return;
  }
  const url = `${cfg.relayUrl}/ws/uplink?token=${encodeURIComponent(cfg.publisherToken)}`;
  uplink = new UplinkClient(url, {
    onState: (state, detail) => {
      uplinkState = state === "idle" ? "off" : state;
      log("info", `uplink: ${uplinkState}${detail ? ` - ${detail}` : ""}`);
      broadcastStatus();
    },
    onStats: () => broadcastStatus(),
    // open()'s automatic reconnect resends its cached hello, which can be
    // stale by the time the socket actually reopens - a session that starts
    // while the uplink is mid-backoff would otherwise report OFF AIR on
    // reconnect. sessionStartedAt is read fresh on every open, not just the
    // one this closure captured at boot.
    live: () => sessionStartedAt !== undefined,
  });
  uplink.connect({
    languages: cfg.languages,
    translates: translationActive(cfg),
    since: sessionStartedAt,
    // startUplink() runs at app boot, not at session start - without this the
    // hosted room reads the hello alone as the liveness signal and shows ON
    // AIR to anyone holding the link while the app merely sits in the tray
    live: sessionStartedAt !== undefined,
    brandName: cfg.brandName,
    brandColor: cfg.brandColor,
  });
  void syncRemoteViewerToken();
}

/**
 * Pull the remote relay's current viewer token so the phone link is right even
 * when we never rotate (fixed link mode, fresh install, stale token from 0.1).
 */
async function syncRemoteViewerToken(): Promise<void> {
  const cfg = config();
  if (!cfg.relayUrl || !cfg.publisherToken) return;
  const origin = httpOriginOfRelayUrl(cfg.relayUrl);
  if (!origin) return;
  try {
    const res = await fetch(`${origin}/admin/viewer-token`, {
      headers: { Authorization: `Bearer ${cfg.publisherToken}` },
    });
    if (!res.ok) {
      log("warn", `remote viewer-token sync failed: HTTP ${res.status}`);
      return;
    }
    const { viewerToken } = (await res.json()) as { viewerToken?: string };
    if (viewerToken && viewerToken !== cfg.viewerToken) {
      configStore.update({ viewerToken });
      log("info", "remote viewer token synced");
      broadcastStatus();
    }
  } catch (err) {
    log("warn", `remote viewer-token sync failed: ${String(err)}`);
  }
}

function stopUplink(): void {
  if (uplink) {
    uplink.disconnect();
    uplink = null;
  }
  uplinkState = "off";
}

function bridgeBroadcasts(): void {
  if (unsubscribeBroadcast) unsubscribeBroadcast();
  unsubscribeBroadcast = null;
  if (!relay) return;
  unsubscribeBroadcast = relay.onBroadcast((msg: ServerToViewer) => {
    if (!uplink || !uplink.connected) return;
    if (msg.type === "subtitle") {
      uplink.sendSubtitle({
        type: "subtitle",
        id: msg.id,
        source: msg.source,
        target: msg.target,
        final: msg.final,
        latency: msg.latency,
        channel: msg.channel,
        speaker: msg.speaker,
        // see the same note in relay/src/server.ts: this is `& SpeakerTag` and
        // leaving `color` out is legal, silent, and invisible on the LAN
        color: msg.color,
      });
    } else if (msg.type === "status") {
      uplink.sendStatus(msg.live, msg.message, msg.since);
    } else if (msg.type === "hello" && msg.live) {
      uplink.sendHello({
        languages: msg.languages,
        translates: msg.translates !== false,
        since: msg.since,
        // this branch is already gated on `msg.live`, so this is always true;
        // named explicitly (not hardcoded) so the guard in speakerTag.test.ts
        // can see this hop carries the field at all
        live: msg.live,
        // see the same note above for `color`: this hop forwards the relay's
        // own live hello, so the brand comes from `msg`, not `cfg` - the
        // uplink's own connect/config-driven hellos already source it there
        brandName: msg.brandName,
        brandColor: msg.brandColor,
      });
    }
  });
}

async function refreshUsage(): Promise<void> {
  if (!relay) return;
  try {
    usageCache = await relay.getUsage();
    broadcastStatus();
  } catch {
    /* keep last */
  }
}

/** translation runs only when enabled AND a Gemini key exists (onboarding may skip it) */
function translationActive(cfg: AppConfig): boolean {
  return cfg.translationEnabled !== false && !!cfg.geminiApiKey;
}

/**
 * Cheap provider round-trips used by onboarding / the keys view.
 * Deepgram: list projects (+ balance when the account exposes it).
 * Gemini: list models. Never throws - returns {valid:false, detail}.
 */
async function validateKey(provider: "deepgram" | "gemini", key: string): Promise<KeyValidation> {
  if (!key) return { valid: false, detail: "empty" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    if (provider === "deepgram") {
      const res = await fetch("https://api.deepgram.com/v1/projects", {
        headers: { Authorization: `Token ${key}` },
        signal: ctl.signal,
      });
      if (res.status === 401 || res.status === 403) return { valid: false, detail: "key rejected" };
      if (!res.ok) return { valid: false, detail: `deepgram http ${res.status}` };
      const data = (await res.json()) as { projects?: { project_id?: string }[] };
      const projectId = data?.projects?.[0]?.project_id;
      let creditUsd: number | undefined;
      if (projectId) {
        try {
          const bal = await fetch(`https://api.deepgram.com/v1/projects/${projectId}/balances`, {
            headers: { Authorization: `Token ${key}` },
            signal: ctl.signal,
          });
          if (bal.ok) {
            const b = (await bal.json()) as { balances?: { amount?: number }[] };
            const total = (b?.balances || []).reduce((sum, x) => sum + (Number(x?.amount) || 0), 0);
            if (Number.isFinite(total) && total > 0) creditUsd = total;
          }
        } catch {
          /* balance is optional */
        }
      }
      return { valid: true, creditUsd };
    }
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}`,
      { signal: ctl.signal },
    );
    if (res.ok) return { valid: true };
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { valid: false, detail: "key rejected" };
    }
    return { valid: false, detail: `gemini http ${res.status}` };
  } catch (err) {
    return { valid: false, detail: ctl.signal.aborted ? "timed out" : "no connection" };
  } finally {
    clearTimeout(timer);
  }
}

async function rotateLink(): Promise<string | undefined> {
  // rotate both the local (OBS/LAN) link and the remote (phone) link
  if (relay) relay.rotateViewerToken();
  const cfg = config();
  const origin = cfg.relayUrl ? httpOriginOfRelayUrl(cfg.relayUrl) : null;
  if (origin && cfg.publisherToken) {
    try {
      const res = await fetch(`${origin}/admin/rotate-viewer-token`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.publisherToken}` },
      });
      if (res.ok) {
        const token = ((await res.json()) as { viewerToken: string }).viewerToken;
        configStore.update({ viewerToken: token });
      }
    } catch (err) {
      log("error", `remote rotate failed: ${String(err)}`);
    }
  }
  broadcastStatus();
  return viewerUrl();
}

function currentStatus() {
  const cfg = config();
  return {
    companion: { version: APP_VERSION },
    session: {
      state: sessionState,
      error: sessionError,
      startedAt: sessionStartedAt,
    },
    relay: {
      mode: "embedded" as const,
      url: `ws://127.0.0.1:${relay?.port || cfg.relayPort || 8787}`,
      viewerUrl: viewerUrl(),
      localViewerUrl: localViewerUrl(),
      remoteViewerUrl: phoneUrl(),
      uplinkState: uplinkState,
      uplinkRttMs: uplink?.rttMs,
      // absent while the embedded relay is not up (startup/restart) rather than
      // false - false would read as "speech is down" to a topbar that has not
      // even connected to a session yet
      sttLive: relay?.sttLive(),
      viewers: relay?.viewerCount() ?? 0,
      remoteViewers: uplink?.remoteViewers ?? 0,
    },
    devices,
    config: cfg,
    usage: usageCache,
    update: updater?.current,
    localModels: models.status(),
    hardware,
  };
}

function broadcastStatus(): void {
  const status = currentStatus();
  win?.webContents.send("status:changed", status);
  refreshTray();
}

/**
 * Config side effects: relay restart when secrets/topology change,
 * renderer notification, control broadcast.
 */
const RELAY_KEYS: (keyof AppConfig)[] = [...RELAY_CONFIG_KEYS];

async function applyConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const before = config();
  const cfg = configStore.update(patch);
  const relayChanged = RELAY_KEYS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(cfg[k]));
  if (relayChanged) {
    log("info", "relay-affecting config changed, restarting local relay + uplink");
    try {
      await restartEmbeddedRelay();
    } catch (err) {
      // The write above already happened - configStore.update is synchronous
      // and runs before this - so a port that cannot be bound is now the SAVED
      // port. Without putting it back, every START fails with "local relay not
      // ready" and a relaunch re-reads the same bad value and fails the same
      // way. The app is dead, permanently, from one typo.
      const reason = String((err as Error)?.message || err);
      log("error", `relay restart failed (${reason}) - putting the previous relay settings back`);
      configStore.update(relayRollbackPatch(before, cfg));
      try {
        await restartEmbeddedRelay();
        log("info", "previous relay settings restored and the relay is up again");
      } catch (again) {
        log("error", `could not restart on the previous settings either: ${String((again as Error)?.message || again)}`);
      }
      win?.webContents.send("config:changed", config());
      broadcastStatus();
      throw new Error(`relay could not restart: ${reason}`);
    }
  } else {
    // language/toggle changes flow into a live uplink immediately
    uplink?.connected &&
      uplink.sendHello({
        languages: cfg.languages,
        translates: translationActive(cfg),
        since: sessionStartedAt,
        // same reasoning as startUplink()'s connect() above: a settings change
        // while idle must not read as "back on air" to anyone holding the link
        live: sessionStartedAt !== undefined,
        brandName: cfg.brandName,
        brandColor: cfg.brandColor,
      });
  }
  if (before.autoUpdate !== cfg.autoUpdate || before.updateFeedUrl !== cfg.updateFeedUrl) {
    updater?.start();
  }
  win?.webContents.send("config:changed", cfg);
  broadcastStatus();
  return cfg;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle("config:get", () => config());
  ipcMain.handle("config:set", (_e, patch: Partial<AppConfig>) => applyConfig(patch || {}));

  // renderer asks for fresh session runtime info; rotates the viewer link
  // when entering a new session in "unique" mode
  ipcMain.handle("runtime:prepare", async (_e, opts: { rotate?: boolean } = {}) => {
    const cfg = config();
    // The relay check comes FIRST. Rotating before it meant every failed START
    // in the default link mode still minted a new viewer token, persisted it,
    // and kicked everyone on the phone link - three presses while the port was
    // busy invalidated the link three times, with only "start failed" on
    // screen. Nothing about a session that cannot start should spend the link.
    const url = publisherWsUrl();
    if (!url) throw new Error("local relay not ready");
    if (opts.rotate && cfg.linkMode === "unique") await rotateLink();
    return {
      publisherUrl: url,
      viewerUrl: viewerUrl(),
      obsUrl: localViewerUrl(),
      phoneUrl: phoneUrl(),
      config: config(),
    };
  });

  ipcMain.handle("open-external", (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  // navigator.clipboard.writeText needs the "clipboard-sanitized-write"
  // permission, and the handler above denies everything but media - so COPY
  // LINK failed silently for every user. Electron's own clipboard writes to
  // the OS directly: no permission, and no focused-document requirement.
  ipcMain.handle("clipboard:write", (_e, text: string) => {
    clipboard.writeText(String(text ?? ""));
  });

  // the renderer compares this against config.lastSeenVersion to decide whether
  // an auto-update has happened since the last run
  ipcMain.handle("app:version", () => app.getVersion());

  ipcMain.handle("updates:check", async (): Promise<UpdateStatus | undefined> => {
    if (!updater) return undefined;
    return updater.check(true);
  });

  ipcMain.handle("updates:install", (): boolean => {
    if (!updater) return false;
    // a live session would be cut off mid-sentence; stop capture first
    if (sessionState === "live" || sessionState === "starting") {
      win?.webContents.send("session:command", "stop");
    }
    return updater.install();
  });

  ipcMain.handle(
    "keys:validate",
    (_e, req: { provider: "deepgram" | "gemini"; key: string }): Promise<KeyValidation> =>
      validateKey(req?.provider, String(req?.key || "")),
  );

  /**
   * Claim a room on the hosted relay and store it, so a user who wants to send
   * someone a link never has to know what a publish token is. This was a curl
   * command in a README - nothing in the app called /claim at all - which meant
   * the one thing the hosted relay exists for was reachable only by people who
   * read the source.
   *
   * Returns a result rather than throwing: this sits behind a button, and the
   * renderer needs a sentence to put on screen when it does not work.
   */
  ipcMain.handle("relay:claim", async (_e, relayUrl?: string) => {
    const url = (relayUrl || "").trim() || HOSTED_RELAY_URL;
    try {
      const patch = await claimHostedRoom(url);
      await applyConfig(patch);
      log("info", `claimed a room on ${url}`);
      return { ok: true as const };
    } catch (err) {
      const message = String((err as Error)?.message || err);
      log("error", `could not claim a room: ${message}`);
      return { ok: false as const, message };
    }
  });

  ipcMain.handle("link:rotate", async () => {
    await rotateLink();
    return viewerUrl();
  });

  /**
   * SEND FEEDBACK, read half: relay.log's raw text, unredacted. The renderer
   * runs redactLog on the result before it is ever shown, and that redacted
   * string - not a fresh read of this - is what "feedback:send" below
   * forwards. Never throws: a missing file (nothing has been logged yet) or a
   * locked one is "no log", not a broken feature.
   */
  ipcMain.handle("log:read", (): string => {
    try {
      return fs.readFileSync(path.join(defaultDataDir(), "relay.log"), "utf8");
    } catch {
      return "";
    }
  });

  /**
   * SEND FEEDBACK, send half. This used to be a `fetch()` in the renderer,
   * which cannot work: the renderer's origin is `file://` (opaque) and
   * `apps/hosted-relay` answers no `Access-Control-*` headers on any route,
   * so Chromium's CORS preflight for the JSON POST has nothing to succeed
   * against - verified against the live deploy. Node's `fetch` has no origin,
   * so it is not subject to CORS at all; that is also why `claimHostedRoom`
   * just above lives here rather than in the renderer.
   *
   * `sendFeedback` (packages/companion) always targets the hosted relay's own
   * `/feedback` route - it takes no address, so there is nothing here that
   * could route it through a self-hosted relay or widen it into something a
   * web page could POST to. The payload is exactly what the renderer built
   * and already redacted; this only forwards it.
   */
  ipcMain.handle("feedback:send", (_e, payload: FeedbackPayload) => {
    const message = String(payload?.message || "");
    const appVersion = String(payload?.appVersion || "");
    const log = typeof payload?.log === "string" ? payload.log : undefined;
    return sendFeedback(log === undefined ? { message, appVersion } : { message, appVersion, log });
  });

  // local STT models: status is part of every status broadcast; downloads
  // run in the background and report progress the same way
  ipcMain.handle("models:status", () => models.status());
  ipcMain.handle("models:download", (_e, id: string) => {
    void models.download(String(id || ""));
    return models.status();
  });
  ipcMain.handle("models:cancel", (_e, id: string) => {
    models.cancel(String(id || ""));
    return models.status();
  });
  ipcMain.handle("models:remove", (_e, id: string) => {
    models.remove(String(id || ""));
    return models.status();
  });

  ipcMain.on("session:update", (_e, update: { state: SessionState; error?: string }) => {
    sessionState = update.state;
    sessionError = update.error;
    sessionStartedAt = update.state === "live" ? Date.now() : undefined;
    setPowerBlock(update.state === "live" || update.state === "starting");
    broadcastStatus();
    void refreshUsage();
  });

  ipcMain.on("devices:update", (_e, list: AudioDeviceInfo[]) => {
    devices = list || [];
    broadcastStatus();
  });
}

// ---------------------------------------------------------------------------
// window + tray
// ---------------------------------------------------------------------------

function createWindow(): void {
  win = new BrowserWindow({
    width: 980,
    height: 800,
    minWidth: 720,
    title: APP_NAME,
    autoHideMenuBar: true,
    backgroundColor: "#131313",
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // closing the window hides to tray so capture keeps running mid-game
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
}

function trayIcon(): Electron.NativeImage {
  const file = path.join(__dirname, "..", "assets", "tray.png");
  if (fs.existsSync(file)) return nativeImage.createFromPath(file);
  return nativeImage.createEmpty();
}

let trayUpdateLabel = "";
function refreshTray(): void {
  if (!tray) return;
  const live = sessionState === "live";
  // the update entry changes text as it downloads, so rebuild when it moves
  const label = updateTrayLabel();
  if (label !== trayUpdateLabel) {
    trayUpdateLabel = label;
    tray.setContextMenu(buildTrayMenu());
  }
  // same strict `=== false` shape as the topbar: undefined (startup/restart,
  // before `relay` is assigned, or a remote relay that never reports this)
  // must read as "live", not "dead"
  const noSpeech = live && relay?.sttLive() === false;
  tray.setToolTip(`${APP_NAME} - ${noSpeech ? "live, no speech" : live ? "live" : sessionState}`);
  tray.setImage(
    live
      ? nativeImage.createFromPath(path.join(__dirname, "..", "assets", "tray-live.png"))
      : trayIcon(),
  );
}

function updateTrayLabel(): string {
  const st = updater?.current;
  if (st?.state === "ready") return `Restart to update to ${st.latest}`;
  if (st?.state === "downloading") return `Downloading update… ${st.percent ?? 0}%`;
  if (st?.state === "unsupported") return "Download the latest version";
  return "Check for updates";
}

function buildTrayMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
      { label: "Show Callout Relay", click: () => win?.show() },
      { type: "separator" },
      {
        label: "Start session",
        click: () => win?.webContents.send("session:command", "start"),
      },
      {
        label: "Stop session",
        click: () => win?.webContents.send("session:command", "stop"),
      },
      {
        label: "Rotate viewer link",
        click: async () => {
          await rotateLink();
          if (viewerUrl()) shell.openExternal(viewerUrl()!);
        },
      },
      { type: "separator" },
      {
        label: "Run setup again",
        click: () => {
          win?.show();
          win?.webContents.send("session:command", "setup");
        },
      },
      {
        label: updateTrayLabel(),
        click: () => {
          if (updater?.current.state === "ready") updater.install();
          else if (updater?.current.state === "unsupported") shell.openExternal(RELEASES_URL);
          else void updater?.check(true);
        },
      },
    {
      label: "Quit",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray(): void {
  tray = new Tray(trayIcon());
  tray.setContextMenu(buildTrayMenu());
  refreshTray();
}

// ---------------------------------------------------------------------------
// app lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => win?.show());

  app.whenReady().then(async () => {
    // auto-approve system loopback capture (Windows)
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        desktopCapturer
          .getSources({ types: ["screen"] })
          .then((sources) => {
            if (sources.length === 0) {
              callback({} as never);
              return;
            }
            // video track is discarded by the capture layer; audio comes from loopback
            callback({ video: sources[0], audio: "loopback" } as never);
          })
          .catch(() => callback({} as never));
      },
      { useSystemPicker: false },
    );

    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === "media");
    });

    registerIpc();
    try {
      await startEmbeddedRelay();
    } catch (err) {
      log("error", `embedded relay failed: ${String(err)}`);
    }
    // usage refresh loop (Deepgram balance cached inside the relay for 5 min)
    setInterval(() => void refreshUsage(), 60000);
    updater = new Updater({
      config,
      log,
      onChange: (status) => {
        win?.webContents.send("update:changed", status);
        broadcastStatus();
      },
    });
    updater.start();
    createTray();
    createWindow();

    // deliver fresh runtime info once the renderer finishes loading
    win?.webContents.on("did-finish-load", () => {
      win?.webContents.send("config:changed", config());
    });
  });

  app.on("before-quit", () => {
    quitting = true;
    setPowerBlock(false);
    updater?.stop();
    stopUplink();
    relay?.close().catch(() => {});
  });

  app.on("window-all-closed", () => {
    // keep running in tray
  });
}
