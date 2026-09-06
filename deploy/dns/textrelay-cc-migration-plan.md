# textrelay.cc — the plan, for when it is done

Domain bought 2026-09-06 as the product's own name, with a year of email.
Not migrated yet, deliberately. This is the runbook so none of the reasoning
has to be worked out again.

## The one thing that makes this urgent-ish

    textrelay.cc      A      2.57.91.91   (Hostinger parking)
    www.textrelay.cc  CNAME  textrelay.cc.
    (no MX)

**There is no mail on this zone yet.** That is the whole point.

The `supr.systems` migration on the same day took a day of care for one reason:
that zone carried live email on two sending paths, and Cloudflare's automatic
import silently sets DKIM CNAMEs to Proxied, which unsigns outbound mail without
bouncing anything. See `supr.systems-before-migration.md` and the Mainbrain note
`decisions/supr-systems-dns-to-cloudflare.md`.

This zone has nothing to break. Moving it now is a ten-minute job with an empty
blast radius.

**So do the DNS move BEFORE configuring the paid email, not after.** Setting up
Hostinger mail first and migrating later recreates the exact hazard that took a
day to handle safely — for no benefit, since the mail records can be created
directly in Cloudflare instead.

That is the only time-sensitive thing here. Everything else can wait
indefinitely; the relay runs fine on `relay.supr.systems`.

## Order

1. **Move the zone while it is empty.** Add textrelay.cc in Cloudflare, let it
   import the two records, force both to **DNS only**, verify, then repoint the
   nameservers at Hostinger. Same method as supr.systems; `verify-cloudflare-zone.ps1`
   can be pointed at the new zone by changing `$Domain`.
2. **Then set up the email**, creating its records in Cloudflare from the start.
   Verify by sending both directions and reading `SPF: PASS` / `DKIM: PASS` off a
   received message. Records resolving is not the same as mail working.
3. **Then point the Worker at it** and decide apex vs subdomain (below).
4. **Then repoint the desktop app** (`relayUrl` in `%APPDATA%\callout-relay\config.json`,
   or the KEYS panel) and claim a room on the new host.
5. Update the changelog wording and `apps/hosted-relay/README.md`, which currently
   name `relay.supr.systems`.

## Apex or subdomain

Worth an actual decision rather than defaulting to `relay.`.

`apps/hosted-relay` already serves a product site: `home.html` at `/`, the viewer
page at `/watch/<token>`, fonts and assets underneath. So the apex can be the
entire product.

- **`textrelay.cc/watch/<token>`** — one name, reads like a product, and the link
  a viewer receives says what it is. The landing page at `/` is already written.
- **`relay.textrelay.cc/watch/<token>`** — leaves the apex free for a separate
  marketing site later, at the cost of a longer link and a second thing to set up.

The viewer link is the most-shared artifact this project produces. That argues
for the apex.

Note Cloudflare will not attach a custom domain to a hostname that already has a
conflicting record, so whichever is chosen, its existing A/CNAME has to go first —
the same reason `relay` was deliberately left out of the supr.systems import.

## What happens to relay.supr.systems

Keep it. `workers_dev` is also still enabled, so the Worker would answer on three
names. That is a feature: the app can be moved deliberately rather than cut over
by a deploy, and there is a fallback if the new domain has a problem.

Retire `relay.supr.systems` only once the app and anyone testing have been moved
and have stayed moved for a while.

## Cost note

None of this changes the hosting cost question, which is still unmeasured:
Durable Objects bill wall-clock duration while a WebSocket is accepted. Measure
that against a real stream before inviting anyone, regardless of which domain it
is on. See the board card "Gates before anyone else uses the hosted relay".
