#!/usr/bin/env bash
# test-check-required-checks-complete.sh — proves
# scripts/devops/check-required-checks-complete.sh actually waits for every
# required context it is told about, not just whichever ones happen to
# already exist on the PR (task-guards-that-do-not-guard, 2026-08-17).
#
# THE HEADLINE CASE is `one-required-context-never-appeared`: it reproduces
# the exact PR #503 shape — TWO contexts are required, the PR currently shows
# only ONE of them (green), the other has not been created at all. The
# command this guard replaces (`gh pr checks --watch --required`) would have
# exited 0 right there — `--required` only ever looked at checks that already
# exist. This guard must go red on that shape, or it has not fixed anything.
#
# The guard itself does not call the branch-protection API (see its header
# for why — GITHUB_TOKEN cannot ever hold the `administration` scope); it
# takes the required-context list as REQUIRED_CONTEXTS from its caller. So
# these tests drive that env var directly, and only stub `gh pr checks` via
# GH_BIN pointed at lib/fake-gh.sh.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/check-required-checks-complete.sh"
FAKE_GH="$SELF_DIR/lib/fake-gh.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

TWO_CONTEXTS="Typecheck · Lint · Unit Tests
E2E Tests"

THREE_CONTEXTS="Typecheck · Lint · Unit Tests
E2E Tests
Integration Tests (Postgres)"

# ── checks-list fixtures ─────────────────────────────────────────────────────
cat >"$WS/checks-both-pass.json" <<'EOF'
[
  {"name":"Typecheck · Lint · Unit Tests","bucket":"pass","state":"SUCCESS"},
  {"name":"E2E Tests","bucket":"pass","state":"SUCCESS"}
]
EOF

cat >"$WS/checks-skipping-counts.json" <<'EOF'
[
  {"name":"Typecheck · Lint · Unit Tests","bucket":"pass","state":"SUCCESS"},
  {"name":"E2E Tests","bucket":"skipping","state":"SKIPPED"}
]
EOF

# THE PR #503 SHAPE: one required context is green, the other is simply not
# in this list at all — nothing has created it yet.
cat >"$WS/checks-one-missing.json" <<'EOF'
[
  {"name":"Typecheck · Lint · Unit Tests","bucket":"pass","state":"SUCCESS"}
]
EOF

cat >"$WS/checks-one-failed.json" <<'EOF'
[
  {"name":"Typecheck · Lint · Unit Tests","bucket":"pass","state":"SUCCESS"},
  {"name":"E2E Tests","bucket":"fail","state":"FAILURE"}
]
EOF

cat >"$WS/checks-one-pending.json" <<'EOF'
[
  {"name":"Typecheck · Lint · Unit Tests","bucket":"pass","state":"SUCCESS"},
  {"name":"E2E Tests","bucket":"pending","state":"IN_PROGRESS"}
]
EOF

cat >"$WS/checks-three-pass.json" <<'EOF'
[
  {"name":"Typecheck · Lint · Unit Tests","bucket":"pass","state":"SUCCESS"},
  {"name":"E2E Tests","bucket":"pass","state":"SUCCESS"},
  {"name":"Integration Tests (Postgres)","bucket":"pass","state":"SUCCESS"}
]
EOF

run_guard() {
  # $1 = REQUIRED_CONTEXTS value, $2 = checks sequence (':'-separated fixture
  # paths), remaining = extra env assignments as NAME=value.
  local contexts="$1" sequence="$2"
  shift 2
  local extra_env=("$@")
  local counter
  counter="$(mktemp -u "$WS/counter-XXXXXX")"
  env \
    REPO="acme/crm" \
    PR_NUMBER="503" \
    REQUIRED_CONTEXTS="$contexts" \
    GH_BIN="$FAKE_GH" \
    FAKE_GH_CHECKS_SEQUENCE="$sequence" \
    FAKE_GH_CALL_COUNTER="$counter" \
    INTERVAL_SECONDS="1" \
    TIMEOUT_SECONDS="0" \
    ${extra_env[@]+"${extra_env[@]}"} \
    bash "$GUARD"
}

# ── green: both required contexts present and passing ──────────────────────
assert_green "both required contexts present and passing" \
  --contains "OK: every required context is present and passing" \
  -- run_guard "$TWO_CONTEXTS" "$WS/checks-both-pass.json"

# ── green: 'skipping' bucket satisfies a required context ──────────────────
assert_green "a required context with bucket=skipping counts as satisfied" \
  --contains "OK: every required context is present and passing" \
  -- run_guard "$TWO_CONTEXTS" "$WS/checks-skipping-counts.json"

# ── green: a THIRD required context (caller-supplied, not hardcoded here) ──
assert_green "a THIRD required context is waited on too, not just the usual two" \
  --contains "Integration Tests (Postgres)" \
  -- run_guard "$THREE_CONTEXTS" "$WS/checks-three-pass.json"

# ── RED: THE PR #503 SHAPE — one required context never appeared ───────────
assert_red "THE #503 BUG: one green check does not mean all required checks exist" \
  --contains "NEVER APPEARED" \
  --contains "E2E Tests" \
  -- run_guard "$TWO_CONTEXTS" "$WS/checks-one-missing.json"

# ── RED: a required context actually failed — fail-fast, named explicitly ──
assert_red "a required check that failed is reported by name, not just 'red'" \
  --contains "FAIL: required check(s) failed or were cancelled" \
  --contains "E2E Tests" \
  -- run_guard "$TWO_CONTEXTS" "$WS/checks-one-failed.json"

# ── RED: caller gave an empty/whitespace-only required-context list ────────
assert_red "an empty REQUIRED_CONTEXTS is refused, not treated as 'nothing required'" \
  --contains "contains no actual context names" \
  -- run_guard "
" "$WS/checks-both-pass.json"

# ── RED: a required context stays pending until the timeout ────────────────
assert_red "a required context still pending at the deadline is reported, not silently retried forever" \
  --contains "STILL PENDING" \
  --contains "E2E Tests" \
  -- run_guard "$TWO_CONTEXTS" "$WS/checks-one-pending.json" \
       TIMEOUT_SECONDS=1 INTERVAL_SECONDS=1

# ── GREEN: genuine polling — missing on poll 1, appears+passes on poll 2 ───
# Proves this is a real watch loop against a moving target, not a single
# snapshot dressed up as one — the exact distinction the #503 fix rests on.
assert_green "a required context that appears on the SECOND poll is waited for, not missed" \
  --contains "OK: every required context is present and passing" \
  -- run_guard "$TWO_CONTEXTS" "$WS/checks-one-missing.json:$WS/checks-both-pass.json" \
       TIMEOUT_SECONDS=5 INTERVAL_SECONDS=1

guard_test_summary "test-check-required-checks-complete.sh"
