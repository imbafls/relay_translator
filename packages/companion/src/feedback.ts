import { HOSTED_RELAY_URL } from "@callout-relay/shared";

/**
 * Send a problem report, mirroring `hostedRoom.ts`'s shape.
 *
 * Task 8 shipped this as a `fetch()` call inside the Electron renderer. The
 * renderer's origin is `file://` (opaque) with `webSecurity` on, and
 * `Content-Type: application/json` makes the request non-simple, so Chromium
 * preflights it with `OPTIONS`. `apps/hosted-relay` never answers CORS
 * headers on any route - by design, so an unauthenticated write endpoint like
 * `/feedback` cannot be POSTed to from an arbitrary web page a visitor's
 * browser happens to have open. The preflight has nowhere to succeed, so the
 * send failed with "could not reach the server" every time in the packaged
 * app, verified against the live deploy.
 *
 * `claimHostedRoom` already solved this for `/claim`: it runs in `main.ts`
 * over Node's `fetch`, where CORS does not apply, because Node's fetch has no
 * origin at all. This is the same move for `/feedback` - called from
 * `main.ts` over IPC, never from the renderer directly.
 *
 * Unlike `claimHostedRoom`, this takes no address to send to. `claimHostedRoom`
 * exists to POST to whatever relay a user names; `sendFeedback` must never do
 * that - a self-hosted relay (`packages/relay`, a different codebase) has no
 * `/feedback` route, and a fresh install's `relayUrl` is unset by
 * construction (LAN-only, CLAUDE.md). Feedback always goes to the one Worker
 * that implements the endpoint, independent of anything the user configured
 * for viewers - so the endpoint is not a parameter here, it cannot be.
 */

export interface FeedbackPayload {
  message: string;
  appVersion: string;
  log?: string;
}

/**
 * What `POST /feedback` (apps/hosted-relay/src/index.ts, `handleFeedback`)
 * can answer with, collapsed to what a caller needs to act on:
 *
 * - `delivered: true` covers both 200 and the one 502 shape that still
 *   carries an `id` - the report itself landed in R2 either way. `logFailed`
 *   distinguishes them: retrying a delivered report would duplicate it just
 *   to retry the log attachment, so both are "done", not "failed".
 * - `delivered: false` covers every other shape (400/413/415/429, a 502 with
 *   no `id`, and a transport failure) - nothing was stored, `message` is a
 *   sentence a person can read, and it is always safe to press SEND again.
 */
export type FeedbackResult =
  | { delivered: true; id: string; logFailed: boolean }
  | { delivered: false; message: string };

/**
 * Where feedback always goes: the http(s) origin of `hostedRelayUrl` +
 * `/feedback`. Exported so the mapping is checkable on its own, the same way
 * `claimUrlFor` (packages/shared) has its own "where a claim is sent" tests -
 * `sendFeedback` below always calls this with no argument; the parameter
 * exists for that test, not for a caller to redirect where feedback goes.
 */
export function feedbackUrlFor(hostedRelayUrl: string = HOSTED_RELAY_URL): string {
  const m = hostedRelayUrl.match(/^(wss?):\/\/([^/]+)\/?$/i);
  const scheme = m && m[1].toLowerCase() === "wss" ? "https" : "http";
  const host = m ? m[2] : "textrelay.cc";
  return `${scheme}://${host}/feedback`;
}

export async function sendFeedback(
  payload: FeedbackPayload,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<FeedbackResult> {
  const url = feedbackUrlFor();
  const doFetch = opts.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000);

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    // DNS, refused, offline, or the timeout above - all the same to the user,
    // who needs to know the server is not answering rather than which syscall
    const detail = (err as Error)?.name === "AbortError" ? "it did not answer in time" : String((err as Error)?.message || err);
    return { delivered: false, message: `could not reach the server - ${detail}` };
  } finally {
    clearTimeout(timer);
  }

  let body: { id?: string; error?: string } | undefined;
  try {
    body = (await res.json()) as { id?: string; error?: string };
  } catch {
    body = undefined;
  }

  if (res.ok) {
    return { delivered: true, id: body?.id ?? "?", logFailed: false };
  }
  if (res.status === 502 && body?.id) {
    // the report landed; only the log attachment failed - see FeedbackResult
    return { delivered: true, id: body.id, logFailed: true };
  }
  // 400 / 413 / 415 / 429 / 502-with-no-id: nothing was stored
  return { delivered: false, message: body?.error || `send failed (HTTP ${res.status})` };
}
