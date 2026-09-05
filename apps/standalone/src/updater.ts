/**
 * Auto-update for the desktop app.
 *
 * Feed: the relay's own `/updates/` directory (DEFAULT_UPDATE_FEED), which the
 * release workflow's artifacts get published to. The GitHub release feed is not
 * usable here because the repo is private. `updateFeedUrl` in config points the
 * app at any other static directory serving `latest.yml` + the installer.
 *
 * Only the NSIS install can replace itself. The portable exe and unpackaged dev
 * runs report "unsupported" and link to the release page instead.
 */
import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_UPDATE_FEED } from "@callout-relay/shared";
import type { AppConfig, UpdateStatus } from "@callout-relay/shared";

export const RELEASES_URL = "https://github.com/imbafls/relay_translator/releases/latest";

type Log = (level: "info" | "warn" | "error", message: string) => void;

interface UpdaterDeps {
  config(): AppConfig;
  log: Log;
  onChange(status: UpdateStatus): void;
}

/** electron-updater is only loaded in packaged builds, so dev runs stay light */
type AutoUpdater = typeof import("electron-updater").autoUpdater;

const SIX_HOURS = 6 * 60 * 60 * 1000;

export class Updater {
  private updater: AutoUpdater | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private status: UpdateStatus;

  constructor(private readonly deps: UpdaterDeps) {
    this.status = { state: "idle", current: app.getVersion(), releaseUrl: RELEASES_URL };
  }

  get current(): UpdateStatus {
    return this.status;
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.deps.onChange(this.status);
  }

  /**
   * A packaged NSIS install ships `app-update.yml`; the portable target does
   * not, which is exactly how we tell the two apart at runtime.
   */
  private unsupportedReason(): string | undefined {
    if (!app.isPackaged) return "development build";
    if (process.env.PORTABLE_EXECUTABLE_FILE) return "portable build";
    const feed = path.join(process.resourcesPath, "app-update.yml");
    if (!fs.existsSync(feed)) return "portable build";
    return undefined;
  }

  private load(): AutoUpdater | null {
    if (this.updater) return this.updater;
    const reason = this.unsupportedReason();
    if (reason) {
      this.set({ state: "unsupported", detail: reason });
      return null;
    }
    let mod: AutoUpdater;
    try {
      // require, not import: never pulled into a dev run
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = (require("electron-updater") as typeof import("electron-updater")).autoUpdater;
    } catch (err) {
      this.set({ state: "error", detail: `updater unavailable: ${String(err)}` });
      return null;
    }

    mod.autoDownload = true;
    // an update must never interrupt a live session; it lands on the next launch
    mod.autoInstallOnAppQuit = true;
    // we ship a normal NSIS installer, never a web installer
    mod.disableWebInstaller = true;
    mod.logger = {
      info: (m: unknown) => this.deps.log("info", `update: ${String(m)}`),
      warn: (m: unknown) => this.deps.log("warn", `update: ${String(m)}`),
      error: (m: unknown) => this.deps.log("error", `update: ${String(m)}`),
      debug: () => {},
    };

    const feedUrl = this.deps.config().updateFeedUrl?.trim() || DEFAULT_UPDATE_FEED;
    try {
      mod.setFeedURL({ provider: "generic", url: feedUrl });
      this.deps.log("info", `update feed: ${feedUrl}`);
    } catch (err) {
      this.deps.log("error", `bad update feed ${feedUrl}: ${String(err)}`);
    }

    mod.on("checking-for-update", () => this.set({ state: "checking" }));
    mod.on("update-available", (info) =>
      this.set({ state: "downloading", latest: info.version, percent: 0 }),
    );
    mod.on("update-not-available", (info) =>
      this.set({ state: "current", latest: info.version, checkedAt: Date.now(), detail: undefined }),
    );
    mod.on("download-progress", (p) => this.set({ state: "downloading", percent: Math.round(p.percent) }));
    mod.on("update-downloaded", (info) => {
      this.deps.log("info", `update ${info.version} ready — installs on restart`);
      this.set({ state: "ready", latest: info.version, percent: 100, checkedAt: Date.now() });
    });
    mod.on("error", (err) => {
      const detail = String(err?.message || err);
      this.deps.log("error", `update check failed: ${detail}`);
      this.set({ state: "error", detail: shortError(detail), checkedAt: Date.now() });
    });

    this.updater = mod;
    return mod;
  }

  /** manual CHECK, and the background poll */
  async check(manual = false): Promise<UpdateStatus> {
    if (this.status.state === "ready") return this.status;
    if (this.checking) return this.status;
    const mod = this.load();
    if (!mod) return this.status;
    this.checking = true;
    try {
      await mod.checkForUpdates();
    } catch (err) {
      const detail = shortError(String((err as Error)?.message || err));
      this.deps.log(manual ? "error" : "warn", `update check failed: ${detail}`);
      this.set({ state: "error", detail, checkedAt: Date.now() });
    } finally {
      this.checking = false;
    }
    return this.status;
  }

  /** quit and install now; only meaningful once state is "ready" */
  install(): boolean {
    if (this.status.state !== "ready" || !this.updater) return false;
    this.deps.log("info", "installing update and restarting");
    setImmediate(() => this.updater?.quitAndInstall(false, true));
    return true;
  }

  /** first check shortly after launch, then every 6h while the app runs */
  start(): void {
    this.stop();
    if (this.deps.config().autoUpdate === false) {
      this.deps.log("info", "background update checks are off");
      return;
    }
    setTimeout(() => void this.check(), 15000);
    this.timer = setInterval(() => void this.check(), SIX_HOURS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** GitHub/network errors are long and noisy; the UI only has one line */
function shortError(detail: string): string {
  if (/404|Not Found/i.test(detail)) return "no release feed found";
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network/i.test(detail)) return "no connection";
  if (/403|rate limit/i.test(detail)) return "feed refused the request";
  return detail.split("\n")[0].slice(0, 120);
}
