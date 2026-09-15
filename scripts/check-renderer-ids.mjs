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
    // The home page carries its script inline, so the page is its own script
    // source. It was outside this check until a full redesign made the gap
    // obvious: nothing caught a re-layout dropping #ver or #stateText, and the
    // failure is silent - a download button that never learns its version.
    name: "home page",
    html: "packages/viewer/public/home.html",
    scripts: ["packages/viewer/public/home.html"],
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
    // Not a skip. Every pair here is a page the app ships, so a missing one is
    // a move or a deletion - and skipping meant this check went green while
    // checking nothing, which is worse than the mismatch it exists to catch.
    failures += 1;
    console.error(`\n${pair.name}: ${pair.html} is missing, so nothing was checked`);
    continue;
  }
  const defined = new Set([...html.matchAll(/\sid=["']([^"']+)["']/g)].map((m) => m[1]));

  const referenced = new Map();
  for (const file of pair.scripts) {
    const src = readFileSync(file, "utf8");
    const patterns = [
      // $("id") / inp("id") / sel("id") / getElementById("id")
      /(?:\$|inp|sel|getElementById)\(\s*["']([A-Za-z][\w-]*)["']\s*\)/g,
      // querySelector("#id ...") - not used today, and a silent hole if it is
      /querySelector(?:All)?\(\s*["']#([A-Za-z][\w-]*)/g,
    ];
    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        if (!referenced.has(m[1])) referenced.set(m[1], file);
      }
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

/**
 * Stylesheets address elements by id too, and that half was outside this check.
 *
 * A rename in the markup kills a `#id` rule silently and completely: no error,
 * no failing test - happy-dom does not apply stylesheets, so the renderer and
 * viewer suites cannot see it either - just a panel that quietly loses its
 * appearance. Same failure as the scripts above, one layer over.
 *
 * Two things this has to get right, both of which caught me out while writing
 * it and neither of which is obvious afterwards:
 *
 *  - **A stylesheet is checked against every page that loads it.** The viewer
 *    page and the home page share one, so checking either alone reports the
 *    other's ids as dangling.
 *  - **`#efeae0` is a colour, not a selector.** Hex colours that happen to
 *    start with a letter look exactly like id selectors, and excluding them by
 *    shape - 3, 4, 6 or 8 hex digits - is the whole difference between this
 *    reporting nothing and reporting three phantoms per sheet.
 */
const SHEETS = [
  { css: "apps/standalone/renderer/style.css", pages: ["apps/standalone/renderer/index.html"] },
  {
    css: "packages/viewer/public/style.css",
    pages: ["packages/viewer/public/index.html", "packages/viewer/public/home.html"],
  },
];

const looksLikeHex = (s) => /^[0-9a-fA-F]+$/.test(s) && [3, 4, 6, 8].includes(s.length);

for (const sheet of SHEETS) {
  let css;
  try {
    css = readFileSync(sheet.css, "utf8");
  } catch {
    // same rule as a missing page: a stylesheet this app ships cannot simply
    // not be checked
    failures += 1;
    console.error(`\n${sheet.css} is missing, so nothing was checked`);
    continue;
  }

  const defined = new Set();
  for (const page of sheet.pages) {
    const html = readFileSync(page, "utf8");
    for (const m of html.matchAll(/\sid=["']([^"']+)["']/g)) defined.add(m[1]);
  }

  const used = new Map();
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(^|[\s,>+~(])#([A-Za-z_][\w-]*)/gm)) {
    if (looksLikeHex(m[2])) continue;
    if (!used.has(m[2])) used.set(m[2], sheet.css);
  }

  const missing = [...used.keys()].filter((id) => !defined.has(id));
  if (missing.length) {
    failures += missing.length;
    console.error(`\n${sheet.css}: ${missing.length} id selector(s) matching nothing in the markup`);
    for (const id of missing) console.error(`  - #${id}`);
  } else {
    console.log(`${sheet.css}: ${used.size} id selectors resolve across ${sheet.pages.length} page(s)`);
  }
}

if (failures) {
  console.error(`\n${failures} unresolved element id(s)`);
  process.exit(1);
}
console.log("\nall renderer element ids resolve");
