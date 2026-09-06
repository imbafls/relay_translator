import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `@callout-relay/companion` has two entry points. The default one pulls in
 * node-only modules, so package.json maps it for bundlers:
 *
 *     "browser": { "./dist/index.js": "./dist/browser.js" }
 *
 * The Electron renderer is bundled for the browser, so esbuild follows that
 * map and the renderer gets `src/browser.ts` - a hand-maintained subset of the
 * default barrel. Adding an export to `src/index.ts` and not to `src/browser.ts`
 * therefore typechecks, builds without a warning, and passes every test: vitest
 * resolves the default entry, so nothing in the suite ever looks at the file
 * the app actually loads. It fails at runtime, in the renderer, as
 * `X is not a function`.
 *
 * That happened: the level meter was moved onto a shared `rmsLevel` and the
 * export went to the wrong barrel. The meter read a flat zero through a live
 * session and only a browser showed it - the guards for `rmsLevel` itself were
 * all green, because the function was right and unreachable.
 */

const repo = path.resolve(__dirname, "..", "..", "..");
const read = (p: string): string => fs.readFileSync(path.join(repo, p), "utf8");

/** the names a file imports from the companion package */
function importedFrom(source: string, pkg: string): string[] {
  const names: string[] = [];
  const re = new RegExp(String.raw`import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']${pkg}["']`, "g");
  for (const m of source.matchAll(re)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/** the names a barrel re-exports */
function exportedBy(source: string): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}/g)) {
    for (const raw of m[1].split(",")) {
      const parts = raw.trim().split(/\s+as\s+/);
      const name = (parts[1] ?? parts[0]).trim().replace(/^type\s+/, "");
      if (name) names.add(name);
    }
  }
  return names;
}

describe("the renderer's view of the companion package", () => {
  const renderer = read("apps/standalone/renderer/app.ts");
  const browserBarrel = read("packages/companion/src/browser.ts");

  it("finds something to check, so a rename cannot make this vacuous", () => {
    expect(importedFrom(renderer, "@callout-relay/companion").length).toBeGreaterThan(0);
    expect(exportedBy(browserBarrel).size).toBeGreaterThan(0);
  });

  it("resolves every name the renderer imports against the browser entry, not the default one", () => {
    const wanted = importedFrom(renderer, "@callout-relay/companion");
    const offered = exportedBy(browserBarrel);
    const missing = wanted.filter((n) => !offered.has(n));
    expect(missing, `missing from packages/companion/src/browser.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("still maps the default entry to the browser one, which is what makes any of this apply", () => {
    const pkg = JSON.parse(read("packages/companion/package.json")) as {
      main: string;
      browser?: Record<string, string>;
    };
    expect(pkg.browser?.[`./${pkg.main}`]).toBe("./dist/browser.js");
  });
});
