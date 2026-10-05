# Prod VPS disk hygiene

**For:** the owner / DevOps, when the VPS (`ssh crm-vps`) runs out of space.
**Source:** 2026-10-04 incident — 696 Docker images took up ~60 GB, the disk reached 93%; a manual cleanup freed ~50.9 GB.

## Cause

Every deploy pulls fresh `api` and `nginx` images tagged by git SHA. Nobody removed the old ones, and
`docker image prune -f` only removes dangling (untagged) images — SHA-tagged images are not dangling.

## What is now automatic

- **Deploy** (`.github/workflows/deploy.yml`, the last step of the SSH script, only after all
  checks have passed): `docker image prune -af --filter "until=168h"` — removes unused images
  older than 7 days. The last week's images stay around for a fast rollback. Active images and
  volumes are not touched. The `until` filter counts by image **creation** time.
- **Container logs:** `docker-compose.prod.yml` (postgres, redis, api, nginx) and
  `services/signal-plus/docker-compose.yml` — `json-file`, `max-size: 10m`, `max-file: 5`
  (up to 50 MB per service). Applied when a container is recreated on deploy, without restarting the daemon.
  `redis` and `postgres` got the limit on 2026-10-04, the rest earlier.

## Symptom

Disk > 85% (`df -h /`), or a deploy fails on image pull/unpack with `no space left on device`.

## Diagnostics

```bash
df -h /
docker system df            # images / containers / volumes / build cache
docker images | wc -l       # hundreds of images = auto-cleanup is not working
du -xhd1 /var 2>/dev/null | sort -h | tail
du -xhd1 /var/lib/docker 2>/dev/null | sort -h | tail
```

## Manual cleanup

```bash
docker image prune -af --filter until=48h   # unused images older than 2 days
docker builder prune -af --filter until=48h # build cache, if it is large (usually empty on the VPS)
journalctl --vacuum-size=200M               # if the system journal has grown
```

Check the result: `df -h /` and `docker system df`.

## What NOT to touch

- **Volumes.** `postgres_data` is Postgres data, `redis_data`, `signal_data` are the state
  of Redis and the signal-cli binding. Do not run `docker volume prune`, `docker system prune --volumes`,
  `docker compose down -v`.
- **Images of running containers** (crm-nginx, crm-api, crm-postgres, crm-redis, signal-plus) —
  Docker will not remove them anyway, but do not force `docker rmi -f`.
- **`/etc/docker/daemon.json`.** Any change requires restarting the daemon = downtime
  for the whole stack. Log limits are set in compose, not in the daemon — intentionally.
- `docker system prune -a` without `--filter` — would wipe everything unused, including rollback images.

## Rollback to an image older than 7 days

The image may have been removed by cleanup. That is not a blocker: a rollback is a `workflow_dispatch`
deploy with `image_tag`, and the image is downloaded again from GHCR (see `docs/runbooks/deployment.md` §9).
