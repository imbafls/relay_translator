/**
 * Local speech-to-text worker (sherpa-onnx). Runs in a worker_thread so the
 * synchronous ONNX decodes never stall the relay's WebSocket loop.
 *
 * Protocol (main -> worker): { type: "init", ... } then { type: "audio", buffer }
 * (s16le 16 kHz, mono or interleaved by `channels`), then { type: "close" }.
 * Worker -> main: ready | partial | final | error.
 *
 * Streaming models (zipformer online): one OnlineStream per channel with
 * endpoint detection - partials arrive word by word.
 * Offline models (parakeet / sense-voice / whisper): silero VAD segments each
 * channel, the open segment is re-decoded every ~1.2 s for a partial, and
 * the finished segment is decoded once more for the final.
 */
import { parentPort } from "worker_threads";
import * as path from "path";
import { clampChannels } from "@callout-relay/shared";

// sherpa-onnx-node has no type declarations; keep the surface we touch loose.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Sherpa = any;

export interface LocalSttInit {
  type: "init";
  engine: "zipformer-online" | "nemotron-online" | "nemo-transducer" | "sense-voice" | "whisper" | "moonshine";
  modelDir: string;
  vadModel: string;
  channels: number;
  /** mel bins the model was exported with (80 unless the catalog says otherwise) */
  melBins?: number;
  language: string;
  numThreads?: number;
}

export type LocalSttToWorker = LocalSttInit | { type: "audio"; buffer: ArrayBuffer } | { type: "close" };

export type LocalSttFromWorker =
  | { type: "ready" }
  | { type: "partial"; channel: number; text: string }
  | { type: "final"; channel: number; text: string; audioEndSec: number }
  | { type: "error"; message: string };

const SAMPLE_RATE = 16000;
const VAD_WINDOW = 512;
/** re-decode the open VAD segment for a partial this often */
const PARTIAL_EVERY_SEC = 1.2;
/** never decode a partial on less than this much speech */
const PARTIAL_MIN_SEC = 0.8;

function post(msg: LocalSttFromWorker): void {
  parentPort?.postMessage(msg);
}

function loadSherpa(): Sherpa {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("sherpa-onnx-node");
}

interface ChannelState {
  /** samples pushed so far (for audioEndSec) */
  fed: number;
  /** `fed` when the streaming text last grew - close to where the speech ended */
  lastGrowFed: number;
  // streaming
  online?: Sherpa;
  lastPartial: string;
  // offline
  vad?: Sherpa;
  /** samples of the segment currently open in the VAD, for partial decodes */
  open: Float32Array[];
  openLen: number;
  sincePartial: number;
  window: Float32Array;
  windowLen: number;
}

let sherpa: Sherpa;
let init: LocalSttInit | null = null;
let onlineRec: Sherpa | null = null;
let offlineRec: Sherpa | null = null;
const chans: ChannelState[] = [];

function modelConfig(i: LocalSttInit): Record<string, unknown> {
  const dir = i.modelDir;
  const f = (name: string): string => path.join(dir, name);
  const threads = i.numThreads || 2;
  const base = { tokens: f("tokens.txt"), numThreads: threads, provider: "cpu", debug: 0 };
  switch (i.engine) {
    case "zipformer-online":
    case "nemotron-online":
      return {
        ...base,
        transducer: { encoder: f("encoder.int8.onnx"), decoder: f("decoder.int8.onnx"), joiner: f("joiner.int8.onnx") },
      };
    case "nemo-transducer":
      return {
        ...base,
        modelType: "nemo_transducer",
        transducer: { encoder: f("encoder.int8.onnx"), decoder: f("decoder.int8.onnx"), joiner: f("joiner.int8.onnx") },
      };
    case "sense-voice":
      return { ...base, senseVoice: { model: f("model.int8.onnx"), language: i.language || "auto", useInverseTextNormalization: 1 } };
    case "moonshine":
      return {
        ...base,
        moonshine: {
          preprocessor: f("preprocess.onnx"),
          encoder: f("encode.int8.onnx"),
          uncachedDecoder: f("uncached_decode.int8.onnx"),
          cachedDecoder: f("cached_decode.int8.onnx"),
        },
      };
    case "whisper":
      return {
        ...base,
        whisper: { encoder: f("encoder.int8.onnx"), decoder: f("decoder.int8.onnx"), language: i.language || "en", task: "transcribe", tailPaddings: -1 },
      };
  }
}

/**
 * Probe mode. sherpa-onnx aborts the whole process on some models rather than
 * throwing, so the desktop app loads every model here first: this child dies
 * instead of the app, and its exit code says whether the model is usable.
 *   node localSttWorker.js --probe '<LocalSttInit json>'
 */
function runProbe(): boolean {
  const at = process.argv.indexOf("--probe");
  if (at === -1) return false;
  try {
    const init = JSON.parse(process.argv[at + 1] || "{}") as LocalSttInit;
    setup({ ...init, channels: 1 });
    process.exit(0);
  } catch (err) {
    process.stderr.write(`${String((err as Error)?.message || err)}\n`);
    process.exit(3);
  }
}

function setup(i: LocalSttInit): void {
  sherpa = loadSherpa();
  init = i;
  const channels = clampChannels(i.channels);
  const online = i.engine === "zipformer-online" || i.engine === "nemotron-online";
  if (online) {
    onlineRec = new sherpa.OnlineRecognizer({
      // Nemotron was exported with 128 mel bins; the zipformers use 80
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: i.melBins || (i.engine === "nemotron-online" ? 128 : 80) },
      modelConfig: modelConfig(i),
      decodingMethod: "greedy_search",
      enableEndpoint: true,
      // trailing silence that ends an utterance: after speech / before any speech / hard cap
      rule1MinTrailingSilence: 1.6,
      rule2MinTrailingSilence: 0.8,
      rule3MinUtteranceLength: 18,
    });
  } else {
    offlineRec = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: i.melBins || 80 },
      modelConfig: modelConfig(i),
      decodingMethod: "greedy_search",
    });
  }
  for (let c = 0; c < channels; c++) {
    const st: ChannelState = {
      fed: 0,
      lastGrowFed: 0,
      lastPartial: "",
      open: [],
      openLen: 0,
      sincePartial: 0,
      window: new Float32Array(VAD_WINDOW),
      windowLen: 0,
    };
    if (onlineRec) {
      st.online = onlineRec.createStream();
      // multilingual streaming models read the language off each stream;
      // leaving it unset means auto-detect
      if (i.engine === "nemotron-online" && /^[a-z]{2}$/.test(i.language || "")) {
        try {
          st.online.setOption("language", i.language);
        } catch {
          /* older builds have no per-stream options: auto-detect */
        }
      }
    } else {
      st.vad = new sherpa.Vad(
        {
          sileroVad: {
            model: i.vadModel,
            threshold: 0.5,
            minSilenceDuration: 0.5,
            minSpeechDuration: 0.25,
            windowSize: VAD_WINDOW,
            maxSpeechDuration: 15,
          },
          sampleRate: SAMPLE_RATE,
          numThreads: 1,
          provider: "cpu",
          debug: 0,
        },
        40,
      );
    }
    chans.push(st);
  }
  post({ type: "ready" });
}

function decodeOffline(samples: Float32Array): string {
  const s = offlineRec.createStream();
  s.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  offlineRec.decode(s);
  const r = offlineRec.getResult(s);
  return String(r?.text || "").trim();
}

function concat(parts: Float32Array[], len: number): Float32Array {
  const out = new Float32Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function feedOnline(c: number, st: ChannelState, samples: Float32Array): void {
  st.online.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  while (onlineRec.isReady(st.online)) onlineRec.decode(st.online);
  const text = String(onlineRec.getResult(st.online)?.text || "").trim();
  if (onlineRec.isEndpoint(st.online)) {
    // the endpoint fires after the trailing silence; stamp the final where the text stopped growing
    if (text) post({ type: "final", channel: c, text, audioEndSec: (st.lastGrowFed || st.fed) / SAMPLE_RATE });
    onlineRec.reset(st.online);
    st.lastPartial = "";
    st.lastGrowFed = 0;
    return;
  }
  if (text && text !== st.lastPartial) {
    st.lastPartial = text;
    st.lastGrowFed = st.fed;
    post({ type: "partial", channel: c, text });
  }
}

function feedOffline(c: number, st: ChannelState, samples: Float32Array): void {
  // the VAD wants fixed 512-sample windows; carry the remainder across chunks
  let i = 0;
  while (i < samples.length) {
    const take = Math.min(VAD_WINDOW - st.windowLen, samples.length - i);
    st.window.set(samples.subarray(i, i + take), st.windowLen);
    st.windowLen += take;
    i += take;
    if (st.windowLen < VAD_WINDOW) break;
    st.windowLen = 0;
    const win = st.window.slice();
    st.vad.acceptWaveform(win);
    const speaking: boolean = st.vad.isDetected();
    if (speaking) {
      st.open.push(win);
      st.openLen += win.length;
      st.sincePartial += win.length;
    }
    // finished segments
    while (!st.vad.isEmpty()) {
      const seg = st.vad.front(false);
      st.vad.pop();
      const text = decodeOffline(seg.samples);
      st.open = [];
      st.openLen = 0;
      st.sincePartial = 0;
      st.lastPartial = "";
      if (text) {
        // seg.start is the sample offset inside the VAD's own timeline, which
        // tracks fed samples 1:1
        const audioEndSec = (seg.start + seg.samples.length) / SAMPLE_RATE;
        post({ type: "final", channel: c, text, audioEndSec });
      }
    }
    // partial for the segment still open
    if (
      speaking &&
      st.openLen >= PARTIAL_MIN_SEC * SAMPLE_RATE &&
      st.sincePartial >= PARTIAL_EVERY_SEC * SAMPLE_RATE
    ) {
      st.sincePartial = 0;
      const text = decodeOffline(concat(st.open, st.openLen));
      if (text && text !== st.lastPartial) {
        st.lastPartial = text;
        post({ type: "partial", channel: c, text });
      }
    }
  }
}

function onAudio(buffer: ArrayBuffer): void {
  if (!init) return;
  const pcm = new Int16Array(buffer);
  const n = chans.length;
  const frames = Math.floor(pcm.length / n);
  for (let c = 0; c < n; c++) {
    const st = chans[c];
    const f32 = new Float32Array(frames);
    for (let k = 0; k < frames; k++) f32[k] = pcm[k * n + c] / 32768;
    st.fed += frames;
    if (st.online) feedOnline(c, st, f32);
    else feedOffline(c, st, f32);
  }
}

function flush(): void {
  for (let c = 0; c < chans.length; c++) {
    const st = chans[c];
    if (st.online) {
      st.online.inputFinished();
      while (onlineRec.isReady(st.online)) onlineRec.decode(st.online);
      const text = String(onlineRec.getResult(st.online)?.text || "").trim();
      if (text) post({ type: "final", channel: c, text, audioEndSec: (st.lastGrowFed || st.fed) / SAMPLE_RATE });
    } else if (st.vad) {
      st.vad.flush();
      while (!st.vad.isEmpty()) {
        const seg = st.vad.front(false);
        st.vad.pop();
        const text = decodeOffline(seg.samples);
        if (text) post({ type: "final", channel: c, text, audioEndSec: (seg.start + seg.samples.length) / SAMPLE_RATE });
      }
    }
  }
}

// --probe loads the model and exits; nothing below runs in that mode
runProbe();

parentPort?.on("message", (msg: LocalSttToWorker) => {
  try {
    if (msg.type === "init") setup(msg);
    else if (msg.type === "audio") onAudio(msg.buffer);
    else if (msg.type === "close") {
      flush();
      parentPort?.close();
    }
  } catch (err) {
    post({ type: "error", message: String((err as Error)?.message || err) });
  }
});
