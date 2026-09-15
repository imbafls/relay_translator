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
const build = fs.readFileSync(path.join(root, "build.mjs"), "utf8");

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

  it("ships the same two files the guards name, and no third one they miss", () => {
    // a new asset copied into dist/renderer is a new file nothing reads the
    // source of; this is how the id checker came to miss four renderer modules
    const copied = [...build.matchAll(/cpSync\(\s*["'`]renderer\/([\w.-]+)["'`]/g)].map((m) => m[1] ?? "");
    expect(copied.length, "no renderer asset copies were found in build.mjs").toBeGreaterThan(0);
    expect(
      copied.filter((f) => !GUARDED.includes(f)),
      "build.mjs ships a renderer asset that no guard reads the source of. Add it to GUARDED here and to " +
        "whatever checks its contents, or say why it needs neither",
    ).toEqual([]);
  });
});
