# Traefik route for the relay

`relay.yml` is the file-provider rule that puts `relay.supr.systems` in front of
the relay, copied here so the box's config is not the only copy.

On the VPS it lives at `/docker/traefik/dynamic/relay.yml`. Traefik is started
with `--providers.file.directory=/dynamic --providers.file.watch=true` and mounts
`./dynamic:/dynamic:ro`, so edits to this file apply without a restart. Adding
those flags is the only change made to the shared Traefik compose; the previous
version is kept there as `docker-compose.yml.bak`.

Traefik uses `network_mode: host`, which is why the backend is `127.0.0.1:8787`.
