import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The two shipped stylesheets, judged against `DESIGN.md`.
 *
 * DESIGN.md is the source of truth for visuals - it fixes the palette by hex,
 * `--radius: 0`, the two families, and the rule that amber is the only
 * chromatic colour. Nothing checked any of it. 828 lines of renderer CSS and
 * 370 of viewer CSS drifted against a spec that could only be enforced by
 * somebody remembering it, and a spec nothing enforces is a spec that is
 * already wrong somewhere.
 *
 * `rendererCsp.test.ts` is the precedent: read the shipped stylesheet off disk
 * and reason about it, rather than trusting that anyone looked.
 *
 * WHAT IS DELIBERATELY NOT CHECKED HERE, and why, so the next reader does not
 * mistake the gap for an oversight:
 *
 * - **"Amber appears only when something is live or needs attention."** A
 *   stylesheet cannot know whether `.wn-kind` is a warning. This is semantic and
 *   is not mechanically enforceable; what IS enforceable is the half that
 *   catches the failure the rule exists to prevent - that nothing chromatic
 *   joins the palette at all. `only amber and the speaker colours are chromatic`
 *   below is that half.
 * - **Type scale.** DESIGN.md gives sizes per surface (18px stage, 21px phone
 *   latest, 34/46px OBS) but the viewer's are driven by a user `--size` setting
 *   with multipliers, so a literal comparison would assert the default and go
 *   red on a feature working as designed.
 * - **Anything inside a `--custom-property` definition.** A theme block
 *   redefining `--ink` for the phone's Light mode is a token definition, not a
 *   hard-coded colour, and DESIGN.md names the Light theme without giving it a
 *   palette. Use sites are what this judges.
 */

const root = path.resolve(__dirname, "..", "..", "..");

const SHEETS = [
  {
    name: "desktop renderer",
    file: path.join(root, "apps", "standalone", "renderer", "style.css"),
    chromatic: ["--amber", "--chat", "--chat-2"],
  },
  {
    name: "phone/OBS viewer",
    file: path.join(root, "packages", "viewer", "public", "style.css"),
    // `--accent` is the reader's own, under `/* viewer-configurable */`: the
    // display bar's Colors swatches write it at runtime, and app.js says in so
    // many words that "the reader owns that one". What the product controls is
    // the value it SHIPS, and that is asserted on its own below.
    chromatic: ["--accent", "--amber", "--chat", "--chat-2"],
  },
];

/** the palette DESIGN.md fixes by hex, as `--token` -> exact value */
const SPEC_TOKENS: Record<string, string> = {
  "--bg": "#131313",
  "--ink": "#efeae0",
  "--ink-2": "#b8b3a8",
  "--dim": "#8a877f",
  "--mute": "#3a3834",
  "--amber": "#e0a43a",
};

/** the same palette as rgb triples, plus the black DESIGN.md names for the OBS shadow */
const PALETTE_RGB = new Set([
  "19,19,19", // --bg
  "239,234,224", // --ink
  "184,179,168", // --ink-2
  "138,135,127", // --dim
  "58,56,52", // --mute
  "224,164,58", // --amber
  // "Transparent, bottom-left ... text-shadow 0 2px 6px rgba(0,0,0,.7)" and the
  // OBS-black theme the display bar offers. Named by the spec, so not an invention.
  "0,0,0",
]);

/**
 * Chromatic tokens the product carries that DESIGN.md does not name.
 *
 * The spec says "Only `--amber` is chromatic; never add green/red." The 0.4
 * additions then gave every speaker its own colour - shipped, verified live with
 * three sources, and editable by the user - so the code carries two blues the
 * spec never described. That is a disagreement between the spec and the product,
 * and resolving it is the owner's call: changing either the colours or the
 * sentence is a design decision, not a conformance fix. Named here so the guard
 * reports the drift once, in one place, instead of failing on it for ever.
 */
const UNSPEC_CHROMATIC = new Set(["--chat", "--chat-2", "--accent"]);

const read = (file: string): string => fs.readFileSync(file, "utf8");

/** every `--token: value` declaration, wherever it appears */
function tokens(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    // first wins: `:root` is at the top, theme blocks below override for a surface
    if (!out.has(m[1])) out.set(m[1], m[2].trim());
  }
  return out;
}

/** "#efeae0" / "rgba(239, 234, 224, .14)" -> "239,234,224", or null if not a colour */
function rgbOf(value: string): string | null {
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value.trim());
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(",");
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(value.trim());
  if (!fn) return null;
  const parts = fn[1].split(/[,/\s]+/).filter(Boolean).slice(0, 3).map((n) => Math.round(Number(n)));
  return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? parts.join(",") : null;
}

/** how far from grey a colour is; the palette's warm neutrals sit at 16 and below */
function chroma(rgb: string): number {
  const n = rgb.split(",").map(Number);
  return Math.max(...n) - Math.min(...n);
}

/** declarations that are NOT custom-property definitions, with their line numbers */
function useSites(css: string): { line: number; prop: string; value: string }[] {
  const out: { line: number; prop: string; value: string }[] = [];
  css.split("\n").forEach((text, i) => {
    // strip comments so prose about a colour is not read as one
    const line = text.replace(/\/\*.*?\*\//g, "");
    for (const m of line.matchAll(/(?:^|[;{])\s*([a-z-]+)\s*:\s*([^;{}]+)/g)) {
      if (m[1].startsWith("--")) continue;
      out.push({ line: i + 1, prop: m[1], value: m[2].trim() });
    }
  });
  return out;
}

describe("the shipped stylesheets against DESIGN.md", () => {
  for (const sheet of SHEETS) {
    describe(sheet.name, () => {
      it("declares the palette at exactly the values the spec fixes", () => {
        const declared = tokens(read(sheet.file));
        for (const [name, want] of Object.entries(SPEC_TOKENS)) {
          expect(declared.get(name), `${name} is missing from ${sheet.name}`).toBeDefined();
          expect(
            rgbOf(declared.get(name) ?? ""),
            `${name} is ${declared.get(name)}, and DESIGN.md fixes it at ${want}`,
          ).toBe(rgbOf(want));
        }
      });

      it("uses no colour the palette does not contain", () => {
        const css = read(sheet.file);
        const bad: string[] = [];
        for (const { line, prop, value } of useSites(css)) {
          for (const m of value.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)) {
            const rgb = rgbOf(m[0]);
            if (rgb && !PALETTE_RGB.has(rgb)) bad.push(`${sheet.file}:${line} ${prop}: ${m[0]}`);
          }
        }
        expect(bad, `a colour outside the palette, which DESIGN.md calls "every surface"`).toEqual([]);
      });

      it("rounds no corner the spec squares", () => {
        const css = read(sheet.file);
        // `--radius: 0` - "square everything". 50% is allowed and only 50%:
        // DESIGN.md asks for the glyphs ●/○/■, and the status dots draw them in
        // CSS rather than as characters. A rounded PANEL or button - the thing
        // "no cards, no rounded panels" forbids - takes a px value and is caught.
        const bad = useSites(css)
          .filter((d) => d.prop === "border-radius")
          .filter((d) => !/^(0|50%|var\(--radius\))$/.test(d.value.trim()))
          .map((d) => `${sheet.file}:${d.line} border-radius: ${d.value}`);
        expect(bad, "DESIGN.md sets --radius: 0 and says square everything").toEqual([]);
      });

      it("names no font family beyond the two the spec ships", () => {
        const css = read(sheet.file);
        const bad = useSites(css)
          .filter((d) => d.prop === "font-family")
          .filter((d) => !/^var\(--(sans|mono|cap-font)\)$/.test(d.value.trim()))
          .map((d) => `${sheet.file}:${d.line} font-family: ${d.value}`);
        expect(bad, "DESIGN.md ships Archivo and Martian Mono, self-hosted, and nothing else").toEqual([]);
      });

      it("lets only amber and the speaker colours be chromatic", () => {
        const declared = tokens(read(sheet.file));
        const chromatic: string[] = [];
        for (const [name, value] of declared) {
          const rgb = rgbOf(value);
          // 16 is the widest spread in the spec's own neutrals (--ink-2 at b8b3a8)
          if (rgb && chroma(rgb) > 20 && name !== "--amber" && !UNSPEC_CHROMATIC.has(name)) {
            chromatic.push(`${name}: ${value}`);
          }
        }
        expect(chromatic, 'DESIGN.md: "Only --amber is chromatic; never add green/red"').toEqual([]);
      });
    });
  }

  /**
   * Both sheets carry `--chat` and `--chat-2`, and DESIGN.md does not. This
   * asserts the divergence is exactly that size rather than growing quietly: a
   * third speaker colour, or a green, would be a design decision somebody made
   * without the spec, and it should reach a person rather than a stylesheet.
   */
  it("carries no chromatic token beyond the ones already reconciled", () => {
    for (const sheet of SHEETS) {
      const declared = tokens(read(sheet.file));
      const chromatic = [...declared]
        .filter(([, v]) => {
          const rgb = rgbOf(v);
          return rgb !== null && chroma(rgb) > 20;
        })
        .map(([name]) => name)
        .sort();
      expect(
        chromatic,
        `${sheet.name} grew a chromatic token DESIGN.md has never been asked about`,
      ).toEqual(sheet.chromatic);
    }
  });

  /**
   * The reader may set any accent they like - that is what the Colors swatches
   * are for - but the one the product ships is amber, and a default that had
   * drifted would put a colour of nobody's choosing on every phone that has
   * never opened the display settings.
   */
  it("ships the reader's accent defaulting to amber", () => {
    const declared = tokens(read(SHEETS[1].file));
    expect(rgbOf(declared.get("--accent") ?? ""), "the shipped accent is no longer amber").toBe(
      rgbOf(SPEC_TOKENS["--amber"]),
    );
  });
});


/**
 * The custom properties the scripts set, against the stylesheets that read them.
 *
 * The viewer's display settings are seven strings. `applyStyle()` writes
 * `--cap-font`, `--size`, `--fg`, `--accent`, `--bgc` and `--shadow` onto the
 * root element, `applyBrand()` writes `--brand`, and the stylesheet reads them
 * back by name. Nothing connects the two ends: `packages/viewer/public/app.js`
 * is served as-is with no build step, so it can import nothing, and the sheet
 * is a separate file with no knowledge of it.
 *
 * Rename either end and the failure is total and silent. No error, no
 * exception, no failing test - happy-dom does not apply stylesheets, so the
 * viewer suite is structurally unable to see it - just a reader whose chosen
 * font size, or colour, or the streamer's brand, quietly stops working while
 * every setting still looks saved. It is the same contract-with-no-shared-
 * constant that `closeCodes.test.ts` and `viewerPing.test.ts` exist for, and
 * this repo has found that shape already broken twice.
 *
 * Two directions, because they fail differently:
 *
 *  - set by a script and read by nothing: the setting does nothing at all
 *  - read by a stylesheet and defined nowhere: `var()` falls back to the
 *    initial value, so the element renders, wrongly, with no clue why
 *
 * Comments are stripped from the scripts first. A prose mention of `var(--fg)`
 * explaining what the VIEWER does, sitting in the renderer's source, reads as a
 * use of a token the renderer does not have - which is exactly the false
 * positive this produced before the strip was added.
 */
describe("custom properties, across the files that cannot import each other", () => {
  const SURFACES = [
    {
      name: "phone/OBS viewer",
      css: ["packages/viewer/public/style.css"],
      markup: ["packages/viewer/public/index.html", "packages/viewer/public/home.html"],
      scripts: ["packages/viewer/public/app.js"],
    },
    {
      name: "desktop renderer",
      css: ["apps/standalone/renderer/style.css"],
      markup: ["apps/standalone/renderer/index.html"],
      scripts: ["apps/standalone/renderer/app.ts"],
    },
  ];

  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");
  const stripComments = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  describe.each(SURFACES)("$name", (surface) => {
    const css = surface.css.map(read).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
    const markup = surface.markup.map(read).join("\n");
    const scripts = stripComments(surface.scripts.map(read).join("\n"));

    /** `--x:` anywhere a value can be declared */
    const declared = new Set<string>();
    for (const m of `${css}\n${markup}`.matchAll(/(--[\w-]+)\s*:/g)) declared.add(m[1] ?? "");
    /** written from a script at runtime */
    const fromScript = new Set<string>();
    for (const m of scripts.matchAll(/setProperty\(\s*["'`](--[\w-]+)["'`]/g)) fromScript.add(m[1] ?? "");
    /** `var(--x)` - only stylesheets and markup consume; a script sets */
    const consumed = new Set<string>();
    for (const m of `${css}\n${markup}`.matchAll(/var\(\s*(--[\w-]+)/g)) consumed.add(m[1] ?? "");

    it("reads something, so the two checks below are not vacuous", () => {
      expect(declared.size, "no custom property was declared anywhere on this surface").toBeGreaterThan(5);
      expect(consumed.size, "no var() use was found, so nothing is being held to anything").toBeGreaterThan(5);
    });

    it("sets nothing from script that no stylesheet reads", () => {
      const dead = [...fromScript].filter((v) => !consumed.has(v));
      expect(
        dead,
        "the script writes these onto the root element and no stylesheet reads them back, so setting them does " +
          "nothing at all - and the panel that sets them still looks like it worked",
      ).toEqual([]);
    });

    it("reads nothing from the stylesheet that is defined nowhere", () => {
      const orphan = [...consumed].filter((v) => !declared.has(v) && !fromScript.has(v));
      expect(
        orphan,
        "the stylesheet reads these and nothing defines them, so var() falls back to the initial value and the " +
          "element renders wrongly with nothing to say why",
      ).toEqual([]);
    });
  });
});


/**
 * The data attributes the stylesheets select on, against the code that sets them.
 *
 * The last name-shaped contract on this seam. A rule like
 * `[data-session="live"]` waits for a string a script writes at runtime, and
 * the two are connected by nothing: rename the state and the rule stops
 * matching, with no error and no failing test, because happy-dom does not apply
 * stylesheets. The ON AIR panel simply stops looking live.
 *
 * It is how the previous iteration found something real: `[data-kind="added"]`
 * names a value that is nowhere in `app.ts`, because it comes from shared's
 * `ChangeKind` by way of `whatsNew.ts` - a renderer module the id checker had
 * never been told about.
 *
 * **What this deliberately does not promise.** The values are computed at the
 * point of use (`el.dataset.state = state`), so the strong form - every value a
 * selector needs is reachable at runtime - is not statically decidable. This
 * takes the weaker one: the value exists as a literal somewhere in the code that
 * feeds the surface. That catches a rename, which is the realistic break, and it
 * can be masked for a short common word that survives elsewhere for unrelated
 * reasons. Worth having and worth not overstating. The attribute NAME check has
 * no such weakness - `data-session` is distinctive, and if nothing sets it, that
 * whole family of rules is dead.
 */
describe("data attributes, between the stylesheets and the code that sets them", () => {
  const SURFACES = [
    {
      name: "desktop renderer",
      css: ["apps/standalone/renderer/style.css"],
      markup: ["apps/standalone/renderer/index.html"],
      // the renderer's own modules, plus the shared source its values come from
      scripts: [
        "apps/standalone/renderer/app.ts",
        "apps/standalone/renderer/dom.ts",
        "apps/standalone/renderer/log.ts",
        "apps/standalone/renderer/meter.ts",
        "apps/standalone/renderer/whatsNew.ts",
        "packages/shared/src/index.ts",
        "packages/shared/src/changelog.ts",
      ],
    },
    {
      name: "phone/OBS viewer",
      css: ["packages/viewer/public/style.css"],
      markup: ["packages/viewer/public/index.html", "packages/viewer/public/home.html"],
      scripts: ["packages/viewer/public/app.js", "packages/shared/src/index.ts"],
    },
  ];

  const load = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");
  const noComments = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const kebab = (s: string): string => s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

  describe.each(SURFACES)("$name", (surface) => {
    const css = surface.css.map(load).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
    const markup = surface.markup.map(load).join("\n");
    const scripts = noComments(surface.scripts.map(load).join("\n"));

    /** data-x -> the exact values the sheet waits for */
    const selected = new Map<string, Set<string>>();
    for (const m of css.matchAll(/\[data-([a-z-]+)(?:\s*[~^|$*]?=\s*"([^"]*)")?\]/g)) {
      const name = m[1] ?? "";
      if (!selected.has(name)) selected.set(name, new Set());
      if (m[2] !== undefined) selected.get(name)?.add(m[2]);
    }

    const setNames = new Set<string>();
    for (const m of scripts.matchAll(/dataset\.([a-zA-Z][\w]*)\s*=/g)) setNames.add(kebab(m[1] ?? ""));
    for (const m of scripts.matchAll(/setAttribute\(\s*["'`]data-([a-z-]+)["'`]/g)) setNames.add(m[1] ?? "");
    for (const m of markup.matchAll(/\sdata-([a-z-]+)\s*=/g)) setNames.add(m[1] ?? "");

    const literals = new Set<string>();
    for (const m of scripts.matchAll(/["'`]([A-Za-z][\w-]*)["'`]/g)) literals.add(m[1] ?? "");
    for (const m of markup.matchAll(/\sdata-[a-z-]+\s*=\s*"([^"]*)"/g)) literals.add(m[1] ?? "");

    it("selects on some, so the two checks below are not vacuous", () => {
      expect(selected.size, "this stylesheet selects on no data attribute at all").toBeGreaterThan(0);
      expect(setNames.size, "nothing in this surface sets a data attribute, so the matcher found nothing").toBeGreaterThan(0);
    });

    it("waits on no attribute that nothing sets", () => {
      const orphans = [...selected.keys()].filter((name) => !setNames.has(name));
      expect(
        orphans,
        "the stylesheet has rules keyed on these and no script or markup ever sets them, so that whole family " +
          "of rules is dead and the elements they style never change appearance",
      ).toEqual([]);
    });

    it("waits on no value the code cannot produce", () => {
      const dead: string[] = [];
      for (const [name, values] of selected) {
        for (const v of values) if (!literals.has(v)) dead.push(`data-${name}="${v}"`);
      }
      expect(
        dead,
        "the stylesheet waits for these exact strings and no code that feeds this surface contains them, so the " +
          "rule never matches - the state it styles simply never appears",
      ).toEqual([]);
    });
  });
});
