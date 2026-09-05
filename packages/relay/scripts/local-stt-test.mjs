/**
 * Decode a 16 kHz mono WAV with a local (sherpa-onnx) model through the same
 * worker the relay uses. Needs the model downloaded into the app data dir.
 *
 *   node packages/relay/scripts/local-stt-test.mjs local-zipformer-en-20m some.wav [--stereo]
 *
 * --stereo duplicates the file onto channel 2 with a 1.5 s offset, which is
 * how the two-source path is exercised without a second recording.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createLocalSttStream, relayDataDir } from "../dist/index.js";

const [modelId, wav, ...flags] = process.argv.slice(2);
if (!modelId || !wav) {
  console.error("usage: node local-stt-test.mjs <local-model-id> <16k-mono.wav> [--stereo]");
  process.exit(1);
}
const stereo = flags.includes("--stereo");

const buf = fs.readFileSync(wav);
// naive RIFF parse: find the "data" chunk
let off = 12;
let pcm = null;
while (off + 8 <= buf.length) {
  const id = buf.toString("ascii", off, off + 4);
  const size = buf.readUInt32LE(off + 4);
  if (id === "data") {
    pcm = buf.subarray(off + 8, off + 8 + size);
    break;
  }
  off += 8 + size + (size % 2);
}
if (!pcm) throw new Error("no data chunk");
const mono = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);

let frames;
let channels = 1;
if (stereo) {
  channels = 2;
  const shift = 16000 * 1.5;
  const n = mono.length + shift;
  frames = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    frames[i * 2] = i < mono.length ? mono[i] : 0;
    frames[i * 2 + 1] = i >= shift ? mono[i - shift] : 0;
  }
} else {
  frames = mono;
}

const t0 = Date.now();
const stream = createLocalSttStream(
  { modelsDir: path.join(relayDataDir(), "models"), workerPath: path.resolve("packages/relay/dist/localSttWorker.js") },
  { model: modelId, language: "en", channels },
  {
    onOpen: () => console.log(`ready in ${Date.now() - t0} ms`),
    onPartial: (text, ch) => console.log(`  [ch${ch}] …${text}`),
    onFinal: (text, meta) => console.log(`FINAL [ch${meta.channel}] @${(meta.audioEndSec ?? 0).toFixed(2)}s: ${text}`),
    onError: (m) => console.error("error:", m),
    onClose: () => {
      console.log(`closed after ${Date.now() - t0} ms`);
      process.exit(0);
    },
  },
);

// feed 100 ms chunks in real time-ish (10x faster than real time keeps it quick)
const chunk = 1600 * channels;
let i = 0;
const timer = setInterval(() => {
  if (i >= frames.length) {
    clearInterval(timer);
    setTimeout(() => stream.close(), 500);
    return;
  }
  const part = frames.subarray(i, i + chunk);
  stream.sendAudio(Buffer.from(part.buffer, part.byteOffset, part.byteLength));
  i += chunk;
}, 10);
