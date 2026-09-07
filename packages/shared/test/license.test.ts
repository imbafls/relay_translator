import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A licence is a claim about what other people may do with this code, and until
 * now the repo made it in the wrong place: the redesigned landing page said
 * "MIT licensed" in three places while there was no LICENSE file and no
 * `license` field anywhere in the workspace. Public is not the same as
 * licensed - with no licence, nobody may reuse any of it.
 *
 * So: the file is the fact, `license` fields are statements about it, and they
 * have to agree. Same shape as versions.test.ts, which exists because a version
 * stated in two places drifted.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const licensePath = path.join(root, "LICENSE");

const read = (rel: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));

/** every workspace package.json, plus the root */
function packageFiles(): string[] {
  const out = ["package.json"];
  for (const group of ["apps", "packages"]) {
    for (const name of fs.readdirSync(path.join(root, group))) {
      const rel = `${group}/${name}/package.json`;
      if (fs.existsSync(path.join(root, rel))) out.push(rel);
    }
  }
  return out;
}

describe("the licence", () => {
  it("exists at the root, where every tool and every reader looks for it", () => {
    expect(fs.existsSync(licensePath)).toBe(true);
  });

  it("is the MIT text, not a file that merely mentions MIT", () => {
    const text = fs.readFileSync(licensePath, "utf8");
    expect(text).toMatch(/^MIT License/);
    // the grant and the disclaimer are the two halves that do the work; a
    // truncated licence is worse than none, because it looks like one
    expect(text).toMatch(/Permission is hereby granted, free of charge/);
    expect(text).toMatch(/without restriction/);
    expect(text).toMatch(/THE SOFTWARE IS PROVIDED "AS IS"/);
    expect(text).toMatch(/WITHOUT WARRANTY OF ANY KIND/);
  });

  it("names a holder and a year, which MIT requires and a template leaves blank", () => {
    const text = fs.readFileSync(licensePath, "utf8");
    const line = /^Copyright \(c\) (\d{4})(?:-\d{4})? (.+)$/m.exec(text);
    expect(line).not.toBeNull();
    // the placeholders a copied template ships with
    expect(line![2]).not.toMatch(/\[|\]|<|>|YOUR NAME|FULLNAME/i);
    expect(line![2].trim().length).toBeGreaterThan(0);
  });

  it("is stated the same way by every package that states it", () => {
    const declared = packageFiles()
      .map((f) => [f, read(f).license as string | undefined] as const)
      .filter(([, l]) => l !== undefined);

    // the root at minimum, or the manifests say nothing about a licence that
    // the repository does carry
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter(([, l]) => l !== "MIT")).toEqual([]);
  });
});
