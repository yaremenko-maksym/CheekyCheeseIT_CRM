#!/usr/bin/env bash
# test-check-security-headers.sh — proves scripts/devops/check-security-headers.sh
# goes RED against an origin whose security headers are wrong.
#
# WHAT IS AND IS NOT PROVEN HERE (stated plainly, because a guard test that
# overclaims is the same disease one level up): this runs the real guard against
# lib/fake-origin.py, whose "good" header values are copied verbatim from
# nginx/conf.d/csp-map.conf + security-headers.conf. So these cases prove the
# GUARD notices a broken origin. They do not prove nginx's config is correct —
# that is deploy.yml's own FATAL post-deploy smoke step, which runs this same
# script against real nginx on the VPS. If someone edits csp-map.conf and this
# guard's assertions together, the fixture goes stale and the positive case here
# keeps passing; only the live smoke step catches that.
#
# Every negative case is a regression this repo has actually shipped or nearly
# shipped (PR #429: Turnstile missing from landing's CSP, crm.conf locations
# losing every security header via nginx's add_header inheritance rule) or the
# textbook way to make a header check green without a header that does anything.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/check-security-headers.sh"

# $1 = flaw, $2 = CRM_CSP_MODE (both the fixture's and the guard's — they are
# meant to be one value, and the guard exists partly to catch them disagreeing).
run_case() {
  local flaw="$1" mode="${2:-report-only}"
  start_fake_origin headers --flaw "$flaw" --crm-csp-mode "$mode" || return 99
  local rc=0
  CRM_CSP_MODE="$mode" bash "$GUARD" "$FAKE_ORIGIN_URL" || rc=$?
  stop_fake_origin
  return $rc
}

# Fixture and guard disagree about the mode on purpose.
run_mode_mismatch() {
  start_fake_origin headers --flaw none --crm-csp-mode enforcing || return 99
  local rc=0
  CRM_CSP_MODE=report-only bash "$GUARD" "$FAKE_ORIGIN_URL" || rc=$?
  stop_fake_origin
  return $rc
}

run_bad_mode_value() {
  CRM_CSP_MODE=whatever bash "$GUARD" "http://127.0.0.1:1"
}

echo "== test-check-security-headers.sh =="
echo

# ── positive ───────────────────────────────────────────────────────────────────
assert_green "correct headers on both vhosts (report-only CRM) -> all checks pass" \
  --contains "0 failed" \
  -- run_case none report-only

assert_green "same origin in enforcing mode passes when the guard is told so" \
  --contains "0 failed" \
  -- run_case none enforcing

# ── negative ───────────────────────────────────────────────────────────────────
assert_red "THE CHEAT: CRM CSP header present but wide open (default-src *) -> red" \
  --contains "want ABSENT: default-src *" \
  -- run_case csp-says-nothing

assert_red "PR #429 regression: landing CSP loses challenges.cloudflare.com -> red" \
  --contains "Turnstile: landing CSP script-src" \
  -- run_case landing-drops-turnstile

assert_red "PR #429 regression: CRM asset locations lose HSTS+CSP entirely -> red" \
  --contains "header missing entirely" \
  --contains "asset bundle" \
  -- run_case assets-lose-headers

assert_red "CSP quietly widened with 'unsafe-inline' in script-src -> red" \
  --contains "want ABSENT within script-src: unsafe-inline" \
  -- run_case csp-unsafe-inline

assert_red "CRM CSP drops the R2 allowance (would break document preview) -> red" \
  --contains "r2.cloudflarestorage.com" \
  -- run_case csp-drops-r2

assert_red "premature flip to enforcing while the mode says report-only -> red" \
  --contains "want: header ABSENT" \
  -- run_case csp-premature-enforcing

assert_red "origin enforcing but guard told report-only (the drift this mode var exists to catch) -> red" \
  -- run_mode_mismatch

assert_red "an unknown CRM_CSP_MODE value is rejected outright, not defaulted" \
  --contains "must be exactly" \
  -- run_bad_mode_value

# ── task-infra-webmanifest-mime ─────────────────────────────────────────────────
# CRM served /site.webmanifest as application/octet-stream (nginx's stock
# mime.types has no .webmanifest entry) instead of the spec-required
# application/manifest+json; landing had no manifest at all and answered a
# request for it with the SPA fallback's 200 text/html home page instead of an
# honest 404. Both fixed in nginx/nginx.conf + nginx/conf.d/landing.conf — these
# two cases prove the GUARD notices a regression of either one.
assert_red "CRM /site.webmanifest regresses to application/octet-stream -> red" \
  --contains "application/manifest+json" \
  -- run_case webmanifest-wrong-type

assert_red "Landing /site.webmanifest falls back to the SPA 200 instead of 404 -> red" \
  --contains "(want: 404)" \
  -- run_case webmanifest-landing-fallback

guard_test_summary "test-check-security-headers.sh"
