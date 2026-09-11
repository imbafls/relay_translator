import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The renderer's Content-Security-Policy is a meta tag in index.html, and what
 * it refuses fails without a sound: no exception, nothing on screen, one line
 * in a console nobody has open. That is how every <select> in the app lost its
 * arrow. The chevron was a data: SVG in style.css and the policy has no
 * img-src, so default-src 'self' governed it and refused it - in the packaged
 * app, from the redesign that drew it that way until this test.
 *
 * So every resource the page names, and every url() in the stylesheets it
 * links, is judged here against the directive that governs it, the way
 * Chromium does: img-src, font-src, style-src or script-src, falling back to
 * default-src.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const rendererDir = path.resolve(__dirname, "..", "renderer");
const html = fs.readFileSync(path.join(rendererDir, "index.html"), "utf8");

/** a URL the page resolves, read from where build.mjs takes it - the fonts are
 *  the viewer's, copied in beside the renderer's own files */
function shipped(rel: string): string {
  const file = rel.startsWith("fonts/") ? path.join(root, "packages", "viewer", "public", rel) : path.join(rendererDir, rel);
  return fs.readFileSync(file, "utf8");
}

type Policy = Map<string, string[]>;

function policyOf(page: string): Policy {
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(page);
  if (!meta) throw new Error("no Content-Security-Policy meta in the page");
  const policy: Policy = new Map();
  for (const directive of (meta[1] ?? "").split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name) policy.set(name.toLowerCase(), sources);
  }
  return policy;
}

/** Chromium's answer for one load: the directive's own list, else default-src */
function admits(policy: Policy, directive: string, url: string): boolean {
  const sources = policy.get(directive) ?? policy.get("default-src");
  if (!sources) return true;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  return sources.some((source) => {
    const s = source.toLowerCase();
    // a relative URL resolves against the page itself, which is what 'self' names
    if (!scheme) return s === "'self'" || s === "*";
    if (s === `${scheme}:`) return true;
    // * admits network schemes only - never data:, blob: or filesystem:
    if (s === "*") return scheme === "http" || scheme === "https";
    return /^https?:\/\//.test(s) && new URL(url).origin === new URL(s).origin;
  });
}

interface Load {
  /** the file that names it */
  from: string;
  directive: string;
  url: string;
}

/** the url()s in a stylesheet, each under the directive that governs its fetch */
function cssLoads(from: string, css: string): Load[] {
  const loads: Load[] = [];
  const urls = (text: string) => [...text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)].map((m) => m[2] ?? "");
  let rest = css.replace(/\/\*[\s\S]*?\*\//g, "");
  rest = rest.replace(/@font-face\s*\{[^}]*\}/g, (block) => {
    for (const url of urls(block)) loads.push({ from, directive: "font-src", url });
    return "";
  });
  rest = rest.replace(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1[^;]*;/g, (_all, _quote, url: string) => {
    loads.push({ from, directive: "style-src", url });
    return "";
  });
  for (const url of urls(rest)) loads.push({ from, directive: "img-src", url });
  return loads;
}

/** everything the page loads: its stylesheets and their url()s, scripts, images */
function pageLoads(page: string, read: (rel: string) => string): Load[] {
  const loads: Load[] = [];
  const attr = (tag: string, name: string) => new RegExp(`\\s${name}=["']([^"']+)["']`, "i").exec(tag)?.[1];
  for (const [tag] of page.matchAll(/<(?:link|script|img)\b[^>]*>/gi)) {
    if (/^<link/i.test(tag) && /\srel=["']stylesheet["']/i.test(tag)) {
      const href = attr(tag, "href");
      if (!href) continue;
      loads.push({ from: "index.html", directive: "style-src", url: href });
      loads.push(...cssLoads(href, read(href)));
    } else if (/^<script/i.test(tag)) {
      const src = attr(tag, "src");
      if (src) loads.push({ from: "index.html", directive: "script-src", url: src });
    } else if (/^<img/i.test(tag)) {
      const src = attr(tag, "src");
      if (src) loads.push({ from: "index.html", directive: "img-src", url: src });
    }
  }
  return loads;
}

const policy = policyOf(html);

describe("the renderer's Content-Security-Policy", () => {
  it("admits every resource the page and its stylesheets load", () => {
    const loads = pageLoads(html, shipped);
    // the walk has to reach inside the stylesheets, or this passes on nothing
    expect(loads.map((l) => l.url)).toEqual(
      expect.arrayContaining(["style.css", "fonts/fonts.css", "archivo-latin.woff2", "app.js"]),
    );
    const refused = loads
      .filter((l) => !admits(policy, l.directive, l.url))
      .map((l) => `${l.from}: ${l.directive} refuses ${l.url.slice(0, 60)}`);
    expect(refused).toEqual([]);
  });

  it("refuses the data: chevron the stylesheet used to draw", () => {
    // the rule as the redesign wrote it - the checker's proof that it can see
    // the failure this file exists for
    const loads = cssLoads(
      "style.css",
      `.chev { background: no-repeat center / 10px 10px url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><path d='M1 3l4 4 4-4'/></svg>"); }`,
    );
    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatchObject({ directive: "img-src", url: expect.stringMatching(/^data:image\/svg\+xml;utf8,<svg /) });
    expect(admits(policy, "img-src", loads[0]!.url)).toBe(false);
  });

  it("judges each url() by the directive that governs its fetch", () => {
    const loads = cssLoads(
      "x.css",
      `@import url("more.css"); @font-face { src: url(data:font/woff2;base64,AAAA) } .a { background: url(data:image/png;base64,AAAA) }`,
    );
    expect(Object.fromEntries(loads.map((l) => [l.url, l.directive]))).toEqual({
      "more.css": "style-src",
      "data:font/woff2;base64,AAAA": "font-src",
      "data:image/png;base64,AAAA": "img-src",
    });
    const meta = (content: string) => policyOf(`<meta http-equiv="Content-Security-Policy" content="${content}" />`);
    const fontsOnly = meta("default-src 'self'; font-src 'self' data:");
    expect(admits(fontsOnly, "font-src", "data:font/woff2;base64,AAAA")).toBe(true);
    // no img-src of its own, so the image falls back to default-src and is refused
    expect(admits(fontsOnly, "img-src", "data:image/png;base64,AAAA")).toBe(false);
    expect(admits(fontsOnly, "img-src", "chevron.svg")).toBe(true);
    expect(admits(meta("default-src 'self'; img-src 'self' data:"), "img-src", "data:image/png;base64,AAAA")).toBe(true);
    // * is not a wildcard for data:
    expect(admits(meta("img-src *"), "img-src", "data:image/png;base64,AAAA")).toBe(false);
    expect(admits(meta("img-src *"), "img-src", "https://example.com/a.png")).toBe(true);
  });
});
