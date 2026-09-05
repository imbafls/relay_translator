/**
 * Real-API pipeline test: TTS WAV -> Deepgram streaming STT -> Gemini translate.
 * Uses keys from repo root .env (DEEPGRAM_API_KEY / GEMINI_API_KEY).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { createDeepgramStream } from "../dist/deepgram.js";
import { createGeminiTranslator } from "../dist/gemini.js";
import { tryLoadDotenv } from "../dist/config.js";

const scriptDir = path.dirname(url.fileURLToPath(import.meta.url));
tryLoadDotenv([path.resolve(scriptDir, "..", "..", "..")]);

const wavPath = process.argv[2] || path.join(process.env.TEMP || ".", "opencode", "callouts.wav");
const wav = fs.readFileSync(wavPath);
// find the data chunk (44-byte canonical header from System.Speech)
const dataIdx = wav.indexOf("data", 12, "ascii");
const pcm = wav.subarray(dataIdx + 8);

const DEEPGRAM = process.env.DEEPGRAM_API_KEY;
const GEMINI = process.env.GEMINI_API_KEY;
if (!DEEPGRAM || !GEMINI) {
  console.error("missing DEEPGRAM_API_KEY / GEMINI_API_KEY");
  process.exit(1);
}

const finals = [];
const stt = createDeepgramStream(
  { apiKey: DEEPGRAM, model: "deepgram-nova-3", language: "en" },
  {
    onOpen: () => console.log("[stt] connected"),
    onPartial: (t) => console.log(`[stt partial] ${t}`),
    onFinal: (t) => {
      console.log(`[stt FINAL] ${t}`);
      finals.push(t);
    },
    onError: (m) => console.log(`[stt error] ${m}`),
    onClose: () => console.log("[stt] closed"),
  },
);

const CHUNK = 3200; // 100 ms
for (let off = 0; off < pcm.length; off += CHUNK) {
  stt.sendAudio(pcm.subarray(off, Math.min(off + CHUNK, pcm.length)));
  await new Promise((r) => setTimeout(r, 25)); // ~4x realtime-ish pacing
}
console.log("[stt] audio sent; draining…");
await new Promise((r) => setTimeout(r, 3000));
stt.close();

if (finals.length === 0) {
  console.error("NO TRANSCRIPTS");
  process.exit(1);
}

const t0 = Date.now();
const translator = createGeminiTranslator({
  apiKey: GEMINI,
  model: "gemini-2.5-flash",
  source: "en",
  target: "vi",
});
const text = finals.join(" ");
const vi = await translator.translate(text);
console.log(`\n[gemini] (${Date.now() - t0} ms) en->vi:`);
console.log(`  EN: ${text}`);
console.log(`  VI: ${vi}`);
