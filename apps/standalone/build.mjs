import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";

const viewerPublic = path.resolve(import.meta.dirname, "..", "..", "packages", "viewer", "public");

/** copy the viewer page next to the bundled main (served by the embedded relay) */
const copyViewer = {
  name: "copy-viewer",
  setup(b) {
    b.onEnd(() => {
      mkdirSync("dist/viewer", { recursive: true });
      cpSync(viewerPublic, "dist/viewer", { recursive: true });
    });
  },
};

// sherpa-onnx is a native addon that loads its platform package by path at
// runtime, so it stays a real node_modules dependency (see asarUnpack)
const NATIVE = ["sherpa-onnx-node", "sherpa-onnx-*"];

// main process: fully self-contained (companion + relay + ws bundled in)
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "dist/main.js",
  // electron-updater reads app-update.yml at runtime and ships as a real
  // node_modules package; bundling it breaks that lookup
  external: ["electron", "electron-updater", "bufferutil", "utf-8-validate", ...NATIVE],
  plugins: [copyViewer],
  sourcemap: false,
  logLevel: "warning",
});

// local STT worker thread: found by main.js as dist/localStt-worker.js
await build({
  entryPoints: ["../../packages/relay/src/localStt/worker.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "dist/localStt-worker.js",
  external: [...NATIVE],
  sourcemap: false,
  logLevel: "warning",
});

await build({
  entryPoints: ["src/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "dist/preload.js",
  external: ["electron"],
  sourcemap: false,
  logLevel: "warning",
});

await build({
  entryPoints: ["renderer/app.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome126",
  outfile: "dist/renderer/app.js",
  sourcemap: false,
  logLevel: "warning",
});

mkdirSync("dist/renderer", { recursive: true });
cpSync("renderer/index.html", "dist/renderer/index.html");
cpSync("renderer/style.css", "dist/renderer/style.css");
// self-hosted fonts are shared with the viewer page (single source of truth)
cpSync(path.join(viewerPublic, "fonts"), "dist/renderer/fonts", { recursive: true });

console.log("standalone built -> dist (main.js, preload.js, renderer/, viewer/)");
