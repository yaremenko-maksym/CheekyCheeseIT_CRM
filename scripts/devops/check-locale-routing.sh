#!/bin/bash
# check-locale-routing.sh — curl proof suite for edge locale detection
# (task-infra-locale-edge, AC B1-B5).
#
# Runs a fixed set of curl cases against ANY origin (local nginx test
# container during development, staging, or production for a post-deploy
# smoke check) and reports PASS/FAIL per case. Exit code is non-zero if any
# case fails — safe to wire into CI or a manual pre/post-deploy check.
#
# Usage:
#   scripts/devops/check-locale-routing.sh [origin]
#   ORIGIN=https://cheekycheese.tech scripts/devops/check-locale-routing.sh
#
# Default origin: http://localhost:8080 (matches a local nginx container
# published on 8080; see scripts/devops/locale-routing-runbook.md for how to
# spin one up for a dry-run before every deploy that touches nginx/**).
#
# Detection order under test (plan-landing-i18n-seo.md §2):
#   cookie pref_locale > Accept-Language best-match > CF-IPCountry > en
# Supported locales: en (default, no prefix) | uk | ru | es | pt.
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
vary_redirect="$(curl -s -k -o /dev/null -D - --max-time 10 -H 'Accept-Language: ru' "$ORIGIN/" 2>/dev/null | grep -i '^Vary:')"
if [[ "$vary_redirect" == *"Accept-Language"* && "$vary_redirect" == *"Cookie"* ]]; then
  PASS=$((PASS + 1))
  printf 'PASS  %-70s %s\n' "B4: Vary header present on 302 response" "$vary_redirect"
else
  FAIL=$((FAIL + 1))
  printf 'FAIL  %-70s got=%s\n' "B4: Vary header present on 302 response" "$vary_redirect"
fi
vary_passthrough="$(curl -s -k -o /dev/null -D - --max-time 10 -H 'Accept-Language: en' "$ORIGIN/" 2>/dev/null | grep -i '^Vary:')"
if [[ "$vary_passthrough" == *"Accept-Language"* && "$vary_passthrough" == *"Cookie"* ]]; then
  PASS=$((PASS + 1))
  printf 'PASS  %-70s %s\n' "B4: Vary header present on 200 (EN passthrough)" "$vary_passthrough"
else
  FAIL=$((FAIL + 1))
  printf 'FAIL  %-70s got=%s\n' "B4: Vary header present on 200 (EN passthrough)" "$vary_passthrough"
fi

# ── B5: CF-IPCountry fallback (only consulted without Accept-Language) ────
check "B5: CF-IPCountry: UA (no Accept-Language) -> 302 /uk/" 302 "/uk/" \
  -H 'CF-IPCountry: UA'
check "B5: CF-IPCountry: RU (no Accept-Language) -> 302 /ru/" 302 "/ru/" \
  -H 'CF-IPCountry: RU'
check "B5: CF-IPCountry: BR (no Accept-Language) -> 302 /pt/" 302 "/pt/" \
  -H 'CF-IPCountry: BR'
check "B5: CF-IPCountry: MX (no Accept-Language) -> 302 /es/" 302 "/es/" \
  -H 'CF-IPCountry: MX'
check "B5: CF-IPCountry: DE unmapped (no Accept-Language) -> 200 EN" 200 "" \
  -H 'CF-IPCountry: DE'
check "B5: Accept-Language wins over CF-IPCountry when both present" 302 "/ru/" \
  -H 'CF-IPCountry: UA' -H 'Accept-Language: ru'

# ── Trailing-slash / deep-path preservation (plan §1) ──────────────────────
check_path "deep path: /careers/ + ru -> 302 /ru/careers/ (trailing slash kept)" "/careers/" 302 "/ru/careers/" \
  -H 'Accept-Language: ru'
check_path "deep path: /careers/my-slug/ + uk -> 302 /uk/careers/my-slug/" "/careers/my-slug/" 302 "/uk/careers/my-slug/" \
  -H 'Accept-Language: uk'

echo
echo "== $PASS passed, $FAIL failed =="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
