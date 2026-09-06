/**
 * Browser-safe entry (Electron renderer). The default entry pulls in
 * node-only modules (config store, control server) via "os"/"http".
 */
export { RelayPublisherClient } from "./relayClient";
export {
  anyTrackLive,
  BrowserAudioCapture,
  captureErrorText,
  captureSources,
  rmsLevel,
  TARGET_SAMPLE_RATE,
  watchSourceTracks,
} from "./capture";
export type { SourceLost } from "./capture";
export { PCM_WORKLET_SOURCE } from "./capture/workletSource";
