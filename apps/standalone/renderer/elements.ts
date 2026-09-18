/**
 * The renderer's small builders: each is handed the element and everything it
 * needs, and touches nothing else - no config, no bridge, no id lookup.
 *
 * Moved out of `app.ts` unchanged, after the formatters in `format.ts`. The
 * survey of that file looked for views that could move, and these are the
 * pieces views are made of, so it never weighed them. `fitSelect` brings the
 * one piece of state it owns, the hidden element it measures with.
 */

import { safeSpeakerColor } from "@callout-relay/shared";

/**
 * Say which language a piece of text is in. index.html is `lang="en"`, so
 * without this a screen reader announces the TRANSLATION column in English -
 * WCAG 3.1.2, Language of Parts. The column headers do not cover it: they are
 * English words naming a language, not text in it.
 *
 * A code is never invented. Nothing is marked when nothing said what it is.
 */
export function markLang(el: Element | null, code: string | undefined): void {
  if (!el) return;
  if (code) el.setAttribute("lang", code);
  else el.removeAttribute("lang");
}

/**
 * Paint a speaker tag.
 *
 * This used to be one binary class - "YOU" against everyone else - which was
 * enough while there were two sources and wrong the moment there were three:
 * CHAT and COACH came out the same colour, so the tag named them and the
 * colour did not tell them apart. The colour now rides on the caption, chosen
 * per slot by the streamer, and the class stays as the fallback for a relay
 * that does not send one.
 */
export function paintSpeaker(el: HTMLElement, seg: { speaker?: string; color?: string }): void {
  const colour = safeSpeakerColor(seg.color);
  el.style.color = colour || "";
  el.classList.toggle("other", !colour && !!seg.speaker && seg.speaker !== "YOU" && seg.speaker !== "CH1");
}

export function fillSelect(box: HTMLSelectElement, entries: { value: string; label: string }[], value: string): void {
  box.innerHTML = "";
  for (const { value: v, label } of entries) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = label;
    if (v === value) opt.selected = true;
    box.appendChild(opt);
  }
  // Said outright as well. Chromium honours an option marked selected before
  // it is appended; the DOM the tests run in does not, and picked another
  // option of a picker refilled in place - so a test read the wrong source.
  // With no match the first option stays, as it always has.
  if (entries.some((e) => e.value === value)) box.value = value;
}

/** size a text-styled <select> to its selected option (Chrome pads selects for the arrow) */
let measureEl: HTMLSpanElement | null = null;
export function fitSelect(box: HTMLSelectElement): void {
  if (!measureEl) {
    measureEl = document.createElement("span");
    measureEl.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;top:-1000px";
    document.body.appendChild(measureEl);
  }
  const cs = getComputedStyle(box);
  measureEl.style.font = cs.font;
  measureEl.style.letterSpacing = cs.letterSpacing;
  measureEl.style.textTransform = cs.textTransform;
  measureEl.textContent = box.selectedOptions[0]?.textContent || "";
  box.style.width = `${Math.ceil(measureEl.getBoundingClientRect().width) + parseFloat(cs.paddingRight || "0") + 2}px`;
}

export function metaSpans(el: HTMLElement, items: { text: string; cls?: string }[]): void {
  el.innerHTML = "";
  for (const it of items) {
    const s = document.createElement("span");
    s.textContent = it.text;
    if (it.cls) s.className = it.cls;
    el.appendChild(s);
  }
}

/** a 1-5 rating as five bordered cells, filled ones in ink (DESIGN.md SegmentedBar) */
export function ratingRow(label: string, value: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "rate";
  const l = document.createElement("span");
  l.className = "rate-label";
  l.textContent = label;
  const cells = document.createElement("span");
  cells.className = "cells";
  for (let i = 1; i <= 5; i++) {
    const c = document.createElement("i");
    if (i <= value) c.className = "on";
    cells.appendChild(c);
  }
  row.append(l, cells);
  return row;
}
