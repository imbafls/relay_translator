# textrelay.cc — done 2026-09-07

**The migration is complete.** Kept as the record of what was decided and why,
and because the email half has not been done yet.

```
textrelay.cc  NS  craig.ns.cloudflare.com, lia.ns.cloudflare.com
              →   the hosted relay Worker, apex custom domain
```

What happened, in the order the plan called for:

1. Zone added to Cloudflare (the account the Worker is in) while it still had
   no MX - the empty blast radius the plan was built around.
2. Both imported records deleted: the apex `A` at the Hostinger parking IP and
   the `www` CNAME. A custom domain will not attach over a conflicting record.
3. Nameservers repointed at the registrar. Live at the .cc registry within
   about a minute.
4. `textrelay.cc` attached as a Worker custom domain alongside
   `relay.supr.systems`, and deployed.
5. Verified on the new name: `verify-deploy` 14/14, `verify-isolation` 9/9, and
   the viewer page byte-identical to the tree. The old name still passes 14/14.
6. `HOSTED_RELAY_URL` moved to `wss://textrelay.cc`, so every install claims
   there from the release that carries it.

**Still to do: the email.** It is paid for and not configured. Create its
records **in Cloudflare**, not at Hostinger - the zone is no longer served
there. Verify by sending both directions and reading `SPF: PASS` / `DKIM: PASS`
off a received message; records resolving is not the same as mail working.

The rest of this file is the plan as it stood beforehand.

---
# textrelay.cc — the plan, for when it is done

Domain bought 2026-09-06 as the product's own name, with a year of email.
Not migrated yet, deliberately. This is the runbook so none of the reasoning
has to be worked out again.

## Status, checked 2026-09-07

    textrelay.cc  NS  nova.dns-parking.com, cosmos.dns-parking.com
    textrelay.cc  A   2.57.91.91          (Hostinger parking, answers 200)
    (still no MX)

Nothing has moved. The zone is exactly as it was bought, which means the
ten-minute window described below is still open.

**The blocker is not technical.** Step 1 changes nameservers on the Hostinger
account, and DNS, Cloudflare account settings and the Hostinger account are all
off-limits to the agent working in this repo. It needs a person. Everything
after step 1 can be done from here.

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
4. **Then repoint the desktop app.** Since v0.5.7 this is one constant -
   `HOSTED_RELAY_URL` in `packages/shared/src/index.ts` - because the app claims
   its own room now rather than being handed a URL and a token by hand. Change
   it, ship a release, and every install claims on the new name from then on.
   Rooms already claimed on `relay.supr.systems` keep working as long as that
   name still answers, which is the reason for keeping it.
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

**Measured since this was written, and the answer inverts the worry above.**
Hibernation works, so duration is a non-issue: 3.83 GB-s per room-hour against a
free-plan 13,000 GB-s/day is about 3,400 room-hours a day. What binds is
**requests** - every inbound WebSocket message on a hibernating object is one, so
every caption is one. Measured at 1,597 requests per room-hour, the free plan is
about **63 room-hours a day**, and the lever is batching captions, not anything
about hibernation. Numbers and method in `apps/hosted-relay/README.md`.

None of that changes with the domain.
