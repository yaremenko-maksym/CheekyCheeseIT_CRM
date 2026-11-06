#!/usr/bin/env bash
# test-check-extraction-worker-compose.sh - both directions for the extraction worker isolation guard.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/check-extraction-worker-compose.mjs"
PROD="$REPO_ROOT/docker-compose.prod.yml"
GHCR="$REPO_ROOT/docker-compose.ghcr.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# mutate "<name>" <sed args...>: a copy of the prod compose with one edit; prints the copy's path.
mutate() {
  local name="$1"
  shift
  sed -e "$@" "$PROD" > "$TMP/$name.yml"
  echo "$TMP/$name.yml"
}
guard() { node "$GUARD" "$@"; }

WORKER_CMD='/^    command: \[.node., .dist\/extraction-worker\/main.\]/'

echo "== test-check-extraction-worker-compose.sh =="

assert_green "prod compose passes" --contains "isolation OK" -- guard "$PROD"
assert_green "prod + ghcr overlay passes" --contains "isolation OK" -- guard "$PROD" "$GHCR"

PORTS="$(mutate ports "${WORKER_CMD}a\\
    ports: ['3100:3100']")"
assert_red "worker gaining ports: is refused" --contains "must not publish ports" -- guard "$PORTS"

HOSTNET="$(mutate host "${WORKER_CMD}a\\
    network_mode: host")"
assert_red "worker with network_mode: host is refused (compose itself rejects it next to networks:)" --contains "network_mode" -- guard "$HOSTNET"

LEAVE="$(mutate leave '/^  extraction-worker:/,/^# -- Volumes\|^# ── Volumes/ s/^      - extraction-internal$/      - backend/')"
assert_red "worker leaving the internal network is refused" --contains "must be on extraction-internal only" -- guard "$LEAVE"

INTRUDER="$(mutate intruder '/^  nginx:/,/^# ── Volumes/ s/^      - frontend$/      - frontend\
      - extraction-internal/')"
assert_red "another service joining the network is refused" --contains "service nginx must not join" -- guard "$INTRUDER"

OPEN="$(mutate open 's/^    internal: true$/    internal: false/')"
assert_red "network losing internal: true is refused" --contains "must be internal: true" -- guard "$OPEN"

SHARENS="$(mutate sharens '/^  nginx:/,/^# ── Volumes/ { /^    networks:$/,/^      - frontend$/d; /^  nginx:/a\
    network_mode: "service:extraction-worker"
}')"
assert_red "a service sharing the worker's network namespace is refused" --contains "network" -- guard "$SHARENS"

NOPROFILE="$(mutate noprofile "/^    profiles: \['extraction'\]\$/d")"
assert_red "worker losing its opt-in profile is refused" --contains "opt-in" -- guard "$NOPROFILE"

guard_test_summary "test-check-extraction-worker-compose.sh"
