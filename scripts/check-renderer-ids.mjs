/**
 * The renderers address elements by string id, so a rename in the markup fails
 * silently at runtime. This walks each HTML/JS pair and reports ids that the
 * script looks up but the markup does not define.
 *
 * Exits non-zero on a mismatch; run by CI and safe to run locally.
 */
import { readFileSync, readdirSync } from "node:fs";

const PAIRS = [
  {
    name: "desktop renderer",
    html: "apps/standalone/renderer/index.html",
    // every module the renderer bundle pulls in, not just the entry: they are
    // all loaded by the one page, and any of them may look an element up
    scripts: [
      "apps/standalone/renderer/app.ts",
      "apps/standalone/renderer/dom.ts",
      "apps/standalone/renderer/elements.ts",
      "apps/standalone/renderer/format.ts",
      "apps/standalone/renderer/log.ts",
      "apps/standalone/renderer/meter.ts",
      "apps/standalone/renderer/whatsNew.ts",
    ],
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

/**
 * Every script beside a page has to be assigned to one of the pairs above.
 *
 * The list was written down, and the renderer is no longer one file: `dom.ts`,
 * `log.ts`, `meter.ts` and `whatsNew.ts` sit next to `app.ts` and none of them
 * was being read. None looks up an id today, so nothing was wrong - but the
 * first one that does would go unchecked in exactly the silence this script
 * exists to break, and nothing would say so.
 *
 * Refusing an unassigned file rather than globbing them all in, deliberately:
 * `packages/viewer/public/` holds two pages, and a script swept into the wrong
 * one reports the other page's ids as dangling. That trap already cost an
 * iteration on the stylesheet half. A human says which page a new module
 * belongs to; this only insists that somebody does.
 *
 * This is the second habit from the fifth lesson - a coverage list should be
 * discovered rather than written down - applied to the last checker here still
 * carrying one. `check-floating-promises.mjs` reads the tree for projects,
 * `tsconfigCorrectness.test.ts` for configs, `reducedMotion.test.ts` for
 * stylesheets.
 */
const SCRIPT_DIRS = [
  { dir: "apps/standalone/renderer", ext: [".ts"] },
  { dir: "packages/viewer/public", ext: [".js"] },
];

const assigned = new Set(PAIRS.flatMap((p) => p.scripts));
for (const { dir, ext } of SCRIPT_DIRS) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    failures += 1;
    console.error(`\n${dir} is missing, so its scripts were not checked`);
    continue;
  }
  const beside = entries
    .filter((name) => ext.some((e) => name.endsWith(e)))
    .map((name) => `${dir}/${name}`)
    .filter((rel) => !assigned.has(rel));
  if (beside.length) {
    failures += beside.length;
    console.error(`\n${dir}: ${beside.length} script(s) beside a page that no pair reads`);
    for (const rel of beside) console.error(`  - ${rel}  (add it to the pair for its page)`);
  }
}

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
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      // a script this pair names but that is not there: a move or a deletion
      // the list did not follow. Same rule as a missing page - it is reported,
      // not skipped, and not left to throw an unhandled ENOENT either
      failures += 1;
      console.error(`\n${pair.name}: ${file} is listed but missing, so its ids were not checked`);
      continue;
    }
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
  console.error(`\n${failures} problem(s) above`);
  process.exit(1);
}
console.log("\nall renderer element ids resolve");
