/**
 * The element getters, which everything in the renderer uses.
 *
 * Moved out of `app.ts` unchanged, because the first piece extracted from that
 * file needs them and importing them back from `app.ts` would be a cycle. There
 * are 240-odd call sites; `scripts/check-renderer-ids.mjs` is what makes the
 * unchecked cast safe, by failing the build when an id these are handed does not
 * exist in the markup.
 */

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;
export const inp = (id: string): HTMLInputElement => $(id);
export const sel = (id: string): HTMLSelectElement => $(id);
