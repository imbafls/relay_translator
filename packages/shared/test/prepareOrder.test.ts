import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Audit finding 33, guarded at the source rather than by running it.
 *
 * `runtime:prepare` rotated the viewer link BEFORE checking that the relay
 * could actually be published to. So every failed START in the default link
 * mode still rotated and persisted a new viewer token and kicked everyone on
 * the phone link - three presses while the port was busy invalidated the link
 * three times, with only "start failed" on screen. Since a refused viewer
 * socket now says THIS LINK HAS ENDED rather than silently retrying, that
 * misfire is more visible than it was, not less.
 *
 * This is a source-level check, and that needs saying. The handler lives in
 * `apps/standalone/src/main.ts`, which imports Electron and cannot be loaded by
 * the suite, and the defect is purely an ORDER between two statements - there
 * is no value to assert and nothing pure to extract that would not be a
 * rewrite of the thing under test. The repo already guards non-source facts
 * this way (`workflows.test.ts`, `lineEndings.test.ts`, `checkRendererIds`).
 *
 * It is narrow on purpose: it finds the handler by name and compares two
 * offsets inside it. A rename breaks it loudly, which is the right failure.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const main = fs.readFileSync(path.join(root, "apps/standalone/src/main.ts"), "utf8");

/** the body of the runtime:prepare handler, from its name to the matching close */
function prepareHandler(): string {
  const at = main.indexOf('ipcMain.handle("runtime:prepare"');
  if (at < 0) throw new Error("runtime:prepare handler is gone - this guard needs re-pointing");
  const end = main.indexOf("\n  });", at);
  return main.slice(at, end < 0 ? main.length : end);
}

describe("preparing a session does not spend the link before it can use it", () => {
  const body = prepareHandler();

  it("still contains both steps, so the comparison means something", () => {
    expect(body).toContain("rotateLink()");
    expect(body).toContain("publisherWsUrl()");
    expect(body).toContain("local relay not ready");
  });

  it("checks the relay is reachable before rotating the viewer link", () => {
    const check = body.indexOf("local relay not ready");
    const rotate = body.indexOf("rotateLink()");
    expect(
      check,
      "the link is rotated before the relay is checked, so a failed START still kicks every phone viewer",
    ).toBeLessThan(rotate);
  });

  it("reads the link after the rotate, or it would hand back the dead one", () => {
    // the ordering fix is only half of it: whatever is returned to the renderer
    // has to be read AFTER the rotate, or the app shows a token it just retired
    const rotate = body.indexOf("rotateLink()");
    const viewer = body.indexOf("viewerUrl:");
    expect(viewer, "the viewer link is read before the rotate that replaces it").toBeGreaterThan(rotate);
  });
});

/**
 * And that it rotates only when the user asked for a link that rotates.
 *
 * `linkMode` is a two-button control in SETTINGS. "unique" mints a fresh viewer
 * link each session; "fixed" keeps the one the user has already handed out -
 * which is the entire point of offering the choice, and the reason
 * `showLink` in the renderer will display a fixed link before a session starts
 * and a unique one only once it is live.
 *
 * The behaviour is one condition:
 *
 *   if (opts.rotate && cfg.linkMode === "unique") await rotateLink();
 *
 * Drop the second half - it reads like a redundant check beside `opts.rotate` -
 * and a user on "fixed" has every link they ever sent invalidated the next time
 * they press START. From inside the app nothing looks wrong: the rotate
 * succeeds, the new link appears, and it is the people holding the old one who
 * get THIS LINK HAS ENDED. The ordering tests above would not notice; they care
 * about where the rotate sits, not whether it should happen.
 *
 * Source-level for the reason the file already gives: `main.ts` imports
 * Electron and cannot be loaded here. Comments are stripped first, because a
 * condition inside a block comment still reads as present - three guards in
 * this repo were green against exactly that until `e419a3f`.
 */
describe("a fixed link stays fixed", () => {
  const code = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  /**
   * The rotate inside the prepare handler, comments removed.
   *
   * Scoped to that handler deliberately, and the first version of this was not:
   * searching the whole file finds `rotateLink`'s own definition first, and
   * also the tray's "Rotate viewer link" item - which calls it unconditionally
   * and should, because that is a person asking for a new link rather than a
   * session starting.
   */
  function rotateStatement(): string {
    const body = code(prepareHandler());
    const at = body.indexOf("rotateLink()");
    expect(at, "the prepare handler no longer rotates - this guard needs re-pointing").toBeGreaterThan(-1);
    const from = body.lastIndexOf("\n", at) + 1;
    const to = body.indexOf("\n", at);
    return body.slice(from, to < 0 ? undefined : to);
  }

  it("still rotates somewhere, so the check below is not vacuous", () => {
    expect(rotateStatement(), "the rotate statement could not be read").toContain("rotateLink()");
  });

  it("rotates only for a link mode that asked to rotate", () => {
    const line = rotateStatement();
    expect(
      /linkMode\s*===\s*["'`]unique["'`]/.test(line),
      `the session rotate is "${line.trim()}" - it no longer checks linkMode. A user on "fixed" would have ` +
        "every viewer link they have handed out invalidated on the next START, and nothing inside the app " +
        "would look wrong: the rotate succeeds and only the people holding the old link see it fail.",
    ).toBe(true);
  });
});
