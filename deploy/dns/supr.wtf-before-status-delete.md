# supr.wtf zone — recorded 2026-09-06 before deleting the `status` record

Three records. Written down because Hostinger's only snapshot for this zone is
from 2026-03-24, which is not a rollback for today's state, and the delete
endpoint available here takes no record filter.

| Type | Name | Content | TTL |
| --- | --- | --- | --- |
| A | `@` | `2.57.91.91` | 50 |
| CNAME | `www` | `supr.wtf.` | 300 |
| A | `status` | `187.124.87.202` | 300 |

Only the `status` record is being removed. It pointed at the retired VPS and was
already dead before that machine was stopped: Traefik answered it with its own
default certificate and a 404, so no service was ever routed there.

The apex is **not** on the VPS — `2.57.91.91` is elsewhere — so removing `status`
does not touch the live site.
