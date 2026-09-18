// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fillSelect, fitSelect, markLang, metaSpans, paintSpeaker, ratingRow } from "../renderer/elements";

/**
 * The renderer's small builders: each is handed the element and everything it
 * needs, and touches nothing else - no config, no bridge, no id lookup.
 *
 * They were the second category the survey of `app.ts` never weighed, after
 * the formatters: it looked for views, and these are the pieces views are made
 * of. Each was only ever exercised through a whole screen. What is held here is
 * what they leave in the element, because that is all anybody sees.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

describe("marking the language of a piece of text", () => {
  it("says which language it is when something said so", () => {
    const el = document.createElement("div");
    markLang(el, "vi");
    expect(el.getAttribute("lang")).toBe("vi");
  });

  it("takes the mark off again rather than leaving the last language on", () => {
    const el = document.createElement("div");
    markLang(el, "vi");
    markLang(el, undefined);
    expect(el.hasAttribute("lang"), "a stale language would be read out over text in another one").toBe(false);
  });

  it("does nothing, rather than throwing, when there is no element", () => {
    expect(() => markLang(null, "vi")).not.toThrow();
  });
});

describe("painting a speaker tag", () => {
  it("wears the colour the caption carries, and no fallback class", () => {
    const el = document.createElement("span");
    paintSpeaker(el, { speaker: "CHAT", color: "#5FB3A1" });
    expect(el.style.color).not.toBe("");
    expect(el.classList.contains("other")).toBe(false);
  });

  it("falls back to the other-speaker class when no colour came", () => {
    const el = document.createElement("span");
    paintSpeaker(el, { speaker: "CHAT" });
    expect(el.style.color).toBe("");
    expect(el.classList.contains("other")).toBe(true);
  });

  it("treats a colour that is not a plain hex as no colour at all", () => {
    const el = document.createElement("span");
    paintSpeaker(el, { speaker: "CHAT", color: "red; background: url(x)" });
    expect(el.style.color).toBe("");
    expect(el.classList.contains("other")).toBe(true);
  });

  it("never marks the streamer's own voice as somebody else", () => {
    for (const speaker of ["YOU", "CH1"]) {
      const el = document.createElement("span");
      paintSpeaker(el, { speaker });
      expect(el.classList.contains("other"), speaker).toBe(false);
    }
    const bare = document.createElement("span");
    paintSpeaker(bare, {});
    expect(bare.classList.contains("other"), "no speaker at all").toBe(false);
  });

  it("clears what an earlier paint left, because a row is repainted in place", () => {
    const el = document.createElement("span");
    paintSpeaker(el, { speaker: "CHAT" });
    paintSpeaker(el, { speaker: "COACH", color: "#aa3377" });
    expect(el.classList.contains("other")).toBe(false);
    paintSpeaker(el, { speaker: "YOU" });
    expect(el.style.color).toBe("");
  });
});

describe("a meta line of spans", () => {
  it("replaces what was there with one span per item, classed when asked", () => {
    const el = document.createElement("div");
    el.innerHTML = "<b>stale</b>";
    metaSpans(el, [{ text: "EN" }, { text: "KEY MISSING", cls: "warn" }]);
    const spans = [...el.children];
    expect(spans.map((s) => s.tagName)).toEqual(["SPAN", "SPAN"]);
    expect(spans.map((s) => s.textContent)).toEqual(["EN", "KEY MISSING"]);
    expect(spans[0]?.hasAttribute("class")).toBe(false);
    expect(spans[1]?.className).toBe("warn");
  });

  it("writes text, never markup", () => {
    const el = document.createElement("div");
    metaSpans(el, [{ text: "<img src=x>" }]);
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toBe("<img src=x>");
  });
});

describe("a 1-5 rating", () => {
  it("is a label and five cells, the first N filled", () => {
    const row = ratingRow("SPEED", 3);
    expect(row.className).toBe("rate");
    expect(row.querySelector(".rate-label")?.textContent).toBe("SPEED");
    const cells = [...row.querySelectorAll(".cells i")];
    expect(cells).toHaveLength(5);
    expect(cells.map((c) => c.className)).toEqual(["on", "on", "on", "", ""]);
  });
});

describe("filling a select", () => {
  it("replaces its options and selects the one asked for", () => {
    const box = document.createElement("select");
    box.innerHTML = '<option value="old">old</option>';
    fillSelect(
      box,
      [
        { value: "en", label: "English" },
        { value: "vi", label: "Tiếng Việt" },
      ],
      "vi",
    );
    expect([...box.options].map((o) => [o.value, o.textContent])).toEqual([
      ["en", "English"],
      ["vi", "Tiếng Việt"],
    ]);
    expect(box.value).toBe("vi");
  });
});

describe("sizing a select to the option it shows", () => {
  /**
   * The measuring element is created once and kept at module level, which is
   * right for a page whose body is never replaced and wrong for these tests,
   * whose teardown replaces it. Each test gets the module fresh.
   */
  async function fresh(): Promise<typeof fitSelect> {
    vi.resetModules();
    return (await import("../renderer/elements")).fitSelect;
  }

  function select(padRight: string): HTMLSelectElement {
    const box = document.createElement("select");
    box.innerHTML = '<option value="a">Tiếng Việt</option>';
    box.style.paddingRight = padRight;
    document.body.appendChild(box);
    return box;
  }

  it("is the measured text plus the right padding and two pixels", async () => {
    const fit = await fresh();
    // happy-dom lays nothing out, so the text measures 0 and what is left is
    // exactly the padding and the allowance on top of it
    const box = select("10px");
    fit(box);
    expect(box.style.width).toBe("12px");
  });

  it("measures the option that is selected, in an element nobody sees", async () => {
    const fit = await fresh();
    fit(select("0px"));
    const probes = [...document.body.querySelectorAll("span")];
    expect(probes).toHaveLength(1);
    expect(probes[0]?.textContent).toBe("Tiếng Việt");
    expect(probes[0]?.style.visibility).toBe("hidden");
  });

  it("reuses one measuring element however many selects it sizes", async () => {
    const fit = await fresh();
    fit(select("0px"));
    fit(select("0px"));
    fit(select("0px"));
    expect(document.body.querySelectorAll("span"), "a new hidden span per fit is a leak on every render").toHaveLength(1);
  });
});
