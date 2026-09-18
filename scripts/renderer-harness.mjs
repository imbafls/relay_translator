/**
 * Look at the desktop renderer in a browser, without Electron.
 *
 *   pnpm --filter @callout-relay/standalone build     # produces dist/renderer
 *   node scripts/renderer-harness.mjs                 # http://127.0.0.1:8791
 *
 * It serves the REAL built renderer - the same `index.html`, `style.css` and
 * `app.js` the app loads - with a stand-in for the `cr` bridge that Electron's
 * preload normally provides. Tests run this markup under happy-dom, which does
 * not paint; this is for the things only a rendering engine shows you, like a
 * row that overflows or a control that has quietly gone the wrong colour.
 *
 * It lives in `scripts/` on purpose. The previous one lived in
 * `apps/standalone/dist/harness/`, which is gitignored build output, so it was
 * never committed and disappeared the first time anything cleaned `dist/` -
 * taking with it the only way the protocol offers to look at the UI. Anything
 * a person is told to run belongs somewhere a build cannot delete.
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.resolve(here, "..", "apps", "standalone", "dist", "renderer");
const PORT = Number(process.env.HARNESS_PORT || 8791);

if (!fs.existsSync(path.join(renderer, "index.html"))) {
  console.error(`no built renderer at ${renderer}`);
  console.error("run: pnpm --filter @callout-relay/standalone build");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Enough of the preload bridge for the page to boot and hold still.
 *
 * Every method the renderer can call is present, because one missing name is a
 * TypeError during boot and a blank window - which looks exactly like the
 * layout bug you came to look at.
 */
const STUB = `
window.cr = (() => {
  const noop = () => {};
  const config = {
    setupDone: true, languages: { source: "en", target: "vi" }, output: "phone",
    stt: "deepgram-nova-3", translation: "gemini-3.1-flash-lite", sources: ["mic"],
    deepgramApiKey: "dg-harness", geminiApiKey: "gm-harness", saveTranscripts: true,
    autoUpdate: true, translationEnabled: true, latencyVisible: true,
  };
  const saved = [
    { id: "2026-09-15T101500", startedAt: Date.parse("2026-09-15T10:15:00Z"),
      endedAt: Date.parse("2026-09-15T10:41:00Z"), lines: 657, bytes: 81920 },
  ];
  return {
    getConfig: async () => config,
    setConfig: async (patch) => Object.assign(config, patch),
    prepareSession: async () => ({ ok: true }),
    publisherUrl: async () => "ws://127.0.0.1:8787/ws/publisher?token=harness",
    viewerUrl: async () => "http://127.0.0.1:8787/watch/harness",
    obsUrl: async () => "http://127.0.0.1:8787/watch/harness?obs=1",
    phoneUrl: async () => undefined,
    config: async () => config,
    // ?rotate=unchanged|unknown|refused shows what NEW says when the relay did
    // not confirm a new internet link; the default is a rotation that worked
    rotateLink: async () => ({
      remote: new URLSearchParams(location.search).get("rotate") || "rotated",
      reason: "textrelay.cc could not replace the link (500)",
      url: "http://127.0.0.1:8787/watch/rotated",
    }),
    claimRelayRoom: async () => ({ relayUrl: "", publisherToken: "" }),
    validateKey: async () => ({ valid: true }),
    checkForUpdate: async () => noop(),
    installUpdate: async () => noop(),
    onUpdate: noop,
    openExternal: noop,
    writeClipboard: async () => noop(),
    appVersion: async () => "0.8.1",
    reportState: noop,
    reportDevices: noop,
    modelStatus: async () => [],
    downloadModel: async () => [],
    cancelModel: async () => [],
    removeModel: async () => [],
    onCommand: noop,
    onConfigChanged: noop,
    onStatus: noop,
    readRelayLog: async () => "[info] harness - nothing real was logged here",
    sendFeedback: async () => ({ delivered: true, id: "harness00000000", logFailed: false }),
    listTranscripts: async () => saved,
    readTranscript: async () => ({ id: saved[0].id, rows: [], header: undefined }),
    exportTranscript: async () => "C:\\\\Transcripts\\\\harness.txt",
    revealTranscript: async () => noop(),
    deleteTranscript: async () => true,
    chooseTranscriptDir: async () => undefined,
    openTranscriptDir: async () => noop(),
  };
})();
`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);

  if (rel === "cr-stub.js") {
    res.writeHead(200, { "Content-Type": MIME[".js"] });
    res.end(STUB);
    return;
  }

  // no traversal out of the built renderer
  const file = path.join(renderer, rel);
  if (!file.startsWith(renderer) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "Content-Type": MIME[".txt"] });
    res.end(`not in the built renderer: ${rel}`);
    return;
  }

  if (rel === "index.html") {
    // the stub has to be in place before app.js runs, or the page boots
    // against an undefined bridge and shows nothing
    const html = fs
      .readFileSync(file, "utf8")
      .replace(/<script/i, '<script src="/cr-stub.js"></script>\n  <script');
    res.writeHead(200, { "Content-Type": MIME[".html"] });
    res.end(html);
    return;
  }

  res.writeHead(200, { "Content-Type": MIME[path.extname(rel).toLowerCase()] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
});

// the designated port or nothing: falling back to another one is how you end
// up looking at a page that is not the one you think it is
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`port ${PORT} is already held - find what has it rather than using another port`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`renderer harness on http://127.0.0.1:${PORT}  (serving ${path.relative(process.cwd(), renderer)})`);
});
