import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The page a phone or OBS actually loads was the one package nothing checked.
 *
 * `build` and `typecheck` were both `node -e "1"` - not a stub someone forgot,
 * but an honest statement that a folder of plain JS has nothing to build. The
 * consequence was easy to miss: `pnpm -r typecheck` walks every package, so the
 * viewer LOOKED covered by the gate while its script did nothing. Every other
 * package gained seven compiler rules; this one had a typo's worth of
 * protection, from `check-renderer-ids.mjs`, and that only checks element ids.
 *
 * `checkJs` is the answer for a file that has to stay plain JS - it is served
 * as-is, with no build step - and this asserts it stays wired up rather than
 * quietly reverting to a no-op that still looks green.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const pkgDir = path.join(root, "packages", "viewer");

function script(name: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts?.[name] ?? "";
}

describe("the viewer package", () => {
  it("runs a real typecheck rather than a no-op", () => {
    const cmd = script("typecheck");
    expect(cmd, `packages/viewer typecheck is ${JSON.stringify(cmd)}`).toContain("tsc");
  });

  it("has a tsconfig that actually reads the JS", () => {
    const file = path.join(pkgDir, "tsconfig.json");
    expect(fs.existsSync(file), "packages/viewer/tsconfig.json is missing").toBe(true);

    // JSON with comments - the repo's other configs carry them too
    const raw = fs.readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "");
    const cfg = JSON.parse(raw) as { compilerOptions?: Record<string, unknown> };
    expect(cfg.compilerOptions?.allowJs).toBe(true);
    expect(cfg.compilerOptions?.checkJs).toBe(true);
  });

  it("passes that typecheck", () => {
    // the real command, run the real way, against the real file
    let out = "";
    let code = 0;
    try {
      out = execFileSync("npx", ["tsc", "-p", "tsconfig.json", "--noEmit"], {
        cwd: pkgDir,
        encoding: "utf8",
        stdio: "pipe",
        shell: true,
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      code = e.status ?? 1;
      out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    expect(code, out).toBe(0);
  }, 120000);
});
