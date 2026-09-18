import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, rotationNotice } from "@callout-relay/shared";
import type { AppConfig, LinkRotation } from "@callout-relay/shared";
import { ConfigStore } from "@callout-relay/companion";
import { startRelay } from "../../../packages/relay/src/server";
import type { RelayHandle } from "../../../packages/relay/src/server";
import { rotateLinks, trayOpensLink } from "../src/linkRotation";

/**
 * NEW, START in the default link mode and the tray's Rotate viewer link, as
 * main runs them - against a real relay standing in for the internet one, and
 * a real ConfigStore.
 *
 * What this returns decides whether the streamer is told the old link is dead.
 * It used to be decided nowhere: main fired the request, swallowed a failure,
 * and the window said "old links are dead" either way.
 */

const relays: RelayHandle[] = [];
const dirs: string[] = [];
let server: http.Server | null = null;

afterEach(async () => {
  for (const r of relays.splice(0)) await r.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "link-rotation-"));
  dirs.push(d);
  return d;
}

async function remoteRelay(): Promise<RelayHandle> {
  const r = await startRelay({ port: 0, dataDir: tmp(), publisherToken: "pub", mockStt: true, mockGemini: true, log: () => undefined });
  relays.push(r);
  return r;
}

function harness(cfg: Partial<AppConfig>, save?: (t: string) => void) {
  const calls = { local: 0, saved: [] as string[], logs: [] as string[] };
  const run = (): Promise<LinkRotation> =>
    rotateLinks({
      rotateLocal: () => void calls.local++,
      config: () => ({ ...DEFAULT_CONFIG, ...cfg }) as AppConfig,
      saveViewerToken: save ?? ((t) => void calls.saved.push(t)),
      log: (_level, message) => void calls.logs.push(message),
      timeoutMs: 2000,
    });
  return { calls, run };
}

describe("rotating against a real relay", () => {
  it("stores the token the relay now admits, and says so", async () => {
    const remote = await remoteRelay();
    const before = remote.state.viewerToken;
    const { calls, run } = harness({ relayUrl: `ws://127.0.0.1:${remote.port}`, publisherToken: "pub", viewerToken: before });

    expect(await run()).toEqual({ remote: "rotated" });
    expect(calls.local, "the LAN link was not rotated").toBe(1);
    expect(remote.state.viewerToken).not.toBe(before);
    expect(calls.saved, "the app would hand out a token the relay does not admit").toEqual([remote.state.viewerToken]);
  });

  it("reports a publish key the relay does not know, and stores nothing", async () => {
    const remote = await remoteRelay();
    const before = remote.state.viewerToken;
    const { calls, run } = harness({ relayUrl: `ws://127.0.0.1:${remote.port}`, publisherToken: "not-the-key", viewerToken: before });

    const out = await run();
    expect(out.remote).toBe("refused");
    expect(calls.saved).toEqual([]);
    expect(remote.state.viewerToken).toBe(before);
    expect(calls.logs.join("\n"), "a refused rotation left no trace in the log").toMatch(/refused/);
  });

  it("rotates only the LAN link when there is no internet link", async () => {
    const { calls, run } = harness({ relayUrl: "", publisherToken: "" });
    expect(await run()).toEqual({ remote: "none" });
    expect(calls.local).toBe(1);
  });

  it("says unchanged, and stores nothing, when a relay that failed still admits the old link", async () => {
    server = http.createServer((req, res) => {
      res.writeHead(req.url === "/admin/viewer-token" ? 200 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify(req.url === "/admin/viewer-token" ? { viewerToken: "v1_old" } : { error: "storage" }));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as { port: number };
    const { calls, run } = harness({ relayUrl: `ws://127.0.0.1:${port}`, publisherToken: "p1_key", viewerToken: "v1_old" });

    expect((await run()).remote).toBe("unchanged");
    expect(calls.saved).toEqual([]);
  });
});

describe("a rotation the relay made, and a save that failed", () => {
  // The relay has replaced the link, so the old one is dead. A save that throws
  // afterwards - a scanner holding config.json - used to be caught with the
  // request's failures and reported as "the old one still works".
  it("is still a rotation, and the new link is what the app now shows", async () => {
    const remote = await remoteRelay();
    const dir = tmp();
    const store = new ConfigStore(dir);
    store.update({ relayUrl: `ws://127.0.0.1:${remote.port}`, publisherToken: "pub", viewerToken: remote.state.viewerToken });
    // a directory where the save's temp file goes: the write throws, as a
    // locked or read-only config does
    fs.mkdirSync(path.join(dir, "config.json.tmp"));
    const logs: string[] = [];

    const out = await rotateLinks({
      rotateLocal: () => undefined,
      config: () => store.get(),
      saveViewerToken: (viewerToken) => store.update({ viewerToken }),
      log: (_l, m) => void logs.push(m),
      timeoutMs: 2000,
    });

    expect(out, "a save that failed was reported as a rotation that failed").toEqual({ remote: "rotated" });
    expect(store.get().viewerToken, "the footer would go on showing the dead link").toBe(remote.state.viewerToken);
    expect(logs.join("\n")).toMatch(/could not be saved/);
  });
});

describe("what the tray opens afterwards", () => {
  const every: LinkRotation[] = [
    { remote: "none" },
    { remote: "rotated" },
    { remote: "unchanged", reason: "r" },
    { remote: "refused", reason: "r" },
    { remote: "unknown", reason: "r" },
  ];

  it("opens the phone link only when it is confirmed new", () => {
    expect(every.map((r) => trayOpensLink(r, "phone"))).toEqual([true, true, false, false, false]);
  });

  // with OUTPUT on OBS the tray opens the local link, which rotated in-process
  // whatever the relay said - skipping it would hide the one link that is new
  it("always opens the OBS link, which rotated in-process", () => {
    expect(every.map((r) => trayOpensLink(r, "obs"))).toEqual([true, true, true, true, true]);
  });
});

describe("what the streamer is told", () => {
  const again = "press NEW again";

  it("says the old links are dead only when they are", () => {
    for (const r of [{ remote: "none" }, { remote: "rotated" }] as LinkRotation[]) {
      expect(rotationNotice(r, again)).toMatchObject({ ok: true, text: "links rotated - old links are dead" });
    }
    for (const r of [
      { remote: "unchanged", reason: "x" },
      { remote: "unknown", reason: "x" },
      { remote: "refused", reason: "x" },
    ] as LinkRotation[]) {
      const n = rotationNotice(r, again);
      expect(n.ok).toBe(false);
      expect(n.text).not.toMatch(/dead/);
    }
  });

  it("says the old link still works only when the relay confirmed it", () => {
    expect(rotationNotice({ remote: "unchanged", reason: "x" }, again).text).toMatch(/still works: press NEW again$/);
    expect(rotationNotice({ remote: "unknown", reason: "x" }, again).text).not.toMatch(/still works/);
    expect(rotationNotice({ remote: "refused", reason: "x" }, again).text).not.toMatch(/still works/);
  });

  // pressing again only asks the same question of a relay that refuses the key
  it("does not send a refused streamer round the same loop", () => {
    const n = rotationNotice({ remote: "refused", reason: "textrelay.cc did not accept this app's publish key" }, again);
    expect(n.text).not.toContain(again);
    expect(n.chip).toBeUndefined();
  });

  it("keeps a warning on screen for an old link that may still be out there", () => {
    expect(rotationNotice({ remote: "unchanged", reason: "x" }, again).chip).toBe("OLD LINK STILL WORKS");
    expect(rotationNotice({ remote: "unknown", reason: "x" }, again).text).toMatch(/\. Press NEW again before sending it/);
    expect(rotationNotice({ remote: "unknown", reason: "x" }, again).chip).toBe("LINK NOT CONFIRMED");
  });
});

describe("main's side of it", () => {
  // comments stripped, so a sentence about the old code cannot satisfy or trip
  // these - but only a `//` after whitespace, or `https://` in a string would
  // take the rest of its line with it
  const main = fs.readFileSync(path.resolve(__dirname, "..", "src", "main.ts"), "utf8").replace(/(^|\s)\/\/.*$/gm, "$1");

  // the outcome lives in linkRotation.ts, so main has to rotate through it: a
  // hand-built request is how a 500 went unlogged and "dead" went out anyway
  it("rotates through rotateLinks, not a request built by hand", () => {
    expect(main).toContain("rotateLinks({");
    expect(main, "main.ts spells out the rotate request by hand again").not.toMatch(/admin\/rotate-viewer-token/);
  });

  it("lets the tray open only what trayOpensLink allows, and tells it what happened", () => {
    expect(main).toMatch(/trayOpensLink\(rotation, config\(\)\.output\) && viewerUrl\(\)\) openExternal/);
    expect(main).toMatch(/rotationNotice\(rotation, "use Rotate viewer link again"\)/);
  });
});
