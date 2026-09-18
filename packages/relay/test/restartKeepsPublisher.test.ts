import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startRelay } from "../src/server";
import type { RelayHandle } from "../src/server";
import { RelayPublisherClient } from "../../companion/src/relayClient";

/**
 * A relay that restarts is not a publisher being replaced.
 *
 * The desktop app restarts its embedded relay whenever a relay setting changes
 * - and GET AN ADDRESS is one: claiming a hosted room writes `relayUrl` and
 * `publisherToken`, both relay keys, so main restarts the relay underneath a
 * session that may be live. That is the natural moment to press it, too: the
 * THIS NETWORK ONLY chip is on screen, and the README sends a user whose phone
 * link does not work outside the network straight to that button.
 *
 * `close()` dropped the publisher with 4409, which is the code for "a newer
 * publisher took over". The publisher client reads 4409 as final and never
 * reconnects - correctly, for what 4409 means - so the session sat under ON
 * AIR with the mic captured and every chunk dropped, and no viewer got another
 * caption until somebody pressed STOP and START by hand. The same `close()`
 * already said 1001 to the uplink and to every viewer.
 *
 * Driven with the real client against a real relay, restarted on the same
 * port and data dir the way `restartEmbeddedRelay` does it, because the defect
 * is in the meaning the two ends give one number.
 */

let relay: RelayHandle | undefined;
let client: RelayPublisherClient | undefined;
const dirs: string[] = [];

afterEach(async () => {
  client?.disconnect();
  client = undefined;
  await relay?.close();
  relay = undefined;
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* disposable */
    }
  }
});

const start = (port: number, dataDir: string): Promise<RelayHandle> =>
  startRelay({ port, dataDir, mockStt: true, mockGemini: true, log: () => undefined });

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

describe("a publisher connected when its relay restarts", () => {
  it("reconnects to the relay that comes back, instead of treating the restart as a takeover", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-restart-"));
    dirs.push(dataDir);
    relay = await start(0, dataDir);
    const port = relay.port;

    const trail: string[] = [];
    client = new RelayPublisherClient(
      `ws://127.0.0.1:${port}/ws/publisher?token=${relay.state.publisherToken}`,
      { onState: (state, detail) => trail.push(detail ? `${state}: ${detail}` : state) },
    );
    client.connect({
      stt: "deepgram-nova-3",
      translation: "gemini-3.1-flash-lite",
      languages: { source: "en", target: "vi" },
      translationEnabled: false,
      latencyVisible: true,
      profanityFilter: true,
    });
    expect(await until(() => client?.state === "connected", 3000), "the publisher never connected at all").toBe(true);

    // what main does when a relay setting changes: close, then start again on
    // the same port with the same data dir, so the tokens carry over
    const before = trail.length;
    await relay.close();
    relay = await start(port, dataDir);

    const back = await until(() => client?.state === "connected", 5000);
    const after = trail.slice(before);
    expect(
      after.filter((s) => s.startsWith("error")),
      "the relay restarting was read as another session taking over, so the publisher gave up for good",
    ).toEqual([]);
    expect(back, `the publisher never reconnected to the restarted relay: ${after.join(" | ")}`).toBe(true);
  });
});
