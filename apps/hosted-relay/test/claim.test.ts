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

/**
 * One host, a fresh bucket on every request.
 *
 * An ordinary IPv6 host holds a whole /64 - 2^64 addresses - and can send each
 * request from a different one. Keyed on the full address, every request found
 * an empty bucket and neither limiter ever refused anything: not /claim, and
 * not /feedback, which writes up to ~1.5 MB into R2 per request on a bucket
 * with no expiry. Cloudflare turns IPv6 on for proxied domains by default. A
 * /64 is the unit a single subscriber is handed, so it is the unit to count.
 */
describe("the rate-limit key for an IPv6 caller", () => {
  const key = (ip: string): string => claimRateKey(claim({ "CF-Connecting-IP": ip }));

  it("is the same for every address in one /64", () => {
    expect(key("2001:db8:1:2::1"), "one host got a fresh bucket by changing the end of its address").toBe(
      key("2001:db8:1:2::ffff"),
    );
    expect(key("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(key("2001:db8:1:2::1"));
  });

  it("is the same whichever way the address is written", () => {
    expect(key("2001:0DB8:0001:0002:0000:0000:0000:0001")).toBe(key("2001:db8:1:2::1"));
  });

  it("still tells two /64s apart", () => {
    expect(key("2001:db8:1:2::1")).not.toBe(key("2001:db8:1:3::1"));
    expect(key("2001:db8::1")).not.toBe(key("2001:db9::1"));
  });

  it("leaves an IPv4 address as it is, however it is written", () => {
    expect(key("203.0.113.7")).toBe("203.0.113.7");
    expect(key("::ffff:203.0.113.7"), "an IPv4 caller written as IPv6 got a second bucket").toBe("203.0.113.7");
  });

  it("is what the claim limiter is actually handed", async () => {
    const keys: string[] = [];
    const h = envWith({ allow: true, onLimit: (k) => keys.push(k) });
    await worker.fetch(claim({ "CF-Connecting-IP": "2001:db8:1:2::1" }), h.env);
    await worker.fetch(claim({ "CF-Connecting-IP": "2001:db8:1:2::2" }), h.env);
    expect(keys[0]).toBe(keys[1]);
  });
});
