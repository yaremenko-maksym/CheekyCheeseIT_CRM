#!/usr/bin/env bash
# test-check-cloudflare-ai-plan.sh - proves scripts/devops/check-cloudflare-ai-plan.sh names the
# plan only on the one response that proves it, and never leaks the token.
#
# The owner reads one line from this script to decide whether the AI overage can bill. A wrong
# "Workers Free" is the expensive mistake, so most cases here are responses that must NOT read as
# Free: a 5035 inside a 5xx, a code that merely starts with 5035, an auth failure. The network path
# runs against a curl shim, offline, which also fails if the token ever reaches curl's argv.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

SUBJECT="$GUARD_DIR/check-cloudflare-ai-plan.sh"
WS="$(guard_test_workspace)"
TOKEN=testtoken_ABC123-xyz
ACCOUNT=0123456789abcdef0123456789abcdef

body() { printf '%s' "$2" >"$WS/$1.json"; printf '%s' "$WS/$1.json"; }
# The exit code itself is the contract (0 Free, 3 Paid, 1 unknown, 2 bad input). An exit_is case is
# asserted green: it passes only when the subject exited with exactly that code.
exit_is() {
  local want="$1" rc
  shift
  "$@"
  rc=$?
  [ "$rc" -eq "$want" ] || { echo "exit $rc, expected $want"; return 1; }
}

FREE_BODY='{"success":false,"errors":[{"code":5035,"message":"This model is not available on the Workers Free plan"}],"result":null}'

# ── classify ────────────────────────────────────────────────────────────────
assert_green "403 with 5035 -> Workers Free, exit 0" --contains "PLAN: Workers Free" \
  -- exit_is 0 "$SUBJECT" --classify 403 "$(body free "$FREE_BODY")"
assert_green "5035 with spaces around the colon -> still Workers Free" --contains "PLAN: Workers Free" \
  -- exit_is 0 "$SUBJECT" --classify 403 "$(body spaced '{"errors":[{"code" : 5035}]}')"
assert_green "200 -> Workers Paid, exit 3, with the do-not-loop warning on the same line" \
  --contains "PLAN: Workers Paid" --contains "do not run it in a loop" \
  -- exit_is 3 "$SUBJECT" --classify 200 "$(body paid '{"success":true,"result":{"response":"o"}}')"
assert_red "200 is not a pass: Paid exits non-zero" --contains "PLAN: Workers Paid" \
  -- "$SUBJECT" --classify 200 "$WS/paid.json"
assert_green "5035 inside a 500 -> UNKNOWN, not Free" --contains "PLAN: UNKNOWN" --not-contains "Workers Free" \
  -- exit_is 1 "$SUBJECT" --classify 500 "$(body err500 "$FREE_BODY")"
assert_red "code 50350 is not 5035 -> UNKNOWN" --contains "PLAN: UNKNOWN" --not-contains "Workers Free" \
  -- "$SUBJECT" --classify 403 "$(body prefix '{"errors":[{"code":50350}]}')"
assert_red "401 auth error -> UNKNOWN with the code" --contains "error codes: 10000" --not-contains "Workers Free" \
  -- "$SUBJECT" --classify 401 "$(body auth '{"errors":[{"code":10000,"message":"Authentication error"}]}')"
assert_red "403 with the message but no code -> UNKNOWN" --contains "PLAN: UNKNOWN" \
  -- "$SUBJECT" --classify 403 "$(body nocode '{"errors":[{"message":"not available on the Workers Free plan"}]}')"
assert_green "--classify without a body file -> usage, exit 2" \
  -- exit_is 2 "$SUBJECT" --classify 403 "$WS/absent.json"

# ── env file and the network path, against a curl shim ──────────────────────
# The shim fails unless the token arrives on stdin as a header, and fails if it is in argv.
# shellcheck disable=SC2016  # the shim body expands its own variables when it runs, not here
guard_test_shim "$WS" curl '#!/usr/bin/env bash
cfg="$(cat)"
case "$*" in *"$FAKE_TOKEN"*) echo "token in argv" >&2; exit 98 ;; esac
case "$cfg" in *"Authorization: Bearer $FAKE_TOKEN"*) ;; *) echo "no auth header on stdin" >&2; exit 99 ;; esac
case "$*" in *"/accounts/$FAKE_ACCOUNT/ai/run/@cf/"*"max_tokens\":1"*|*"max_tokens\":1"*"/accounts/$FAKE_ACCOUNT/ai/run/@cf/"*) ;; *) echo "unexpected request: $*" >&2; exit 97 ;; esac
while [ $# -gt 0 ]; do [ "$1" = -o ] && { printf "%s" "$FAKE_BODY" > "$2"; shift; }; shift; done
printf "%s" "$FAKE_STATUS"'
export FAKE_TOKEN="$TOKEN" FAKE_ACCOUNT="$ACCOUNT"
PATH="$WS/bin:$PATH"

envfile() { printf '%s\n' "$2" >"$WS/$1.env"; printf '%s' "$WS/$1.env"; }
GOOD_ENV="$(envfile good "EXTRACTION_WORKER_SECRET=x
CLOUDFLARE_ACCOUNT_ID=$ACCOUNT
CLOUDFLARE_AI_TOKEN=$TOKEN")"

assert_green "network path, Free response -> Workers Free; token never printed" \
  --contains "PLAN: Workers Free" --not-contains "$TOKEN" --not-contains "$ACCOUNT" \
  -- env FAKE_STATUS=403 FAKE_BODY="$FREE_BODY" "$SUBJECT" "$GOOD_ENV"
assert_green "network path, quoted values are read" --contains "PLAN: Workers Free" \
  -- env FAKE_STATUS=403 FAKE_BODY="$FREE_BODY" "$SUBJECT" "$(envfile quoted "CLOUDFLARE_ACCOUNT_ID=\"$ACCOUNT\"
CLOUDFLARE_AI_TOKEN='$TOKEN'")"
assert_green "network path, Paid response -> exit 3, the body never printed" \
  --contains "PLAN: Workers Paid" --not-contains "SECRET_BODY_TEXT" \
  -- exit_is 3 env FAKE_STATUS=200 FAKE_BODY='{"result":{"response":"SECRET_BODY_TEXT"}}' "$SUBJECT" "$GOOD_ENV"
assert_red "network path, curl fails -> UNKNOWN" --contains "PLAN: UNKNOWN" \
  -- env FAKE_STATUS=403 FAKE_BODY="$FREE_BODY" FAKE_TOKEN=other "$SUBJECT" "$GOOD_ENV"
assert_green "missing env file -> exit 2" \
  -- exit_is 2 "$SUBJECT" "$WS/absent.env"
assert_green "account id not 32 hex -> exit 2, the token not echoed" --not-contains "$TOKEN" \
  -- exit_is 2 "$SUBJECT" "$(envfile badacct "CLOUDFLARE_ACCOUNT_ID=0123
CLOUDFLARE_AI_TOKEN=$TOKEN")"
assert_green "token with a quote (would break the curl config line) -> exit 2" --not-contains 'ab"cd' \
  -- exit_is 2 "$SUBJECT" "$(envfile badtok "CLOUDFLARE_ACCOUNT_ID=$ACCOUNT
CLOUDFLARE_AI_TOKEN=ab\"cd")"
assert_green "no token -> exit 2" \
  -- exit_is 2 "$SUBJECT" "$(envfile notok "CLOUDFLARE_ACCOUNT_ID=$ACCOUNT")"
assert_green "probe model override that is not a @cf id -> exit 2" \
  -- exit_is 2 env CF_PLAN_PROBE_MODEL='../../user/tokens' "$SUBJECT" "$GOOD_ENV"

rm -rf "$WS"
guard_test_summary "test-check-cloudflare-ai-plan.sh"
