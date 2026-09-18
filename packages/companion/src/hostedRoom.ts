import { claimUrlFor, isRoomClaim } from "@callout-relay/shared";

/**
 * Claim a room on a relay, so the user never has to type a token.
 *
 * Returns exactly the patch that turns the uplink on - `relayUrl` and
 * `publisherToken`, the two fields `startUplink()` checks. The viewer token is
 * deliberately not returned: the app already fetches that itself from
 * `/admin/viewer-token` with the publish token, and storing a second copy would
 * mean two places to go stale.
 *
 * Every failure throws with a sentence a person can act on. This runs behind a
 * button, and a button that fails silently is worse than no button.
 */
export async function claimHostedRoom(
  relayUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ relayUrl: string; publisherToken: string }> {
  const url = claimUrlFor(relayUrl);
  if (!url) throw new Error(`"${relayUrl}" is not a relay address - it has to start with ws:// or wss://`);

  const doFetch = opts.fetchImpl || fetch;
  const controller = new AbortController();
  // One deadline from the first byte to the last. It used to be cleared when
  // the headers arrived, so a relay or proxy that sent 200 and stalled
  // mid-body held the button with no deadline at all.
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000);
  const tooSlow = new Error(`could not reach ${new URL(url).host} - it did not answer in time`);
  try {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      });
    } catch (err) {
      // DNS, refused, offline, or the timeout above - all the same to the user,
      // who needs to know the relay is not answering rather than which syscall
      if ((err as Error)?.name === "AbortError") throw tooSlow;
      throw new Error(`could not reach ${new URL(url).host} - ${String((err as Error)?.message || err)}`);
    }

    if (res.status === 429) {
      throw new Error("that relay is refusing new rooms for the moment - too many were claimed from this address. Try again in a minute.");
    }
    if (!res.ok) {
      throw new Error(`${new URL(url).host} refused to open a room (${res.status})`);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // an answer the timeout cut short is a relay that did not answer in
      // time, not an address that is wrong
      if (controller.signal.aborted) throw tooSlow;
      body = undefined;
    }
    // a proxy, a captive portal or a stale route answers 200 with HTML, and
    // storing that as a publish token leaves the uplink retrying against nonsense
    if (!isRoomClaim(body)) {
      throw new Error(`${new URL(url).host} did not answer with a room - check the address`);
    }

    return { relayUrl, publisherToken: body.publisherToken };
  } finally {
    clearTimeout(timer);
  }
}
