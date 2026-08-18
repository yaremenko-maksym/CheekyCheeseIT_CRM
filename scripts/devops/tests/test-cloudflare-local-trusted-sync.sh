#!/usr/bin/env bash
# test-cloudflare-local-trusted-sync.sh — proves the LOCAL_TRUSTED constant
# in check-cloudflare-ips-freshness.sh and generate-cloudflare-nginx-
# snippets.sh has NOT drifted apart (security review PR #557, informational,
# 2026-08-18).
#
# WHY A TEST INSTEAD OF ONE SHARED FILE: generate-cloudflare-nginx-
# snippets.sh runs INSIDE the nginx Docker build stage — nginx/Dockerfile
# COPYs ONLY that one script file into the build context, not the rest of
# scripts/devops/ (`COPY scripts/devops/generate-cloudflare-nginx-
# snippets.sh /tmp/...`). Extracting LOCAL_TRUSTED into a shared data file
# both scripts read would need a second COPY line in nginx/Dockerfile —
# confirmed by reading it, not assumed — which is out of THIS task's zone
# (nginx/** is a parallel mTLS-observability-phase PR's to touch, not this
# one's). A test that fails the moment the two constants diverge is the
# available alternative, and directly matches the review's own "one source,
# or a test that verifies they match". This repo has paid for "two
# descriptions of one zone, each individually looking right" before — see
# both scripts' own LOCAL_TRUSTED comments for the class of bug this guards.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

FRESHNESS="$GUARD_DIR/check-cloudflare-ips-freshness.sh"
GENERATOR="$GUARD_DIR/generate-cloudflare-nginx-snippets.sh"

# Extracts the single-quoted, possibly-multi-line value assigned to
# LOCAL_TRUSTED= in a shell script. python3 (a hard dependency of this repo
# already — ci.yml and several other guards run it) rather than sed/awk: the
# value spans multiple lines inside one pair of quotes, which a line-
# oriented tool has to special-case and a regex with DOTALL just doesn't.
extract_local_trusted() {
  python3 -c '
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"LOCAL_TRUSTED=\x27(.*?)\x27", text, re.S)
if not m:
    sys.exit("LOCAL_TRUSTED not found in " + sys.argv[1])
sys.stdout.write(m.group(1))
' "$1"
}

same_local_trusted() { [ "$1" = "$2" ]; }

echo "== test-cloudflare-local-trusted-sync.sh =="
echo

FROM_FRESHNESS="$(extract_local_trusted "$FRESHNESS")"
FROM_GENERATOR="$(extract_local_trusted "$GENERATOR")"

if [ -z "$FROM_FRESHNESS" ] || [ -z "$FROM_GENERATOR" ]; then
  echo "ERROR: could not extract LOCAL_TRUSTED from one or both scripts — extraction itself is broken, not just the values" >&2
  exit 2
fi

assert_green "LOCAL_TRUSTED is byte-identical between the two scripts, right now" \
  -- same_local_trusted "$FROM_FRESHNESS" "$FROM_GENERATOR"

# Negative case: proves this comparison is CAPABLE of failing — not just
# "the two files happen to agree today, and would agree with themselves no
# matter what I compared them to".
assert_red "the comparison itself detects a real difference (sanity — not vacuously green)" \
  -- same_local_trusted "$FROM_FRESHNESS" "${FROM_GENERATOR}
127.0.0.2"

guard_test_summary "test-cloudflare-local-trusted-sync.sh"
