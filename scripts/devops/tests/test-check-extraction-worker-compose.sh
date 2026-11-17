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
WK='/^  extraction-worker:/,/^volumes:/'
# A second service, injected before `volumes:`. (Text inserted by `i` is not matched by later sed
# commands, so a test that needs an extra line on it writes the whole insertion itself.)
SIDECAR='/^volumes:$/i\
  sidecar:\
    image: busybox\
'

echo "== test-check-extraction-worker-compose.sh =="

assert_green "the real files pass" --contains "isolation OK" -- guard_with

# ── the separate project: the worker ──
F="$(ex worker-ports "${WORKER}a\\
    ports: ['3100:3100']")"
assert_red "worker gaining ports: is refused" --contains "extraction-worker must not publish ports" -- guard_with --extraction "$F"

F="$(ex worker-expose "${WORKER}a\\
    expose: ['3100']")"
assert_red "worker declaring expose is refused" --contains "extraction-worker must not declare expose" -- guard_with --extraction "$F"

# compose refuses network_mode beside networks:, so the mutation swaps one for the other.
F="$(ex worker-host "$WK"' { s/^    networks:$/    network_mode: host/; /^      - entry$/d; /^      - egress$/d; }')"
assert_red "worker with network_mode: host is refused" --contains "network_mode" -- guard_with --extraction "$F"

F="$(ex worker-privileged "${WORKER}a\\
    privileged: true")"
assert_red "a privileged worker is refused" --contains "extraction-worker must not be privileged" -- guard_with --extraction "$F"

F="$(ex worker-cap-add "${WORKER}a\\
    cap_add: [NET_ADMIN]")"
assert_red "worker adding a capability is refused" --contains "extraction-worker must not add capabilities" -- guard_with --extraction "$F"

F="$(ex keep-caps "$WK"' { /^    cap_drop:$/d; /^      - ALL$/d; }')"
assert_red "worker keeping capabilities is refused" --contains "extraction-worker must drop all capabilities" -- guard_with --extraction "$F"

F="$(ex no-nnp "$WK"' { /^    security_opt:$/d; /^      - no-new-privileges:true$/d; }')"
assert_red "worker without no-new-privileges is refused" --contains "extraction-worker must set no-new-privileges" -- guard_with --extraction "$F"

F="$(ex worker-cpus "$WK"' s/^    cpus: 0.5$/    cpus: 1.0/')"
assert_red "worker cpus drifting is refused" --contains "extraction-worker cpus must be 0.5" -- guard_with --extraction "$F"

F="$(ex worker-mem "$WK"' s/^    mem_limit: 512m$/    mem_limit: 1024m/')"
assert_red "worker memory drifting is refused" --contains "extraction-worker mem_limit" -- guard_with --extraction "$F"

F="$(ex worker-swap "$WK"' s/^    memswap_limit: 512m$/    memswap_limit: 1024m/')"
assert_red "worker with swap allowed is refused" --contains "memswap_limit must equal" -- guard_with --extraction "$F"

F="$(ex worker-pids "$WK"' { /^    pids_limit: 64$/d; }')"
assert_red "worker without a pids limit is refused" --contains "extraction-worker pids_limit must be 64" -- guard_with --extraction "$F"

F="$(ex worker-rw "$WK"' { /^    read_only: true$/d; }')"
assert_red "worker with a writable root filesystem is refused" --contains "extraction-worker must run with read_only" -- guard_with --extraction "$F"

F="$(ex worker-no-state "$WK"' { /^    volumes:$/d; /^      - worker_state:\/var\/lib\/extraction-worker$/d; }')"
assert_red "worker losing its state volume is refused" --contains "must keep its state volume" -- guard_with --extraction "$F"

F="$(ex worker-profile "${WORKER}a\\
    profiles: ['extraction']")"
assert_red "worker hiding behind a profile is refused" --contains "must not hide behind a profile" -- guard_with --extraction "$F"

# ── the separate project: its networks ──
F="$(ex worker-leaves-entry "$WK"' { /^      - entry$/d; }')"
assert_red "worker leaving the entry network is refused" --contains "extraction-worker must be on entry and egress only" -- guard_with --extraction "$F"

F="$(ex worker-leaves-egress "$WK"' { /^      - egress$/d; }')"
assert_red "worker leaving the egress network is refused" --contains "extraction-worker must be on entry and egress only" -- guard_with --extraction "$F"

F="$(ex third-net -e '$a\
  extra:\
    driver: bridge' -e "$WK"' s/^      - egress$/      - egress\
      - extra/')"
assert_red "a third network on the worker is refused" --contains "unexpected network extra" -- guard_with --extraction "$F"

F="$(ex open-entry '/^  entry:$/,/^  # Outbound/ s/^    internal: true$/    internal: false/')"
assert_red "entry network losing internal: true is refused" --contains "network entry must be internal: true" -- guard_with --extraction "$F"

F="$(ex external-entry '/^  entry:$/,/^  # Outbound/ s/^    driver: bridge$/    external: true/')"
assert_red "an external entry network is refused" --contains "must not be external" -- guard_with --extraction "$F"

F="$(ex renamed-entry 's/^    name: crm-extraction-entry$/    name: other/')"
assert_red "renaming the entry network is refused" --contains "must keep the name" -- guard_with --extraction "$F"

F="$(ex no-egress -e '/^  # Outbound to the hosted/,$d' -e "$WK"' { /^      - egress$/d; }')"
assert_red "no egress network is refused" --contains "network egress is missing" -- guard_with --extraction "$F"

F="$(ex internal-egress '/^  egress:$/a\
    internal: true')"
assert_red "an internal egress network is refused" --contains "network egress must not be internal" -- guard_with --extraction "$F"

# The main stack's backend network, where postgres lives: a fixed name would share it.
F="$(ex shared-egress '/^  egress:$/a\
    name: crm_backend')"
assert_red "an egress network named after a main-stack network is refused" --contains "must resolve to crm-extraction_egress" -- guard_with --extraction "$F"

F="$(ex external-egress '/^  egress:$/,$ s/^    driver: bridge$/    external: true\
    name: crm-extraction_egress/')"
assert_red "an external egress network is refused" --contains "network egress must not be external" -- guard_with --extraction "$F"

F="$(ex sidecar-on-egress '/^volumes:$/i\
  sidecar:\
    image: busybox\
    networks: [egress]\
')"
assert_red "another service joining the egress network is refused" --contains "service sidecar must not join egress" -- guard_with --extraction "$F"

F="$(ex sidecar-on-entry '/^volumes:$/i\
  sidecar:\
    image: busybox\
    networks: [entry]\
')"
assert_red "another service joining the entry network is refused" --contains "service sidecar must not join entry" -- guard_with --extraction "$F"

F="$(ex sidecar-shares-ns '/^volumes:$/i\
  sidecar:\
    image: busybox\
    network_mode: "service:extraction-worker"\
')"
assert_red "a service sharing the worker's namespace is refused" --contains "must not share another service's network namespace" -- guard_with --extraction "$F"

# ── the separate project: services, pin, name ──
F="$(ex extra-service "$SIDECAR")"
assert_red "an unexpected service in the project is refused" --contains "unexpected service sidecar" -- guard_with --extraction "$F"

F="$(ex profiled-runtime '/^volumes:$/i\
  sidecar:\
    image: busybox\
    profiles: ["provision"]\
')"
assert_red "a service behind a profile in the project is refused" --contains "unexpected service sidecar" -- guard_with --extraction "$F"

F="$(ex default-tag 's/\${EXTRACTION_WORKER_IMAGE_TAG:?pin the worker image tag}/${EXTRACTION_WORKER_IMAGE_TAG:-main}/')"
assert_red "an unset image tag that does not refuse is itself refused" --contains "unset EXTRACTION_WORKER_IMAGE_TAG" -- guard_with --extraction "$F"

F="$(ex renamed-project 's/^name: crm-extraction$/name: crm/')"
assert_red "losing its own project name is refused" --contains "project must be named" -- guard_with --extraction "$F"

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
