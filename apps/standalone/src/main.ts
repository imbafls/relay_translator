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
  dialog,
} from "electron";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  claimHostedRoom,
  ConfigStore,
  defaultDataDir,
  forwardsToUplink,
  openFileLog,
  sendFeedback,
  UplinkClient,
} from "@callout-relay/companion";
import type { FeedbackPayload } from "@callout-relay/companion";
import { startRelay, RelayHandle, tryLoadDotenv } from "@callout-relay/relay";
import {
  AppConfig,
  AudioDeviceInfo,
  ControlStatus,
  KeyValidation,
  LinkRotation,
  ServerToViewer,
  SessionState,
  HardwareInfo,
  recommendTier,
  UpdateStatus,
  UsageInfo,
  HOSTED_RELAY_URL,
  RELAY_CONFIG_KEYS,
  redactLog,
  rotationNotice,
  validPublicBaseUrl,
  uplinkUrlFor,
  validTranscriptDir,
  viewerLinkFor,
} from "@callout-relay/shared";
import { RELEASES_URL, Updater } from "./updater";
import { rotateLinks, trayOpensLink } from "./linkRotation";
import { restartAfterConfigChange } from "./relayRestart";
import type { RendererBridge } from "./preload";

/**
 * What the renderer receives from a bridge method. `ipcMain.handle` takes and
 * returns `any`, so without this nothing ties a handler to the type the
 * renderer is written against - a reply in the wrong shape compiles, and the
 * rotation replies are ones where the wrong shape reads as success.
 */
type Reply<K extends keyof RendererBridge> = RendererBridge[K] extends (...args: never[]) => infer R ? Awaited<R> : never;
import { ModelStore } from "./models";
import {
  TranscriptWriter,
  deleteTranscript,
  exportTranscript,
  listTranscripts,
  readTranscript,
  transcriptFile,
} from "./transcripts";

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

/**
 * Where saved transcripts go: the folder SETTINGS names, else Documents. Read
 * on every use rather than cached. A folder changed mid-session applies from
 * the next session - the writer keeps the file it already has - and every IPC
 * handler below reads the folder the user can currently see in SETTINGS.
 */
function transcriptDir(): string {
  return (
    validTranscriptDir(config().transcriptDir) ??
    path.join(app.getPath("documents"), "Callout Relay", "Transcripts")
  );
}

const transcripts = new TranscriptWriter({
  dir: transcriptDir,
  // `!== false` rather than truthiness: a config written before this key
  // existed has no value for it, and the feature is on by default
  enabled: () => config().saveTranscripts !== false,
  appVersion: APP_VERSION,
  log,
  onChange: () => broadcastStatus(),
});
let unsubscribeTranscript: (() => void) | null = null;

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

/**
 * Open a link in the user's browser. `shell.openExternal` rejects when nothing
 * can handle the URL, and three call sites discarded that, so a click did
 * nothing and left no trace. One line is the right amount of noise - the same
 * as `could not open ${dir}` for the transcripts folder.
 *
 * The URL goes through `redactLog` because one of these IS the viewer link,
 * whose token sits in its /watch/ path, and this log is a file in the data dir
 * that users are asked to send when something breaks.
 */
function openExternal(url: string): void {
  shell.openExternal(url).catch((err) => {
    log("warn", `could not open ${redactLog(url)}: ${String((err as Error)?.message || err)}`);
  });
}

/** ws(s)://host[:port] -> http(s)://host[:port]; keeps TLS intact */
function httpOriginOfRelayUrl(relayUrl: string): string | null {
  const m = relayUrl.match(/^(wss?):\/\/([^/]+)\/?$/i);
  const proto = m?.[1];
  const host = m?.[2];
  if (proto === undefined || host === undefined) return null;
  const scheme = proto.toLowerCase() === "wss" ? "https" : "http";
  return `${scheme}://${host}`;
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
  const base = validPublicBaseUrl(cfg.publicBaseUrl) || httpOriginOfRelayUrl(cfg.relayUrl);
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

/**
 * Why the embedded relay last failed to start, until it next starts. Status
 * carries it so the console can say the relay is down and why, rather than
 * leaving START to fail with "local relay not ready".
 */
let relayStartError: string | undefined;

async function startEmbeddedRelay(): Promise<void> {
  if (relay) return;
  try {
    await launchEmbeddedRelay();
    relayStartError = undefined;
  } catch (err) {
    relayStartError = String((err as Error)?.message || err);
    throw err;
  }
}

async function launchEmbeddedRelay(): Promise<void> {
  const cfg = config();
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
  bridgeTranscripts();
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
  const url = uplinkUrlFor(cfg.relayUrl, cfg.publisherToken);
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

/**
 * Every finished line, as it was heard, into the saved transcript.
 *
 * `onTranscript`, not `onBroadcast` below: the broadcast is the viewers' copy,
 * after HIDE SWEARING has masked it and with latency dropped when the badge is
 * off. The streamer's own record gets neither change. Re-run on every relay
 * restart, because a restart replaces the relay and the old subscription with it.
 */
function bridgeTranscripts(): void {
  if (unsubscribeTranscript) unsubscribeTranscript();
  unsubscribeTranscript = relay ? relay.onTranscript((line) => transcripts.write(line)) : null;
}

function bridgeBroadcasts(): void {
  if (unsubscribeBroadcast) unsubscribeBroadcast();
  unsubscribeBroadcast = null;
  if (!relay) return;
  unsubscribeBroadcast = relay.onBroadcast((msg: ServerToViewer) => {
    if (!uplink || !uplink.connected) return;
    if (!forwardsToUplink(msg)) return;
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
      uplink.sendStatus(msg.live, msg.message, msg.since, msg.epoch);
    } else if (msg.type === "hello") {
      uplink.sendHello({
        languages: msg.languages,
        translates: msg.translates !== false,
        since: msg.since,
        // the relay's own numbering domain, forwarded. This tee must not
        // invent one from a clock it happens to hold - the ids it is relaying
        // were generated by that relay, not by this process.
        epoch: msg.epoch,
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

/**
 * Rotate both the local (OBS/LAN) link and the remote (phone) link, and say
 * what the relay confirmed about the remote one - see linkRotation.ts.
 */
async function rotateLink(): Promise<LinkRotation> {
  const rotation = await rotateLinks({
    rotateLocal: () => relay?.rotateViewerToken(),
    config,
    saveViewerToken: (viewerToken) => configStore.update({ viewerToken }),
    log,
  });
  broadcastStatus();
  return rotation;
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
      localError: relay ? undefined : relayStartError,
      // absent while the embedded relay is not up (startup/restart) rather than
      // false - false would read as "speech is down" to a topbar that has not
      // even connected to a session yet
      sttLive: relay?.sttLive(),
      // Fix-round-3 Finding 4: same "absent before the relay exists, never a
      // hardcoded false" shape as sttLive above - see ControlStatus.relay's
      // own comment.
      billingPaused: relay?.billingPaused(),
      viewers: relay?.viewerCount() ?? 0,
      remoteViewers: uplink?.remoteViewers ?? 0,
    },
    devices,
    config: cfg,
    usage: usageCache,
    update: updater?.current,
    localModels: models.status(),
    hardware,
    transcript: transcripts.status(),
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
  // read before anything restarts: whether a failed restart has a working
  // relay to roll back to is a fact about the settings being replaced
  const relayWasUp = relay !== null;
  const cfg = configStore.update(patch);
  const relayChanged = RELAY_KEYS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(cfg[k]));
  if (relayChanged) {
    log("info", "relay-affecting config changed, restarting local relay + uplink");
    try {
      await restartAfterConfigChange({
        relayWasUp,
        before,
        after: cfg,
        restart: restartEmbeddedRelay,
        store: (p) => configStore.update(p),
        log,
      });
    } catch (err) {
      win?.webContents.send("config:changed", config());
      broadcastStatus();
      throw err;
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
  ipcMain.handle("runtime:prepare", async (_e, opts: { rotate?: boolean } = {}): Promise<Reply<"prepareSession">> => {
    const cfg = config();
    // The relay check comes FIRST. Rotating before it meant every failed START
    // in the default link mode still minted a new viewer token, persisted it,
    // and kicked everyone on the phone link - three presses while the port was
    // busy invalidated the link three times, with only "start failed" on
    // screen. Nothing about a session that cannot start should spend the link.
    const url = publisherWsUrl();
    if (!url) throw new Error(relayStartError ? `local relay not running: ${relayStartError}` : "local relay not ready");
    const rotation = opts.rotate && cfg.linkMode === "unique" ? await rotateLink() : undefined;
    return {
      publisherUrl: url,
      viewerUrl: viewerUrl(),
      obsUrl: localViewerUrl(),
      phoneUrl: phoneUrl(),
      config: config(),
      rotation,
    };
  });

  ipcMain.handle("open-external", (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) openExternal(url);
  });

  // navigator.clipboard.writeText needs the "clipboard-sanitized-write"
  // permission, and the handler above denies everything but media - so COPY
  // LINK failed silently for every user. Electron's own clipboard writes to
  // the OS directly: no permission, and no focused-document requirement.
  ipcMain.handle("clipboard:write", (_e, text: string) => {
    clipboard.writeText(String(text ?? ""));
  });

  // Saved transcripts. The renderer names a transcript by its session id and
  // never by a path: each handler resolves the id itself, under the folder main
  // chose, through transcriptFile's pattern - so nothing the renderer sends can
  // point fs or shell anywhere else.
  ipcMain.handle("transcripts:list", () => listTranscripts(transcriptDir()));
  ipcMain.handle("transcripts:read", (_e, id: unknown) => readTranscript(transcriptDir(), id));
  ipcMain.handle("transcripts:export", (_e, req: { id?: unknown; format?: unknown } | null) => {
    const file = exportTranscript(transcriptDir(), req?.id, req?.format === "srt" ? "srt" : "txt");
    if (file) shell.showItemInFolder(file);
    return file;
  });
  ipcMain.handle("transcripts:reveal", (_e, id: unknown) => {
    const file = transcriptFile(transcriptDir(), id);
    if (file && fs.existsSync(file)) shell.showItemInFolder(file);
  });
  ipcMain.handle("transcripts:delete", (_e, id: unknown) => {
    // the file being written right now is not the renderer's to delete
    if (id === transcripts.status().session) return false;
    return deleteTranscript(transcriptDir(), id);
  });
  ipcMain.handle("transcripts:openDir", async () => {
    const dir = transcriptDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      log("warn", `could not create ${dir}: ${String((err as Error)?.message || err)}`);
      return;
    }
    const failed = await shell.openPath(dir);
    if (failed) log("warn", `could not open ${dir}: ${failed}`);
  });
  ipcMain.handle("transcripts:chooseDir", async () => {
    const options = {
      title: "Where should transcripts be saved?",
      defaultPath: transcriptDir(),
      properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
    };
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const dir = res.canceled ? undefined : validTranscriptDir(res.filePaths[0]);
    if (!dir) return undefined;
    await applyConfig({ transcriptDir: dir });
    return dir;
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

  // typed from the bridge, like runtime:prepare: a reply in the wrong shape
  // reads as a rotation that worked
  ipcMain.handle("link:rotate", async (): Promise<Reply<"rotateLink">> => {
    const rotation = await rotateLink();
    return { ...rotation, url: viewerUrl() };
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
    // A transcript belongs to the session, not to the publisher socket: a
    // reconnect reports "starting" again and has to go on writing the same
    // file, which open() allows for. "stopping" keeps it open on purpose - STOP
    // lets the last utterance finish, and that line is still on its way.
    if (update.state === "starting" || update.state === "live") {
      const cfg = config();
      transcripts.open({ languages: cfg.languages, translates: translationActive(cfg) });
    } else if (update.state === "idle" || update.state === "error") {
      transcripts.close();
    }
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
  // a rejection here is a window that came up blank; without this the only
  // symptom is an empty frame and nothing written down anywhere
  win.loadFile(path.join(__dirname, "renderer", "index.html")).catch((err) => {
    log("error", `could not load the renderer: ${String((err as Error)?.message || err)}`);
  });

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
          const rotation = await rotateLink();
          // the tray has no log to say it in, so it says it in a dialog
          const notice = rotationNotice(rotation, "use Rotate viewer link again");
          if (!notice.ok) {
            void dialog.showMessageBox({ type: "warning", title: APP_NAME, message: notice.title, detail: notice.text });
          }
          if (trayOpensLink(rotation, config().output) && viewerUrl()) openExternal(viewerUrl()!);
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
          else if (updater?.current.state === "unsupported") openExternal(RELEASES_URL);
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
      // status carries the reason now; say so without waiting for a push
      broadcastStatus();
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
  })
    // one argument to .then() means a throw anywhere in the block above - the
    // relay coming up, the tray, the window - was an unhandled rejection: the
    // app half-starts and the reason goes nowhere. This is the run that most
    // needs a line in the file log, since it is the one the user cannot
    // describe beyond "it didn't open".
    .catch((err) => {
      log("error", `startup failed: ${String((err as Error)?.stack || (err as Error)?.message || err)}`);
    });

  app.on("before-quit", () => {
    quitting = true;
    setPowerBlock(false);
    updater?.stop();
    stopUplink();
    transcripts.close();
    relay?.close().catch(() => {});
  });

  app.on("window-all-closed", () => {
    // keep running in tray
  });
}
