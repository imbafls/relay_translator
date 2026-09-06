import { describe, expect, it } from "vitest";
import worker, { claimRateKey } from "../src/index";

/**
 * `POST /claim` mints a room for anybody who asks. The rooms are worthless
 * without their secrets and an idle one costs nothing, which is why this was
 * survivable while the URL was unadvertised - and exactly why it had to be
 * closed before it was handed to anyone.
 *
 * The router holds no state by design, so the limit is the platform's: a
 * `ratelimit` binding, keyed per client. These drive the real `fetch` with the
 * binding stood in for, so the decision under test is the shipped one.
 */

type Env = Parameters<typeof worker.fetch>[1];

function envWith(opts: { allow?: boolean; onLimit?: (key: string) => void } = {}): {
  env: Env;
  claimed: number;
} {
  const state = { claimed: 0 };
  const env = {
    ROOM: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: async () => {
          state.claimed += 1;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      }),
    },
    ASSETS: { fetch: async () => new Response("asset") },
    CLAIM_LIMIT:
      opts.allow === undefined
        ? undefined
        : {
            limit: async ({ key }: { key: string }) => {
              opts.onLimit?.(key);
              return { success: opts.allow as boolean };
            },
          },
  } as unknown as Env;
  return { env, get claimed() { return state.claimed; } };
}

const claim = (headers: Record<string, string> = {}): Request =>
  new Request("https://relay.example/claim", { method: "POST", headers });

describe("rate limiting POST /claim", () => {
  it("mints a room when the limiter allows it", async () => {
    const h = envWith({ allow: true });
    const res = await worker.fetch(claim({ "CF-Connecting-IP": "203.0.113.7" }), h.env);
    expect(res.status).toBe(200);
    expect(h.claimed, "the room was never actually claimed").toBe(1);
  });

  it("refuses with 429 when the limiter says no", async () => {
    const h = envWith({ allow: false });
    const res = await worker.fetch(claim({ "CF-Connecting-IP": "203.0.113.7" }), h.env);
    expect(res.status).toBe(429);
  });

  it("does not wake a Durable Object for a refused claim", async () => {
    // the point of refusing at the edge: a rejected claim must not cost
    // anything, and a DO that runs is a DO that bills
    const h = envWith({ allow: false });
    await worker.fetch(claim({ "CF-Connecting-IP": "203.0.113.7" }), h.env);
    expect(h.claimed, "a refused claim still created a room").toBe(0);
  });

  it("keeps working with no limiter bound, which is local dev", async () => {
    const h = envWith({});
    const res = await worker.fetch(claim(), h.env);
    expect(res.status).toBe(200);
    expect(h.claimed).toBe(1);
  });

  it("buckets by the address Cloudflare reports", async () => {
    const keys: string[] = [];
    const h = envWith({ allow: true, onLimit: (k) => keys.push(k) });
    await worker.fetch(claim({ "CF-Connecting-IP": "203.0.113.7" }), h.env);
    expect(keys).toEqual(["203.0.113.7"]);
  });

  it("ignores a forwarded-for header, which the client controls", async () => {
    // CF-Connecting-IP is written by Cloudflare and overwritten on every
    // request; X-Forwarded-For is whatever the caller typed. Trusting the
    // second one would hand every attacker their own private bucket.
    expect(claimRateKey(claim({ "X-Forwarded-For": "1.2.3.4" }))).not.toBe("1.2.3.4");
    expect(
      claimRateKey(claim({ "CF-Connecting-IP": "203.0.113.7", "X-Forwarded-For": "1.2.3.4" })),
    ).toBe("203.0.113.7");
  });

  it("puts every unidentifiable caller in one bucket rather than none", () => {
    // no address means no per-client limit is possible; sharing a bucket is the
    // safe reading, because a per-request unique key is no limit at all
    expect(claimRateKey(claim())).toBe(claimRateKey(claim()));
    expect(claimRateKey(claim())).toBeTruthy();
  });
});
