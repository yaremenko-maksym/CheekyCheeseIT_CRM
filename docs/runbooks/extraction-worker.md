# Extraction worker service (owner-run, A3: production)

**For:** the owner. **No agent runs any step here on the production server unasked.**
**Spec:** `docs/architecture/2026-11-03-extraction-model-router.md` §2.4 (network, secret, no published port), §3.3 (key hygiene).
**State after merge:** the service is defined in `docker-compose.prod.yml` / `docker-compose.ghcr.yml` behind the compose profile `extraction`. A plain `up` does **not** start it. The local model is a separate task (5.4c-8) and is not started here.

## What the compose files give you

- Service `extraction-worker`: same image as `api`, command `node dist/extraction-worker/main`, `no-new-privileges`, all capabilities dropped.
- Network `extraction-internal` (`internal: true`): holds only the worker and `api` (the caller side). No `ports:` on the worker.
- Env from the worker's own file `.env.extraction-worker`, never `.env.production`.
- Router state file on the named volume `extraction_worker_state`.
- Guard: `scripts/devops/check-extraction-worker-compose.mjs` (run by `scripts/devops/tests/run-guard-tests.sh`) fails if the worker gains `ports:` / `network_mode`, leaves the network, or another service joins it.

Note: the first deploy after merge recreates `api` once, because it now also joins `extraction-internal`.

## 1. Create the env file (0600)

On the server, in the compose directory (`/opt/crm`):

```bash
umask 177
touch .env.extraction-worker && chmod 600 .env.extraction-worker
stat -c '%a' .env.extraction-worker      # expect 600
```

Fill it with the keys listed under "Extraction worker" in `.env.example` (`EXTRACTION_WORKER_SECRET`, `EXTRACTION_ROUTER_CONFIG`, and the route keys when those tasks land). Edit it with an editor; never paste values into a command line or chat.

## 2. Generate `EXTRACTION_WORKER_SECRET`

At least 32 characters with at least 8 distinct ones; the worker refuses to start otherwise.

```bash
openssl rand -hex 32        # 64 hex chars, 16 distinct
```

Put the same value in `.env.extraction-worker` and, for the caller side, in the API's env. It is the only worker setting the API may hold: no hosted key, no `ROUTER_LOCAL_MODEL_URL`.

## 3. State volume ownership (once)

The image runs as `node`; a fresh named volume is root-owned.

```bash
docker compose -f docker-compose.prod.yml --profile extraction run --rm --no-deps \
  --user root --cap-add CHOWN --entrypoint chown extraction-worker \
  node:node /var/lib/extraction-worker
```

## 4. Start / stop

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.ghcr.yml --profile extraction up -d extraction-worker
docker compose -f docker-compose.prod.yml -f docker-compose.ghcr.yml --profile extraction stop extraction-worker
```

Undo: `stop`, then `rm -f extraction-worker`; remove the volume only if you want the router state gone (`docker volume rm <project>_extraction_worker_state`).

## 5. Checks after the first start

```bash
# no published port (expect no output)
docker port "$(docker compose -f docker-compose.prod.yml --profile extraction ps -q extraction-worker)"

# unauthenticated call is refused (expect 401/403, not 200), run from the API container
docker compose -f docker-compose.prod.yml exec api wget -S -qO- --post-data='{}' http://extraction-worker:3100/extract 2>&1 | head -5

# the API container holds no hosted key and no local-model URL (expect "0")
docker compose -f docker-compose.prod.yml exec api env | grep -c -E '^(ROUTER_API_KEY|ROUTER_LOCAL_MODEL_URL|EXTRACTION_ROUTER_CONFIG)=' || true

# only api and the worker are on the network (expect exactly those two)
docker network inspect "$(docker network ls -q --filter name=extraction-internal)" \
  --format '{{range .Containers}}{{.Name}} {{end}}'
```

The worker's log must show it started (a refusal names the key, never its value). A secret shorter than 32 characters, or with fewer than 8 distinct ones, makes the container exit at once.

## 6. Known interim limits (close before hosted keys, task 5.4c-5)

- **Egress.** The network is `internal: true`, so the worker has no route to hosted providers. Hosted egress must be an allow-listed path added together with the guard (which today requires exactly one network); do not "fix" it by attaching a normal network.
- **Caller.** Until the collection worker exists, `api` is the caller and joins the internal network. Do not enable the profile with hosted keys before the collection worker replaces `api` as the caller (ADR §2.4).
- **Caller secret.** `EXTRACTION_WORKER_SECRET` for the caller side is added by the owner by hand; this change does not wire it into `api`.
- **Env-file separation** (worker never reads `.env.production`, `api` never reads `.env.extraction-worker`) is not machine-checked: `docker compose config` inlines env files, so the resolved config cannot show it. Review compose diffs for it.
