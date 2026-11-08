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
#     network-reset path (`down --remove-orphans`, then `up`) leave the runtime and worker containers
#     with the same ID, zero restarts and the same start time; the worker reaches the runtime, `api`
#     reaches the worker, the main stack is healthy;
#   - `api` cannot reach the runtime, the runtime cannot reach outside, no port is published;
#   - the undo leaves the worker's state volume and the main stack healthy;
#   - what the first deploy after merge does to `api` and to the old network and volume.
set -euo pipefail

: "${API_IMAGE:?set API_IMAGE (the api image, tag included)}"
: "${NGINX_IMAGE:?set NGINX_IMAGE (the nginx image, tag included)}"
: "${RUNTIME_IMAGE_SHA256:?set RUNTIME_IMAGE_SHA256}"
: "${MODEL_URL:?set MODEL_URL}"
: "${MODEL_FILE:?set MODEL_FILE}"
: "${MODEL_SHA256:?set MODEL_SHA256}"
: "${OLD_COMPOSE_REF:?set OLD_COMPOSE_REF (the commit whose compose files production runs before merge)}"

REPO="$(git rev-parse --show-toplevel)"
WORK="${RUNNER_TEMP:-/tmp}/crm"            # directory name crm = project crm, as /opt/crm on the VPS
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
RUNTIME_CTX=4096                          # the tiny rehearsal model; large enough for the router's input ceiling (G2); production pins its own window
ENTRY_NET=crm-extraction-entry
REGISTRY=ghcr.io/yaremenko-maksym

rm -rf "$WORK" && mkdir -p "$WORK"
cd "$WORK"

log() { printf '\n==> %s\n' "$*"; }
fail() { echo "REHEARSAL FAILED: $*" >&2; printf -- '- FAILED: %s\n' "$*" >> "$SUMMARY"; exit 1; }
record() { echo "$*"; printf -- '- %s\n' "$*" >> "$SUMMARY"; }

# ── The deploy script's own commands ────────────────────────────────────────
# Copied verbatim from deploy-stack-on-vps.sh; asserted present there, so a drift fails this run.
DEPLOY_SCRIPT="$REPO/scripts/devops/deploy-stack-on-vps.sh"
for cmd in 'up -d postgres redis' 'down --remove-orphans' 'up -d --remove-orphans'; do
  grep -qF -- "$cmd" "$DEPLOY_SCRIPT" || fail "deploy script no longer runs '$cmd': update this rehearsal"
done
sed -n '/^# >>> extraction-entry-attach$/,/^# <<< extraction-entry-attach$/p' "$DEPLOY_SCRIPT" > attach-block.sh
[ "$(wc -l < attach-block.sh)" -gt 5 ] || fail "attach block markers not found in the deploy script"

main() { docker compose -f docker-compose.prod.yml -f docker-compose.ghcr.yml --env-file .env.production "$@"; }
ext() { docker compose -f docker-compose.extraction.yml --env-file .env.extraction-pins "$@"; }
attach() { bash -euo pipefail attach-block.sh; }
deploy_normal() {
  main up -d postgres redis
  main up -d --remove-orphans
  attach
}
deploy_reset() {
  main down --remove-orphans
  main up -d postgres redis
  main up -d --remove-orphans
  attach
}

# ── Setup: env files with throwaway values, certs, compose files ────────────
rnd() { openssl rand -hex 32; }
secret() { local v; v="$(rnd)"; echo "::add-mask::$v" >&2; echo "$v"; }
log "Writing throwaway env files (values never printed)"
PGPW="$(secret)"
umask 077
cat > .env.production <<EOF
POSTGRES_PASSWORD=$PGPW
DATABASE_URL=postgresql://crm_user:$PGPW@postgres:5432/crm_db
REDIS_URL=redis://redis:6379
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
EOF
cat > .env.extraction-worker <<EOF
EXTRACTION_WORKER_SECRET=$(secret)
INFERENCE_EXTRACTION_PROVIDER=router
ROUTER_LOCAL_MODEL_URL=http://crm-model-runtime:8080/v1
LOCAL_MODEL_NAME=rehearsal-model
EXTRACTION_ROUTER_CONFIG={"policyVersion":"rehearsal","hostedBudgetMs":0,"floorBudgetMs":360000,"routes":[{"provider":"local","contextTokens":$RUNTIME_CTX,"structuredOutput":"json_schema","timeoutMs":60000,"maxAnswerTokens":64}]}
EOF
umask 022
cat > .env.extraction-pins <<EOF
EXTRACTION_RUNTIME_IMAGE_SHA256=$RUNTIME_IMAGE_SHA256
EXTRACTION_MODEL_URL=$MODEL_URL
EXTRACTION_MODEL_FILE=$MODEL_FILE
EXTRACTION_MODEL_SHA256=$MODEL_SHA256
EXTRACTION_RUNTIME_CONTEXT_TOKENS=$RUNTIME_CTX
EXTRACTION_WORKER_IMAGE_TAG=rehearsal1
EOF

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

# node inside a container: one HTTP request, prints the status or the error code.
probe() {
  local container="$1" url="$2" method="${3:-GET}"
  docker exec "$container" node -e "
    fetch('$url', { method: '$method', headers: { 'content-type': 'application/json' },
      body: '$method' === 'POST' ? '{}' : undefined, signal: AbortSignal.timeout(10000) })
      .then((r) => console.log('status=' + r.status), (e) => console.log('error=' + (e.cause?.code || e.name)))"
}
fingerprint() { docker inspect -f '{{.Id}} restarts={{.RestartCount}} started={{.State.StartedAt}}' "$1"; }

RUNTIME_BASE=""
WORKER_BASE=""
assert_extraction_intact() {
  local when="$1" rt wk out
  rt="$(ecid crm-model-runtime)"
  wk="$(ecid extraction-worker)"
  [ "$(fingerprint "$rt")" = "$RUNTIME_BASE" ] || fail "$when: runtime changed: $(fingerprint "$rt") vs $RUNTIME_BASE"
  [ "$(fingerprint "$wk")" = "$WORKER_BASE" ] || fail "$when: worker changed: $(fingerprint "$wk") vs $WORKER_BASE"
  record "$when: runtime $(fingerprint "$rt")"
  record "$when: worker $(fingerprint "$wk")"
  out="$(probe "$wk" http://crm-model-runtime:8080/health)"
  [ "$out" = status=200 ] || fail "$when: worker cannot reach the runtime ($out)"
  record "$when: worker -> runtime /health: $out"
  out="$(probe "$(cid api)" http://extraction-worker:3100/extract POST)"
  # 401: the worker answered and refused the missing secret. Reached, nothing extracted.
  [ "$out" = status=401 ] || fail "$when: api cannot reach the worker ($out)"
  record "$when: api $(cid api | cut -c1-12) -> worker /extract without secret: $out"
}

# ── A. The first deploy after merge, from the compose files production runs today ──
log "A. Old compose files ($OLD_COMPOSE_REF), then the first deploy with the new ones"
git -C "$REPO" show "$OLD_COMPOSE_REF:docker-compose.prod.yml" > docker-compose.prod.yml
git -C "$REPO" show "$OLD_COMPOSE_REF:docker-compose.ghcr.yml" > docker-compose.ghcr.yml
main up -d postgres redis
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

# ── C. Install the project (the runbook's steps) ────────────────────────────
log "C. Provision weights, prepare the state volume, start the project"
ext --profile provision run --rm weights-fetch
ext run --rm --no-deps --user root --cap-add CHOWN --entrypoint chown extraction-worker node:node /var/lib/extraction-worker
ext up -d
ext ps
[ -z "$(ext ps -q weights-fetch)" ] || fail "C. weights-fetch started without its profile"
for _ in $(seq 1 60); do
  [ "$(probe "$(ecid extraction-worker)" http://crm-model-runtime:8080/health)" = status=200 ] && break
  sleep 3
done
attach
RUNTIME_BASE="$(fingerprint "$(ecid crm-model-runtime)")"
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

# ── G. What must not be reachable ───────────────────────────────────────────
log "G. Isolation negatives"
out="$(probe "$(cid api)" http://crm-model-runtime:8080/health)"
[ "${out#error=}" != "$out" ] || fail "G. api reached the runtime ($out)"
record "G. api -> runtime: $out (refused, as it must be)"
out="$(docker exec "$(ecid crm-model-runtime)" sh -c 'curl -s -o /dev/null --max-time 5 https://example.com && echo reached || echo blocked')"
[ "$out" = blocked ] || fail "G. the runtime reached the internet"
record "G. runtime -> internet: $out"
members="$(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$ENTRY_NET")"
record "G. $ENTRY_NET members: $members"
for m in $members; do
  case "$m" in crm-api-1 | crm-extraction-extraction-worker-1) ;; *) fail "G. unexpected member $m on $ENTRY_NET" ;; esac
done
ports="$(docker inspect -f '{{json .NetworkSettings.Ports}}' "$(ecid crm-model-runtime)" "$(ecid extraction-worker)")"
echo "$ports" | grep -q HostPort && fail "G. a port is published: $ports"
record "G. published ports on runtime and worker: none"
MARKER="rehearsal-marker-$(openssl rand -hex 4)"
docker exec "$(ecid extraction-worker)" node -e "
  fetch('http://crm-model-runtime:8080/v1/chat/completions', { method: 'POST',
    headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60000),
    body: JSON.stringify({ messages: [{ role: 'user', content: '$MARKER' }], max_tokens: 8 }) })
    .then((r) => console.log('chat status=' + r.status), (e) => console.log('chat error=' + (e.cause?.code || e.name)))"
docker logs "$(ecid crm-model-runtime)" 2>&1 | grep -qF "$MARKER" && fail "G. the runtime logged the prompt"
record "G. a prompt carrying a marker: absent from the runtime log"
record "G. runtime log lines after all requests: $(docker logs "$(ecid crm-model-runtime)" 2>&1 | wc -l)"
# A fact, not a gate: whether the host itself reaches the runtime by its address on the internal
# network. The MP-04 harness runs on the host and depends on it.
rt_ip="$(docker inspect -f '{{with index .NetworkSettings.Networks "crm-extraction_runtime"}}{{.IPAddress}}{{end}}' "$(ecid crm-model-runtime)")"
out="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$rt_ip:8080/health" || echo unreachable)"
record "G. host -> runtime at $rt_ip on the internal network: $out"

# ── G2. MP-04 harness smoke: wiring against the real api build, a few pages ─
# The tiny model cannot pass the table, so the expected verdict is FAIL (exit 1) with a report;
# exit 0 or exit 2 (harness error) fails the rehearsal. Not a model measurement.
if [ "$out" = 200 ]; then
  log "G2. MP-04 harness smoke"
  docker create --name mp04-app "$(docker inspect -f '{{.Config.Image}}' "$(ecid extraction-worker)")" >/dev/null
  docker cp -q mp04-app:/app mp04-app
  docker rm mp04-app >/dev/null
  api_ip="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{$v.IPAddress}}{{"\n"}}{{end}}' "$(cid api)" | grep -v "^$ENTRY_NET " | awk 'NF==2 {print $2; exit}')"
  cat > mp04-candidate.json <<EOF
{"name":"stories260K-smoke","repo":"ggml-org/models-moved","file":"$MODEL_FILE","sha256":"$MODEL_SHA256","repoCommit":"main","licence":null,
 "routerConfig":{"policyVersion":"rehearsal","hostedBudgetMs":0,"floorBudgetMs":360000,"routes":[{"provider":"local","baseUrl":"http://crm-model-runtime:8080/v1","model":"rehearsal-model","contextTokens":$RUNTIME_CTX,"structuredOutput":"json_schema","timeoutMs":60000,"maxAnswerTokens":64}]}}
EOF
  # A hung harness fails here in minutes (exit 124), not at the job's timeout.
  if timeout 900 node "$REPO/scripts/devops/extraction-mp04/mp04.mjs" --candidate mp04-candidate.json --api-dist mp04-app \
    --runtime-url "http://$rt_ip:8080" --crm-url "http://$api_ip:3001/api/health" \
    --baseline-s 10 --fixtures 4 --out-dir mp04-out; then st=0; else st=$?; fi
  [ -s mp04-out/report.json ] || fail "G2. the harness wrote no report (exit $st)"
  [ "$st" = 1 ] || fail "G2. the harness exited $st, expected 1 (a FAIL verdict with a report)"
  record "G2. MP-04 harness smoke: exit 1 with a report; $(node -e "const c=require('./mp04-out/report.json').candidates[0]; console.log('requests', c.requests.total, 'answered', c.requests.answered, 'cold load ms', c.coldLoadMs, 'records', c.mp03.records)")"
  docker exec "$(ecid extraction-worker)" true || fail "G2. the worker is gone after the runtime restart"
else
  record "G2. MP-04 harness smoke: not run (the host does not reach the runtime network)"
fi

# ── H. Undo (the runbook's steps) ───────────────────────────────────────────
log "H. Undo"
if ext down >down-attached.log 2>&1; then st=0; else st=$?; fi
cat down-attached.log
record "H. project down with api still attached: exit $st, entry network left behind: $(docker network inspect "$ENTRY_NET" >/dev/null 2>&1 && echo yes || echo no)"
docker network disconnect "$ENTRY_NET" "$(cid api)" 2>/dev/null || true
ext down
docker volume rm crm-extraction_model_weights
docker volume inspect crm-extraction_worker_state >/dev/null || fail "H. the undo removed the worker state volume"
record "H. after undo: worker state volume kept, weights volume removed, network gone: $(docker network inspect "$ENTRY_NET" >/dev/null 2>&1 && echo no || echo yes)"
main_healthy
deploy_normal
main_healthy
record "H. a deploy after undo: main healthy, attach a no-op"

record "REHEARSAL PASSED"
