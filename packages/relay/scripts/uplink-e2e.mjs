/**
 * Full production-path test: local relay (app pipeline) -> uplink -> VPS viewer.
 * Streams a WAV as the publisher to the LOCAL embedded relay, checks that a
 * viewer connected to the VPS receives the uplinked subtitles.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const DATA = path.join(process.env.APPDATA || "", "callout-relay");
const LOCAL_STATE = path.join(DATA, "relay-state.json");
const { publisherToken: LOCAL_PUB, viewerToken: LOCAL_VIEWER } = JSON.parse(fs.readFileSync(LOCAL_STATE, "utf8"));

// the remote relay and its viewer token come from the app's own config, so this
// script never carries a copy of either (tokens rotate; a committed one goes stale)
const cfg = JSON.parse(fs.readFileSync(path.join(DATA, "config.json"), "utf8"));
const RELAY_URL = process.env.RELAY_URL || cfg.relayUrl;
const VPS_VIEWER = process.env.RELAY_VIEWER_TOKEN || cfg.viewerToken;
if (!RELAY_URL || !VPS_VIEWER) {
  console.error("set relayUrl + viewerToken in the app (KEYS), or pass RELAY_URL / RELAY_VIEWER_TOKEN");
  process.exit(1);
}

const wavPath = process.argv[2] || path.join(process.env.TEMP, "opencode", "callouts.wav");
const wav = fs.readFileSync(wavPath);
const dataIdx = wav.indexOf("data", 12, "ascii");
const pcm = wav.subarray(dataIdx + 8);

// local viewer (sanity: local pipeline works)
const localInbox = [];
const localViewer = new WebSocket(`ws://127.0.0.1:8787/ws/viewer?token=${LOCAL_VIEWER}`);
localViewer.addEventListener("message", (e) => {
  try {
    localInbox.push(JSON.parse(String(e.data)));
  } catch {}
});
await new Promise((r, j) => {
  localViewer.addEventListener("open", r, { once: true });
  localViewer.addEventListener("error", j, { once: true });
});

// remote viewer (the friend's phone)
const remoteInbox = [];
const remoteViewer = new WebSocket(`${RELAY_URL.replace(/\/$/, "")}/ws/viewer?token=${VPS_VIEWER}`);
remoteViewer.addEventListener("message", (e) => {
  try {
    remoteInbox.push(JSON.parse(String(e.data)));
  } catch {}
});
await new Promise((r, j) => {
  remoteViewer.addEventListener("open", r, { once: true });
  remoteViewer.addEventListener("error", j, { once: true });
});
console.log("[viewers] local + VPS viewer connected");

// publisher -> LOCAL relay (exactly what the app's renderer does)
const pub = new WebSocket(`ws://127.0.0.1:8787/ws/publisher?token=${LOCAL_PUB}`);
await new Promise((r, j) => {
  pub.addEventListener("open", r, { once: true });
  pub.addEventListener("error", j, { once: true });
});
pub.send(
  JSON.stringify({
    type: "hello",
    stt: "deepgram-nova-3",
    translation: "gemini-3.1-flash-lite",
    languages: { source: "en", target: "vi" },
    translationEnabled: true,
    latencyVisible: true,
  }),
);
console.log("[publisher] streaming to LOCAL relay (app pipeline)");

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

// wait for remote translations
const deadline = Date.now() + 60000;
let translated = 0;
while (translated < 2 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  translated = remoteInbox.filter((m) => m.type === "subtitle" && m.target).length;
}
clearInterval(stream);
pub.close();
localViewer.close();
remoteViewer.close();

const remoteSubs = remoteInbox.filter((m) => m.type === "subtitle" && m.target);
console.log(`\nVPS viewer got ${remoteSubs.length} translated subtitle(s) via uplink:`);
for (const s of remoteSubs.slice(0, 4)) {
  console.log(`  EN: ${s.source}`);
  console.log(`  VI: ${s.target}`);
  const lat = s.latency || {};
  if (lat.stt != null || lat.translate != null)
    console.log(`      [stt ${lat.stt ?? "-"}ms, translate ${lat.translate ?? "-"}ms]`);
}
if (remoteSubs.length === 0) {
  console.error("FAIL: no subtitles reached the VPS viewer through the uplink");
  process.exit(1);
}
console.log("\nLOCAL-FIRST PIPELINE PASSED (local STT -> uplink -> VPS viewer)");
