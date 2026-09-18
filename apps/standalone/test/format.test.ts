import { describe, expect, it } from "vitest";
import {
  clampUtf8Bytes,
  esc,
  fmtBytes,
  fmtClock,
  fmtDuration,
  fmtElapsed,
  fmtMb,
  fmtSec,
  fmtTs,
  fmtWhen,
  pad2,
  stripUrl,
  usd,
} from "../renderer/format";

/**
 * The renderer's formatters: data in, a string out, nothing read from the DOM,
 * the bridge or the config.
 *
 * They lived scattered through `app.ts` - three beside the saved-transcripts
 * view, one beside the model list, one beside the feedback form - and were only
 * ever exercised through whatever screen happened to show them. The earlier
 * survey of that file looked for views that could move without changing
 * behaviour and stopped at the ones bound to shared state; these were never
 * views, so it never weighed them, and they are the one set of pieces that
 * touches nothing at all.
 *
 * What is held here is what a reader sees, so each case is a string that
 * appears on a screen.
 */

describe("the session clock", () => {
  it("reads hours, minutes and seconds, each two digits", () => {
    expect(fmtClock(0)).toBe("00:00:00");
    expect(fmtClock(3_723_999)).toBe("01:02:03");
    expect(pad2(7)).toBe("07");
    expect(pad2(42)).toBe("42");
  });

  it("never runs backwards past zero", () => {
    // a clock read against a start the streamer's machine put in the future
    expect(fmtClock(-5_000)).toBe("00:00:00");
  });

  it("keeps counting past a hundred hours rather than wrapping", () => {
    expect(fmtClock(100 * 3_600_000)).toBe("100:00:00");
  });

  /**
   * Two implementations of one format. `fmtClock` drives the topbar and
   * `fmtElapsed` the timestamps in a saved transcript, and they were written
   * separately - one with `pad2`, one with `padStart`. Held equal so that
   * whoever folds them into one has a test that says they may.
   */
  it("is the same format a saved transcript's timestamps use", () => {
    for (const ms of [0, -5_000, 999, 59_999, 3_723_999, 100 * 3_600_000]) {
      expect(fmtElapsed(ms), `at ${ms}ms`).toBe(fmtClock(ms));
    }
  });
});

describe("the stage row timestamp", () => {
  it("is minutes and seconds of the wall clock, with no hour", () => {
    expect(fmtTs(new Date(2026, 8, 18, 13, 5, 7))).toBe("05:07");
  });
});

describe("latency", () => {
  it("is seconds to one place, or nothing when there is no figure", () => {
    expect(fmtSec(1234)).toBe("1.2s");
    expect(fmtSec(0)).toBe("0.0s");
    expect(fmtSec(undefined)).toBe("");
  });
});

describe("a link shown in the footer", () => {
  it("loses its scheme and keeps everything else", () => {
    expect(stripUrl("http://192.168.1.20:8787/watch/abc")).toBe("192.168.1.20:8787/watch/abc");
    expect(stripUrl("HTTPS://textrelay.cc/watch/abc")).toBe("textrelay.cc/watch/abc");
    expect(stripUrl("textrelay.cc/watch/abc")).toBe("textrelay.cc/watch/abc");
  });
});

describe("money", () => {
  it("is dollars to three places unless asked otherwise", () => {
    expect(usd(0)).toBe("$0.000");
    expect(usd(1.2346)).toBe("$1.235");
    expect(usd(0.5, 2)).toBe("$0.50");
  });
});

describe("a saved transcript's size and length", () => {
  it("steps bytes up to KB and MB", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(1023)).toBe("1023 B");
    expect(fmtBytes(1024)).toBe("1 KB");
    expect(fmtBytes(81_920)).toBe("80 KB");
    expect(fmtBytes(1024 * 1024)).toBe("1.0 MB");
  });

  it("rounds to whole minutes and adds hours past sixty", () => {
    expect(fmtDuration(26 * 60_000)).toBe("26 MIN");
    expect(fmtDuration(29_999)).toBe("0 MIN");
    expect(fmtDuration(30_000)).toBe("1 MIN");
    expect(fmtDuration(60 * 60_000)).toBe("1 H 0 MIN");
    expect(fmtDuration(125 * 60_000)).toBe("2 H 5 MIN");
    expect(fmtDuration(-60_000)).toBe("0 MIN");
  });

  it("dates it in the reader's own locale, medium date and short time", () => {
    const ms = Date.UTC(2026, 8, 15, 5, 15);
    expect(fmtWhen(ms)).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(ms));
  });
});

describe("a model's download size", () => {
  it("is MB below a thousand and GB to one place from there", () => {
    expect(fmtMb(989)).toBe("989 MB");
    expect(fmtMb(1000)).toBe("1.0 GB");
    expect(fmtMb(2400)).toBe("2.4 GB");
  });
});

describe("text written into the onboarding preview's markup", () => {
  it("cannot open a tag or close an attribute", () => {
    expect(esc('<b class="x">R&D</b>')).toBe("&lt;b class=&quot;x&quot;&gt;R&amp;D&lt;/b&gt;");
  });
});

describe("the log attached to a problem report", () => {
  it("comes back unchanged when it already fits", () => {
    expect(clampUtf8Bytes("callout", 7)).toBe("callout");
  });

  it("is cut by UTF-8 bytes, not by characters", () => {
    expect(clampUtf8Bytes("abcdef", 3)).toBe("abc");
    // three characters, nine bytes: a budget of six holds two of them
    expect(clampUtf8Bytes("ếếế", 6)).toBe("ếế");
    expect(clampUtf8Bytes("éé", 2)).toBe("é");
  });

  it("marks a cut through a character instead of throwing", () => {
    expect(clampUtf8Bytes("é", 1)).toBe("�");
  });
});
