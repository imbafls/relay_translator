import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The dev tools a person is told to run have to still be there.
 *
 * `.claude/launch.json` named two: `scripts/mock-relay.mjs`, which is tracked
 * and has survived everything, and a renderer harness that lived in
 * `apps/standalone/dist/harness/`. That directory is gitignored build output,
 * so the harness was never committed - and it vanished the first time anything
 * cleaned `dist/`, taking with it the only way `docs/RALPH-IMPROVEMENT-LOOP.md`
 * offers to look at the UI at all. Nothing noticed, because nothing was
 * looking.
 *
 * So: anything a launch config points at must exist, and must not live
 * somewhere a build can delete. The second half is the one that matters - the
 * first would have gone red the day it broke, and the second is why it could
 * break at all.
 */

const root = path.resolve(__dirname, "..", "..", "..");

interface Launch {
  configurations?: { name?: string; runtimeArgs?: string[] }[];
}

/** every repo-relative path a launch configuration would run */
function launchTargets(): { name: string; target: string }[] {
  const file = path.join(root, ".claude", "launch.json");
  if (!fs.existsSync(file)) return [];
  const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as Launch;
  return (cfg.configurations ?? []).flatMap((c) =>
    (c.runtimeArgs ?? [])
      .filter((a) => /\.(mjs|cjs|js)$/.test(a))
      .map((target) => ({ name: c.name ?? "(unnamed)", target })),
  );
}

/**
 * `.claude/` is gitignored, so this half only has anything to say on a machine
 * that has a launch config - which is the only machine where anybody could run
 * one. In CI there is no file and these skip, deliberately and out loud, rather
 * than asserting something true of an empty list. The half that carries weight
 * everywhere is the stub check below, which reads tracked files only.
 */
describe("the tools a launch config offers to run", () => {
  const configured = launchTargets().length > 0;

  it("has a launch config here, or says these checks are not running", () => {
    if (!configured) {
      expect(fs.existsSync(path.join(root, ".claude", "launch.json"))).toBe(false);
      return; // nothing to check, and the next two know it
    }
    expect(launchTargets().length).toBeGreaterThan(1);
  });

  it("all exist", () => {
    if (!configured) return;
    const missing = launchTargets()
      .filter((t) => !fs.existsSync(path.join(root, t.target)))
      .map((t) => `${t.name} runs ${t.target}, which is not there`);
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("none of them lives where a build can delete it", () => {
    if (!configured) return;
    // dist/ is regenerated and routinely wiped; a tool kept there is a tool
    // that will be gone the next time somebody tests a cold build
    const doomed = launchTargets()
      .filter((t) => /(^|\/)dist\//.test(t.target))
      .map((t) => `${t.name} runs ${t.target}, which is gitignored build output`);
    expect(doomed, doomed.join("\n")).toEqual([]);
  });

});

/**
 * The harness stands in for the preload bridge, and one name it does not
 * answer to is a TypeError during boot and a blank window - which looks
 * exactly like the layout bug somebody opened it to look at. That is the whole
 * failure mode of a tool for looking at things: it has to be obvious when it
 * is the tool that is broken.
 */
describe("the renderer harness's stand-in bridge", () => {
  const harness = fs.readFileSync(path.join(root, "scripts", "renderer-harness.mjs"), "utf8");
  const app = fs.readFileSync(path.join(root, "apps", "standalone", "renderer", "app.ts"), "utf8");

  const called = (): string[] => [...new Set([...app.matchAll(/\bcr\.([a-zA-Z]+)/g)].map((m) => m[1] ?? ""))].sort();
  const provided = (): Set<string> => new Set([...harness.matchAll(/^\s{4}([a-zA-Z]+):/gm)].map((m) => m[1] ?? ""));

  it("answers to everything the renderer asks it for", () => {
    const supplied = provided();
    const missing = called().filter((n) => !supplied.has(n));
    expect(missing, `the page would throw on boot and show nothing: ${missing.join(", ")}`).toEqual([]);
  });

  it("found calls on both sides, so the comparison is about something", () => {
    expect(called().length).toBeGreaterThan(20);
    expect(provided().size).toBeGreaterThan(20);
  });
});
