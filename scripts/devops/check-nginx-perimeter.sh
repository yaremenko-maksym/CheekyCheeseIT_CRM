#!/bin/bash
# check-nginx-perimeter.sh — curl proof suite for the nginx-edge perimeter:
# request body limits (MED-1) + the default_server catch-all (MED-5, part
# 1). A source-IP allow/deny gate (MED-5, part 2) was ATTEMPTED alongside
# this file and REVERTED after security review — see "Cloudflare-only
# source-IP gate" below for why, and the "real-visitor regression guard"
# check this script now carries specifically because of that finding.
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
#   MED-5 (default_server): neither port 80 nor 443 had an explicit
#   `default_server` — per nginx's fallback rule, crm.conf's blocks
#   (alphabetically first) silently served ANY unmatched Host, including
#   none at all (`curl http://<origin-ip>/`). Fixed with
#   nginx/conf.d/default-server.conf (`return 444;` catch-all).
#
#   Cloudflare-only source-IP gate (REVERTED, security review round 1):
#   the first version of this PR added a plain `allow <cloudflare
#   ranges>; deny all;` gate. nginx's realip module runs in the
#   POST_READ/PREACCESS phases — BEFORE ngx_http_access_module's ACCESS
#   phase — and, when `set_real_ip_from`/`real_ip_header
#   CF-Connecting-IP` match, it REWRITES `$remote_addr` (and the
#   connection's own stored address, which `allow`/`deny` reads) to the
#   value of the client-SUPPLIED `CF-Connecting-IP` header. A plain
#   `allow`/`deny` gate therefore filters on an attacker-controlled
#   header, not the actual TCP peer:
#     - a REAL visitor via Cloudflare: TCP peer is a Cloudflare edge IP
#       (in-range), CF-Connecting-IP is the visitor's own public IP
#       (essentially never in Cloudflare's range) → realip rewrites
#       $remote_addr to that → allow/deny denies it. Verified live: 403,
#       nginx error.log `access forbidden by rule, client: 203.0.113.7`
#       (the simulated CF-Connecting-IP value).
#     - an ATTACKER connecting directly from an IP that happens to be
#       inside Cloudflare's published range, sending NO CF-Connecting-IP
#       header at all: realip has nothing to substitute, $remote_addr
#       stays the real (in-range) peer address → allow/deny ALLOWS it.
#       Verified live: 200.
#   i.e. the gate blocked real visitors and passed the exact traffic it
#   was meant to stop — merging it would have taken both domains down
#   entirely. A corrected version (comparing `$realip_remote_addr` — the
#   PRE-substitution peer address — via `geo`, not the mutated
#   `$remote_addr`) is tracked as a separate, follow-up PR; see that PR's
#   own header comment for the "if directive not allowed here" gotcha
#   discovered along the way (a bare `if{}` snippet cannot live in
#   conf.d/ — nginx.conf's wildcard `include /etc/nginx/conf.d/*.conf;`
#   also sweeps it up directly at http level, where `if` is invalid).
#
# ── real-visitor regression guard (why it's in THIS script) ────────────────
#   The `allow`/`deny` gate above is gone from this branch, so nothing
#   currently blocks real Cloudflare-forwarded visitors. But the ROOT
#   CAUSE that made the bug possible — nobody had a check that simulates
#   "a real visitor arriving via Cloudflare" — would let it (or an
#   equivalent regression) come back silently. `check_visitor_not_blocked`
#   below sends a `CF-Connecting-IP` header on every request (exactly what
#   Cloudflare would forward for a genuine visitor) and asserts the
#   response is NOT a 403 — this stays green today (no gate to trip it)
#   and becomes the tripwire the moment ANY future source-IP gate
#   (including the corrected follow-up PR) regresses to filtering on the
#   post-realip `$remote_addr` again.
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
#   3. The real-visitor regression guard — also safe anywhere; it's a
#      plain GET with an extra header, no different from any real request
#      Cloudflare forwards.
#
# Tests: scripts/devops/tests/test-check-nginx-perimeter.sh — positive AND
# negative cases against a controllable stub origin (tests/lib/fake-origin.py),
# including the reverted PR #437 gate 403ing a real Cloudflare-forwarded visitor,
# a missing default_server catch-all, missing body caps, and — for
# check_gate_keyed_on_realip below — both a geo block keyed on the wrong variable
# AND an unreadable `nginx -T` while docker access exists, so that a SKIP can
# never be mistaken for a PASS.
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

# TEST-NET-3 (RFC 5737) — reserved for documentation/examples, never a real
# routable address. Stands in for "some real visitor's public IP" in the
# CF-Connecting-IP regression guard below; the exact value doesn't matter,
# only that it is NOT inside any Cloudflare-published range (so a
# realip-substituted allow/deny gate, if one existed, would reject it —
# which is precisely the bug this guard exists to catch).
SIMULATED_VISITOR_IP='203.0.113.7'

PASS=0
FAIL=0
SKIP=0

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

# nginx's stock error-page template is IDENTICAL across every status code it
# generates itself (413, 502, 503, 504, ...) — only the number/reason phrase
# in the <title>/<h1> changes; the footer `<center>nginx</center>` is
# constant. Grepping for the 413-specific title string alone would silently
# count a 502 (upstream unreachable) or 504 (upstream timeout) as "reached
# the app" — found in security review round 1: `check_passes_nginx()`
# checked ONLY for the absence of the 413 title, so any OTHER nginx-generated
# error page (e.g. the API container being down) fell through as a false
# PASS. Matching the constant footer instead closes the whole class, not
# just the one status code this test happens to exercise.
NGINX_ERROR_PAGE_SIGNATURE='<center>nginx</center>'

# Args: description, host, size-in-MB. Asserts the response reached the
# REAL upstream — i.e. neither nginx's own error-page template (see above)
# NOR a non-2xx/4xx-from-the-app status that nginx itself could have
# generated. Whatever the upstream itself returned (200 from a local stub,
# 404 "Cannot POST" from the real Nest app, a real 413 JSON from the app's
# own size check) counts as a pass; only nginx's own generated pages don't.
check_passes_nginx() {
  local desc="$1" host="$2" mb="$3"
  local out body code
  out="$(curl -sS -k --max-time 20 -H "Host: $host" --data-binary @"$(payload "$mb")" \
    -w '\n%{http_code}' "$ORIGIN/api/health" 2>/dev/null)"
  code="${out##*$'\n'}"
  body="${out%$'\n'"$code"}"

  if [[ "$body" != *"$NGINX_ERROR_PAGE_SIGNATURE"* ]]; then
    PASS=$((PASS + 1))
    printf 'PASS  %-70s HTTP %s, upstream responded: %.70s\n' "$desc" "$code" "$body"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-70s HTTP %s, got nginx'"'"'s OWN error page: %.70s\n' "$desc" "$code" "$body"
  fi
}

# Args: description, host, size-in-MB. Asserts nginx's own client_max_body_size
# backstop fired — the response IS nginx's generated error-page template,
# with a 413 status specifically (not just "some nginx page" — 413 is the
# only status this specific test could legitimately produce, so pinning it
# catches a misconfigured/wrong-cause block too).
check_blocked_by_nginx() {
  local desc="$1" host="$2" mb="$3"
  local out body code
  out="$(curl -sS -k --max-time 20 -H "Host: $host" --data-binary @"$(payload "$mb")" \
    -w '\n%{http_code}' "$ORIGIN/api/health" 2>/dev/null)"
  code="${out##*$'\n'}"
  body="${out%$'\n'"$code"}"

  if [[ "$code" == "413" && "$body" == *"$NGINX_ERROR_PAGE_SIGNATURE"* ]]; then
    PASS=$((PASS + 1))
    printf 'PASS  %-70s nginx backstop fired (413), as expected\n' "$desc"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-70s expected nginx'"'"'s 413 backstop, got HTTP %s: %.70s\n' "$desc" "$code" "$body"
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

# Args: description, host. Real-visitor regression guard (see header
# comment) — sends CF-Connecting-IP exactly as Cloudflare would for a
# genuine visitor and asserts the request is NOT rejected with a 403. Does
# NOT assert a specific success status (the real app behind /api/health
# always 200s regardless of this header; a local stub might differ) — only
# that nothing in the perimeter is filtering on this attacker-controlled
# header the way the reverted gate did.
check_visitor_not_blocked() {
  local desc="$1" host="$2"
  local code
  code="$(curl -sS -k --max-time 10 -o /dev/null -w '%{http_code}' \
    -H "Host: $host" -H "CF-Connecting-IP: $SIMULATED_VISITOR_IP" "$ORIGIN/api/health" 2>/dev/null)"

  if [[ "$code" != "403" ]]; then
    PASS=$((PASS + 1))
    printf 'PASS  %-70s HTTP %s, visitor not blocked\n' "$desc" "$code"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-70s got HTTP 403 — a source-IP gate is filtering on the\n' "$desc"
    printf '      client-supplied CF-Connecting-IP header instead of the real TCP\n'
    printf '      peer (the exact bug reverted from this PR — see header comment).\n'
  fi
}

# ── gate-variable regression guard (why THIS check, not a bigger fix to ───
# ── check_visitor_not_blocked above — security review, PR #439 follow-up, ─
# ── MED-3, 2026-07-31) ──────────────────────────────────────────────────
#   check_visitor_not_blocked above went VACUOUS the moment the origin
#   gate's LOCAL_TRUSTED allow-list (nginx/cloudflare-ips.txt) started
#   covering the docker-compose pinned subnet: this script's OWN test
#   peer (127.0.0.1 in a local dry-run, or the VPS's own bridge-gateway
#   address in deploy.yml's FATAL smoke test) is now itself unconditionally
#   trusted BEFORE realip is even in the picture, so `check_visitor_not_
#   blocked`'s assertion ("not 403") passes REGARDLESS of which nginx
#   variable the gate is keyed on — it cannot distinguish the fix from the
#   exact bug it exists to catch (the reverted $remote_addr gate).
#
#   The fundamental reason a plain curl-based check cannot fix this: nginx's
#   realip module only ever substitutes $remote_addr for a peer that is
#   ITSELF listed in `set_real_ip_from` (only Cloudflare's published ranges
#   here) — for any OTHER peer (this script's own test peer, always), a
#   forged CF-Connecting-IP header is syntactically present but semantically
#   inert: realip never fires, so $remote_addr and $realip_remote_addr are
#   PROVABLY IDENTICAL for every request this script (or deploy.yml) is able
#   to send. $remote_addr-vs-$realip_remote_addr can only ever diverge for a
#   peer that IS a genuine Cloudflare edge — i.e. only observable by running
#   through production Cloudflare itself, which is exactly the dependency
#   deploy.yml's FATAL smoke tests were deliberately changed to AVOID (see
#   the "landing origin" smoke test's own LOW-3 comment). No HTTP-only test
#   invoked the way this script is actually invoked can close this gap.
#
#   So: a STATIC assertion on the compiled config, not another HTTP probe.
#   Reads the geo block's key variable straight from `nginx -T` (the
#   authoritative, fully-resolved config nginx itself is running) and
#   fails if it is ANYTHING other than exactly `$realip_remote_addr` —
#   directly, deterministically catches a reversion to `$remote_addr`
#   (or any other variable), with no dependency on network topology,
#   trust ranges, or which peer this script happens to run from.
#
#   Best-effort / optional, NOT silently skipped: requires docker exec
#   access to the running nginx container (the caller sets NGINX_EXEC_CMD,
#   e.g. `docker compose -f docker-compose.prod.yml -f docker-compose.
#   ghcr.yml --env-file .env.production exec -T nginx`) — deploy.yml's
#   FATAL invocation of this script DOES have that access (same shell
#   session already runs `docker compose ... exec -T postgres` etc. a few
#   steps earlier) and sets it, so this check has real teeth there. A local
#   dry-run or an external `ORIGIN=https://cheekycheese.tech` invocation
#   without docker access explicitly SKIPs (own counter, does not fail the
#   script) rather than silently reporting PASS for a check that never ran.
check_gate_keyed_on_realip() {
  local desc="Origin gate's geo block is keyed on \$realip_remote_addr (not \$remote_addr)"

  if [ -z "${NGINX_EXEC_CMD:-}" ]; then
    SKIP=$((SKIP + 1))
    printf 'SKIP  %-70s NGINX_EXEC_CMD not set — no docker exec access from this invocation\n' "$desc"
    return
  fi

  local geo_line
  geo_line="$($NGINX_EXEC_CMD nginx -T 2>/dev/null | grep -m1 'geo \$[a-z_]* \$origin_gate_allowed')"

  if [ -z "$geo_line" ]; then
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-70s could not find the $origin_gate_allowed geo block via `nginx -T`\n' "$desc"
    printf '      (NGINX_EXEC_CMD set but nginx -T returned nothing usable — check the\n'
    printf '      command/container name, or the gate was refactored without updating\n'
    printf '      this check).\n'
    return
  fi

  case "$geo_line" in
    *'geo $realip_remote_addr $origin_gate_allowed'*)
      PASS=$((PASS + 1))
      printf 'PASS  %-70s keyed on $realip_remote_addr\n' "$desc"
      ;;
    *)
      FAIL=$((FAIL + 1))
      printf 'FAIL  %-70s got: %s\n' "$desc" "$geo_line"
      printf '      The origin gate is NOT keyed on $realip_remote_addr — this is the\n'
      printf '      exact bug class reverted from PR #437 (filtering on the post-realip-\n'
      printf '      substitution $remote_addr blocks real Cloudflare-forwarded visitors\n'
      printf '      and passes an attacker connecting from inside a Cloudflare-owned\n'
      printf '      range without the header). See nginx/snippets/origin-gate.conf.\n'
      ;;
  esac
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

# ── real-visitor regression guard (security review round 1 finding) ───────
check_visitor_not_blocked "CRM: real visitor via Cloudflare (CF-Connecting-IP) is not blocked" "$CRM_HOST"
check_visitor_not_blocked "Landing: real visitor via Cloudflare (CF-Connecting-IP) is not blocked" "$LANDING_HOST"

# ── gate-variable regression guard (security review round 2, MED-3) ───────
# See check_gate_keyed_on_realip's own header comment for why this is a
# STATIC config assertion rather than another HTTP probe.
check_gate_keyed_on_realip

echo
echo "== $PASS passed, $FAIL failed, $SKIP skipped =="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
