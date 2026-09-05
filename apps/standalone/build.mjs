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
  external: ["electron", "electron-updater", "bufferutil", "utf-8-validate", "sherpa-onnx-node"],
  plugins: [copyViewer],
  sourcemap: false,
  logLevel: "warning",
});

// local STT worker: its own file because worker_threads loads it by path;
// sherpa-onnx-node stays a real node_modules package (native addon + DLLs)
await build({
  entryPoints: [path.resolve(import.meta.dirname, "..", "..", "packages", "relay", "src", "localSttWorker.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "dist/localSttWorker.js",
  external: ["sherpa-onnx-node"],
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

console.log("standalone built -> dist (main.js, preload.js, localSttWorker.js, renderer/, viewer/)");
