import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The bridge between the renderer and the main process, which is thirty
 * strings.
 *
 * Every call across it is keyed by a name: `ipcRenderer.invoke("updates:check")`
 * reaches `ipcMain.handle("updates:check")` and nothing connects the two. A
 * typecheck cannot help - both sides are string literals - and the renderer
 * suite cannot either, because it stubs the whole `cr` API and never loads
 * `preload.ts` or `main.ts` at all. Rename one side and the feature is simply
 * gone: the invoke rejects with "No handler registered", the button does
 * nothing, and the suite stays green.
 *
 * `renderer.test.ts` already holds both ends of the seven `transcripts:*`
 * channels together, and its list is written down. That covers seven of
 * thirty. This is the same check with the list discovered instead, which is
 * the second habit of the fifth lesson and the same correction `aa504a1` made
 * to the id checker's sources.
 *
 * Four directions, because a bridge can fail from either end:
 *
 *  - invoked with no handler: the call rejects
 *  - sent with no listener: the message vanishes silently, which is worse
 *  - subscribed to but never pushed: the renderer waits for an event that
 *    cannot arrive
 *  - handled but never invoked: dead surface, and by this repo's sixth lesson
 *    that is a question rather than an answer
 *
 * NOT checked here, deliberately: that the renderer calls only methods
 * `preload.ts` exposes. That contract is the `CalloutRelayApi` interface and
 * the compiler already enforces it - `pnpm typecheck` is the guard, and
 * duplicating it here would be a second opinion about what tsc does.
 */

const src = (file: string): string => fs.readFileSync(path.resolve(__dirname, "..", "src", file), "utf8");
const stripComments = (t: string): string =>
  t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const preload = stripComments(src("preload.ts"));
const main = stripComments(src("main.ts"));

const names = (text: string, re: RegExp): Set<string> => {
  const out = new Set<string>();
  for (const m of text.matchAll(re)) out.add(m[1] ?? "");
  return out;
};

/** renderer -> main, awaiting a reply */
const invoked = names(preload, /ipcRenderer\.invoke\(\s*["'`]([^"'`]+)["'`]/g);
/** renderer -> main, fire and forget */
const sent = names(preload, /ipcRenderer\.send\(\s*["'`]([^"'`]+)["'`]/g);
/** main -> renderer, subscribed by the bridge */
const subscribed = names(preload, /ipcRenderer\.on\(\s*["'`]([^"'`]+)["'`]/g);

const handled = names(main, /ipcMain\.handle\(\s*["'`]([^"'`]+)["'`]/g);
const listened = names(main, /ipcMain\.on\(\s*["'`]([^"'`]+)["'`]/g);
/** anything main pushes at a renderer, however it reaches webContents */
const pushed = names(main, /webContents\.send\(\s*["'`]([^"'`]+)["'`]/g);

describe("the preload bridge", () => {
  it("found both sides, so the checks below are not vacuous", () => {
    // a mis-scoped regex reporting an empty set reads exactly like a bridge
    // with nothing wrong on it
    expect(invoked.size, "no ipcRenderer.invoke was found in preload.ts at all").toBeGreaterThan(15);
    expect(handled.size, "no ipcMain.handle was found in main.ts at all").toBeGreaterThan(15);
    expect(subscribed.size, "no ipcRenderer.on was found in preload.ts at all").toBeGreaterThan(0);
    expect(pushed.size, "no webContents.send was found in main.ts at all").toBeGreaterThan(0);
  });

  it("invokes nothing the main process does not handle", () => {
    const missing = [...invoked].filter((c) => !handled.has(c));
    expect(
      missing,
      "the bridge invokes these and main registers no handler, so every call rejects with " +
        "'No handler registered' and whatever feature they belong to is dead",
    ).toEqual([]);
  });

  it("sends nothing the main process is not listening for", () => {
    const missing = [...sent].filter((c) => !listened.has(c));
    expect(
      missing,
      "the bridge sends these and nothing in main listens. A send has no reply to reject, so this one fails " +
        "in complete silence - the renderer believes it reported something and nobody received it",
    ).toEqual([]);
  });

  it("subscribes to nothing the main process never pushes", () => {
    const missing = [...subscribed].filter((c) => !pushed.has(c));
    expect(
      missing,
      "the bridge listens for these and main never sends them, so the renderer is waiting for an event that " +
        "cannot arrive - the screen simply never updates",
    ).toEqual([]);
  });

  it("handles nothing the bridge never invokes", () => {
    const orphans = [...handled].filter((c) => !invoked.has(c));
    expect(
      orphans,
      "main handles these and nothing on the bridge calls them. Dead surface is a question, not an answer: " +
        "either a caller was removed and this is the other half left behind, or the channel is reached some " +
        "way this does not know about, and either is worth finding out before it rots",
    ).toEqual([]);
  });

  it("listens for nothing the bridge never sends", () => {
    const orphans = [...listened].filter((c) => !sent.has(c));
    expect(orphans, "main listens on these and nothing on the bridge sends them").toEqual([]);
  });
});
