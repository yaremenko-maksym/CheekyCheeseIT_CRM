#!/usr/bin/env bash
# test-check-extraction-worker-secret.sh - both directions for the deploy.yml preflight of
# EXTRACTION_WORKER_SECRET: unset passes (Deploy runs on push and schedule), an unusable value is
# refused, and no case ever prints the value.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

SUBJECT="$GUARD_DIR/check-extraction-worker-secret.sh"
GOOD=0123456789abcdef0123456789abcdef
SHORT=0123456789abcdef0123456789abcde
LOW_DISTINCT=abcdefgabcdefgabcdefgabcdefgabcdefg

echo "== test-check-extraction-worker-secret.sh =="

assert_green "unset secret -> no worker, exit 0" --contains "unset (no worker)" \
  -- env -u EXTRACTION_WORKER_SECRET bash "$SUBJECT"
assert_green "empty secret -> no worker, exit 0" --contains "unset (no worker)" \
  -- env EXTRACTION_WORKER_SECRET= bash "$SUBJECT"
assert_green "32 hex chars, 16 distinct -> usable; the value is not printed" --contains "set, usable" \
  --not-contains "$GOOD" -- env EXTRACTION_WORKER_SECRET="$GOOD" bash "$SUBJECT"
assert_red "31 chars -> refused; the value is not printed" --contains "shorter than 32" \
  --not-contains "$SHORT" -- env EXTRACTION_WORKER_SECRET="$SHORT" bash "$SUBJECT"
assert_red "7 distinct chars -> refused; the value is not printed" --contains "fewer than 8 distinct" \
  --not-contains "$LOW_DISTINCT" -- env EXTRACTION_WORKER_SECRET="$LOW_DISTINCT" bash "$SUBJECT"
assert_red "a line break -> refused" --contains "line break" \
  -- env EXTRACTION_WORKER_SECRET="$GOOD
$GOOD" bash "$SUBJECT"
assert_red "a space -> refused" --contains "whitespace" \
  -- env EXTRACTION_WORKER_SECRET="$GOOD $GOOD" bash "$SUBJECT"

# G4: each of these reads differently in compose env_file and in .env.production.
for c in '$' '"' "'" '#' '\' '`'; do
  assert_red "a $c -> refused; the value is not printed" --contains "outside A-Z a-z 0-9" \
    --not-contains "${GOOD}${c}x" -- env EXTRACTION_WORKER_SECRET="${GOOD}${c}x" bash "$SUBJECT"
done
# G5: a non-ASCII value is refused, so no count depends on the runner's locale.
assert_red "a non-ASCII character -> refused" --contains "outside A-Z a-z 0-9" \
  -- env LC_ALL=en_US.UTF-8 EXTRACTION_WORKER_SECRET="${GOOD}é" bash "$SUBJECT"
assert_green "the documented generator (openssl rand -hex 32) passes" --contains "set, usable" \
  -- env EXTRACTION_WORKER_SECRET="$(openssl rand -hex 32)" bash "$SUBJECT"
assert_green "dot, underscore and dash are allowed" --contains "set, usable" \
  -- env EXTRACTION_WORKER_SECRET="${GOOD}._-" bash "$SUBJECT"

guard_test_summary "test-check-extraction-worker-secret.sh"
