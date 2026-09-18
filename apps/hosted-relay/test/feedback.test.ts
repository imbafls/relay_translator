import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import * as path from "node:path";
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

  // the costly one: an accepted report is up to two R2 objects, ~1.5 MB, on a
  // bucket that never expires - one IPv6 host must not get a bucket per address
  it("counts every address in one IPv6 /64 as one sender", async () => {
    const keys: string[] = [];
    const { env } = envWith({ allow: true });
    (env as unknown as { FEEDBACK_LIMIT: unknown }).FEEDBACK_LIMIT = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: true };
      },
    };
    for (const ip of ["2001:db8:1:2::1", "2001:db8:1:2::beef"]) {
      await worker.fetch(post({ message: "hi", appVersion: "0.8.1" }, { "CF-Connecting-IP": ip }), env);
    }
    expect(keys).toHaveLength(2);
    expect(keys[0], "each address in one /64 was handed its own feedback allowance").toBe(keys[1]);
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

/**
 * Terminal escape sequences, from anyone, into the maintainer's terminal.
 *
 * `POST /feedback` takes no token - it writes into R2 for whoever asks - and
 * nothing it checked rejected a control character. `read-feedback.cjs`, the
 * one supported way to read a report, JSON-parses the record back into real
 * ESC and BEL bytes and prints the version and a preview of the message. So
 * a report could write the maintainer's clipboard (OSC 52 in Windows
 * Terminal), move the cursor to hide the reports around it, or dress a link
 * up as another (OSC 8) - in the shell that holds a wrangler login.
 *
 * Closed at both ends: the Worker stores no control character a report did
 * not need (a message keeps its line breaks and tabs), and the reader prints
 * none - records already stored are still dirty.
 */
const ESC = "\x1b";
const BEL = "\x07";
const HOSTILE = `${ESC}]52;c;aGk=${BEL}${ESC}[1A${ESC}[2K${ESC}]8;;https://evil.example${ESC}\\`;
/** C0 but tab, LF and CR; DEL; and C1 */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;

describe("control characters in a feedback report", () => {
  it("are not stored from the message, the version or the log", async () => {
    const { env, puts } = envWith({ allow: true });

    const res = await worker.fetch(
      post({
        message: `captions froze${HOSTILE}\nafter an hour\tor so`,
        appVersion: `0.8.1${ESC}[2J`,
        log: `boot\r\n${HOSTILE}ready\n`,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const record = JSON.parse(puts.find((p) => p.key.endsWith(".json"))!.value as string) as Record<string, string>;
    expect(record.message, "the stored message still carries a terminal escape").not.toMatch(CONTROL);
    expect(record.appVersion, "the stored version still carries a terminal escape").not.toMatch(CONTROL);
    const log = puts.find((p) => p.key.endsWith(".log"))!.value as string;
    expect(log, "the stored log still carries a terminal escape").not.toMatch(CONTROL);

    // what a person wrote survives: the words, the line break, the tab
    expect(record.message).toContain("captions froze");
    expect(record.message).toContain("\nafter an hour\tor so");
    expect(record.appVersion).toBe("0.8.1[2J");
    expect(log).toContain("boot\r\n");
  });

  it("leave a version that was nothing else empty, and refused", async () => {
    const { env, puts } = envWith({ allow: true });
    const res = await worker.fetch(post({ message: "hi", appVersion: `${ESC}${BEL}` }), env);
    expect(res.status).toBe(400);
    expect(puts).toHaveLength(0);
  });

  it("are not printed by the script that reads the reports", () => {
    const { printable, preview } = requireScript("read-feedback.cjs") as {
      printable: (s: string) => string;
      preview: (s: string) => string;
    };
    expect(printable(`0.8.1${HOSTILE}`), "the version is printed with its escapes intact").not.toMatch(CONTROL);
    expect(preview(`captions froze${HOSTILE}`), "the message preview is printed with its escapes intact").not.toMatch(
      CONTROL,
    );
    // and it still reads as what was sent
    expect(preview("captions  froze\nafter an hour")).toBe("captions froze after an hour");
  });
});

/** a script in `scripts/`, loaded without running it */
function requireScript(name: string): unknown {
  return createRequire(__filename)(path.join(__dirname, "..", "scripts", name));
}
