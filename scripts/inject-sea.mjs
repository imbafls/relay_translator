/**
 * Node Single Executable Application: inject the SEA blob into a copy of the
 * local node.exe -> callout-relay-server.exe (viewer page assets embedded).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const seaDir = path.resolve("packages/relay/sea");
const exe = path.join(seaDir, "callout-relay-server.exe");
const blob = path.join(seaDir, "sea-prep.blob");
const sentinel = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

// 1. SEA blob (paths inside sea-config.json resolve from the sea dir)
console.log("[sea] generating blob…");
execFileSync(
  process.execPath,
  ["--experimental-sea-config", "sea-config.json"],
  { stdio: "inherit", cwd: seaDir },
);

// 2. copy node.exe
console.log("[sea] copying node runtime…");
copyFileSync(process.execPath, exe);

// 3. inject via postject (invoked directly as JS — .cmd spawn is blocked on Node 24)
console.log("[sea] injecting blob with postject…");
const postjectCli = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  "postject",
  "dist",
  "cli.js",
);
execFileSync(process.execPath, [postjectCli, exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", sentinel], {
  stdio: "inherit",
});

if (!existsSync(exe)) throw new Error("exe missing after postject");
console.log(`[sea] done -> ${exe}`);
