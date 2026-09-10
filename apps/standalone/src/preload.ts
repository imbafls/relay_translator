import { contextBridge, ipcRenderer } from "electron";
import type {
  AppConfig,
  AudioDeviceInfo,
  ControlStatus,
  KeyValidation,
  LocalModelStatus,
  SessionState,
  Transcript,
  TranscriptSummary,
  UpdateStatus,
} from "@callout-relay/shared";
import type { FeedbackPayload, FeedbackResult } from "@callout-relay/companion";

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
  /** claim a room on the hosted relay so the link works outside this network */
  claimRelayRoom(relayUrl?: string): Promise<{ ok: boolean; message?: string }>;
  /** test an API key with a cheap request against the provider */
  validateKey(provider: "deepgram" | "gemini", key: string): Promise<KeyValidation>;
  /** ask the update feed right now */
  checkForUpdate(): Promise<UpdateStatus | undefined>;
  /** restart into a downloaded update; false when nothing is staged */
  installUpdate(): Promise<boolean>;
  onUpdate(cb: (status: UpdateStatus) => void): void;
  openExternal(url: string): Promise<void>;
  writeClipboard(text: string): Promise<void>;
  appVersion(): Promise<string>;
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
  /**
   * The raw, unredacted text of relay.log. The renderer redacts it
   * (redactLog) and shows the result in the preview before anything is sent.
   */
  readRelayLog(): Promise<string>;
  /**
   * Send a feedback report - the exact payload the renderer built, already
   * redacted client-side (see `readRelayLog` above and `redactLog`,
   * packages/shared). This runs the actual POST in the main process: the
   * renderer's `file://` origin gets no CORS headers back from the hosted
   * relay (by design - see the comment on the `feedback:send` handler in
   * main.ts) and could never complete this request itself.
   */
  sendFeedback(payload: FeedbackPayload): Promise<FeedbackResult>;
  /**
   * Saved transcripts. Every one of these names a transcript by its session id,
   * never by a path - main resolves the id itself, under the folder it chose,
   * so nothing sent from here can point fs or shell anywhere else.
   */
  /** every saved session in the current folder, newest first */
  listTranscripts(): Promise<TranscriptSummary[]>;
  /** one session, each line merged with its translation */
  readTranscript(id: string): Promise<Transcript | undefined>;
  /** write a readable copy beside it and show it in Explorer; the file, or undefined */
  exportTranscript(id: string, format: "txt" | "srt"): Promise<string | undefined>;
  revealTranscript(id: string): Promise<void>;
  /** false for the session still being written, or a file that would not go */
  deleteTranscript(id: string): Promise<boolean>;
  /** the folder picked - already saved to config - or undefined if cancelled */
  chooseTranscriptDir(): Promise<string | undefined>;
  openTranscriptDir(): Promise<void>;
}

contextBridge.exposeInMainWorld("cr", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (patch: Partial<AppConfig>) => ipcRenderer.invoke("config:set", patch),
  prepareSession: (opts: { rotate: boolean }) => ipcRenderer.invoke("runtime:prepare", opts),
  rotateLink: () => ipcRenderer.invoke("link:rotate"),
  claimRelayRoom: (relayUrl?: string) => ipcRenderer.invoke("relay:claim", relayUrl),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  writeClipboard: (text: string) => ipcRenderer.invoke("clipboard:write", text),
  appVersion: () => ipcRenderer.invoke("app:version"),
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
  readRelayLog: () => ipcRenderer.invoke("log:read"),
  sendFeedback: (payload: FeedbackPayload) => ipcRenderer.invoke("feedback:send", payload),
  listTranscripts: () => ipcRenderer.invoke("transcripts:list"),
  readTranscript: (id: string) => ipcRenderer.invoke("transcripts:read", id),
  exportTranscript: (id: string, format: "txt" | "srt") => ipcRenderer.invoke("transcripts:export", { id, format }),
  revealTranscript: (id: string) => ipcRenderer.invoke("transcripts:reveal", id),
  deleteTranscript: (id: string) => ipcRenderer.invoke("transcripts:delete", id),
  chooseTranscriptDir: () => ipcRenderer.invoke("transcripts:chooseDir"),
  openTranscriptDir: () => ipcRenderer.invoke("transcripts:openDir"),
} satisfies RendererBridge);
