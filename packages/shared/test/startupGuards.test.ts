import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Source-level guards over `apps/standalone/src/`, which imports Electron and
 * so cannot be loaded by the suite at all. Narrow on purpose: each finds a
 * function by name and asks one question about its shape. A rename breaks them
 * loudly, which is the right failure.
 *
 * There used to be one here for audit finding 28 - an unguarded
 * `await startControl()` that took the tray and the window down with it. Both
 * the control API and the Stream Deck plugin that was its only consumer have
 * since been deleted, so there is no longer a call that can fail there.
 */

const root = path.resolve(__dirname, "..", "..", "..");

describe("changing the update feed takes effect without a restart", () => {
  const updater = fs.readFileSync(path.join(root, "apps/standalone/src/updater.ts"), "utf8");

  it("consults the feed decision on the cached path, not only on first load", () => {
    const at = updater.indexOf("private load()");
    expect(at, "load() is gone - this guard needs re-pointing").toBeGreaterThanOrEqual(0);
    const body = updater.slice(at, updater.indexOf("\n  }", at));

    const early = body.indexOf("if (this.updater)");
    expect(early, "the cached early return is gone; check this guard still means anything").toBeGreaterThanOrEqual(0);
    // everything the cached path runs, from the test to the return it takes
    const cached = body.slice(early, body.indexOf("return this.updater;", early));
    expect(
      cached,
      "load() returns the cached updater without re-applying the feed, so a changed updateFeedUrl does nothing until restart",
    ).toContain("applyFeed");
  });

  it("routes that decision through the tested function rather than re-deciding inline", () => {
    expect(updater, "the updater no longer uses updateFeedAction").toContain("updateFeedAction");
    expect(updater, "a cleared override has to be reported, not silently ignored").toContain("restart-needed");
  });
});
