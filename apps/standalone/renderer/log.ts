/**
 * The LOG view: the running record a streamer opens when they want to know what
 * just went wrong.
 *
 * Lifted out of `app.ts` unchanged - the file boundary is exactly where the
 * section boundary already was, so this is a relocation and nothing else. It was
 * chosen first because it is the most self-contained thing in that file: it owns
 * one box, it is appended to and never read back, and `appendLog` and the line
 * counter have no caller outside it, which the module boundary now enforces
 * rather than merely hoping for.
 *
 * `wordless` sits here because it sat here - it is the predicate `logSubtitle`
 * guards with, colocated in the same section since the guard was written. It is
 * a statement about a subtitle rather than about the log, and `onSubtitle` on
 * the stage uses it too, so a later seam should give it a better home; moving it
 * now would have made this something other than a pure move.
 */

import { $ } from "./dom";

let logLines = 0;

export function log(message: string, cls: "" | "err" | "ok" = ""): void {
  const el = document.createElement("div");
  if (cls) el.className = cls;
  el.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  appendLog(el);
}

/**
 * A final the engine sent to say that utterance came to nothing.
 *
 * Deepgram emits one every couple of seconds on a silent channel, and does so
 * deliberately - dispatchDeepgramMessage (packages/relay/src/deepgram.ts)
 * stopped swallowing them precisely because the session reserves a segment id
 * for a channel's interim and only releases it on a final. They are a control
 * message, not a caption, and every other consumer already says so: onPartial
 * in app.ts, the viewer page, the translator (packages/relay/src/session.ts) and
 * the saved-transcript writer (../src/transcripts.ts) all check before acting.
 * One measured 94-minute session carried 3,105 of these against 657 real lines.
 */
export function wordless(seg: { source: string; target?: string }): boolean {
  return !seg.source.trim() && !seg.target?.trim();
}

export function logSubtitle(seg: {
  source: string;
  target?: string;
  speaker?: string;
  latency?: { stt?: number; translate?: number };
}): void {
  // nothing was said, so there is nothing to log - and the box holds 400 lines,
  // so logging them anyway costs the real ones their place
  if (wordless(seg)) return;
  const t = new Date().toLocaleTimeString();
  const en = document.createElement("div");
  en.className = "sub-en";
  en.textContent = `[${t}] ▸ ${seg.speaker ? `${seg.speaker}: ` : ""}${seg.source}${seg.latency?.stt != null ? `  [stt ${seg.latency.stt}ms]` : ""}`;
  appendLog(en);
  // "" is a translation that is not coming - the error log already says why,
  // rate-limited, and a blank line per failed caption says nothing more
  if (seg.target) {
    const vi = document.createElement("div");
    vi.className = "sub-vi";
    vi.textContent = `    ${seg.target}${seg.latency?.translate != null ? `  [+${seg.latency.translate}ms]` : ""}`;
    appendLog(vi);
  }
}

function appendLog(el: HTMLElement): void {
  const box = $("log");
  box.appendChild(el);
  logLines += 1;
  while (box.children.length > 400) box.firstChild?.remove();
  box.scrollTop = box.scrollHeight;
  $("logCount").textContent = `${box.children.length} LINES`;
}
