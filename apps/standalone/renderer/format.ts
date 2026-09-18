/**
 * The renderer's formatters: a value in, the string a reader sees out.
 *
 * Moved out of `app.ts` unchanged. They read nothing - not the DOM, not the
 * bridge, not the config - which makes them the one set of pieces in that file
 * that can move without a single signature changing. `fmtClock` and
 * `fmtElapsed` are two implementations of one format, left as two because
 * this was a move; `test/format.test.ts` holds them equal.
 */

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

export function fmtTs(d: Date): string {
  return `${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
export function fmtSec(ms: number | undefined): string {
  return ms == null ? "" : `${(ms / 1000).toFixed(1)}s`;
}
export function stripUrl(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "");
}
export function usd(n: number, digits = 3): string {
  return `$${n.toFixed(digits)}`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtDuration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  return min < 60 ? `${min} MIN` : `${Math.floor(min / 60)} H ${min % 60} MIN`;
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
}

export function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Clamp `text` to at most `maxBytes` of UTF-8, decoding back to a string. A
 * cut that lands inside a multi-byte character comes back with a trailing
 * replacement character rather than throwing - acceptable for a log that is
 * already being truncated.
 */
export function clampUtf8Bytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder().decode(bytes.slice(0, maxBytes));
}

export function fmtMb(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}
