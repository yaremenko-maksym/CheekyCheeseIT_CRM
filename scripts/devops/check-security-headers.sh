#!/bin/bash
# check-security-headers.sh — curl proof suite for nginx security headers
# (HSTS / CSP / X-Frame-Options / etc.), per-domain.
#
# Companion to scripts/devops/check-locale-routing.sh (same harness style,
# same "local dry-run container OR prod smoke check" usage — see that
# script's header + scripts/devops/locale-routing-runbook.md §6 for how to
# spin up a local nginx:1.27-alpine dry-run container against
# nginx/conf.d/**). Kept SEPARATE from check-locale-routing.sh on purpose:
# that script is scoped to locale-redirect routing (task-infra-locale-edge);
# this one is scoped to the security-headers.conf / csp-map.conf layer,
# which is an orthogonal nginx concern (headers on already-resolved
# responses, not which URL gets served).
#
# Origin story (2026-07, prod regression, task fix/csp-allow-turnstile):
#
#   1. `https://challenges.cloudflare.com` (Cloudflare Turnstile — script +
#      widget iframe + verification XHR, see
#      apps/landing/app/lib/use-turnstile.ts) was missing from EVERY CSP
#      directive that matters for it on the landing domain, silently
#      breaking the vacancy-apply form's spam-check widget (and therefore
#      the form itself — the API rejects submissions with no valid
#      Turnstile token). Was dormant pre-PR #423 (a DIFFERENT nginx bug was
#      dropping the CSP header entirely on HTML responses, so there was
#      nothing to violate); #423 fixed the header-drop bug, which turned
#      REAL enforcement on for the first time and exposed this
#      always-incomplete CSP value. Fixed by nginx/conf.d/csp-map.conf
#      (per-domain `$csp_value`, keyed on `$server_name`) — cases 1-3 below
#      guard this specific regression from coming back silently.
#   2. While verifying the fix (full before/after header table across every
#      nginx/conf.d/crm.conf location, same methodology as PR #423's
#      review), found crm.conf had the EXACT SAME "location defines its own
#      add_header, which drops server-level add_header inheritance
#      entirely" bug that #423 fixed for landing.conf — but crm.conf itself
#      was never given the same fix. `/`, `/index.html`, every JS/CSS/font/
#      image asset, `/sw.js`, `/registerSW.js`, and `/robots.txt` were ALL
#      shipping zero security headers (no HSTS, no CSP, no
#      X-Content-Type-Options, no X-Frame-Options, ...) on app.cheekycheese.
#      tech. Fixed alongside case 1 in the same PR. Cases 4-7 below guard
#      this regression from coming back silently.
#
# Usage:
#   scripts/devops/check-security-headers.sh [origin]
#   ORIGIN=https://cheekycheese.tech scripts/devops/check-security-headers.sh
#
# Default origin: http://localhost:8080 (matches check-locale-routing.sh's
# local dry-run convention — a single nginx container serving BOTH vhosts,
# selected via the Host header below, same as deploy.yml's own smoke check).
#
# Safe to run repeatedly against production (read-only GET requests, no
# state mutated).
set -u

ORIGIN="${1:-${ORIGIN:-http://localhost:8080}}"
LANDING_HOST="cheekycheese.tech"
CRM_HOST="app.cheekycheese.tech"

PASS=0
FAIL=0

# Args: description, path, Host header value, header name (case-insensitive,
# no trailing colon), substring that MUST be present in that header's value.
check_header_contains() {
  local desc="$1" path="$2" host="$3" header_name="$4" needle="$5"
  local value
  value="$(curl -sS -k --max-time 10 -o /dev/null -D - -H "Host: $host" "$ORIGIN$path" 2>/dev/null \
    | grep -i "^${header_name}:" | head -1)"

  if [[ "$value" == *"$needle"* ]]; then
    PASS=$((PASS + 1))
    printf 'PASS  %-70s %s\n' "$desc" "$value"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-70s got=%s (want substring: %s)\n' "$desc" "$value" "$needle"
  fi
}

# Same as check_header_contains but asserts the substring is ABSENT — used
# for "did NOT get widened where it shouldn't have been" guards (e.g. CRM
# must never get the Turnstile origin — Turnstile has no caller there).
check_header_not_contains() {
  local desc="$1" path="$2" host="$3" header_name="$4" needle="$5"
  local value
  value="$(curl -sS -k --max-time 10 -o /dev/null -D - -H "Host: $host" "$ORIGIN$path" 2>/dev/null \
    | grep -i "^${header_name}:" | head -1)"

  if [[ -n "$value" && "$value" != *"$needle"* ]]; then
    PASS=$((PASS + 1))
    printf 'PASS  %-70s %s\n' "$desc" "$value"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-70s got=%s (want ABSENT: %s)\n' "$desc" "$value" "$needle"
  fi
}

# Args: description, path, Host header value, header name — asserts the
# header is PRESENT at all (any non-empty value). Used for the crm.conf
# add_header-inheritance regression guard (cases 4-7): the bug was the
# header vanishing entirely, not carrying a wrong value.
check_header_present() {
  local desc="$1" path="$2" host="$3" header_name="$4"
  local value
  value="$(curl -sS -k --max-time 10 -o /dev/null -D - -H "Host: $host" "$ORIGIN$path" 2>/dev/null \
    | grep -i "^${header_name}:" | head -1)"

  if [[ -n "$value" ]]; then
    PASS=$((PASS + 1))
    printf 'PASS  %-70s %s\n' "$desc" "$value"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-70s header missing entirely\n' "$desc"
  fi
}

echo "== check-security-headers.sh — origin: $ORIGIN =="
echo

# ── Turnstile CSP regression guard (landing) ───────────────────────────────
# All three are required: script-src (loads turnstile/v0/api.js),
# frame-src (the widget renders in an iframe on that origin), connect-src
# (the widget's own verification XHR). No unsafe-inline/wildcard used.
check_header_contains "Turnstile: landing CSP script-src allows challenges.cloudflare.com" \
  "/" "$LANDING_HOST" "Content-Security-Policy" "script-src 'self' https://challenges.cloudflare.com"
check_header_contains "Turnstile: landing CSP connect-src allows challenges.cloudflare.com" \
  "/" "$LANDING_HOST" "Content-Security-Policy" "connect-src 'self' https://challenges.cloudflare.com"
check_header_contains "Turnstile: landing CSP frame-src allows challenges.cloudflare.com" \
  "/" "$LANDING_HOST" "Content-Security-Policy" "frame-src 'self' blob: https://challenges.cloudflare.com"

# ── Scope guard: CRM must NOT inherit the Turnstile allowance ─────────────
# Turnstile has no caller on app.cheekycheese.tech — widening its CSP would
# be an unnecessary loosening (see nginx/conf.d/csp-map.conf's rationale).
check_header_not_contains "Scope: CRM CSP does NOT contain challenges.cloudflare.com" \
  "/" "$CRM_HOST" "Content-Security-Policy" "challenges.cloudflare.com"

# ── crm.conf add_header-inheritance regression guard ───────────────────────
# Each of these locations defines its own add_header (Cache-Control /
# Content-Type / X-Robots-Tag), which — per nginx's inheritance rule — drops
# ALL server-level add_header (HSTS/CSP/X-Frame-Options/...) unless
# security-headers.conf is explicitly re-included inside that exact
# location. Checks HSTS as the representative header (any one of the six
# security-headers.conf headers proves the include is present/working).
check_header_present "crm.conf: / (SPA fallback -> index.html) carries HSTS" \
  "/" "$CRM_HOST" "Strict-Transport-Security"
check_header_present "crm.conf: /index.html (explicit) carries HSTS" \
  "/index.html" "$CRM_HOST" "Strict-Transport-Security"
check_header_present "crm.conf: /robots.txt carries HSTS" \
  "/robots.txt" "$CRM_HOST" "Strict-Transport-Security"
check_header_present "crm.conf: /sw.js carries HSTS" \
  "/sw.js" "$CRM_HOST" "Strict-Transport-Security"

# ── CRM Google Fonts CDN — real, currently-used external domain ───────────
# apps/web/index.html loads Inter from fonts.googleapis.com (stylesheet)
# and fonts.gstatic.com (the actual .woff2 files) — landing does NOT need
# this (self-hosts its fonts, see apps/landing/index.html).
check_header_contains "CRM: CSP style-src allows fonts.googleapis.com" \
  "/" "$CRM_HOST" "Content-Security-Policy" "https://fonts.googleapis.com"
check_header_contains "CRM: CSP font-src allows fonts.gstatic.com" \
  "/" "$CRM_HOST" "Content-Security-Policy" "https://fonts.gstatic.com"

# ── Baseline: landing still gets its own full header set (no regression) ──
check_header_present "landing: / carries HSTS" \
  "/" "$LANDING_HOST" "Strict-Transport-Security"

echo
echo "== $PASS passed, $FAIL failed =="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
