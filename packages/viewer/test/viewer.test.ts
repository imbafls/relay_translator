// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
/** every socket every boot in this test opened; never reassigned, so a
 *  re-boot cannot orphan the previous page's pending onopen */
const opened: FakeSocket[] = [];

function detachAll(): void {
  for (const ws of opened.splice(0)) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
  }
}

/**
 * Every timer armed since the last page ended. A real page lives as long as
 * its tab and never stops its own clock; a page here ends at teardown, and its
 * timers have to end with it - see "tearing a page down" at the bottom.
 */
const armed: unknown[] = [];
for (const name of ["setTimeout", "setInterval"] as const) {
  const real = window[name].bind(window) as (handler: TimerHandler, ms?: number, ...args: unknown[]) => number;
  (window as unknown as Record<string, unknown>)[name] = (handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    const id = real(handler, ms, ...args);
    armed.push(id);
    return id;
  };
}

function disarmAll(): void {
  for (const id of armed.splice(0)) window.clearTimeout(id as number);
}

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

/**
 * Boot the shipped page. `search` selects the surface: "" is the phone
 * viewer, "?obs=1" the OBS overlay, which behaves differently enough that it
 * needs its own coverage - the overlay renders exactly one row and hides the
 * rest, so a bug there is invisible to every phone-viewer assertion.
 */
function boot(search = ""): void {
  // the token comes out of the path, so the page has to believe it is there
  window.history.pushState({}, "", `/watch/test-token${search}`);
  // A fresh page has a bare <body>. Setting innerHTML below does not touch the
  // body's own classes, so without this an overlay booted by an earlier test
  // left `obs` (and `idle`, `light`, ...) on the next page, phone or not.
  document.body.className = "";

  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  // the shipped markup, minus its own script tags: app.js is evaluated below
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, "");

  // Detach anything an EARLIER boot in this same test left behind. Each socket
  // announces itself on a timer, so a re-boot leaves the first page's onopen
  // queued; it then fires into the markup this boot just replaced and reports a
  // null element from inside teardown. It survived locally on timing alone and
  // failed on CI.
  detachAll();
  // and the earlier page's clock, which would otherwise tick into this one
  disarmAll();
  const created: FakeSocket[] = [];
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
      opened.push(this as unknown as FakeSocket);
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
}

/** what afterEach does, named so a test can hold it to its job */
function teardown(): void {
  // onopen is scheduled, so without this it fires into a cleared page and
  // reports an error that belongs to the teardown rather than the test
  detachAll();
  disarmAll();
  document.body.innerHTML = "";
}

beforeEach(() => boot());

afterEach(() => teardown());

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

  it("gives each speaker the colour the relay named, so three can be told apart", () => {
    // the tag used to carry one binary class - YOU against everyone else - so
    // a third speaker was the same colour as the second, and the tag was the
    // only thing distinguishing them
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    push({ type: "subtitle", id: 1, source: "a", final: true, channel: 0, speaker: "YOU", color: "#e0a43a" });
    push({ type: "subtitle", id: 2, source: "b", final: true, channel: 1, speaker: "CHAT", color: "#7fb6d9" });
    push({ type: "subtitle", id: 3, source: "c", final: true, channel: 2, speaker: "COACH", color: "#9ad17f" });

    const colours = Array.from(document.querySelectorAll<HTMLElement>("#lines .row .who")).map((n) => n.style.color);
    expect(colours).toHaveLength(3);
    expect(new Set(colours).size, `two speakers share a colour: ${colours.join(" / ")}`).toBe(3);
  });

  it("falls back to its own colours when the relay names none", () => {
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    push({ type: "subtitle", id: 1, source: "a", final: true, channel: 0, speaker: "YOU" });
    push({ type: "subtitle", id: 2, source: "b", final: true, channel: 1, speaker: "CHAT" });

    const tags = Array.from(document.querySelectorAll<HTMLElement>("#lines .row .who"));
    for (const t of tags) expect(t.style.color).toBe("");
    expect(tags[0].className).toBe("who");
    expect(tags[1].className).toContain("other");
  });

  it("sets the colour as a property, so a value smuggling more CSS cannot bring it along", () => {
    // the relay sanitises, but this page is the thing rendering it and a relay
    // is only as trustworthy as whoever holds its publish token. Assigning to
    // .style.color makes the CSSOM reject the whole value; building a style
    // ATTRIBUTE out of it would apply every declaration in the string.
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    push({
      type: "subtitle",
      id: 1,
      source: "a",
      final: true,
      channel: 0,
      speaker: "YOU",
      color: "#7fb6d9; background: url(javascript:alert(1))",
    });

    const who = document.querySelector<HTMLElement>("#lines .row .who");
    expect(who?.style.background, "the publisher set a property it does not own").toBe("");
    expect(who?.getAttribute("style") || "").not.toContain("background");
  });

  it("falls back to its own class colours when the value is not a hex colour", () => {
    // not a security boundary - .style.color rejects nonsense on its own - but
    // it keeps the fallback coherent: a value that is not a colour must leave
    // the class doing the work, not half-apply something the publisher named
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    push({ type: "subtitle", id: 1, source: "b", final: true, channel: 1, speaker: "CHAT", color: "red" });

    const who = document.querySelector<HTMLElement>("#lines .row .who");
    expect(who?.style.color).toBe("");
    expect(who?.className, "a non-hex colour stole the class fallback").toContain("other");
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

describe("the OBS overlay shows the line being spoken", () => {
  /**
   * The overlay renders exactly one row: everything but the chosen line is
   * display:none. That line used to be picked by markLatest, which only ever
   * considered `.row:not(.interim)` - so an in-progress caption was built,
   * filled and never shown, and the broadcast stayed a whole utterance behind.
   * A viewer put it as "it doesn't put anything in until the whole message is
   * done".
   *
   * On the phone page `.latest` means hero size, so the fix must NOT promote an
   * interim there - that would make every line jump as it was spoken.
   */
  const overlayRow = (): HTMLElement | null =>
    document.querySelector("#lines .row.obs-live");

  it("renders a partial as the live line", () => {
    boot("?obs=1");
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: false });
    push({ type: "partial", id: 1, source: "enemy pushing" });

    const row = overlayRow();
    expect(row, "no row was marked as the overlay line").not.toBeNull();
    expect(row?.classList.contains("interim")).toBe(true);
    expect(row?.querySelector(".src")?.textContent).toContain("enemy pushing");
  });

  it("hands the slot to the final and drops the interim", () => {
    boot("?obs=1");
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: false });
    push({ type: "partial", id: 1, source: "enemy pu" });
    push({ type: "subtitle", id: 1, source: "enemy pushing mid", final: true });

    const row = overlayRow();
    expect(row?.classList.contains("interim"), "the interim outlived its final").toBe(false);
    expect(row?.querySelector(".src")?.textContent).toContain("enemy pushing mid");
    expect(document.querySelectorAll("#lines .row.obs-live")).toHaveLength(1);
  });

  it("keeps exactly one overlay line as captions accumulate", () => {
    boot("?obs=1");
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: false });
    for (let i = 1; i <= 4; i += 1) {
      push({ type: "subtitle", id: i, source: `line ${i}`, final: true });
    }
    push({ type: "partial", id: 5, source: "still talking" });

    expect(document.querySelectorAll("#lines .row.obs-live")).toHaveLength(1);
    expect(overlayRow()?.querySelector(".src")?.textContent).toContain("still talking");
  });

  it("does not promote an interim on the phone page, where it would resize", () => {
    boot();
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: false });
    push({ type: "subtitle", id: 1, source: "settled line", final: true });
    push({ type: "partial", id: 2, source: "being said" });

    const latest = document.querySelector("#lines .row.latest");
    expect(latest?.classList.contains("interim"), "the hero row became an interim").toBe(false);
    expect(latest?.querySelector(".src")?.textContent).toContain("settled line");
  });
});

describe("the harness itself", () => {
  /**
   * A test that re-boots the page (the overlay cases do) used to orphan the
   * first page's socket: each one announces itself on a timer, so the queued
   * onopen fired into markup that had already been replaced and threw a null
   * element from inside teardown. It passed locally on timing and failed on CI
   * four times in one run - once per re-booting test.
   */
  it("leaves no live handler from a page it replaced", async () => {
    const first = socket;
    boot("?obs=1");
    expect(socket, "the re-boot did not open its own socket").not.toBe(first);

    expect(first.onopen, "the replaced page can still be called back").toBeNull();
    expect(first.onmessage).toBeNull();

    // and letting every queued timer run must not throw into the new page
    await new Promise((r) => setTimeout(r, 5));
    expect(document.getElementById("lines")).not.toBeNull();
  });
});

describe("a kicked overlay does not paint onto the broadcast", () => {
  /**
   * Audit finding 10. The `kicked` handler called showScreen("ended") with no
   * `?obs=1` guard, and the OBS rules hide only the HUD and the non-latest
   * rows - there was no `body.obs #ended`. So on the DEFAULT link mode, every
   * press of START rotated the token, kicked the overlay, and composited
   * "THIS LINK HAS ENDED" plus a solid TRY AGAIN button straight onto the live
   * stream, where it stayed until someone refreshed the browser source.
   *
   * A phone viewer wants that panel. An overlay wants to disappear.
   */
  const shown = (id: string): boolean => !(document.getElementById(id) as HTMLElement).hidden;
  const kick = (): void => {
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    push({ type: "subtitle", id: 1, source: "on air", final: true });
    push({ type: "kicked", reason: "link was rotated" });
  };

  it("shows nothing at all in the overlay", () => {
    boot("?obs=1");
    kick();
    expect(shown("ended"), "THIS LINK HAS ENDED was composited onto the broadcast").toBe(false);
    expect(shown("live"), "the stale captions stayed on the broadcast").toBe(false);
    expect(shown("display")).toBe(false);
  });

  it("still tells a phone viewer what happened", () => {
    boot();
    kick();
    expect(shown("ended"), "a phone viewer was left staring at a dead page").toBe(true);
    expect(shown("live")).toBe(false);
  });

});

describe("a viewer socket that drops and comes back", () => {
  /**
   * Audit finding 9. `connect()` had no re-entrancy guard and did not cancel
   * the armed 2 s retry, and every handler acted on the module-level `ws`
   * rather than on the socket that raised the event.
   *
   * A phone's socket drops and arms a retry. The user unlocks the phone inside
   * that window, `visibilitychange` calls connect() (socket B), then the timer
   * fires and connect() runs again (socket C, `ws = C`). The relay allows one
   * viewer per token, so it kicks B - and B's still-bound handler sets
   * `closedByKick`, shows ENDED and calls `ws.close()`, which is now **C**, the
   * healthy socket. A live session shows THIS LINK HAS ENDED and stops
   * receiving captions until the page is reloaded.
   *
   * cc824dd applied exactly this fix to relayClient and uplinkClient.
   */
  const live = (): number => opened.filter((s) => s.readyState === 1).length;
  const drop = (s: (typeof opened)[number]): void => {
    s.readyState = 3;
    s.onclose?.({ code: 1006 });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    boot();
    vi.advanceTimersByTime(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not open a second socket when the retry and a wake-up race", () => {
    const a = opened[0];
    drop(a);
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(3000);

    expect(live(), "two sockets were left open on one token").toBe(1);
    // and the armed retry must not have fired at all. Counting only LIVE
    // sockets hides this: connect() closes the previous one, so a third socket
    // still leaves exactly one alive while churning through a needless kick.
    expect(opened.length, "the wake-up connected and then the armed retry connected again").toBe(2);
  });

  it("ignores a kick aimed at a socket that is already replaced", () => {
    const a = opened[0];
    drop(a);
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(3000);

    // the relay kicks the OLD socket, because the new one took the token
    a.onmessage?.({ data: JSON.stringify({ type: "kicked", reason: "another device opened this link" }) });

    const ended = document.getElementById("ended") as HTMLElement;
    expect(ended.hidden, "a dead socket's kick put ENDED over a live session").toBe(true);
    expect(live(), "a dead socket's kick closed the healthy one").toBe(1);
  });

  it("still ends the session when the live socket is the one kicked", () => {
    const a = opened[0];
    a.onmessage?.({ data: JSON.stringify({ type: "kicked", reason: "link was rotated" }) });
    expect((document.getElementById("ended") as HTMLElement).hidden).toBe(false);
  });

  it("does not retry for ever against a token that was rotated away", () => {
    const a = opened[0];
    a.onmessage?.({ data: JSON.stringify({ type: "kicked", reason: "link was rotated" }) });
    drop(a);
    // waking the phone must not restart a reconnect loop against a dead token
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(10000);

    expect(opened.length, "a kicked viewer reconnected to a token it cannot use").toBe(1);
  });
});

describe("a link that is no longer valid", () => {
  /**
   * Found while verifying finding 10, and written down in docs/OPEN-WORK.md as
   * its own item: a viewer that is KICKED gets the ENDED panel, but a viewer
   * that *loads* an already-dead link does not. The socket is refused, the page
   * shows RECONNECTING, and it retries for ever - because a refusal and a
   * dropped train tunnel look identical to it.
   *
   * The relay closes with 4401 for a token it does not know. That is a fact,
   * not a network condition, and retrying cannot change it.
   */
  const shown = (id: string): boolean => !(document.getElementById(id) as HTMLElement).hidden;

  beforeEach(() => {
    vi.useFakeTimers();
    boot();
    vi.advanceTimersByTime(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says the link is dead instead of reconnecting for ever", () => {
    const a = opened[0];
    a.readyState = 3;
    a.onclose?.({ code: 4401 });
    vi.advanceTimersByTime(10000);

    expect(opened.length, "it kept retrying a token the relay has refused").toBe(1);
    expect(shown("ended"), "the viewer was left staring at RECONNECTING").toBe(true);
  });

  /**
   * The hosted relay closes viewers with 4410 when the owner rotates the link,
   * which kills every link handed out before that moment. It sends no `kicked`
   * message first - the self-hosted relay does, which is why this never showed
   * up there - so without knowing the code the page fell through to
   * RECONNECTING, retried two seconds later with a token that is now dead, and
   * only then got the 4401 that says so. A flash of the wrong state on the way
   * to the right one, on the two relays behaving differently for one action.
   */
  it("treats a rotated link as finished, not as a connection to retry", () => {
    const a = opened[0];
    a.readyState = 3;
    a.onclose?.({ code: 4410 });
    vi.advanceTimersByTime(10000);

    expect(opened.length, "it retried a link the owner has deliberately rotated away").toBe(1);
    expect(shown("ended"), "a rotated link left the viewer on RECONNECTING").toBe(true);
  });

  it("still reconnects when the connection merely dropped", () => {
    const a = opened[0];
    a.readyState = 3;
    a.onclose?.({ code: 1006 });
    vi.advanceTimersByTime(3000);

    expect(opened.length, "a normal drop stopped reconnecting").toBeGreaterThan(1);
    expect(shown("ended")).toBe(false);
  });

  it("shows nothing at all in the overlay, which must not paint onto a broadcast", () => {
    boot("?obs=1");
    vi.advanceTimersByTime(1);
    const a = opened[opened.length - 1];
    a.readyState = 3;
    a.onclose?.({ code: 4401 });
    vi.advanceTimersByTime(10000);

    expect(shown("ended")).toBe(false);
    expect(shown("live")).toBe(false);
  });
});

describe("an interim that never resolves", () => {
  /**
   * Audit finding 35(a). Two paths stranded a blinking half-caption.
   *
   * Only the `status` branch cleared interims when the stream was not live;
   * the `hello` branch did not. So a viewer disconnected while
   * `status live:false` went out reconnects onto `hello live:false` and keeps
   * a half-finished line under an OFF AIR badge - and `trimRows` excludes
   * `.interim`, so it never ages out.
   *
   * And an empty final - Deepgram saying "that utterance came to nothing" -
   * now reaches the page, where it has to remove the interim without leaving
   * an empty row in its place.
   */
  const interims = (): number => document.querySelectorAll("#lines .row.interim").length;
  const rows = (): number => document.querySelectorAll("#lines .row:not(.interim)").length;

  it("clears a half-caption when a reconnect lands on a dead stream", () => {
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    push({ type: "partial", id: 1, source: "enemy mid", channel: 0 });
    expect(interims(), "no interim was created, so this proves nothing").toBe(1);

    // the reconnect: hello, not status, and the stream is no longer live
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: false, translates: true });
    expect(interims(), "a blinking half-caption survived under an OFF AIR badge").toBe(0);
  });

  it("keeps the interim while the stream is still live", () => {
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    push({ type: "partial", id: 1, source: "enemy mid", channel: 0 });
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    expect(interims()).toBe(1);
  });

  it("removes the interim on an empty final without leaving an empty row", () => {
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    push({ type: "partial", id: 1, source: "enemy m", channel: 0 });
    push({ type: "subtitle", id: 1, source: "", final: true, channel: 0 });

    expect(interims(), "the reserved interim was left behind").toBe(0);
    expect(rows(), "an empty caption was rendered").toBe(0);
  });

  it("still renders a final that has something in it", () => {
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    push({ type: "partial", id: 1, source: "enemy m", channel: 0 });
    push({ type: "subtitle", id: 1, source: "enemy mid", final: true, channel: 0 });

    expect(interims()).toBe(0);
    expect(rows()).toBe(1);
    expect(lineTexts()).toEqual(["enemy mid"]);
  });
});

describe("the session clock on a viewer whose clock is wrong", () => {
  /**
   * Audit finding 36. `since` is the STREAMER's `Date.now()`, forwarded
   * verbatim, and the HUD computed `Date.now() - since` on the VIEWER's clock.
   * Any skew between the two machines was displayed as duration error - and
   * negative skew (a phone whose clock is behind) clamps at
   * `Math.max(0, ...)`, so the clock sat frozen at 00:00:00 for as long as the
   * skew lasted. Phones drift; a few minutes is ordinary.
   *
   * Elapsed milliseconds do not care whose clock they came from.
   */
  const clock = (): string => (document.getElementById("hudClock") as HTMLElement).textContent || "";

  it("reads the elapsed time even when the two clocks disagree", () => {
    // the streamer's clock is five minutes AHEAD of this viewer's
    const skewMs = 5 * 60_000;
    push({
      type: "hello",
      languages: { source: "en", target: "vi" },
      live: true,
      translates: true,
      since: Date.now() + skewMs - 90_000,
      elapsedMs: 90_000,
    });

    expect(clock(), "the streamer's epoch was subtracted from the viewer's").toBe("00:01:30");
  });

  it("does not freeze at zero when the viewer's clock is behind", () => {
    push({
      type: "hello",
      languages: { source: "en", target: "vi" },
      live: true,
      translates: true,
      // `since` in this viewer's future, which is what froze it
      since: Date.now() + 10 * 60_000,
      elapsedMs: 42_000,
    });

    expect(clock(), "a viewer clock behind the streamer's froze the session clock").toBe("00:00:42");
  });

  it("still works against a relay that sends only `since`", () => {
    push({
      type: "hello",
      languages: { source: "en", target: "vi" },
      live: true,
      translates: true,
      since: Date.now() - 65_000,
    });

    expect(clock()).toBe("00:01:05");
  });

  it("shows nothing running when the stream is not live", () => {
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: false, translates: true });
    expect(clock()).toBe("00:00:00");
  });
});

/**
 * The relay says WHY it kicked a viewer - `{type:"kicked", reason}` - and the
 * page threw the reason away and printed one hardcoded sentence: "The session
 * was stopped, or a new link was made."
 *
 * For the reason that actually happens most, that sentence is false twice over.
 * The app's own relay allows exactly one viewer per link, so a second phone -
 * or a phone and an OBS overlay - kicks the first with "another device opened
 * this link". Nothing was stopped and no new link was made. The person reading
 * is told to go and ask for a link they already have, and the one thing that
 * would help them - that someone else has it open - is the thing they are not
 * told. It is the most confusing behaviour in a home setup, reported as two
 * causes that are both wrong.
 *
 * TRY AGAIN differs too, and that is the point of separating them: when another
 * device took the link, trying again works and takes it back. When the link was
 * rotated, trying again cannot help and the reader needs a new one.
 */
describe("a viewer is told why they were disconnected", () => {
  const title = (): string => ($("endedTitle") as HTMLElement).textContent || "";
  const text = (): string => ($("endedText") as HTMLElement).textContent || "";
  const live = (): void => {
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
  };

  it("says another device has it, rather than blaming a stopped session", () => {
    live();
    push({ type: "kicked", reason: "another device opened this link" });

    expect(title(), "the reader is told the session stopped when it did not").not.toMatch(/session was stopped/i);
    expect(title() + text(), "nothing on screen mentions the other device").toMatch(/another device|someone else|one device/i);
    // the label sits directly above the title; leaving it on ENDED prints a
    // contradiction - the link has not ended, someone else is on it
    expect(
      ($("endedLabel") as HTMLElement).textContent,
      "the panel still says the link has ended, above a line saying it has not",
    ).not.toMatch(/HAS ENDED/i);
  });

  it("tells them trying again takes it back, because it does", () => {
    live();
    push({ type: "kicked", reason: "another device opened this link" });

    expect(text(), "no hint that TRY AGAIN is the fix for this one").toMatch(/again/i);
  });

  it("still says a new link was made when that is what happened", () => {
    live();
    push({ type: "kicked", reason: "link was rotated" });

    expect(title() + text(), "a rotated link is reported as something else").toMatch(/new link|rotated/i);
    expect(($("endedLabel") as HTMLElement).textContent, "a rotated link no longer reads as ended").toMatch(/HAS ENDED/i);
    expect(title(), "a rotated link now blames another device").not.toMatch(/another device/i);
  });

  it("falls back to something true when it is given no reason at all", () => {
    // the hosted relay closes with a code and no `kicked` frame, and an older
    // relay may send none either - the panel still has to say something, and it
    // must not invent a cause
    live();
    push({ type: "kicked" });

    expect(title(), "no reason left the panel blank").toBeTruthy();
    expect(title(), "a missing reason was reported as a specific one").not.toMatch(/another device/i);
  });
});

describe("the overlay does not leave the last thing said on the broadcast", () => {
  /**
   * The overlay renders exactly one row, and it used to render it for ever. A
   * streamer who stopped talking kept their last sentence burned into the
   * broadcast until they said something else - which is the state a scene sits
   * in during every quiet stretch of a game.
   *
   * So the live line fades once nothing has arrived for `holdSeconds`, and any
   * caption - interim or final - brings it straight back. The phone page is
   * deliberately exempt: its stack is a transcript somebody may be reading
   * back through, and hiding it would be a bug rather than a fix.
   */
  const HOLD_MS = 10_000;
  const faded = (): boolean => document.body.classList.contains("idle");

  /** boot with a live stream and the fake clock already running */
  function overlay(search = "?obs=1", style?: Record<string, unknown>): void {
    vi.useFakeTimers();
    if (style) localStorage.setItem("relay-style-v2", JSON.stringify(style));
    boot(search);
    vi.advanceTimersByTime(1);
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: false });
  }

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it("fades the live line once the hold passes with nothing said", () => {
    overlay();
    push({ type: "subtitle", id: 1, source: "spike is down", final: true });

    expect(faded(), "faded while the line was still fresh").toBe(false);
    vi.advanceTimersByTime(HOLD_MS + 100);
    expect(faded(), "the last thing said is still on the broadcast").toBe(true);
  });

  it("keeps it up while someone is still speaking", () => {
    overlay();
    push({ type: "subtitle", id: 1, source: "spike is down", final: true });

    // a partial lands most of the way through the hold, as a pause between
    // sentences does - the clock has to start again, not run out mid-word
    vi.advanceTimersByTime(HOLD_MS - 500);
    push({ type: "partial", id: 2, source: "rotating" });
    vi.advanceTimersByTime(HOLD_MS - 500);

    expect(faded(), "a caption in progress was faded out from under the speaker").toBe(false);
  });

  it("brings it straight back when the next caption lands", () => {
    overlay();
    push({ type: "subtitle", id: 1, source: "spike is down", final: true });
    vi.advanceTimersByTime(HOLD_MS + 100);
    expect(faded()).toBe(true);

    push({ type: "partial", id: 2, source: "he is one shot" });
    expect(faded(), "the overlay stayed hidden while somebody was talking into it").toBe(false);
  });

  it("never fades when the hold is set to zero", () => {
    // somebody who wants a permanent last-line readout can still have one
    overlay("?obs=1", { holdSeconds: 0 });
    push({ type: "subtitle", id: 1, source: "spike is down", final: true });
    vi.advanceTimersByTime(HOLD_MS * 6);

    expect(faded(), "zero was treated as a hold rather than as off").toBe(false);
  });

  it("honours a hold the viewer shortened", () => {
    overlay("?obs=1", { holdSeconds: 3 });
    push({ type: "subtitle", id: 1, source: "spike is down", final: true });

    vi.advanceTimersByTime(2_000);
    expect(faded(), "faded before the viewer's own hold elapsed").toBe(false);
    vi.advanceTimersByTime(1_500);
    expect(faded(), "the viewer's shorter hold was ignored").toBe(true);
  });

  it("never fades the phone page, where the stack is a transcript", () => {
    overlay("");
    push({ type: "subtitle", id: 1, source: "spike is down", final: true });
    vi.advanceTimersByTime(HOLD_MS * 6);

    expect(faded(), "the phone viewer hid a transcript somebody may be reading").toBe(false);
  });
});

describe("whose captions these are", () => {
  const brandBar = (): HTMLElement => $("brandBar");

  it("names the stream when the hello carries one", () => {
    boot();
    push({
      type: "hello",
      languages: { source: "en", target: "vi" },
      live: true,
      translates: true,
      brandName: "Omer's stream",
      brandColor: "#e0a43a",
    });

    expect($("brandName").textContent).toBe("Omer's stream");
    expect(brandBar().hidden).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--brand")).toBe("#e0a43a");
  });

  it("shows nothing at all when the stream is unbranded", () => {
    boot();
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    expect(brandBar().hidden, "an unbranded stream reserved space for a name it does not have").toBe(true);
  });

  it("renders the name as text, never as markup", () => {
    // the publisher is only as trustworthy as its token, and this page is
    // served publicly with no CSP
    boot();
    push({
      type: "hello",
      languages: { source: "en", target: "vi" },
      live: true,
      translates: true,
      brandName: "<img src=x onerror=alert(1)>",
    });

    expect(document.querySelector("#brandBar img")).toBeNull();
    expect($("brandName").textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("leaves the reader's own accent alone", () => {
    // --accent belongs to the theme the reader picked; themeMatches() compares
    // it, and RESET reverts it. A brand painted there would be wiped.
    boot();
    const before = document.documentElement.style.getPropertyValue("--accent");
    push({
      type: "hello",
      languages: { source: "en", target: "vi" },
      live: true,
      translates: true,
      brandColor: "#ff0000",
    });
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe(before);
  });

  it("stays off the broadcast overlay", () => {
    // the streamer already brands that scene, and an element outside
    // .row.obs-live never fades - it would sit there through every quiet stretch
    boot("?obs=1");
    push({
      type: "hello",
      languages: { source: "en", target: "vi" },
      live: true,
      translates: true,
      brandName: "Omer's stream",
    });
    expect(brandBar().hidden, "the brand reached the broadcast overlay").toBe(true);
  });

  it("clears a colour the streamer just removed, instead of leaving it painted", () => {
    // an absent or invalid colour on a later hello is how a streamer clears
    // one they set earlier - apps/hosted-relay/src/room.ts:306 documents the
    // same contract for the room state this hello is built from, and stores
    // unconditionally so a genuinely cleared colour arrives as undefined.
    // This also has to reject a colour smuggling more than a hex value. Both
    // relay paths sanitise it now - publisherHello() and the uplink handler in
    // packages/relay/src/server.ts, and safeColor in the hosted Worker - but
    // this page is served with no CSP and cannot know which relay build it is
    // attached to, so it validates for itself rather than inheriting a check
    // somebody else is supposed to have made.
    boot();
    push({
      type: "hello",
      languages: { source: "en", target: "vi" },
      live: true,
      translates: true,
      brandName: "Omer's stream",
      brandColor: "#e0a43a",
    });
    expect(document.documentElement.style.getPropertyValue("--brand")).toBe("#e0a43a");

    push({
      type: "hello",
      languages: { source: "en", target: "vi" },
      live: true,
      translates: true,
      brandName: "Omer's stream",
      brandColor: "red; background: url(javascript:alert(1))",
    });
    expect(
      document.documentElement.style.getPropertyValue("--brand"),
      "a cleared or invalid colour stayed painted from the hello before it",
    ).toBe("");
  });

  /**
   * check-renderer-ids.mjs makes a missing id impossible within one deploy,
   * but a browser caches the page and the script separately: an index.html
   * held from before a Worker deploy, against a fresh app.js, has no
   * #brandBar. The dereference happens INSIDE `case "hello"`, so a throw
   * there skips langsLabel, applyLive and everything after it, and the page
   * sits on CONNECTING with nothing on screen saying why - a skew turned into
   * a dead page. Two elements, two guards, because either can be the one that
   * is missing.
   */
  for (const gone of ["brandBar", "brandName"]) {
    it(`still reads the rest of the hello when the markup has no #${gone}`, () => {
      boot();
      $(gone).remove();

      push({
        type: "hello",
        languages: { source: "en", target: "vi" },
        live: true,
        translates: true,
        brandName: "Omer's stream",
      });

      expect(
        $("hudLangs").textContent,
        `the hello handler died on the missing #${gone} before it reached the language pair`,
      ).toBe("EN → VI");
      expect($("hudState").dataset.state, "and before it reported the stream live").toBe("on");
    });
  }
});

/**
 * Audit finding 12, the half that carrying the counter did not close.
 *
 * `private segId = 0` is per session, so ids restart whenever a new one is
 * built. The audit offered two fixes and the repo took the first: `buildSession`
 * in packages/relay/src/server.ts seeds the replacement from the old session's
 * `lastSegId`, which covers a rebuild inside one running relay - a settings
 * change, say. It cannot cover a relay that has itself restarted, and that is
 * the ordinary case: the streamer closes the app, or the embedded relay comes
 * back up, and `publisher` is gone so the carry-over is 0. Ids start again at 1
 * while a viewer is still holding rows 1..N from before.
 *
 * The audit's own words for what happens next: "showSubtitle finds the surviving
 * row 1 and rewrites it in place, so the new caption appears at the top of the
 * stage with the old line's timestamp and the replaced line is lost; showPartial
 * drops every interim for ids 1-5, so live typing stops until segId passes 5."
 * Both are asserted below.
 *
 * The fix is the audit's second option - "send a session epoch in hello and have
 * viewers clear rows when it changes" - except that no new field is needed,
 * which matters because this hop serves apps at every shipped version. `since`
 * is already that epoch and already on the wire: `stamp()` in server.ts mints it
 * once when a session goes live and clears it when the stream stops, and the
 * publisher's own hello carries none, so a rebuild that keeps the relay running
 * keeps the same value. It changes on exactly the boundary that restarts ids.
 *
 * The three tests that pass either way are the ones that matter most for the
 * fix not overreaching: a viewer reconnecting mid-stream, a hello carrying no
 * `since` at all, and a stream that merely stops must each keep the transcript.
 */
describe("a stream that restarts while somebody is watching", () => {
  const FIRST = 1_788_000_000_000;
  const SECOND = FIRST + 600_000;

  /**
   * A live hello from the numbering domain `epoch`. `since` is deliberately
   * held constant across all of them: it is the session clock, not the
   * identity, and pinning it here keeps every assertion below about the one
   * field that decides whether the ids restarted.
   */
  const live = (epoch?: number): Record<string, unknown> => ({
    type: "hello",
    languages: { source: "en", target: "vi" },
    live: true,
    translates: true,
    since: FIRST,
    ...(epoch === undefined ? {} : { epoch }),
  });

  const interims = (): number => document.querySelectorAll("#lines .row.interim").length;

  it("starts the new session's transcript clean instead of painting over the old one", () => {
    boot();
    push(live(FIRST));
    push({ type: "subtitle", id: 1, source: "rush B", final: true });
    push({ type: "subtitle", id: 2, source: "they pushed mid", final: true });

    // the app restarts: a new session, numbering from the beginning again
    push(live(SECOND));
    push({ type: "subtitle", id: 1, source: "one down", final: true });

    expect(
      lineTexts(),
      "the new caption was written into the old row 1 and the line it replaced is gone",
    ).toEqual(["one down"]);
  });

  it("puts the new session's first caption below nothing, not above an older line", () => {
    boot();
    push(live(FIRST));
    push({ type: "subtitle", id: 1, source: "rush B", final: true });
    push({ type: "subtitle", id: 2, source: "they pushed mid", final: true });
    push(live(SECOND));
    push({ type: "subtitle", id: 1, source: "one down", final: true });

    expect(
      lineTexts()[lineTexts().length - 1],
      "the newest caption is not the last line on screen - it landed where the old row 1 sat",
    ).toBe("one down");
  });

  it("lets the new session's live typing through again", () => {
    boot();
    push(live(FIRST));
    push({ type: "subtitle", id: 1, source: "rush B", final: true });

    push(live(SECOND));
    push({ type: "partial", id: 1, source: "one d" });

    expect(
      interims(),
      "live typing stayed dead, because showPartial found the old session still holding that id",
    ).toBe(1);
  });

  it("clears on a status that reports a new session, not only on a hello", () => {
    boot();
    push(live(FIRST));
    push({ type: "subtitle", id: 1, source: "rush B", final: true });
    // two rows, not one: with a single row on screen the overwrite and the
    // clear leave the stage looking identical, and this test passed against
    // the unfixed page for that reason alone
    push({ type: "subtitle", id: 2, source: "they pushed mid", final: true });

    push({ type: "status", live: true, since: SECOND, epoch: SECOND });
    push({ type: "subtitle", id: 1, source: "one down", final: true });

    expect(lineTexts(), "a restart announced by status overwrote the old row").toEqual(["one down"]);
  });

  it("keeps the transcript when the same session greets it again", () => {
    boot();
    push(live(FIRST));
    push({ type: "subtitle", id: 1, source: "rush B", final: true });

    // a viewer whose own socket dropped and came back mid-stream
    push(live(FIRST));

    expect(lineTexts(), "a reconnect inside one session threw the transcript away").toEqual([
      "rush B",
    ]);
  });

  it("keeps the transcript when a hello carries no numbering domain at all", () => {
    boot();
    push(live(FIRST));
    push({ type: "subtitle", id: 1, source: "rush B", final: true });

    push(live());

    expect(lineTexts(), "an absent epoch was read as a new session").toEqual(["rush B"]);
  });

  /**
   * The case that decides the design, and the reason `since` cannot be the
   * epoch however convenient it looks. An STT socket blip - a quota, an idle
   * close, a wifi hiccup, the whole reason the reopen ladder exists - makes
   * `session.ts` send `status live:false` and then `status live:true` from
   * WITHIN one session. `stamp()` clears `liveSince` on the first and mints a
   * fresh one on the second, while `segId` is never touched: the numbering
   * carries straight on. Keying the clear on `since` would throw away a live
   * transcript every time the speech engine reconnected, which is worse than
   * the overwrite this whole card is about.
   */
  it("keeps the transcript when the speech pipeline drops and comes back", () => {
    boot();
    push(live(FIRST));
    push({ type: "subtitle", id: 1, source: "rush B", final: true });

    push({ type: "status", live: false, message: "speech pipeline lost" });
    // the session clock jumps here and the numbering domain does not, which is
    // exactly the pair stamp() produces on a reopen: liveSince is cleared by the
    // not-live status and re-minted by this one, while segId is never touched
    push({ type: "status", live: true, since: SECOND, epoch: FIRST });
    push({ type: "subtitle", id: 2, source: "they pushed mid", final: true });

    expect(
      lineTexts(),
      "a reconnect inside one session wiped a transcript whose numbering never restarted",
    ).toEqual(["rush B", "they pushed mid"]);
  });

  it("keeps the transcript when the stream merely stops", () => {
    boot();
    push(live(FIRST));
    push({ type: "subtitle", id: 1, source: "rush B", final: true });

    // a stop clears `since`, and that must not read as a restart - what was
    // said stays on screen under an OFF AIR badge, as it always has
    push({ type: "status", live: false, message: "stream ended" });

    expect(lineTexts(), "stopping the stream wiped what had been said").toEqual(["rush B"]);
  });
});

/**
 * The Light theme's accent used to be `#b8801f`, which measures 2.95:1 on that
 * theme's background - under WCAG AA, and under even the large-text floor. It
 * colours the tag saying who is speaking now, at 10.5px, on the theme most
 * likely to be picked for reading in daylight.
 *
 * Correcting the preset only helps people who have not chosen Light yet. The
 * reader already squinting at it has the old value saved on their own device
 * and nothing would ever replace it, so `loadStyle` lifts exactly that value on
 * exactly that theme - and leaves a colour they picked themselves alone.
 */
describe("a reader who chose the Light theme before its accent was legible", () => {
  const saved = (style: Record<string, unknown>): void => {
    localStorage.setItem("relay-style-v2", JSON.stringify(style));
  };
  const accent = (): string =>
    document.documentElement.style.getPropertyValue("--accent").trim().toLowerCase();

  afterEach(() => localStorage.clear());

  it("is moved off the accent that could not be read", () => {
    saved({ theme: "light", fg: "#131313", accent: "#b8801f", bg: "#f0eee9" });
    boot();

    expect(accent(), "the unreadable accent was left on a device that already had it").not.toBe(
      "#b8801f",
    );
  });

  it("keeps an accent they chose for themselves", () => {
    saved({ theme: "light", fg: "#131313", accent: "#2f6f3f", bg: "#f0eee9" });
    boot();

    expect(accent(), "a colour the reader picked was overwritten").toBe("#2f6f3f");
  });

  it("leaves the dark theme's accent alone", () => {
    saved({ theme: "dark", fg: "#efeae0", accent: "#e0a43a", bg: "#131313" });
    boot();

    expect(accent(), "the dark theme's accent was changed by a light-theme migration").toBe(
      "#e0a43a",
    );
  });
});

/**
 * A caption page whose whole job is to show one language beside another, with
 * nothing saying which is which.
 *
 * The page is `<html lang="en">` and the translation went in as bare text, so
 * assistive technology announced Vietnamese, Japanese or Russian with an
 * English voice and English pronunciation rules. That is WCAG 3.1.2 - Language
 * of Parts - and it lands hardest here of anywhere in the product, because the
 * translated line is the reason somebody opened the link.
 *
 * The codes were already on the wire: `langsLabel` has always read
 * `msg.languages` to write "EN → VI" into the HUD. Nothing had to be added to
 * the protocol - only applied to the text.
 */
describe("which language a line is in", () => {
  it("marks the source and the translation separately", () => {
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    push({ type: "subtitle", id: 1, source: "rush B", target: "lao B", final: true });

    expect(document.querySelector("#lines .row .src")?.getAttribute("lang")).toBe("en");
    expect(document.querySelector("#lines .row .tgt")?.getAttribute("lang")).toBe("vi");
  });

  it("marks a translation that arrives after its line", () => {
    // the relay sends the source first and the translation second, same id -
    // the row is patched in place, and the patch has to carry the language too
    push({ type: "hello", languages: { source: "en", target: "ja" }, live: true, translates: true });
    push({ type: "subtitle", id: 1, source: "rush B", final: true });
    push({ type: "subtitle", id: 1, source: "rush B", target: "ラッシュB", final: true });

    expect(document.querySelector("#lines .row .tgt")?.getAttribute("lang")).toBe("ja");
  });

  it("does not claim a language it was never told", () => {
    // a relay that sends no languages must not have one invented for it
    push({ type: "hello", live: true, translates: false });
    push({ type: "subtitle", id: 1, source: "rush B", final: true });

    expect(document.querySelector("#lines .row .src")?.hasAttribute("lang")).toBe(false);
  });

  it("follows the languages changing mid-session", () => {
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    push({ type: "subtitle", id: 1, source: "one", target: "mot", final: true });
    push({ type: "hello", languages: { source: "en", target: "es" }, live: true, translates: true });
    push({ type: "subtitle", id: 2, source: "two", target: "dos", final: true });

    const tgts = Array.from(document.querySelectorAll("#lines .row .tgt"));
    expect(tgts[tgts.length - 1]?.getAttribute("lang")).toBe("es");
  });
});

/**
 * A relay that stopped answering.
 *
 * `6fcfaaf` gave the uplink client a heartbeat timeout, and `4706a54` wrote
 * down that the publisher client does not need one because it only ever
 * reaches 127.0.0.1. This is the third socket, and it is the one that actually
 * lives on a phone: mobile data, carrier NAT, a screen that locks. `server.ts`
 * says why that matters, on its own side of the same problem - a TCP
 * connection whose peer vanished without a FIN stays OPEN on this side
 * indefinitely.
 *
 * What made it invisible here is that both recovery paths are spelled in terms
 * of a socket that knows it is shut. The 2 s retry is armed by `onclose`,
 * which never fires for a half-open socket, and the `visibilitychange` handler
 * reconnects only when `readyState > OPEN` - so unlocking the phone skipped it
 * too. The reader is left on the last caption that arrived, under a HUD saying
 * nothing is wrong, for as long as the OS keeps the socket.
 *
 * `ViewerToServer` has been `ping | sync` all along and both relays answer a
 * ping. The page simply never asked.
 */
describe("a relay that stops answering", () => {
  const PING = JSON.stringify({ type: "ping" });
  const pingsOn = (s: (typeof opened)[number]): number => s.sent.filter((m) => m === PING).length;

  beforeEach(() => {
    vi.useFakeTimers();
    boot();
    vi.advanceTimersByTime(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks the relay whether it is still there", () => {
    const s = opened[0];
    vi.advanceTimersByTime(25_000);

    expect(
      pingsOn(s),
      "the page never asks the relay anything, so a relay that died and a relay with nothing to say are the same thing to it",
    ).toBeGreaterThan(0);
  });

  it("gives up on one that answers nothing, so the reconnect it already has can run", () => {
    const s = opened[0];
    vi.advanceTimersByTime(120_000);

    expect(
      s.readyState,
      "the socket is still open after two minutes of a relay saying nothing back. The retry is armed by onclose " +
        "and a half-open socket never fires it, so the phone keeps showing the last caption it got - and the " +
        "wake-up path checks readyState > OPEN, so unlocking it does not help either.",
    ).toBe(3);
  });

  /**
   * What giving up has to mean in a real browser.
   *
   * The test above only asks whether close() was called, through a fake that
   * jumps straight to CLOSED. A real one does not: close() moves the socket to
   * CLOSING and onclose waits for the peer's Close frame - which a peer that
   * has stopped answering pings will never send - or for the closing-handshake
   * timer, 60 s in Chromium and 20 s in Firefox. Measured against a silent
   * peer in Chromium by the discovery pass: the close event arrived at 60 s.
   * Every recovery the page has - RECONNECTING, the retry - hangs off that
   * event, so the reader sat under ON AIR for a minute after the page itself
   * had decided the relay was gone.
   */
  it("reconnects when it gives up, without waiting for a close the dead peer will not finish", () => {
    const s = opened[0];
    // Chromium's close() for a peer that never answers: CLOSING, and no onclose
    s.close = () => {
      s.readyState = 2;
    };

    vi.advanceTimersByTime(40_500);
    expect(
      (document.getElementById("hudText") as HTMLElement).textContent,
      "the page has decided the relay is gone and still tells the reader nothing is wrong",
    ).toBe("RECONNECTING");

    vi.advanceTimersByTime(3_000);
    expect(
      opened.length,
      "no second connection was tried: the retry hangs off an onclose that a real browser holds back for a minute",
    ).toBe(2);
  });

  // The socket given up on is let go of, so its close - whenever the browser
  // finally delivers it - arms nothing. Were it still current, a 4408 landing
  // inside the 2 s window would arm a second retry of its own, and the first
  // one to fire would then tear down the healthy socket the other had opened.
  it("lets the socket it gave up on arm nothing when its close finally arrives", () => {
    const s = opened[0];
    s.close = () => {
      s.readyState = 2;
    };

    vi.advanceTimersByTime(40_500);
    s.onclose?.({ code: 4408 });
    vi.advanceTimersByTime(3_000);

    expect(opened.length, "one give-up opened more than one new connection").toBe(2);
  });

  it("leaves one that answers alone, through ten rounds", () => {
    const s = opened[0];
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(25_000);
      s.onmessage?.({ data: JSON.stringify({ type: "pong" }) });
    }

    expect(pingsOn(s), "no heartbeat went out at all, so this says nothing about a relay that works").toBeGreaterThan(5);
    expect(s.readyState, "a relay answering every single round was dropped anyway").toBe(1);
    expect(opened.length, "it reconnected underneath a relay that was working perfectly").toBe(1);
  });
});

/**
 * How many lines the page keeps is a setting - three to fifteen - and nothing
 * here covered it.
 *
 * The part worth pinning is not the number but what the number counts. An open
 * interim is the line being spoken right now, one per capture channel, and it
 * must not be charged against the history budget: three people talking at once
 * on a phone set to three lines would otherwise push the entire transcript off
 * the screen to make room for three half-captions. `trimRows` gets this right
 * by selecting `.row:not(.interim)`, and the desktop's copy says so in a
 * comment; on this page it was only ever behaviour.
 *
 * It also must not be removed BY the budget. An interim that vanished
 * underneath a live utterance would take the blinking cursor with it and the
 * finished line would then arrive with nothing to replace.
 */
describe("how many lines the page keeps", () => {
  const finals = (): number => document.querySelectorAll("#lines .row:not(.interim)").length;
  const interims = (): number => document.querySelectorAll("#lines .row.interim").length;

  const speak = (from: number, to: number): void => {
    for (let id = from; id <= to; id += 1) {
      push({ type: "subtitle", id, source: `line ${id}`, final: true, channel: 0 });
    }
  };

  beforeEach(() => {
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
  });

  it("keeps the last few and drops the rest", () => {
    speak(1, 20);
    expect(finals(), "the history is not being trimmed at all").toBeLessThan(20);
    expect(lineTexts().at(-1), "the newest line was trimmed instead of the oldest").toBe("line 20");
    expect(lineTexts().includes("line 1"), "the oldest line survived twenty newer ones").toBe(false);
  });

  it("does not charge an open interim against that budget", () => {
    // the number the page is set to, read off the panel rather than restated
    const kept = Number($("linesVal").textContent);
    expect(kept, "the page does not say how many lines it keeps").toBeGreaterThan(2);

    // two other channels start talking and neither finishes, THEN the history
    // fills up - so every trim runs with those interims on the page
    push({ type: "partial", id: 101, source: "half a", channel: 1 });
    push({ type: "partial", id: 102, source: "half b", channel: 2 });
    speak(1, 20);

    expect(interims(), "the two open interims are not on the page").toBe(2);
    expect(
      finals(),
      "two people starting to speak cost the reader finished lines, which is the whole reason " +
        "trimRows selects .row:not(.interim)",
    ).toBe(kept);
  });

  it("does not let the budget remove an interim either", () => {
    push({ type: "partial", id: 101, source: "half a", channel: 1 });
    speak(1, 20);

    expect(
      interims(),
      "the line being spoken was trimmed away as history, so the cursor goes with it and the " +
        "final that follows has nothing to replace",
    ).toBe(1);
  });
});

/**
 * Four of the reader's display settings did what they do by putting a class on
 * `<body>`, and not one of them was covered.
 *
 * `showSource` is the one that matters most and reads like the least: a friend
 * who does not speak the streamer's language turns the original off, and half
 * their screen stops being text they cannot read. `showTranslation` is the same
 * move in reverse. `timestamps` and `align` are smaller and break the same way.
 *
 * Each is checked twice on purpose, because either half alone passes on a
 * broken page. Asserting the class proves the setting reached `<body>` and
 * nothing about whether that means anything; asserting the stylesheet proves a
 * rule exists and nothing about whether the class ever arrives. The comment
 * over `applyBrand` in the shipped file says why this matters here in
 * particular - happy-dom applies no stylesheets, so "a test asserting it would
 * pass on markup that shows the brand to a whole Twitch audience".
 */
describe("the display settings a reader actually changes", () => {
  const css = fs.readFileSync(path.join(publicDir, "style.css"), "utf8");
  const on = (name: string): boolean => document.body.classList.contains(name);

  const tick = (id: string, checked: boolean): void => {
    const el = $(id) as HTMLInputElement;
    el.checked = checked;
    el.dispatchEvent(new Event("change"));
  };
  const choose = (id: string, value: string): void => {
    const el = $(id) as HTMLSelectElement;
    el.value = value;
    el.dispatchEvent(new Event("change"));
  };

  /** the rules in the shipped stylesheet that key on `body.<name>` */
  const rulesFor = (name: string): string[] =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => new RegExp(`body\\.${name}\\b`).test(m[1]))
      .map((m) => `${m[1].trim().replace(/\s+/g, " ")} { ${m[2].trim()} }`);

  beforeEach(() => {
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
  });

  for (const name of ["no-src", "no-tgt", "no-ts", "center"]) {
    it(`has something in the stylesheet behind .${name}`, () => {
      expect(
        rulesFor(name),
        `nothing in style.css keys on body.${name}, so the setting that sets it changes nothing on screen`,
      ).not.toEqual([]);
    });
  }

  it("turns the original off for a reader who cannot read it", () => {
    expect(on("no-src"), "the original was already hidden before anything was asked").toBe(false);
    tick("setShowSource", false);
    expect(on("no-src"), "SHOW ORIGINAL was turned off and the page kept showing it").toBe(true);
    tick("setShowSource", true);
    expect(on("no-src")).toBe(false);
  });

  it("turns the translation off for a reader who does not want it", () => {
    tick("setShowTranslation", false);
    expect(on("no-tgt"), "SHOW TRANSLATION was turned off and the page kept showing it").toBe(true);
  });

  it("hides the translation on a stream that is not translating, whatever the reader asked for", () => {
    // the class is `!serverTranslates || !showTranslation`: there is nothing to
    // show, and a column reserved for nothing is worse than no column
    push({ type: "hello", languages: { source: "en", target: "en" }, live: true, translates: false });
    expect(on("no-tgt")).toBe(true);
    tick("setShowTranslation", true);
    expect(
      on("no-tgt"),
      "the reader asked for a translation the stream is not producing and got an empty column for it",
    ).toBe(true);
  });

  it("turns the timestamps off", () => {
    tick("setTimestamps", false);
    expect(on("no-ts")).toBe(true);
  });

  /**
   * The mirror of the rule above, and the one that was missing.
   *
   * `no-tgt` already refuses to reserve a column for a translation that is not
   * coming. `no-src` did not: it hid the original whenever the reader had asked
   * it to, whether or not anything was left to put in its place. Turn both off
   * between them and every row on the page is empty - a live badge, a clock,
   * and nothing under it.
   *
   * It is not a contrived setting either, because the display settings are
   * saved per device. Watch a translated stream, turn the original off because
   * it is not a language you read, come back next week to the same streamer not
   * translating, and the page is blank with nothing saying why.
   */
  it("keeps the original when there is no translation to replace it with", () => {
    tick("setShowSource", false);
    expect(on("no-src"), "the original is hidden while a translation is on screen, which is the point").toBe(true);

    push({ type: "hello", languages: { source: "en", target: "en" }, live: true, translates: false });
    expect(on("no-tgt"), "a stream that is not translating still reserved the column").toBe(true);
    expect(
      on("no-src"),
      "both columns are hidden at once, so every row renders empty and the reader gets a live badge " +
        "over a blank page",
    ).toBe(false);
  });

  it("keeps the original when the reader turns the translation off as well", () => {
    tick("setShowTranslation", false);
    tick("setShowSource", false);
    expect(
      on("no-src"),
      "the reader turned off both columns and the page went blank rather than falling back to the " +
        "one that has something in it",
    ).toBe(false);
  });

  it("centres the lines when asked, and only then", () => {
    expect(on("center")).toBe(false);
    choose("setAlign", "center");
    expect(on("center"), "ALIGN was set to centre and the page stayed left").toBe(true);
    choose("setAlign", "left");
    expect(on("center")).toBe(false);
  });
});

/**
 * Those settings meet the overlay, and one combination empties it.
 *
 * `DESIGN.md` says the overlay "Honors the other viewer display settings", and
 * turning the original off is a setting a streamer captioning for an
 * international audience would reach for first: show them the translation and
 * nothing else.
 *
 * The overlay renders exactly one row and promotes the open interim into that
 * slot, so a caption resolves in place instead of arriving a whole sentence
 * late. But an interim carries the source line and nothing else - its `.tgt` is
 * removed when it is built, because there is nothing to translate yet. With the
 * original hidden it has nothing left to draw, so promoting it puts an empty
 * row on the broadcast for the length of every utterance, and takes the last
 * finished translation off the screen to do it. What the audience sees while
 * somebody is talking is the amber bar and nothing beside it.
 */
describe("the overlay with the original turned off", () => {
  const obsOverlay = (style: Record<string, unknown>): void => {
    vi.useFakeTimers();
    localStorage.setItem("relay-style-v2", JSON.stringify(style));
    boot("?obs=1");
    vi.advanceTimersByTime(1);
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
  };

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  const live = (): HTMLElement | null => document.querySelector("#lines .row.obs-live");

  it("keeps the finished translation up while somebody is speaking", () => {
    obsOverlay({ showSource: false });
    push({ type: "subtitle", id: 1, source: "push B", target: "len B di", final: true, channel: 0 });
    push({ type: "partial", id: 2, source: "one on A", channel: 0 });

    const el = live();
    expect(el, "nothing at all is marked as the overlay's line").not.toBeNull();
    expect(
      el?.classList.contains("interim"),
      "the overlay promoted a half-caption that has nothing to show, so the broadcast is an amber " +
        "bar and an empty row until the speaker finishes",
    ).toBe(false);
    expect(el?.querySelector(".tgt")?.textContent, "the finished translation is not the line on air").toContain(
      "len B di",
    );
  });

  it("still promotes the interim when the original is shown", () => {
    // the promotion is the fix for captions arriving a whole utterance late,
    // and it has to keep working wherever there is something to draw
    obsOverlay({ showSource: true });
    push({ type: "subtitle", id: 1, source: "push B", target: "len B di", final: true, channel: 0 });
    push({ type: "partial", id: 2, source: "one on A", channel: 0 });

    expect(
      live()?.classList.contains("interim"),
      "the live line is not the one being spoken, so the overlay is a sentence behind again",
    ).toBe(true);
  });

  /**
   * The question is whether the original is ON SCREEN, not whether the reader
   * asked for it. Those came apart the moment `no-src` started standing down on
   * a stream with no translation to put in the original's place: the setting
   * still says hide, the page shows it anyway, and keying the promotion on the
   * setting leaves this reader a sentence behind for no reason.
   */
  it("promotes it again when the original is shown despite the setting", () => {
    vi.useFakeTimers();
    localStorage.setItem("relay-style-v2", JSON.stringify({ showSource: false }));
    boot("?obs=1");
    vi.advanceTimersByTime(1);
    push({ type: "hello", languages: { source: "en", target: "en" }, live: true, translates: false });
    push({ type: "subtitle", id: 1, source: "push B", final: true, channel: 0 });
    push({ type: "partial", id: 2, source: "one on A", channel: 0 });

    expect(document.body.classList.contains("no-src"), "the original is hidden and there is nothing else").toBe(
      false,
    );
    expect(
      live()?.classList.contains("interim"),
      "the original is on screen and the overlay is still waiting for the sentence to finish",
    ).toBe(true);
  });
});

/**
 * A rotated link, said the same way whichever relay the reader is on.
 *
 * The embedded relay sends a `kicked` MESSAGE carrying a reason, and this page
 * turns "link was rotated" into the panel that is actually useful: a new link
 * was made, this one will not work again, ask for the current one, your display
 * settings are kept. The hosted relay has no such message - it closes the
 * socket with 4410 and says nothing, because `closeAll` carries a close reason
 * that a browser does not hand to `onclose` in any useful form.
 *
 * So the page fell through to the generic sentence, "The session was stopped,
 * or a new link was made", for the one case where it knows exactly which of
 * those two happened. The code IS the reason; nothing has to be carried.
 *
 * Worth drawing because the ACTION differs, which is the argument `endedWords`
 * already makes for the other branch: trying again cannot help here, and the
 * reader needs to ask for a new link rather than wait.
 */
describe("a link rotated out from under an internet viewer", () => {
  const panel = (): { label: string; title: string; text: string } => ({
    label: (document.getElementById("endedLabel") as HTMLElement).textContent || "",
    title: (document.getElementById("endedTitle") as HTMLElement).textContent || "",
    text: (document.getElementById("endedText") as HTMLElement).textContent || "",
  });

  it("is told a new link was made, not that the session may have stopped", () => {
    socket.readyState = 3;
    socket.onclose?.({ code: 4410 });

    expect((document.getElementById("ended") as HTMLElement).hidden, "the ENDED panel never opened").toBe(false);
    expect(
      panel().title,
      "an internet viewer whose link was rotated is given the sentence for a session that may merely have " +
        "stopped, when the relay closed them with the code that says exactly which it was",
    ).toBe("A new link was made.");
    expect(panel().text).toContain("Ask whoever sent it");
  });

  it("still says nothing it does not know when the reason really is unknown", () => {
    socket.readyState = 3;
    socket.onclose?.({ code: 4401 });

    expect(
      panel().title,
      "4401 is the relay not knowing the token - which can be a rotation, a restart or a link that was " +
        "never valid, and the page must not pick one",
    ).toBe("The session was stopped, or a new link was made.");
  });
});

/**
 * A page that has been torn down must stop.
 *
 * Every boot evaluates app.js afresh, and app.js starts its clock with a
 * `setInterval(tick, 1000)` that a real page never needs to clear - it lives
 * as long as the tab. Here it outlived its markup: one interval per test,
 * nearly ninety of them by the end of this file, none ever stopped. Run alone
 * the file finishes inside a second and not one of them fires; run in the full
 * suite it is slower than that, and each tick that landed between a teardown
 * and the next boot looked up `#hudClock` in an empty body and threw. Vitest
 * counted eleven of those as unhandled errors, and a suite with every test
 * green exited 1.
 */
describe("tearing a page down", () => {
  it("stops its clock, so it cannot write into whatever page comes next", async () => {
    teardown();
    document.body.innerHTML = '<span id="hudClock">untouched</span>';

    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(
      $("hudClock").textContent,
      "a page that was torn down kept ticking and wrote its clock into markup it no longer owns",
    ).toBe("untouched");
  });
});

/**
 * A line whose translation is not coming.
 *
 * The relay answers a failed translation with `target: ""`. Before it did,
 * the row's "…" placeholder stayed for good - and on an OBS overlay set to
 * hide the original, which is the setup for an audience that does not read
 * the streamer's language, the caption on air was a lone "…" with the words
 * that were said hidden underneath it.
 *
 * What is on screen is a stylesheet question, so the real stylesheet is
 * loaded here: happy-dom does not fetch the page's <link>, but it does apply
 * an inline <style>.
 */
describe("a line whose translation is not coming", () => {
  const css = fs.readFileSync(path.join(publicDir, "style.css"), "utf8");

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    document.head.querySelector("style[data-test]")?.remove();
  });

  const overlayHidingTheOriginal = (): void => {
    vi.useFakeTimers();
    localStorage.setItem("relay-style-v2", JSON.stringify({ showSource: false }));
    boot("?obs=1");
    const style = document.createElement("style");
    style.dataset.test = "1";
    style.textContent = css;
    document.head.appendChild(style);
    vi.advanceTimersByTime(1);
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
  };

  // an element's own display is not the answer when an ancestor can hide it
  const shown = (el: Element | null | undefined): boolean => {
    if (!el) return false;
    for (let e: Element | null = el; e; e = e.parentElement) if (getComputedStyle(e).display === "none") return false;
    return true;
  };

  it("puts the words that were said on air, not a placeholder", () => {
    overlayHidingTheOriginal();
    push({ type: "subtitle", id: 1, source: "rush B", final: true, channel: 0 });
    push({ type: "subtitle", id: 1, source: "rush B", target: "", final: true, channel: 0 });

    const row = document.querySelector("#lines .row.obs-live");
    expect(row, "nothing is on air at all").not.toBeNull();
    expect(
      shown(row?.querySelector(".src .txt")),
      "the original is still hidden under a translation that is never coming, so the caption on air says nothing",
    ).toBe(true);
    expect(
      shown(row?.querySelector(".tgt")),
      "the translation slot is still on air - a placeholder, or an empty gap - for a translation that is not coming",
    ).toBe(false);
  });

  /**
   * The signal is the slowest message the page ever gets: it goes out only
   * once every retry has run out, up to about 22 s after the line on
   * timeouts. By then the page may have trimmed the row, and a subtitle for an
   * id it does not hold is treated as a new line - which put the stale line
   * back on air as the newest caption and deleted the half-caption being
   * spoken. There is no placeholder left to retire, so there is nothing to do.
   */
  it("does nothing for a line the page has already let go of", () => {
    vi.useFakeTimers();
    localStorage.setItem("relay-style-v2", JSON.stringify({ showSource: false, lines: 3 }));
    boot("?obs=1");
    vi.advanceTimersByTime(1);
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    for (let id = 1; id <= 5; id += 1) {
      push({ type: "subtitle", id, source: `line ${id}`, target: `dong ${id}`, final: true, channel: 0 });
    }
    push({ type: "partial", id: 6, source: "being spoken", channel: 0 });
    const before = lineTexts();

    // line 1's translation, failed long after line 1 was trimmed
    push({ type: "subtitle", id: 1, source: "line 1", target: "", final: true, channel: 0 });

    expect(lineTexts(), "a line the page had already let go of came back").toEqual(before);
    expect(document.querySelector("#lines .row.interim"), "the half-caption being spoken was deleted").not.toBeNull();
  });

  it("still waits with the placeholder while the translation is only in flight", () => {
    overlayHidingTheOriginal();
    push({ type: "subtitle", id: 1, source: "rush B", final: true, channel: 0 });

    const row = document.querySelector("#lines .row.obs-live");
    // unchanged behaviour: a translation that is coming is waited for, and the
    // original's words stay hidden as the reader asked
    expect(shown(row?.querySelector(".src .txt"))).toBe(false);
    expect(row?.querySelector(".tgt")?.textContent).toBe("…");
  });
});

/**
 * A translation that lands after its line has gone.
 *
 * Gemini's retries put a translation 5-22 s behind its line under a 429 or a
 * timeout, and on a fast stream the page has trimmed that line by then -
 * trimRows drops the id from `rows`, so the page keeps no record it was shown.
 * showSubtitle then took the translation for a new line: it rebuilt the old
 * sentence at the bottom as the newest caption (and the OBS overlay's line on
 * air), pushed the oldest real line off, and deleted the half-caption being
 * spoken on that channel.
 *
 * The rule has to tell "trimmed" from "never seen". A viewer that joined in
 * the middle of a line, reconnected across it, or sat behind an uplink gap
 * gets its translation without its source - and for that viewer the line is
 * news, so building its row is right. The numbering cannot separate them: a
 * missed line can be older than lines already on screen, and with two sources
 * the ids are reserved per channel and finish out of order. So the page
 * remembers the ids it actually let go of, and forgets them when a new session
 * restarts the numbering.
 */
describe("a translation that lands after its line has gone", () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  const keepThree = (): void => {
    vi.useFakeTimers();
    localStorage.setItem("relay-style-v2", JSON.stringify({ lines: 3 }));
    boot();
    vi.advanceTimersByTime(1);
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true, epoch: 100 });
  };
  const latest = (): string =>
    document.querySelector("#lines .row.latest .src .txt")?.textContent ?? "";

  it("does not bring the line back as the newest caption", () => {
    keepThree();
    for (let id = 1; id <= 4; id += 1) push({ type: "subtitle", id, source: `line ${id}`, final: true, channel: 0 });
    push({ type: "partial", id: 5, source: "still talking", channel: 0 });

    push({ type: "subtitle", id: 1, source: "line 1", target: "dong 1", final: true, channel: 0 });

    const finished = [...document.querySelectorAll("#lines .row:not(.interim) .src .txt")].map((n) => n.textContent);
    expect(finished, "a trimmed line came back at the bottom, out of order").toEqual(["line 2", "line 3", "line 4"]);
    expect(latest(), "the stale line became the newest caption").toBe("line 4");
    expect(document.querySelector("#lines .row.interim"), "the half-caption being spoken was deleted").not.toBeNull();
  });

  it("still builds a line it never saw, even with newer lines on screen", () => {
    keepThree();
    // line 3's source went out while this viewer was reconnecting
    push({ type: "subtitle", id: 1, source: "line 1", final: true, channel: 0 });
    push({ type: "subtitle", id: 2, source: "line 2", final: true, channel: 0 });
    push({ type: "subtitle", id: 4, source: "line 4", final: true, channel: 0 });
    push({ type: "subtitle", id: 3, source: "line 3", target: "dong 3", final: true, channel: 0 });

    expect(lineTexts(), "a line this viewer had never seen was thrown away").toContain("line 3");
  });

  it("tells them apart by what it let go of, not by the numbering, when two sources finish out of order", () => {
    keepThree();
    push({ type: "partial", id: 5, source: "fi", channel: 0 });
    push({ type: "partial", id: 6, source: "si", channel: 1 });
    push({ type: "subtitle", id: 6, source: "six", final: true, channel: 1 });
    push({ type: "subtitle", id: 5, source: "five", final: true, channel: 0 });
    push({ type: "subtitle", id: 7, source: "seven", final: true, channel: 1 });
    push({ type: "subtitle", id: 8, source: "eight", final: true, channel: 0 });
    // three kept, in the order they finished: six went first, five is still up
    expect(lineTexts()).toEqual(["five", "seven", "eight"]);

    push({ type: "subtitle", id: 6, source: "six", target: "sau", final: true, channel: 1 });

    expect(lineTexts(), "a line let go of came back, because a lower id was still on screen").toEqual([
      "five",
      "seven",
      "eight",
    ]);
  });

  it("measures against the session on screen, not the one before it", () => {
    keepThree();
    for (let id = 1; id <= 5; id += 1) push({ type: "subtitle", id, source: `old ${id}`, final: true, channel: 0 });
    // a new session: the ids start again and the rows are cleared
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true, epoch: 200 });
    // missed the new line 2's source across a reconnect, then got its translation
    push({ type: "subtitle", id: 2, source: "new two", target: "moi hai", final: true, channel: 0 });

    expect(lineTexts(), "the previous session's numbering hid a line of this one").toEqual(["new two"]);
  });
});

/**
 * A viewport unit an old browser does not know, with nothing under it.
 *
 * `.screen` took its height from `100dvh` alone. A browser that does not know
 * `dvh` - Chromium before 108, Safari before 15.4 - drops the declaration, so
 * the screen falls back to its content's height and `.lines`, which pins the
 * newest caption to the bottom only inside a definite height, has nothing to
 * pin against. OBS 28-30's browser source is Chromium 103: the overlay's one
 * caption was drawn at the top of the source. On an older phone the rows
 * stacked down from the top and, with the page `overflow: hidden`, the newest
 * lines fell below the fold where nothing could scroll to them.
 *
 * Every declaration that uses a dynamic viewport unit needs the same property
 * in a unit every browser knows ahead of it in the same rule, so a browser that
 * drops the first still has the second. The pages are found, not listed: every
 * stylesheet and every inline <style> this package serves.
 */
describe("a viewport unit an old browser does not know", () => {
  // signed and any case: `translateY(-50dvh)` and `100DVH` are the same unit
  const DYNAMIC = /(?:^|[^\w.])-?\d*\.?\d+(?:dvh|svh|lvh|dvw|svw|lvw|dvmin|dvmax|svmin|svmax|lvmin|lvmax)\b/i;

  /**
   * Every stylesheet, every <style> and every style="" attribute under the
   * served folder, subfolders included. The landing page is written mostly in
   * attributes, so they are where a new rule is likeliest to land.
   */
  function sheets(): { name: string; css: string }[] {
    const out: { name: string; css: string }[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const name = path.relative(publicDir, full);
        if (entry.isDirectory()) walk(full);
        else if (name.endsWith(".css")) out.push({ name, css: fs.readFileSync(full, "utf8") });
        else if (name.endsWith(".html")) {
          const html = fs.readFileSync(full, "utf8");
          for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
            out.push({ name: `${name} <style>`, css: m[1] ?? "" });
          }
          for (const m of html.matchAll(/\sstyle="([^"]*)"/gi)) {
            out.push({ name: `${name} style=""`, css: `[style] { ${m[1] ?? ""} }` });
          }
        }
      }
    };
    walk(publicDir);
    return out;
  }

  /** declaration blocks, innermost braces only, so rules inside @media are read too */
  function blocks(css: string): { selector: string; decls: [string, string][] }[] {
    const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
    return [...plain.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => ({
      selector: (m[1] ?? "").trim(),
      decls: (m[2] ?? "")
        .split(";")
        .map((d) => d.split(/:(.*)/s))
        .filter((p) => p.length >= 2 && (p[0] ?? "").trim())
        .map((p) => [(p[0] ?? "").trim().toLowerCase(), (p[1] ?? "").trim()] as [string, string]),
    }));
  }

  it("reads the stylesheets it is meant to, and finds the unit in them", () => {
    const found = sheets();
    const names = found.map((s) => s.name);
    expect(names, "the page stylesheet was not read").toContain("style.css");
    expect(names, "a stylesheet in a subfolder was not read").toContain(path.join("fonts", "fonts.css"));
    expect(names, "the landing page's <style> was not read").toContain("home.html <style>");
    expect(names.filter((n) => n.endsWith('style=""')).length, "no inline style attribute was read").toBeGreaterThan(50);
    // and the pattern matches what it is looking for, so a green run means the
    // declarations it found have fallbacks - not that it found none
    const dynamic = found
      .flatMap((s) => blocks(s.css))
      .flatMap((b) => b.decls)
      .filter(([, v]) => DYNAMIC.test(v));
    expect(dynamic.length, "no dynamic viewport length was found at all, so the check below saw nothing").toBeGreaterThan(0);
    for (const v of ["translateY(-50dvh)", "100DVH", "calc(100dvh - 10px)", ".5svh"]) {
      expect(DYNAMIC.test(v), `the pattern misses ${v}`).toBe(true);
    }
    expect(DYNAMIC.test("100vh"), "the pattern takes the fallback unit for a dynamic one").toBe(false);
  });

  it("never leaves a dynamic viewport length without a fallback ahead of it", () => {
    const bare: string[] = [];
    for (const { name, css } of sheets()) {
      for (const { selector, decls } of blocks(css)) {
        decls.forEach(([prop, value], i) => {
          if (!DYNAMIC.test(value)) return;
          const fallback = decls.slice(0, i).some(([p, v]) => p === prop && !DYNAMIC.test(v));
          if (!fallback) bare.push(`${name}: ${selector} { ${prop}: ${value} }`);
        });
      }
    }
    expect(
      bare,
      "a browser that does not know the unit drops these and keeps nothing - on OBS 28-30 the overlay's caption " +
        "goes to the top of the source",
    ).toEqual([]);
  });
});

/**
 * Two people talking over each other, on an overlay that shows one line.
 *
 * The overlay's one line was the newest finished row - unless ANY channel had
 * an interim open, in which case the most recently opened interim took it.
 * With one voice that is right: the interim is the next sentence, begun after
 * the last one finished. With two it is not. YOU is mid-sentence; a teammate's
 * callout on the other channel starts, types live (its interim is newer, so it
 * wins) and finishes - and the moment it finishes, YOU's older interim takes
 * the line back. The teammate's finished line, and the translation patched
 * onto it, were never on the broadcast at all. Talking over each other is
 * what game comms are.
 *
 * The rule the code already stated - the most recent thing is the one to show
 * - applied to finished lines too: an interim takes the line only if it was
 * opened after the newest finished line.
 */
describe("two voices on an overlay that shows one line", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const overlay = (): void => {
    vi.useFakeTimers();
    boot("?obs=1");
    vi.advanceTimersByTime(1);
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
  };
  const onAir = (): string => document.querySelector("#lines .row.obs-live")?.textContent ?? "";

  it("puts the other voice's finished line and its translation on air", () => {
    overlay();
    push({ type: "partial", id: 1, source: "I am still", channel: 0, speaker: "YOU" });
    push({ type: "partial", id: 2, source: "enemy", channel: 1, speaker: "CHAT" });
    push({ type: "subtitle", id: 2, source: "enemy behind the box", final: true, channel: 1, speaker: "CHAT" });
    expect(onAir(), "the teammate's line finished and the overlay went back to a sentence begun before it").toContain(
      "enemy behind the box",
    );

    push({ type: "subtitle", id: 2, source: "enemy behind the box", target: "dich sau hop", final: true, channel: 1, speaker: "CHAT" });
    expect(onAir(), "its translation never reached the broadcast").toContain("dich sau hop");
  });

  it("hands the line on when the first voice finishes or starts again", () => {
    overlay();
    push({ type: "partial", id: 1, source: "I am still", channel: 0, speaker: "YOU" });
    push({ type: "partial", id: 2, source: "enemy", channel: 1, speaker: "CHAT" });
    push({ type: "subtitle", id: 2, source: "enemy behind the box", final: true, channel: 1, speaker: "CHAT" });

    push({ type: "subtitle", id: 1, source: "I am still rotating", final: true, channel: 0, speaker: "YOU" });
    expect(onAir(), "the newest finished line is not on air").toContain("I am still rotating");

    push({ type: "partial", id: 3, source: "going A", channel: 0, speaker: "YOU" });
    expect(onAir(), "a sentence begun after the last one finished is not live").toContain("going A");
  });

  /**
   * And it has to give the line back. On the local engines one voice's segment
   * runs 15-18 s, so a callout that finished inside it would hold the overlay
   * the whole time while the person the audience can hear had no caption - the
   * "nothing until the whole message is done" complaint this line was built
   * to answer. A finished line gets its air - from when it lands, and again
   * from when its translation does - and then the voice still talking takes it
   * back on its next partial.
   */
  it("gives the line back to the voice still talking once the finished one has had its air", () => {
    overlay();
    push({ type: "partial", id: 1, source: "I am still", channel: 0, speaker: "YOU" });
    push({ type: "partial", id: 2, source: "enemy", channel: 1, speaker: "CHAT" });
    push({ type: "subtitle", id: 2, source: "enemy behind the box", final: true, channel: 1, speaker: "CHAT" });

    vi.advanceTimersByTime(2_500);
    push({ type: "subtitle", id: 2, source: "enemy behind the box", target: "dich sau hop", final: true, channel: 1, speaker: "CHAT" });
    vi.advanceTimersByTime(1_000);
    push({ type: "partial", id: 1, source: "I am still rotating", channel: 0, speaker: "YOU" });
    expect(onAir(), "the translation that just landed was taken off air before anyone could read it").toContain(
      "dich sau hop",
    );

    vi.advanceTimersByTime(3_000);
    push({ type: "partial", id: 1, source: "I am still rotating to B", channel: 0, speaker: "YOU" });
    expect(
      onAir(),
      "the finished line kept the overlay while the voice still talking had no caption",
    ).toContain("I am still rotating to B");
  });

  // "not coming" arrives long after its line - every retry has run out - and
  // leaves nothing new to read, so it must not pull the line back on air
  it("does not take the line back for a translation that is not coming", () => {
    overlay();
    push({ type: "partial", id: 1, source: "I am still", channel: 0, speaker: "YOU" });
    push({ type: "partial", id: 2, source: "enemy", channel: 1, speaker: "CHAT" });
    push({ type: "subtitle", id: 2, source: "enemy behind the box", final: true, channel: 1, speaker: "CHAT" });
    vi.advanceTimersByTime(3_500);
    push({ type: "partial", id: 1, source: "I am still rotating", channel: 0, speaker: "YOU" });
    expect(onAir()).toContain("I am still rotating");

    vi.advanceTimersByTime(10_000);
    push({ type: "subtitle", id: 2, source: "enemy behind the box", target: "", final: true, channel: 1, speaker: "CHAT" });
    push({ type: "partial", id: 1, source: "I am still rotating to B", channel: 0, speaker: "YOU" });

    expect(onAir(), "a translation that is not coming put an old line back on air over the voice talking").toContain(
      "I am still rotating to B",
    );
  });

  // an interim element carries a channel from one sentence to the next when the
  // page never saw the final in between (a reconnect, a rebuild): the NEW
  // sentence is what is being said now, whatever element it types into
  it("counts a new sentence from when it began, even typed into an old line", () => {
    overlay();
    push({ type: "partial", id: 1, source: "I am still", channel: 0, speaker: "YOU" });
    push({ type: "partial", id: 2, source: "enemy", channel: 1, speaker: "CHAT" });
    push({ type: "subtitle", id: 2, source: "enemy behind the box", final: true, channel: 1, speaker: "CHAT" });
    // id 1's final was missed; id 3 is a sentence begun after CHAT's line
    push({ type: "partial", id: 3, source: "going B", channel: 0, speaker: "YOU" });

    expect(onAir(), "a sentence begun after the finished line was held off air as if it were older").toContain("going B");
  });
});

/**
 * Who said it, with the original hidden.
 *
 * The speaker tag is drawn inside the original's element, and "Show original"
 * off hid that whole element - so on a translated stream with two sources, the
 * setting a reader who does not know the streamer's language reaches for first
 * took every YOU and CHAT off the page with it, and on the overlay a streamer
 * captioning for an international audience lost them too. Lines from different
 * people looked identical. DESIGN.md: "when two sources are on, every caption
 * row carries a condensed uppercase .who label ... Phone viewer and OBS overlay
 * use the same tag".
 *
 * The setting hides the original's words, not who said them. Loaded with the
 * real stylesheet, because what is on screen is the stylesheet's call.
 */
describe("who said it, with the original hidden", () => {
  const css = fs.readFileSync(path.join(publicDir, "style.css"), "utf8");
  // happy-dom reports an element's own display, not whether an ancestor hides
  // it - and hidden-by-its-parent is exactly the failure here - so walk up
  const shown = (el: Element | null | undefined): boolean => {
    if (!el) return false;
    for (let e: Element | null = el; e; e = e.parentElement) if (getComputedStyle(e).display === "none") return false;
    return true;
  };

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    document.head.querySelector("style[data-test]")?.remove();
  });

  const page = (search: string): void => {
    vi.useFakeTimers();
    localStorage.setItem("relay-style-v2", JSON.stringify({ showSource: false }));
    boot(search);
    const style = document.createElement("style");
    style.dataset.test = "1";
    style.textContent = css;
    document.head.appendChild(style);
    vi.advanceTimersByTime(1);
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    push({ type: "subtitle", id: 1, source: "go left", target: "di trai", final: true, channel: 1, speaker: "CHAT", color: "#7fb6d9" });
  };

  for (const [where, search] of [
    ["the phone page", ""],
    ["the overlay", "?obs=1"],
  ] as const) {
    it(`keeps the speaker on ${where}, and still hides the original's words`, () => {
      page(search);
      expect(document.body.classList.contains("no-src"), "the original is not hidden, so this proves nothing").toBe(true);
      const row = document.querySelector("#lines .row");
      const who = row?.querySelector(".who");

      expect(who?.textContent).toBe("CHAT");
      expect(shown(who), `hiding the original took the speaker off ${where}, so two people's lines look the same`).toBe(
        true,
      );
      expect(shown(row?.querySelector(".src .txt")), "the words the reader asked to hide are on screen").toBe(false);
      expect(shown(row?.querySelector(".tgt")), "the translation is not on screen").toBe(true);
      // on a line of its own, a trailing margin only pushes a centred tag off centre
      expect(who && getComputedStyle(who).marginRight).toBe("0px");
    });
  }
});

/**
 * Why the app stops sending wordless finals to the hosted relay.
 *
 * A wordless final retires the interim row a partial left. The uplink carries
 * no partials, so on a page reached through the hosted relay there is never an
 * interim - and a wordless final changes nothing at all. That is what makes
 * dropping them at the uplink (`forwardsToUplink` in packages/companion) safe,
 * so it is held here, against the page as it ships, on both surfaces.
 */
describe("a wordless final on a page that has no interim", () => {
  for (const search of ["", "?obs=1"]) {
    it(`changes nothing${search ? " on the overlay" : ""}`, () => {
      boot(search);
      push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: false, since: Date.now() });
      push({ type: "subtitle", id: 1, source: "rush B", final: true });
      const before = $("lines").innerHTML;

      push({ type: "subtitle", id: 2, source: "", final: true });
      push({ type: "subtitle", id: 3, source: "", target: "", final: true });

      expect($("lines").innerHTML, "a wordless final changed the page, so it has a job on the hosted hop after all").toBe(
        before,
      );
      expect(lineTexts()).toEqual(["rush B"]);
    });
  }
});

/**
 * A half-caption that came to nothing, on the overlay.
 *
 * The overlay shows one line, and while somebody speaks that line is the open
 * half-caption. When the utterance comes to nothing the engine sends a
 * wordless final, which retires the half-caption - and returned before
 * anything chose a line again, so nothing was on air: the overlay went blank
 * over a finished line it could have shown, until the next caption. With
 * "hide after" set to never, the line that should have stayed up for good
 * never came back at all.
 */
describe("the overlay after a half-caption that came to nothing", () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });
  const live = (): HTMLElement | null => document.querySelector("#lines .row.obs-live");

  it("puts the last finished line back on air", () => {
    vi.useFakeTimers();
    localStorage.setItem("relay-style-v2", JSON.stringify({ showSource: true }));
    boot("?obs=1");
    vi.advanceTimersByTime(1);
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: false });
    push({ type: "subtitle", id: 1, source: "push B", final: true, channel: 0 });
    push({ type: "partial", id: 2, source: "um", channel: 0 });
    expect(live()?.classList.contains("interim"), "the half-caption was never on air, so this proves nothing").toBe(true);

    push({ type: "subtitle", id: 2, source: "", final: true, channel: 0 });

    expect(live(), "the overlay went blank over a finished line it could show").not.toBeNull();
    expect(live()?.querySelector(".src")?.textContent).toContain("push B");
  });
});

/**
 * Every control in DISPLAY has a name a screen reader can say.
 *
 * The text-size slider was announced as a bare "slider, 18": its visible
 * "Size" is a sibling span tied to nothing. A low-vision reader is the most
 * likely person to reach for that control, and the one who could not tell
 * what it was. The colour swatches were the same - each is a colour input in
 * a label whose only text is an empty swatch, with the name in a `title` on
 * the label, where it names nothing. This walks every control the panel has,
 * so the next one added cannot ship nameless either.
 */
describe("the display settings, to a screen reader", () => {
  /** the accessible name, as far as markup can give one: aria, then a label, then a title */
  const nameOf = (el: HTMLElement): string => {
    const aria = el.getAttribute("aria-label")?.trim();
    if (aria) return aria;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() || "")
        .join(" ")
        .trim();
      if (text) return text;
    }
    const label = (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest("label");
    if (label) {
      const copy = label.cloneNode(true) as HTMLElement;
      // a label's name is its own text, not the options of the select inside it
      for (const inner of copy.querySelectorAll("input, select, textarea")) inner.remove();
      const text = copy.textContent?.replace(/\s+/g, " ").trim();
      if (text) return text;
    }
    return el.getAttribute("title")?.trim() || "";
  };

  it("names every control it has", () => {
    boot();
    const controls = [...document.querySelectorAll<HTMLElement>("#display input, #display select")];
    expect(controls.length, "found no controls in DISPLAY, so this checked nothing").toBeGreaterThan(8);
    const nameless = controls.filter((c) => !nameOf(c)).map((c) => `#${c.id}`);
    expect(nameless, "these are announced with no name at all").toEqual([]);
  });

  it("calls the size slider what it is labelled on screen", () => {
    boot();
    expect(nameOf($("setSize"))).toBe("Size");
  });
});

/**
 * Where keyboard focus is, in DISPLAY.
 *
 * The pickers (font, alignment, lines kept, hide after) and the colour
 * swatches are real controls laid invisibly over what the reader sees -
 * `opacity: 0` - and opacity takes the browser's own focus ring with it. So a
 * reader tabbing through the panel, or a streamer driving OBS's Interact
 * window from the keyboard, saw nothing change as focus moved: no telling
 * which setting the arrow keys would change. The row wearing the invisible
 * control has to show it instead - on keyboard focus only, so a tap on a
 * phone draws nothing, as the desktop app's own pickers do.
 *
 * The list is discovered from the stylesheet, not written down: every rule
 * that makes a `select` or `input` invisible, and the element it sits in.
 */
describe("keyboard focus in the display settings", () => {
  // comments out first: one above a rule would otherwise read as part of its selector
  const css = fs.readFileSync(path.join(publicDir, "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(",").map((s) => s.trim().replace(/\s+/g, " ")),
    body: m[2],
  }));
  const hidden = rules
    .filter((r) => /(^|;)\s*opacity:\s*0\s*(;|$)/.test(r.body))
    .flatMap((r) => r.selectors)
    .map((s) => /^(.+) (select|input)$/.exec(s))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);

  it("finds the invisible controls it is about", () => {
    expect(hidden, "no invisible select or input was found, so nothing below was checked").toEqual(
      expect.arrayContaining([".drow-pick", ".swatch"]),
    );
  });

  it("shows focus on the row around each invisible control", () => {
    const unmarked = hidden.filter(
      (container) =>
        !rules.some(
          (r) =>
            /outline/.test(r.body) &&
            r.selectors.some((s) => s.startsWith(`${container}:has(`) && s.includes(":focus-visible")),
        ),
    );
    expect(unmarked, "focus moves onto these with nothing on screen to show it").toEqual([]);
  });
});

/**
 * The active theme button, readable on every theme.
 *
 * It is drawn inverted - ink behind, the caption background in front - and
 * on the overlay's default theme, OBS clear, that background is literally
 * `transparent`. So the button the streamer lands on when they open DISPLAY,
 * and again after RESET, was a cream block with no "OBS clear" on it. The text
 * takes the colour the background was chosen as, which is opaque on every
 * theme, rather than what the page is painted with.
 */
describe("the active theme button", () => {
  const css = fs.readFileSync(path.join(publicDir, "style.css"), "utf8");
  afterEach(() => {
    document.head.querySelector("style[data-test]")?.remove();
    localStorage.clear();
  });

  for (const search of ["", "?obs=1"]) {
    it(`can be read on every theme${search ? " on the overlay" : ""}`, () => {
      boot(search);
      const style = document.createElement("style");
      style.dataset.test = "1";
      style.textContent = css;
      document.head.appendChild(style);

      const unreadable: string[] = [];
      for (const theme of ["dark", "light", "obs-black", "obs-clear"]) {
        (document.querySelector(`#themeBar button[data-theme="${theme}"]`) as HTMLButtonElement).click();
        const active = document.querySelector("#themeBar button.active") as HTMLElement | null;
        if (!active) {
          unreadable.push(`${theme}: no button marked active`);
          continue;
        }
        const { color, backgroundColor } = getComputedStyle(active);
        if (!color || color === "transparent" || /rgba\([^)]*,\s*0\)$/.test(color) || color === backgroundColor) {
          unreadable.push(`${theme}: "${color}" on "${backgroundColor}"`);
        }
      }
      expect(unreadable, "the active theme's label cannot be read").toEqual([]);
    });
  }
});

/**
 * The preview in DISPLAY, on the overlay.
 *
 * In OBS the only way to style the overlay is its Interact window, and while
 * DISPLAY is open the preview row is the only feedback on screen. The overlay
 * draws only the row marked as on air, and the preview's row never was - so
 * every change to size, font, colour or alignment happened against an empty
 * box, usually before anyone had spoken, which is when an overlay is set up.
 * On the overlay the preview is now the on-air line, drawn the way it airs.
 */
describe("the display preview on the overlay", () => {
  const css = fs.readFileSync(path.join(publicDir, "style.css"), "utf8");
  afterEach(() => {
    document.head.querySelector("style[data-test]")?.remove();
    localStorage.clear();
  });
  const withCss = (search: string): void => {
    boot(search);
    const style = document.createElement("style");
    style.dataset.test = "1";
    style.textContent = css;
    document.head.appendChild(style);
  };
  const previewRow = (): HTMLElement | null => document.querySelector("#previewRow .row");

  it("shows something before any caption has arrived", () => {
    withCss("?obs=1");
    $("openDisplay").click();
    expect(previewRow(), "the preview built no row").not.toBeNull();
    expect(getComputedStyle(previewRow()!).display, "the overlay hid its own preview").not.toBe("none");
  });

  it("is drawn the way the line airs", () => {
    withCss("?obs=1");
    $("openDisplay").click();
    expect(previewRow()?.classList.contains("obs-live")).toBe(true);
  });

  // the overlay fades its line after the hold; the preview is not the broadcast
  it("stays visible through a quiet stretch", () => {
    withCss("?obs=1");
    document.body.classList.add("idle");
    $("openDisplay").click();
    expect(getComputedStyle(previewRow()!).opacity).not.toBe("0");
  });

  it("leaves the phone page's preview as it was", () => {
    withCss("");
    $("openDisplay").click();
    expect(getComputedStyle(previewRow()!).display).not.toBe("none");
    expect(previewRow()?.classList.contains("obs-live")).toBe(false);
  });
});

/**
 * What a screen reader is handed, while somebody is still talking.
 *
 * `#lines` is a polite live region, and the half-caption sat inside it. Every
 * partial rebuilds that row's text, which a screen reader hears as new text to
 * read: "enemy", then "enemy pushing", then "enemy pushing mid" - the whole
 * sentence so far, again, several times a second, queued faster than it can
 * be spoken, and the translation the reader opened the link for comes last.
 * The half-caption is for eyes; the finished line, a new row, is what is read.
 */
describe("a screen reader and the half-caption", () => {
  /** the text a screen reader would take from #lines: nothing under aria-hidden */
  const announced = (): string => {
    const copy = $("lines").cloneNode(true) as HTMLElement;
    for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
    return copy.textContent?.replace(/\s+/g, " ").trim() || "";
  };

  it("is not read out on every partial", () => {
    boot();
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    for (const words of ["enemy", "enemy pushing", "enemy pushing mid"]) {
      push({ type: "partial", id: 1, source: words, channel: 0 });
    }

    expect(lineTexts().join(" "), "the half-caption was not on screen, so this proves nothing").toContain(
      "enemy pushing mid",
    );
    expect(announced(), "every partial was handed to the screen reader as new text").not.toContain("enemy");
  });

  it("still reads the finished line and its translation", () => {
    boot();
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    push({ type: "partial", id: 1, source: "enemy pushing", channel: 0 });
    push({ type: "subtitle", id: 1, source: "enemy pushing mid", final: true, channel: 0 });
    push({ type: "subtitle", id: 1, source: "enemy pushing mid", target: "địch đẩy giữa", final: true, channel: 0 });

    expect(announced()).toContain("enemy pushing mid");
    expect(announced()).toContain("địch đẩy giữa");
  });
});
