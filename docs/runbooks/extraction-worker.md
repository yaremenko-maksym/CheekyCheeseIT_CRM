# Extraction worker, hosted-only (owner-run, A3: production)

**For:** the owner. **No agent runs any step here on the production server unasked.**
**Spec:** `docs/architecture/2026-11-03-extraction-model-router.md` §2.4 (network, secret, no published port), §3.3 (key hygiene), §8.6 (separate project, owner-run install), Amendment 2026-11-08 H.4 (the worker stays, the local runtime goes). Owner decision 2026-11-17: the worker gets its own egress network and `api` is its caller now (see "What changed against the ADR").
**State after merge:** the worker lives in `docker-compose.extraction.yml`, compose project `crm-extraction`. No deploy names that file or that project, and the deploy does not copy the file to the server. The deploy writes the worker's URL and secret into the API's env only when the GitHub secret `EXTRACTION_WORKER_SECRET` is set. Nothing else here happens until you run it.

## Precondition: the worker image must be hosted-only (5.4c-H1)

The router is hosted-only since task 5.4c-H1 of the ADR (PR #1381). `routerConfigSchema` (`packages/inference/src/router/config.ts`) has no `local` route and no `floorBudgetMs`, and it is strict: a config that still carries either is refused, never stripped (H.1). The worker runs the `api` image at the tag you pin (step 3), so pin an image built from a commit that contains 5.4c-H1. An older image refuses the hosted-only sample below.

What a refused config looks like, on an older image or with a stale config:

- The worker starts and listens. Its log line `HOSTED_ROUTES` shows `"present":[]`.
- `/extract`, `/resume-write` and `/visual-check` are answered as not configured, and the readiness preflight answers `NO_ROUTE`. `api` reads both as "unavailable", which is what happens with no worker at all. Nothing reaches a provider.

Do not add a `local` route or `floorBudgetMs` to a config: both are refused.

**The API side.** When the worker URL and secret are set, the collection side's env schema (`buildModelExtraction` in `apps/api/src/job-sourcing/structuring/model-extraction-wiring.ts`) also requires `EXTRACTION_INPUT_CONTEXT_TOKENS` and `EXTRACTION_INPUT_MAX_ANSWER_TOKENS` (H.4). They size the input ceiling: the page is cut to fit the smallest configured hosted window. The deploy writes both together with the URL and the secret (step 6). Without them that wiring refuses and names the two keys. The deploy writes `JOB_ROLE_AI_ENABLED=true` in the same conditional block (step 6), because the role-AI pass calls this worker's `/classify-roles` route: with no worker secret the key stays unset and the pass stays off.

The sample config below is checked against the router's schema by the `Guard Tests` CI job on every pull request that changes code and on every push to `main`; a pull request that changes only docs (this runbook alone, say) skips that job, so its sample is checked after the merge, on the push to `main`. `scripts/devops/check-extraction-router-sample.mjs` runs it through the worker's own env parse and fails unless every route is kept, and with `--deploy` it also fails when the input window `deploy.yml` writes (`EXTRACTION_INPUT_CONTEXT_TOKENS` / `EXTRACTION_INPUT_MAX_ANSWER_TOKENS`) is not this sample's smallest route (`scripts/devops/tests/test-check-extraction-router-sample.sh`). Change a route's `contextTokens` or `maxAnswerTokens` here and in `deploy.yml` together. The off-by-default `openrouter` route object below is checked by the same job and the same test: it is spliced into the sample's `routes` and the router must keep it.

## What the compose file gives you

- **One service, `extraction-worker`.** It runs the `api` image at a tag you pin, with the command `node dist/extraction-worker/main`.
  - Limits: 512 MiB of memory with no swap above it, 0.5 CPU, 64 processes.
  - Read-only root filesystem. The only writable places are its state volume and a 16 MiB `/tmp` mounted `noexec,nosuid`.
  - Runs as `node` (the image's own user, stated in the file), `no-new-privileges`, all capabilities dropped, no published port.
- **Its env comes from its own file**, `.env.extraction-worker`, never from `.env.production`. That file holds the worker's provider keys. Three of those names the API also holds in its own env for its own inference — `OPENROUTER_API_KEY`, `CLOUDFLARE_AI_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, the last an identifier rather than a credential (`apps/api/src/config/env.ts`, written by `deploy.yml`); the rest are the worker's alone. The worker holds no database credential.
- **Router state** lives on the volume `crm-extraction_worker_state`.
- **The pin `EXTRACTION_WORKER_IMAGE_TAG`** is the only pin, and it is required: unset, compose refuses to start.
  - It is the same tag the deploy gives `api`: the full git commit SHA it was built from. Read the running one with `docker inspect -f '{{.Config.Image}}' crm-api-1`.
- **Network `crm-extraction-entry`** (`internal: true`) holds the worker and its caller, `api`. On it the worker carries the alias `crm-extraction-worker`.
- **Network `crm-extraction_egress`** (not internal) is the worker's way out to the hosted providers. It holds the worker and nothing else. It has no fixed name, so compose scopes it to this project and it can never be a main-stack network such as `crm_backend`. Its subnet is pinned to `10.250.17.0/28` (outside Docker's default pools), so the later host egress firewall can target it. If that range is already used on the host, `up` fails with an overlap error: pick a free range and change the file and the guard together.

### How `api` reaches the worker

Neither project's compose file names the other.

- The extraction project owns `crm-extraction-entry`.
- Right after its `up -d --remove-orphans`, the deploy script attaches the `api` container to that network with `docker network connect`. If the network does not exist, it does nothing.
- It attaches only to the network this project created: `internal`, and labelled `com.docker.compose.project=crm-extraction`. A same-named network without both gets a warning and no attach.
- A failed attach is a warning, never a failed deploy.

So:

- A deploy's `down --remove-orphans` (the network-reset path) only meets containers of its own project on its own networks.
- The main stack starts whether or not the extraction project exists.
- A deploy never stops or recreates the worker.

**`api` calls the worker at `http://crm-extraction-worker:3100`.** The deploy writes that URL, together with the secret, into `.env.production`, and only when the GitHub secret is set. The host is not free to choose: the API's transport sends plain HTTP to one host only, `crm-extraction-worker` (`EXTRACTION_WORKER_HOST` in `packages/inference/src/http/bounded-request.ts`). Any other host, `extraction-worker` included, is refused as `transport` before the request leaves `api`. That is why the worker carries the alias.

**Limits of this design:**

- **An `api` recreated outside the deploy script** (by hand, or by a rollback to a revision older than this change) is not attached. Attach it by hand: `docker network connect crm-extraction-entry crm-api-1`.
- **The extraction project's own `down`** exits 0 while `api` is attached, but leaves `crm-extraction-entry` behind. Disconnect first (see Undo).
- **A deploy does not update the worker.** Its image tag is the pin. When `api` and the worker run different images, the worker refuses a request whose table version differs. Move the pin and recreate the worker. The role-AI pass needs a worker image that has the `/classify-roles` route (PR #1382), so after the deploy that first writes `JOB_ROLE_AI_ENABLED=true`, move the pin and recreate the worker before the pass can classify anything. Do it in the same window as that deploy: until then every call answers 404, each failure counts toward the per-vacancy cap (`ROLE_AI_MAX_ATTEMPTS`, 10), and a vacancy that reaches the cap stays `PENDING` for that classifier version. Each 404 also spends one call of the day's `JOB_ROLE_AI_DAILY_BUDGET` (default 18) and is not refunded, so a few hours of a worker without the route use up the UTC day: after the pin moves, classification resumes at 00:00 UTC, not at once. Evidence of the mismatch: `ROLE_AI_FAILED` log events with status 404 from `api`.
- **Env-file separation is not machine-checked.** The worker never reads `.env.production`, and `api` never reads `.env.extraction-worker`. `docker compose config` inlines env files, so the resolved config cannot show this. Review compose diffs for it.

**Guard:** `scripts/devops/check-extraction-worker-compose.mjs` (run by `scripts/devops/tests/run-guard-tests.sh`). It fails if:

- the composed deploy configuration gains a service, an extraction network or an external network;
- the deploy script or `deploy.yml` names this file or this project (the names `crm-extraction-entry` and `crm-extraction-worker` are allowed);
- the extraction file gains a service, a port or a network, or loses any hardening property above;
- the worker sets a key outside the reviewed allow-list (the keys the shipped file uses), such as `devices`, `group_add`, `volumes_from`, `sysctls`, `cgroup_parent`, `oom_kill_disable`, `runtime`, `secrets` or `configs`, or the file gains top-level `secrets` or `configs`;
- the top-level `worker_state` volume sets anything: a `driver`, `driver_opts` (a bind of a host path), `external`, `name` or `labels`;
- the worker gains a bind mount or a second volume, an `env_file` other than `.env.extraction-worker`, a `DATABASE_URL` or `POSTGRES_*` key, a user other than `node`, `extra_hosts`, `pid` / `ipc` / `uts` / `userns_mode` / `cgroup`, any `security_opt` beyond `no-new-privileges`, or a `/tmp` without `noexec` and `nosuid` or with `exec`, `suid` or `dev` among its options;
- the worker loses its alias `crm-extraction-worker`;
- the egress network becomes internal, external, fixed-named, or loses its pinned subnet.

**Deploy preflight:** `scripts/devops/check-extraction-worker-secret.sh` runs in Deploy before anything is written on the server. Unset, it passes. Set, the secret must meet the API's rule (at least 32 characters, at least 8 distinct) and use only `A-Z a-z 0-9 . _ -`, or the deploy stops. A `$`, a quote, `#` or a backslash reads differently in the worker's env file and in `.env.production`, so the two sides would hold different secrets and every call would get 401. It never prints the value.

**Rehearsal:** `.github/workflows/rehearse-extraction-deploy.yml` runs both deploy paths on a disposable runner with the project up. It checks:

- the worker URL on the `EXTRACTION_WORKER_URL=` line of `deploy.yml` has the host the API's transport accepts;
- `api`, using the URL and the secret from its own env, is refused without the secret (401) and let in with it (400 for an empty body, before any model call);
- the worker reaches outside;
- the worker cannot reach postgres;
- `api` is not on the egress network;
- the worker's log carries no key value.

## What changed against the ADR (owner decision 2026-11-17)

The runtime-era runbook listed two "interim limits" to close before hosted keys. The owner decided on 2026-11-17 to enable hosted routes without waiting for either:

| ADR / old runbook said                                                                                                                                                                             | Now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Egress.** Both networks internal. Hosted egress must be an allow-listed path to the pinned provider hosts only (ADR §4 item 5, the 5.4c-5 scope). "Do not fix it by attaching a normal network." | The worker has a normal outbound network of its own. **Egress is not allow-listed**: the worker can open a connection to any host. That includes every host service listening on `0.0.0.0` (nginx on 80 and 443, sshd on 22, and so on), reached through the network gateway `10.250.17.1`, and the cloud metadata address `169.254.169.254`; the Hetzner cloud firewall does not filter container-to-host traffic, so it gives no protection here. The owner accepted this on 2026-11-17 as a temporary deviation from the ADR, until a later DevOps task adds a host egress allow-list for the pinned subnet `10.250.17.0/28`, or an egress proxy. That allow-list needs rules in two chains: `DOCKER-USER` (FORWARD) for traffic leaving the host, and `INPUT` for traffic to the host itself (`10.250.17.1:22` and every other host service never passes FORWARD, so `DOCKER-USER` alone does not stop it). What still holds: no other container is on that network, it is not a main-stack network, and the worker has no route to postgres (asserted by the rehearsal).                                                                        |
| **Caller.** "Do not put hosted keys in the worker before the collection worker replaces `api` as the caller" (ADR §2.4). The 5.4c-5 scope also says "the API env without the secret".              | `api` stays the caller and holds `EXTRACTION_WORKER_SECRET` (written by the deploy; accepted by the owner on 2026-11-17). `GEMINI_API_KEY`, `GROQ_API_KEY` and `EXTRACTION_ROUTER_CONFIG` are in the worker only: `api` refuses the first two and `ROUTER_LOCAL_MODEL_URL` in its own env (`WORKER_ONLY_ENV_KEYS`). **Not every provider key is in the worker only:** `deploy.yml` also writes `CLOUDFLARE_AI_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `OPENROUTER_API_KEY` into the API's env, and the API's resume path (`resume-ai.service.ts`) calls Cloudflare with that token. `OPENROUTER_API_KEY` is the same kind of shared name: the worker may hold one of its own for the `openrouter` route while the API keeps a different one for its own inference, and then either can be revoked alone. That holds only while the two values really are two different keys — no CI guard checks it; step 7 does, on the server, by comparing the two values' digests (see the key table). The hostile-page process that sends calls through the worker is `api` itself, so §2.4's split between the page parser and the keys rests on the secret alone. |

## Install (production)

Run these in order, on the server in `/opt/crm` unless the step says otherwise.

### 1. Generate the shared secret

Generate the secret on your machine with the command below and keep it for steps 2 and 6. It must be at least 32 characters with at least 8 distinct ones, and only `A-Z a-z 0-9 . _ -`; anything else makes Deploy stop at its preflight. The hex output meets all three.

```bash
openssl rand -hex 32
```

**Do not add it to GitHub yet.** Deploy also runs on every push to `main` and on a schedule, so a secret added now would reach `api` before the worker exists. It goes to GitHub in step 6, after the worker is up.

### 2. The worker env file (0600)

```bash
umask 177
touch .env.extraction-worker && chmod 600 .env.extraction-worker
stat -c '%a' .env.extraction-worker      # expect 600
```

Fill it with an editor. Never paste values into a command line or a chat. The keys:

| Key                             | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXTRACTION_WORKER_SECRET`      | the value you generated in step 1 (it goes to GitHub in step 6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `INFERENCE_EXTRACTION_PROVIDER` | `router` (anything else and the worker refuses to start)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `EXTRACTION_ROUTER_CONFIG`      | the route parameters as one line of JSON (sample below). No key, base URL or account id in it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GEMINI_API_KEY`                | the Gemini key (AI Studio)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GROQ_API_KEY`                  | the Groq key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `CLOUDFLARE_ACCOUNT_ID`         | 32 lower-case hex. Any other form drops the Cloudflare route with a `ROUTE_ENV_WARNING` line (below): check `HOSTED_ROUTES` in step 7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `CLOUDFLARE_AI_TOKEN`           | a **new** token of its own, Workers AI scope only. Not the API's token. Read "Cloudflare quota and billing" first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `OPENROUTER_API_KEY`            | the OpenRouter key, for the `openrouter` route below. Stays unused until the config names that route. **Not worker-only:** the API reads this same name for its own inference. **Give the worker a key of its own** (its own OpenRouter key, its own $0 `limit`): then a worker-side incident is one revocation and the API's own inference and resume paths go on. One key pasted into both files couples them — revoking it for the worker also stops the API, and removing it from the worker file leaves the same key live in the API. Removing a key from `.env.extraction-worker` or from the repo secrets stops its use here but does not revoke it: it stays valid at the provider, so on a suspected leak revoke (or delete) it in the provider's console (OpenRouter keys page; Cloudflare API tokens page). No CI guard checks the split; step 7 does, on the server. Both files hold the same name, so the worker-only leak count in step 7 must not count it. Its USD `limit` must be $0 — the backstop behind the free-model checks (ADR §3.5, check 4) |

A missing Cloudflare token or account id drops the Cloudflare route — missing, not blank: a blank `CLOUDFLARE_AI_TOKEN=` stops the whole worker instead (see "An empty key is worse than an absent one" below). The worker logs a `ROUTE_ENV_WARNING` line at start, with the route and the reason but never the value, for: a malformed account id (`ACCOUNT_ID_MALFORMED`), an account id missing while the token is set (`ACCOUNT_ID_MISSING`), and a token missing while the account id is set (`TOKEN_MISSING`). A token and an id both missing logs nothing. After the start check that `cloudflare` is in the `present` list of the worker's `HOSTED_ROUTES` log line.

Do **not** set `ROUTER_LOCAL_MODEL_URL`, `LOCAL_MODEL_KEY` or `LOCAL_MODEL_NAME`: there is no local runtime. A missing provider key drops that one route without an error.

**An empty key is worse than an absent one.** `GEMINI_API_KEY=`, `GROQ_API_KEY=`, `OPENROUTER_API_KEY=` or
`CLOUDFLARE_AI_TOKEN=` with nothing after the `=` fails the worker's env schema (`extractionWorkerEnvSchema`, each of
those four `z.string().min(1).optional()`), and the worker refuses to start with `ROUTER_ENV`: every route goes down,
not just that one. To drop a single route, leave its line out of the file entirely; blanking it is never the way to
turn one provider off.

`CLOUDFLARE_ACCOUNT_ID` is the one exception. It carries no `min(1)`, so a blank value passes the schema and only drops
the Cloudflare route, logged as `ACCOUNT_ID_MALFORMED` (`routerEnvWarnings`); the worker still starts.

**This file is the worker's alone, and a shared one stops the API.** The API's `validateEnv` throws on any non-empty
worker-only key (`WORKER_ONLY_ENV_KEYS`: `GEMINI_API_KEY`, `GROQ_API_KEY`, `ROUTER_LOCAL_MODEL_URL`) in its own env, so
pointing `api` at this file, or copying those keys into `.env.production`, stops the API at start. `OPENROUTER_API_KEY`,
`CLOUDFLARE_AI_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are not on that list: the API reads all three for its own inference.

**Sample `EXTRACTION_ROUTER_CONFIG`** (one line in the file):

```
EXTRACTION_ROUTER_CONFIG={"policyVersion":"hosted-2026-11-17","hostedBudgetMs":90000,"routes":[{"provider":"gemini","models":["gemini-2.5-flash","gemini-2.5-flash-lite"],"contextTokens":32000,"structuredOutput":"json_schema","minGapMs":4000,"timeoutMs":30000,"maxAnswerTokens":2000,"freeLimit":{"requestsPerDay":20}},{"provider":"groq","models":["openai/gpt-oss-120b","openai/gpt-oss-20b"],"contextTokens":8000,"structuredOutput":"json_schema","minGapMs":2000,"timeoutMs":30000,"maxAnswerTokens":2000,"freeLimit":{"requestsPerDay":1000,"tokensPerDay":200000}},{"provider":"cloudflare","models":["@cf/mistralai/mistral-small-3.1-24b-instruct","@cf/openai/gpt-oss-20b","@cf/google/gemma-4-26b-a4b-it"],"contextTokens":16000,"structuredOutput":"none","minGapMs":2000,"timeoutMs":30000,"maxAnswerTokens":2048,"freeLimit":{"requestsPerDay":16}}]}
```

What the fields mean, and what to check before you use the sample:

- **Route order** is the call order: gemini first, then groq, then cloudflare. Each provider appears once. The `openrouter` route below is not in the sample; added, it goes last, so it is tried only after those three.
- **`freeLimit`** is the provider's published free limit. The router's own cap is 50 % of it.
  - Gemini's numbers change often. Read them on AI Studio's rate-limit page and set `requestsPerDay` to what it shows for the first model. The sample's `20` is a conservative placeholder.
  - Groq: read the limits page of the Groq console for the first model. The sample's `1000` requests and `200000` tokens a day are placeholders, not a verified figure.
  - Cloudflare: the router refuses a `requestsPerDay` that does not fit 10 000 Neurons a day at full context and full answer. With `contextTokens` 16000 and `maxAnswerTokens` 2048, 16 fits and 17 is refused.
- **`models`** must match each provider's id pattern:
  - gemini: `gemini-<version>-flash|flash-lite|pro`;
  - groq: `openai/gpt-oss-20b|120b`;
  - cloudflare: `@cf/<org>/<model>`;
  - openrouter: `<author>/<model>:free`. Every other suffix (`:online`, `:nitro`, `:extended`, `:thinking`, …) and every id authored by `openrouter` itself (`openrouter/auto`, `openrouter/free`) are refused (ADR §3.5).
- **`structuredOutput` is `none` for cloudflare.** Its models are not asked for a JSON schema.
- **Time limits.** `timeoutMs` is at most 120000. `hostedBudgetMs` is at most 120000 and must be at least the largest `timeoutMs` of any route: the budget holds one whole request of the slowest route. There is no `floorBudgetMs`; a config with it is refused.
- **Input window.** The deploy sizes the API's input ceiling for the smallest window in this sample: groq, `contextTokens` 8000 and `maxAnswerTokens` 2000 (the least room left for the input). If you add a route with less room, change the two values in `deploy.yml` with it. A page cut too small only wastes room; one too large for a route is skipped on that route and tried on the next.

**The `openrouter` route (not in the sample above — off until you add it).** Free models only, and `dataCollection` is
required on this route with no default, set to `allow` (ADR §3.5, H.9 / D11). Under `allow` no
provider-side setting stands behind the contact-stripping guard, so this route carries the redaction
limits recorded in H.9. To enable it, append this object to `routes` after the `cloudflare` route
**and** put `OPENROUTER_API_KEY` in this file; leave either out and the route stays off (a missing
key drops this route alone, without an error):

```
{"provider":"openrouter","models":["meta-llama/llama-3.3-70b-instruct:free"],"contextTokens":32000,"structuredOutput":"json_schema","minGapMs":3000,"timeoutMs":30000,"maxAnswerTokens":2000,"freeLimit":{"requestsPerDay":50},"dataCollection":"allow"}
```

Its room for the input is 30000 (`contextTokens` 32000 less `maxAnswerTokens` 2000), well above groq's 6000, so adding
it leaves the input window in `deploy.yml` where it is. `requestsPerDay` 50 is OpenRouter's `:free` allowance on an
account that bought no credits; the router's own cap is half of it, 25. The 1000-a-day allowance applies only after
a purchase of at least $10 of credits. The owner has not bought them yet (2026-11-18) and will once real use shows
the 50-a-day cap is the bottleneck: a one-off $10 that raises the cap twentyfold is the obvious cheap way to scale
this route. The credits only raise the free-model allowance; the key's USD `limit` stays $0, so nothing is billed.
Until that purchase, do not raise the number, or the route spends its day on 429s.

Check that the line is valid JSON without printing it:

```bash
sed -n 's/^EXTRACTION_ROUTER_CONFIG=//p' .env.extraction-worker | python3 -m json.tool >/dev/null && echo JSON OK
```

### 3. Copy the compose file and write the pin

The deploy does not copy it. From a checkout at the merged commit, on your machine:

```bash
scp docker-compose.extraction.yml crm-vps:/opt/crm/
```

Then, on the server, write the pin (no secret in this file):

```bash
printf 'EXTRACTION_WORKER_IMAGE_TAG=%s\n' "$(docker inspect -f '{{.Config.Image}}' crm-api-1 | sed 's/.*://')" > .env.extraction-pins
cat .env.extraction-pins     # one line, the 40-hex tag api runs now
```

### 4. State volume ownership (once)

The worker image runs as `node`, and a fresh named volume is owned by root.

```bash
docker compose -f docker-compose.extraction.yml --env-file .env.extraction-pins run --rm --no-deps \
  --user root --cap-add CHOWN --entrypoint chown extraction-worker \
  node:node /var/lib/extraction-worker
```

### 5. Start

```bash
docker compose -f docker-compose.extraction.yml --env-file .env.extraction-pins up -d
docker logs crm-extraction-extraction-worker-1 2>&1 | tail -5
```

Expect a `LISTENING` line. A refusal names the bad key (`refusing to start, bad SECRET`, for example), never its value.

### 6. Add the GitHub secret, then deploy (attaches `api` and gives it the secret)

Only now, with the worker listening, add the secret of step 1 as the repository secret `EXTRACTION_WORKER_SECRET` (Settings, then Secrets and variables, then Actions).

Then run the Deploy workflow once (Actions, then Deploy, then Run workflow on `main`). Its preflight checks the secret's shape without printing it. It writes `EXTRACTION_WORKER_URL=http://crm-extraction-worker:3100`, the secret, `EXTRACTION_INPUT_CONTEXT_TOKENS`, `EXTRACTION_INPUT_MAX_ANSWER_TOKENS` and `JOB_ROLE_AI_ENABLED=true` into `.env.production`, recreates `api` with them, and attaches `api` to `crm-extraction-entry`. Its log shows `extraction entry: api attached`. Every later deploy re-attaches `api` by itself.

Attaching by hand (`docker network connect crm-extraction-entry crm-api-1`) is not enough on the first install: without a deploy, `api` does not have the secret yet.

### 7. Checks

```bash
EXT='docker compose -f docker-compose.extraction.yml --env-file .env.extraction-pins'
WK="$($EXT ps -q extraction-worker)"
: "${WK:?FAIL: the worker is not running}"

# no published port (expect no output)
docker port "$WK"

# the worker's networks (expect exactly: crm-extraction-entry crm-extraction_egress)
docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$WK"
# who is on each (expect api and the worker on entry; the worker alone on egress)
docker network inspect crm-extraction-entry --format '{{range .Containers}}{{.Name}} {{end}}'
docker network inspect crm-extraction_egress --format '{{range .Containers}}{{.Name}} {{end}}'

# api's own worker URL has the one host its transport accepts (expect: crm-extraction-worker)
docker exec crm-api-1 node -e 'console.log(new URL(process.env.EXTRACTION_WORKER_URL).hostname)'
# api, at its own URL: without the secret (expect 401), then with its own secret (expect 400:
# let in, the empty body refused before any model call). Both values come from api's env.
W='const a=process.argv[1]==="auth";fetch(process.env.EXTRACTION_WORKER_URL+"/extract",{method:"POST",headers:{"content-type":"application/json",...(a&&{authorization:"Bearer "+process.env.EXTRACTION_WORKER_SECRET})},body:"{}",signal:AbortSignal.timeout(10000)}).then(r=>console.log(r.status),e=>console.log(e.cause?.code||e.name))'
docker exec crm-api-1 node -e "$W" anon
docker exec crm-api-1 node -e "$W" auth

# the secret is set on both sides (expect a count of 1 for each file), then compared by digest (expect SAME)
grep -c '^EXTRACTION_WORKER_SECRET=.' .env.production .env.extraction-worker
[ "$(sed -n 's/^EXTRACTION_WORKER_SECRET=//p' .env.production | sha256sum)" = \
  "$(sed -n 's/^EXTRACTION_WORKER_SECRET=//p' .env.extraction-worker | sha256sum)" ] && echo SAME || echo DIFFERENT

# the shared names: one key on both sides, or two. Compares what each running container holds (after compose
# parsed the env file: quotes, duplicate lines), hashed inside the container. Prints the name and SHARED / SEPARATE,
# or which side is unset / not read, never a value or a digest. Expect SHARED or SEPARATE for a name set on both sides.
# SHARED is a legitimate owner choice, and the operator must know it before relying on "revoked alone".
# Treat `not read` as unresolved, never as "uncoupled": fix the container, then run the loop again.
H='const v=process.env[process.argv[1]];console.log(v?require("crypto").createHash("sha256").update(v).digest("hex"):"unset")'
side() { case "$1" in unset) echo unset ;; '') echo 'not read' ;; *) [ "${#1}" -eq 64 ] && echo set || echo 'not read' ;; esac; }
for k in OPENROUTER_API_KEY CLOUDFLARE_AI_TOKEN; do
  a="$(docker exec crm-api-1 node -e "$H" "$k")"; w="$(docker exec "$WK" node -e "$H" "$k")"
  [ "$(side "$a")$(side "$w")" = setset ] || { echo "$k: api $(side "$a"), worker $(side "$w")"; continue; }
  [ "$a" = "$w" ] && echo "$k: SHARED" || echo "$k: SEPARATE"
done

# By address, not by name: a name-resolution error proves nothing about routing.
TCP='const [h,p]=process.argv.slice(1);const s=require("net").connect({host:h,port:+p,timeout:5000});s.on("connect",()=>{console.log("CONNECTED");s.destroy()});s.on("timeout",()=>{console.log("ETIMEDOUT");s.destroy()});s.on("error",e=>console.log(e.code))'
PG_IP="$(docker inspect -f '{{with index .NetworkSettings.Networks "crm_backend"}}{{.IPAddress}}{{end}}' crm-postgres-1)"
# an empty address makes net.connect fall back to localhost and look like a pass; on FAIL, stop here
: "${PG_IP:?FAIL: no postgres IP}"
# positive control: api reaches postgres (expect CONNECTED; anything else voids the next check)
docker exec crm-api-1 node -e "$TCP" "$PG_IP" 5432
# the worker cannot reach postgres (expect an error code, never CONNECTED)
docker exec "$WK" node -e "$TCP" "$PG_IP" 5432
# the worker gets out (expect CONNECTED)
docker exec "$WK" node -e "$TCP" generativelanguage.googleapis.com 443

# which hosted routes the worker ended up with (names only)
docker logs "$WK" 2>&1 | grep HOSTED_ROUTES | tail -1

# the API container holds none of the worker-ONLY keys (expect "leaked: 0"; "env not read" is NOT a pass)
if API_ENV="$(docker exec crm-api-1 env)" && [ -n "$API_ENV" ]; then
  printf 'leaked: %s\n' "$(printf '%s\n' "$API_ENV" | grep -c -E '^(GEMINI_API_KEY|GROQ_API_KEY|ROUTER_LOCAL_MODEL_URL|EXTRACTION_ROUTER_CONFIG)=.+' || true)"
else
  echo 'env not read'
fi
```

**`leaked: 0` is the only pass, and `env not read` is not one.** A bare `docker exec ... | grep -c` prints `0` when the
exec itself fails — the container stopped, renamed or crash-looping — because `grep` counts an empty input, and that
reads exactly like a clean answer. The block above reads the env into `API_ENV` first and refuses when it is empty, so
"clean" and "did not look" are two different lines.

**Treat `env not read` as unresolved, never as clean.** A non-empty worker-only key in the API's env is precisely what
stops the API at start (`validateEnv` throws before the schema parse), so the one leak shape that matters leaves no
container to exec into. On that line, read `docker ps` and the API's start log for its refusal line, which names the
key and reads `worker-only key, not allowed in the API env`, before concluding anything.

**The pattern counts non-empty values only (`=.+`), and `leaked: 0` holds once the `openrouter` route is enabled, by
design.** An empty `GEMINI_API_KEY=` in the API's env is accepted by `validateEnv` and is not this leak, so counting it
would report a tolerated configuration as one. `OPENROUTER_API_KEY`, `CLOUDFLARE_AI_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
are deliberately outside the pattern: `deploy.yml` writes all three into the API's env for the API's own inference, so
counting them would report the intended configuration as a leak. The check covers the names whose non-empty presence in
the API's env is fatal (`WORKER_ONLY_ENV_KEYS`), plus `EXTRACTION_ROUTER_CONFIG`, which the API ignores but which
belongs in the worker alone. Do not add the three shared names to it.

`HOSTED_ROUTES` lists the routes whose key arrived under `present` and the rest under `absent`. None under `present` means the router refused the config (see the Precondition).

### 8. Undo

Run these in order:

```bash
docker network disconnect crm-extraction-entry crm-api-1
docker compose -f docker-compose.extraction.yml --env-file .env.extraction-pins down
for n in crm-extraction-entry crm-extraction_egress; do docker network inspect "$n" >/dev/null 2>&1 && echo "$n LEFT" || echo "$n gone"; done
```

Then remove the GitHub secret `EXTRACTION_WORKER_SECRET` and run the Deploy workflow once. The deploy rewrites `.env.production` without the URL and the secret, and `api` is back to today's behaviour.

- **`down` without `-v`.** The worker's state volume stays. Never add `-v` here.
- **Without the disconnect**, `down` still exits 0 but leaves the entry network on the host with `api` on it.
- **The privacy rollback** is faster: remove `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` and `CLOUDFLARE_AI_TOKEN` from `.env.extraction-worker`, then run `docker compose -f docker-compose.extraction.yml --env-file .env.extraction-pins up -d --force-recreate`. Text already sent is not recalled. Removing a key from a file or a repo secret does not revoke it: it stays valid at the provider. On a suspected leak, also revoke (or delete) the key in the provider's console (OpenRouter keys page; Cloudflare API tokens page); if the worker and the API share that value, revoking it stops the API's path too. This stops the worker's hosted calls only: the API keeps its own `OPENROUTER_API_KEY` and `CLOUDFLARE_AI_TOKEN` in `.env.production`, and its own inference goes on. To stop that too, remove (or blank) the **GitHub repo secrets** `OPENROUTER_API_KEY` and `CLOUDFLARE_AI_TOKEN` first, then run the Deploy workflow — the same move as the `EXTRACTION_WORKER_SECRET` undo above. Both are optional on both sides — `write-env` appends each one only when it is set, the deploy's Workers AI token check skips when unset, and the API's own env declares both optional (an absent `CLOUDFLARE_AI_TOKEN` turns resume AI off and uploads end as `AI_NOT_CONFIGURED`; an absent `OPENROUTER_API_KEY` leaves the API's OpenRouter inference unconfigured; neither fails boot) — so the deploy stays green and the API still starts without them. Editing `.env.production` on the server alone is undone by the next deploy: `write-env` rewrites that file from scratch and re-appends both names from the repo secrets, so any later push to `main` restores the keys with no error. Leave the repo secret `CLOUDFLARE_ACCOUNT_ID` in place — it is an identifier, and the deploy also builds `MEETING_RECORDER_MEDIA_S3_ENDPOINT` from it.
- **Left behind after undo:** the volume `crm-extraction_worker_state`, and the files `docker-compose.extraction.yml`, `.env.extraction-pins` and `.env.extraction-worker`. Delete `.env.extraction-worker` if you no longer want the keys on the server.

## Cloudflare quota and billing (check before enabling)

Facts verified 2026-11-17 against Cloudflare's docs ([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [errors](https://developers.cloudflare.com/workers-ai/platform/errors/)):

- **Workers AI gives 10 000 Neurons a day free on both plans.** The count resets at 00:00 UTC.
- **On Workers Free, use above that fails** with error 3036 (HTTP 429). Nothing is billed.
- **On Workers Paid, use above 10 000 a day is billed** at $0.011 per 1 000 Neurons, **with no cap**.
- **The account is on Workers Free today.** In the 2026-11-17 probe, the paid-only models answered `5035 ... not available on the Workers Free plan`.
- **The production token is scoped to Workers AI only.** It cannot read billing, so the plan cannot be read with it directly; the check below infers the plan from the paid-only refusal.

**Upgrading the account to Workers Paid, for any product, makes the AI overage billable.** After that, the app's own daily caps are the only limit on the bill. A bug or a config error in those caps would then cost money instead of failing with 3036.

**Two tokens, one allowance.** Give the worker a Cloudflare token of its own (Workers AI scope only), not the API's `CLOUDFLARE_AI_TOKEN`: then either can be revoked alone. Both tokens draw on the same account, so they share the same 10 000 Neurons a day. The caps on the two callers:

- the router in the worker: 50 % of the cloudflare route's `freeLimit.requestsPerDay`;
- the API's resume path: 10 Cloudflare calls a day, from PR #1378 (open, not merged on 2026-11-17). Until it merges, that path has no daily cap of its own.

### One-command plan check (on the server)

```bash
bash scripts/devops/check-cloudflare-ai-plan.sh /opt/crm/.env.extraction-worker
```

Run it from a checkout, or copy the script to the server next to the compose file. It reads `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_TOKEN` from the file by name, and passes the token to `curl` on stdin.

It sends one request to a model Cloudflare serves on Workers Paid only (`@cf/zai-org/glm-5.2`; Kimi K2.6, Kimi K2.7 Code and GLM-5.2 require Workers Paid since 2026-07-28, per Cloudflare's changelog), with `max_tokens: 1`. On Free it is refused and costs nothing. On Paid it is answered and counts against the day's 10 000 free Neurons; once those are used up, each run bills a negligible amount. So on Paid the line carries a warning: do not run it in a loop.

It prints one line and never prints the token, the account id or the response:

| Line                   | Exit | Means                                                                                       |
| ---------------------- | ---- | ------------------------------------------------------------------------------------------- |
| `PLAN: Workers Free …` | 0    | the probe was refused with 5035: overage fails, nothing is billed                           |
| `PLAN: Workers Paid …` | 3    | the probe answered: overage is billed with no cap. The line ends with a do-not-loop warning |
| `PLAN: UNKNOWN …`      | 1    | anything else (bad token, wrong account id, the probe model gone); it shows the error codes |

If Cloudflare ever lets Free accounts use that model, the check reports `Workers Paid` for a Free account. That mistake errs toward caution. Override the model with `CF_PLAN_PROBE_MODEL=@cf/<org>/<model>`.

### Where to look in the dashboard

- **Neurons used per day:** Workers AI → [dashboard](https://dash.cloudflare.com/?to=/:account/ai/workers-ai).
- **The plan:** Workers & Pages → Plans.
- **Anything billed:** Billing → Billable usage.
- **An email when spend crosses a threshold:** [spend management](https://developers.cloudflare.com/billing/manage/spend-management/). Set one before any upgrade to Workers Paid.

## MP-04 / MP-03

The harness `scripts/devops/extraction-mp04/` measured a local candidate model against the frozen pass table (result: `docs/runbooks/vacancy-sourcing-measurements.md`, entry MP-04). It was retired with the local route in PR #1381 (5.4c-H1): it imported the worker's local-only router config, which no longer exists. It is in the git history at the commit before that merge.
