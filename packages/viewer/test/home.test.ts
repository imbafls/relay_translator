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
    const SERVED = new Set(["/download"]);
    const EXTERNAL = new Set(["console.deepgram.com"]);

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
    // there is no LICENSE file and no license field anywhere in the workspace,
    // so "MIT" on a public page would be a licensing statement we cannot back
    expect(html).not.toMatch(/\bMIT\b/);
  });
});
