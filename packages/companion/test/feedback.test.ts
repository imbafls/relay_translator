import { describe, expect, it } from "vitest";
import { HOSTED_RELAY_URL } from "@callout-relay/shared";
import { feedbackUrlFor, sendFeedback } from "../src/feedback";
import type { FeedbackPayload } from "../src/feedback";

/**
 * The network half of SEND FEEDBACK (Task 8), moved here from the renderer
 * because a `fetch()` from an Electron renderer's `file://` origin is blocked
 * by CORS against a Worker that answers none of the `Access-Control-*`
 * headers on any route - verified against the live deploy: a cross-origin
 * `GET https://textrelay.cc/health` from `http://127.0.0.1` came back
 * "has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header
 * is present". Node's `fetch` (main.ts, over IPC) has no origin, so it has
 * nothing to be blocked against - the same reason `claimHostedRoom` already
 * lives here rather than in the renderer.
 *
 * Every case is driven by a fake `fetchImpl` - no real socket, no `vi.mock` -
 * the same seam `hostedRoom.ts` exposes, just exercised directly instead of
 * through a real local server, since `sendFeedback` (deliberately) takes no
 * address to redirect: it always targets the hosted relay's own `/feedback`
 * route, never something a caller supplies.
 */

const payload: FeedbackPayload = { message: "captions froze after twenty minutes", appVersion: "0.6.0" };

function fakeRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("where feedback is sent", () => {
  it("resolves to the hosted relay's /feedback route", () => {
    expect(feedbackUrlFor()).toBe("https://textrelay.cc/feedback");
    expect(feedbackUrlFor("wss://relay.supr.systems")).toBe("https://relay.supr.systems/feedback");
    expect(feedbackUrlFor("ws://127.0.0.1:8787")).toBe("http://127.0.0.1:8787/feedback");
  });

  it("ships the same default hosted relay claiming uses", () => {
    // if this default ever moves, feedback has to move with it - same as
    // claimUrlFor(HOSTED_RELAY_URL) in hostedRoom.test.ts
    expect(HOSTED_RELAY_URL).toBe("wss://textrelay.cc");
  });
});

describe("sending feedback", () => {
  it("posts JSON to the fixed endpoint - there is no url parameter to redirect it", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen.push({ url: String(url), init });
      return fakeRes(200, { id: "a1b2c3d4e5f6a7b8" });
    };

    await sendFeedback(payload, { fetchImpl: fetchImpl as typeof fetch });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://textrelay.cc/feedback");
    expect(seen[0].init?.method).toBe("POST");
    expect((seen[0].init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(seen[0].init?.body))).toEqual(payload);
  });

  it("reports delivered with the reference id on 200", async () => {
    const result = await sendFeedback(payload, {
      fetchImpl: (async () => fakeRes(200, { id: "a1b2c3d4e5f6a7b8" })) as typeof fetch,
    });
    expect(result).toEqual({ delivered: true, id: "a1b2c3d4e5f6a7b8", logFailed: false });
  });

  it("treats a 502 that carries an id as delivered - the report landed, only the log attachment failed", async () => {
    const result = await sendFeedback(
      { ...payload, log: "deepgram key <redacted>" },
      { fetchImpl: (async () => fakeRes(502, { error: "feedback stored, log upload failed", id: "deadbeefdeadbeef" })) as typeof fetch },
    );
    expect(result).toEqual({ delivered: true, id: "deadbeefdeadbeef", logFailed: true });
  });

  it("treats a 502 with no id as nothing stored, safe to retry", async () => {
    const result = await sendFeedback(payload, {
      fetchImpl: (async () => fakeRes(502, { error: "feedback could not be stored" })) as typeof fetch,
    });
    expect(result).toEqual({ delivered: false, message: "feedback could not be stored" });
  });

  it("surfaces the server's own error text for every other refusal", async () => {
    const cases: [number, string][] = [
      [400, "invalid feedback"],
      [413, "feedback too large"],
      [415, "expected application/json"],
      [429, "too much feedback from here - try again in a minute"],
    ];
    for (const [status, error] of cases) {
      const result = await sendFeedback(payload, {
        fetchImpl: (async () => fakeRes(status, { error })) as typeof fetch,
      });
      expect(result, `status ${status}`).toEqual({ delivered: false, message: error });
    }
  });

  it("says so, rather than throwing, when the server cannot be reached at all", async () => {
    const result = await sendFeedback(payload, {
      fetchImpl: (async () => {
        throw new Error("getaddrinfo ENOTFOUND textrelay.cc");
      }) as typeof fetch,
    });
    expect(result.delivered).toBe(false);
    expect((result as { message: string }).message).toMatch(/could not reach the server/i);
  });

  it("times out rather than hanging forever, and says so distinctly from a refusal", async () => {
    const result = await sendFeedback(payload, {
      timeoutMs: 20,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          (init?.signal as AbortSignal)?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        })) as typeof fetch,
    });
    expect(result.delivered).toBe(false);
    expect((result as { message: string }).message).toMatch(/did not answer in time/i);
  });

  it("never sends a request before the payload is built - JSON body matches exactly {message, appVersion, log?}", async () => {
    const seen: unknown[] = [];
    await sendFeedback(payload, {
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        seen.push(JSON.parse(String(init?.body)));
        return fakeRes(200, { id: "x" });
      }) as typeof fetch,
    });
    expect(Object.keys(seen[0] as object).sort()).toEqual(["appVersion", "message"]);
  });
});
