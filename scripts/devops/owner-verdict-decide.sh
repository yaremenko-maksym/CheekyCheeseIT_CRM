#!/usr/bin/env bash
# owner-verdict-decide.sh — the go / no-go of owner-verdict-merge.yml, step Decide.
# Proceeds only on `approved` (the owner's fresh verdict on this exact head), a PR head that still
# equals HEAD_SHA, no .github/workflows/ file (GITHUB_TOKEN cannot merge those) and no
# `do-not-merge` / `awaiting-pm-review` label. Fails CLOSED: any read that fails (pr.json /
# files.json unreadable, the labels API erroring) is `go=false`, never a skipped check.
# Env: STATUS (check-owner-approval.mjs .status), HEAD_SHA, D (owner-verdict-fetch.sh output dir),
#      REPO, PR_NUMBER, GH_BIN (default gh; tests point it at a stub), GITHUB_OUTPUT (optional).
# Always exits 0; the answer is the `go=` line.
# Tests: scripts/devops/tests/test-check-owner-approval.sh (section "Decide").
set -uo pipefail
: "${STATUS:?}" "${HEAD_SHA:?}" "${D:?}" "${REPO:?}" "${PR_NUMBER:?}"
GH_BIN="${GH_BIN:-gh}"

decide() {
  if [ "$STATUS" != "approved" ]; then
    echo "not merging: status is $STATUS"
    return 1
  fi
  local pr_head wf labels
  if ! pr_head=$(jq -er .headSha "$D/pr.json"); then
    echo "not merging: pr.json unreadable — failing closed"
    return 1
  fi
  if [ "$pr_head" != "$HEAD_SHA" ]; then
    echo "not merging: the PR head moved past $HEAD_SHA"
    return 1
  fi
  if ! wf=$(jq -e 'type == "array" and length > 0' "$D/files.json" >/dev/null &&
    jq -r 'any(.[]; .filename | startswith(".github/workflows/"))' "$D/files.json"); then
    echo "not merging: files.json unreadable or empty — failing closed"
    return 1
  fi
  if [ "$wf" != "false" ]; then
    echo "::notice::PR #$PR_NUMBER touches .github/workflows/ — manual merge by the owner (GITHUB_TOKEN cannot write workflow files)."
    return 1
  fi
  # Read first, match second: a failed API call must not read as "no blocking label".
  if ! labels=$("$GH_BIN" api --paginate "repos/$REPO/issues/$PR_NUMBER/labels?per_page=100" --jq '.[].name'); then
    echo "not merging: could not read the PR labels (API failure) — failing closed"
    return 1
  fi
  if printf '%s\n' "$labels" | grep -qxE 'do-not-merge|awaiting-pm-review'; then
    echo "not merging: a do-not-merge / awaiting-pm-review label is set"
    return 1
  fi
  return 0
}

go=false
decide && go=true
echo "go=$go"
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "go=$go" >>"$GITHUB_OUTPUT"; fi
exit 0
