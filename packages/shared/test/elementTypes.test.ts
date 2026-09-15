import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The other half of the bargain `renderer/dom.ts` makes.
 *
 * `$<T>(id)` casts whatever `getElementById` returns to `T`, so `inp(id)`
 * claims `HTMLInputElement` for any id at all and `sel(id)` claims
 * `HTMLSelectElement`. A cast to a type parameter is the one thing the compiler
 * cannot check, and `check-renderer-ids.mjs` proves only that the id EXISTS.
 *
 * So `inp()` on a `<select>` compiles and runs: `.value` even works, because
 * both have one. `.checked` is `undefined`, silently, and a setting reads as
 * off for ever. That is the same shape as a dangling id - wrong at runtime,
 * quiet in a browser nobody is watching - and it is the half nothing was
 * checking.
 *
 * Both front-ends are covered. The viewer grew its own `inp`/`sel` split in
 * 946fad6 for exactly this reason, and choosing between them there meant
 * reading the markup by hand - eight inputs and four selects. This is that
 * reading, kept.
 */

const root = path.resolve(__dirname, "..", "..", "..");

const SURFACES = [
  {
    name: "desktop renderer",
    html: "apps/standalone/renderer/index.html",
    src: "apps/standalone/renderer/app.ts",
  },
  {
    name: "phone/OBS viewer",
    html: "packages/viewer/public/index.html",
    src: "packages/viewer/public/app.js",
  },
] as const;

/** every id in the markup, with the tag that carries it */
function idsIn(htmlPath: string): Map<string, string> {
  const html = fs.readFileSync(path.join(root, htmlPath), "utf8");
  const map = new Map<string, string>();
  for (const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g)) {
    const id = /\bid=["']([^"']+)["']/.exec(m[2] ?? "")?.[1];
    if (id) map.set(id, (m[1] ?? "").toLowerCase());
  }
  return map;
}

/** `inp("x")` / `sel("x")` call sites, with the tag each one claims */
function claims(srcPath: string): { fn: string; id: string; wants: string }[] {
  const src = fs.readFileSync(path.join(root, srcPath), "utf8");
  const out: { fn: string; id: string; wants: string }[] = [];
  for (const [fn, wants] of [
    ["inp", "input"],
    ["sel", "select"],
  ] as const) {
    for (const m of src.matchAll(new RegExp(`\\b${fn}\\("([^"]+)"\\)`, "g"))) {
      out.push({ fn, id: m[1] ?? "", wants });
    }
  }
  return out;
}

describe("what the typed element getters claim", () => {
  it.each(SURFACES.map((s) => [s.name, s] as const))("is what the markup carries: %s", (_name, surface) => {
    const ids = idsIn(surface.html);
    const wrong = claims(surface.src)
      // an id the markup does not define at all is check-renderer-ids' job
      .filter((c) => ids.has(c.id) && ids.get(c.id) !== c.wants)
      .map((c) => `${c.fn}("${c.id}") claims <${c.wants}> and the markup has <${ids.get(c.id)}>`);
    expect(wrong, wrong.join("\n")).toEqual([]);
  });

  it("read both surfaces, so the assertions above are about something", () => {
    // an empty read would agree with any markup at all
    const total = SURFACES.reduce((n, s) => n + claims(s.src).length, 0);
    expect(total, "no inp()/sel() call sites were found in either front-end").toBeGreaterThan(50);
    expect(idsIn(SURFACES[0].html).size).toBeGreaterThan(20);
    expect(idsIn(SURFACES[1].html).size).toBeGreaterThan(10);
  });
});
