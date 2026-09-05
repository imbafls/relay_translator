import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { createGeminiTranslator } from "../src/gemini";

/**
 * The real translator runs here - its retry predicate, its backoff, its cache
 * and its response parsing. What stands in is Google: a real HTTP server on
 * localhost answering the same shapes the API answers, including the ones that
 * only show up when something is going wrong.
 */

interface Stub {
  url: string;
  /** one entry per request received, in order */
  hits: { body: unknown }[];
  close(): Promise<void>;
}

/** answer each request with the next reply, repeating the last one forever */
async function stubApi(replies: Array<{ status: number; body: unknown } | "hangup">): Promise<Stub> {
  const hits: { body: unknown }[] = [];
  let n = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        body = null;
      }
      hits.push({ body });
      const reply = replies[Math.min(n, replies.length - 1)];
      n += 1;
      if (reply === "hangup") {
        // drop the connection mid-request: fetch rejects with no status
        req.socket.destroy();
        return;
      }
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1beta`,
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const said = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] } }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
});

/** a 200 that stopped because it ran out of room - a sentence cut mid-clause */
const cutOff = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: "MAX_TOKENS" }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 120 },
});

let stub: Stub | null = null;
afterEach(async () => {
  await stub?.close();
  stub = null;
});

function translator(s: Stub, over: Record<string, unknown> = {}) {
  return createGeminiTranslator({
    apiKey: "test-key",
    model: "gemini-3.1-flash-lite",
    source: "en",
    target: "vi",
    baseUrl: s.url,
    timeoutMs: 2000,
    // keep the retry shape but drop the waiting
    backoffMs: [0, 10, 20],
    ...over,
  });
}

describe("a translation that works", () => {
  it("returns the text and sends the utterance in the request", async () => {
    stub = await stubApi([{ status: 200, body: said("rush B") }]);
    const out = await translator(stub).translate("rush bee");
    expect(out).toBe("rush B");
    const sent = stub.hits[0].body as { contents: { parts: { text: string }[] }[] };
    expect(sent.contents[0].parts[0].text).toBe("rush bee");
  });

  it("joins multi-part answers and trims them", async () => {
    stub = await stubApi([
      { status: 200, body: { candidates: [{ content: { parts: [{ text: " one " }, { text: "two " }] } }] } },
    ]);
    expect(await translator(stub).translate("x")).toBe("one two");
  });

  it("reports tokens as not cached the first time", async () => {
    stub = await stubApi([{ status: 200, body: said("ok") }]);
    const uses: { cached: boolean; tokensIn: number }[] = [];
    await translator(stub, { stats: { onUse: (u: never) => uses.push(u) } }).translate("hello");
    expect(uses).toEqual([{ cached: false, tokensIn: 10, tokensOut: 4 }]);
  });
});

describe("the cache", () => {
  it("answers a repeat callout without asking again", async () => {
    stub = await stubApi([{ status: 200, body: said("A site") }]);
    const t = translator(stub);
    expect(await t.translate("a site")).toBe("A site");
    expect(await t.translate("a site")).toBe("A site");
    expect(stub.hits).toHaveLength(1);
  });

  it("treats trivial differences in a callout as the same thing", async () => {
    stub = await stubApi([{ status: 200, body: said("rotate") }]);
    const t = translator(stub);
    await t.translate("Rotate!");
    // different case, trailing punctuation and spacing: still one API call
    await t.translate("  rotate  ");
    expect(stub.hits).toHaveLength(1);
  });
});

describe("when the API is having a bad day", () => {
  it("retries a 429 and returns the answer when quota frees up", async () => {
    stub = await stubApi([
      { status: 429, body: { error: "quota" } },
      { status: 200, body: said("clutch") },
    ]);
    expect(await translator(stub).translate("clutch")).toBe("clutch");
    expect(stub.hits).toHaveLength(2);
  });

  it("retries a 500", async () => {
    stub = await stubApi([
      { status: 500, body: { error: "boom" } },
      { status: 200, body: said("eco") },
    ]);
    expect(await translator(stub).translate("eco")).toBe("eco");
    expect(stub.hits).toHaveLength(2);
  });

  it("retries a dropped connection, which is what a flaky link actually does", async () => {
    stub = await stubApi(["hangup", { status: 200, body: said("one tapped") }]);
    expect(await translator(stub).translate("one tap")).toBe("one tapped");
    expect(stub.hits).toHaveLength(2);
  });

  it("gives up on a bad key instead of hammering it", async () => {
    stub = await stubApi([{ status: 400, body: { error: "bad key" } }]);
    await expect(translator(stub).translate("x")).rejects.toThrow(/gemini 400/);
    // a 4xx is our fault; asking twice more cannot fix it
    expect(stub.hits).toHaveLength(1);
  });

  it("gives up on a 200 that carries no candidates", async () => {
    stub = await stubApi([{ status: 200, body: { candidates: [] } }]);
    await expect(translator(stub).translate("x")).rejects.toThrow(/empty response/);
    // a safety block answers the same way however many times you ask
    expect(stub.hits).toHaveLength(1);
  });

  it("stops after the last backoff rather than retrying forever", async () => {
    stub = await stubApi([{ status: 503, body: { error: "down" } }]);
    await expect(translator(stub).translate("x")).rejects.toThrow(/gemini 503/);
    expect(stub.hits).toHaveLength(3);
  });

  it("does not cache a failure", async () => {
    stub = await stubApi([
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 200, body: said("late") },
    ]);
    const t = translator(stub);
    await expect(t.translate("x")).rejects.toThrow();
    expect(await t.translate("x")).toBe("late");
  });
});

describe("an answer that ran out of room", () => {
  it("asks again with more room", async () => {
    stub = await stubApi([{ status: 200, body: cutOff("rotate to A and then") }, { status: 200, body: said("rotate to A and then take mid") }]);
    const out = await translator(stub).translate("long callout");
    expect(out).toBe("rotate to A and then take mid");
    expect(stub.hits).toHaveLength(2);

    const second = stub.hits[1].body as { generationConfig: { maxOutputTokens: number } };
    const first = stub.hits[0].body as { generationConfig: { maxOutputTokens: number } };
    expect(second.generationConfig.maxOutputTokens).toBeGreaterThan(first.generationConfig.maxOutputTokens);
  });

  it("does not remember a fragment when the second try is cut off too", async () => {
    // half a sentence is still better than nothing on a live caption, but the
    // cache would serve it for the next thirty minutes
    stub = await stubApi([{ status: 200, body: cutOff("rotate to A and") }]);
    const t = translator(stub);
    expect(await t.translate("long callout")).toBe("rotate to A and");
    const afterFirst = stub.hits.length;

    expect(await t.translate("long callout")).toBe("rotate to A and");
    expect(stub.hits.length, "the fragment was served from cache").toBeGreaterThan(afterFirst);
  });

  it("still caches an answer that finished", async () => {
    stub = await stubApi([{ status: 200, body: said("rush B") }]);
    const t = translator(stub);
    await t.translate("rush bee");
    await t.translate("rush bee");
    expect(stub.hits).toHaveLength(1);
  });

  it("treats a normal finish reason as complete", async () => {
    stub = await stubApi([
      { status: 200, body: { candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }] } },
    ]);
    expect(await translator(stub).translate("x")).toBe("done");
    expect(stub.hits).toHaveLength(1);
  });
});
