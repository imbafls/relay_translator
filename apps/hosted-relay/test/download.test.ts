import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadInstaller } from "../src/index";

/**
 * /download used to 302 straight at the release asset, which meant a visitor who
 * clicked Download on textrelay.cc watched their address bar turn into the
 * maintainer's personal account. It now streams the bytes through the Worker.
 *
 * Only `fetch` is stood in for - it is the boundary at which this leaves the
 * Worker, and the bodies below are the ones the release actually serves.
 */

const FEED = ["version: 0.5.11", "path: CalloutRelay-Setup-0.5.11.exe", ""].join("\n");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** answer the feed request and the asset request the way the release does */
function upstream(opts: { feed?: Response; asset?: Response } = {}): string[] {
  const seen: string[] = [];
  globalThis.fetch = ((url: string) => {
    seen.push(String(url));
    if (String(url).endsWith("latest.yml")) {
      return Promise.resolve(opts.feed ?? new Response(FEED, { status: 200 }));
    }
    return Promise.resolve(
      opts.asset ??
        new Response("MZ-installer-bytes", {
          status: 200,
          headers: { "Content-Length": "88238646" },
        }),
    );
  }) as typeof fetch;
  return seen;
}

/** every header value the response would put in front of a visitor */
const headerBlob = (res: Response): string => [...res.headers].flat().join(" ");

describe("GET /download", () => {
  it("serves the installer itself rather than sending the visitor elsewhere", async () => {
    upstream();
    const res = await downloadInstaller();

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("MZ-installer-bytes");
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    // named, or the browser saves a file called "download" that Windows cannot run
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="CalloutRelay-Setup-0.5.11.exe"',
    );
    expect(res.headers.get("Content-Length")).toBe("88238646");
  });

  /**
   * The guard this change exists for. A redirect - to the asset or to the
   * releases page - hands the visitor a URL with a personal account name in it.
   */
  it("never redirects, and never names the account in a header", async () => {
    upstream();
    const res = await downloadInstaller();

    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("Location")).toBeNull();
    expect(headerBlob(res)).not.toMatch(/github|imbafls/i);
  });

  it("still fetches the bytes from the release, server-side", async () => {
    const seen = upstream();
    await downloadInstaller();
    // the Worker reaches the origin; that is the half a visitor never sees
    expect(seen.some((u) => u.endsWith("/CalloutRelay-Setup-0.5.11.exe"))).toBe(true);
  });

  it("says there is no build rather than falling back to a public page", async () => {
    upstream({ feed: new Response("nope", { status: 404 }) });
    const res = await downloadInstaller();

    expect(res.status).toBe(503);
    expect(await res.text()).toBe("no build published yet");
    expect(res.headers.get("Location")).toBeNull();
    expect(headerBlob(res)).not.toMatch(/github|imbafls/i);
  });

  it("refuses a filename that would split the response header", async () => {
    // installerName returns whatever the feed says; a header value carrying a
    // newline is a response-splitting primitive, so it is rejected outright
    upstream({ feed: new Response('path: evil"\r\nX-Injected: 1\n', { status: 200 }) });
    const res = await downloadInstaller();

    expect(res.status).toBe(503);
    expect(res.headers.get("X-Injected")).toBeNull();
  });

  it("reports upstream trouble instead of serving an error page as an installer", async () => {
    upstream({ asset: new Response("not found", { status: 404 }) });
    const res = await downloadInstaller();

    expect(res.status).toBe(502);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
  });
});
