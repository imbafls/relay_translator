/**
 * Relay smoke test (no API keys needed - mock STT + mock Gemini).
 * Verifies: static viewer page, token auth, single-connection kick,
 * publisher hello, subtitle pipeline (source + translation), link rotate.
 */
import { startRelay } from "../dist/index.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const failures = [];
const ok = (name) => console.log(`  PASS  ${name}`);
const fail = (name, detail) => {
  failures.push(name);
  console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
};

async function expectMsg(ws, type, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${type}"`)), timeoutMs);
    const onMsg = (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === type) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMsg);
        resolve(msg);
      }
    };
    ws.addEventListener("message", onMsg);
  });
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "callout-relay-smoke-"));
const handle = await startRelay({
  port: 0,
  dataDir,
  mockStt: true,
  mockGemini: true,
});

const { publisherToken, viewerToken } = handle.state;
const base = `http://127.0.0.1:${handle.port}`;
console.log(`relay on ${base}`);

// 1. health + viewer page
{
  const health = await (await fetch(`${base}/health`)).json();
  health.ok ? ok("health endpoint") : fail("health endpoint", JSON.stringify(health));
  const page = await fetch(`${base}/watch/${viewerToken}`);
  const html = await page.text();
  page.ok && html.includes("<title>Relay</title>")
    ? ok("viewer page served")
    : fail("viewer page served", `status ${page.status}`);
  const bad = await fetch(`${base}/watch/not-the-token`);
  bad.status === 200 && (await bad.text()).includes("<title>Relay</title>")
    ? ok("viewer page serves any path (token enforced at WS)")
    : fail("viewer page serves any path (token enforced at WS)");
}

// 2. publisher with bad token is rejected
{
  let rejected = false;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/publisher?token=wrong`);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => {
        rejected = true;
        rej(new Error("rejected"));
      };
    });
  } catch {
    rejected = true;
  }
  rejected ? ok("publisher token auth rejects bad token") : fail("publisher token auth rejects bad token");
}

// 3. viewer connects, receives hello
const viewer = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/viewer?token=${viewerToken}`);
await new Promise((res, rej) => {
  viewer.onopen = res;
  viewer.onerror = rej;
});
{
  const hello = await expectMsg(viewer, "hello");
  hello.languages && typeof hello.live === "boolean"
    ? ok("viewer hello (languages + live)")
    : fail("viewer hello (languages + live)", JSON.stringify(hello));
}

// 4. second viewer with same token kicks the first
let viewer2;
{
  const kickedPromise = expectMsg(viewer, "kicked");
  viewer2 = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/viewer?token=${viewerToken}`);
  await new Promise((res) => (viewer2.onopen = res));
  try {
    const kicked = await kickedPromise;
    kicked.reason ? ok("single-connection kick (viewer)") : fail("single-connection kick (viewer)");
  } catch (e) {
    fail("single-connection kick (viewer)", e.message);
  }
}

// 5. publisher session -> subtitles with mock translation
{
  const pub = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/publisher?token=${publisherToken}`);
  await new Promise((res, rej) => {
    pub.onopen = res;
    pub.onerror = rej;
  });
  pub.send(
    JSON.stringify({
      type: "hello",
      stt: "deepgram-nova-3",
      translation: "gemini-2.5-flash",
      languages: { source: "en", target: "vi" },
    }),
  );
  const ready = await expectMsg(pub, "ready");
  ready.sampleRate === 16000 ? ok("publisher ready (16 kHz)") : fail("publisher ready (16 kHz)");

  // viewer should see hello again (languages from publisher)
  const vHello = await expectMsg(viewer2, "hello");
  vHello.languages.source === "en" && vHello.languages.target === "vi"
    ? ok("viewer languages sync from publisher hello")
    : fail("viewer languages sync from publisher hello", JSON.stringify(vHello));

  // collect everything the viewer receives while we stream audio
  const inbox = [];
  const collector = (ev) => {
    try {
      inbox.push(JSON.parse(String(ev.data)));
    } catch {
      /* ignore */
    }
  };
  viewer2.addEventListener("message", collector);

  // stream 6s of near-silence PCM (mock emits a line every 2s of audio)
  const silence = Buffer.alloc(3200, 0); // 100ms of s16le 16k
  const stream = setInterval(() => pub.send(silence), 100);
  await new Promise((r) => setTimeout(r, 5500));
  clearInterval(stream);
  viewer2.removeEventListener("message", collector);

  const subs = inbox.filter((m) => m.type === "subtitle");
  const withSource = subs.find((m) => m.source);
  withSource
    ? ok("subtitle source delivered")
    : fail("subtitle source delivered", JSON.stringify(inbox.map((m) => m.type)));

  const translated = subs.find((m) => m.target && m.target.startsWith("[vi]"));
  translated
    ? ok("translation delivered (mock)")
    : fail("translation delivered (mock)", JSON.stringify(subs));

  pub.close();
}

// 6. local STT: a model that is not on disk fails loudly to the publisher
{
  const local = await startRelay({ port: 0, dataDir, mockGemini: true, modelsDir: path.join(dataDir, "no-models") });
  const pub = new WebSocket(`ws://127.0.0.1:${local.port}/ws/publisher?token=${local.state.publisherToken}`);
  await new Promise((res, rej) => {
    pub.onopen = res;
    pub.onerror = rej;
  });
  const errPromise = expectMsg(pub, "error", 4000);
  pub.send(
    JSON.stringify({
      type: "hello",
      stt: "local-zipformer-en-20m",
      translation: "gemini-2.5-flash",
      languages: { source: "en", target: "vi" },
      translationEnabled: false,
    }),
  );
  try {
    const err = await errPromise;
    /not downloaded/.test(err.message)
      ? ok("local model missing -> publisher error")
      : fail("local model missing -> publisher error", JSON.stringify(err));
  } catch (e) {
    fail("local model missing -> publisher error", e.message);
  }
  const statuses = local.models.statuses();
  statuses.length > 0 && statuses.every((m) => m.state === "missing")
    ? ok("model catalog reports missing models")
    : fail("model catalog reports missing models", JSON.stringify(statuses.slice(0, 2)));
  pub.close();
  await local.close();
}

// 7. local STT end to end - only when a model folder is provided
//    CALLOUT_LOCAL_STT_MODEL_DIR=<models dir> CALLOUT_LOCAL_STT_MODEL=<id> pnpm smoke
if (process.env.CALLOUT_LOCAL_STT_MODEL_DIR) {
  const modelId = process.env.CALLOUT_LOCAL_STT_MODEL || "local-zipformer-en-20m";
  const local = await startRelay({ port: 0, dataDir, mockGemini: true, modelsDir: process.env.CALLOUT_LOCAL_STT_MODEL_DIR });
  const st = local.models.status(modelId);
  if (st.state !== "ready") {
    fail("local STT end to end", `${modelId} is ${st.state} in ${process.env.CALLOUT_LOCAL_STT_MODEL_DIR}`);
  } else {
    const pub = new WebSocket(`ws://127.0.0.1:${local.port}/ws/publisher?token=${local.state.publisherToken}`);
    await new Promise((res, rej) => {
      pub.onopen = res;
      pub.onerror = rej;
    });
    pub.send(
      JSON.stringify({ type: "hello", stt: modelId, translation: "x", languages: { source: "en", target: "vi" }, translationEnabled: false }),
    );
    await expectMsg(pub, "ready");
    const wav = process.env.CALLOUT_LOCAL_STT_WAV;
    const pcm = wav ? fs.readFileSync(wav).subarray(44) : Buffer.alloc(16000 * 2 * 4);
    const got = expectMsg(pub, "subtitle", 20000);
    let pos = 0;
    const tick = setInterval(() => {
      if (pos >= pcm.length) {
        pub.send(Buffer.alloc(3200));
        return;
      }
      pub.send(pcm.subarray(pos, pos + 3200));
      pos += 3200;
    }, 100);
    try {
      const sub = await got;
      sub.source ? ok(`local STT end to end (${modelId}: "${sub.source}")`) : fail("local STT end to end", JSON.stringify(sub));
    } catch (e) {
      fail("local STT end to end", e.message);
    }
    clearInterval(tick);
    pub.close();
  }
  await local.close();
} else {
  console.log("  SKIP  local STT end to end (set CALLOUT_LOCAL_STT_MODEL_DIR)");
}

// 8. link rotate: old viewer token dies
{
  const res = await fetch(`${base}/admin/rotate-viewer-token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${publisherToken}` },
  });
  const { viewerToken: newToken } = await res.json();
  newToken && newToken !== viewerToken
    ? ok("admin rotate-viewer-token")
    : fail("admin rotate-viewer-token");
  const denied = await fetch(`${base}/admin/rotate-viewer-token`, {
    method: "POST",
    headers: { Authorization: "Bearer nope" },
  });
  denied.status === 403 ? ok("admin endpoint auth") : fail("admin endpoint auth");
}

await handle.close();
fs.rmSync(dataDir, { recursive: true, force: true });

console.log(failures.length === 0 ? "\nALL SMOKE TESTS PASSED" : `\n${failures.length} FAILURE(S)`);
process.exit(failures.length === 0 ? 0 : 1);

