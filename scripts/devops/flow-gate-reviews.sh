#!/usr/bin/env bash
# flow-gate-reviews.sh — the PR reviews for the Flow Gate job (flow-gate.yml), through GraphQL, as
# a JSON array on stdout in the shape scripts/architect/flow-gate.mjs reads
# ({author, association, state, body, at, commit_id}).
# SR-M-4: only GraphQL says whether a review body was edited after it was posted. An edited
# review is never positive evidence for `Verdict:` / `Security Review:` / `Spec Review:`: its body
# is replaced by one synthesized line per marker kind, where those three kinds keep only a
# negative verdict and every other kind keeps what flow-gate.mjs `parseMarker` read from it.
# A page set that does not add up to totalCount fails (never a short list).
# Env: REPO, PR_NUMBER, GH_BIN (default gh; tests point it at a stub).
# Run from a checkout holding scripts/architect/flow-gate.mjs and scripts/devops/.
# Tests: scripts/devops/tests/test-check-owner-approval.sh (section "Flow Gate reviews").
set -euo pipefail
: "${REPO:?}" "${PR_NUMBER:?}"
[[ "$PR_NUMBER" =~ ^[0-9]+$ ]] || { echo "::error::PR_NUMBER is not a number" >&2; exit 1; }
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "::error::REPO is not owner/name" >&2; exit 1; }
GH_BIN="${GH_BIN:-gh}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# shellcheck disable=SC2016 # GraphQL variables, not shell
Q='query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviews(first: 100, after: $endCursor) {
      totalCount pageInfo { hasNextPage endCursor }
      nodes { author { login } authorAssociation state body submittedAt commit { oid }
              lastEditedAt includesCreatedEdit userContentEdits { totalCount } } } } } }'
"$GH_BIN" api graphql --paginate -f query="$Q" -f owner="${REPO%%/*}" -f name="${REPO#*/}" \
  -F number="$PR_NUMBER" \
  --jq '.data.repository.pullRequest.reviews | {total: .totalCount, nodes: [.nodes[] | {
      author: (.author.login // ""), association: .authorAssociation, state, body: (.body // ""),
      at: .submittedAt, commit_id: (.commit.oid // null),
      edited: (.lastEditedAt != null or .includesCreatedEdit == true
               or (.userContentEdits.totalCount // 0) > 0)}]}' >"$tmp/pages"
jq -es 'if length > 0 and (.[0].total | type) == "number" and ([.[].nodes[]] | length) == .[0].total
        then [.[].nodes[]] else error("review pages do not add up to totalCount") end' \
  "$tmp/pages" >"$tmp/reviews.json"

# shellcheck disable=SC2016 # JavaScript template literals, not shell
FLOW_GATE="$ROOT/scripts/architect/flow-gate.mjs" node --input-type=module -e '
  import { readFileSync } from "node:fs"
  import { pathToFileURL } from "node:url"
  const { MARKERS, parseMarker } = await import(pathToFileURL(process.env.FLOW_GATE).href)
  const STRICT = new Set(["review", "security", "spec"])
  const reviews = JSON.parse(readFileSync(process.argv[1], "utf8"))
  const out = reviews.map(({ edited, ...r }) => {
    if (edited !== false) {
      const lines = ["(edited after posting: no positive Verdict / Security Review / Spec Review)"]
      for (const [kind, m] of Object.entries(MARKERS)) {
        const v = parseMarker(r.body, kind)
        if (v === "neg") lines.push(`${m.prefix}: ${m.neg[0]}`)
        else if (v === "pos" && !STRICT.has(kind)) lines.push(`${m.prefix}: ${m.pos[0]}`)
      }
      r.body = lines.join("\n")
    }
    return r
  })
  console.log(JSON.stringify(out))
' "$tmp/reviews.json"
