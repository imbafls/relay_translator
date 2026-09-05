import { LocalSttKind, LocalSttMode } from "@callout-relay/shared";
import { ResolvedModelFiles } from "./files";

/** what the engine sends to the worker */
export type ToWorker =
  | {
      type: "init";
      kind: LocalSttKind;
      mode: LocalSttMode;
      files: ResolvedModelFiles;
      vadFile?: string;
      /** ISO 639-1 source language (models that take one) */
      language: string;
      numThreads: number;
    }
  /** s16le mono 16 kHz PCM, transferred */
  | { type: "audio"; buffer: ArrayBuffer }
  | { type: "close" };

/** what the worker reports back */
export type FromWorker =
  | { type: "open"; detail?: string }
  | { type: "partial"; text: string }
  | { type: "final"; text: string; audioEndSec?: number }
  | { type: "error"; message: string }
  | { type: "closed" };
