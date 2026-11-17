#!/usr/bin/env bash
# rehearse-extraction-deploy-paths.sh - both deploy paths of deploy-stack-on-vps.sh, run for real on
# a disposable host with the separate extraction project up (ADR 2026-11-03 §8.6, task r5-5.4c-7 AC 5).
#
# Runs on a GitHub-hosted runner (.github/workflows/rehearse-extraction-deploy.yml). Never on the VPS:
# it writes /etc/nginx/certs, creates throwaway secrets and tears containers down.
#
# Needs: docker with compose v2, openssl, sudo, git (full history, for the old compose files), and the
# images named below present locally (the workflow pulls or builds them).
#
# What it proves, each by a command whose output is printed, never by an exit status alone:
#   - the main stack comes up with the extraction project absent, on both deploy paths;
#   - with the project up, the normal path (`up -d --remove-orphans`, same and new image) and the
#     network-reset path (`down --remove-orphans`, then `up`) leave the worker container with the
#     same ID, zero restarts and the same start time; `api` reaches the worker at the URL deploy.yml
#     writes, whose host is the one the API's transport accepts, and the worker takes its secret;
#     the main stack is healthy;
#   - the worker reaches outside on its own egress network (the hosted providers); `api` is not on
#     that network and the worker is on no main-stack network, so it cannot reach postgres; no port
#     is published; the worker's log carries no key value;
#   - the undo leaves the worker's state volume and the main stack healthy;
#   - what the first deploy after merge does to `api` and to the old network and volume.
set -euo pipefail

: "${API_IMAGE:?set API_IMAGE (the api image, tag included)}"
: "${NGINX_IMAGE:?set NGINX_IMAGE (the nginx image, tag included)}"
: "${OLD_COMPOSE_REF:?set OLD_COMPOSE_REF (the commit whose compose files production runs before merge)}"

REPO="$(git rev-parse --show-toplevel)"
WORK="${RUNNER_TEMP:-/tmp}/crm"            # directory name crm = project crm, as /opt/crm on the VPS
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
ENTRY_NET=crm-extraction-entry
EGRESS_NET=crm-extraction_egress
WORKER_NAME=crm-extraction-extraction-worker-1
REGISTRY=ghcr.io/yaremenko-maksym

rm -rf "$WORK" && mkdir -p "$WORK"
cd "$WORK"

log() { printf '\n==> %s\n' "$*"; }
fail() { echo "REHEARSAL FAILED: $*" >&2; printf -- '- FAILED: %s\n' "$*" >> "$SUMMARY"; exit 1; }
record() { echo "$*"; printf -- '- %s\n' "$*" >> "$SUMMARY"; }

# ── The deploy script's own commands ────────────────────────────────────────
# Copied verbatim from deploy-stack-on-vps.sh; asserted present there, so a drift fails this run.
DEPLOY_SCRIPT="$REPO/scripts/devops/deploy-stack-on-vps.sh"
for cmd in 'up -d postgres' 'down --remove-orphans' 'up -d --remove-orphans'; do
  grep -qF -- "$cmd" "$DEPLOY_SCRIPT" || fail "deploy script no longer runs '$cmd': update this rehearsal"
done
sed -n '/^# >>> extraction-entry-attach$/,/^# <<< extraction-entry-attach$/p' "$DEPLOY_SCRIPT" > attach-block.sh
[ "$(wc -l < attach-block.sh)" -gt 5 ] || fail "attach block markers not found in the deploy script"

main() { docker compose -f docker-compose.prod.yml -f docker-compose.ghcr.yml --env-file .env.production "$@"; }
ext() { docker compose -f docker-compose.extraction.yml --env-file .env.extraction-pins "$@"; }
attach() { bash -euo pipefail attach-block.sh; }
deploy_normal() {
  main up -d postgres
  main up -d --remove-orphans
  attach
}
deploy_reset() {
  main down --remove-orphans
  main up -d postgres
  main up -d --remove-orphans
  attach
}

# ── The API's worker URL (CR-H-1) ──────────────────────────────────────────
# The URL deploy.yml writes, and the one plain-HTTP host the API's transport accepts. A mismatch is a
# worker every call refuses as `transport` before it leaves api. Read from the line that writes it,
# not from any quoted URL in the file.
WORKER_URL="$(sed -nE "s|^[[:space:]]*printf 'EXTRACTION_WORKER_URL=%s\\\\n' '(http://[a-z0-9.-]+:[0-9]+)' >> /opt/crm/\\.env\\.production$|\\1|p" "$REPO/.github/workflows/deploy.yml")"
TRANSPORT_HOST="$(sed -n "s/^export const EXTRACTION_WORKER_HOST = '\([^']*\)'.*/\1/p" "$REPO/packages/inference/src/http/bounded-request.ts")"
[ -n "$TRANSPORT_HOST" ] || fail "EXTRACTION_WORKER_HOST not found in packages/inference/src/http/bounded-request.ts"
[ "$(printf '%s\n' "$WORKER_URL" | wc -l | tr -d ' ')" = 1 ] && [ -n "$WORKER_URL" ] || fail "deploy.yml must write exactly one worker URL (found: ${WORKER_URL:-none})"
[ "$WORKER_URL" = "http://$TRANSPORT_HOST:3100" ] || fail "deploy.yml writes $WORKER_URL; the API's transport accepts only http://$TRANSPORT_HOST:3100"
record "worker URL in deploy.yml: $WORKER_URL (host = the API transport's EXTRACTION_WORKER_HOST)"

# ── Setup: env files with throwaway values, certs, compose files ────────────
rnd() { openssl rand -hex 32; }
secret() { local v; v="$(rnd)"; echo "::add-mask::$v" >&2; echo "$v"; }
log "Writing throwaway env files (values never printed)"
PGPW="$(secret)"
WORKER_SECRET="$(secret)"
umask 077
cat > .env.production <<EOF
POSTGRES_PASSWORD=$PGPW
DATABASE_URL=postgresql://crm_user:$PGPW@postgres:5432/crm_db
GOOGLE_CLIENT_ID=rehearsal.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=$(secret)
GOOGLE_CALLBACK_URL=https://app.cheekycheese.tech/api/auth/google/callback
FRONTEND_URL=https://app.cheekycheese.tech
JWT_SECRET=$(secret)
SESSION_SECRET=$(secret)
CREDENTIALS_ENC_KEY=$(secret)
AWS_ACCESS_KEY_ID=$(secret)
AWS_SECRET_ACCESS_KEY=$(secret)
TURNSTILE_SECRET_KEY=$(secret)
TELEMETRY_DIGEST_TOKEN=$(secret)
TELEMETRY_SESSION_SALT=$(secret)
EXTRACTION_WORKER_URL=$WORKER_URL
EXTRACTION_WORKER_SECRET=$WORKER_SECRET
EXTRACTION_INPUT_CONTEXT_TOKENS=8000
EXTRACTION_INPUT_MAX_ANSWER_TOKENS=2000
EOF
# The runbook's file shape, throwaway keys: no call ever reaches a provider with them. The config is
# the runbook's sample, hosted-only (5.4c-H1); check-extraction-router-sample.mjs proves in the guard
# tests that the router accepts it. The log check in C names which hosted routes the worker ended up with.
GEMINI_KEY="$(secret)"
GROQ_KEY="$(secret)"
CF_TOKEN="$(secret)"
cat > .env.extraction-worker <<EOF
EXTRACTION_WORKER_SECRET=$WORKER_SECRET
INFERENCE_EXTRACTION_PROVIDER=router
GEMINI_API_KEY=$GEMINI_KEY
GROQ_API_KEY=$GROQ_KEY
CLOUDFLARE_ACCOUNT_ID=$(openssl rand -hex 16)
CLOUDFLARE_AI_TOKEN=$CF_TOKEN
EXTRACTION_ROUTER_CONFIG={"policyVersion":"hosted-2026-11-17","hostedBudgetMs":90000,"routes":[{"provider":"gemini","models":["gemini-2.5-flash","gemini-2.5-flash-lite"],"contextTokens":32000,"structuredOutput":"json_schema","minGapMs":4000,"timeoutMs":30000,"maxAnswerTokens":2000,"freeLimit":{"requestsPerDay":20}},{"provider":"groq","models":["openai/gpt-oss-120b","openai/gpt-oss-20b"],"contextTokens":8000,"structuredOutput":"json_schema","minGapMs":2000,"timeoutMs":30000,"maxAnswerTokens":2000,"freeLimit":{"requestsPerDay":1000,"tokensPerDay":200000}},{"provider":"cloudflare","models":["@cf/mistralai/mistral-small-3.1-24b-instruct","@cf/openai/gpt-oss-20b","@cf/google/gemma-4-26b-a4b-it"],"contextTokens":16000,"structuredOutput":"none","minGapMs":2000,"timeoutMs":30000,"maxAnswerTokens":2048,"freeLimit":{"requestsPerDay":16}}]}
EOF
umask 022
echo 'EXTRACTION_WORKER_IMAGE_TAG=rehearsal1' > .env.extraction-pins

log "Self-signed certs in /etc/nginx/certs (the names nginx confs read)"
sudo mkdir -p /etc/nginx/certs
for name in app.cheekycheese.tech cheekycheese.tech; do
  sudo openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$name" \
    -keyout "/etc/nginx/certs/$name.key" -out "/etc/nginx/certs/$name.crt" 2>/dev/null
done
sudo cp /etc/nginx/certs/cheekycheese.tech.crt /etc/nginx/certs/cloudflare-origin-pull-ca.pem
sudo chmod 0644 /etc/nginx/certs/*

# Local tags stand in for GHCR tags: rehearsal1 for the first deploy, rehearsal2 a new image id.
docker tag "$API_IMAGE" "$REGISTRY/cheekycheeseit-crm-api:rehearsal1"
docker tag "$NGINX_IMAGE" "$REGISTRY/cheekycheeseit-crm-nginx:rehearsal1"
printf 'FROM %s\nLABEL rehearsal=second\n' "$API_IMAGE" | docker build -q -t "$REGISTRY/cheekycheeseit-crm-api:rehearsal2" - >/dev/null
printf 'FROM %s\nLABEL rehearsal=second\n' "$NGINX_IMAGE" | docker build -q -t "$REGISTRY/cheekycheeseit-crm-nginx:rehearsal2" - >/dev/null
export IMAGE_TAG=rehearsal1

# ── Waits and assertions ────────────────────────────────────────────────────
cid() { main ps -q "$1"; }
ecid() { ext ps -q "$1"; }
wait_healthy() {
  local svc="$1" id status
  for _ in $(seq 1 60); do
    id="$(cid "$svc")"
    status="$( [ -n "$id" ] && docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo none)"
    [ "$status" = healthy ] && return 0
    sleep 5
  done
  main ps -a
  main logs --tail 80 "$svc" || true
  fail "$svc did not become healthy (last: $status)"
}
main_healthy() { wait_healthy api; wait_healthy nginx; record "main stack healthy: api $(cid api | cut -c1-12), nginx $(cid nginx | cut -c1-12)"; }

# node inside a container: one TCP connect, prints "connected" or the error code.
tcp() {
  docker exec "$1" node -e "
    const s = require('net').connect({ host: '$2', port: $3, timeout: 5000 })
    s.on('connect', () => { console.log('connected'); s.destroy() })
    s.on('timeout', () => { console.log('error=ETIMEDOUT'); s.destroy() })
    s.on('error', (e) => console.log('error=' + e.code))"
}
# node inside api: POST /extract at api's own EXTRACTION_WORKER_URL, with ("auth") or without ("anon")
# api's own EXTRACTION_WORKER_SECRET. Both come from api's env, so no value is in any argv.
api_to_worker() {
  docker exec -e MODE="$1" "$(cid api)" node -e "
    const h = { 'content-type': 'application/json' }
    if (process.env.MODE === 'auth') h.authorization = 'Bearer ' + process.env.EXTRACTION_WORKER_SECRET
    fetch(process.env.EXTRACTION_WORKER_URL + '/extract', { method: 'POST', headers: h, body: '{}',
      signal: AbortSignal.timeout(10000) })
      .then((r) => console.log('status=' + r.status), (e) => console.log('error=' + (e.cause?.code || e.name)))"
}
fingerprint() { docker inspect -f '{{.Id}} restarts={{.RestartCount}} started={{.State.StartedAt}}' "$1"; }

WORKER_BASE=""
assert_extraction_intact() {
  local when="$1" wk out
  wk="$(ecid extraction-worker)"
  [ "$(fingerprint "$wk")" = "$WORKER_BASE" ] || fail "$when: worker changed: $(fingerprint "$wk") vs $WORKER_BASE"
  record "$when: worker $(fingerprint "$wk")"
  # 401 without the secret, 400 with it: the worker answered, took the secret, and refused the empty
  # body before any model call. Reached by the deploy's URL, nothing extracted.
  out="$(api_to_worker anon)"
  [ "$out" = status=401 ] || fail "$when: api cannot reach the worker at $WORKER_URL ($out)"
  record "$when: api $(cid api | cut -c1-12) -> $WORKER_URL/extract without secret: $out"
  out="$(api_to_worker auth)"
  [ "$out" = status=400 ] || fail "$when: the worker did not accept api's secret ($out, expected status=400)"
  record "$when: api -> $WORKER_URL/extract with api's secret, empty body: $out"
}

# ── A. The first deploy after merge, from the compose files production runs today ──
log "A. Old compose files ($OLD_COMPOSE_REF), then the first deploy with the new ones"
git -C "$REPO" show "$OLD_COMPOSE_REF:docker-compose.prod.yml" > docker-compose.prod.yml
git -C "$REPO" show "$OLD_COMPOSE_REF:docker-compose.ghcr.yml" > docker-compose.ghcr.yml
main up -d postgres
main up -d --remove-orphans
main_healthy
OLD_API="$(cid api)"
record "A. before merge: api $OLD_API networks: $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$OLD_API")"
cp "$REPO/docker-compose.prod.yml" "$REPO/docker-compose.ghcr.yml" "$REPO/docker-compose.extraction.yml" .
deploy_normal
main_healthy
NEW_API="$(cid api)"
record "A. first deploy after merge: api recreated: $([ "$OLD_API" != "$NEW_API" ] && echo yes || echo no) ($NEW_API)"
record "A. api networks now: $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$NEW_API")"
record "A. networks left on the host: $(docker network ls --format '{{.Name}}' | grep extraction | tr '\n' ' ' || true)"
record "A. volumes left on the host: $(docker volume ls --format '{{.Name}}' | grep extraction | tr '\n' ' ' || true)"
docker network rm crm_extraction-internal >/dev/null 2>&1 && record "A. the unused crm_extraction-internal removes cleanly" || true

# ── B. The extraction project entirely absent: both paths ───────────────────
log "B. Extraction project absent"
docker network inspect "$ENTRY_NET" >/dev/null 2>&1 && fail "B. $ENTRY_NET exists before the project was created"
out="$(attach)"; echo "$out"
echo "$out" | grep -q "network absent" || fail "B. attach block did not report the absent network"
deploy_reset
main_healthy
record "B. both paths with the project absent: main healthy, attach was a no-op"

# A same-named network the project did not create is not joined: neither a plain one, nor an
# internal one without the project label.
for kind in plain internal; do
  if [ "$kind" = internal ]; then docker network create --internal "$ENTRY_NET" >/dev/null; else docker network create "$ENTRY_NET" >/dev/null; fi
  out="$(attach)"; echo "$out"
  echo "$out" | grep -q "not the extraction project's internal network" || fail "B. attach did not refuse a $kind foreign $ENTRY_NET"
  [ -z "$(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$ENTRY_NET" | tr -d ' ')" ] || fail "B. api joined a $kind foreign $ENTRY_NET"
  docker network rm "$ENTRY_NET" >/dev/null
  record "B. a $kind $ENTRY_NET without the project label: attach warned, api not joined"
done

# ── C. Install the project (the runbook's steps) ────────────────────────────
log "C. Prepare the state volume, start the project"
ext run --rm --no-deps --user root --cap-add CHOWN --entrypoint chown extraction-worker node:node /var/lib/extraction-worker
ext up -d
ext ps
[ "$(ext ps --services | tr '\n' ' ')" = "extraction-worker " ] || fail "C. the project runs more than the worker: $(ext ps --services | tr '\n' ' ')"
hc="$(docker inspect -f 'read_only={{.HostConfig.ReadonlyRootfs}} pids={{.HostConfig.PidsLimit}}' "$(ecid extraction-worker)")"
[ "$hc" = "read_only=true pids=64" ] || fail "C. worker limits not applied ($hc)"
record "C. worker runs with $hc (healthy below: api reaches it)"
# The log is read into a variable first: under pipefail, `docker logs | grep -q` can fail on SIGPIPE
# exactly when grep matched.
wlog=""
for _ in $(seq 1 30); do
  wlog="$(docker logs "$(ecid extraction-worker)" 2>&1)"
  case "$wlog" in *'"event":"LISTENING"'*) break ;; esac
  sleep 2
done
case "$wlog" in *'"event":"LISTENING"'*) ;; *) printf '%s\n' "$wlog" | tail -20; fail "C. the worker did not start listening" ;; esac
# Names only. The worker runs API_IMAGE (the workflow pulls `:main`), so before 5.4c-H1 is on main its
# router refuses the hosted-only config and this lists none: a fact for the owner, not the gate. The
# config's acceptance by H1's schema is gated by check-extraction-router-sample.mjs instead.
record "C. worker $(printf '%s\n' "$wlog" | grep -o '"event":"HOSTED_ROUTES".*' || echo 'logged no HOSTED_ROUTES line')"
attach
WORKER_BASE="$(fingerprint "$(ecid extraction-worker)")"
assert_extraction_intact "C. installed"

# ── D/E/F. The deploy paths with the project up ─────────────────────────────
log "D. Normal path, same image"
deploy_normal
main_healthy
assert_extraction_intact "D. normal path, same image"

log "E. Normal path, new image (api recreated)"
BEFORE="$(cid api)"
export IMAGE_TAG=rehearsal2
deploy_normal
main_healthy
[ "$(cid api)" != "$BEFORE" ] || fail "E. api was not recreated by a new image"
assert_extraction_intact "E. normal path, new image"

log "F. Network-reset path"
deploy_reset
main_healthy
assert_extraction_intact "F. reset path"
out="$(attach)"; echo "$out"
echo "$out" | grep -q "already attached" || fail "F. a second attach did not see the existing attachment"

# ── G. What reaches what ────────────────────────────────────────────────────
log "G. Egress and isolation"
# By address, not by name: a name-resolution error proves nothing about routing.
ip_on() { docker inspect -f "{{with index .NetworkSettings.Networks \"$2\"}}{{.IPAddress}}{{end}}" "$1"; }
wk="$(ecid extraction-worker)"
wk_entry="$(ip_on "$wk" "$ENTRY_NET")"
wk_egress="$(ip_on "$wk" "$EGRESS_NET")"
pg_ip="$(ip_on "$(cid postgres)" crm_backend)"
[ -n "$wk_entry" ] && [ -n "$wk_egress" ] || fail "G. the worker lacks an address on $ENTRY_NET or $EGRESS_NET"
[ -n "$pg_ip" ] || fail "G. postgres has no address on crm_backend"
# Positive controls: tcp() must be able to say "connected" before its errors count as proof.
out="$(tcp "$(cid api)" "$wk_entry" 3100)"
[ "$out" = connected ] || fail "G. control: api cannot reach the worker at $wk_entry:3100 ($out)"
record "G. control: api -> worker at its entry address: $out"
out="$(tcp "$(cid api)" "$pg_ip" 5432)"
[ "$out" = connected ] || fail "G. control: api cannot reach postgres at $pg_ip:5432 ($out)"
record "G. control: api -> postgres: $out"
# The hosted routes need this one; the runtime-era rehearsal asserted the opposite.
out="$(tcp "$wk" 1.1.1.1 443)"
[ "$out" = connected ] || fail "G. the worker cannot reach outside on its egress network ($out)"
record "G. worker -> 1.1.1.1:443: $out"
out="$(tcp "$wk" "$pg_ip" 5432)"
[ "${out#error=}" != "$out" ] || fail "G. the worker connected to postgres at $pg_ip:5432 ($out)"
record "G. worker -> postgres at $pg_ip:5432: $out (no connection, as it must be)"
out="$(tcp "$(cid api)" "$wk_egress" 3100)"
[ "${out#error=}" != "$out" ] || fail "G. api connected to the worker by its egress address ($out)"
record "G. api -> worker at its egress address: $out (not on that network)"
for net in "$ENTRY_NET" "$EGRESS_NET"; do
  members="$(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$net")"
  record "G. $net members: $members"
  for m in $members; do
    case "$net $m" in "$ENTRY_NET crm-api-1" | "$ENTRY_NET $WORKER_NAME" | "$EGRESS_NET $WORKER_NAME") ;;
      *) fail "G. unexpected member $m on $net" ;; esac
  done
done
nets="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$wk")"
[ "$nets" = "$ENTRY_NET $EGRESS_NET " ] || fail "G. the worker is on unexpected networks: $nets"
record "G. worker networks: $nets"
ports="$(docker inspect -f '{{json .NetworkSettings.Ports}}' "$wk")"
echo "$ports" | grep -q HostPort && fail "G. a port is published: $ports"
record "G. published ports on the worker: none"
# The keys live in the worker's env; none may reach its log.
wlog="$(docker logs "$wk" 2>&1)"
[ -n "$wlog" ] || fail "G. the worker log is empty: nothing to check for key values"
for v in "$GEMINI_KEY" "$GROQ_KEY" "$CF_TOKEN"; do
  case "$wlog" in *"$v"*) fail "G. a key value is in the worker log" ;; esac
done
record "G. worker log lines: $(printf '%s\n' "$wlog" | wc -l), no key value among them"

# ── H. Undo (the runbook's steps) ───────────────────────────────────────────
log "H. Undo"
if ext down >down-attached.log 2>&1; then st=0; else st=$?; fi
cat down-attached.log
record "H. project down with api still attached: exit $st, entry network left behind: $(docker network inspect "$ENTRY_NET" >/dev/null 2>&1 && echo yes || echo no)"
docker network disconnect "$ENTRY_NET" "$(cid api)" 2>/dev/null || true
ext down
docker volume inspect crm-extraction_worker_state >/dev/null || fail "H. the undo removed the worker state volume"
for net in "$ENTRY_NET" "$EGRESS_NET"; do
  docker network inspect "$net" >/dev/null 2>&1 && fail "H. $net is left after the undo"
done
record "H. after undo: worker state volume kept, $ENTRY_NET and $EGRESS_NET gone"
main_healthy
deploy_normal
main_healthy
record "H. a deploy after undo: main healthy, attach a no-op"

record "REHEARSAL PASSED"
