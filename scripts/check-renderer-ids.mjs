/**
 * The renderers address elements by string id, so a rename in the markup fails
 * silently at runtime. This walks each HTML/JS pair and reports ids that the
 * script looks up but the markup does not define.
 *
 * Exits non-zero on a mismatch; run by CI and safe to run locally.
 */
import { readFileSync } from "node:fs";

const PAIRS = [
  {
    name: "desktop renderer",
    html: "apps/standalone/renderer/index.html",
    scripts: ["apps/standalone/renderer/app.ts"],
  },
  {
    name: "phone/OBS viewer",
    html: "packages/viewer/public/index.html",
    scripts: ["packages/viewer/public/app.js"],
  },
  {
    name: "stream deck inspector",
    html: "apps/streamdeck/com.callout-relay.sdPlugin/pi/index.html",
    scripts: ["apps/streamdeck/com.callout-relay.sdPlugin/pi/pi.js"],
  },
];

/** ids the script builds at runtime rather than looking up literally */
const DYNAMIC = new Set();

let failures = 0;

for (const pair of PAIRS) {
  let html;
  try {
    html = readFileSync(pair.html, "utf8");
  } catch {
    console.log(`skip ${pair.name} (${pair.html} not present)`);
    continue;
  }
  const defined = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

  const referenced = new Map();
  for (const file of pair.scripts) {
    const src = readFileSync(file, "utf8");
    // $("id") / inp("id") / sel("id") / getElementById("id")
    const re = /(?:\$|inp|sel|getElementById)\(\s*"([A-Za-z][\w-]*)"\s*\)/g;
    for (const m of src.matchAll(re)) {
      if (!referenced.has(m[1])) referenced.set(m[1], file);
    }
  }

  const missing = [...referenced.keys()].filter((id) => !defined.has(id) && !DYNAMIC.has(id));
  if (missing.length) {
    failures += missing.length;
    console.error(`\n${pair.name}: ${missing.length} id(s) used by script but missing from ${pair.html}`);
    for (const id of missing) console.error(`  - #${id}  (${referenced.get(id)})`);
  } else {
    console.log(`${pair.name}: ${referenced.size} ids resolve against ${defined.size} in the markup`);
  }
}

if (failures) {
  console.error(`\n${failures} unresolved element id(s)`);
  process.exit(1);
}
console.log("\nall renderer element ids resolve");
