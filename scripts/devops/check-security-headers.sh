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
#      `$CRM_CSP_HEADER` below is now DERIVED from `CRM_CSP_MODE` (see
#      below) instead of being an independently-hardcoded constant —
#      security review round 2 (LOW fix, task-csp-reports-and-flip Part B)
#      flagged the old two-constants-in-two-files setup as a footgun: this
#      script and nginx/conf.d/csp-map.conf could silently disagree about
#      CRM's actual mode if only one of the two was updated on a flip.
#
# Tests: scripts/devops/tests/test-check-security-headers.sh — positive AND
# negative cases against a controllable stub origin (tests/lib/fake-origin.py),
# including a CSP header that is present and wide open (`default-src *`), the
# PR #429 regressions (landing losing Turnstile, CRM asset locations losing every
# header), and a fixture/guard disagreement about CRM_CSP_MODE. Those cases prove
# THIS SCRIPT's logic; that nginx itself is configured correctly is proven by
# deploy.yml's FATAL post-deploy smoke step, which runs this script against the
# real VPS.
#
# Usage:
#   scripts/devops/check-security-headers.sh [origin]
#   ORIGIN=https://cheekycheese.tech scripts/devops/check-security-headers.sh
#   CRM_CSP_MODE=enforcing scripts/devops/check-security-headers.sh
#
# Default origin: http://localhost:8080 (matches check-locale-routing.sh's
# local dry-run convention — a single nginx container serving BOTH vhosts,
# selected via the Host header below, same as deploy.yml's own smoke check).
#
# KNOWN LIMITATION (security review round 2, LOW-1, enforcing-flip
# task-csp-reports-and-flip): even against production, `curl` here hits
# ORIGIN directly — 127.0.0.1 in the local dry-run, and in deploy.yml's
# post-deploy smoke step it hits the VPS's own nginx too, i.e. BEFORE the
# Cloudflare proxy layer. This suite proves nginx itself emits the right
# headers; it has no visibility into anything Cloudflare's edge injects
# into the response AFTER nginx (e.g. the `<script data-cf-beacon>` Web
# Analytics tag — see nginx/conf.d/csp-map.conf's
# static.cloudflareinsights.com comment). A "32 passed" run here means
# "the nginx config is correct", NOT "the HTML a real browser receives via
# Cloudflare has been checked for CF-injected content". If Cloudflare ever
# changes/adds an edge-injected script, this suite stays green while a
# real CSP-enforcing prod could start blocking it — the only way to catch
# that is the csp_reports digest (see
# scripts/devops/csp-report-only-rollout-runbook.md §2/§6), not this
# script. Direction of failure is safe (fails closed, not open) but this
# is not a guarantee this suite alone can make.
#
# Safe to run repeatedly against production (read-only GET requests, no
# state mutated).
set -u

ORIGIN="${1:-${ORIGIN:-http://localhost:8080}}"
LANDING_HOST="cheekycheese.tech"
CRM_HOST="app.cheekycheese.tech"

# task-csp-reports-and-flip (Part B, security review round 2 LOW fix):
# CRM_CSP_MODE is now the ONE source of truth for CRM's CSP delivery mode —
# same env var name deploy.yml passes as a Docker build-arg to
# nginx/Dockerfile (see that file's ARG CRM_CSP_MODE comment) AND passes to
# THIS script's invocation in the post-deploy smoke-test step, so both sides
# read from the exact same workflow-level value and cannot drift apart.
# Default "report-only" matches nginx/Dockerfile's own ARG default, so a
# bare local run (no CRM_CSP_MODE set) still checks the right header.
CRM_CSP_MODE="${CRM_CSP_MODE:-report-only}"
# $CRM_CSP_OTHER_HEADER is the header CRM must NOT be sending — used by the
# "Report-Only rollout guard" checks below so they stay correct across a
# CRM_CSP_MODE flip too, not just $CRM_CSP_HEADER (same footgun class this
# whole consolidation exists to close — see the origin-story comment above).
case "$CRM_CSP_MODE" in
  report-only)
    CRM_CSP_HEADER="Content-Security-Policy-Report-Only"
    CRM_CSP_OTHER_HEADER="Content-Security-Policy"
    ;;
  enforcing)
    CRM_CSP_HEADER="Content-Security-Policy"
    CRM_CSP_OTHER_HEADER="Content-Security-Policy-Report-Only"
    ;;
  *)
    echo "ERROR: CRM_CSP_MODE must be exactly 'report-only' or 'enforcing', got: '$CRM_CSP_MODE'." >&2
    exit 1
    ;;
esac
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

# task-csp-reports-and-flip (Part B, security review round 2 LOW fix):
# asserts a substring is ABSENT within ONE named CSP directive's own value
# (up to its terminating `;`), not the whole header. Checking the WHOLE
# header for e.g. "unsafe-inline" would false-positive on CRM/landing's
# style-src, which legitimately carries 'unsafe-inline' (Tailwind/shadcn
# runtime style injection — unrelated to script execution risk) — this
# scopes the assertion to exactly the directive that matters.
# Args: description, path, Host header value, header name, CSP directive
# name (e.g. "script-src"), substring that must be ABSENT within it.
check_directive_not_contains() {
  local desc="$1" path="$2" host="$3" header_name="$4" directive="$5" needle="$6"
  local header_value directive_value
  header_value="$(curl -sS -k --max-time 10 -o /dev/null -D - -H "Host: $host" "$ORIGIN$path" 2>/dev/null \
    | grep -i "^${header_name}:" | head -1)"
  # Isolate "<directive> <value-up-to-semicolon>" — CSP directive names are
  # case-sensitive per spec and this repo always writes them lowercase.
  directive_value="$(printf '%s' "$header_value" | grep -oE "${directive} [^;]*" | head -1)"

  if [[ -z "$directive_value" ]]; then
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-70s directive "%s" not found in header\n' "$desc" "$directive"
  elif [[ "$directive_value" != *"$needle"* ]]; then
    PASS=$((PASS + 1))
    printf 'PASS  %-70s %s\n' "$desc" "$directive_value"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-70s got=%s (want ABSENT within %s: %s)\n' "$desc" "$directive_value" "$directive" "$needle"
  fi
}

# task-infra-webmanifest-mime: asserts the exact HTTP status code — none of
# the header-focused helpers above check this, and the landing regression
# guard below (SPA fallback silently returning 200 instead of a real 404)
# needs it. Args: description, path, Host header value, expected status code.
check_status_code() {
  local desc="$1" path="$2" host="$3" want="$4"
  local got
  got="$(curl -sS -k --max-time 10 -o /dev/null -w '%{http_code}' -H "Host: $host" "$ORIGIN$path" 2>/dev/null)"

  if [[ "$got" == "$want" ]]; then
    PASS=$((PASS + 1))
    printf 'PASS  %-70s %s\n' "$desc" "$got"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-70s got=%s (want: %s)\n' "$desc" "$got" "$want"
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

# ── Report-Only rollout guard (security review round 1, HIGH-1; ───────────
# ── made CRM_CSP_MODE-aware in task-csp-reports-and-flip Part B) ──────────
# CRM has never served ANY CSP before PR #429 (crm.conf's add_header-
# inheritance bug dropped it entirely) — its first rollout ships as
# Report-Only, not enforcing, so a still-unknown gap cannot break a real
# request. This guard fails loudly the moment nginx and CRM_CSP_MODE
# disagree about which header CRM is actually sending — BEFORE this fix it
# hardcoded "report-only is the only valid state", which would have made
# the guard itself wrong the moment CRM_CSP_MODE flips to enforcing
# (exactly the class of drift task-csp-reports-and-flip Part B closes).
check_header_absent "Report-Only rollout: CRM does NOT send $CRM_CSP_OTHER_HEADER" \
  "/" "$CRM_HOST" "$CRM_CSP_OTHER_HEADER"
check_header_present "Report-Only rollout: CRM DOES send $CRM_CSP_HEADER" \
  "/" "$CRM_HOST" "$CRM_CSP_HEADER"

# ── task-csp-reports-and-flip (Part B, security review round 2 LOW fixes) ──
# Negative assertions on CSP CONTENT itself — catch a future edit widening
# either domain's policy into something CSP exists to prevent, not just a
# header-presence/scope regression (everything above this section). Applies
# to BOTH domains: neither should ever need unsafe-eval/unsafe-inline in
# script-src (this codebase ships no inline scripts/eval — Vite/React build
# output is all external, hashed bundle files) or a wildcard default-src.
check_directive_not_contains "Hardening: landing CSP script-src has no unsafe-eval" \
  "/" "$LANDING_HOST" "$LANDING_CSP_HEADER" "script-src" "unsafe-eval"
check_directive_not_contains "Hardening: landing CSP script-src has no unsafe-inline" \
  "/" "$LANDING_HOST" "$LANDING_CSP_HEADER" "script-src" "unsafe-inline"
check_directive_not_contains "Hardening: CRM CSP script-src has no unsafe-eval" \
  "/" "$CRM_HOST" "$CRM_CSP_HEADER" "script-src" "unsafe-eval"
check_directive_not_contains "Hardening: CRM CSP script-src has no unsafe-inline" \
  "/" "$CRM_HOST" "$CRM_CSP_HEADER" "script-src" "unsafe-inline"
check_header_not_contains "Hardening: landing CSP has no wildcard default-src" \
  "/" "$LANDING_HOST" "$LANDING_CSP_HEADER" "default-src *"
check_header_not_contains "Hardening: CRM CSP has no wildcard default-src" \
  "/" "$CRM_HOST" "$CRM_CSP_HEADER" "default-src *"

# ── task-csp-reports-and-flip (Part B): CRM must carry report directives ──
# CRM-only (landing has no collector wired — see csp-map.conf's rationale).
# Both directives are part of $csp_value (nginx/conf.d/csp-map.conf), so
# they are present regardless of CRM_CSP_MODE — report-uri/report-to work
# identically whether the policy ships as Content-Security-Policy or
# -Report-Only (only enforcement differs, not reporting).
check_header_contains "CRM CSP carries report-uri (POST /api/public/csp-report)" \
  "/" "$CRM_HOST" "$CRM_CSP_HEADER" "report-uri /api/public/csp-report"
check_header_contains "CRM CSP carries report-to (csp-endpoint)" \
  "/" "$CRM_HOST" "$CRM_CSP_HEADER" "report-to csp-endpoint"
check_header_contains "CRM sends Reporting-Endpoints (csp-endpoint -> /api/public/csp-report)" \
  "/" "$CRM_HOST" "Reporting-Endpoints" "csp-endpoint=\"https://app.cheekycheese.tech/api/public/csp-report\""
check_header_absent "Scope: landing does NOT send Reporting-Endpoints" \
  "/" "$LANDING_HOST" "Reporting-Endpoints"

# ── Baseline: landing still gets its own full header set (no regression) ──
check_header_present "landing: / carries HSTS" \
  "/" "$LANDING_HOST" "Strict-Transport-Security"

# ── task-infra-webmanifest-mime: Web App Manifest regression guard ────────
# Two independent defects, found live (curl -I against production):
#   1. CRM served /site.webmanifest as `application/octet-stream` (nginx's
#      stock mime.types has no `.webmanifest` entry, see the `types {}`
#      block added to nginx/nginx.conf in this PR) instead of the spec-
#      required `application/manifest+json` — browsers may silently reject
#      a manifest served with the wrong Content-Type, which is what supplies
#      the mobile tab/PWA icon and "Add to Home Screen" name.
#   2. Landing has no manifest at all (no `<link rel="manifest">`, no
#      `site.webmanifest` file in apps/landing/public/) — a request for
#      /site.webmanifest fell through the SPA fallback and got served the
#      prerendered HOME PAGE: 200 OK, full HTML, under a path a client
#      asked for as JSON. Fixed with an explicit
#      `location = /site.webmanifest { return 404; }` in landing.conf (an
#      honest 404 beats a fake 200) — see that file's own comment for why a
#      real manifest was deliberately NOT added there instead.
check_header_contains "CRM: /site.webmanifest is served as application/manifest+json" \
  "/site.webmanifest" "$CRM_HOST" "Content-Type" "application/manifest+json"
check_status_code "Landing: /site.webmanifest is an honest 404 (not the SPA-fallback 200)" \
  "/site.webmanifest" "$LANDING_HOST" "404"

echo
echo "== $PASS passed, $FAIL failed =="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
