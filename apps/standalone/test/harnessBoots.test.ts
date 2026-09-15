// @vitest-environment happy-dom
import { describe, expect, it, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The harness, booted: the built renderer and the stand-in bridge that
 * `scripts/renderer-harness.mjs` actually serves, evaluated together.
 *
 * `devTools.test.ts` checks the stub answers to every `cr.*` name the renderer
 * mentions. That is a list comparison, and it cannot see the failure that
 * matters - a bridge method returning the wrong SHAPE, so the page throws
 * while rendering rather than while resolving a name. Either way you get a
 * blank window, and a blank window is indistinguishable from the layout bug
 * somebody opened the harness to look at.
 *
 * happy-dom does not paint, so this proves the page BOOTS and populates, not
 * that it looks right. Looking right still needs eyes. Booting at all is the
 * part that can be checked on every run, and it is the part that was silently
 * untrue for as long as the harness was missing.
 */

const root = path.resolve(__dirname, "..");
const built = path.join(root, "dist", "renderer");
const harness = path.resolve(root, "..", "..", "scripts", "renderer-harness.mjs");

/** the stub exactly as the harness serves it, cut out of the script */
function stubSource(): string {
  const src = fs.readFileSync(harness, "utf8");
  const m = /const STUB = `([\s\S]*?)`;\n/.exec(src);
  if (!m) throw new Error("no STUB template found in renderer-harness.mjs");
  // it is a template literal in the script; the only escape it carries is the
  // doubled backslash in a Windows path
  return (m[1] ?? "").replace(/\\\\/g, "\\");
}

describe("the harness can boot the renderer it serves", () => {
  beforeAll(() => {
    if (!fs.existsSync(path.join(built, "app.js"))) {
      throw new Error(`no built renderer at ${built} - run the workspace build first`);
    }
  });

  it("evaluates the stub and the real app without throwing", () => {
    const html = fs.readFileSync(path.join(built, "index.html"), "utf8");
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
    document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, "");

    expect(() => window.eval(stubSource()), "the harness stub itself does not evaluate").not.toThrow();
    expect((window as unknown as { cr?: unknown }).cr, "the stub left no bridge behind").toBeTruthy();

    expect(
      () => window.eval(fs.readFileSync(path.join(built, "app.js"), "utf8")),
      "the built renderer threw while booting against the harness stub",
    ).not.toThrow();
  });

  it("puts the app on screen rather than leaving the markup empty", async () => {
    // boot is async - config arrives through a promise - so let it settle
    await new Promise((r) => setTimeout(r, 50));

    const app = document.querySelector(".app");
    expect(app, "the shipped markup has no .app root any more").toBeTruthy();

    // The column headers are written from `getConfig()`, so they are empty in
    // the markup and filled only if boot got all the way through the bridge.
    // Deliberately not `updateVersion`, which the first version of this test
    // used: that one is filled by an update status the harness never pushes,
    // so it is legitimately empty and proves nothing either way.
    expect(
      document.getElementById("srcHead")?.textContent ?? "",
      "nothing was written from the bridge, so boot did not finish",
    ).toContain("ENGLISH");
    // the target language name comes from the catalogue, not the config, so
    // this covers one hop further than the line above
    expect(document.getElementById("tgtHead")?.textContent ?? "").toContain("TIẾNG VIỆT");
  });
});
