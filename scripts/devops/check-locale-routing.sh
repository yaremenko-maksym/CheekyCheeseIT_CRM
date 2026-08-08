#!/bin/bash
# check-locale-routing.sh — curl proof suite for edge locale detection
# (task-infra-locale-edge, AC B1-B9).
#
# Runs a fixed set of curl cases against ANY origin (local nginx test
# container during development, staging, or production for a post-deploy
# smoke check) and reports PASS/FAIL per case. Exit code is non-zero if any
# case fails — safe to wire into CI or a manual pre/post-deploy check.
#
# Tests: scripts/devops/tests/test-check-locale-routing.sh — positive AND
# negative cases against a controllable stub origin (tests/lib/fake-origin.py):
# a Vary header that is present but omits a field that decides the locale, an
# ignored pref_locale cookie, prefixed URLs that start redirecting again, a
# redirect into a locale the page was never prerendered in, a 302 that loses
# no-store, and a simulated ReDoS. Those prove THIS SCRIPT's logic; that nginx/njs
# is correct is proven by running this script against a real origin.
#
# Usage:
#   scripts/devops/check-locale-routing.sh [origin]
#   ORIGIN=https://cheekycheese.tech scripts/devops/check-locale-routing.sh
#
# Default origin: http://localhost:8080 (matches a local nginx container
# published on 8080; see scripts/devops/locale-routing-runbook.md for how to
# spin one up for a dry-run before every deploy that touches nginx/**).
#
# Detection order under test (plan-landing-i18n-seo.md §2, amended by the
# 2026-08-08 indexability fix — see nginx/njs/locale.js):
#   cookie pref_locale > Accept-Language best-match > en
# Supported locales: en (default, no prefix) | uk | ru | es | pt.
#
# INDEXABILITY SWEEP (added 2026-08-08, see the section of the same name
# below): the cases above test the DECISION. They cannot, on their own,
# catch the production defect that motivated it — every URL we advertise to
# search engines (sitemap.xml, rel=canonical, hreflang, x-default) redirected
# a preference-less client, so Google consolidated the entire English site
# into the Ukrainian one and indexed none of it. The sweep walks sitemap.xml
# and asserts that not one advertised URL answers anything but a bare 200 to
# a client that sent no Accept-Language — the property the markup claims and
# nothing was checking.
#
# AC B9 (added security-review round 1, HIGH-1): a pathological
# Accept-Language header must not add meaningful latency relative to a
# normal request — see the "ReDoS hardening" case near the end of this
# file. This script CANNOT check the nginx/docker error log for the
# absence of an unhandled njs exception (no log access for an arbitrary
# HTTP origin) — that half of the AC is verified manually against a local
# dry-run container, see scripts/devops/locale-routing-runbook.md "ReDoS
# hardening verification".
set -u

ORIGIN="${1:-${ORIGIN:-http://localhost:8080}}"
CURL_OPTS=(-s -k -o /dev/null -w '%{http_code}\n%{redirect_url}\n' --max-time 10)

PASS=0
FAIL=0

# Args: description, expected_status, expected_location_substring ("" = no
# Location expected / not checked), curl -H flags...
check() {
  local desc="$1" expected_status="$2" expected_location="$3"
  shift 3
  local out status location
  out="$(curl "${CURL_OPTS[@]}" "$@" "$ORIGIN/" 2>/dev/null)"
  status="$(printf '%s\n' "$out" | sed -n '1p')"
  location="$(printf '%s\n' "$out" | sed -n '2p')"

  local ok=1
  if [ "$status" != "$expected_status" ]; then
    ok=0
  fi
  if [ -n "$expected_location" ] && [[ "$location" != *"$expected_location"* ]]; then
    ok=0
  fi

  if [ "$ok" = "1" ]; then
    PASS=$((PASS + 1))
    printf 'PASS  %-70s status=%s location=%s\n' "$desc" "$status" "$location"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-70s status=%s (want %s) location=%s (want *%s*)\n' \
      "$desc" "$status" "$expected_status" "$location" "$expected_location"
  fi
}

# Same as `check` but against an arbitrary path (not just "/") — used for
# the crawler-safety / prefixed-URL / careers-slug cases below.
check_path() {
  local desc="$1" path="$2" expected_status="$3" expected_location="$4"
  shift 4
  local out status location
  out="$(curl "${CURL_OPTS[@]}" "$@" "$ORIGIN$path" 2>/dev/null)"
  status="$(printf '%s\n' "$out" | sed -n '1p')"
  location="$(printf '%s\n' "$out" | sed -n '2p')"

  local ok=1
  if [ "$status" != "$expected_status" ]; then
    ok=0
  fi
  if [ -n "$expected_location" ] && [[ "$location" != *"$expected_location"* ]]; then
    ok=0
  fi

  if [ "$ok" = "1" ]; then
    PASS=$((PASS + 1))
    printf 'PASS  %-70s status=%s location=%s\n' "$desc" "$status" "$location"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-70s status=%s (want %s) location=%s (want *%s*)\n' \
      "$desc" "$status" "$expected_status" "$location" "$expected_location"
  fi
}

# Like `check_path`, but the Location header must match EXACTLY rather than
# by substring. Needed wherever the expected target is short enough that a
# substring test is vacuous — `*"/"*` matches every Location there is, so
# asserting "redirects to /" the substring way asserts nothing at all.
check_path_exact() {
  local desc="$1" path="$2" expected_status="$3" expected_location="$4"
  shift 4
  local out status location
  out="$(curl "${CURL_OPTS[@]}" "$@" "$ORIGIN$path" 2>/dev/null)"
  status="$(printf '%s\n' "$out" | sed -n '1p')"
  location="$(printf '%s\n' "$out" | sed -n '2p')"
  # `redirect_url` is reported absolute even when the origin sends a
  # relative `Location:` (absolute_redirect off) — curl resolves it against
  # the request URL. Compare on the path, which is what we actually mean.
  local location_path="${location#"$ORIGIN"}"

  if [ "$status" = "$expected_status" ] && [ "$location_path" = "$expected_location" ]; then
    PASS=$((PASS + 1))
    printf 'PASS  %-70s status=%s location=%s\n' "$desc" "$status" "$location_path"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-70s status=%s (want %s) location=%s (want %s)\n' \
      "$desc" "$status" "$expected_status" "$location_path" "$expected_location"
  fi
}

echo "== check-locale-routing.sh — origin: $ORIGIN =="
echo

# ── B1: Accept-Language -> 302, plain "en" -> 200 ──────────────────────────
check "B1: Accept-Language: ru -> 302 /ru/" 302 "/ru/" \
  -H 'Accept-Language: ru'
check "B1: Accept-Language: en -> 200 (no redirect)" 200 "" \
  -H 'Accept-Language: en'

# ── B1/§2: best-match — exact + base-language, correct q-order ────────────
check "best-match: pt-BR,pt;q=0.9 -> 302 /pt/ (base-language)" 302 "/pt/" \
  -H 'Accept-Language: pt-BR,pt;q=0.9'
check "best-match: es-MX,es;q=0.9 -> 302 /es/ (base-language)" 302 "/es/" \
  -H 'Accept-Language: es-MX,es;q=0.9'
check "best-match: en-GB,en;q=0.9 -> 200 (base-language -> en)" 200 "" \
  -H 'Accept-Language: en-GB,en;q=0.9'
check "best-match: de-DE,de;q=0.9 -> 200 (no supported match -> en)" 200 "" \
  -H 'Accept-Language: de-DE,de;q=0.9'
check "best-match: q-value out of LEFT-TO-RIGHT order (en;q=0.5,ru;q=0.9 -> ru wins)" 302 "/ru/" \
  -H 'Accept-Language: en;q=0.5,ru;q=0.9'
check "best-match: unmatched tag then a real one (fr;q=0.9,uk;q=0.5 -> uk)" 302 "/uk/" \
  -H 'Accept-Language: fr;q=0.9,uk;q=0.5'

# ── B2: cookie pref_locale always wins, in both directions ────────────────
check "B2: Cookie pref_locale=en overrides Accept-Language: ru -> 200" 200 "" \
  -H 'Cookie: pref_locale=en' -H 'Accept-Language: ru'
check "B2: Cookie pref_locale=pt overrides Accept-Language: ru -> 302 /pt/" 302 "/pt/" \
  -H 'Cookie: pref_locale=pt' -H 'Accept-Language: ru'

# ── B3: crawler-safety — prefixed URLs NEVER redirect, bot gets 200 EN ────
check_path "B3: /uk/ never redirects (even with Accept-Language: ru)" "/uk/" 200 "" \
  -H 'Accept-Language: ru'
check_path "B3: /ru/ never redirects (even with Accept-Language: uk)" "/ru/" 200 "" \
  -H 'Accept-Language: uk'
check_path "B3: /es/careers/ never redirects" "/es/careers/" 200 "" \
  -H 'Accept-Language: ru'
check_path "B3: /pt/careers/ never redirects" "/pt/careers/" 200 "" \
  -H 'Accept-Language: ru'
check "B3: bot with NO Accept-Language header -> 200 EN" 200 ""

# ── B4: Vary present on redirect-eligible routes (both branches) ──────────
# Vary must name EXACTLY the request headers the locale decision reads —
# Accept-Language and Cookie. security-review round 1 (MED-2) originally also
# required CF-IPCountry here, correctly, because geolocation was a tier back
# then; the 2026-08-08 indexability fix removed that tier, so the header is
# now asserted ABSENT. A Vary listing a header the response no longer depends
# on is not harmless: it splits every shared cache on a value that differs
# per visitor, and it tells the next reader that geo still decides something.
assert_vary() {
  local desc="$1" vary="$2"
  if [[ "$vary" == *"Accept-Language"* && "$vary" == *"Cookie"* && "$vary" != *"CF-IPCountry"* ]]; then
    PASS=$((PASS + 1))
    printf 'PASS  %-70s %s\n' "$desc" "$vary"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-70s got=%s (want Accept-Language + Cookie, without CF-IPCountry)\n' "$desc" "$vary"
  fi
}
vary_redirect="$(curl -s -k -o /dev/null -D - --max-time 10 -H 'Accept-Language: ru' "$ORIGIN/" 2>/dev/null | grep -i '^Vary:')"
assert_vary "B4: Vary header present on 302 response" "$vary_redirect"
vary_passthrough="$(curl -s -k -o /dev/null -D - --max-time 10 -H 'Accept-Language: en' "$ORIGIN/" 2>/dev/null | grep -i '^Vary:')"
assert_vary "B4: Vary header present on 200 (EN passthrough)" "$vary_passthrough"

# security-review round 1 (MED-2): 302 responses must carry an explicit
# no-store Cache-Control — RFC 9111 does not heuristically cache a bare 302,
# but the finding was relying on that implicitly instead of stating it.
cache_control_redirect="$(curl -s -k -o /dev/null -D - --max-time 10 -H 'Accept-Language: ru' "$ORIGIN/" 2>/dev/null | grep -i '^Cache-Control:')"
if [[ "$cache_control_redirect" == *"no-store"* ]]; then
  PASS=$((PASS + 1))
  printf 'PASS  %-70s %s\n' "MED-2: Cache-Control: no-store present on 302" "$cache_control_redirect"
else
  FAIL=$((FAIL + 1))
  printf 'FAIL  %-70s got=%s\n' "MED-2: Cache-Control: no-store present on 302" "$cache_control_redirect"
fi

# security-review round 2 (PR #423, MED-6): the FIRST fix for MED-3 only
# matched `index.html` at a locale ROOT (0-1 path segments), so a NESTED
# index.html (`/careers/index.html`, `/uk/careers/index.html`,
# `/uk/careers/<slug>/index.html` — exactly what feature/landing-i18n
# prerenders) fell through to `@locale_fallback` with no explicit
# Cache-Control at all. Regression guard: `/careers/` already exists on
# main TODAY (task-vacancies-api, independent of feature/landing-i18n's
# merge status) — safe to run against real production right now, not just
# a local fixture with synthetic nested files.
cache_control_nested="$(curl -s -k -o /dev/null -D - --max-time 10 "$ORIGIN/careers/" 2>/dev/null | grep -i '^Cache-Control:')"
if [[ "$cache_control_nested" == *"no-store"* ]]; then
  PASS=$((PASS + 1))
  printf 'PASS  %-70s %s\n' "MED-6: nested index.html (/careers/) gets no-store Cache-Control" "$cache_control_nested"
else
  FAIL=$((FAIL + 1))
  printf 'FAIL  %-70s got=%s\n' "MED-6: nested index.html (/careers/) gets no-store Cache-Control" "$cache_control_nested"
fi

# ── B5: geolocation is NOT a language preference ──────────────────────────
# This section used to assert the OPPOSITE (CF-IPCountry: UA -> 302 /uk/).
# That tier is what broke indexing: Cloudflare injects CF-IPCountry on every
# request, so a client that expressed no language preference — which in
# practice means a crawler, since browsers always send Accept-Language — was
# redirected off `/` by its IP address. `/` is the canonical AND x-default
# URL for the English site, so Google saw four English URLs that all bounced
# and folded them into the Ukrainian versions. Removed at the source
# (nginx/njs/locale.js); these cases keep it removed, and are written against
# the two countries whose mapping caused the incident so a re-introduction
# fails here rather than in Search Console three weeks later.
check "B5: CF-IPCountry: UA (no Accept-Language) -> 200 EN, no redirect" 200 "" \
  -H 'CF-IPCountry: UA'
check "B5: CF-IPCountry: RU (no Accept-Language) -> 200 EN, no redirect" 200 "" \
  -H 'CF-IPCountry: RU'
check "B5: CF-IPCountry: BR (no Accept-Language) -> 200 EN, no redirect" 200 "" \
  -H 'CF-IPCountry: BR'
check "B5: CF-IPCountry: MX (no Accept-Language) -> 200 EN, no redirect" 200 "" \
  -H 'CF-IPCountry: MX'
check_path "B5: CF-IPCountry: UA on /careers/ -> 200, no redirect" "/careers/" 200 "" \
  -H 'CF-IPCountry: UA'
# An EXPRESSED preference still redirects — the geo removal must not have
# taken the actual feature with it (AC B1 covers the header alone; this
# covers it in the presence of the geo signal that used to compete with it).
check "B5: Accept-Language still redirects when CF-IPCountry disagrees" 302 "/ru/" \
  -H 'CF-IPCountry: UA' -H 'Accept-Language: ru'

# ── /en/ — the accidental duplicate of the English pages ──────────────────
# `/en/` is not a route (English is unprefixed — apps/landing/app/i18n/locale.ts
# `localePrefix('en') === ''`), but the SPA fallback answered it with the
# prerendered HOME markup: a 200 duplicate of `/` carrying `rel=canonical`
# pointing back at `/`. Collapsed to a 301 in nginx/conf.d/landing.conf.
check_path_exact "/en/ -> 301 / (no duplicate address for the same page)" "/en/" 301 "/"
check_path_exact "/en -> 301 /" "/en" 301 "/"
check_path_exact "/en/careers/ -> 301 /careers/ (deep path preserved)" \
  "/en/careers/" 301 "/careers/"

# ── Trailing-slash / deep-path preservation (plan §1) ──────────────────────
check_path "deep path: /careers/ + ru -> 302 /ru/careers/ (trailing slash kept)" "/careers/" 302 "/ru/careers/" \
  -H 'Accept-Language: ru'
check_path "deep path: /careers/my-slug/ + uk -> 302 /uk/careers/my-slug/" "/careers/my-slug/" 302 "/uk/careers/my-slug/" \
  -H 'Accept-Language: uk'

# code-review round (PR #423): partial-prerender guard correctness — a path
# that does NOT exist for the target locale (even though the locale ROOT
# does) must NOT redirect into a silent language mismatch. Uses a slug that
# is guaranteed to never exist on any real origin either, so this is safe
# to run against production as a permanent regression guard, not just a
# local-fixture-only case.
check_path "partial-prerender: nonexistent deep slug + uk -> 200 EN (no silent mismatch)" \
  "/careers/__check-locale-routing-nonexistent-slug__/" 200 "" \
  -H 'Accept-Language: uk'

# ══════════════════════════════════════════════════════════════════════════
# INDEXABILITY SWEEP — every URL we advertise must answer a bare 200
# ══════════════════════════════════════════════════════════════════════════
# The 2026-08-08 production defect this section exists to catch: the four
# English URLs (`/`, `/careers/`, `/careers/<slug>/` ×2) were listed in
# sitemap.xml, named by `rel=canonical`, and pointed at by `hreflang="en"`
# and `hreflang="x-default"` from all five locales — and every one of them
# 302'd a client that sent no Accept-Language. Google Search Console reported
# them as "Alternate page with proper canonical tag": consolidated into the
# Ukrainian versions, English absent from the index entirely.
#
# Every individual case above passed throughout. They test the DECISION
# (given this header, which locale?) and the decision was working as
# specified — the specification was wrong. What nothing tested was the
# property the markup asserts to a crawler: an advertised URL resolves, in
# one hop, to the page it claims to be. So that is what this sweeps, over
# the real sitemap rather than a hardcoded list, in the two shapes a crawler
# actually arrives in: no Accept-Language at all, and Googlebot's UA.
#
# The Googlebot-UA pass is NOT a request for special treatment — it must
# produce the identical result to the anonymous pass. Serving crawlers
# something different from humans is cloaking; this pair is what would catch
# someone "fixing" a future regression that way.
GOOGLEBOT_UA='Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
# A healthy sitemap is 5 locales × (home + careers + N vacancies). The floor
# is deliberately low (the vacancy count is live data and legitimately
# changes) but non-zero: a sweep over an empty list is a check that cannot
# fail, which is the exact defect class this section was written to end.
MIN_SITEMAP_URLS=5

# Absolute URL -> origin-relative path. sitemap.xml and the canonical/hreflang
# markup always carry PRODUCTION-absolute URLs (SITE_ORIGIN in
# apps/landing/app/lib/seo.ts), including in a local dry-run container, so
# every advertised URL is re-pointed at $ORIGIN before being fetched.
url_path() {
  local rest="${1#*://}"
  case "$rest" in
    */*) printf '/%s' "${rest#*/}" ;;
    *) printf '/' ;;
  esac
}

extract_hrefs() {
  grep -oE 'href="[^"]+"' | sed -E 's/^href="//; s/"$//'
}

sitemap_body="$(curl -s -k --max-time 15 "$ORIGIN/sitemap.xml" 2>/dev/null)"
SITEMAP_URLS="$(printf '%s' "$sitemap_body" | grep -oE '<loc>[^<]+</loc>' | sed -E 's|</?loc>||g')"
sitemap_count="$(printf '%s' "$SITEMAP_URLS" | grep -c . || true)"

if [ "$sitemap_count" -ge "$MIN_SITEMAP_URLS" ]; then
  PASS=$((PASS + 1))
  printf 'PASS  %-70s %s URLs\n' "sitemap.xml is reachable and non-empty" "$sitemap_count"
else
  FAIL=$((FAIL + 1))
  printf 'FAIL  %-70s got %s URLs (want >= %s) — the sweeps below are vacuous\n' \
    "sitemap.xml is reachable and non-empty" "$sitemap_count" "$MIN_SITEMAP_URLS"
fi

# Paths proven to answer a bare 200 in the anonymous sweep — reused to avoid
# re-fetching the same URL when it shows up again as an hreflang target.
# Newline-delimited on BOTH sides of every entry so a lookup for `/` cannot
# match `/careers/` by prefix.
SWEPT_OK=$'\n'
# Everything the served pages advertise, collected during the sweep.
ADVERTISED_ALTERNATES=""
XDEFAULT_HREFS=""
canonical_mismatches=""
anon_failures=""

for url in $SITEMAP_URLS; do
  path="$(url_path "$url")"
  body_file="$(mktemp)"
  out="$(curl -s -k -o "$body_file" -w '%{http_code}\n%{redirect_url}\n' --max-time 15 "$ORIGIN$path" 2>/dev/null)"
  status="$(printf '%s\n' "$out" | sed -n '1p')"
  location="$(printf '%s\n' "$out" | sed -n '2p')"

  if [ "$status" = "200" ] && [ -z "$location" ]; then
    SWEPT_OK="${SWEPT_OK}${path}"$'\n'
  else
    anon_failures="$anon_failures        ↳ $path -> status=$status location=$location
"
  fi

  # rel=canonical must name the URL itself. A page in the sitemap that
  # points its canonical somewhere else is asking Google to drop it — the
  # `/en/` duplicate did exactly that, and so did every English page once
  # Google followed the 302 and read the Ukrainian page's markup.
  canonical="$(grep -oE '<link[^>]+rel="canonical"[^>]*>' "$body_file" | extract_hrefs | head -1)"
  if [ "$canonical" != "$url" ]; then
    canonical_mismatches="$canonical_mismatches        ↳ $url declares canonical=${canonical:-<none>}
"
  fi

  page_alternates="$(grep -oE '<link[^>]+rel="alternate"[^>]*>' "$body_file" | extract_hrefs)"
  ADVERTISED_ALTERNATES="$ADVERTISED_ALTERNATES$page_alternates
"
  page_xdefault="$(grep -oE '<link[^>]+hreflang="x-default"[^>]*>' "$body_file" | extract_hrefs)"
  XDEFAULT_HREFS="$XDEFAULT_HREFS$page_xdefault
"
  rm -f "$body_file"
done

# sitemap.xml carries its own reciprocal `xhtml:link` alternate cluster —
# same advertisement, different file, equally capable of pointing at a
# redirect. Folded into the same pool.
sitemap_alternates="$(printf '%s' "$sitemap_body" | grep -oE '<xhtml:link[^>]*>' | extract_hrefs)"
ADVERTISED_ALTERNATES="$ADVERTISED_ALTERNATES$sitemap_alternates"

if [ -z "$anon_failures" ]; then
  PASS=$((PASS + 1))
  printf 'PASS  %-70s %s/%s\n' "INDEX-1: every sitemap URL -> 200, no Accept-Language sent" \
    "$sitemap_count" "$sitemap_count"
else
  FAIL=$((FAIL + 1))
  printf 'FAIL  %-70s\n' "INDEX-1: every sitemap URL -> 200, no Accept-Language sent"
  printf '%s' "$anon_failures"
fi

bot_failures=""
for url in $SITEMAP_URLS; do
  path="$(url_path "$url")"
  out="$(curl "${CURL_OPTS[@]}" -A "$GOOGLEBOT_UA" "$ORIGIN$path" 2>/dev/null)"
  status="$(printf '%s\n' "$out" | sed -n '1p')"
  location="$(printf '%s\n' "$out" | sed -n '2p')"
  if [ "$status" != "200" ] || [ -n "$location" ]; then
    bot_failures="$bot_failures        ↳ $path -> status=$status location=$location
"
  fi
done
if [ -z "$bot_failures" ]; then
  PASS=$((PASS + 1))
  printf 'PASS  %-70s %s/%s\n' "INDEX-2: every sitemap URL -> 200 under Googlebot's UA" \
    "$sitemap_count" "$sitemap_count"
else
  FAIL=$((FAIL + 1))
  printf 'FAIL  %-70s\n' "INDEX-2: every sitemap URL -> 200 under Googlebot's UA"
  printf '%s' "$bot_failures"
fi

if [ -z "$canonical_mismatches" ]; then
  PASS=$((PASS + 1))
  printf 'PASS  %-70s %s/%s\n' "INDEX-3: every sitemap URL is self-canonical" \
    "$sitemap_count" "$sitemap_count"
else
  FAIL=$((FAIL + 1))
  printf 'FAIL  %-70s\n' "INDEX-3: every sitemap URL is self-canonical"
  printf '%s' "$canonical_mismatches"
fi

# hreflang / x-default targets. Same rule, different advertisement: the
# cluster is how Google is told where the other languages live, and
# x-default specifically is what it falls back to for an unmatched visitor.
# Pointing either at a redirecting URL is what produced "Alternate page with
# proper canonical tag" on all four English pages.
unique_alternates="$(printf '%s\n' "$ADVERTISED_ALTERNATES" | grep -E '^https?://' | sort -u)"
alternate_count="$(printf '%s' "$unique_alternates" | grep -c . || true)"
xdefault_count="$(printf '%s\n' "$XDEFAULT_HREFS" | grep -cE '^https?://' || true)"
alternate_failures=""
for url in $unique_alternates; do
  path="$(url_path "$url")"
  case "$SWEPT_OK" in
    *$'\n'"$path"$'\n'*) continue ;; # already proven 200 in INDEX-1
  esac
  out="$(curl "${CURL_OPTS[@]}" "$ORIGIN$path" 2>/dev/null)"
  status="$(printf '%s\n' "$out" | sed -n '1p')"
  location="$(printf '%s\n' "$out" | sed -n '2p')"
  if [ "$status" != "200" ] || [ -n "$location" ]; then
    alternate_failures="$alternate_failures        ↳ $path -> status=$status location=$location
"
  fi
done

if [ "$alternate_count" -ge "$MIN_SITEMAP_URLS" ] && [ "$xdefault_count" -ge 1 ] && [ -z "$alternate_failures" ]; then
  PASS=$((PASS + 1))
  printf 'PASS  %-70s %s targets, %s x-default\n' \
    "INDEX-4: every hreflang/x-default target -> 200, no redirect" "$alternate_count" "$xdefault_count"
else
  FAIL=$((FAIL + 1))
  printf 'FAIL  %-70s %s targets (want >= %s), %s x-default (want >= 1)\n' \
    "INDEX-4: every hreflang/x-default target -> 200, no redirect" \
    "$alternate_count" "$MIN_SITEMAP_URLS" "$xdefault_count"
  printf '%s' "$alternate_failures"
fi

# ── B9 (security-review round 1, HIGH-1): ReDoS hardening ─────────────────
# A pathological Accept-Language must not add meaningful latency relative
# to a normal request. Payload mirrors the exact shape that took 119-153 ms
# against the pre-fix regex (a long digit run in the q-value position that
# never resolves to a valid qvalue, forcing catastrophic backtracking in
# the old `/^q=([0-9]*\.?[0-9]+)$/` pattern) — fixed version should show no
# meaningful difference from baseline (typically < 2x, always << the 40x-
# 100x+ a vulnerable regex produces). This script has no way to inspect the
# origin's error log for the absence of an unhandled njs exception (the
# other half of B9) — verify that manually against a local dry-run
# container, see scripts/devops/locale-routing-runbook.md "ReDoS hardening
# verification".
pathological_q="$(head -c 7800 /dev/zero | tr '\0' '9')"
pathological_al="zz;q=${pathological_q}x"
baseline_time="$(curl -s -k -o /dev/null -w '%{time_total}' --max-time 10 -H 'Accept-Language: en' "$ORIGIN/" 2>/dev/null)"
payload_time="$(curl -s -k -o /dev/null -w '%{time_total}' --max-time 10 -H "Accept-Language: $pathological_al" "$ORIGIN/" 2>/dev/null)"
b9_verdict="$(awk -v b="$baseline_time" -v p="$payload_time" 'BEGIN {
  if (b <= 0) b = 0.001
  ratio = p / b
  # Absolute ceiling (500ms) as a network-latency-independent backstop,
  # PLUS a relative ceiling (10x baseline) — a genuine ReDoS regression
  # blows past both by 1-2 orders of magnitude; normal jitter does not.
  if (p < 0.5 && ratio < 10) print "PASS"; else print "FAIL"
}')"
if [ "$b9_verdict" = "PASS" ]; then
  PASS=$((PASS + 1))
  printf 'PASS  %-70s baseline=%ss payload=%ss\n' "B9: pathological Accept-Language (7.8KB) adds no meaningful latency" "$baseline_time" "$payload_time"
else
  FAIL=$((FAIL + 1))
  printf 'FAIL  %-70s baseline=%ss payload=%ss\n' "B9: pathological Accept-Language (7.8KB) adds no meaningful latency" "$baseline_time" "$payload_time"
fi

echo
echo "== $PASS passed, $FAIL failed =="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
