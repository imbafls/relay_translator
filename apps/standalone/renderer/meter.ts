/**
 * The twelve-bar level meter in 01 SOURCE, and the reading behind it.
 *
 * Moved out of `app.ts` unchanged. The whole unit came rather than just the
 * render half, because the three pieces are one thing: a number, the frames that
 * feed it, and the bars that show it. Leaving `level` behind in `app.ts` would
 * have meant handing it to `renderMeter` on every tick to keep the same
 * behaviour, which is a change to the signature rather than a relocation.
 *
 * `resetLevel` is the only addition, and it is not a behaviour change: `app.ts`
 * sets the level back to zero when a session starts, and module-private state
 * needs a door for the one writer outside it. The assignment it replaces is the
 * same assignment.
 */

import { rmsLevel } from "@callout-relay/companion";

import { $ } from "./dom";

let level = 0;

/** a new session starts from silence, however loud the last one ended */
export function resetLevel(): void {
  level = 0;
}

export function feedLevel(chunk: Int16Array): void {
  // rmsLevel reads every lane of the interleave; the stride this used to walk
  // with saw only channel 0 once there were three sources
  level = Math.max(level * 0.85, rmsLevel(chunk));
}

export function renderMeter(): void {
  const bars = $("meter").children;
  const db = level > 0 ? 20 * Math.log10(level) : -100;
  const lit = Math.round(Math.min(1, Math.max(0, (db + 50) / 50)) * bars.length);
  // an HTMLCollection is indexed, not iterable in the way a loop wants
  Array.from(bars).forEach((bar, i) => bar.classList.toggle("on", i < lit));
}
