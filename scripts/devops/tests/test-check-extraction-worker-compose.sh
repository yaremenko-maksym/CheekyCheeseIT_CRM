#!/usr/bin/env bash
# test-check-extraction-worker-compose.sh - both directions for the extraction isolation guard.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/check-extraction-worker-compose.mjs"
EXTRACTION="$REPO_ROOT/docker-compose.extraction.yml"
PROD="$REPO_ROOT/docker-compose.prod.yml"
GHCR="$REPO_ROOT/docker-compose.ghcr.yml"
SCRIPT="$REPO_ROOT/scripts/devops/deploy-stack-on-vps.sh"
WORKFLOW="$REPO_ROOT/.github/workflows/deploy.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# guard_with [--extraction F] [--prod F] [--script F] [--workflow F]: the real files except the named one.
guard_with() {
  local e="$EXTRACTION" p="$PROD" s="$SCRIPT" w="$WORKFLOW"
  while [ $# -gt 0 ]; do
    case "$1" in
      --extraction) e="$2" ;;
      --prod) p="$2" ;;
      --script) s="$2" ;;
      --workflow) w="$2" ;;
    esac
    shift 2
  done
  node "$GUARD" --extraction "$e" --deploy "$p" --deploy "$GHCR" --names "$s" --names "$w"
}

# mutate <source> "<name>" <sed script | -e script...>: a copy with one edit, under its original basename; prints its path.
mutate() {
  local src="$1" name="$2"
  shift 2
  mkdir -p "$TMP/$name"
  sed "$@" "$src" > "$TMP/$name/$(basename "$src")"
  # A sed that matched nothing would test the unmodified file, and pass for the wrong reason.
  if cmp -s "$src" "$TMP/$name/$(basename "$src")"; then
    echo "mutation $name changed nothing" >&2
    return 1
  fi
  echo "$TMP/$name/$(basename "$src")"
}
ex() { mutate "$EXTRACTION" "$@"; }

WORKER='/^    command: \[.node., .dist\/extraction-worker\/main.\]/'
RUNTIME='/^    user: .1000:1000.$/'

echo "== test-check-extraction-worker-compose.sh =="

assert_green "the real files pass" --contains "isolation OK" -- guard_with

# ── the separate project ──
F="$(ex worker-ports "${WORKER}a\\
    ports: ['3100:3100']")"
assert_red "worker gaining ports: is refused" --contains "extraction-worker must not publish ports" -- guard_with --extraction "$F"

F="$(ex runtime-ports "${RUNTIME}a\\
    ports: ['8080:8080']")"
assert_red "runtime gaining ports: is refused" --contains "model-runtime must not publish ports" -- guard_with --extraction "$F"

# compose refuses network_mode beside networks:, so the mutation swaps one for the other.
F="$(ex runtime-host '/^  crm-model-runtime:/,/^  # ── Extraction worker/ { s/^    networks:$/    network_mode: host/; /^      - runtime$/d; }')"
assert_red "runtime with network_mode: host is refused" --contains "network_mode" -- guard_with --extraction "$F"

F="$(ex worker-leaves '/^  extraction-worker:/,/^  # ── One-shot/ { /^      - entry$/d; }')"
assert_red "worker leaving the entry network is refused" --contains "extraction-worker must be on" -- guard_with --extraction "$F"

F="$(ex runtime-on-entry '/^  crm-model-runtime:/,/^  # ── Extraction worker/ s/^      - runtime$/      - runtime\
      - entry/')"
assert_red "runtime joining the entry network is refused" --contains "model-runtime must be on runtime only" -- guard_with --extraction "$F"

F="$(ex fetch-on-runtime '/^  weights-fetch:/,/^volumes:/ s/^      - provision$/      - runtime/')"
assert_red "the fetch service joining the runtime network is refused" --contains "service weights-fetch must not join runtime" -- guard_with --extraction "$F"

F="$(ex open-runtime '/^  runtime:$/,/^  # Outbound/ s/^    internal: true$/    internal: false/')"
assert_red "runtime network losing internal: true is refused" --contains "network runtime must be internal: true" -- guard_with --extraction "$F"

F="$(ex open-entry '/^  entry:$/,/^  # The runtime network/ s/^    internal: true$/    internal: false/')"
assert_red "entry network losing internal: true is refused" --contains "network entry must be internal: true" -- guard_with --extraction "$F"

F="$(ex external-entry '/^  entry:$/,/^  # The runtime network/ s/^    driver: bridge$/    external: true/')"
assert_red "an external entry network is refused" --contains "must not be external" -- guard_with --extraction "$F"

F="$(ex renamed-entry 's/^    name: crm-extraction-entry$/    name: other/')"
assert_red "renaming the entry network is refused" --contains "must keep the name" -- guard_with --extraction "$F"

F="$(ex root-user 's/^    user: .1000:1000.$/    user: "0:0"/')"
assert_red "runtime running as root is refused" --contains "must run non-root" -- guard_with --extraction "$F"

F="$(ex keep-caps '/^  crm-model-runtime:/,/^  # ── Extraction worker/ { /^    cap_drop:$/d; /^      - ALL$/d; }')"
assert_red "runtime keeping capabilities is refused" --contains "model-runtime must drop all capabilities" -- guard_with --extraction "$F"

F="$(ex no-nnp '/^  crm-model-runtime:/,/^  # ── Extraction worker/ { /^    security_opt:$/d; /^      - no-new-privileges:true$/d; }')"
assert_red "runtime without no-new-privileges is refused" --contains "model-runtime must set no-new-privileges" -- guard_with --extraction "$F"

F="$(ex big-mem 's/^    mem_limit: 3584m$/    mem_limit: 4096m/')"
assert_red "runtime limit drifting from the frozen budget is refused" --contains "model-runtime mem_limit" -- guard_with --extraction "$F"

F="$(ex swap 's/^    memswap_limit: 3584m$/    memswap_limit: 7168m/')"
assert_red "runtime with swap allowed is refused" --contains "memswap_limit must equal" -- guard_with --extraction "$F"

F="$(ex logging-on 's/ --log-disable$//')"
assert_red "runtime with logging on is refused" --contains "--log-disable" -- guard_with --extraction "$F"

F="$(ex no-verify '/sha256sum -c -$/d')"
assert_red "runtime that does not verify its weights is refused" --contains "sha256sum -c" -- guard_with --extraction "$F"

F="$(ex rw-weights 's/^      - model_weights:\/models:ro$/      - model_weights:\/models/')"
assert_red "weights mounted writable into the runtime are refused" --contains "read-only" -- guard_with --extraction "$F"

F="$(ex by-tag 's/llama\.cpp@sha256:\${EXTRACTION_RUNTIME_IMAGE_SHA256:?pin the runtime image digest}/llama.cpp:server/')"
assert_red "runtime image by tag is refused" --contains "pinned by sha256" -- guard_with --extraction "$F"

F="$(ex default-digest 's/\${EXTRACTION_MODEL_SHA256:?pin the weights digest}/${EXTRACTION_MODEL_SHA256:-}/')"
assert_red "an unset weights digest that does not refuse is itself refused" --contains "unset EXTRACTION_MODEL_SHA256" -- guard_with --extraction "$F"

F="$(ex default-image 's/\${EXTRACTION_RUNTIME_IMAGE_SHA256:?pin the runtime image digest}/${EXTRACTION_RUNTIME_IMAGE_SHA256:-aaaa}/g')"
assert_red "an unset image digest that does not refuse is itself refused" --contains "unset EXTRACTION_RUNTIME_IMAGE_SHA256" -- guard_with --extraction "$F"

F="$(ex renamed-project 's/^name: crm-extraction$/name: crm/')"
assert_red "losing its own project name is refused" --contains "project must be named" -- guard_with --extraction "$F"

F="$(ex extra-service '/^volumes:$/i\
  sidecar:\
    image: busybox\
')"
assert_red "an unexpected service in the project is refused" --contains "unexpected service sidecar" -- guard_with --extraction "$F"

# ── the composed deploy configuration ──
F="$(mutate "$PROD" gains-worker '/^  # ── nginx (reverse-proxy/i\
  extraction-worker:\
    image: busybox\
')"
assert_red "the deploy configuration gaining the worker is refused" --contains "gained service extraction-worker" -- guard_with --prod "$F"

F="$(mutate "$PROD" gains-profile '/^  # ── nginx (reverse-proxy/i\
  llm:\
    profiles: ["model"]\
    image: busybox\
')"
assert_red "a model service behind a profile in the main file is refused" --contains "gained service llm" -- guard_with --prod "$F"

# compose drops a declared network no service uses, so api joins it too.
F="$(mutate "$PROD" external-net -e '/^networks:$/a\
  crossing:\
    external: true\
    name: some-shared-net
' -e 's/^      - frontend$/      - frontend\
      - crossing/')"
assert_red "an external network in the deploy configuration is refused" --contains "must not use external network crossing" -- guard_with --prod "$F"

# ── the deploy paths ──
F="$(mutate "$SCRIPT" names-file '1a\
docker compose -f docker-compose.extraction.yml up -d')"
assert_red "the deploy script naming the file is refused" --contains "names the extraction project or its file" -- guard_with --script "$F"

F="$(mutate "$WORKFLOW" names-file-wf '1a\
# source: docker-compose.extraction.yml')"
assert_red "deploy.yml naming the file is refused" --contains "names the extraction project or its file" -- guard_with --workflow "$F"

F="$(mutate "$SCRIPT" names-project '1a\
docker compose -p crm-extraction ps')"
assert_red "the deploy script naming the project is refused" --contains "names the extraction project or its file" -- guard_with --script "$F"

mkdir -p "$TMP/empty" && : > "$TMP/empty/deploy-stack-on-vps.sh"
assert_red "an empty deploy script is not read as clean" --contains "nothing was checked" -- guard_with --script "$TMP/empty/deploy-stack-on-vps.sh"

assert_red "a missing deploy script is not read as clean" --contains "could not read" -- guard_with --script "$TMP/empty/absent.sh"

guard_test_summary "test-check-extraction-worker-compose.sh"
