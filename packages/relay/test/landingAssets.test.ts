import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startRelay } from "../src/server";
import type { RelayHandle } from "../src/server";

/**
 * Every asset the pages this relay serves actually ask for.
 *
 * The relay answers `/` with `home.html` and `/watch/<token>` with
 * `index.html`, and those pages then request things. The route table already
 * carries one special case for that - `/fonts/` from the root, with a comment
 * saying "the landing page loads these from the root, the viewer from /watch/"
 * - which is somebody noticing the problem for one asset and stopping there.
 * `home.html` also asks for `/favicon.ico`, `/favicon.svg` and
 * `/apple-touch-icon.png`, and those fell through to 404.
 *
 * Cosmetic, and visible: no icon in the tab, a generic square if a reader adds
 * the link to a phone's home screen. The captions are unaffected. It matters
 * because it is the shape this run keeps finding - the fix went in for the one
 * asset in front of somebody and the adjacent ones stayed broken, which is
 * lesson 2 word for word.
 *
 * The list is READ OFF THE PAGES rather than written here, so an asset added to
 * the markup tomorrow is covered without anyone remembering this file. That is
 * the whole point: a hand-written list of icons would have the same failure
 * mode as the route table it is checking.
 */

let relay: RelayHandle;
let dir: string;

const publicDir = path.resolve(__dirname, "..", "..", "viewer", "public");
const read = (name: string): string => fs.readFileSync(path.join(publicDir, name), "utf8");

/**
 * Local subresources a page makes the browser fetch: `<link>`, `<script>`,
 * `<img>`. Not every `href` on the page.
 *
 * `home.html` has `<a href="/download">`, which is a person clicking a button,
 * and it answers 404 on a relay with no installers folder - correctly, and by
 * design. Treating that as a missing asset made the first version of this test
 * report a defect that was not one. A subresource fails without anybody asking
 * for it; a link fails only when somebody does, and means something different.
 */
function referenced(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<(?:link|script|img)\b[^>]*?(?:href|src)="([^"]+)"/g)) {
    const ref = m[1] ?? "";
    if (/^(?:https?:)?\/\//.test(ref) || ref.startsWith("data:") || ref.startsWith("#")) continue;
    out.add(ref);
  }
  return [...out];
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-landing-"));
  relay = await startRelay({ port: 0, dataDir: dir, mockStt: true, mockGemini: true });
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
});

const get = (p: string): Promise<Response> => fetch(`http://127.0.0.1:${relay.port}${p}`);

describe("what the pages this relay serves ask it for", () => {
  it("finds references in both pages, so the checks below are not vacuous", () => {
    expect(referenced(read("home.html")).length, "home.html references nothing local").toBeGreaterThan(2);
    expect(referenced(read("index.html")).length, "index.html references nothing local").toBeGreaterThan(2);
  });

  it("serves the landing page itself", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
  });

  /**
   * Resolved the way a browser would, not by gluing strings together.
   *
   * `index.html` is served at `/watch/<token>` with no trailing slash, so a
   * relative `style.css` on that page resolves to `/watch/style.css` - the
   * directory part of the base - and not to `/watch/<token>/style.css`. The
   * first version of this test built the second form, got a 404, and for a
   * moment looked like it had found a bug in the relay rather than in itself.
   */
  const resolved = (base: string, ref: string): string =>
    new URL(ref, `http://127.0.0.1:${relay.port}${base}`).pathname;

  it("serves everything the landing page asks for", async () => {
    const missing: string[] = [];
    for (const ref of referenced(read("home.html"))) {
      const res = await get(resolved("/", ref));
      if (res.status !== 200) missing.push(`${ref} -> ${res.status}`);
    }
    expect(
      missing,
      "the landing page asks this relay for these and does not get them. A reader sees a page with no icon, " +
        "and a phone that adds the link to its home screen gets a blank square",
    ).toEqual([]);
  });

  it("serves everything the viewer page asks for", async () => {
    const missing: string[] = [];
    for (const ref of referenced(read("index.html"))) {
      const res = await get(resolved(`/watch/${relay.state.viewerToken}`, ref));
      if (res.status !== 200) missing.push(`${ref} -> ${res.status}`);
    }
    expect(missing, "the viewer page asks for these and does not get them").toEqual([]);
  });

  it("still refuses to climb out of the bundle", async () => {
    // widening the root route must not widen this
    for (const p of ["/../package.json", "/..%2fpackage.json", "/fonts/../../package.json"]) {
      const res = await get(p);
      expect(res.status, `${p} was served`).not.toBe(200);
    }
  });
});

/**
 * The same question asked of the standalone binary.
 *
 * A self-hoster runs `callout-relay-server.exe`, which carries the viewer
 * bundle inside it as SEA assets rather than reading a directory. That list
 * lives in `packages/relay/sea/sea-config.json`, by hand, and it had gone
 * stale in exactly the way a hand-written list does: eleven files and three
 * icons the pages ask for were not among them.
 *
 * The route above is only half the fix. Serving `/favicon.ico` is no use if the
 * binary does not contain it - the relay would find the route, ask
 * `readViewerAsset`, and get nothing back. Fixing one and not the other leaves
 * the same 404 arriving by a different path, which is the sort of half-fix this
 * repo's second lesson is about.
 *
 * Read off the pages again, for the same reason: a list is what went stale.
 */
describe("what the standalone binary carries", () => {
  const seaConfig = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "sea", "sea-config.json"), "utf8"),
  ) as { assets?: Record<string, string> };

  it("declares assets at all, so the check below is not vacuous", () => {
    expect(Object.keys(seaConfig.assets ?? {}).length, "sea-config.json declares no assets").toBeGreaterThan(5);
  });

  it("carries every subresource the pages it serves ask for", () => {
    const embedded = new Set(Object.keys(seaConfig.assets ?? {}));
    const wanted = new Set<string>();
    for (const page of ["home.html", "index.html"]) {
      wanted.add(`viewer/${page}`);
      for (const ref of referenced(read(page))) wanted.add(`viewer/${ref.replace(/^\//, "")}`);
    }

    const missing = [...wanted].filter((a) => !embedded.has(a));
    expect(
      missing,
      "the pages this binary serves ask for these and it does not contain them. The route can resolve the " +
        "request and still find nothing, so a self-hosted relay answers 404 for its own page's icons",
    ).toEqual([]);
  });

  it("points every declared asset at a file that is really there", () => {
    const seaDir = path.resolve(__dirname, "..", "sea");
    const dangling = Object.entries(seaConfig.assets ?? {}).filter(
      ([, rel]) => !fs.existsSync(path.resolve(seaDir, rel)),
    );
    expect(
      dangling.map(([name]) => name),
      "sea-config.json embeds paths that do not exist, so the build either fails or ships a binary missing them",
    ).toEqual([]);
  });
});
