import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Audit finding 28.
 *
 * `app.whenReady()` runs a fixed sequence: register IPC, start the embedded
 * relay, start the control API, build the updater, `createTray()`,
 * `createWindow()`. The relay start is wrapped in a try/catch. The control API
 * start was not, and nothing in the app installs an `unhandledRejection`
 * handler - so anything already holding 127.0.0.1:47477 (a second copy of the
 * app, a crashed one whose socket has not been reaped, an unrelated process on
 * a port with no registry entry) took the whole startup down with it: no
 * window, no tray, no updater, and a process still holding the single-instance
 * lock, which makes every relaunch quit silently. The user sees an app that
 * will not open and no reason why.
 *
 * That the precondition is real - `startControlServer` genuinely rejects on a
 * taken port rather than resolving or hanging - is proved for real against a
 * real socket in `packages/companion/test/controlServer.test.ts`; shared cannot
 * import companion. What is left here is the call site, which cannot be run at
 * all: `apps/standalone/src/main.ts` imports Electron and the suite cannot load
 * it, so it is checked at the source, the way `prepareOrder.test.ts` checks
 * finding 33. Narrow on purpose: it finds the function by name and asks whether
 * the await that can reject is inside a `try`.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const main = fs.readFileSync(path.join(root, "apps/standalone/src/main.ts"), "utf8");

/** the body of a top-level `async function <name>` declaration */
function body(name: string): string {
  const at = main.indexOf(`async function ${name}(`);
  if (at < 0) throw new Error(`${name} is gone - this guard needs re-pointing`);
  const end = main.indexOf("\n}", at);
  return main.slice(at, end < 0 ? main.length : end);
}

describe("a control API that cannot bind does not take the app down with it", () => {
  it("catches that rejection where it happens, so no caller can forget to", () => {
    const start = body("startControl");

    expect(start, "startControl no longer starts the control server").toContain("startControlServer");
    const guard = start.indexOf("try {");
    const call = start.indexOf("await startControlServer");
    expect(guard, "startControl has no try/catch, so a busy port aborts startup").toBeGreaterThanOrEqual(0);
    expect(guard, "the await that can reject is outside the try").toBeLessThan(call);
    expect(start, "the failure is swallowed silently - it needs to reach the log").toMatch(/catch[\s\S]*log\(/);
  });

  it("still reaches the tray and the window after the control API is started", () => {
    // the ordering this is all in aid of: whatever happens above, these run
    const ready = main.slice(main.indexOf("app.whenReady"));
    const control = ready.indexOf("startControl()");
    const tray = ready.indexOf("createTray()");
    const window = ready.indexOf("createWindow()");

    expect(control, "startControl is no longer part of startup").toBeGreaterThanOrEqual(0);
    expect(tray, "createTray moved above the control API - this guard is now checking nothing").toBeGreaterThan(control);
    expect(window, "createWindow moved above the control API").toBeGreaterThan(control);
  });
});

/**
 * Audit finding 27.
 *
 * `Updater.load()` returns the cached `this.updater` on its first line, and
 * `setFeedURL` sits below that early return; `stop()` only clears the poll
 * timer. So `applyConfig`'s `updater?.start()` - the thing that fires when
 * `updateFeedUrl` changes - re-checked the OLD feed, for the rest of the
 * process's life, and the confirming `update feed: <url>` line never printed.
 * Point the app at a feed and it keeps asking GitHub; point it back and it
 * keeps asking your box.
 *
 * The decision the fix executes is real code with real tests, in
 * `updateFeed.test.ts`. That it is now consulted on the cached path is what is
 * checked here, and it has to be checked at the source: `updater.ts` imports
 * Electron's `app` at module scope, so the suite cannot load it, and `app` is
 * not a thing Node can supply - `require("electron")` outside Electron returns
 * a path string.
 */
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
