// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The viewer page, running for real: the shipped index.html in a DOM, the
 * shipped app.js evaluated in it, and messages pushed through the socket the
 * relay would have opened. This is the page an audience looks at and nothing
 * has ever tested it.
 *
 * Only the WebSocket is stood in for - it is the boundary, and every message
 * below is one the relay genuinely sends.
 */

const publicDir = path.resolve(__dirname, "..", "public");
const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");

interface FakeSocket {
  url: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
  sent: string[];
}

let socket: FakeSocket;
/** every socket a test opened, so their handlers can be detached at the end */
let opened: FakeSocket[] = [];

/** deliver a message the way the relay would */
function push(msg: Record<string, unknown>): void {
  socket.onmessage?.({ data: JSON.stringify(msg) });
}

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no #${id} in the shipped markup`);
  return el;
};

const lineTexts = (): string[] =>
  Array.from(document.querySelectorAll("#lines .row .src .txt")).map((n) => n.textContent ?? "");

beforeEach(() => {
  // the token comes out of the path, so the page has to believe it is there
  window.history.pushState({}, "", "/watch/test-token");

  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  // the shipped markup, minus its own script tags: app.js is evaluated below
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, "");

  const created: FakeSocket[] = [];
  opened = created;
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: ((ev: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    sent: string[] = [];
    constructor(readonly url: string) {
      created.push(this as unknown as FakeSocket);
      // let the page finish wiring its handlers before it is told we are open
      setTimeout(() => this.onopen?.(), 0);
    }
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      this.readyState = 3;
    }
  }
  (window as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;

  window.eval(appJs);
  socket = created[0];
});

afterEach(() => {
  // onopen is scheduled, so without this it fires into a cleared page and
  // reports an error that belongs to the teardown rather than the test
  for (const ws of opened) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
  }
  opened = [];
  document.body.innerHTML = "";
});

describe("connecting", () => {
  it("opens a viewer socket carrying the token from the path", () => {
    expect(socket).toBeTruthy();
    expect(socket.url).toContain("/ws/viewer?token=test-token");
  });
});

describe("captions arriving", () => {
  it("shows a final subtitle", () => {
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    push({ type: "subtitle", id: 1, source: "rush B", final: true });
    expect(lineTexts()).toContain("rush B");
  });

  it("patches the translation onto the same line instead of adding one", () => {
    // the relay sends the source first and the translation second, same id
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    push({ type: "subtitle", id: 1, source: "rush B", final: true });
    const afterSource = document.querySelectorAll("#lines .row").length;

    push({ type: "subtitle", id: 1, source: "rush B", target: "lao B", final: true });

    expect(document.querySelectorAll("#lines .row")).toHaveLength(afterSource);
    expect(document.querySelector("#lines .row .tgt")?.textContent).toBe("lao B");
  });

  it("keeps two speakers on separate lines", () => {
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    push({ type: "subtitle", id: 1, source: "mine", final: true, channel: 0, speaker: "YOU" });
    push({ type: "subtitle", id: 2, source: "theirs", final: true, channel: 1, speaker: "CHAT" });

    expect(lineTexts()).toEqual(["mine", "theirs"]);
    const who = Array.from(document.querySelectorAll("#lines .row .who")).map((n) => n.textContent);
    expect(who).toEqual(["YOU", "CHAT"]);
  });

  it("does not render caption text as markup", () => {
    // transcripts are attacker-influenced in the sense that anyone speaking
    // into the mic chooses them, and this page is served publicly
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    push({ type: "subtitle", id: 1, source: "<img src=x onerror=alert(1)>", final: true });

    expect(document.querySelector("#lines img")).toBeNull();
    expect(lineTexts()[0]).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("the stream ending", () => {
  it("clears the interim line when the relay says it is no longer live", () => {
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    push({ type: "partial", id: 9, source: "half a sen" });
    expect(document.querySelectorAll("#lines .row.interim").length).toBeGreaterThan(0);

    push({ type: "status", live: false, message: "stream ended" });
    expect(document.querySelectorAll("#lines .row.interim")).toHaveLength(0);
  });

  it("says so when another device takes the link", () => {
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    push({ type: "kicked", reason: "another device opened this link" });
    expect($("endedAt").textContent).toMatch(/^ENDED \d{2}:\d{2}$/);
  });
});
