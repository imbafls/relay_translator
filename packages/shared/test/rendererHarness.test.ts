import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";

/**
 * The renderer harness, and the one behaviour it must never lose.
 *
 * `docs/RALPH-IMPROVEMENT-LOOP.md` calls this the only way to look at the
 * desktop UI - tests run under happy-dom, which does not paint - and pins it to
 * port 8791: "If it is busy, find out what is holding it. Never fall back to a
 * different port." A server that quietly picks another port is worse than one
 * that refuses, because the page you then open is not the one you think you are
 * looking at, and the process you were trying to find is still running.
 *
 * This was written after leaving a harness listening for hours and then being
 * confused by it: the collision message was correct and nothing had ever
 * checked that it stays correct.
 *
 * Both halves are needed and neither is enough alone. Without the positive
 * case, "exits non-zero when the port is held" passes just as well against a
 * harness that is broken outright - it exits non-zero either way. Without the
 * negative case, nothing holds the no-fallback rule at all.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const script = path.join(root, "scripts", "renderer-harness.mjs");

const running: { kill(): void }[] = [];
const holders: net.Server[] = [];

afterEach(async () => {
  while (running.length) running.pop()?.kill();
  await Promise.all(
    holders.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))),
  );
});

/** a port nothing else has, held open for as long as the test needs it */
function heldPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      holders.push(server);
      const addr = server.address();
      if (typeof addr === "object" && addr) resolve(addr.port);
      else reject(new Error("no port"));
    });
  });
}

/** a port that was free a moment ago, and is free again now */
async function freePort(): Promise<number> {
  const p = await heldPort();
  const server = holders.pop();
  await new Promise<void>((done) => server?.close(() => done()));
  return p;
}

interface Run {
  code: number | null;
  out: string;
}

/** run the harness on `port`, giving up after `ms` if it is still alive */
function runHarness(port: number, ms: number): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, HARNESS_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    running.push(child);
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    const timer = setTimeout(() => resolve({ code: null, out }), ms);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

describe("the renderer harness", () => {
  it("starts on a free port, so the refusal below is not just a broken script", async () => {
    const res = await runHarness(await freePort(), 2500);
    expect(res.code, `it exited instead of serving:\n${res.out}`).toBeNull();
    expect(res.out, "it started without saying where").toMatch(/127\.0\.0\.1:\d+/);
  }, 15000);

  it("refuses a port something else is holding, rather than moving to another", async () => {
    const port = await heldPort();
    const res = await runHarness(port, 4000);

    expect(res.code, `it kept running on a held port instead of refusing:\n${res.out}`).not.toBeNull();
    expect(res.code, "it refused but reported success").not.toBe(0);
    expect(
      res.out,
      "the harness gave up without naming the port, so nobody can go and find what is holding it",
    ).toContain(String(port));
    expect(
      /already held/i.test(res.out),
      `it failed for some other reason, which would let this pass against a harness that cannot start at all:\n${res.out}`,
    ).toBe(true);
  }, 15000);
});
