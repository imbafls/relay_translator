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
