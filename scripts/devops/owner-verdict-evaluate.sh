#!/usr/bin/env bash
# owner-verdict-evaluate.sh — check-owner-approval.mjs on the data in $D, then the go / no-go of
# owner-verdict-decide.sh. owner-verdict-merge.yml runs it twice: in step Decide, and again in step
# Squash on a FRESH fetch right before the pinned merge, so a BLOCK posted while the run waited on
# the checks stops the merge (SR-M-2).
# A scanner that prints nothing (a crash before --json) is status `error`, never an empty status
# (CR-M-1). Callers act on the `go=true` line, never on the exit status.
# Env: D, HEAD_SHA, REPO, PR_NUMBER, OWNER, GH_BIN (passed to decide), GITHUB_OUTPUT (optional),
#      OWNER_GATE_TS (optional, the TypeScript the scanner loads).
# Run from a checkout of main. Always exits 0.
# Tests: scripts/devops/tests/test-check-owner-approval.sh (section "Evaluate").
set -uo pipefail
: "${D:?}" "${OWNER:?}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

res=$(node "$SCRIPT_DIR/check-owner-approval.mjs" --codeowners "$ROOT/.github/CODEOWNERS" \
  --zones "$SCRIPT_DIR/owner-verdict-zones.json" --tsconfig-root "$ROOT" \
  --pr "$D/pr.json" --files "$D/files.json" --contents "$D/contents.json" \
  --owner "$OWNER" --json)
status=$(printf '%s' "$res" | jq -r '.status // "error"') || status=error
status=${status:-error}
echo "verdict status: $status"
STATUS="$status" bash "$SCRIPT_DIR/owner-verdict-decide.sh"
