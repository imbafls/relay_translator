/**
 * Local STT worker thread: owns the sherpa-onnx recognizer so inference never
 * blocks the process that hosts the relay (the Electron main process).
 *
 * Two shapes, both fed s16le 16 kHz mono PCM:
 *  - streaming: OnlineRecognizer; partial on every text change, final + reset
 *    on endpoint.
 *  - phrase: Silero VAD cuts speech segments; each segment is decoded once as
 *    a final. While a segment is open the buffered audio is re-decoded at most
 *    once a second (and only when the last decode was quick) for interim text.
 */
import { parentPort } from "worker_threads";
import type { FromWorker, ToWorker } from "./protocol";

const SAMPLE_RATE = 16000;

interface OnlineStream {
  acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void;
  setOption(key: string, value: string): void;
}
interface OnlineRecognizer {
  createStream(): OnlineStream;
  isReady(s: OnlineStream): boolean;
  decode(s: OnlineStream): void;
  isEndpoint(s: OnlineStream): boolean;
  reset(s: OnlineStream): void;
  getResult(s: OnlineStream): { text: string };
}
interface OfflineStream {
  acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void;
}
interface OfflineRecognizer {
  createStream(): OfflineStream;
  decode(s: OfflineStream): void;
  getResult(s: OfflineStream): { text: string };
}
interface Vad {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  isDetected(): boolean;
  front(): { start: number; samples: Float32Array };
  pop(): void;
  flush(): void;
  reset(): void;
}
interface Sherpa {
  OnlineRecognizer: new (cfg: unknown) => OnlineRecognizer;
  OfflineRecognizer: new (cfg: unknown) => OfflineRecognizer;
  Vad: new (cfg: unknown, bufferSeconds: number) => Vad;
}

const port = parentPort;
if (!port) throw new Error("local STT worker must run as a worker thread");

const send = (msg: FromWorker): void => port.postMessage(msg);

/** captions read better sentence-cased; transducers shout, Whisper adds gaps */
function tidy(text: string): string {
  let t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length > 3 && letters === letters.toUpperCase()) t = t.toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function toFloat(buffer: ArrayBuffer): Float32Array {
  const pcm = new Int16Array(buffer);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

let engine: { feed(samples: Float32Array): void; close(): void } | null = null;

function buildStreaming(sherpa: Sherpa, init: Extract<ToWorker, { type: "init" }>): typeof engine {
  const f = init.files;
  if (f.kind !== "online-transducer" && f.kind !== "online-transducer-nemotron") throw new Error("not a streaming model");
  const nemotron = f.kind === "online-transducer-nemotron";
  const rec = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: nemotron ? 128 : 80 },
    modelConfig: {
      transducer: { encoder: f.encoder, decoder: f.decoder, joiner: f.joiner },
      tokens: f.tokens,
      numThreads: init.numThreads,
      provider: "cpu",
      debug: 0,
    },
    decodingMethod: "greedy_search",
    enableEndpoint: true,
    // callouts are short: 0.8 s of silence after a phrase closes it
    rule1MinTrailingSilence: 2.0,
    rule2MinTrailingSilence: 0.8,
    rule3MinUtteranceLength: 15,
  });
  const stream = rec.createStream();
  if (nemotron && /^[a-z]{2}$/.test(init.language)) {
    try {
      stream.setOption("language", init.language);
    } catch {
      /* auto-detect */
    }
  }
  let fed = 0;
  let last = "";
  return {
    feed(samples) {
      stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
      fed += samples.length;
      while (rec.isReady(stream)) rec.decode(stream);
      const text = tidy(rec.getResult(stream).text);
      if (rec.isEndpoint(stream)) {
        if (text) send({ type: "final", text, audioEndSec: fed / SAMPLE_RATE });
        rec.reset(stream);
        last = "";
        return;
      }
      if (text && text !== last) {
        last = text;
        send({ type: "partial", text });
      }
    },
    close() {
      // whatever was being said when the session stopped still counts
      try {
        stream.acceptWaveform({ samples: new Float32Array(SAMPLE_RATE), sampleRate: SAMPLE_RATE });
        while (rec.isReady(stream)) rec.decode(stream);
        const text = tidy(rec.getResult(stream).text);
        if (text && text !== last) send({ type: "partial", text });
        if (text) send({ type: "final", text, audioEndSec: fed / SAMPLE_RATE });
      } catch {
        /* closing anyway */
      }
    },
  };
}

function buildPhrase(sherpa: Sherpa, init: Extract<ToWorker, { type: "init" }>): typeof engine {
  const f = init.files;
  if (!init.vadFile) throw new Error("phrase models need the VAD model");
  let modelConfig: Record<string, unknown>;
  switch (f.kind) {
    case "offline-transducer-nemo":
      modelConfig = { transducer: { encoder: f.encoder, decoder: f.decoder, joiner: f.joiner }, modelType: "nemo_transducer" };
      break;
    case "moonshine":
      modelConfig = {
        moonshine: { preprocessor: f.preprocessor, encoder: f.encoder, uncachedDecoder: f.uncachedDecoder, cachedDecoder: f.cachedDecoder },
      };
      break;
    case "whisper":
      modelConfig = { whisper: { encoder: f.encoder, decoder: f.decoder, language: init.language || "en", task: "transcribe" } };
      break;
    case "sense-voice":
      modelConfig = {
        senseVoice: {
          model: f.model,
          language: ["zh", "en", "ja", "ko", "yue"].includes(init.language) ? init.language : "auto",
          useInverseTextNormalization: 1,
        },
      };
      break;
    default:
      throw new Error("not a phrase model");
  }
  const rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: { ...modelConfig, tokens: f.tokens, numThreads: init.numThreads, provider: "cpu", debug: 0 },
  });
  const WINDOW = 512;
  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model: init.vadFile,
        threshold: 0.5,
        minSilenceDuration: 0.5,
        minSpeechDuration: 0.25,
        maxSpeechDuration: 8,
        windowSize: WINDOW,
      },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      provider: "cpu",
      debug: 0,
    },
    30,
  );

  const decode = (samples: Float32Array): { text: string; ms: number } => {
    const t0 = Date.now();
    const s = rec.createStream();
    s.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    rec.decode(s);
    return { text: tidy(rec.getResult(s).text), ms: Date.now() - t0 };
  };

  // VAD wants exact 512-sample windows; carry the remainder between chunks
  let carry = new Float32Array(0);
  let fed = 0;
  /** audio of the phrase currently being spoken (for interim decodes) */
  let open: Float32Array[] = [];
  let openLen = 0;
  let lastInterimAt = 0;
  let lastDecodeMs = 0;
  let lastPartial = "";

  return {
    feed(samples) {
      let buf = samples;
      if (carry.length) {
        const merged = new Float32Array(carry.length + samples.length);
        merged.set(carry);
        merged.set(samples, carry.length);
        buf = merged;
        carry = new Float32Array(0);
      }
      let i = 0;
      for (; i + WINDOW <= buf.length; i += WINDOW) {
        const win = buf.subarray(i, i + WINDOW);
        vad.acceptWaveform(win);
        fed += WINDOW;
        if (vad.isDetected()) {
          open.push(win.slice());
          openLen += WINDOW;
        }
        while (!vad.isEmpty()) {
          const seg = vad.front();
          vad.pop();
          open = [];
          openLen = 0;
          lastPartial = "";
          const { text, ms } = decode(seg.samples);
          lastDecodeMs = ms;
          if (text) send({ type: "final", text, audioEndSec: (seg.start + seg.samples.length) / SAMPLE_RATE });
        }
      }
      if (i < buf.length) carry = buf.slice(i);

      // interim text for the phrase in progress: cheap models only, once a second
      const now = Date.now();
      if (openLen >= SAMPLE_RATE && now - lastInterimAt >= 1000 && lastDecodeMs < 400) {
        lastInterimAt = now;
        const joined = new Float32Array(openLen);
        let off = 0;
        for (const part of open) {
          joined.set(part, off);
          off += part.length;
        }
        const { text, ms } = decode(joined);
        lastDecodeMs = ms;
        if (text && text !== lastPartial) {
          lastPartial = text;
          send({ type: "partial", text });
        }
      }
    },
    close() {
      try {
        vad.flush();
        while (!vad.isEmpty()) {
          const seg = vad.front();
          vad.pop();
          const { text } = decode(seg.samples);
          if (text) send({ type: "final", text, audioEndSec: (seg.start + seg.samples.length) / SAMPLE_RATE });
        }
      } catch {
        /* closing anyway */
      }
    },
  };
}

port.on("message", (msg: ToWorker) => {
  try {
    if (msg.type === "init") {
      const sherpa = require("sherpa-onnx-node") as Sherpa;
      engine = msg.mode === "streaming" ? buildStreaming(sherpa, msg) : buildPhrase(sherpa, msg);
      send({ type: "open" });
    } else if (msg.type === "audio") {
      engine?.feed(toFloat(msg.buffer));
    } else if (msg.type === "close") {
      engine?.close();
      engine = null;
      send({ type: "closed" });
    }
  } catch (err) {
    send({ type: "error", message: String((err as Error).message || err) });
  }
});
