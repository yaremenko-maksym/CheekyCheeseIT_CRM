#!/bin/bash
# check-nginx-perimeter.sh — curl proof suite for the nginx-edge perimeter:
# request body limits (MED-1) + origin-exposure hardening (MED-5).
#
# Companion to scripts/devops/check-security-headers.sh /
# check-locale-routing.sh (same harness style: PASS/FAIL counters, safe to
# run repeatedly against ANY origin — local Docker dry-run OR production —
# non-zero exit on any failure).
#
# Origin story (security audit 2026-07-27):
#
#   MED-1: `grep -rn client_max_body_size nginx/` returned ZERO matches —
#   every `location /api/` ran on nginx's built-in 1 MB default, far below
#   what the API itself accepts (DOCUMENT_MAX_BYTES = 10 MB, main.ts;
#   RESUME_MAX_BYTES = 5 MB, applications.service.ts). A candidate
#   attaching an ordinary 2 MB PDF resume got nginx's own HTML 413 page —
#   the SPA then tried to JSON.parse() HTML and broke silently, no trace
#   in API logs/telemetry (the request never reached the API at all).
#   Fixed with an explicit `client_max_body_size` in every `location /api/`
#   (nginx/conf.d/crm.conf, nginx/conf.d/landing.conf — both :80 and :443):
#   12m for CRM (DOCUMENT_MAX_BYTES + ~2 MB margin) / 7m for landing
#   (RESUME_MAX_BYTES + ~2 MB margin) — the margin means a request that's
#   over the API's OWN limit by a modest amount still reaches the API and
#   gets ITS clean `PayloadTooLargeException` JSON (413) instead of
#   nginx's generic HTML page; nginx remains the backstop against
#   genuinely oversized/abusive bodies.
#
#   MED-5: neither port 80 nor 443 had an explicit `default_server`, and
#   no `allow`/`deny` gate existed anywhere — the origin's real IP (DNS
#   history, Certificate Transparency logs) let anyone curl it directly,
#   bypassing Cloudflare's WAF/bot-management entirely. Fixed with
#   nginx/conf.d/default-server.conf (`return 444;` catch-all for any Host
#   that matches neither real vhost) + nginx/conf.d/origin-access.conf
#   (Cloudflare-only `allow`/`deny` gate, reusing the SAME CIDR list
#   already used for `set_real_ip_from`, + explicit `allow` for
#   loopback/Docker-bridge ranges so our OWN health checks / deploy.yml
#   smoke tests keep working). See origin-access.conf's header comment for
#   what remains OWNER-side (host firewall, Cloudflare Authenticated
#   Origin Pulls) — this script cannot verify either of those.
#
# ── What this script CAN safely verify against ANY origin (local OR prod) ──
#   1. Body-size checks (`--target /api/health`, below): a real,
#      always-public, unauthenticated GET-only endpoint
#      (apps/api/src/health/health.controller.ts) — POSTing an oversized
#      body to it never touches the DB/S3/business logic (Nest 404s on the
#      method mismatch, or — against a local stub — 200s), it only
#      exercises nginx's `client_max_body_size` boundary. Safe to run
#      against production repeatedly.
#   2. default_server catch-all (`return 444;` on an unrecognised Host) —
#      also safe anywhere, does not depend on source IP.
#
# ── What this script CANNOT verify (documented, not scripted) ──────────────
#   The Cloudflare-only `allow`/`deny` gate (origin-access.conf) cannot be
#   meaningfully tested from THIS harness: run locally, curl's source IP is
#   loopback/Docker-bridge — explicitly ALLOWED (that's required so this
#   very script, and deploy.yml's own post-deploy smoke tests, keep
#   working); run from a GitHub Actions runner or the VPS itself, same
#   problem. A genuine "does it deny a real non-Cloudflare source" proof
#   requires curling the origin's real IP from a vantage point OUTSIDE
#   Cloudflare/this host — verified manually instead (methodology below),
#   not automated here.
#
#   Manual verification methodology used for the PR that introduced this
#   file (repeatable any time origin-access.conf changes):
#     1. Build the real image: `docker build -f nginx/Dockerfile -t
#        crm-nginx-test --build-arg VITE_API_URL=/api .`
#     2. Run it normally (real origin-access.conf) — confirm a direct curl
#        gets a normal 200 (proves `allow` matches SOMETHING — in the
#        author's environment this happened to be a genuine Cloudflare
#        edge IP via a WARP-routed connection, visible in
#        `docker logs <container>`'s access log).
#     3. Re-run with a bind-mounted override of origin-access.conf
#        containing ONLY `deny all;` (no allow lines) at a different
#        published port — confirm the SAME curl now gets 403. This proves
#        the `include`, the server-level placement (covers every
#        location), and `deny all` itself are all correctly wired,
#        independent of which specific IP ranges are listed (nginx's own
#        access module is mature/well-tested — what needed proving was
#        THIS config's wiring, not the module itself).
#
# Usage:
#   scripts/devops/check-nginx-perimeter.sh [origin]
#   ORIGIN=https://cheekycheese.tech scripts/devops/check-nginx-perimeter.sh
#
# Default origin: http://localhost:8080 (matches check-locale-routing.sh /
# check-security-headers.sh's local dry-run convention).
set -u

ORIGIN="${1:-${ORIGIN:-http://localhost:8080}}"
LANDING_HOST="cheekycheese.tech"
CRM_HOST="app.cheekycheese.tech"

PASS=0
FAIL=0

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# dd a zero-filled payload of the given size (MB) once, reused across checks.
payload() {
  local mb="$1"
  local path="$WORKDIR/${mb}mb.bin"
  if [ ! -f "$path" ]; then
    dd if=/dev/zero of="$path" bs=1048576 count="$mb" >/dev/null 2>&1
  fi
  printf '%s' "$path"
}

# nginx's stock error page for client_max_body_size rejections — exact
# title string, safe to grep for without false-positiving on real API JSON.
NGINX_413_SIGNATURE='413 Request Entity Too Large'

# Args: description, host, size-in-MB. Asserts the response is NOT nginx's
# own HTML 413 page — i.e. the body reached the upstream (whatever status
# the upstream itself returned: 200 from a local stub, 404 "Cannot POST"
# from the real Nest app, a real 413 JSON from the real app's own size
# check — anything EXCEPT nginx's blunt HTML page counts as a pass here).
check_passes_nginx() {
  local desc="$1" host="$2" mb="$3"
  local body
  body="$(curl -sS -k --max-time 20 -H "Host: $host" --data-binary @"$(payload "$mb")" \
    "$ORIGIN/api/health" 2>/dev/null)"

  if [[ "$body" != *"$NGINX_413_SIGNATURE"* ]]; then
    PASS=$((PASS + 1))
    printf 'PASS  %-70s upstream responded (not nginx HTML): %.80s\n' "$desc" "$body"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-70s got nginx'"'"'s own HTML 413 — client_max_body_size too low\n' "$desc"
  fi
}

# Args: description, host, size-in-MB. Asserts the response IS nginx's own
# HTML 413 — i.e. this body is big enough that nginx's cap (the backstop
# against genuinely oversized/abusive bodies) should reject it outright,
# never reaching the upstream at all.
check_blocked_by_nginx() {
  local desc="$1" host="$2" mb="$3"
  local body
  body="$(curl -sS -k --max-time 20 -H "Host: $host" --data-binary @"$(payload "$mb")" \
    "$ORIGIN/api/health" 2>/dev/null)"

  if [[ "$body" == *"$NGINX_413_SIGNATURE"* ]]; then
    PASS=$((PASS + 1))
    printf 'PASS  %-70s nginx backstop fired, as expected\n' "$desc"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-70s expected nginx'"'"'s HTML 413 backstop, got: %.80s\n' "$desc" "$body"
  fi
}

# Args: description, Host header (empty string = do NOT override — curl
# then sends whatever Host the ORIGIN url itself implies, e.g. "localhost",
# mirroring wget's behaviour with no --header flag). Asserts the connection
# is closed with NO response at all (nginx `return 444;`) —
# default-server.conf's catch-all for a Host matching neither real vhost.
# curl reports this as exit 52 ("empty reply from server") / HTTP code 000,
# never a real status line.
check_connection_closed() {
  local desc="$1" host="$2"
  local code
  # No arrays here (macOS's default /bin/bash is 3.2 — `"${arr[@]}"` on an
  # EMPTY array under `set -u` throws "unbound variable" on that version,
  # even with the `-a` declaration; two explicit curl invocations sidesteps
  # it entirely rather than reaching for the `${arr[@]+"${arr[@]}"}` idiom).
  if [[ -n "$host" ]]; then
    code="$(curl -sS -k --max-time 10 -o /dev/null -w '%{http_code}' -H "Host: $host" "$ORIGIN/" 2>/dev/null)"
  else
    code="$(curl -sS -k --max-time 10 -o /dev/null -w '%{http_code}' "$ORIGIN/" 2>/dev/null)"
  fi

  if [[ "$code" == "000" ]]; then
    PASS=$((PASS + 1))
    printf 'PASS  %-70s connection closed (444), no response\n' "$desc"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-70s got HTTP %s (expected connection close / no response)\n' "$desc" "$code"
  fi
}

echo "== check-nginx-perimeter.sh — origin: $ORIGIN =="
echo

# ── MED-1: CRM (app.cheekycheese.tech) — DOCUMENT_MAX_BYTES = 10 MB, ──────
# ── nginx client_max_body_size = 12m ───────────────────────────────────────
check_passes_nginx "CRM: 2 MB body reaches the API (was nginx HTML 413 pre-fix)" "$CRM_HOST" 2
check_passes_nginx "CRM: 11 MB body reaches the API (over app limit, under nginx cap)" "$CRM_HOST" 11
check_blocked_by_nginx "CRM: 13 MB body hits nginx's own cap (backstop)" "$CRM_HOST" 13

# ── MED-1: Landing (cheekycheese.tech) — RESUME_MAX_BYTES = 5 MB, ─────────
# ── nginx client_max_body_size = 7m ────────────────────────────────────────
check_passes_nginx "Landing: 2 MB body reaches the API (was nginx HTML 413 pre-fix)" "$LANDING_HOST" 2
check_passes_nginx "Landing: 6 MB body reaches the API (over app limit, under nginx cap)" "$LANDING_HOST" 6
check_blocked_by_nginx "Landing: 8 MB body hits nginx's own cap (backstop)" "$LANDING_HOST" 8

# ── MED-5: default_server catch-all ────────────────────────────────────────
check_connection_closed "default_server: unrecognised Host gets 444 (CRM path)" "not-a-real-host.invalid"
check_connection_closed "default_server: no Host override (curl default) gets 444" ""

echo
echo "== $PASS passed, $FAIL failed =="
echo
echo "NOTE: the Cloudflare-only allow/deny gate (origin-access.conf) is NOT"
echo "covered above — see this script's header comment for why and how it"
echo "was verified manually instead."
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
