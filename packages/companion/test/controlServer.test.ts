import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_CLIENT_HEADER, DEFAULT_CONFIG } from "@callout-relay/shared";
import type { AppConfig, ControlStatus } from "@callout-relay/shared";
import { startControlServer } from "../src/controlServer";
import type { ControlHandle } from "../src/controlServer";

/**
 * The real control server runs here on a real port, answering real requests.
 * It is the app's local remote control: the Stream Deck plugin and the
 * property inspector drive it, and it has no auth by design - the gate is the
 * loopback bind plus an origin check.
 */

const DEEPGRAM = "dg-live-key-should-never-leave";
const GEMINI = "gm-live-key-should-never-leave";

function config(): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    deepgramApiKey: DEEPGRAM,
    geminiApiKey: GEMINI,
    publisherToken: "pub-secret",
    viewerToken: "view-secret",
  };
}

function status(): ControlStatus {
  return {
    companion: { version: "0.0.0-test" },
    session: { state: "idle" },
    relay: { mode: "embedded", url: "http://127.0.0.1:8787", viewerUrl: "http://127.0.0.1:8787/watch/view-secret" },
    devices: [],
    config: config(),
  };
}

let handle: ControlHandle | null = null;
const patched: Record<string, unknown>[] = [];

async function serve(): Promise<string> {
  handle = await startControlServer(
    {
      getStatus: status,
      start: async () => {},
      stop: async () => {},
      patchConfig: async (patch) => {
        patched.push(patch);
        return status();
      },
      rotateLink: async () => {},
    },
    { port: 0 },
  );
  return `http://127.0.0.1:${handle.port}`;
}

afterEach(async () => {
  await handle?.close();
  handle = null;
  patched.length = 0;
});

const post = (base: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { [CONTROL_CLIENT_HEADER]: "test", "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** every secret the fixture holds, so a test cannot pass by checking only one */
const SECRETS = [DEEPGRAM, GEMINI, "pub-secret"];

function expectNoSecrets(text: string): void {
  for (const secret of SECRETS) expect(text, `leaked ${secret}`).not.toContain(secret);
}

describe("secrets in the control API", () => {
  it("does not hand out the API keys on GET /status", async () => {
    const base = await serve();
    const text = await (await fetch(`${base}/status`)).text();
    expectNoSecrets(text);
  });

  it("still tells a caller that a key is set", async () => {
    // the property inspector greys out its translate toggle on falsiness alone
    const base = await serve();
    const body = (await (await fetch(`${base}/status`)).json()) as ControlStatus;
    expect(body.config.geminiApiKey).toBeTruthy();
    expect(body.config.deepgramApiKey).toBeTruthy();
  });

  it("leaves a key that is genuinely unset falsy", async () => {
    handle = await startControlServer(
      {
        getStatus: () => ({ ...status(), config: { ...config(), geminiApiKey: undefined } }),
        start: async () => {},
        stop: async () => {},
        patchConfig: async () => status(),
        rotateLink: async () => {},
      },
      { port: 0 },
    );
    const body = (await (await fetch(`http://127.0.0.1:${handle.port}/status`)).json()) as ControlStatus;
    expect(body.config.geminiApiKey).toBeFalsy();
  });

  it("does not hand them out on the SSE stream either", async () => {
    const base = await serve();
    const res = await fetch(`${base}/events`);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expectNoSecrets(first);
    expect(first).toContain('"type":"status"');
    await reader.cancel();
  });

  it("does not hand them back from a config patch", async () => {
    const base = await serve();
    const text = await (await post(base, "/config", { translationEnabled: true })).text();
    expectNoSecrets(text);
    expect(patched).toEqual([{ translationEnabled: true }]);
  });

  it("does not hand them out from start or stop", async () => {
    const base = await serve();
    expectNoSecrets(await (await post(base, "/start")).text());
    expectNoSecrets(await (await post(base, "/stop")).text());
  });

  it("does not hand them out on a broadcast", async () => {
    const base = await serve();
    const res = await fetch(`${base}/events`);
    const reader = res.body!.getReader();
    await reader.read(); // the initial frame
    handle!.broadcast(status());
    const pushed = new TextDecoder().decode((await reader.read()).value);
    expectNoSecrets(pushed);
    await reader.cancel();
  });
});

describe("who is allowed to ask", () => {
  it("turns away a page on the open web", async () => {
    const base = await serve();
    const res = await fetch(`${base}/status`, { headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("still answers the property inspector, which sends a null origin", async () => {
    // this is why the origin check cannot be the thing protecting the keys:
    // a sandboxed iframe on any site sends exactly this
    const base = await serve();
    const res = await fetch(`${base}/status`, { headers: { Origin: "null" } });
    expect(res.status).toBe(200);
    expectNoSecrets(await res.text());
  });

  it("refuses a mutation with no client header", async () => {
    const base = await serve();
    const res = await fetch(`${base}/start`, { method: "POST" });
    expect(res.status).toBe(403);
  });
});
