/**
 * Do aborted installer downloads leave read streams open?
 *
 * A caller walking away mid-download is ordinary - a phone leaving wifi, an
 * updater retrying, a closed tab - and `pipe()` never destroys the source when
 * the destination goes away, so each one used to strand a descriptor. Enough of
 * them and the process hits its file limit and stops serving without crashing
 * or logging a cause.
 *
 * This has to be a separate process: it patches CJS `fs` before the relay is
 * loaded so the relay's own `createReadStream` calls are the ones counted, and
 * that property cannot be redefined on an ESM namespace from inside vitest.
 *
 *   node packages/relay/scripts/leak-probe.cjs [aborts]
 *
 * Prints "RESULT: no leak" and exits 0, or the count and exits 1.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const made = [];
const realCreate = fs.createReadStream;
fs.createReadStream = function (...args) {
  const stream = realCreate.apply(fs, args);
  made.push(stream);
  return stream;
};

const { startRelay } = require(path.join(__dirname, "..", "dist", "index.js"));

const NAME = "CalloutRelay-Setup-9.9.9.exe";
const ABORTS = Number(process.argv[2]) || 25;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-leak-probe-"));
  const updates = path.join(dir, "updates");
  fs.mkdirSync(updates, { recursive: true });
  // big enough that the stream is still live when the caller walks away
  fs.writeFileSync(path.join(updates, NAME), Buffer.alloc(16 * 1024 * 1024, 7));

  const relay = await startRelay({
    port: 0,
    dataDir: dir,
    updatesDir: updates,
    mockStt: true,
    mockGemini: true,
  });
  const url = `http://127.0.0.1:${relay.port}/updates/${NAME}`;

  for (let i = 0; i < ABORTS; i += 1) {
    const ctrl = new AbortController();
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      const reader = res.body.getReader();
      await reader.read();
      ctrl.abort();
      try {
        await reader.cancel();
      } catch {
        /* already aborted */
      }
    } catch {
      /* the abort itself */
    }
  }
  await sleep(800);

  const undestroyed = made.filter((s) => !s.destroyed);
  console.log(`aborted downloads:    ${ABORTS}`);
  console.log(`read streams created: ${made.length}`);
  console.log(`still undestroyed:    ${undestroyed.length}`);
  console.log(undestroyed.length === 0 ? "RESULT: no leak" : `RESULT: ${undestroyed.length} leaked`);

  await relay.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
  process.exit(undestroyed.length === 0 ? 0 : 1);
})();
