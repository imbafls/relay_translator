import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The assumption every renderer guard in this repo rests on.
 *
 * `check-renderer-ids.mjs` reads `renderer/index.html` and `renderer/style.css`.
 * So does the id-selector half of that script, and so do the custom-property
 * and data-attribute checks in `designTokens.test.ts`. All of them read the
 * SOURCE. What the app ships is `dist/renderer`, which `build.mjs` produces.
 *
 * Today those are the same bytes - `cpSync("renderer/index.html",
 * "dist/renderer/index.html")`, a verbatim copy, no transform. That is the only
 * reason reading the source says anything about the shipped page. Turn either
 * line into a template, an injected meta tag or a minifier and every one of
 * those guards goes on passing while describing a file nobody loads.
 *
 * This is checked at the source of `build.mjs` rather than by comparing
 * `dist/` against `renderer/`, deliberately. A comparison needs a build to have
 * run, and `pnpm test` does not build - so on a clean checkout it would fail
 * for a reason that is not a defect, and the only way out would be to skip when
 * `dist/` is absent, which is a checker reporting success having read nothing.
 *
 * **What this does not catch**, said plainly rather than implied: a mutation
 * added AFTER the copy, writing over the destination. The pattern below would
 * still be there. It catches the realistic change - replacing the copy with a
 * transform - and not every conceivable one.
 *
 * The viewer needs no equivalent. `packages/viewer/public/` is served exactly
 * as it sits on disk, by both relays, with no build step at all.
 */

const root = path.resolve(__dirname, "..");

/**
 * The build script with its comments removed. A `cpSync` inside a block comment
 * is not a copy - matching the raw text let this pass while `dist/renderer` no
 * longer received `index.html` at all, which is the opposite of what it claims
 * to check.
 */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const build = code(fs.readFileSync(path.join(root, "build.mjs"), "utf8"));

/** the files a guard elsewhere reads from source and assumes is what ships */
const GUARDED = ["index.html", "style.css"];

describe("the renderer assets the guards read", () => {
  it("has a build script to inspect, so the check below is not vacuous", () => {
    expect(build.length, "build.mjs is empty or unreadable").toBeGreaterThan(200);
    expect(build, "build.mjs no longer mentions dist/renderer at all").toContain("dist/renderer");
  });

  it.each(GUARDED)("copies %s to dist verbatim, rather than transforming it", (name) => {
    const verbatim = new RegExp(
      `cpSync\\(\\s*["'\`]renderer/${name.replace(".", "\\.")}["'\`]\\s*,\\s*["'\`]dist/renderer/${name.replace(".", "\\.")}["'\`]`,
    );
    expect(
      verbatim.test(build),
      `build.mjs no longer copies renderer/${name} to dist verbatim. check-renderer-ids.mjs and ` +
        "designTokens.test.ts read the SOURCE copy and take it for what ships - if this became a transform, " +
        "every one of those guards would keep passing while describing a file the app does not load.",
    ).toBe(true);
  });

  /**
   * Everything that lands in `dist/renderer`, found by DESTINATION.
   *
   * The first version of this scanned for copies whose SOURCE was `renderer/`,
   * and missed one the very next time anybody looked: the fonts are copied from
   * the viewer's directory - `cpSync(path.join(viewerPublic, "fonts"),
   * "dist/renderer/fonts")`, deliberately, so the two surfaces share one set -
   * and never appear under `renderer/` at all. A check that asks "what do we
   * copy out of this folder" cannot see a file arriving from somewhere else,
   * and what ships is decided by where things land, not where they came from.
   */
  const ACCOUNTED: Record<string, string> = {
    "index.html": "read by check-renderer-ids.mjs and designTokens.test.ts",
    "style.css": "read by check-renderer-ids.mjs and designTokens.test.ts",
    // shared with the viewer on purpose - a single set of self-hosted faces
    fonts: "covered by license.test.ts (OFL notice) and designTokens.test.ts (families)",
    /**
     * Not a copy at all: the esbuild bundle of `renderer/app.ts` and the four
     * modules beside it, which are exactly the five files the id checker reads
     * since `aa504a1`.
     *
     * So the assumption here is different from the two above, and weaker in a
     * way worth naming. It is not "identical bytes" - it is that bundling
     * preserves STRING LITERALS, so `$("wnHeadline")` in the source is still
     * `"wnHeadline"` in what ships. Checked once against the built file: all
     * 158 ids the checker finds in source appear verbatim in `dist`. The build
     * passes no `minify`, and no minifier rewrites the inside of a string in
     * any case.
     */
    "app.js": "the bundle of the five modules check-renderer-ids.mjs reads; literals survive bundling",
  };

  it("ships nothing into dist/renderer that no guard accounts for", () => {
    const landing = [...build.matchAll(/["'`]dist\/renderer\/([\w.-]+)["'`]/g)].map((m) => m[1] ?? "");
    expect(landing.length, "no copies into dist/renderer were found in build.mjs at all").toBeGreaterThan(1);
    expect(
      [...new Set(landing)].filter((f) => !(f in ACCOUNTED)),
      "build.mjs ships this into dist/renderer and nothing here accounts for it. Say which guard reads its " +
        "source, or why it needs none - the app loads what lands in this folder, whatever it was copied from",
    ).toEqual([]);
  });
});
