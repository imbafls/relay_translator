// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The pages under test - the desktop renderer, the viewer, the hosted home page
 * - link their stylesheets relatively, and happy-dom resolves and fetches them.
 * vitest gives happy-dom `http://localhost:3000` unless told otherwise, and on
 * the machine this is developed on 3000 is another project's dev server. Every
 * renderer run logged ECONNREFUSED for style.css and fonts.css; with that
 * server up, the tests would have loaded its CSS into these pages instead, and
 * any test reading a computed style would have been testing someone else's
 * stylesheet. No test here wants a page to load anything: each one that needs
 * CSS reads the file from disk itself.
 *
 * So `vitest.config.mts` turns resource loading off for happy-dom and points
 * the page at a port nothing serves. This proves both, with a real server
 * standing in for whatever might be listening.
 */

let server: http.Server | null = null;

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

describe("the page a DOM test runs in", () => {
  it("is on no port a person runs a server on", () => {
    expect(location.port, "happy-dom's page is on 3000, another project's dev port").not.toBe("3000");
    expect(location.host).toBe("127.0.0.1:9");
  });

  it("fetches nothing a page links to, even with a server there to answer", async () => {
    const hits: string[] = [];
    server = http.createServer((req, res) => {
      hits.push(String(req.url));
      res.end("");
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`http://127.0.0.1:${port}/`);

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/style.css";
    document.head.appendChild(link);
    const script = document.createElement("script");
    script.src = "/app.js";
    document.head.appendChild(script);
    const frame = document.createElement("iframe");
    frame.src = "/frame.html";
    document.body.appendChild(frame);
    await new Promise((r) => setTimeout(r, 300));

    // the server does answer - a request made here would have been seen
    const direct = await fetch(`http://127.0.0.1:${port}/probe`);
    expect(direct.status).toBe(200);
    expect(hits, "the page fetched what it links to").toEqual(["/probe"]);
  });
});
