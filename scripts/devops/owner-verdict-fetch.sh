#!/usr/bin/env bash
# owner-verdict-fetch.sh — reads one PR through the REST API, as data, into $D for
# check-owner-approval.mjs: files.json, pr.json (head, author, changed_files, reviews with body and
# commit_id) and contents.json (head-sha text of the unowned code files the scanner names).
# Shared by the `Owner Verdict` job (flow-gate.yml) and owner-verdict-merge.yml.
# Run from a checkout of main (needs .github/CODEOWNERS and scripts/devops/). Never runs PR code.
# A content fetch that fails is recorded as `unavailable` — the scanner reads that as a trigger.
# Reviews come from GraphQL (with an `edited` flag); a page set that does not add up to
# totalCount fails the fetch.
# Env: GH_TOKEN, REPO, PR_NUMBER, D (output dir), GH_BIN (default gh; tests point it at a stub).
# Tests: scripts/devops/tests/test-check-owner-approval.sh (section "Fetch").
set -euo pipefail
: "${REPO:?}" "${PR_NUMBER:?}" "${D:?}"
[[ "$PR_NUMBER" =~ ^[0-9]+$ ]] || { echo "::error::PR_NUMBER is not a number"; exit 1; }
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "::error::REPO is not owner/name"; exit 1; }
GH_BIN="${GH_BIN:-gh}"
mkdir -p "$D"

"$GH_BIN" api --paginate "repos/$REPO/pulls/$PR_NUMBER/files?per_page=100" \
  --jq '.[] | {filename, previous_filename, status}' | jq -s . >"$D/files.json"
# Reviews through GraphQL, not REST: only GraphQL says whether a review body was edited after it
# was posted (SR-H-1 — an edited owner review never approves). Any of the three edit signals
# counts. The page union must hold totalCount reviews, or the fetch fails (never a short list).
# shellcheck disable=SC2016 # GraphQL variables, not shell
Q='query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviews(first: 100, after: $endCursor) {
      totalCount pageInfo { hasNextPage endCursor }
      nodes { author { login } state body commit { oid } lastEditedAt includesCreatedEdit
              userContentEdits { totalCount } } } } } }'
"$GH_BIN" api graphql --paginate -f query="$Q" -f owner="${REPO%%/*}" -f name="${REPO#*/}" \
  -F number="$PR_NUMBER" \
  --jq '.data.repository.pullRequest.reviews | {total: .totalCount, nodes: [.nodes[] | {
      author: (.author.login // ""), state, body: (.body // ""), commit_id: (.commit.oid // null),
      edited: (.lastEditedAt != null or .includesCreatedEdit == true
               or (.userContentEdits.totalCount // 0) > 0)}]}' >"$D/reviews.pages"
jq -es 'if length > 0 and (.[0].total | type) == "number" and ([.[].nodes[]] | length) == .[0].total
        then [.[].nodes[]] else error("review pages do not add up to totalCount") end' \
  "$D/reviews.pages" >"$D/reviews.json"
"$GH_BIN" api "repos/$REPO/pulls/$PR_NUMBER" \
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
  if "$GH_BIN" api -H "Accept: application/vnd.github.raw+json" "repos/$REPO/contents/$enc?ref=$head_sha" \
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
