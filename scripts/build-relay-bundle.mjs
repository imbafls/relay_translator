import { build } from "esbuild";

// bundle the relay CLI into a single CJS file for Node SEA injection
await build({
  entryPoints: ["packages/relay/src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "packages/relay/sea/relay-bundle.cjs",
  // the native STT addon cannot live inside a SEA blob: the server binary
  // reports local STT as unavailable and keeps relaying
  external: ["bufferutil", "utf-8-validate", "sherpa-onnx-node", "sherpa-onnx-*"],
  sourcemap: false,
  logLevel: "warning",
});

console.log("relay bundle -> packages/relay/sea/relay-bundle.cjs");
