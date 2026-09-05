import * as fs from "fs";
import * as path from "path";
import { LocalSttKind } from "@callout-relay/shared";

/**
 * Resolved sherpa-onnx model files for one model folder. The catalog does not
 * pin file names: archives are located by kind, preferring int8 weights except
 * for the transducer decoder (int8 decoders lose accuracy for no speed gain).
 */
export type ResolvedModelFiles =
  | { kind: "online-transducer" | "online-transducer-nemotron" | "offline-transducer-nemo"; encoder: string; decoder: string; joiner: string; tokens: string }
  | { kind: "moonshine"; preprocessor: string; encoder: string; uncachedDecoder: string; cachedDecoder: string; tokens: string }
  | { kind: "whisper"; encoder: string; decoder: string; tokens: string }
  | { kind: "sense-voice"; model: string; tokens: string };

function listFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => {
      try {
        return fs.statSync(path.join(dir, f)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** first file matching any pattern, in pattern order */
function pick(dir: string, files: string[], patterns: RegExp[]): string | undefined {
  for (const re of patterns) {
    const hit = files.find((f) => re.test(f));
    if (hit) return path.join(dir, hit);
  }
  return undefined;
}

/**
 * Locate the files a model of `kind` needs inside `dir`. Returns undefined
 * when anything required is missing (a half-downloaded or foreign folder).
 */
export function resolveModelFiles(kind: LocalSttKind, dir: string): ResolvedModelFiles | undefined {
  const files = listFiles(dir);
  if (files.length === 0) return undefined;
  const tokens = pick(dir, files, [/^tokens\.txt$/, /-tokens\.txt$/, /tokens.*\.txt$/]);
  if (!tokens) return undefined;

  switch (kind) {
    case "online-transducer":
    case "online-transducer-nemotron":
    case "offline-transducer-nemo": {
      const encoder = pick(dir, files, [/^encoder.*int8.*\.onnx$/, /^encoder.*\.onnx$/]);
      // fp32 decoder first: it is tiny and int8 quantisation hurts it
      const decoder = pick(dir, files, [/^decoder(?!.*int8).*\.onnx$/, /^decoder.*\.onnx$/]);
      const joiner = pick(dir, files, [/^joiner.*int8.*\.onnx$/, /^joiner.*\.onnx$/]);
      if (!encoder || !decoder || !joiner) return undefined;
      return { kind, encoder, decoder, joiner, tokens };
    }
    case "moonshine": {
      const preprocessor = pick(dir, files, [/^preprocess.*\.onnx$/]);
      const encoder = pick(dir, files, [/^encode.*int8.*\.onnx$/, /^encode.*\.onnx$/]);
      const uncachedDecoder = pick(dir, files, [/^uncached_decode.*int8.*\.onnx$/, /^uncached_decode.*\.onnx$/]);
      const cachedDecoder = pick(dir, files, [/^cached_decode.*int8.*\.onnx$/, /^cached_decode.*\.onnx$/]);
      if (!preprocessor || !encoder || !uncachedDecoder || !cachedDecoder) return undefined;
      return { kind, preprocessor, encoder, uncachedDecoder, cachedDecoder, tokens };
    }
    case "whisper": {
      const encoder = pick(dir, files, [/-encoder.*int8.*\.onnx$/, /-encoder.*\.onnx$/]);
      const decoder = pick(dir, files, [/-decoder.*int8.*\.onnx$/, /-decoder.*\.onnx$/]);
      if (!encoder || !decoder) return undefined;
      return { kind, encoder, decoder, tokens };
    }
    case "sense-voice": {
      const model = pick(dir, files, [/^model.*int8.*\.onnx$/, /^model.*\.onnx$/]);
      if (!model) return undefined;
      return { kind, model, tokens };
    }
    default:
      return undefined;
  }
}

/** phrase (offline) models need the Silero VAD next to them */
export function needsVad(kind: LocalSttKind): boolean {
  return kind === "offline-transducer-nemo" || kind === "moonshine" || kind === "whisper" || kind === "sense-voice";
}
