#!/usr/bin/env bash
# test-check-deploy-freshness.sh — proves scripts/devops/check-deploy-freshness.sh
# goes RED on a standing deploy failure (the 2026-10-13..17 shape: a long streak
# of failures, mostly workflow_dispatch) AND when it simply cannot see.
#
# The run list is fed from a fixture file (DEPLOY_RUNS_JSON_FILE) and "now" is
# pinned (NOW_EPOCH), so no network and no clock dependence.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/check-deploy-freshness.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# 2026-10-17T21:00:00Z
NOW=1792270800

# The real incident, condensed: a green run, then failures from 10-13 20:46
# through 10-17 20:35, mixed push + workflow_dispatch, with a cancelled run in
# the middle that must not break the streak.
cat >"$WS/incident.json" <<'EOF'
[
 {"databaseId":9,"conclusion":"failure","createdAt":"2026-10-17T20:35:16Z","event":"push","url":"https://example.invalid/runs/9"},
 {"databaseId":8,"conclusion":"failure","createdAt":"2026-10-17T17:07:56Z","event":"workflow_dispatch","url":"https://example.invalid/runs/8"},
 {"databaseId":7,"conclusion":"cancelled","createdAt":"2026-10-16T21:00:00Z","event":"push","url":"https://example.invalid/runs/7"},
 {"databaseId":6,"conclusion":"failure","createdAt":"2026-10-16T17:28:29Z","event":"workflow_dispatch","url":"https://example.invalid/runs/6"},
 {"databaseId":5,"conclusion":"failure","createdAt":"2026-10-13T20:46:49Z","event":"push","url":"https://example.invalid/runs/5"},
 {"databaseId":4,"conclusion":"success","createdAt":"2026-10-13T10:33:54Z","event":"workflow_dispatch","url":"https://example.invalid/runs/4"}
]
EOF

cat >"$WS/green.json" <<'EOF'
[
 {"databaseId":3,"conclusion":"success","createdAt":"2026-10-17T20:00:00Z","event":"push","url":"https://example.invalid/runs/3"},
 {"databaseId":2,"conclusion":"failure","createdAt":"2026-10-17T10:00:00Z","event":"push","url":"https://example.invalid/runs/2"}
]
EOF

# Newest is a cancelled run sitting on top of a green one: cancelled must be
# ignored, so this is healthy (not "newest is not success").
cat >"$WS/cancelled-on-top.json" <<'EOF'
[
 {"databaseId":3,"conclusion":"cancelled","createdAt":"2026-10-17T20:50:00Z","event":"push","url":"https://example.invalid/runs/3"},
 {"databaseId":2,"conclusion":"success","createdAt":"2026-10-17T20:00:00Z","event":"push","url":"https://example.invalid/runs/2"}
]
EOF

# One failure 30 minutes ago: inside the grace window.
cat >"$WS/fresh-failure.json" <<'EOF'
[
 {"databaseId":3,"conclusion":"failure","createdAt":"2026-10-17T20:30:00Z","event":"push","url":"https://example.invalid/runs/3"},
 {"databaseId":2,"conclusion":"success","createdAt":"2026-10-17T10:00:00Z","event":"push","url":"https://example.invalid/runs/2"}
]
EOF

# Only non-conclusive runs: nothing to base a verdict on.
cat >"$WS/inconclusive.json" <<'EOF'
[
 {"databaseId":3,"conclusion":"cancelled","createdAt":"2026-10-17T20:50:00Z","event":"push","url":"https://example.invalid/runs/3"},
 {"databaseId":2,"conclusion":"skipped","createdAt":"2026-10-17T20:00:00Z","event":"push","url":"https://example.invalid/runs/2"}
]
EOF

printf '%s' '<html>502 Bad Gateway</html>' >"$WS/garbage.json"
printf '%s' '[]' >"$WS/empty.json"

run_guard() {
  env -u GITHUB_REPOSITORY DEPLOY_RUNS_JSON_FILE="$1" NOW_EPOCH="$NOW" bash "$GUARD"
}

# Exit code is part of the contract (1 = deploy is red, act on it; 2 = the
# monitor itself is blind), and assert_red only sees "non-zero".
assert_exit_code() {
  local desc="$1" expected="$2" rc
  shift 2
  "$@" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq "$expected" ]; then
    GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
    printf 'PASS  [code=%s] %s\n' "$expected" "$desc"
  else
    GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
    printf 'FAIL  [code!=%s] %s (got %s)\n' "$expected" "$desc" "$rc"
  fi
}

assert_red "standing streak (the 2026-10 incident) exits 1" \
  --contains "PROD DEPLOY IS RED" --contains "4 consecutive" --contains "workflow_dispatch=2" --contains "push=2" \
  --contains "runs/9" -- \
  run_guard "$WS/incident.json"

assert_green "newest conclusive run is success -> quiet" --contains "OK" -- \
  run_guard "$WS/green.json"

assert_green "cancelled run on top of a green one is ignored" --contains "OK" -- \
  run_guard "$WS/cancelled-on-top.json"

assert_green "fresh failure inside the grace window is not yet red" --contains "grace" -- \
  run_guard "$WS/fresh-failure.json"

assert_red "no conclusive run in the window fails CLOSED" --contains "cannot say deploy is healthy" -- \
  run_guard "$WS/inconclusive.json"

assert_red "empty run list fails CLOSED" -- run_guard "$WS/empty.json"

assert_red "unparseable API response fails CLOSED" --contains "unparseable" -- \
  run_guard "$WS/garbage.json"

assert_red "missing fixture file fails CLOSED" -- run_guard "$WS/does-not-exist.json"

assert_red "no repo and no fixture fails CLOSED instead of querying nothing" --contains "REPO" -- \
  env -u GITHUB_REPOSITORY -u REPO -u DEPLOY_RUNS_JSON_FILE bash "$GUARD"

assert_exit_code "red deploy exits 1 (act on it), not 2" 1 run_guard "$WS/incident.json"
assert_exit_code "green exits 0" 0 run_guard "$WS/green.json"
assert_exit_code "blind monitor exits 2 (broken sentinel), not 1" 2 run_guard "$WS/garbage.json"
assert_exit_code "no conclusive run exits 2, not 0" 2 run_guard "$WS/inconclusive.json"

guard_test_summary "test-check-deploy-freshness.sh"
