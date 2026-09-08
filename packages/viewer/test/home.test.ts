// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The landing page, running for real: the shipped home.html in a DOM with its
 * own inline script evaluated in it. Only `fetch` is stood in for - it is the
 * boundary, and every body below is one the Worker genuinely serves.
 *
 * Nothing had ever tested this page. It went through a full redesign carrying
 * placeholder download URLs, a placeholder version and a licence it does not
 * have, and the only reason none of that reached textrelay.cc is that a human
 * read the markup. These tests are so the next redesign does not need one.
 */

const publicDir = path.resolve(__dirname, "..", "public");
const html = fs.readFileSync(path.join(publicDir, "home.html"), "utf8");

/** the real feed, as /updates/latest.yml serves it */
const FEED = [
  "version: 0.5.11",
  "files:",
  "  - url: CalloutRelay-Setup-0.5.11.exe",
  "    sha512: 2KBH7mgnqMlZbhYI5s8tcXbyGNTm1WClApRzkOQOSxxmZxNp8U6AVJnM1C1DKQHnMLiBx6xQz4MSdkk4kjJT3g==",
  "    size: 88238646",
  "path: CalloutRelay-Setup-0.5.11.exe",
  "releaseDate: '2026-09-07T11:43:23.317Z'",
  "",
].join("\n");

/** the head alone, with its stylesheet links dropped - happy-dom would go and
 *  fetch them, and this is a markup assertion, not a network one */
const headOnly = (doc: string): string =>
  doc.replace(/<body[\s\S]*/i, "").replace(/<link rel="stylesheet"[^>]*>/g, "");

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no #${id} in the shipped markup`);
  return el;
};

interface Answers {
  health?: { ok: boolean; body?: unknown };
  feed?: { ok: boolean; body?: string };
  ua?: string;
}

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

/** Boot the shipped page with the Worker answering as `answers` says. */
async function boot(answers: Answers = {}): Promise<void> {
  const health = answers.health ?? { ok: true, body: { ok: true, live: false, viewers: 0 } };
  const feed = answers.feed ?? { ok: true, body: FEED };

  if (answers.ua !== undefined) {
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: answers.ua, platform: "" },
      configurable: true,
    });
  }

  (globalThis as { fetch?: unknown }).fetch = (url: string) => {
    if (String(url).includes("/health")) {
      return Promise.resolve({
        ok: health.ok,
        json: () => Promise.resolve(health.body),
      });
    }
    return Promise.resolve({
      ok: feed.ok,
      text: () => Promise.resolve(feed.body ?? ""),
    });
  };

  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, "");

  // the page's own script, evaluated against the markup it ships with
  const script = /<script>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  if (!script) throw new Error("home.html no longer carries an inline script");
  new Function(script)();

  // let both fetch chains settle
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
});

describe("the landing page", () => {
  it("takes its version, date and size from the feed rather than the markup", async () => {
    await boot();
    expect($("ver").textContent).toBe("v0.5.11");
    expect($("relDate").textContent).toBe("2026-09-07");
    // 88238646 bytes is 84 MB, and the markup must never state a size of its own
    expect($("size").textContent).toBe("84 MB");
    expect($("winSpec").textContent).toContain("84 MB");
  });

  it("offers no download at all when nothing is published", async () => {
    await boot({ feed: { ok: false } });
    expect($("dl").getAttribute("aria-disabled")).toBe("true");
    expect($("dlText").textContent).toBe("No build published yet");
    expect($("ver").textContent).toBe("");
    expect($("relDate").textContent).toBe("");
    expect($("size").textContent).toBe("");
  });

  it("reports the service reachable, not that somebody is streaming", async () => {
    // a tokenless /health always answers live:false, so the badge must read `ok`
    await boot({ health: { ok: true, body: { ok: true, live: false, viewers: 0 } } });
    expect($("stateText").textContent).toBe("ONLINE");
    expect($("state").className).toContain("up");
  });

  it("says so when the relay is unreachable", async () => {
    await boot({ health: { ok: false } });
    expect($("stateText").textContent).toBe("OFFLINE");
    expect($("state").className).not.toContain("up");
  });

  it("tells a visitor who is not on Windows before they click", async () => {
    await boot({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
    expect($("detected").textContent).toContain("WINDOWS BUILD ONLY");
    expect($("winTag").hidden).toBe(true);
  });

  it("flags the row as yours on Windows", async () => {
    await boot({ ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    expect($("detected").textContent).toBe("DETECTED WINDOWS");
    expect($("winTag").hidden).toBe(false);
  });

  /**
   * The honesty guard. The redesign arrived advertising macOS and Linux builds
   * that electron-builder has no target for, a /dl/ path the Worker 404s, a
   * subdomain with no DNS record, and a repository that does not exist. Each
   * was a link a visitor would have clicked.
   *
   * So: every link either points inside this page, at a route the Worker
   * actually serves, or at a host on this list. Adding a link means adding it
   * here, deliberately.
   */
  it("links only to routes the Worker serves and hosts we have checked", () => {
    // the root assets the crawler/preview tags point at; each has a route in
    // apps/hosted-relay/src/routes.ts ROOT_ASSETS and a file in ./public
    const SERVED = new Set(["/download", "/og.png", "/favicon.svg", "/favicon.ico", "/apple-touch-icon.png"]);
    // the canonical link names this site's own apex, absolutely, by design
    const EXTERNAL = new Set(["console.deepgram.com", "textrelay.cc"]);

    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);

    const bad = hrefs.filter((h) => {
      if (h.startsWith("#")) return false;
      if (h === "/fonts/fonts.css") return false;
      if (SERVED.has(h)) return false;
      if (h.startsWith("https://")) return !EXTERNAL.has(new URL(h).hostname);
      return true;
    });
    expect(bad).toEqual([]);
  });

  it("claims no licence the repository does not carry", () => {
    // The redesign said MIT in three places when there was no LICENSE file and
    // no license field anywhere - a licensing statement nothing backed. There
    // is a LICENSE now, so the page is allowed to say it; what still must not
    // happen is the page claiming it while the file says otherwise or is gone.
    const claimed = /\bMIT\b/.test(html);
    const licensePath = path.resolve(__dirname, "..", "..", "..", "LICENSE");
    const carried =
      fs.existsSync(licensePath) && /^MIT License/.test(fs.readFileSync(licensePath, "utf8"));

    expect(claimed && !carried).toBe(false);
  });
});

describe("what a link preview and a crawler read off this page", () => {
  /**
   * The page had no Open Graph tags at all, which is why a textrelay.cc link
   * pasted into Discord rendered as bare blue text. This product's growth loop
   * IS the pasted link - every stream shows the viewer URL to its own chat - so
   * an unstyled preview is not cosmetic, it is the funnel.
   *
   * Parsed out of the shipped file rather than asserted as substrings: a tag
   * that is present but inside a comment is not present.
   */
  const head = new DOMParser().parseFromString(headOnly(html), "text/html").head;
  const meta = (prop: string): string | null =>
    head.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`)?.getAttribute("content") ?? null;

  it("names itself, describes itself and points at its own image", () => {
    expect(meta("og:title")).toBeTruthy();
    expect(meta("og:description")).toBeTruthy();
    expect(meta("og:type")).toBe("website");
    expect(meta("og:url")).toBe("https://textrelay.cc/");
    // absolute, because a relative og:image is ignored by every scraper
    expect(meta("og:image")).toBe("https://textrelay.cc/og.png");
    expect(meta("og:image:alt")).toBeTruthy();
    expect(meta("twitter:card")).toBe("summary_large_image");
  });

  it("says which of the three hostnames is the real one", () => {
    // relay.supr.systems and the workers.dev fallback serve these same bytes
    const canonical = head.querySelector('link[rel="canonical"]');
    expect(canonical?.getAttribute("href")).toBe("https://textrelay.cc/");
  });

  it("has an icon for a browser tab and for a phone home screen", () => {
    expect(head.querySelector('link[rel="icon"]')).not.toBeNull();
    expect(head.querySelector('link[rel="apple-touch-icon"]')).not.toBeNull();
  });

  it("describes itself to a search engine as the free Windows app it is", () => {
    const script = head.querySelector('script[type="application/ld+json"]');
    expect(script, "no JSON-LD in the head").not.toBeNull();
    const data = JSON.parse(script!.textContent || "{}");
    expect(data["@type"]).toBe("SoftwareApplication");
    expect(data.operatingSystem).toBe("Windows");
    expect(data.offers?.price).toBe("0");
    // no reviews exist. Stars that were never earned are a guideline violation
    // and get the whole snippet dropped, not just the rating.
    expect(data.aggregateRating).toBeUndefined();
  });
});

describe("what the viewer page tells a crawler", () => {
  it("refuses to be indexed", () => {
    // /watch/<token> pages are unauthenticated, one per stream, and pasted into
    // public chats. The Worker sends X-Robots-Tag as well; this is the copy
    // that survives being opened from a file or served by the embedded relay.
    const viewer = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
    const doc = new DOMParser().parseFromString(headOnly(viewer), "text/html");
    expect(doc.head.querySelector('meta[name="robots"]')?.getAttribute("content")).toContain("noindex");
  });
});
