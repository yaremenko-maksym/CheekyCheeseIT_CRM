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
# The runtime's own restart line: its user line is shared with weights-fetch.
RUNTIME='/^    restart: on-failure:3$/'
RT='/^  crm-model-runtime:/,/^  # ── Extraction worker/'
WK='/^  extraction-worker:/,/^  # ── One-shot/'
FE='/^  weights-fetch:/,/^volumes:/'

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

F="$(ex root-user "$RT"' s/^    user: .1000:1000.$/    user: "0:0"/')"
assert_red "runtime running as root is refused" --contains "crm-model-runtime must run non-root" -- guard_with --extraction "$F"

F="$(ex worker-cpus "$WK"' s/^    cpus: 0.5$/    cpus: 1.0/')"
assert_red "worker cpus drifting is refused" --contains "extraction-worker cpus must be 0.5" -- guard_with --extraction "$F"

F="$(ex worker-mem "$WK"' s/^    mem_limit: 512m$/    mem_limit: 1024m/')"
assert_red "worker memory drifting is refused" --contains "extraction-worker mem_limit" -- guard_with --extraction "$F"

F="$(ex worker-pids "$WK"' { /^    pids_limit: 64$/d; }')"
assert_red "worker without a pids limit is refused" --contains "extraction-worker pids_limit must be 64" -- guard_with --extraction "$F"

F="$(ex worker-rw "$WK"' { /^    read_only: true$/d; }')"
assert_red "worker with a writable root filesystem is refused" --contains "extraction-worker must run with read_only" -- guard_with --extraction "$F"

F="$(ex runtime-cpus "$RT"' s/^    cpus: 2.0$/    cpus: 4.0/')"
assert_red "runtime cpus drifting is refused" --contains "crm-model-runtime cpus must be 2" -- guard_with --extraction "$F"

F="$(ex runtime-pids "$RT"' s/^    pids_limit: 128$/    pids_limit: 4096/')"
assert_red "runtime pids limit drifting is refused" --contains "crm-model-runtime pids_limit must be 128" -- guard_with --extraction "$F"

F="$(ex parallel-12 's/--parallel 1 /--parallel 12 /')"
assert_red "runtime with --parallel 12 is refused" --contains '"--parallel 1" (found: 12)' -- guard_with --extraction "$F"

F="$(ex threads-24 's/--threads 2 --threads-batch/--threads 24 --threads-batch/')"
assert_red "runtime with --threads 24 is refused" --contains '"--threads 2" (found: 24)' -- guard_with --extraction "$F"

F="$(ex parallel-dup 's/ --log-disable$/ --log-disable --parallel 4/')"
assert_red "a later duplicate --parallel is refused" --contains '"--parallel 1" (found: 1, 4)' -- guard_with --extraction "$F"

F="$(ex worker-expose "${WORKER}a\\
    expose: ['3100']")"
assert_red "worker declaring expose is refused" --contains "extraction-worker must not declare expose" -- guard_with --extraction "$F"

F="$(ex runtime-privileged "${RUNTIME}a\\
    privileged: true")"
assert_red "a privileged runtime is refused" --contains "crm-model-runtime must not be privileged" -- guard_with --extraction "$F"

F="$(ex runtime-cap-add "${RUNTIME}a\\
    cap_add: [NET_ADMIN]")"
assert_red "runtime adding a capability is refused" --contains "crm-model-runtime must not add capabilities" -- guard_with --extraction "$F"

F="$(ex fetch-shares-ns "$FE"' { s/^    networks:$/    network_mode: "service:crm-model-runtime"/; /^      - provision$/d; }')"
assert_red "weights-fetch sharing the runtime's namespace is refused" --contains "must not share another service's network namespace" -- guard_with --extraction "$F"

F="$(ex fetch-no-profile "$FE"' { /^    profiles: .*provision/d; }')"
assert_red "weights-fetch without its profile is refused" --contains "service weights-fetch must stay behind a profile" -- guard_with --extraction "$F"

F="$(ex fetch-on-entry "$FE"' s/^      - provision$/      - entry/')"
assert_red "another service joining the entry network is refused" --contains "service weights-fetch must not join entry" -- guard_with --extraction "$F"

F="$(ex fetch-root "$FE"' s/^    user: .1000:1000.$/    user: "0:0"/')"
assert_red "weights-fetch running as root is refused" --contains "weights-fetch must run non-root" -- guard_with --extraction "$F"

F="$(ex fetch-http 's/ --proto =https / /')"
assert_red "weights-fetch allowing a non-https download is refused" --contains 'curl must carry "--proto =https"' -- guard_with --extraction "$F"

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

# The network the old prod file declared; resolves to crm_extraction-internal.
F="$(mutate "$PROD" readds-net -e '/^networks:$/a\
  extraction-internal:\
    internal: true
' -e 's/^      - frontend$/      - frontend\
      - extraction-internal/')"
assert_red "an extraction network re-added to the prod file is refused" --contains "must not declare network extraction-internal" -- guard_with --prod "$F"

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
