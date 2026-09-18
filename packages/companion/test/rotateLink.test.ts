import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { rotateUrlFor, viewerTokenUrlFor } from "@callout-relay/shared";
import { rotateRemoteLink } from "../src/rotateLink";

/**
 * Replacing the internet link, and knowing what became of it.
 *
 * NEW used to fire this request and move on. A 500 from the room's storage or
 * a 403 for a publish key the relay no longer knows was not even logged, and
 * the app said "old links are dead" while the old phone link went on working.
 *
 * Saying "the old one still works" instead would be just as wrong half the
 * time: both relays replace the link before they answer, so a request that
 * timed out or lost its answer may have killed the old link anyway. So a
 * failure is followed by asking the relay which link it admits now, and each
 * outcome here is only what the relay confirmed.
 *
 * Against a real HTTP server, speaking what both relays speak: POST
 * /admin/rotate-viewer-token and GET /admin/viewer-token with the publish key
 * as a bearer token, each answered with `{ viewerToken }`.
 */

let server: http.Server | null = null;

async function serve(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const { port } = server!.address() as { port: number };
  return `ws://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
  }
  server = null;
});

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/** a relay whose rotate answers `rotate`, and whose token read answers with `now` (or fails) */
function relayWhere(rotate: http.RequestListener, now: string | null): http.RequestListener {
  return (req, res) => {
    if (req.url === "/admin/rotate-viewer-token") return rotate(req, res);
    if (req.url === "/admin/viewer-token" && now !== null) return json(res, 200, { viewerToken: now });
    json(res, 500, { error: "down" });
  };
}

describe("replacing the internet link", () => {
  it("posts with the publish key and hands back the new token", async () => {
    const seen: { method?: string; url?: string; auth?: string }[] = [];
    const relayUrl = await serve((req, res) => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      json(res, 200, { viewerToken: "v1_new" });
    });

    expect(await rotateRemoteLink(relayUrl, "p1_key", "v1_old")).toEqual({ remote: "rotated", viewerToken: "v1_new" });
    expect(seen).toEqual([{ method: "POST", url: "/admin/rotate-viewer-token", auth: "Bearer p1_key" }]);
  });

  it("takes the address with the trailing slash the rest of the app accepts", async () => {
    const relayUrl = await serve((_req, res) => json(res, 200, { viewerToken: "v1_new" }));
    expect((await rotateRemoteLink(`${relayUrl}/`, "p1_key", "v1_old")).remote).toBe("rotated");
    expect(rotateUrlFor("wss://textrelay.cc/")).toBe("https://textrelay.cc/admin/rotate-viewer-token");
    expect(viewerTokenUrlFor("wss://textrelay.cc/")).toBe("https://textrelay.cc/admin/viewer-token");
    expect(rotateUrlFor("wss://textrelay.cc//")).toBeUndefined();
  });
});

describe("when the relay did not do it", () => {
  it("says the old link is unchanged once the relay confirms it still admits it", async () => {
    const relayUrl = await serve(relayWhere((_req, res) => json(res, 500, { error: "storage" }), "v1_old"));
    const out = await rotateRemoteLink(relayUrl, "p1_key", "v1_old");
    expect(out.remote).toBe("unchanged");
    expect(out.remote !== "rotated" && out.reason).toMatch(/could not replace the link \(500\)/);
  });

  // a captive portal answers 200 with a page; storing that as a viewer token
  // would hand every phone a link to nothing
  it("does not take a 200 that is not a token for one", async () => {
    const page: http.RequestListener = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>sign in to the wifi</html>");
    };
    const relayUrl = await serve(relayWhere(page, "v1_old"));
    const out = await rotateRemoteLink(relayUrl, "p1_key", "v1_old");
    expect(out.remote).toBe("unchanged");
    expect(out.remote !== "rotated" && out.reason).toMatch(/did not answer with a new link/);
  });
});

describe("when the relay did it but the answer was lost", () => {
  // Both relays replace the link before they answer. Saying "the old one still
  // works" here would be the opposite lie: the old link is dead, and the app
  // would go on handing it out.
  it("learns the new link from the relay instead of claiming the old one works", async () => {
    const relayUrl = await serve(relayWhere((_req, res) => json(res, 500, { error: "answer lost" }), "v1_new"));
    expect(await rotateRemoteLink(relayUrl, "p1_key", "v1_old")).toEqual({ remote: "rotated", viewerToken: "v1_new" });
  });

  it("does the same when the answer is cut off by the timeout", async () => {
    const stall: http.RequestListener = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("{");
    };
    const relayUrl = await serve(relayWhere(stall, "v1_new"));
    const began = Date.now();
    expect(await rotateRemoteLink(relayUrl, "p1_key", "v1_old", { timeoutMs: 150 })).toEqual({
      remote: "rotated",
      viewerToken: "v1_new",
    });
    // the timeout has to reach the body: clearing it when the headers arrived
    // left this waiting for as long as the socket lived
    expect(Date.now() - began, "the answer's body read had no deadline").toBeLessThan(3000);
  });
});

describe("when it cannot be known", () => {
  it("says so, rather than guessing either way", async () => {
    const relayUrl = await serve(relayWhere((_req, res) => json(res, 502, { error: "gateway" }), null));
    const out = await rotateRemoteLink(relayUrl, "p1_key", "v1_old");
    expect(out.remote).toBe("unknown");
    expect(out.remote !== "rotated" && out.reason).toMatch(/could not replace the link \(502\)/);
  });

  it("covers a relay that is not there", async () => {
    const relayUrl = await serve((_req, res) => json(res, 200, {}));
    server!.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    const out = await rotateRemoteLink(relayUrl, "p1_key", "v1_old");
    expect(out.remote).toBe("unknown");
    expect(out.remote !== "rotated" && out.reason).toMatch(/could not reach 127\.0\.0\.1/);
  });

  it("covers a relay that never answers, within the timeout it was given", async () => {
    const relayUrl = await serve(() => undefined);
    const began = Date.now();
    const out = await rotateRemoteLink(relayUrl, "p1_key", "v1_old", { timeoutMs: 100 });
    expect(out.remote).toBe("unknown");
    expect(out.remote !== "rotated" && out.reason).toMatch(/did not answer in time/);
    expect(Date.now() - began, "the timeout it was given was ignored").toBeLessThan(3000);
  });
});

describe("when the relay turned the app away", () => {
  // nothing was done, and nothing a second press changes: no point asking
  it("says the publish key was refused, and asks nothing more", async () => {
    const seen: string[] = [];
    const relayUrl = await serve((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      json(res, 403, { error: "forbidden" });
    });
    const out = await rotateRemoteLink(relayUrl, "p1_key", "v1_old");
    expect(out.remote).toBe("refused");
    expect(out.remote !== "rotated" && out.reason).toMatch(/publish key.*WHO CAN OPEN IT/);
    expect(seen).toEqual(["POST /admin/rotate-viewer-token"]);
  });

  it("says a room the relay no longer has is gone", async () => {
    const relayUrl = await serve((_req, res) => json(res, 404, { error: "no such room" }));
    const out = await rotateRemoteLink(relayUrl, "p1_key", "v1_old");
    expect(out.remote).toBe("refused");
    expect(out.remote !== "rotated" && out.reason).toMatch(/no room for this app.*WHO CAN OPEN IT/);
  });

  it("refuses something that is not a relay address", async () => {
    const out = await rotateRemoteLink("https://textrelay.cc", "p1_key", "v1_old");
    expect(out.remote).toBe("refused");
    expect(out.remote !== "rotated" && out.reason).toMatch(/not a relay address/);
  });
});
