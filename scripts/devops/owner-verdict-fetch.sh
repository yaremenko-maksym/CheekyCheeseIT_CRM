#!/usr/bin/env bash
# owner-verdict-fetch.sh — reads one PR through the REST API, as data, into $D for
# check-owner-approval.mjs: files.json, pr.json (head, author, changed_files, reviews with body and
# commit_id) and contents.json (head-sha text of the unowned code files the scanner names).
# Shared by the `Owner Verdict` job (flow-gate.yml) and owner-verdict-merge.yml.
# Run from a checkout of main (needs .github/CODEOWNERS and scripts/devops/). Never runs PR code.
# A content fetch that fails is recorded as `unavailable` — the scanner reads that as a trigger.
# Env: GH_TOKEN, REPO, PR_NUMBER, D (output dir).
set -euo pipefail
: "${REPO:?}" "${PR_NUMBER:?}" "${D:?}"
[[ "$PR_NUMBER" =~ ^[0-9]+$ ]] || { echo "::error::PR_NUMBER is not a number"; exit 1; }
mkdir -p "$D"

gh api --paginate "repos/$REPO/pulls/$PR_NUMBER/files?per_page=100" \
  --jq '.[] | {filename, previous_filename, status}' | jq -s . >"$D/files.json"
gh api --paginate "repos/$REPO/pulls/$PR_NUMBER/reviews?per_page=100" \
  --jq '.[] | {author: .user.login, state: .state, body: (.body // ""), commit_id: .commit_id}' \
  | jq -s . >"$D/reviews.json"
gh api "repos/$REPO/pulls/$PR_NUMBER" \
  --jq '{headSha: .head.sha, author: .user.login, counts: {changedFiles: .changed_files}}' >"$D/pr0.json"
jq --slurpfile r "$D/reviews.json" '. + {reviews: $r[0]}' "$D/pr0.json" >"$D/pr.json"

head_sha=$(jq -r .headSha "$D/pr.json")
[[ "$head_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::no head sha in the PR data"; exit 1; }

node scripts/devops/check-owner-approval.mjs --codeowners .github/CODEOWNERS \
  --files "$D/files.json" --fetch-plan >"$D/plan.txt"
: >"$D/contents.ndjson"
while IFS= read -r p; do
  [ -n "$p" ] || continue
  enc=$(jq -rn --arg p "$p" '$p | split("/") | map(@uri) | join("/")')
  if gh api -H "Accept: application/vnd.github.raw+json" "repos/$REPO/contents/$enc?ref=$head_sha" \
    >"$D/one" 2>"$D/one.err"; then
    jq -n --arg f "$p" --rawfile c "$D/one" '{filename: $f, content: $c}'
  else
    cat "$D/one.err" >&2
    jq -n --arg f "$p" '{filename: $f, unavailable: true}'
  fi >>"$D/contents.ndjson"
done <"$D/plan.txt"
jq -s . "$D/contents.ndjson" >"$D/contents.json"

echo "fetched: files=$(jq length "$D/files.json")/$(jq .counts.changedFiles "$D/pr.json")" \
  "reviews=$(jq '.reviews | length' "$D/pr.json") head=$head_sha author=$(jq -r .author "$D/pr.json")" \
  "contents planned=$(wc -l <"$D/plan.txt" | tr -d ' ')" \
  "fetched=$(jq '[.[] | select(.content)] | length' "$D/contents.json")" \
  "unavailable=$(jq '[.[] | select(.unavailable)] | length' "$D/contents.json")"
