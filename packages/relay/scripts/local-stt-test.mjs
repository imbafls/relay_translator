/**
 * Decode a wave file through the local STT engine exactly as the app runs it
 * (worker thread + sherpa-onnx). No relay, no keys.
 *
 *   node packages/relay/scripts/local-stt-test.mjs <model-id> <file.wav> [modelsDir]
 *
 * modelsDir defaults to $CALLOUT_RELAY_DATA/models or ~/.callout-relay/models.
 * The wave must be 16 kHz mono s16le (what the app streams).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createLocalSttStream, ModelManager, SAMPLE_RATE } = require("../dist/index.js");
const { LOCAL_STT_MODELS } = require("@callout-relay/shared");

const [modelId, wav, dirArg] = process.argv.slice(2);
if (!modelId || !wav) {
  console.error("usage: local-stt-test.mjs <model-id> <file.wav> [modelsDir]");
  console.error("models:", LOCAL_STT_MODELS.map((m) => m.id).join(", "));
  process.exit(1);
}
const modelsDir =
  dirArg ||
  path.join(process.env.CALLOUT_RELAY_DATA || path.join(process.env.APPDATA || path.join(process.env.HOME || ".", ".callout-relay")), "models");

const models = new ModelManager({ modelsDir, log: (l, m) => console.log(`[${l}] ${m}`) });
const status = models.status(modelId);
console.log(`model ${modelId}: ${status.state}${status.detail ? ` (${status.detail})` : ""}${status.dir ? ` @ ${status.dir}` : ""}`);
if (status.state !== "ready") process.exit(2);

// minimal RIFF parse: assume 16-bit PCM, take the data chunk
const buf = fs.readFileSync(wav);
let off = 12;
let data = null;
let rate = SAMPLE_RATE;
let channels = 1;
while (off + 8 <= buf.length) {
  const id = buf.toString("ascii", off, off + 4);
  const size = buf.readUInt32LE(off + 4);
  if (id === "fmt ") {
    channels = buf.readUInt16LE(off + 10);
    rate = buf.readUInt32LE(off + 12);
  }
  if (id === "data") {
    data = buf.subarray(off + 8, off + 8 + size);
    break;
  }
  off += 8 + size + (size % 2);
}
if (!data) throw new Error("no data chunk");
if (rate !== SAMPLE_RATE || channels !== 1) throw new Error(`need 16 kHz mono, got ${rate} Hz x${channels}`);

const t0 = Date.now();
const stream = createLocalSttStream(
  { model: modelId, language: "en", models, log: (l, m) => console.log(`[${l}] ${m}`) },
  {
    onOpen: () => console.log(`open after ${Date.now() - t0} ms`),
    onPartial: (t) => console.log(`  … ${t}`),
    onFinal: (t, meta) => console.log(`FINAL ${JSON.stringify(t)} audioEnd=${meta?.audioEndSec?.toFixed(2)}s`),
    onError: (m) => console.log(`ERROR ${m}`),
    onClose: () => console.log("closed"),
  },
);

// pace like the app: 100 ms chunks
const step = (SAMPLE_RATE / 10) * 2;
let pos = 0;
const tick = setInterval(() => {
  if (pos >= data.length) {
    clearInterval(tick);
    // a few seconds of silence let endpointing / VAD close the last phrase
    const silence = Buffer.alloc(step);
    let n = 0;
    const tail = setInterval(() => {
      stream.sendAudio(silence);
      if (++n >= 30) {
        clearInterval(tail);
        stream.close();
        setTimeout(() => process.exit(0), 800);
      }
    }, 100);
    return;
  }
  stream.sendAudio(Buffer.from(data.subarray(pos, pos + step)));
  pos += step;
}, 100);
