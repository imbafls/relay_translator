import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The id checker is a guard CI and the release gate both depend on, and nothing
 * had ever checked the guard. It runs against fixture trees here - the real
 * script, invoked the real way, with inputs a test controls - because its paths
 * are relative to the working directory.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const script = path.join(root, "scripts/check-renderer-ids.mjs");
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    try {
      fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      /* disposable */
    }
  }
});

/** a tree shaped like the one the checker expects, with the given contents */
function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "id-check-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, "utf8");
  }
  return dir;
}

function run(cwd: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [script], { cwd, encoding: "utf8", stdio: "pipe" });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** the three pages the checker knows about, each satisfied by default */
const OK = {
  "apps/standalone/renderer/index.html": `<div id="alpha"></div>`,
  "apps/standalone/renderer/app.ts": `$("alpha");`,
  "packages/viewer/public/index.html": `<div id="beta"></div>`,
  "packages/viewer/public/app.js": `$("beta");`,
  "apps/streamdeck/com.callout-relay.sdPlugin/pi/index.html": `<div id="gamma"></div>`,
  "apps/streamdeck/com.callout-relay.sdPlugin/pi/pi.js": `$("gamma");`,
};

describe("the id checker", () => {
  it("passes when every id resolves", () => {
    const res = run(tree(OK));
    expect(res.code).toBe(0);
    expect(res.out).toContain("all renderer element ids resolve");
  });

  it("fails on an id the markup does not define", () => {
    const res = run(tree({ ...OK, "packages/viewer/public/app.js": `$("beta"); $("nowhere");` }));
    expect(res.code).toBe(1);
    expect(res.out).toContain("nowhere");
  });

  it("fails when a page it is meant to check has gone missing", () => {
    // this used to print "skip" and exit 0: the guard reporting success while
    // checking nothing at all
    const missing = { ...OK } as Record<string, string>;
    delete missing["packages/viewer/public/index.html"];
    const res = run(tree(missing));
    expect(res.code).toBe(1);
    expect(res.out).toContain("is missing");
  });

  it("sees an id used through querySelector", () => {
    const res = run(
      tree({ ...OK, "packages/viewer/public/app.js": `$("beta"); document.querySelector("#absent .row");` }),
    );
    expect(res.code).toBe(1);
    expect(res.out).toContain("absent");
  });

  it("accepts an id defined with single quotes", () => {
    const res = run(
      tree({
        ...OK,
        "packages/viewer/public/index.html": `<div id='beta'></div>`,
        "packages/viewer/public/app.js": `$('beta');`,
      }),
    );
    expect(res.code).toBe(0);
  });

  it("does not mistake a class selector for an id", () => {
    const res = run(
      tree({ ...OK, "packages/viewer/public/app.js": `$("beta"); document.querySelectorAll(".row .txt");` }),
    );
    expect(res.code).toBe(0);
  });
});
