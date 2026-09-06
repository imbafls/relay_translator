/**
 * Two streamers at once - the thing the single-tenant relay could not do.
 *
 * On packages/relay this is impossible by construction: one `publisher` slot,
 * and the second connection evicts the first. Here each room is its own
 * Durable Object, so the test is whether that isolation is real end to end:
 * neither uplink is disturbed by the other, and no caption crosses.
 */
const { createRequire } = require("node:module");
const req = createRequire("C:/depot/_projects/relay/packages/relay/package.json");
const WebSocket = req("ws");

const BASE = process.argv[2];
const wsBase = BASE.replace(/^https:/, "wss:");

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass });
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
    ws.on("close", (c) => closes.push(c));
    ws.once("open", () => resolve({ ws, seen, closes }));
    ws.once("error", reject);
    setTimeout(() => reject(new Error("timed out opening " + url)), 15000);
  });
}

const claim = () => fetch(`${BASE}/claim`, { method: "POST" }).then((r) => r.json());

(async () => {
  const a = await claim();
  const b = await claim();
  ok("two claims produce two different rooms", a.publisherToken.split("_")[1] !== b.publisherToken.split("_")[1]);

  const upA = await open(`${wsBase}/ws/uplink?token=${a.publisherToken}`);
  const upB = await open(`${wsBase}/ws/uplink?token=${b.publisherToken}`);
  await wait(1000);

  // the single-tenant relay would have evicted one of these
  ok("both uplinks stay connected", upA.closes.length === 0 && upB.closes.length === 0,
     `A closes=${upA.closes} B closes=${upB.closes}`);

  upA.ws.send(JSON.stringify({ type: "hello", languages: { source: "en", target: "vi" }, translates: false }));
  upB.ws.send(JSON.stringify({ type: "hello", languages: { source: "en", target: "ja" }, translates: false }));
  await wait(800);

  const viewA = await open(`${wsBase}/ws/viewer?token=${a.viewerToken}`);
  const viewB = await open(`${wsBase}/ws/viewer?token=${b.viewerToken}`);
  await wait(1200);

  // the languages singleton was one of the old relay's cross-tenant hazards
  ok("each viewer gets its own room's languages",
     viewA.seen.find((m) => m.type === "hello")?.languages?.target === "vi" &&
     viewB.seen.find((m) => m.type === "hello")?.languages?.target === "ja");

  upA.ws.send(JSON.stringify({ type: "subtitle", id: 1, source: "ROOM-A-SECRET", final: true }));
  upB.ws.send(JSON.stringify({ type: "subtitle", id: 1, source: "ROOM-B-SECRET", final: true }));
  await wait(1800);

  const textA = JSON.stringify(viewA.seen);
  const textB = JSON.stringify(viewB.seen);
  ok("room A's viewer sees room A's caption", textA.includes("ROOM-A-SECRET"));
  ok("room B's viewer sees room B's caption", textB.includes("ROOM-B-SECRET"));
  ok("room A's caption never reaches room B", !textB.includes("ROOM-A-SECRET"));
  ok("room B's caption never reaches room A", !textA.includes("ROOM-B-SECRET"));

  // a credential for one room must not open another
  const cross = await open(`${wsBase}/ws/viewer?token=${a.viewerToken.split("_")[0]}_${b.publisherToken.split("_")[1]}_${a.viewerToken.split("_")[2]}`).catch(() => null);
  if (cross) {
    await wait(1500);
    ok("room A's secret cannot open room B", cross.closes.includes(4401), `codes=${cross.closes}`);
    cross.ws.close();
  }

  // each room reports only its own viewers
  const hA = await fetch(`${BASE}/health?token=${a.publisherToken}`).then((r) => r.json());
  const hB = await fetch(`${BASE}/health?token=${b.publisherToken}`).then((r) => r.json());
  ok("each room counts only its own viewers", hA.viewers === 1 && hB.viewers === 1,
     `A=${JSON.stringify(hA)} B=${JSON.stringify(hB)}`);

  for (const s of [upA, upB, viewA, viewB]) s.ws.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS ERROR", e.message);
  process.exit(2);
});
