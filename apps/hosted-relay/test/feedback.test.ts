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
 * Four things have to hold, in order of how expensive a mistake would be:
 *   1. A refused request must cost nothing - same reasoning as /claim's rate
 *      limit, checked first, before anything else runs.
 *   2. An oversized request must be refused by its DECLARED size, before the
 *      body is ever read - a 413 that already buffered the body saved
 *      nothing. That includes a request whose declared size cannot even be
 *      read (missing or non-numeric Content-Length): there is exactly one
 *      caller of this endpoint and a real `fetch()` call always sets it, so
 *      an unreadable length is refused the same as an oversized one.
 *   3. Every field has its own cap, not just the overall body. Staying under
 *      the declared-size ceiling does not mean any one field is reasonably
 *      sized - a version string with no cap of its own is exactly how a
 *      request that looks fine at the door writes something huge.
 *   4. Nothing written to R2 may identify the machine that sent it - no IP,
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

function envWith(
  opts: { allow?: boolean; failPut?: "json" | "log" } = {},
): { env: Env; puts: Put[] } {
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
        const isLog = key.endsWith(".log");
        // A rejected R2 put, on demand - the real binding can fail (quota,
        // a transient platform error), and until this stub could reject
        // nothing here exercised that path at all.
        if (opts.failPut === "json" && !isLog) throw new Error("R2 put failed (json)");
        if (opts.failPut === "log" && isLog) throw new Error("R2 put failed (log)");
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

/**
 * A real HTTP request always carries the true `Content-Length` on the wire,
 * even though `new Request()` in this test runtime does not populate it on
 * `.headers` by itself (confirmed separately: a plain `new Request(url,
 * {body})` has no Content-Length header at all until something actually
 * sends it). Setting it here from the real encoded byte length is what makes
 * this helper stand in for a genuine caller - `post()` without an explicit
 * override behaves like the one real client this endpoint has, not like the
 * header-less case Finding 2 is about.
 */
function post(body: unknown, headers: Record<string, string> = {}): Request {
  const raw = JSON.stringify(body);
  return new Request("https://relay.example/feedback", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(new TextEncoder().encode(raw).length),
      ...headers,
    },
    body: raw,
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

  it("refuses a request with no Content-Length header, before reading the body", async () => {
    // Not routed through post() - that helper deliberately sets a real
    // Content-Length to stand in for a genuine caller. This constructs the
    // header-less case directly: no application caller of this endpoint
    // omits it, but a request that manages to arrive without one must not
    // be waved through to `request.json()` on the strength of a `Number(null)
    // === 0` fallthrough.
    let bodyRead = false;
    const req = {
      url: "https://relay.example/feedback",
      method: "POST",
      headers: new Headers({ "Content-Type": "application/json" }),
      json: async () => {
        bodyRead = true;
        throw new Error("body should not have been read");
      },
    } as unknown as Request;
    const { env, puts } = envWith({ allow: true });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(413);
    expect(bodyRead, "the body was read despite no declared length").toBe(false);
    expect(puts).toHaveLength(0);
  });

  it("refuses a request with a non-numeric Content-Length, before reading the body", async () => {
    let bodyRead = false;
    const req = {
      url: "https://relay.example/feedback",
      method: "POST",
      headers: new Headers({ "Content-Type": "application/json", "Content-Length": "garbage" }),
      json: async () => {
        bodyRead = true;
        throw new Error("body should not have been read");
      },
    } as unknown as Request;
    const { env, puts } = envWith({ allow: true });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(413);
    expect(bodyRead).toBe(false);
    expect(puts).toHaveLength(0);
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
    // The exact contract: 16 lowercase hex characters (8 random bytes).
    // Task 8 is told to rely on this shape - a looser check here (e.g. "at
    // least 8 characters") would stay green even if the id generator's
    // entropy were quietly halved.
    expect(body.id).toMatch(/^[a-f0-9]{16}$/);

    expect(puts).toHaveLength(1);
    expect(puts[0].key).toMatch(new RegExp(`^\\d{4}/\\d{2}/\\d{2}/${body.id}\\.json$`));
    const record = JSON.parse(puts[0].value as string) as Record<string, unknown>;
    expect(record.message).toBe("captions stopped after 2 hours");
    expect(record.appVersion).toBe("0.6.0");
    expect(typeof record.timestamp).toBe("string");
  });

  it("refuses an oversized appVersion with 400 and writes nothing", async () => {
    // Well under FEEDBACK_BODY_MAX (~1.57 MB) so the request clears the
    // declared-size check - the point is that a request that looks
    // reasonably sized overall can still carry one field that is not.
    const { env, puts } = envWith({ allow: true });
    const hugeVersion = "9".repeat(100 * 1024); // 100 KB - a version string is never this

    const res = await worker.fetch(post({ message: "hi", appVersion: hugeVersion }), env);

    expect(res.status).toBe(400);
    expect(puts).toHaveLength(0);
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

    // A green run here proves nothing on its own: `puts` starts empty and
    // stays empty for plenty of reasons that have nothing to do with this
    // behaviour (a 404, a rate-limit refusal). It only guards the intended
    // thing - "no log means no .log write" - once it is read together with
    // "stores a well-formed report", above, which pins `puts` to exactly one
    // entry and confirms that entry is the .json one, for the same request
    // shape. This test was previously green even during RED (the route
    // didn't exist, `puts` was vacuously empty) without being flagged as
    // such; noted accurately here rather than repeating that gap.
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

  it("returns 502 and stores nothing when the .json put itself fails", async () => {
    const { env, puts } = envWith({ allow: true, failPut: "json" });

    const res = await worker.fetch(post({ message: "hi", appVersion: "0.6.0" }), env);

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; id?: string };
    // Nothing was stored, so there is no id to hand back - and no id means
    // a client that treats "there's an id" as "it's safe to move on" cannot
    // be fooled into thinking a failed report succeeded.
    expect(body.id).toBeUndefined();
    expect(typeof body.error).toBe("string");
    expect(puts).toHaveLength(0);
  });

  it("returns 502 with the id when the log put fails after the json put succeeds", async () => {
    const { env, puts } = envWith({ allow: true, failPut: "log" });

    const res = await worker.fetch(
      post({ message: "hi", appVersion: "0.6.0", log: "boot\n" }),
      env,
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; id?: string };
    // The .json half DID land - the id it landed under is returned so the
    // caller knows a retry would create a duplicate report rather than
    // finishing this one.
    expect(body.id).toMatch(/^[a-f0-9]{16}$/);
    expect(puts).toHaveLength(1);
    expect(puts[0].key.endsWith(".json")).toBe(true);
    expect(puts[0].key).toContain(body.id as string);
  });
});
