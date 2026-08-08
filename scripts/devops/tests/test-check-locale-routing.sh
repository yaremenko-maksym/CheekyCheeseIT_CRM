#!/usr/bin/env bash
# test-check-locale-routing.sh — proves scripts/devops/check-locale-routing.sh
# goes RED when edge locale detection regresses.
#
# Scope note, same as the other two curl suites: this proves the GUARD's logic
# against lib/fake-origin.py, not that nginx/njs is correct. The live proof is
# deploy.yml's own post-deploy invocation of this script against the VPS.
#
# The negative cases are chosen for how QUIET each regression is in production —
# every one of them serves a 200 or a 302 that looks perfectly healthy in a
# browser, and is only visible as a bug later, in the wrong place:
#   vary-partial        -> a shared cache serves one visitor's language to the next
#   cookie-ignored      -> the user's explicit language choice is overridden by their browser
#   prefixed-redirects  -> crawlers get bounced off the URLs they were told to index
#   redirect-into-missing-page -> a visitor is sent to a page that does not exist in that language
#   no-cache-control    -> the 302 becomes cacheable
#   redos               -> one crafted header burns origin CPU
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/check-locale-routing.sh"

run_case() {
  local flaw="$1"
  start_fake_origin locale --flaw "$flaw" || return 99
  local rc=0
  bash "$GUARD" "$FAKE_ORIGIN_URL" || rc=$?
  stop_fake_origin
  return $rc
}

echo "== test-check-locale-routing.sh =="
echo

# ── positive ───────────────────────────────────────────────────────────────────
assert_green "correct locale routing (cookie > Accept-Language > CF-IPCountry > en) passes" \
  --contains "0 failed" \
  -- run_case none

# ── negative ───────────────────────────────────────────────────────────────────
assert_red "THE CHEAT: Vary present but missing CF-IPCountry (a field that decides) -> red" \
  --contains "B4: Vary header present" \
  -- run_case vary-partial

assert_red "cookie pref_locale ignored, Accept-Language wins instead -> red" \
  --contains "B2: Cookie pref_locale" \
  -- run_case cookie-ignored

# Review round 2, MED: every other case here could be satisfied by a guard that
# only checked the STATUS code. Nothing held the Location header, so "redirects
# to the RIGHT locale" — the entire purpose of this edge layer — was untested.
# Here the 302, the Vary and the Cache-Control are all correct; only the target
# language is wrong.
assert_red "302 to the WRONG locale (status and headers all correct) -> red" \
  --contains "B1: Accept-Language: ru -> 302 /ru/" \
  --contains "deep path: /careers/" \
  -- run_case wrong-locale-redirect

assert_red "already-prefixed URLs start redirecting again (crawler safety) -> red" \
  --contains "B3: /uk/ never redirects" \
  -- run_case prefixed-redirects

assert_red "redirect into a locale where the page was never prerendered -> red" \
  --contains "partial-prerender" \
  -- run_case redirect-into-missing-page

assert_red "302 loses its no-store Cache-Control (becomes cacheable) -> red" \
  --contains "Cache-Control: no-store present on 302" \
  -- run_case no-cache-control

assert_red "ReDoS: a pathological Accept-Language blows past the latency ceiling -> red" \
  --contains "B9: pathological Accept-Language" \
  -- run_case redos

guard_test_summary "test-check-locale-routing.sh"
