/**
 * Does a WebSocket text frame that parses to something other than an object
 * make the relay throw?
 *
 * `JSON.parse("null")` succeeds and the property read after it does not. The
 * standalone server has an uncaughtException handler, so the process survives
 * either way - which means "still alive" proves nothing. This looks for the
 * throw itself, in the server's stderr.
 *
 * It must be a separate process: vitest installs its own handlers, and the
 * embedded relay inside the desktop app has no backstop at all, so a throw
 * here is a dead app there.
 *
 *   node packages/relay/scripts/frame-probe.cjs
 *
 * Prints "RESULT: nothing threw" and exits 0, or the error and exits 1.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const cli = path.join(__dirname, "..", "dist", "cli.js");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-frame-probe-"));
const PORT = 8903;

const child = spawn(process.execPath, [cli], {
  env: {
    ...process.env,
    RELAY_PORT: String(PORT),
    CALLOUT_RELAY_DATA: dataDir,
    RELAY_MOCK_STT: "1",
    RELAY_MOCK_GEMINI: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let exited = null;
let stderr = "";
child.stderr.on("data", (b) => {
  stderr += b.toString();
});
child.on("exit", (code, sig) => {
  exited = { code, sig };
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** frames that parse cleanly but are not objects */
const BODIES = ["null", "123", '"a string"', "[]", "true"];

function sendFrame(target, frame) {
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${PORT}${target}`);
    } catch {
      return resolve();
    }
    const done = () => {
      try {
        ws.close();
      } catch {
        /* gone */
      }
      resolve();
    };
    const timer = setTimeout(done, 3000);
    ws.on("open", () => {
      ws.send(frame);
      setTimeout(() => {
        clearTimeout(timer);
        done();
      }, 250);
    });
    ws.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

(async () => {
  await sleep(2500);
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, "relay-state.json"), "utf8"));
  const roles = [
    ["publisher", `/ws/publisher?token=${state.publisherToken}`],
    ["uplink", `/ws/uplink?token=${state.publisherToken}`],
    ["viewer", `/ws/viewer?token=${state.viewerToken}`],
  ];

  for (const [, target] of roles) {
    for (const body of BODIES) {
      await sendFrame(target, body);
      if (exited) break;
    }
    if (exited) break;
  }
  await sleep(400);

  const idx = stderr.indexOf("uncaught:");
  const threw = idx >= 0 ? stderr.slice(idx, idx + 140).split(String.fromCharCode(10))[0] : null;

  console.log(`roles probed:  ${roles.length}`);
  console.log(`frames each:   ${BODIES.length}`);
  console.log(`process:       ${exited ? `EXITED ${JSON.stringify(exited)}` : "alive"}`);
  console.log(`threw:         ${threw || "no"}`);
  const clean = !exited && !threw;
  console.log(clean ? "RESULT: nothing threw" : "RESULT: the relay threw on a frame");

  try {
    child.kill();
  } catch {
    /* already gone */
  }
  await sleep(300);
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
  process.exit(clean ? 0 : 1);
})();
