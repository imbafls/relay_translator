import { isViewerTokenAnswer, rotateUrlFor, viewerTokenUrlFor } from "@callout-relay/shared";

/** what a relay said to a rotation, as far as it can be known */
export type RemoteRotation =
  | { remote: "rotated"; viewerToken: string }
  | { remote: "unchanged" | "refused" | "unknown"; reason: string };

type Opts = { fetchImpl?: typeof fetch; timeoutMs?: number };

/**
 * Ask a relay to replace its viewer link, and find out what actually happened.
 *
 * This is the half of NEW that can fail. The app used to fire this request and
 * move on: a 500 or a 403 was not even logged, and either way the window said
 * "old links are dead" while the old phone link kept working.
 *
 * It never throws, because what the streamer is told depends on which failure
 * it was. Both relays replace the link before they answer, so a request that
 * failed after it was sent - a timeout, a dropped connection, a 500, an answer
 * cut short - may have killed the old link anyway. For those it asks the relay
 * which link it admits now, and compares that with `previous`, the one the app
 * has been handing out. A 403 or a 404 is a relay that turned this app away
 * before doing anything: nothing to ask, and nothing a second press changes.
 *
 * The answer is checked, not trusted. A proxy or a captive portal answers 200
 * with HTML, and storing that as a viewer token hands every phone a link to
 * nothing.
 */
export async function rotateRemoteLink(
  relayUrl: string,
  publisherToken: string,
  previous: string | undefined,
  opts: Opts = {},
): Promise<RemoteRotation> {
  const url = rotateUrlFor(relayUrl);
  const readUrl = viewerTokenUrlFor(relayUrl);
  if (!url || !readUrl) {
    return { remote: "refused", reason: `"${relayUrl}" is not a relay address - it has to start with ws:// or wss://` };
  }
  const host = new URL(url).host;

  const asked = await ask(url, "POST", publisherToken, opts);
  if (asked.token !== undefined) return { remote: "rotated", viewerToken: asked.token };
  if (asked.status === 403) {
    return { remote: "refused", reason: `${host} did not accept this app's publish key - SETTINGS → WHO CAN OPEN IT gets a new address` };
  }
  if (asked.status === 404) {
    return { remote: "refused", reason: `${host} has no room for this app any more - SETTINGS → WHO CAN OPEN IT gets a new address` };
  }

  const reason =
    asked.status === undefined
      ? `could not reach ${host} - ${asked.detail}`
      : asked.status >= 200 && asked.status < 300
        ? `${host} did not answer with a new link - check the relay address`
        : `${host} could not replace the link (${asked.status})`;

  const now = await ask(readUrl, "GET", publisherToken, opts);
  if (now.token === undefined) return { remote: "unknown", reason };
  // the relay admits a link the app was not handing out: whatever became of
  // the request, the one people were given no longer opens
  if (now.token !== previous) return { remote: "rotated", viewerToken: now.token };
  return { remote: "unchanged", reason };
}

/**
 * One request with the publish key, bounded by the timeout from the first byte
 * to the last. Clearing the timer when the headers arrived left the body read
 * with no deadline at all, so a relay that stalled mid-answer held NEW for as
 * long as the socket lived.
 */
async function ask(
  url: string,
  method: "POST" | "GET",
  publisherToken: string,
  opts: Opts,
): Promise<{ token?: string; status?: number; detail?: string }> {
  const doFetch = opts.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000);
  try {
    let res: Response;
    try {
      res = await doFetch(url, { method, headers: { Authorization: `Bearer ${publisherToken}` }, signal: controller.signal });
    } catch (err) {
      const detail = controller.signal.aborted ? "it did not answer in time" : String((err as Error)?.message || err);
      return { detail };
    }
    if (!res.ok) return { status: res.status };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // an answer the timeout cut short is a relay that did not answer in
      // time, not an address that is wrong
      if (controller.signal.aborted) return { detail: "it did not answer in time" };
      body = undefined;
    }
    return isViewerTokenAnswer(body) ? { token: body.viewerToken, status: res.status } : { status: res.status };
  } finally {
    clearTimeout(timer);
  }
}
