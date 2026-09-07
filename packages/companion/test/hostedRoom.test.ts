import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { HOSTED_RELAY_URL, claimUrlFor } from "@callout-relay/shared";
import { claimHostedRoom } from "../src/hostedRoom";

/**
 * Getting a room on the hosted relay used to be a curl command the user had to
 * find in a README and type by hand, then paste two tokens into a panel called
 * ADVANCED whose own hint text says none of it is needed. Nothing in the app
 * called `/claim` at all. So the one thing the hosted relay exists for -
 * sending someone a link they can open on a phone, anywhere - was reachable
 * only by people who read the source.
 *
 * This is the piece that removes the curl. It runs against a real HTTP server
 * speaking the shape the deployed Worker speaks (verified against the live
 * service: POST /claim returns `p1_<rid>_<secret>` and `v1_<rid>_<secret>`).
 *
 * It takes a `fetch` rather than reaching for the global so the failures can be
 * driven: a relay that is down, that answers HTML, that rate-limits, that hands
 * back something that is not a room. Every one of those has to reach the user
 * as a sentence, because the alternative is a button that does nothing.
 */

let server: http.Server | null = null;

async function serve(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const { port } = server!.address() as { port: number };
  // the app stores a ws:// url; the claim goes over http to the same origin
  return `ws://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

const room = {
  publisherToken: "p1_0a23a346f3fa40eb_257173246fcdfdf6a9b6801cf096395f",
  viewerToken: "v1_0a23a346f3fa40eb_3cf7847338d651767d63aafc54265d0b",
};

describe("claiming a room so the user does not have to", () => {
  it("posts to /claim and hands back the settings patch that turns the uplink on", async () => {
    const seen: { method?: string; url?: string }[] = [];
    const relayUrl = await serve((req, res) => {
      seen.push({ method: req.method, url: req.url });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(room));
    });

    const patch = await claimHostedRoom(relayUrl);

    expect(seen, "a room is claimed with POST /claim, the way the Worker expects").toEqual([
      { method: "POST", url: "/claim" },
    ]);
    // exactly the two fields startUplink() checks, and nothing else - the
    // viewer token is deliberately absent, because the app already fetches
    // that itself from /admin/viewer-token using the publish token
    expect(patch).toEqual({ relayUrl, publisherToken: room.publisherToken });
  });

  it("says what went wrong when the relay is not there, rather than failing silently", async () => {
    // nothing listening on this port
    await expect(claimHostedRoom("ws://127.0.0.1:9")).rejects.toThrow(/could not reach/i);
  });

  it("says so when the relay refuses because too many rooms were claimed", async () => {
    const relayUrl = await serve((_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "slow down" }));
    });

    await expect(claimHostedRoom(relayUrl)).rejects.toThrow(/too many|slow down|try again/i);
  });

  it("does not mistake an error page for a room", async () => {
    // a proxy, a captive portal or a stale route answers 200 with HTML, and
    // storing that as a publish token would leave the uplink retrying against
    // nonsense for the rest of the session
    const relayUrl = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><title>hello</title>");
    });

    await expect(claimHostedRoom(relayUrl)).rejects.toThrow(/did not answer with a room/i);
  });

  it("rejects a room with a blank token instead of storing it", async () => {
    const relayUrl = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ publisherToken: "", viewerToken: room.viewerToken }));
    });

    await expect(claimHostedRoom(relayUrl)).rejects.toThrow(/did not answer with a room/i);
  });

  it("refuses a relay address it cannot turn into an http origin", async () => {
    // the same rule httpOriginOfRelayUrl applies in main.ts: a bare host or an
    // https:// address is not a relay url, and half-accepting one is how the
    // footer ends up quietly showing the LAN link
    await expect(claimHostedRoom("https://relay.supr.systems")).rejects.toThrow(/ws:\/\/ or wss:\/\//i);
    await expect(claimHostedRoom("relay.supr.systems")).rejects.toThrow(/ws:\/\/ or wss:\/\//i);
  });
});

describe("where a claim is sent", () => {
  it("uses the same origin as the relay, over http", () => {
    expect(claimUrlFor("wss://relay.supr.systems")).toBe("https://relay.supr.systems/claim");
    expect(claimUrlFor("ws://127.0.0.1:8787")).toBe("http://127.0.0.1:8787/claim");
    expect(claimUrlFor("wss://relay.supr.systems/")).toBe("https://relay.supr.systems/claim");
  });

  it("has nothing to say about an address that is not a relay", () => {
    expect(claimUrlFor("https://relay.supr.systems")).toBeUndefined();
    expect(claimUrlFor("wss://relay.supr.systems/watch/abc")).toBeUndefined();
    expect(claimUrlFor("")).toBeUndefined();
  });

  it("ships a default so the user is not asked to know the address", () => {
    expect(HOSTED_RELAY_URL).toBe("wss://relay.supr.systems");
    expect(claimUrlFor(HOSTED_RELAY_URL)).toBe("https://relay.supr.systems/claim");
  });
});
