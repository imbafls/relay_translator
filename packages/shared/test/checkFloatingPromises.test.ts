import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `doThing()` on its own line starts the work and throws the result away, so a
 * rejection has nowhere to go. The compiler has no rule for it at any
 * strictness, and the type-aware lint rule that does costs an eslint install -
 * so the checker is a small script, the same shape as check-renderer-ids.mjs.
 *
 * Two halves, and both are needed. The fixture tests prove the checker can tell
 * a floating promise from the four shapes that are not one; the last test runs
 * it against this repo, which is the assertion that actually guards the code.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const script = path.join(root, "scripts/check-floating-promises.mjs");
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

/** a one-file project whose source is `body`, and the path to its tsconfig */
function project(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "float-check-"));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", lib: ["ES2022"], strict: true, noEmit: true, types: [] },
      include: ["src"],
    }),
    "utf8",
  );
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "a.ts"), `async function doThing(): Promise<void> {}\n${body}\n`, "utf8");
  return path.join(dir, "tsconfig.json");
}

function run(...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", stdio: "pipe" });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("the checker", () => {
  it("reports a promise whose result is discarded", () => {
    const res = run(project("doThing();"));
    expect(res.code).toBe(1);
    expect(res.out).toContain("floating promise");
    expect(res.out).toContain("doThing()");
  });

  it("accepts `void` as saying the result is deliberately dropped", () => {
    // the escape hatch is at the call site on purpose: an allowlist inside the
    // checker would be invisible to the person reading the code
    expect(run(project("void doThing();")).code).toBe(0);
  });

  it("accepts an awaited call", () => {
    expect(run(project("async function outer() { await doThing(); }\nvoid outer();")).code).toBe(0);
  });

  it("accepts a call that handles its own rejection", () => {
    expect(run(project("doThing().catch(() => {});")).code).toBe(0);
    expect(run(project("doThing().finally(() => {});")).code).toBe(0);
    expect(run(project("doThing().then(() => {}, () => {});")).code).toBe(0);
  });

  it("still reports .then() with no rejection handler", () => {
    // one argument means a throw inside the callback is unhandled, which is
    // exactly the shape main.ts had at startup
    const res = run(project("doThing().then(() => {});"));
    expect(res.code).toBe(1);
  });

  it("does not report a promise assigned to something that holds it", () => {
    // this one is not hypothetical: the first version of the probe reported
    // `readRelayLogGate = new Promise(...)` in the test suite, a site nobody
    // could have fixed. A checker that reports the unfixable reads exactly
    // like one that works.
    expect(run(project("let p: Promise<void> | null = null;\np = doThing();\nvoid p;")).code).toBe(0);
  });

  it("says what it scanned when it finds nothing, so a silent pass is not mistaken for coverage", () => {
    const res = run(project("void doThing();"));
    expect(res.out).toMatch(/no floating promises in [1-9]\d* files/);
  });

  it("fails rather than passes when it scanned nothing at all", () => {
    // how the fixtures above were green before they were true: the checker
    // resolved ownership against the working directory, so every file in a
    // temp dir was skipped and every fixture passed having read nothing. The
    // two tests expecting RED are what exposed it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "float-empty-"));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { types: [], noEmit: true }, files: [] }),
      "utf8",
    );
    const res = run(path.join(dir, "tsconfig.json"));
    expect(res.code).toBe(1);
    expect(res.out).toContain("scanned no files");
  });
});

describe("this repo", () => {
  it("has no floating promises in its source", () => {
    const res = run();
    expect(res.code, res.out).toBe(0);
  });
});
