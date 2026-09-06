/**
 * Hold one room open the way a real stream does, so its billed Durable Object
 * duration can be read afterwards.
 *
 * This exists because the cost question cannot be answered by reading code.
 * Cloudflare bills a Durable Object for wall-clock duration while it holds an
 * accepted WebSocket, and hibernation is supposed to mean a room is evicted
 * between messages and billed only when it runs. Whether that is what actually
 * happens for a room with a live uplink and a viewer attached is the whole
 * premise of hosting other people for nothing, and it had never been checked.
 *
 *   node scripts/measure-cost.cjs https://relay.supr.systems <minutes>
 *
 * It claims a room, attaches an uplink and a viewer, and publishes a caption
 * every few seconds at roughly the rate a real session produces them. It prints
 * the room id and the exact UTC window to read back, because the analytics are
 * queried per object and per time range.
 */
const { createRequire } = require("node:module");
const req = createRequire(require("node:path").join(__dirname, "..", "..", "..", "packages", "relay", "package.json"));
const WebSocket = req("ws");

const BASE = process.argv[2];
const MINUTES = Number(process.argv[3] || 20);
if (!BASE) {
  console.error("usage: node scripts/measure-cost.cjs <https://host> [minutes]");
  process.exit(1);
}
const wsBase = BASE.replace(/^https:/, "wss:");

/** a real session produces a caption every couple of seconds while people talk */
const CAPTION_EVERY_MS = 2500;
const LINES = [
  "enemy down mid, rotate now",
  "one on A site, watching the angle",
  "save it, they have ops",
  "rush B, don't stop",
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

(async () => {
  const claimed = await (await fetch(`${BASE}/claim`, { method: "POST" })).json();
  if (!claimed?.publisherToken || !claimed?.viewerToken) {
    console.error("claim failed:", JSON.stringify(claimed));
    process.exit(1);
  }
  const rid = String(claimed.publisherToken).split("_")[1] || "unknown";

  const uplink = await open(`${wsBase}/ws/uplink?token=${claimed.publisherToken}`);
  uplink.send(
    JSON.stringify({
      type: "hello",
      languages: { source: "en", target: "vi" },
      translates: true,
    }),
  );
  const viewer = await open(`${wsBase}/ws/viewer?token=${claimed.viewerToken}`);

  let received = 0;
  viewer.on("message", (d) => {
    try {
      if (JSON.parse(d.toString()).type === "subtitle") received += 1;
    } catch {
      /* not a subtitle */
    }
  });

  const startedAt = new Date();
  console.log(`room        ${rid}`);
  console.log(`viewer link ${BASE}/watch/${claimed.viewerToken}`);
  console.log(`started     ${startedAt.toISOString()}`);
  console.log(`holding for ${MINUTES} minutes, a caption every ${CAPTION_EVERY_MS / 1000}s`);

  const until = Date.now() + MINUTES * 60_000;
  let sent = 0;
  while (Date.now() < until) {
    uplink.send(
      JSON.stringify({
        type: "subtitle",
        id: sent + 1,
        source: LINES[sent % LINES.length],
        target: `[vi] ${LINES[sent % LINES.length]}`,
        final: true,
      }),
    );
    sent += 1;
    await wait(CAPTION_EVERY_MS);
  }

  const endedAt = new Date();
  uplink.close();
  viewer.close();

  console.log(`ended       ${endedAt.toISOString()}`);
  console.log(`sent        ${sent} captions`);
  console.log(`received    ${received} at the viewer`);
  console.log(
    `\nRead the billed duration for this window with:\n` +
      `  node scripts/read-cost.cjs ${startedAt.toISOString()} ${endedAt.toISOString()}`,
  );
})().catch((err) => {
  console.error("measurement failed:", err?.message || err);
  process.exit(1);
});
