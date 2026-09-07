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

  /**
   * The fonts are a second licence, and a stricter one. MIT covers the code;
   * the two families in packages/viewer/public/fonts/ are redistributed under
   * the SIL Open Font License, which asks that its text and the copyright
   * notices travel WITH the files. They are served publicly at /fonts/ and
   * copied into the app twice over, so "travel with" means this directory.
   */
  describe("the fonts it redistributes", () => {
    const fontDir = path.join(root, "packages/viewer/public/fonts");
    const oflPath = path.join(fontDir, "OFL.txt");
    /**
     * The families shipped here and the exact notice each upstream publishes.
     *
     * Pinned in full, years included, because both years were a year out when
     * guessed from memory and the whole point of the file is that it was not
     * guessed. If upstream ever changes one, this failing is the correct
     * outcome: somebody should re-fetch rather than edit the string here.
     *
     * Martian Mono contradicts itself upstream and Google Fonts inherited it -
     * ofl/martianmono/OFL.txt says 2021, while the name table (nameID 0) of the
     * shipped binary says 2020. The licence file is what is being reproduced,
     * so the licence file's year is the one carried. Do not "fix" it to 2020.
     */
    const FAMILIES = [
      {
        prefix: "archivo",
        notice: "Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)",
      },
      {
        prefix: "martian-mono",
        notice: "Copyright 2021 The Martian Mono Project Authors (https://github.com/evilmartians/mono)",
      },
    ];

    it("ships the licence beside the font files it applies to", () => {
      expect(fs.existsSync(oflPath)).toBe(true);
    });

    it("credits every family it carries, with upstream's notice verbatim", () => {
      const lines = fs.readFileSync(oflPath, "utf8").split(/\r?\n/);
      for (const f of FAMILIES) {
        expect(lines, `notice for ${f.prefix} is missing or altered`).toContain(f.notice);
      }
    });

    it("carries the licence body, not just the notices", () => {
      const ofl = fs.readFileSync(oflPath, "utf8");
      expect(ofl).toMatch(/SIL Open Font License, Version 1\.1/);
      expect(ofl).toMatch(/PERMISSION & CONDITIONS/);
      expect(ofl).toMatch(/THE FONT SOFTWARE IS PROVIDED "AS IS"/);
    });

    it("leaves no font file uncovered", () => {
      // the guard that bites later: dropping a third family in here without
      // adding its notice is the easy mistake, and it is silent
      const faces = fs.readdirSync(fontDir).filter((f) => f.endsWith(".woff2"));
      expect(faces.length).toBeGreaterThan(0);
      const uncovered = faces.filter((f) => !FAMILIES.some((fam) => f.startsWith(fam.prefix)));
      expect(uncovered, "a font is shipped that no notice covers").toEqual([]);
    });
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
