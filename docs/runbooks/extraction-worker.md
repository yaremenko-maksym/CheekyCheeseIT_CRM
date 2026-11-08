# Extraction worker and local model (owner-run, A3: production)

**For:** the owner. **No agent runs any step here on the production server unasked.**
**Spec:** `docs/architecture/2026-11-03-extraction-model-router.md` §2.4 (network, secret, no published port), §3.3 (key hygiene), §8.3 (runtime container), §8.6 (separate project, replay).
**State after merge:** the worker and the local model runtime live in `docker-compose.extraction.yml`, compose project `crm-extraction`. No deploy names that file or that project, and the deploy does not copy the file to the server. Nothing in this runbook happens until you run it.

## What the compose file gives you

- Service `crm-model-runtime`: the llama.cpp server, image pinned by `sha256`, weights checked against their digest on every start, read-only weights volume, user `1000:1000`, `no-new-privileges`, all capabilities dropped, request and prompt logging off. Limits: 3584 MiB memory with no swap above it, 2.0 CPUs, 128 processes, 2 threads, one request at a time, one window for the whole server.
- Service `extraction-worker`: the `api` image at a tag you pin, command `node dist/extraction-worker/main`, 512 MiB, 0.5 CPU, same hardening. Env from its own file `.env.extraction-worker`, never `.env.production`. Router state on the volume `crm-extraction_worker_state`.
- Service `weights-fetch`: a one-shot download behind the profile `provision`; a plain `up` never starts it.
- Network `crm-extraction-entry` (`internal: true`): the worker and its caller, `api`. Network `crm-extraction_runtime` (`internal: true`): the worker and the runtime only. No `ports:` anywhere.
- Every pin is required. An unset one makes compose refuse to start, so a forgotten digest cannot fall back to a default.

### How `api` reaches the worker

Neither project's compose file names the other. The extraction project owns `crm-extraction-entry`. The deploy script, right after its `up -d --remove-orphans`, attaches the `api` container to that network with `docker network connect` when the network exists, and does nothing when it does not. A failed attach is a warning, never a failed deploy. So:

- a deploy's `down --remove-orphans` (the network-reset path) only meets containers of its own project on its own networks;
- the main stack starts whether or not the extraction project exists;
- a deploy never stops or recreates the runtime or the worker;
- neither project needs the other to start.

Limits of this design:

- **An `api` recreated outside the deploy script** (by hand, by a rollback to a revision older than this change) is not attached. Attach it by hand: `docker network connect crm-extraction-entry crm-api-1`.
- **The extraction project's own `down`** exits 0 while `api` is attached, but leaves `crm-extraction-entry` behind (rehearsal, phase H). Disconnect first (see Undo).
- **A deploy does not update the worker.** Its image tag is the pin `EXTRACTION_WORKER_IMAGE_TAG`. When `api` and the worker run different images, the worker refuses a request whose table version differs; move the pin and recreate the worker.

Guard: `scripts/devops/check-extraction-worker-compose.mjs` (run by `scripts/devops/tests/run-guard-tests.sh`) fails if the composed deploy configuration gains a service, an extraction network or an external network, if the deploy script or `deploy.yml` names this file or project, or if the extraction file loses any property above.

Rehearsal: `.github/workflows/rehearse-extraction-deploy.yml` runs both deploy paths on a disposable runner with the project up, and records what the first deploy after merge does.

## What the first deploy after merge does

- **`api` is recreated once**, because it leaves the old `extraction-internal` network. That is the normal recreate of every deploy with a new image.
- **The old network `crm_extraction-internal` stays on the host**, unused: `up` does not remove networks. Remove it when you like: `docker network rm crm_extraction-internal`.
- **The old volume `crm_extraction_worker_state`** exists only if the worker was ever created under the old file. It is unused from now on and holds router state only. Keep it or remove it with `docker volume rm crm_extraction_worker_state`; the new worker uses `crm-extraction_worker_state`.

## Install (replay on production)

Run these on the server in `/opt/crm`, in order, only after you confirm the replay. The candidate (image digest, weights URL, weights digest, window) comes from the candidate table of task r5-5.4c-7, and only a candidate that passed MP-04 on the target host.

### 1. Check the host

```bash
free -m                      # "available" must stay above 4500 before you start
docker ps --format '{{.Names}}'
```

### 2. Copy the compose file

The deploy does not copy it. From a checkout at the merged commit, on your machine:

```bash
scp docker-compose.extraction.yml crm-vps:/opt/crm/
```

### 3. Write the pins file (no secret in it)

`/opt/crm/.env.extraction-pins`:

```
EXTRACTION_RUNTIME_IMAGE_SHA256=<64 hex, the index digest of the llama.cpp server image>
EXTRACTION_MODEL_URL=<https URL of the weights file>
EXTRACTION_MODEL_FILE=<file name, for example model.gguf>
EXTRACTION_MODEL_SHA256=<64 hex, the weights digest>
EXTRACTION_RUNTIME_CONTEXT_TOKENS=<the window>
EXTRACTION_WORKER_IMAGE_TAG=<the api image tag the server runs now>
```

### 4. Write the worker env file (0600)

```bash
umask 177
touch .env.extraction-worker && chmod 600 .env.extraction-worker
stat -c '%a' .env.extraction-worker      # expect 600
```

Fill it with an editor; never paste values into a command line or chat. Keys (see "Extraction worker" in `.env.example`):

- `EXTRACTION_WORKER_SECRET`: `openssl rand -hex 32`. At least 32 characters with at least 8 distinct ones, or the worker refuses to start. The caller side gets the same value in the API's env, and nothing else of the worker's.
- `INFERENCE_EXTRACTION_PROVIDER=router`
- `ROUTER_LOCAL_MODEL_URL=http://crm-model-runtime:8080/v1`
- `LOCAL_MODEL_NAME`: the model id you route to.
- `EXTRACTION_ROUTER_CONFIG`: the route parameters as JSON. The local route's `contextTokens` must equal `EXTRACTION_RUNTIME_CONTEXT_TOKENS`, and its `timeoutMs` must stay below 300000.

### 5. Download the weights (checked against the digest)

```bash
docker compose -f docker-compose.extraction.yml --env-file .env.extraction-pins --profile provision run --rm weights-fetch
```

A digest mismatch leaves no file behind and exits non-zero.

### 6. State volume ownership (once)

The worker image runs as `node`; a fresh named volume is root-owned.

```bash
docker compose -f docker-compose.extraction.yml --env-file .env.extraction-pins run --rm --no-deps \
  --user root --cap-add CHOWN --entrypoint chown extraction-worker \
  node:node /var/lib/extraction-worker
```

### 7. Start, then attach `api`

```bash
docker compose -f docker-compose.extraction.yml --env-file .env.extraction-pins up -d
docker network connect crm-extraction-entry crm-api-1
```

Every later deploy re-attaches `api` by itself.

### 8. Checks

```bash
EXT='docker compose -f docker-compose.extraction.yml --env-file .env.extraction-pins'

# no published port (expect no output from either)
docker port "$($EXT ps -q crm-model-runtime)"
docker port "$($EXT ps -q extraction-worker)"

# an unauthenticated call is refused (expect 401), run from the API container
docker exec crm-api-1 wget -S -qO- --post-data='{}' http://extraction-worker:3100/extract 2>&1 | head -3

# api cannot reach the runtime (expect a name-resolution error)
docker exec crm-api-1 wget -qO- -T 5 http://crm-model-runtime:8080/health 2>&1 | head -1

# only api and the worker on the entry network
docker network inspect crm-extraction-entry --format '{{range .Containers}}{{.Name}} {{end}}'

# the API container holds no hosted key and no local-model URL (expect "0")
docker exec crm-api-1 env | grep -c -E '^(ROUTER_API_KEY|ROUTER_LOCAL_MODEL_URL|EXTRACTION_ROUTER_CONFIG)=' || true
```

The worker's log must show it started (a refusal names the key, never its value).

## Undo

```bash
docker network disconnect crm-extraction-entry crm-api-1
docker compose -f docker-compose.extraction.yml --env-file .env.extraction-pins down
docker volume rm crm-extraction_model_weights
```

`down` without `-v`: the worker's state volume stays. Never add `-v` here. Without the disconnect, `down` still exits 0 but leaves the entry network on the host with `api` on it; check with `docker network inspect crm-extraction-entry` (expect "No such network").

**Left behind after undo:** the volume `crm-extraction_worker_state`, the files `docker-compose.extraction.yml`, `.env.extraction-pins` and `.env.extraction-worker`, and the pulled runtime image. Remove the image with `docker image rm ghcr.io/ggml-org/llama.cpp@sha256:<digest>` if you want the disk back. The next deploy finds no entry network and attaches nothing. Any preflight against the worker then fails loudly, as ADR §8.6 requires.

## MP-04 / MP-03: measuring a candidate model

`scripts/devops/extraction-mp04/mp04.mjs` measures one candidate against the frozen pass table (ADR §8.3/§8.4). It feeds the 50 synthetic pages of `fixtures.mjs` through `ModelStructurer.structure` over a local-only router port, the same path the worker takes. A loopback tap between the router and the runtime reads the runtime's reported prompt tokens, speed and reasoning output; it keeps counts only, never page text or replies. The candidates and their pins are in `scripts/devops/extraction-mp04/candidates.md`.

**Where to run it.** On a disposable host with the extraction project up and the candidate's pins in `.env.extraction-pins`; production replay is an owner step (A3). The harness restarts the runtime once (cold load) and needs `docker` and Node 22 on the host. The host must reach the runtime on its internal network: the rehearsal records this as "host -> runtime" (a GitHub-hosted runner does).

```bash
# 1. the api build the worker runs (dist/ + node_modules/), copied out of the worker's image
docker create --name mp04-app "$(docker inspect -f '{{.Config.Image}}' crm-extraction-extraction-worker-1)"
docker cp -q mp04-app:/app ./mp04-app && docker rm mp04-app
# 2. the runtime's address on its internal network
RT_IP="$(docker inspect -f '{{with index .NetworkSettings.Networks "crm-extraction_runtime"}}{{.IPAddress}}{{end}}' crm-extraction-crm-model-runtime-1)"
# 3. one run per candidate, into one output directory
node scripts/devops/extraction-mp04/mp04.mjs --candidate cand.json --api-dist ./mp04-app \
  --runtime-url "http://$RT_IP:8080" --crm-url https://<the CRM host>/api/health --out-dir ./mp04-out
```

`cand.json` carries `name`, `repo`, `file`, `sha256`, `repoCommit`, `licence` (`{ url, verdict }`, the licence as read at the pinned commit) and `routerConfig` (the worker's `EXTRACTION_ROUTER_CONFIG`; any hosted route is dropped, the local `baseUrl` is replaced by the tap).

**The CRM probe** sends unauthenticated GETs to `--crm-url`, one at a time, at most one per `--probe-interval-ms` (default 500, floor 200). First a baseline with the runtime idle (`--baseline-s`, default 60), then the same probe during the run.

**The abort rule** stops the run at once on any probe 5xx, a rolling p95 (last 20 probes) above 2 x the baseline p95, or host available RAM below 800 MiB. A stopped run fails. Never relax a threshold to make a candidate pass.

**Reading the result.** `mp04-out/summary.txt` is one screen: a PASS/FAIL line per candidate, its failing rows, then `passes: ...` or `none passes`. `mp04-out/report.json` has every measured value per candidate. Exit status: 0 = the report is written and this candidate passes; 1 = written, it fails; 2 = harness error. A harness error still writes a report naming the error. An unmeasured value fails its row.

The rehearsal runs the harness against the 1.2 MB test model on four pages as a wiring smoke ("G2"); its expected verdict is FAIL. It is not a measurement of any candidate.

## Known interim limits (close before hosted keys, task 5.4c-5)

- **Egress.** Both networks are `internal: true`, so the worker has no route to hosted providers. Hosted egress must be an allow-listed path added together with the guard (which today requires exactly these two networks); do not "fix" it by attaching a normal network.
- **Caller.** Until the collection worker exists, `api` is the caller and is attached to the entry network. Do not put hosted keys in the worker before the collection worker replaces `api` as the caller (ADR §2.4).
- **Caller secret.** `EXTRACTION_WORKER_SECRET` for the caller side is added by the owner by hand; this change does not wire it into `api`.
- **Env-file separation** (the worker never reads `.env.production`, `api` never reads `.env.extraction-worker`) is not machine-checked: `docker compose config` inlines env files, so the resolved config cannot show it. Review compose diffs for it.
- **Reboot.** The runtime restarts `on-failure` up to three times, so a bad digest cannot loop a multi-GB hash beside the CRM. After a host reboot it does not start by itself; run step 7 again.
