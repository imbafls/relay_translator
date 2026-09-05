import { build } from "esbuild";

// bundle the relay CLI into a single CJS file for Node SEA injection
await build({
  entryPoints: ["packages/relay/src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "packages/relay/sea/relay-bundle.cjs",
  // sherpa-onnx-node is a native addon the SEA cannot carry; the relay CLI
  // never passes `localStt`, so the worker is simply never started there
  external: ["bufferutil", "utf-8-validate", "sherpa-onnx-node"],
  sourcemap: false,
  logLevel: "warning",
});

console.log("relay bundle -> packages/relay/sea/relay-bundle.cjs");
