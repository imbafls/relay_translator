import { contextBridge, ipcRenderer } from "electron";
import type { AppConfig, AudioDeviceInfo, ControlStatus, SessionState } from "@callout-relay/shared";

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
  openExternal(url: string): Promise<void>;
  reportState(state: SessionState, error?: string): void;
  reportDevices(devices: AudioDeviceInfo[]): void;
  onCommand(cb: (cmd: "start" | "stop") => void): void;
  onConfigChanged(cb: (cfg: AppConfig) => void): void;
  onStatus(cb: (status: ControlStatus) => void): void;
}

contextBridge.exposeInMainWorld("cr", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (patch: Partial<AppConfig>) => ipcRenderer.invoke("config:set", patch),
  prepareSession: (opts: { rotate: boolean }) => ipcRenderer.invoke("runtime:prepare", opts),
  rotateLink: () => ipcRenderer.invoke("link:rotate"),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  reportState: (state: SessionState, error?: string) =>
    ipcRenderer.send("session:update", { state, error }),
  reportDevices: (devices: AudioDeviceInfo[]) => ipcRenderer.send("devices:update", devices),
  onCommand: (cb: (cmd: "start" | "stop") => void) =>
    ipcRenderer.on("session:command", (_e, cmd) => cb(cmd)),
  onConfigChanged: (cb: (cfg: AppConfig) => void) =>
    ipcRenderer.on("config:changed", (_e, cfg) => cb(cfg)),
  onStatus: (cb: (status: ControlStatus) => void) =>
    ipcRenderer.on("status:changed", (_e, status) => cb(status)),
} satisfies RendererBridge);
