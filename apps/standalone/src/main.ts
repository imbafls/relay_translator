import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  session,
  desktopCapturer,
  ipcMain,
  shell,
} from "electron";
import * as path from "path";
import * as fs from "fs";
import { ConfigStore, defaultDataDir, startControlServer } from "@callout-relay/companion";
import { startRelay, RelayHandle, tryLoadDotenv } from "@callout-relay/relay";
import { AppConfig, AudioDeviceInfo, ControlStatus, SessionState } from "@callout-relay/shared";

// dev convenience: pick up DEEPGRAM_API_KEY / GEMINI_API_KEY from repo .env
tryLoadDotenv([path.resolve(__dirname, "..", "..", "..")]);

const APP_VERSION = "0.1.0";
const APP_NAME = "Callout Relay";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let relay: RelayHandle | null = null;
let controlBroadcast: ((status: ControlStatus) => void) | null = null;
let quitting = false;

const configStore = new ConfigStore(defaultDataDir());

let sessionState: SessionState = "idle";
let sessionError: string | undefined;
let sessionStartedAt: number | undefined;
let devices: AudioDeviceInfo[] = [];

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

function httpOriginOfRelayUrl(relayUrl: string): string | null {
  const m = relayUrl.match(/^wss?:\/\/([^/]+)$/i);
  return m ? `http://${m[1]}` : null;
}

function viewerUrl(): string | undefined {
  const cfg = config();
  const token = relay ? relay.state.viewerToken : cfg.viewerToken;
  if (!token) return undefined;
  const base =
    cfg.publicBaseUrl ||
    (cfg.relayUrl ? httpOriginOfRelayUrl(cfg.relayUrl) : undefined) ||
    (relay ? relay.origin : `http://127.0.0.1:${cfg.relayPort || 8787}`);
  const suffix = cfg.obsOverlay ? "?obs=1" : "";
  return `${base}/watch/${token}${suffix}`;
}

function publisherWsUrl(): string | undefined {
  const cfg = config();
  if (cfg.relayUrl) {
    if (!cfg.publisherToken) return undefined;
    return `${cfg.relayUrl.replace(/^http/i, "ws")}/ws/publisher?token=${encodeURIComponent(cfg.publisherToken)}`;
  }
  if (!relay) return undefined;
  return `ws://127.0.0.1:${relay.port}/ws/publisher?token=${encodeURIComponent(relay.state.publisherToken)}`;
}

async function startEmbeddedRelay(): Promise<void> {
  const cfg = config();
  if (cfg.relayUrl) return; // remote mode
  if (relay) return;
  relay = await startRelay({
    port: cfg.relayPort,
    dataDir: defaultDataDir(),
    deepgramApiKey: cfg.deepgramApiKey,
    geminiApiKey: cfg.geminiApiKey,
    publisherToken: cfg.publisherToken,
    viewerToken: cfg.viewerToken,
    log,
  });
  // persist tokens so "fixed" link mode survives restarts
  configStore.update({ publisherToken: relay.state.publisherToken, viewerToken: relay.state.viewerToken });
  log("info", `embedded relay up on :${relay.port}`);
}

async function restartEmbeddedRelay(): Promise<void> {
  if (relay) {
    await relay.close();
    relay = null;
  }
  await startEmbeddedRelay();
}

async function rotateLink(): Promise<string | undefined> {
  const cfg = config();
  let token: string | undefined;
  if (relay) {
    token = relay.rotateViewerToken();
  } else if (cfg.relayUrl && cfg.publisherToken) {
    try {
      const res = await fetch(`${cfg.relayUrl.replace(/^ws/i, "http")}/admin/rotate-viewer-token`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.publisherToken}` },
      });
      if (res.ok) token = ((await res.json()) as { viewerToken: string }).viewerToken;
    } catch (err) {
      log("error", `remote rotate failed: ${String(err)}`);
    }
  }
  if (token) {
    configStore.update({ viewerToken: token });
    broadcastStatus();
  }
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
      mode: cfg.relayUrl ? ("remote" as const) : ("embedded" as const),
      url: cfg.relayUrl || `ws://127.0.0.1:${relay?.port || cfg.relayPort || 8787}`,
      viewerUrl: viewerUrl(),
    },
    devices,
    config: cfg,
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
    log("info", "relay-affecting config changed, restarting embedded relay");
    await restartEmbeddedRelay();
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
    if (!url) throw new Error("relay not ready (check keys / relay settings)");
    return { publisherUrl: url, viewerUrl: viewerUrl(), config: config() };
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
    broadcastStatus();
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
    relay?.close().catch(() => {});
  });

  app.on("window-all-closed", () => {
    // keep running in tray
  });
}
