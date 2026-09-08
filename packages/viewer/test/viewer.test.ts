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

  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  // the shipped markup, minus its own script tags: app.js is evaluated below
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, "");

  // Detach anything an EARLIER boot in this same test left behind. Each socket
  // announces itself on a timer, so a re-boot leaves the first page's onopen
  // queued; it then fires into the markup this boot just replaced and reports a
  // null element from inside teardown. It survived locally on timing alone and
  // failed on CI.
  detachAll();
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

beforeEach(() => boot());

afterEach(() => {
  // onopen is scheduled, so without this it fires into a cleared page and
  // reports an error that belongs to the teardown rather than the test
  detachAll();
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
