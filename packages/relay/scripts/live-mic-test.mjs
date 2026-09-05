/* Live mic E2E: collect subtitles from the public relay like the friend's phone. */
const HOST = process.env.RELAY_HOST || "127.0.0.1:8787";
const VIEWER = process.env.RELAY_VIEWER_TOKEN || "";
const SECONDS = Number(process.argv[2] || 50);
if (!VIEWER) {
  console.error("set RELAY_VIEWER_TOKEN (and optionally RELAY_HOST)");
  process.exit(1);
}

const t0 = Date.now();
const events = [];
const segFirstSeen = new Map();
let partials = 0;

const viewer = new WebSocket(`ws://${HOST}/ws/viewer?token=${VIEWER}`);
viewer.onmessage = (e) => {
  let m;
  try {
    m = JSON.parse(String(e.data));
  } catch {
    return;
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (m.type === "partial") {
    partials += 1;
    return;
  }
  if (m.type === "subtitle") {
    if (!segFirstSeen.has(m.id)) segFirstSeen.set(m.id, Date.now());
    if (m.target && !segFirstSeen.has("t" + m.id)) {
      segFirstSeen.set("t" + m.id, Date.now());
      const latency = ((segFirstSeen.get("t" + m.id) - segFirstSeen.get(m.id)) / 1000).toFixed(2);
      console.log(`[${dt}s] (+${latency}s translate)  EN: ${m.source}`);
      console.log(`         VI: ${m.target}`);
    } else if (!m.target) {
      console.log(`[${dt}s] (source…)     EN: ${m.source}`);
    }
    events.push({ dt, ...m });
  }
};

await new Promise((r, j) => {
  viewer.onopen = r;
  viewer.onerror = j;
});
console.log(`viewer connected — collecting ${SECONDS}s…\n`);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
viewer.close();

const translated = events.filter((m) => m.target);
console.log(`\n--- RESULT: ${events.length} finals, ${translated.length} translated, ${partials} partials ---`);
if (translated.length > 0) process.exit(0);
process.exit(1);
