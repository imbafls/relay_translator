/**
 * Exercise the deployed hosted relay the way the desktop app and a phone
 * viewer would: uplink connects, viewer connects, a caption is published, the
 * viewer receives it. This is the Durable Object runtime - hibernation,
 * acceptWebSocket, tag routing, storage - which has no local coverage.
 */
const { createRequire } = require("node:module");
const req = createRequire("C:/depot/_projects/relay/packages/relay/package.json");
const WebSocket = req("ws");

const BASE = process.argv[2];
if (!BASE) {
  console.error("usage: node scripts/verify-deploy.cjs <https://your-worker-url>");
  process.exit(1);
}
const wsBase = BASE.replace(/^https:/, "wss:");

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const seen = [];
    const closes = [];
    ws.on("message", (d) => {
      try {
        seen.push(JSON.parse(d.toString()));
      } catch {
        /* binary */
      }
    });
    ws.on("close", (code) => closes.push(code));
    ws.once("open", () => resolve({ ws, seen, closes }));
    ws.once("error", reject);
    setTimeout(() => reject(new Error("open timed out: " + url)), 15000);
  });
}

(async () => {
  // a fresh room every run: a previous run rotates the viewer token, and
  // reusing a fixture makes that success look like a failure
  const { publisherToken, viewerToken } = await fetch(`${BASE}/claim`, { method: "POST" }).then((r) => r.json());

  // 1. a bad credential must arrive as a close code, not an HTTP error
  const rid = publisherToken.split("_")[1];
  const bad = await open(`${wsBase}/ws/uplink?token=p1_${rid}_${"0".repeat(32)}`);
  await wait(1500);
  ok("bad publisher token closes with 4401", bad.closes.includes(4401), `codes=${bad.closes}`);

  // 2. the real uplink
  const up = await open(`${wsBase}/ws/uplink?token=${publisherToken}`);
  await wait(1000);
  ok("uplink is greeted with ready", up.seen.some((m) => m.type === "ready"));

  up.ws.send(
    JSON.stringify({
      type: "hello",
      languages: { source: "en", target: "vi" },
      translates: false,
      since: 1757000000000,
    }),
  );
  await wait(800);

  // 3. a viewer joining mid-stream gets the state it missed
  const view = await open(`${wsBase}/ws/viewer?token=${viewerToken}`);
  await wait(1200);
  const hello = view.seen.find((m) => m.type === "hello");
  ok("viewer receives hello on join", !!hello, hello ? `live=${hello.live}` : "");
  ok("hello carries the languages the uplink set", hello?.languages?.target === "vi");
  ok("hello reports the stream live", hello?.live === true);

  // 4. the uplink is told how many viewers are attached
  await wait(500);
  ok("uplink is told the viewer count", up.seen.some((m) => m.type === "viewers" && m.count >= 1));

  // 5. a caption reaches the viewer
  up.ws.send(
    JSON.stringify({ type: "subtitle", id: 7, source: "enemy down mid", final: true }),
  );
  await wait(1500);
  const sub = view.seen.find((m) => m.type === "subtitle");
  ok("caption reaches the viewer", !!sub, sub ? JSON.stringify(sub.source) : "");
  ok("caption keeps its segment id", sub?.id === 7);

  // 6. a wrong viewer token must not reach this room
  const badView = await open(`${wsBase}/ws/viewer?token=v1_${rid}_${"1".repeat(32)}`);
  await wait(1500);
  ok("wrong viewer token closes with 4401", badView.closes.includes(4401), `codes=${badView.closes}`);

  // 7. health now reflects a live room with a viewer
  const health = await fetch(`${BASE}/health?token=${publisherToken}`).then((r) => r.json());
  ok("per-room health reports live", health.live === true, JSON.stringify(health));
  ok("per-room health counts the viewer", health.viewers >= 1, JSON.stringify(health));

  // 8. rotation kills the old link
  const rotated = await fetch(`${BASE}/admin/rotate-viewer-token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${publisherToken}` },
  }).then((r) => r.json());
  ok("rotate issues a new viewer token", !!rotated.viewerToken && rotated.viewerToken !== viewerToken);
  await wait(1200);
  ok("rotation closes the viewers on the old link", view.closes.length > 0, `codes=${view.closes}`);

  const oldLink = await open(`${wsBase}/ws/viewer?token=${viewerToken}`).catch(() => null);
  if (oldLink) {
    await wait(1500);
    ok("the old viewer link no longer works", oldLink.closes.includes(4401), `codes=${oldLink.closes}`);
    oldLink.ws.close();
  }

  up.ws.close();
  view.ws.close();
  badView.ws.close();
  bad.ws.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS ERROR", e.message);
  process.exit(2);
});
