import { describe, expect, it } from "vitest";
import worker from "../src/index";

/**
 * `POST /feedback` is this Worker's first write path: a person presses SEND
 * FEEDBACK in the desktop app and a message (plus, optionally, their own
 * `relay.log`, already redacted on their machine by `redactLog` - see
 * packages/shared/src/index.ts) lands in R2. Nobody is watching this service
 * day to day once 0.7.0 ships, so what this endpoint gets wrong nobody
 * notices until they go looking.
 *
 * Three things have to hold, in order of how expensive a mistake would be:
 *   1. A refused request must cost nothing - same reasoning as /claim's rate
 *      limit, checked first, before anything else runs.
 *   2. An oversized request must be refused by its DECLARED size, before the
 *      body is ever read - a 413 that already buffered the body saved
 *      nothing.
 *   3. Nothing written to R2 may identify the machine that sent it - no IP,
 *      no user agent, no install id. The reference id is generated per send
 *      and is not a fingerprint.
 *
 * These drive the real `worker.fetch` against hand-written bindings, the way
 * `claim.test.ts` and `room.test.ts` do - no `vi.mock` anywhere in this repo.
 */

type Env = Parameters<typeof worker.fetch>[1];

interface Put {
  key: string;
  value: unknown;
  contentType?: string;
}

function envWith(opts: { allow?: boolean } = {}): { env: Env; puts: Put[] } {
  const puts: Put[] = [];
  const env = {
    ROOM: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({ fetch: async () => new Response("{}") }),
    },
    ASSETS: { fetch: async () => new Response("asset") },
    FEEDBACK: {
      put: async (
        key: string,
        value: unknown,
        options?: { httpMetadata?: { contentType?: string } },
      ) => {
        puts.push({ key, value, contentType: options?.httpMetadata?.contentType });
        return {};
      },
    },
    FEEDBACK_LIMIT:
      opts.allow === undefined
        ? undefined
        : { limit: async () => ({ success: opts.allow as boolean }) },
  } as unknown as Env;
  return { env, puts };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://relay.example/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /feedback", () => {
  it("refuses an oversized request by its declared length, before the body is read", async () => {
    // A duck-typed stand-in rather than a real Request with a stream body:
    // Node's undici drains a ReadableStream body on its own background
    // microtask the moment one is attached to a Request, whether or not
    // application code ever reads it - that made a stream-pull flag prove
    // nothing about *this handler's* behaviour. `.json()` throwing is a
    // direct, deterministic assertion that the handler itself never called
    // it - nothing else in `worker.fetch` touches the body before routing.
    let bodyRead = false;
    const req = {
      url: "https://relay.example/feedback",
      method: "POST",
      headers: new Headers({ "Content-Type": "application/json", "Content-Length": "999999999" }),
      json: async () => {
        bodyRead = true;
        throw new Error("body should not have been read");
      },
    } as unknown as Request;
    const { env, puts } = envWith({ allow: true });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(413);
    expect(bodyRead, "the body was read before the declared size was checked").toBe(false);
    expect(puts, "an oversized request still wrote to R2").toHaveLength(0);
  });

  it("refuses a non-JSON content type with 415", async () => {
    const { env, puts } = envWith({ allow: true });
    const req = post({ message: "hi", appVersion: "0.6.0" }, { "Content-Type": "text/plain" });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(415);
    expect(puts).toHaveLength(0);
  });

  it("stores a well-formed report and returns a short reference id", async () => {
    const { env, puts } = envWith({ allow: true });

    const res = await worker.fetch(post({ message: "captions stopped after 2 hours", appVersion: "0.6.0" }), env);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = (await res.json()) as { id: string };
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThanOrEqual(8);
    expect(body.id).toMatch(/^[a-f0-9]+$/);

    expect(puts).toHaveLength(1);
    expect(puts[0].key).toMatch(new RegExp(`^\\d{4}/\\d{2}/\\d{2}/${body.id}\\.json$`));
    const record = JSON.parse(puts[0].value as string) as Record<string, unknown>;
    expect(record.message).toBe("captions stopped after 2 hours");
    expect(record.appVersion).toBe("0.6.0");
    expect(typeof record.timestamp).toBe("string");
  });

  it("also writes the attached log under the matching key", async () => {
    const { env, puts } = envWith({ allow: true });

    const res = await worker.fetch(
      post({ message: "no audio", appVersion: "0.6.0", log: "2026-09-08 boot\n<redacted>\n" }),
      env,
    );
    const body = (await res.json()) as { id: string };

    expect(puts).toHaveLength(2);
    const jsonPut = puts.find((p) => p.key.endsWith(".json"));
    const logPut = puts.find((p) => p.key.endsWith(".log"));
    expect(jsonPut?.key).toBe(`${logPut?.key.replace(/\.log$/, ".json")}`);
    expect(logPut?.key).toContain(body.id);
    // stored exactly as sent - the Worker does not re-redact, because the
    // client already did (redactLog runs client-side, before upload)
    expect(logPut?.value).toBe("2026-09-08 boot\n<redacted>\n");
  });

  it("writes no .log object when no log was attached", async () => {
    const { env, puts } = envWith({ allow: true });

    await worker.fetch(post({ message: "hi", appVersion: "0.6.0" }), env);

    expect(puts.some((p) => p.key.endsWith(".log"))).toBe(false);
  });

  it("refuses over the rate limit with 429, and never touches R2", async () => {
    const { env, puts } = envWith({ allow: false });

    const res = await worker.fetch(post({ message: "hi", appVersion: "0.6.0" }), env);

    expect(res.status).toBe(429);
    expect(puts, "a refused report still cost an R2 write").toHaveLength(0);
  });

  it("keeps working with no limiter bound, which is local dev", async () => {
    const { env } = envWith({});
    const res = await worker.fetch(post({ message: "hi", appVersion: "0.6.0" }), env);
    expect(res.status).toBe(200);
  });

  it("stores nothing that identifies the machine that sent it", async () => {
    const { env, puts } = envWith({ allow: true });

    await worker.fetch(
      post(
        { message: "hi", appVersion: "0.6.0" },
        { "CF-Connecting-IP": "203.0.113.7", "User-Agent": "CalloutRelay/0.6.0 (Windows NT 10.0)" },
      ),
      env,
    );

    const record = JSON.parse(puts[0].value as string) as Record<string, unknown>;
    const blob = JSON.stringify(record).toLowerCase();
    expect(blob).not.toContain("203.0.113.7");
    expect(blob).not.toContain("windows");
    expect(Object.keys(record).sort()).toEqual(["appVersion", "message", "timestamp"]);
  });

  it("rejects a malformed body with 400 rather than guessing", async () => {
    const { env, puts } = envWith({ allow: true });

    const res = await worker.fetch(post({ appVersion: "0.6.0" }), env); // no message

    expect(res.status).toBe(400);
    expect(puts).toHaveLength(0);
  });
});
