# supr.systems DNS — inventory before any migration

Read from Hostinger on **2026-09-06**, before touching anything. This is the
restore reference: if a Cloudflare migration goes wrong, every record needed to
put the zone back is here.

Nameservers today: `ns1.dns-parking.com`, `ns2.dns-parking.com` (Hostinger).

## The full zone

| Type | Name | Content | TTL |
| --- | --- | --- | --- |
| A | `@` | `76.76.21.21` | 14400 |
| A | `relay` | `187.124.87.202` | 300 |
| CNAME | `www` | `cname.vercel-dns.com.` | 300 |
| MX | `@` | `5 mx1.hostinger.com.` | 14400 |
| MX | `@` | `10 mx2.hostinger.com.` | 14400 |
| MX | `send` | `10 feedback-smtp.us-east-1.amazonses.com.` | 3600 |
| TXT | `@` | `"v=spf1 include:_spf.mail.hostinger.com ~all"` | 3600 |
| TXT | `send` | `"v=spf1 include:amazonses.com ~all"` | 3600 |
| TXT | `_dmarc` | `"v=DMARC1; p=none"` | 3600 |
| TXT | `resend._domainkey` | `"p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCroXEbwvOMBRKBhKVYBXBuuB22q1VdhpcjPJZFYi46Sf7ZzIQOF/WVs8YbzGlhD8EBXB5r4zvNk0koiEecOidS1o1T5TYbz1fZ8pNAMW10zUDZOdi4H0HI2gMDSui3w8vGf2cZ1z8e51Zdgq1lSVzJ72E30P1ZjtaSK5/25/oRCwIDAQAB"` | 14400 |
| CNAME | `hostingermail-a._domainkey` | `hostingermail-a.dkim.mail.hostinger.com.` | 300 |
| CNAME | `hostingermail-b._domainkey` | `hostingermail-b.dkim.mail.hostinger.com.` | 300 |
| CNAME | `hostingermail-c._domainkey` | `hostingermail-c.dkim.mail.hostinger.com.` | 300 |
| CNAME | `autoconfig` | `autoconfig.mail.hostinger.com.` | 300 |
| CNAME | `autodiscover` | `autodiscover.mail.hostinger.com.` | 300 |

## What each thing is, and what breaks if it is lost

**The website** — `@` → `76.76.21.21` and `www` → `cname.vercel-dns.com` are
Vercel. Losing these takes supr.systems offline. Visible immediately, easy to
spot, easy to fix.

**Email — this is the dangerous part.** The zone carries a working mail setup
and none of its failures are loud:

- `MX @` → Hostinger mx1/mx2. Lose it and **inbound mail bounces**, silently
  from the sender's point of view.
- `TXT @` SPF, and three `hostingermail-*._domainkey` DKIM CNAMEs. Lose or
  mistype these and outbound mail starts landing in spam rather than failing —
  the worst failure mode, because nothing tells you.
- `autoconfig` / `autodiscover` — mail clients set themselves up through these.
- `resend._domainkey` TXT is a **Resend** DKIM key, and `send` has its own SPF
  and an MX for Amazon SES bounce handling. So a second mail path exists for
  transactional sending on the `send` subdomain. That DKIM value is a single
  long string; it must be copied byte for byte.

**`relay` → 187.124.87.202** is the VPS being retired. This is the record that
would be replaced by a Cloudflare Worker custom domain. Note Cloudflare refuses
to create a Custom Domain on a hostname that already has a conflicting record,
so the A record has to go first.

## Rollback

Hostinger keeps zone snapshots automatically. Available at the time of writing:

| id | reason | created |
| --- | --- | --- |
| 178307069 | Zone records update request | 2026-09-05T08:03:35Z |
| 153967051 | Zone records update request | 2026-06-03T14:35:12Z |
| 153966915 | Zone records update request | 2026-06-03T14:34:48Z |
| 153966509 | Zone records update request | 2026-06-03T14:33:17Z |
| 153951647 | Hostinger mail activated | 2026-06-03T13:33:48Z |
| 143951415 | Zone records update request | 2026-05-01T06:40:17Z |

`178307069` (2026-09-05) is the newest and matches the table above. Restoring it
puts the Hostinger-side zone back.

**But a snapshot does not undo a nameserver change.** If the nameservers are
pointed at Cloudflare and something is wrong, the fix is to point them back at
`ns1/ns2.dns-parking.com` and wait for propagation — the snapshot only matters
if the records themselves were edited too.

## Order of work, if this goes ahead

1. This inventory. Done.
2. Add the zone in Cloudflare and recreate all 16 records above **while the
   nameservers still point at Hostinger**. Nothing is live yet.
3. Verify by querying Cloudflare's assigned nameservers directly and diffing
   every answer against this table — especially MX, SPF, and all four DKIM
   records.
4. Only then change the nameservers at Hostinger.
5. After propagation, confirm the site loads and send a test mail both ways.
6. Last: delete the `relay` A record and attach the Worker custom domain.

The Worker is already reachable on
`callout-relay-hosted.calloutrelay.workers.dev` throughout, so nothing about
captions depends on any of this.
