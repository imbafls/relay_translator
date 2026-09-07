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
