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
#
# The five cases below them are the 2026-08-08 indexability class, and they
# are quieter still: every one of them serves a healthy-looking site to every
# human who visits, and is visible only in Search Console, weeks later, as
# pages that simply are not in the index:
#   geo-redirects-no-preference -> the exact production defect: a geo tier bounces
#                                  every client that expressed no language, i.e. crawlers
#   sitemap-url-redirects       -> one advertised URL hops; NO per-header case notices
#   hreflang-points-at-redirect -> the alternate cluster names an address that redirects
#   canonical-cross-points      -> a page asks Google to index a different URL instead
#   en-alias-200                -> two live addresses serving one page
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
assert_green "correct locale routing (cookie > Accept-Language > en) passes" \
  --contains "0 failed" \
  -- run_case none

# ── negative ───────────────────────────────────────────────────────────────────
assert_red "THE CHEAT: Vary present but missing Cookie (a field that decides) -> red" \
  --contains "FAIL  B4: Vary header present" \
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

# ── negative: indexability (2026-08-08) ───────────────────────────────────────
# These assert on the `FAIL  ` prefix, not on the case name alone: every case
# name appears in the output whether it passed or failed, so `--contains
# "INDEX-1"` would be satisfied by a green run. The two-space `FAIL  ` prefix
# is the guard's own printf format and is what makes the assertion mean
# "this specific case went red".

# THE PRODUCTION DEFECT. Cloudflare injects CF-IPCountry on every request, so
# a geo tier redirects everyone who expressed no language preference — which
# in practice is crawlers, since browsers always send Accept-Language. Four
# English URLs, all advertised as canonical/x-default, all bouncing.
assert_red "geo tier redirects a client that expressed no language -> red" \
  --contains "FAIL  INDEX-1" \
  --contains "FAIL  B5: CF-IPCountry: UA" \
  -- run_case geo-redirects-no-preference

# The case for the sweep existing at all: ONE advertised URL redirects, and
# not a single per-header case notices — they set a preference, so they never
# exercise the state a crawler arrives in. Before the sweep, this shipped green.
assert_red "one sitemap URL redirects a preference-less client -> red (no B case sees it)" \
  --contains "FAIL  INDEX-1" \
  --contains "FAIL  INDEX-2" \
  --not-contains "FAIL  B" \
  -- run_case sitemap-url-redirects

assert_red "hreflang/x-default point at an address that redirects -> red" \
  --contains "FAIL  INDEX-4" \
  -- run_case hreflang-points-at-redirect

assert_red "a page in the sitemap defers its canonical to another URL -> red" \
  --contains "FAIL  INDEX-3" \
  -- run_case canonical-cross-points

assert_red "/en/ stays alive as a 200 duplicate of / -> red" \
  --contains "FAIL  /en/ -> 301 /" \
  -- run_case en-alias-200

assert_red "Vary advertises CF-IPCountry after the geo tier is gone -> red" \
  --contains "FAIL  B4: Vary header present" \
  -- run_case vary-claims-geo

# Review round 1, finding 1: `rewrite` re-appends the query string, `return`
# does not — so the slashless `/en` branch dropped it. A campaign link to
# /en?utm=x landed on / with no attribution, and every other case stayed green.
assert_red "/en?utm=1 loses the query string on the 301 -> red" \
  --contains "FAIL  /en?utm=1 -> 301 keeps the query string" \
  -- run_case en-alias-drops-query

# Review round 1, finding 3: an empty sitemap left the sweeps iterating
# nothing and printing "0/0" as a PASS. Each sweep now re-checks the count
# itself, so a sweep cannot go green without having swept anything.
assert_red "an empty sitemap makes the sweeps themselves red, not just the floor -> red" \
  --contains "FAIL  sitemap.xml is reachable and non-empty" \
  --contains "FAIL  INDEX-1" \
  --contains "FAIL  INDEX-2" \
  --contains "FAIL  INDEX-3" \
  --contains "FAIL  INDEX-4" \
  -- run_case empty-sitemap

guard_test_summary "test-check-locale-routing.sh"
