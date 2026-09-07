import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
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
const SECRETS = [DEEPGRAM, GEMINI, "pub-secret", "view-secret"];

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

describe("the viewer link", () => {
  it("does not hand out the token embedded in the URL", async () => {
    // redacting `viewerToken` and leaving the link alone gives away the same
    // power in a different shape: whoever holds the link watches the stream
    const base = await serve();
    const body = (await (await fetch(`${base}/status`)).json()) as ControlStatus;
    expect(body.relay.viewerUrl).not.toContain("view-secret");
    expect(body.relay.viewerUrl).toContain("/watch/");
  });

  it("masks it on the SSE stream too", async () => {
    const base = await serve();
    const res = await fetch(`${base}/events`);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expectNoSecrets(first);
    await reader.cancel();
  });

  it("masks every viewer link the status carries", async () => {
    handle = await startControlServer(
      {
        getStatus: () => ({
          ...status(),
          relay: {
            mode: "embedded",
            url: "http://127.0.0.1:8787",
            viewerUrl: "https://relay.supr.systems/watch/view-secret",
            localViewerUrl: "http://192.168.1.5:8787/watch/view-secret",
            remoteViewerUrl: "https://relay.supr.systems/watch/view-secret?obs=1",
          },
        }),
        start: async () => {},
        stop: async () => {},
        patchConfig: async () => status(),
        rotateLink: async () => {},
      },
      { port: 0 },
    );
    const text = await (await fetch(`http://127.0.0.1:${handle.port}/status`)).text();
    expectNoSecrets(text);
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

/**
 * Audit finding 3, the half of it that turned out to be dead code.
 *
 * `GET /link` carried a `STILL OPEN` comment: it returns the unredacted viewer
 * link on purpose, `allowedOrigin` admits `Origin: null` - which is what a
 * sandboxed iframe on any web page sends - and there is no credential to check.
 * So any page you visit could ask for your viewer link and watch your stream.
 *
 * It has no callers. Not the Stream Deck plugin (`apps/streamdeck/src/plugin.ts`
 * uses status/start/stop only), not the property inspector (`pi/pi.js` calls
 * /status, /config, /link/rotate and /events), not the desktop app, which reads
 * its own config over IPC. The only caller was `ControlClient.link()`, which
 * nothing called either. A route that exists to hand out a secret, that nobody
 * asks for, is not a route to authenticate - it is a route to delete.
 *
 * What this does NOT close is the rest of finding 3: `POST /link/rotate` hands
 * back the same unredacted link, and the property inspector genuinely needs it,
 * so it cannot simply be masked. That still needs the per-launch token.
 */
describe("the route that handed out the viewer link", () => {
  it("is not there any more", async () => {
    const base = await serve();
    const res = await fetch(`${base}/link`, { headers: { Origin: "null" } });

    expect(res.status, "GET /link still answers").toBe(404);
    expectNoSecrets(await res.text());
  });

  it("leaves nothing an unauthenticated reader can pull the link out of", async () => {
    const base = await serve();

    // everything a sandboxed iframe can reach with a plain GET: no client
    // header, no credential, the null origin the check admits
    const st = await fetch(`${base}/status`, { headers: { Origin: "null" } });
    expect(st.status).toBe(200);
    expectNoSecrets(await st.text());

    const ctl = new AbortController();
    const ev = await fetch(`${base}/events`, { headers: { Origin: "null" }, signal: ctl.signal });
    const frame = await ev.body!.getReader().read();
    ctl.abort();
    expectNoSecrets(new TextDecoder().decode(frame.value));
  });

  it("still rotates the link for the property inspector, which does use that", async () => {
    const base = await serve();
    const res = await post(base, "/link/rotate");

    expect(res.status, "the deletion took the live route with it").toBe(200);
    expect((await res.json()).viewerUrl).toContain("/watch/");
  });
});

/**
 * Audit finding 28, the half of it that can be run.
 *
 * The app awaited `startControl()` with no try/catch and installs no
 * `unhandledRejection` handler, so anything already holding 127.0.0.1:47477
 * took the whole of startup down with it - no tray, no window, and a process
 * still holding the single-instance lock, which makes every relaunch quit
 * silently. That only matters if the reject is real, so here it is, against a
 * real socket. The call site is guarded at the source in
 * `packages/shared/test/startupGuards.test.ts` - main.ts imports Electron and
 * cannot be loaded here.
 */
describe("a control server that cannot have the port", () => {
  it("rejects rather than resolving onto a port it does not hold", async () => {
    const squatter = http.createServer();
    await new Promise<void>((r) => squatter.listen(0, "127.0.0.1", () => r()));
    const taken = (squatter.address() as { port: number }).port;

    await expect(
      startControlServer(
        {
          getStatus: status,
          start: async () => {},
          stop: async () => {},
          patchConfig: async () => status(),
          rotateLink: async () => {},
        },
        { port: taken },
      ),
    ).rejects.toThrow(/EADDRINUSE|listen/i);

    await new Promise<void>((r) => squatter.close(() => r()));
  });
});
