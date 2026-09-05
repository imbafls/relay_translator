import { afterEach, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import { DEFAULT_CONFIG } from "@callout-relay/shared";
import type { ControlStatus } from "@callout-relay/shared";
import { ControlClient } from "../src/controlClient";
import { startControlServer } from "../src/controlServer";
import type { ControlHandle } from "../src/controlServer";

/**
 * The real ControlClient against the real ControlServer, and - where the point
 * is how the client parses bytes rather than what the server means - against a
 * raw HTTP server whose exact chunking the test controls. The SSE framing here
 * is hand-rolled, so the interesting cases are the ones a well-behaved server
 * happens not to produce.
 */

let handle: ControlHandle | null = null;
let raw: http.Server | null = null;
const unsubs: (() => void)[] = [];

function status(state: ControlStatus["session"]["state"] = "idle"): ControlStatus {
  return {
    companion: { version: "0.0.0-test" },
    session: { state },
    relay: { mode: "embedded", url: "http://127.0.0.1:8787", viewerUrl: "http://127.0.0.1:8787/watch/tok" },
    devices: [],
    config: { ...DEFAULT_CONFIG },
  };
}

async function serve(): Promise<ControlClient> {
  let state: ControlStatus["session"]["state"] = "idle";
  handle = await startControlServer(
    {
      getStatus: () => status(state),
      start: async () => {
        state = "live";
      },
      stop: async () => {
        state = "idle";
      },
      patchConfig: async () => status(state),
      rotateLink: async () => {},
    },
    { port: 0 },
  );
  return new ControlClient(`http://127.0.0.1:${handle.port}`, "test");
}

/** a server that writes exactly the bytes given, in the chunks given */
async function serveRaw(chunks: string[], gapMs = 10): Promise<ControlClient> {
  raw = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    let i = 0;
    const next = (): void => {
      if (i >= chunks.length) return;
      res.write(chunks[i]);
      i += 1;
      setTimeout(next, gapMs);
    };
    next();
  });
  await new Promise<void>((r) => raw!.listen(0, "127.0.0.1", r));
  const port = (raw.address() as { port: number }).port;
  return new ControlClient(`http://127.0.0.1:${port}`, "test");
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, ms = 6000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`${what} never happened within ${ms}ms`);
    await settle(20);
  }
}

afterEach(async () => {
  for (const off of unsubs.splice(0)) off();
  await handle?.close();
  handle = null;
  if (raw) await new Promise<void>((r) => raw!.close(() => r()));
  raw = null;
});

function subscribe(client: ControlClient): ControlStatus[] {
  const got: ControlStatus[] = [];
  unsubs.push(client.onStatus((s) => got.push(s)));
  return got;
}

describe("talking to the control server", () => {
  it("reads status and drives start and stop", async () => {
    const client = await serve();
    expect((await client.status()).session.state).toBe("idle");
    expect((await client.start()).session.state).toBe("live");
    expect((await client.stop()).session.state).toBe("idle");
  });

  it("reads the viewer link", async () => {
    const client = await serve();
    expect((await client.link()).viewerUrl).toContain("/watch/");
  });

  it("turns a refusal into an error rather than a silent undefined", async () => {
    const client = await serve();
    // the server requires the client header on mutations; a bare fetch has none
    const bare = new ControlClient(`http://127.0.0.1:${handle!.port}`, "");
    await expect(bare.start()).rejects.toThrow(/start 403/);
    expect((await client.status()).session.state).toBe("idle");
  });
});

describe("the status subscription", () => {
  it("delivers the opening status and then each broadcast", async () => {
    const client = await serve();
    const got = subscribe(client);
    await until(() => got.length >= 1, "the opening status");

    handle!.broadcast(status("live"));
    await until(() => got.some((s) => s.session.state === "live"), "the broadcast");
  });

  it("delivers two broadcasts sent back to back", async () => {
    // both frames can land in one chunk, so this exercises the frame splitter
    const client = await serve();
    const got = subscribe(client);
    await until(() => got.length >= 1, "the opening status");
    const before = got.length;

    handle!.broadcast(status("starting"));
    handle!.broadcast(status("live"));

    await until(() => got.length >= before + 2, "both broadcasts");
    expect(got.slice(before).map((s) => s.session.state)).toEqual(["starting", "live"]);
  });

  it("stops delivering once unsubscribed", async () => {
    const client = await serve();
    const got: ControlStatus[] = [];
    const off = client.onStatus((s) => got.push(s));
    await until(() => got.length >= 1, "the opening status");

    off();
    await settle(100);
    const after = got.length;
    handle!.broadcast(status("live"));
    await settle(300);

    expect(got).toHaveLength(after);
  });

  it("comes back when the server restarts under it", async () => {
    const client = await serve();
    const port = handle!.port;
    const got = subscribe(client);
    await until(() => got.length >= 1, "the opening status");

    await handle!.close();
    handle = null;
    // same port, so the client's retry finds it again
    handle = await startControlServer(
      {
        getStatus: () => status("live"),
        start: async () => {},
        stop: async () => {},
        patchConfig: async () => status("live"),
        rotateLink: async () => {},
      },
      { port },
    );

    await until(() => got.some((s) => s.session.state === "live"), "a status after the restart", 12000);
  });
});

describe("SSE framing the server does not happen to produce", () => {
  it("ignores the keepalive comment between events", async () => {
    const client = await serveRaw([
      ":ka\n\n",
      `data: ${JSON.stringify({ type: "status", status: status("live") })}\n\n`,
    ]);
    const got = subscribe(client);
    await until(() => got.length >= 1, "the status after a keepalive");
    expect(got[0].session.state).toBe("live");
  });

  it("reassembles an event split across chunks", async () => {
    const payload = JSON.stringify({ type: "status", status: status("starting") });
    const whole = `data: ${payload}\n\n`;
    const cut = Math.floor(whole.length / 2);
    const client = await serveRaw([whole.slice(0, cut), whole.slice(cut)]);
    const got = subscribe(client);
    await until(() => got.length >= 1, "the reassembled status");
    expect(got[0].session.state).toBe("starting");
  });

  it("keeps going after a frame that is not valid json", async () => {
    const client = await serveRaw([
      "data: {not json at all\n\n",
      `data: ${JSON.stringify({ type: "status", status: status("live") })}\n\n`,
    ]);
    const got = subscribe(client);
    await until(() => got.length >= 1, "the status after a bad frame");
    expect(got[0].session.state).toBe("live");
  });

  it("reports a subscriber that throws instead of filing it as a bad frame", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m) => errors.push(String(m)));
    try {
      const client = await serveRaw([
        `data: ${JSON.stringify({ type: "status", status: status("live") })}\n\n`,
        `data: ${JSON.stringify({ type: "status", status: status("starting") })}\n\n`,
      ]);
      const seen: ControlStatus[] = [];
      unsubs.push(
        client.onStatus((s) => {
          seen.push(s);
          if (seen.length === 1) throw new Error("boom in the subscriber");
        }),
      );

      // the throw must not stop the stream: the second event still arrives
      await until(() => seen.length >= 2, "the event after the throw");
      expect(errors.some((e) => e.includes("boom in the subscriber"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("ignores an event that is not a status", async () => {
    const client = await serveRaw([
      `data: ${JSON.stringify({ type: "something-else", status: status("live") })}\n\n`,
      `data: ${JSON.stringify({ type: "status", status: status("starting") })}\n\n`,
    ]);
    const got = subscribe(client);
    await until(() => got.length >= 1, "the status event");
    expect(got).toHaveLength(1);
    expect(got[0].session.state).toBe("starting");
  });
});
