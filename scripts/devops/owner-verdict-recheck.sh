#!/usr/bin/env bash
# owner-verdict-recheck.sh — the go / no-go re-read right before a merge attempt: a fresh
# owner-verdict-fetch.sh, then owner-verdict-evaluate.sh on it (its decide step also requires the
# freshly fetched PR head to equal HEAD_SHA).
# Exit 0 only on `go=true`; anything else exits 1 (never a merge).
# owner-verdict-merge.yml passes it to gh-merge-pr-with-retry.sh as PRE_ATTEMPT, so it runs before
# EACH merge attempt, not once before the retry loop: a BLOCK posted during a retry pause stops it.
# Env: GH_TOKEN, REPO, PR_NUMBER, HEAD_SHA, D, OWNER, GH_BIN (default gh; tests point it at a stub).
# Run from a checkout of main. Tests: scripts/devops/tests/test-check-owner-approval.sh ("Recheck").
set -euo pipefail
: "${REPO:?}" "${PR_NUMBER:?}" "${HEAD_SHA:?}" "${D:?}" "${OWNER:?}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GH_BIN="${GH_BIN:-gh}"

bash "$SCRIPT_DIR/owner-verdict-fetch.sh"
final=$(GITHUB_OUTPUT='' bash "$SCRIPT_DIR/owner-verdict-evaluate.sh")
printf '%s\n' "$final"
if ! printf '%s\n' "$final" | grep -qx 'go=true'; then
  echo "::error::the verdict re-read right before the merge is not a go — not merging."
  exit 1
fi
