import { build } from "esbuild";

// bundle the relay CLI into a single CJS file for Node SEA injection
await build({
  entryPoints: ["packages/relay/src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "packages/relay/sea/relay-bundle.cjs",
  external: ["bufferutil", "utf-8-validate"],
  sourcemap: false,
  logLevel: "warning",
});

console.log("relay bundle -> packages/relay/sea/relay-bundle.cjs");
