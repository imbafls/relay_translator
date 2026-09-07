# Traefik route for the relay — RETIRED

> **None of this is live.** The VPS was stopped on 2026-09-06 and
> `relay.supr.systems` is now a Cloudflare Worker custom domain
> (`apps/hosted-relay/wrangler.toml`), alongside `textrelay.cc`. Applying this
> rule would route a name Cloudflare serves at a machine that does not exist.
> Kept as the record of how the box was wired; read it in the past tense.

`relay.yml` was the file-provider rule that put `relay.supr.systems` in front of
the relay, copied here so the box's config was not the only copy.

On the VPS it lives at `/docker/traefik/dynamic/relay.yml`. Traefik is started
with `--providers.file.directory=/dynamic --providers.file.watch=true` and mounts
`./dynamic:/dynamic:ro`, so edits to this file apply without a restart. Adding
those flags is the only change made to the shared Traefik compose; the previous
version is kept there as `docker-compose.yml.bak`.

Traefik uses `network_mode: host`, which is why the backend is `127.0.0.1:8787`.
