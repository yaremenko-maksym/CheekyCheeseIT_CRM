#!/usr/bin/env bash
# test-check-extraction-router-sample.sh - both directions for the router-sample guard: the runbook's
# sample and the rehearsal's config are accepted by the worker's router (5.4c-H1, hosted-only); a
# stale `floorBudgetMs` or `local` route is refused.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/check-extraction-router-sample.mjs"
TSX="$REPO_ROOT/apps/api/node_modules/.bin/tsx"
RUNBOOK="$REPO_ROOT/docs/runbooks/extraction-worker.md"
REHEARSAL="$REPO_ROOT/scripts/devops/rehearse-extraction-deploy-paths.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

check() { "$TSX" --conditions=source "$GUARD" "$@"; }

assert_green "runbook sample: accepted, every route kept" --contains "routes kept: gemini, groq, cloudflare" -- check "$RUNBOOK"
assert_green "rehearsal config: accepted, every route kept" --contains "routes kept: gemini, groq, cloudflare" -- check "$REHEARSAL"

sed 's/"hostedBudgetMs":90000,/"hostedBudgetMs":90000,"floorBudgetMs":180000,/' "$RUNBOOK" > "$TMP/floor.md"
assert_red "a stale floorBudgetMs is refused" --contains "router refused the config" -- check "$TMP/floor.md"

sed 's/"freeLimit":{"requestsPerDay":16}}]}/"freeLimit":{"requestsPerDay":16}},{"provider":"local","models":["m"],"contextTokens":8000,"timeoutMs":30000,"maxAnswerTokens":1000}]}/' "$RUNBOOK" > "$TMP/local.md"
assert_red "a stale local route is refused" --contains "router refused the config" -- check "$TMP/local.md"

grep -v '^EXTRACTION_ROUTER_CONFIG=' "$RUNBOOK" > "$TMP/none.md"
assert_red "no sample line is a failure, not a pass" --contains "found 0" -- check "$TMP/none.md"

{ cat "$RUNBOOK"; grep '^EXTRACTION_ROUTER_CONFIG=' "$RUNBOOK"; } > "$TMP/two.md"
assert_red "two sample lines are ambiguous" --contains "found 2" -- check "$TMP/two.md"

guard_test_summary "check-extraction-router-sample"
