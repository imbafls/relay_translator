import { build } from "esbuild";

await build({
  entryPoints: ["src/plugin.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "com.callout-relay.sdPlugin/bin/plugin.js",
  sourcemap: false,
  logLevel: "info",
});
console.log("streamdeck plugin bundled -> com.callout-relay.sdPlugin/bin/plugin.js");
