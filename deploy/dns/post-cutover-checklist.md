# supr.systems cutover — what to check, in order

Nameservers were repointed at Cloudflare on 2026-09-06. The registrar accepted
it immediately; the `.systems` registry publishes it on its own schedule, which
can be minutes or hours. Until it publishes, Hostinger keeps answering and
nothing changes.

## 1. Has it actually cut over?

    nslookup -type=NS supr.systems 8.8.8.8

Hostinger (`ns1/ns2.dns-parking.com`) means it has not landed yet — that is not
a fault, and there is nothing to fix. Cloudflare (`craig`/`lia.ns.cloudflare.com`)
means you are live on Cloudflare.

To see the registry's own view rather than a cached one, ask the TLD directly:

    nslookup -type=NS supr.systems v0n0.nic.systems

## 2. Does the whole zone still answer correctly?

    powershell -File deploy/dns/verify-cloudflare-zone.ps1 -NS 8.8.8.8

Expect **14 passed, 0 failed**. This is the same script that verified the zone
before cutover; run against a public resolver it now checks what the world sees.

## 3. The website

    https://supr.systems        expect HTTP 200
    https://www.supr.systems    expect HTTP 200

Both are DNS-only, so they resolve straight to Vercel exactly as before.

## 4. Mail — do this one properly

The zone's DNS records being right is necessary, not sufficient. Actually send:

- **Inbound:** send a mail from an outside address to your supr.systems mailbox.
  It should arrive. If it bounces, MX is wrong — check step 2.
- **Outbound:** send from your supr.systems address to a Gmail account. Open the
  message, **Show original**, and confirm `SPF: PASS` and `DKIM: PASS`.

DKIM is the one to actually look at. If a DKIM record were wrong, nothing
bounces and nothing errors — the mail simply arrives unsigned and starts being
filtered as spam over the following days. The header is the only early warning.

Also worth one send from the `send` subdomain path (Resend/SES) if anything uses
it, since that has its own SPF, DKIM and bounce MX.

## 5. Only after all of the above

Attach the Worker custom domain so `relay.supr.systems` points at the caption
relay. It is deliberately absent from the Cloudflare zone: Cloudflare will not
attach a custom domain to a hostname that already has a conflicting record.

Until then the relay stays reachable at
`callout-relay-hosted.calloutrelay.workers.dev`, which is where the desktop app
is pointed, so captions are unaffected throughout.

## If something is wrong

Point the nameservers back at `ns1.dns-parking.com` / `ns2.dns-parking.com` at
Hostinger and wait for propagation. A Hostinger DNS snapshot restores *records*
and cannot undo a nameserver change — the Hostinger zone is still intact, so
pointing back is the whole rollback.
