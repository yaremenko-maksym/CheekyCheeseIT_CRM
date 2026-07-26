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
# WIRED into deploy.yml's post-deploy smoke step (runs against the live VPS,
# same pattern as the existing landing-origin health check there) — see
# scripts/devops/csp-report-only-rollout-runbook.md for the full picture.
#
# Origin story (2026-07, prod regression, PR #429):
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
#      (per-domain `$csp_value`, keyed on `$server_name`) — cases in the
#      "Turnstile CSP regression guard" section below guard this specific
#      regression from coming back silently.
#   2. While verifying the fix (full before/after header table across every
#      nginx/conf.d/crm.conf location, same methodology as PR #423's
#      review), found crm.conf had the EXACT SAME "location defines its own
#      add_header, which drops server-level add_header inheritance
#      entirely" bug that #423 fixed for landing.conf — but crm.conf itself
#      was never given the same fix. `/`, `/index.html`, every JS/CSS/font/
#      image asset, `/sw.js`, `/registerSW.js`, and `/robots.txt` were ALL
#      shipping zero security headers (no HSTS, no CSP, no
#      X-Content-Type-Options, no X-Frame-Options, ...) on app.cheekycheese.
#      tech. Fixed alongside case 1 in the same PR — see the "crm.conf
#      add_header-inheritance regression guard" section below, which now
#      also covers the JS/CSS asset location and /registerSW.js (security
#      review round 1, MED-2 — the original version of this guard checked
#      HSTS on 4 locations but missed exactly the two that matter most: the
#      asset bundle and the service-worker registration script).
#   3. Security review round 1 (PR #429) caught a THIRD regression before it
#      ever reached prod: enabling CSP enforcement on CRM for the first time
#      (case 2 above) would have broken document/invoice/receipt preview —
#      prod serves those via presigned Cloudflare R2 URLs
#      (`https://<account_id>.r2.cloudflarestorage.com/...`), which is
#      cross-origin for app.cheekycheese.tech and was blocked by
#      connect-src/frame-src/object-src (HIGH-1), and blob: object-URL image
#      previews were blocked by img-src (MED-1). Fixed in csp-map.conf
#      (R2 wildcard + blob: in img-src) AND shipped as
#      `Content-Security-Policy-Report-Only` for CRM on this first rollout
#      (never blocks, only observes) rather than `Content-Security-Policy`
#      (enforcing) — see scripts/devops/csp-report-only-rollout-runbook.md.
#      `$CRM_CSP_HEADER` below MUST be updated in lockstep with csp-map.conf
#      when CRM flips to enforcing (the runbook's switch-over step says so).
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

# CRM's CSP currently ships as Report-Only (security review round 1, PR
# #429 HIGH-1/MED-1 — see the origin-story comment above). Update this to
# "Content-Security-Policy" the same day csp-map.conf's
# $csp_enforcing/$csp_report_only maps are flipped for app.cheekycheese.tech
# (scripts/devops/csp-report-only-rollout-runbook.md's switch-over step) —
# otherwise this guard silently stops checking the header that actually
# matters post-flip.
CRM_CSP_HEADER="Content-Security-Policy-Report-Only"
LANDING_CSP_HEADER="Content-Security-Policy"

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
# add_header-inheritance regression guard: the bug was the header vanishing
# entirely, not carrying a wrong value.
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

# Args: description, path, Host header value, header name — asserts the
# header is ABSENT entirely. Used for the report-only rollout guard: CRM
# must NOT (yet) send an enforcing Content-Security-Policy header — only
# Content-Security-Policy-Report-Only. Catches both an accidental premature
# flip to enforcing AND a regression back to sending neither.
check_header_absent() {
  local desc="$1" path="$2" host="$3" header_name="$4"
  local value
  value="$(curl -sS -k --max-time 10 -o /dev/null -D - -H "Host: $host" "$ORIGIN$path" 2>/dev/null \
    | grep -i "^${header_name}:" | head -1)"

  if [[ -z "$value" ]]; then
    PASS=$((PASS + 1))
    printf 'PASS  %-70s (absent, as expected)\n' "$desc"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-70s got=%s (want: header ABSENT)\n' "$desc" "$value"
  fi
}

echo "== check-security-headers.sh — origin: $ORIGIN =="
echo

# ── Turnstile CSP regression guard (landing) ───────────────────────────────
# All three are required: script-src (loads turnstile/v0/api.js),
# frame-src (the widget renders in an iframe on that origin), connect-src
# (the widget's own verification XHR). No unsafe-inline/wildcard used.
check_header_contains "Turnstile: landing CSP script-src allows challenges.cloudflare.com" \
  "/" "$LANDING_HOST" "$LANDING_CSP_HEADER" "script-src 'self' https://challenges.cloudflare.com"
check_header_contains "Turnstile: landing CSP connect-src allows challenges.cloudflare.com" \
  "/" "$LANDING_HOST" "$LANDING_CSP_HEADER" "connect-src 'self' https://challenges.cloudflare.com"
check_header_contains "Turnstile: landing CSP frame-src allows challenges.cloudflare.com" \
  "/" "$LANDING_HOST" "$LANDING_CSP_HEADER" "frame-src 'self' blob: https://challenges.cloudflare.com"

# ── Scope guard: CRM must NOT inherit the Turnstile allowance ─────────────
# Turnstile has no caller on app.cheekycheese.tech — widening its CSP would
# be an unnecessary loosening (see nginx/conf.d/csp-map.conf's rationale).
check_header_not_contains "Scope: CRM CSP does NOT contain challenges.cloudflare.com" \
  "/" "$CRM_HOST" "$CRM_CSP_HEADER" "challenges.cloudflare.com"

# ── Scope guard: landing must NOT inherit the R2/document allowance ───────
# Landing never serves documents/invoices/receipts — R2 has no caller there.
check_header_not_contains "Scope: landing CSP does NOT contain r2.cloudflarestorage.com" \
  "/" "$LANDING_HOST" "$LANDING_CSP_HEADER" "r2.cloudflarestorage.com"

# ── crm.conf add_header-inheritance regression guard ───────────────────────
# Each of these locations defines its own add_header (Cache-Control /
# Content-Type / X-Robots-Tag), which — per nginx's inheritance rule — drops
# ALL server-level add_header (HSTS/CSP/X-Frame-Options/...) unless
# security-headers.conf is explicitly re-included inside that exact
# location. Checks HSTS AND CSP explicitly (security review round 1, MED-2:
# the original version only checked HSTS as a representative header — CSP
# is the one that actually varies per-domain/per-mode, so its own loss on
# an asset location would otherwise pass silently).
#
# security review round 1, MED-2: the two most-important locations were
# MISSING from the original 4 — the JS/CSS asset bundle (the PR body itself
# called this "matters most", every page load hits it) and
# /registerSW.js (the service worker's own registration script, which per
# HIGH-1's finding #3 is now itself subject to connect-src via the worker it
# registers). `/__check-security-headers-fixture.js` is a fictitious path —
# it does not need to exist on disk: `add_header ... always;` sends the
# header set on EVERY response from a matching location, including a 404.
check_header_present "crm.conf: / (SPA fallback -> index.html) carries HSTS" \
  "/" "$CRM_HOST" "Strict-Transport-Security"
check_header_present "crm.conf: /index.html (explicit) carries HSTS" \
  "/index.html" "$CRM_HOST" "Strict-Transport-Security"
check_header_present "crm.conf: /robots.txt carries HSTS" \
  "/robots.txt" "$CRM_HOST" "Strict-Transport-Security"
check_header_present "crm.conf: /sw.js carries HSTS" \
  "/sw.js" "$CRM_HOST" "Strict-Transport-Security"
check_header_present "crm.conf: JS/CSS asset bundle carries HSTS (MED-2)" \
  "/__check-security-headers-fixture.js" "$CRM_HOST" "Strict-Transport-Security"
check_header_present "crm.conf: /registerSW.js carries HSTS (MED-2)" \
  "/registerSW.js" "$CRM_HOST" "Strict-Transport-Security"
check_header_present "crm.conf: JS/CSS asset bundle carries CSP (MED-2)" \
  "/__check-security-headers-fixture.js" "$CRM_HOST" "$CRM_CSP_HEADER"
check_header_present "crm.conf: /registerSW.js carries CSP (MED-2)" \
  "/registerSW.js" "$CRM_HOST" "$CRM_CSP_HEADER"

# ── CRM Google Fonts CDN — real, currently-used external domain ───────────
# apps/web/index.html loads Inter from fonts.googleapis.com (stylesheet)
# and fonts.gstatic.com (the actual .woff2 files) — landing does NOT need
# this (self-hosts its fonts, see apps/landing/index.html).
check_header_contains "CRM: CSP style-src allows fonts.googleapis.com" \
  "/" "$CRM_HOST" "$CRM_CSP_HEADER" "https://fonts.googleapis.com"
check_header_contains "CRM: CSP font-src allows fonts.gstatic.com" \
  "/" "$CRM_HOST" "$CRM_CSP_HEADER" "https://fonts.gstatic.com"

# ── HIGH-1 (security review round 1): CRM must allow Cloudflare R2 ────────
# Documents/invoices/receipts are fetched/framed/embedded from presigned R2
# URLs (cross-origin) via fetch (connect-src), <iframe> (frame-src), and
# <object> (object-src) — see apps/web/app/hooks/use-document-blob.ts,
# apps/web/app/components/invoices/invoice-detail-dialog.tsx,
# apps/web/.../finance/components/dialogs/receipt-panel.tsx. Verified live
# in a real Chromium instance (PR #429 body) that the pre-fix policy
# genuinely blocked all three and the fixed policy genuinely does not.
check_header_contains "HIGH-1: CRM CSP connect-src allows R2 (*.r2.cloudflarestorage.com)" \
  "/" "$CRM_HOST" "$CRM_CSP_HEADER" "connect-src 'self' https://*.r2.cloudflarestorage.com"
check_header_contains "HIGH-1: CRM CSP frame-src allows R2 (*.r2.cloudflarestorage.com)" \
  "/" "$CRM_HOST" "$CRM_CSP_HEADER" "frame-src 'self' blob: https://*.r2.cloudflarestorage.com"
check_header_contains "HIGH-1: CRM CSP object-src allows R2 (*.r2.cloudflarestorage.com)" \
  "/" "$CRM_HOST" "$CRM_CSP_HEADER" "object-src 'self' blob: https://*.r2.cloudflarestorage.com"

# ── MED-1 (security review round 1): CRM img-src must allow blob: ─────────
# ReceiptInput.tsx renders URL.createObjectURL(file) into <img src="blob:">
# during upload, before the file has an R2 URL at all.
check_header_contains "MED-1: CRM CSP img-src allows blob:" \
  "/" "$CRM_HOST" "$CRM_CSP_HEADER" "img-src 'self' data: blob: https:"

# ── Report-Only rollout guard (security review round 1, HIGH-1) ───────────
# CRM has never served ANY CSP before PR #429 (crm.conf's add_header-
# inheritance bug dropped it entirely) — its first rollout ships as
# Report-Only, not enforcing, so a still-unknown gap cannot break a real
# request. This guard fails loudly the moment either (a) CRM starts sending
# an enforcing Content-Security-Policy header before the runbook's
# switch-over procedure has run (premature/accidental flip), or (b) it
# regresses back to sending neither header at all.
check_header_absent "Report-Only rollout: CRM does NOT (yet) send enforcing Content-Security-Policy" \
  "/" "$CRM_HOST" "Content-Security-Policy"
check_header_present "Report-Only rollout: CRM DOES send Content-Security-Policy-Report-Only" \
  "/" "$CRM_HOST" "Content-Security-Policy-Report-Only"

# ── Baseline: landing still gets its own full header set (no regression) ──
check_header_present "landing: / carries HSTS" \
  "/" "$LANDING_HOST" "Strict-Transport-Security"

echo
echo "== $PASS passed, $FAIL failed =="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
