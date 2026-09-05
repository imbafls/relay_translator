/**
 * E2E test against the public VPS relay with REAL Deepgram + Gemini keys:
 * TTS WAV PCM -> publisher WS (internet) -> Deepgram -> Gemini -> viewer WS.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const HOST = process.env.RELAY_HOST || "127.0.0.1:8787";
const PUB = process.env.RELAY_PUBLISHER_TOKEN || "";
const VIEWER = process.env.RELAY_VIEWER_TOKEN || "";
if (!PUB || !VIEWER) {
  console.error("set RELAY_PUBLISHER_TOKEN and RELAY_VIEWER_TOKEN (and optionally RELAY_HOST)");
  process.exit(1);
}

const wavPath = process.argv[2] || path.join(process.env.TEMP, "opencode", "callouts.wav");
const wav = fs.readFileSync(wavPath);
const dataIdx = wav.indexOf("data", 12, "ascii");
const pcm = wav.subarray(dataIdx + 8);

const inbox = [];
const viewer = new WebSocket(`ws://${HOST}/ws/viewer?token=${VIEWER}`);
viewer.addEventListener("message", (e) => {
  try {
    inbox.push(JSON.parse(String(e.data)));
  } catch {}
});
viewer.addEventListener("error", (e) => console.log(`[viewer] ws error: ${e.message || e.error?.message || "unknown"}`));
viewer.addEventListener("close", (e) => console.log(`[viewer] ws close code=${e.code} reason=${e.reason}`));
await new Promise((resolve) => viewer.addEventListener("open", resolve, { once: true }));
console.log("[viewer] connected to public relay");

const t0 = Date.now();
const pub = new WebSocket(`ws://${HOST}/ws/publisher?token=${PUB}`);
pub.addEventListener("error", (e) => console.log(`[publisher] ws error: ${e.message || e.error?.message || "unknown"}`));
pub.addEventListener("close", (e) => console.log(`[publisher] ws close code=${e.code} reason=${e.reason}`));
pub.addEventListener("message", (e) => {
  const msg = JSON.parse(String(e.data));
  if (msg.type === "ready") {
    readyAt = Date.now() - t0;
    console.log(`[publisher] ready — Deepgram session open (${readyAt} ms after connect)`);
  }
  if (msg.type === "subtitle") {
    // what the desktop app's session log now shows the gamer live
    const lat = msg.latency || {};
    const tags = [];
    if (lat.stt != null) tags.push(`stt ${lat.stt}ms`);
    if (lat.translate != null) tags.push(`translate ${lat.translate}ms`);
    const tagStr = tags.length ? `  [${tags.join(", ")}]` : "";
    if (msg.target) console.log(`[app log] EN: ${msg.source}\n          VI: ${msg.target}${tagStr}`);
  }
  if (msg.type === "error") console.log(`[publisher] ERROR: ${msg.message}`);
});
await new Promise((resolve) => pub.addEventListener("open", resolve, { once: true }));
let readyAt = 0;
pub.send(
  JSON.stringify({
    type: "hello",
    stt: "deepgram-nova-3",
    translation: process.argv[3] || "gemini-3.1-flash-lite",
    languages: { source: "en", target: "vi" },
  }),
);

// pace the WAV in 100ms chunks (16 kHz s16le mono = 3200 B per 100ms)
const CHUNK = 3200;
let off = 0;
const stream = setInterval(() => {
  if (off >= pcm.length) {
    clearInterval(stream);
    return;
  }
  pub.send(pcm.subarray(off, Math.min(off + CHUNK, pcm.length)));
  off += CHUNK;
}, 100);

// wait for translated subtitles
const deadline = Date.now() + 45000;
let done = false;
while (!done && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  const subs = inbox.filter((m) => m.type === "subtitle" && m.target);
  if (subs.length >= 2) done = true;
}
clearInterval(stream);
pub.close();
viewer.close();

const subs = inbox.filter((m) => m.type === "subtitle");
const translated = subs.filter((m) => m.target);
console.log(`\n${subs.length} subtitle(s), ${translated.length} translated:`);
for (const s of translated) {
  console.log(`  EN: ${s.source}`);
  console.log(`  VI: ${s.target}`);
  console.log();
}
if (translated.length === 0) {
  console.error("FAIL: no translated subtitles through the public relay");
  process.exit(1);
}
console.log("PUBLIC INTERNET E2E PASSED");
