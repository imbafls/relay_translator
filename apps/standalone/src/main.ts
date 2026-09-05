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
} from "electron";
import * as path from "path";
import * as fs from "fs";
import { ConfigStore, defaultDataDir, startControlServer, UplinkClient } from "@callout-relay/companion";
import { startRelay, RelayHandle, tryLoadDotenv } from "@callout-relay/relay";
import { AppConfig, AudioDeviceInfo, ControlStatus, ServerToViewer, SessionState, UsageInfo } from "@callout-relay/shared";

// dev convenience: pick up DEEPGRAM_API_KEY / GEMINI_API_KEY from repo .env
tryLoadDotenv([path.resolve(__dirname, "..", "..", "..")]);

const APP_VERSION = "0.1.0";
const APP_NAME = "Callout Relay";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let relay: RelayHandle | null = null;
let controlBroadcast: ((status: ControlStatus) => void) | null = null;
let quitting = false;
let uplink: UplinkClient | null = null;
let uplinkState: NonNullable<ControlStatus["relay"]["uplinkState"]> = "off";
let usageCache: UsageInfo | undefined;
let unsubscribeBroadcast: (() => void) | null = null;

const configStore = new ConfigStore(defaultDataDir());

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

function log(level: "info" | "warn" | "error", message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
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

/** OBS / LAN viewer link — always the local embedded relay */
function localViewerUrl(): string | undefined {
  if (!relay) return undefined;
  return relay.viewerUrl(relay.state.viewerToken, true);
}

/** internet viewer link — remote relay, if configured */
function phoneUrl(): string | undefined {
  const cfg = config();
  const token = cfg.viewerToken;
  if (!cfg.relayUrl || !token) return undefined;
  const base = cfg.publicBaseUrl || httpOriginOfRelayUrl(cfg.relayUrl);
  if (!base) return undefined;
  return `${base}/watch/${token}`;
}

/** the link shown front-and-center: internet link when configured, else local */
function viewerUrl(): string | undefined {
  return phoneUrl() || localViewerUrl();
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
    log,
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
      log("info", `uplink: ${uplinkState}${detail ? ` — ${detail}` : ""}`);
      broadcastStatus();
    },
  });
  uplink.connect({
    languages: cfg.languages,
    translates: cfg.translationEnabled !== false,
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
      });
    } else if (msg.type === "status") {
      uplink.sendStatus(msg.live, msg.message);
    } else if (msg.type === "hello" && msg.live) {
      uplink.sendHello({ languages: msg.languages, translates: msg.translates !== false });
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
    },
    devices,
    config: cfg,
    usage: usageCache,
  };
}

function broadcastStatus(): void {
  controlBroadcast?.(currentStatus());
  win?.webContents.send("status:changed", currentStatus());
  refreshTray();
}

/**
 * Config side effects: relay restart when secrets/topology change,
 * renderer notification, control broadcast.
 */
const RELAY_KEYS: (keyof AppConfig)[] = [
  "deepgramApiKey",
  "geminiApiKey",
  "relayPort",
  "relayUrl",
  "publisherToken",
  "viewerToken",
];

async function applyConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const before = config();
  const cfg = configStore.update(patch);
  const relayChanged = RELAY_KEYS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(cfg[k]));
  if (relayChanged) {
    log("info", "relay-affecting config changed, restarting local relay + uplink");
    await restartEmbeddedRelay();
  } else {
    // language/toggle changes flow into a live uplink immediately
    uplink?.connected &&
      uplink.sendHello({
        languages: cfg.languages,
        translates: cfg.translationEnabled !== false,
      });
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
    if (opts.rotate && cfg.linkMode === "unique") await rotateLink();
    const url = publisherWsUrl();
    if (!url) throw new Error("local relay not ready");
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

  ipcMain.handle("link:rotate", async () => {
    await rotateLink();
    return viewerUrl();
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
// control API (consumed by Stream Deck plugin)
// ---------------------------------------------------------------------------

async function startControl(): Promise<void> {
  const handle = await startControlServer({
    getStatus: () => currentStatus(),
    async start() {
      win?.webContents.send("session:command", "start");
    },
    async stop() {
      win?.webContents.send("session:command", "stop");
    },
    async patchConfig(patch) {
      await applyConfig(patch);
      return currentStatus();
    },
    async rotateLink() {
      await rotateLink();
    },
  });
  controlBroadcast = handle.broadcast;
  log("info", `control API on 127.0.0.1:${handle.port}`);
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
    backgroundColor: "#0e1117",
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

function refreshTray(): void {
  if (!tray) return;
  const live = sessionState === "live";
  tray.setToolTip(`${APP_NAME} — ${live ? "live" : sessionState}`);
  tray.setImage(
    live
      ? nativeImage.createFromPath(path.join(__dirname, "..", "assets", "tray-live.png"))
      : trayIcon(),
  );
}

function createTray(): void {
  tray = new Tray(trayIcon());
  tray.setContextMenu(
    Menu.buildFromTemplate([
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
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
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
    await startControl();
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
    stopUplink();
    relay?.close().catch(() => {});
  });

  app.on("window-all-closed", () => {
    // keep running in tray
  });
}
