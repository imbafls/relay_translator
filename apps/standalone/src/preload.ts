import { contextBridge, ipcRenderer } from "electron";
import type {
  AppConfig,
  AudioDeviceInfo,
  ControlStatus,
  KeyValidation,
  LocalModelStatus,
  SessionState,
  UpdateStatus,
} from "@callout-relay/shared";

export interface RendererBridge {
  getConfig(): Promise<AppConfig>;
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
  prepareSession(opts: { rotate: boolean }): Promise<{
    publisherUrl: string;
    viewerUrl?: string;
    obsUrl?: string;
    phoneUrl?: string;
    config: AppConfig;
  }>;
  rotateLink(): Promise<string | undefined>;
  /** test an API key with a cheap request against the provider */
  validateKey(provider: "deepgram" | "gemini", key: string): Promise<KeyValidation>;
  /** ask the update feed right now */
  checkForUpdate(): Promise<UpdateStatus | undefined>;
  /** restart into a downloaded update; false when nothing is staged */
  installUpdate(): Promise<boolean>;
  onUpdate(cb: (status: UpdateStatus) => void): void;
  openExternal(url: string): Promise<void>;
  writeClipboard(text: string): Promise<void>;
  reportState(state: SessionState, error?: string): void;
  reportDevices(devices: AudioDeviceInfo[]): void;
  /** local STT models on disk + running downloads */
  modelStatus(): Promise<LocalModelStatus[]>;
  downloadModel(id: string): Promise<LocalModelStatus[]>;
  cancelModel(id: string): Promise<LocalModelStatus[]>;
  removeModel(id: string): Promise<LocalModelStatus[]>;
  /** "setup" reopens onboarding (tray / keys view) */
  onCommand(cb: (cmd: "start" | "stop" | "setup") => void): void;
  onConfigChanged(cb: (cfg: AppConfig) => void): void;
  onStatus(cb: (status: ControlStatus) => void): void;
}

contextBridge.exposeInMainWorld("cr", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (patch: Partial<AppConfig>) => ipcRenderer.invoke("config:set", patch),
  prepareSession: (opts: { rotate: boolean }) => ipcRenderer.invoke("runtime:prepare", opts),
  rotateLink: () => ipcRenderer.invoke("link:rotate"),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  writeClipboard: (text: string) => ipcRenderer.invoke("clipboard:write", text),
  reportState: (state: SessionState, error?: string) =>
    ipcRenderer.send("session:update", { state, error }),
  reportDevices: (devices: AudioDeviceInfo[]) => ipcRenderer.send("devices:update", devices),
  onCommand: (cb: (cmd: "start" | "stop" | "setup") => void) =>
    ipcRenderer.on("session:command", (_e, cmd) => cb(cmd)),
  modelStatus: () => ipcRenderer.invoke("models:status"),
  downloadModel: (id: string) => ipcRenderer.invoke("models:download", id),
  cancelModel: (id: string) => ipcRenderer.invoke("models:cancel", id),
  removeModel: (id: string) => ipcRenderer.invoke("models:remove", id),
  onConfigChanged: (cb: (cfg: AppConfig) => void) =>
    ipcRenderer.on("config:changed", (_e, cfg) => cb(cfg)),
  onStatus: (cb: (status: ControlStatus) => void) =>
    ipcRenderer.on("status:changed", (_e, status) => cb(status)),
  validateKey: (provider: "deepgram" | "gemini", key: string) =>
    ipcRenderer.invoke("keys:validate", { provider, key }),
  checkForUpdate: () => ipcRenderer.invoke("updates:check"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  onUpdate: (cb: (status: UpdateStatus) => void) =>
    ipcRenderer.on("update:changed", (_e, status) => cb(status)),
} satisfies RendererBridge);
