import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { LOCAL_VAD } from "../src/index";

/**
 * The shared voice detector always has files - it is a literal in the
 * catalogue with one in it - and its type said `files?`. So four places coped
 * with a possibility that does not exist, in three different ways: two
 * asserted with `!`, one threw an explicit error, and one defaulted with
 * `?? []`.
 *
 * That spread is the symptom. `516247f` and `2ca6207` made this file the one
 * every local model needs, and `517415c` fixed the assertion in `createLocalSttStream`
 * while leaving the two beside it - because a `!` silences
 * `noUncheckedIndexedAccess` completely, so the sweep that found 56 sites
 * could not see them.
 *
 * The fix is the type, the way `SPEAKER_COLORS` became a non-empty tuple: say
 * what is true and nobody has to assert it. This holds that line - if the type
 * is ever widened back, the assertions creep back with it and this goes red.
 */

const root = path.resolve(__dirname, "..", "..", "..");

/** shipping source that mentions the shared detector's file list */
function assertionSites(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", "test"].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
        const text = fs.readFileSync(full, "utf8");
        text.split(/\r?\n/).forEach((line, i) => {
          // a non-null assertion on a `files` list, wherever the VAD is bound
          if (/\bfiles!/.test(line) && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//")) {
            out.push(`${path.relative(root, full).split(path.sep).join("/")}:${i + 1}  ${line.trim().slice(0, 64)}`);
          }
        });
      }
    }
  };
  for (const group of ["packages", "apps"]) {
    const base = path.join(root, group);
    if (!fs.existsSync(base)) continue;
    for (const pkg of fs.readdirSync(base)) {
      walk(path.join(base, pkg, "src"));
      walk(path.join(base, pkg, "renderer"));
    }
  }
  return out;
}

describe("the shared voice detector", () => {
  it("declares the files it is documented to have", () => {
    expect(LOCAL_VAD.files, "the catalogue entry lost its file list").toBeTruthy();
    expect(LOCAL_VAD.files?.length, "the shared VAD is the one file every local model needs").toBeGreaterThan(0);
  });

  it("needs no non-null assertion anywhere, because its type says so", () => {
    const sites = assertionSites();
    expect(
      sites,
      "the type promises a file list, so asserting one means the promise was weakened:\n" + sites.join("\n"),
    ).toEqual([]);
  });

  it("read the source, so the assertion above is about something", () => {
    // an empty walk would make it pass while checking nothing
    const anyFilesRead = fs.existsSync(path.join(root, "packages", "relay", "src", "localStt.ts"));
    expect(anyFilesRead).toBe(true);
  });
});
