#!/bin/sh
# 25-origin-gate-runtime-trust.sh — runs automatically at container startup
# via the OFFICIAL nginx:1.27-alpine image's own /docker-entrypoint.sh,
# which sources every executable *.sh file under /docker-entrypoint.d/ (in
# `sort -V` order) BEFORE exec'ing nginx — verified against this exact base
# image (`docker run --rm nginx:1.27-alpine cat /docker-entrypoint.sh`);
# this file needs no extra ENTRYPOINT/CMD wiring in nginx/Dockerfile, it is
# picked up by the mechanism the base image already ships four of (10-, 15-,
# 20-, 30- — this one deliberately sorts between 20 and 30, no ordering
# dependency on either).
#
# security review (PR #439 follow-up, MED-1, 2026-07-31):
# docker-compose.prod.yml's `frontend`/`backend` networks pin an EXPLICIT
# subnet (172.30.0.0/24 + 172.30.1.0/24) so the origin gate
# (nginx/snippets/origin-gate.conf) can trust host-published-port
# smoke-test traffic — deploy.yml's FATAL post-deploy checks curl
# `http://127.0.0.1/...` FROM THE VPS SHELL (not through Cloudflare, see
# those steps' own comments for why), and Docker's port-publishing NATs
# that connection through the network's bridge gateway before nginx ever
# sees it — NOT literal 127.0.0.1 (verified empirically during review).
#
# BUT: `deploy.yml`'s deploy step only ever runs `docker compose up -d`
# (never `down`) — if `frontend`/`backend` already exist from a PRIOR
# deploy with a DIFFERENT (Docker-auto-allocated) subnet, this pin can
# silently fail to apply (older Compose versions quietly reuse the
# existing network unchanged) or make the deploy step itself fail outright
# trying to recreate a network still in use by running containers (newer
# Compose versions, see docker/compose#12495). Either way, the STATIC pin
# alone cannot be relied on to guarantee what nginx/cloudflare-ips.txt's
# LOCAL_TRUSTED constant actually matches on any given deploy.
#
# Reviewer's ask, and the reasoning for choosing it over simply dropping
# the subnet pin from this PR: "add the smoke-test peer's ACTUAL address to
# the allow-list, so the result does not depend on whether the pin
# applied" — safer than either (a) guessing a broader static range (the
# ORIGINAL, already-rejected mistake this whole gate exists to fix) or (b)
# relying on deploy-time operational discipline alone (a runbook step is
# still added, scripts/devops/origin-gate-rollout-runbook.md, but it should
# not be the ONLY thing standing between a stale network and every future
# deploy going red the moment ORIGIN_GATE_MODE flips to enforce).
#
# This script closes that gap WITHOUT widening the gate to a guessed/broad
# range: at startup, it reads THIS CONTAINER'S OWN actual default-route
# gateway straight from the kernel (/proc/net/route) — i.e. exactly the
# address host-published-port traffic will actually arrive from on THIS
# exact deploy, whatever subnet Docker happened to allocate, pin applied
# or not — and writes it to /etc/nginx/origin-gate-runtime-trusted.conf.
# nginx/cloudflare-ips.txt's generated origin-gate-geo.conf `geo {}` block
# (scripts/devops/generate-cloudflare-nginx-snippets.sh) `include`s that
# file ALONGSIDE the static LOCAL_TRUSTED pin — belt-and-suspenders: the
# static pin documents and enforces the INTENDED topology (still worth
# keeping — it makes drift visible in `docker network inspect` and gives
# the runbook something concrete to verify), this discovers whatever
# topology is ACTUALLY in effect on THIS container, so the FATAL smoke
# tests' result never depends on whether the pin silently failed to apply.
#
# /proc/net/route (no `ip`/`route` binary dependency — verified this base
# image's PATH does not have either; just POSIX sh + cut + printf + awk,
# all present in any container with a /proc filesystem): row with
# Destination "00000000" is the default route; its Gateway field is 8 hex
# chars in little-endian byte order. Verified against this exact base
# image + a real bridge network (`010011AC` -> 172.17.0.1, the Docker
# default-bridge gateway) before this script was written.
#
# Fail-safe (see write_empty below): ANY failure here — missing/unreadable
# /proc/net/route, no default route found, unexpected format — writes an
# EMPTY (comment-only) file, i.e. falls back to ONLY the static
# LOCAL_TRUSTED pin, and this script always exits 0. It must never widen
# trust on failure, and it must never be able to stop nginx from starting:
# the base image's own /docker-entrypoint.sh runs under `set -e` and
# invokes each *.sh script as a plain command inside a `while` loop body —
# a non-zero exit here WOULD abort the entire entrypoint chain (nginx never
# starts, the whole site goes down), which is a far worse failure mode
# than simply not getting the runtime-discovered trust entry this one time.

OUT_FILE=/etc/nginx/origin-gate-runtime-trusted.conf
ROUTE_FILE=/proc/net/route

write_empty() {
  {
    echo '# GENERATED at container startup by'
    echo '# nginx/docker-entrypoint.d/25-origin-gate-runtime-trust.sh — do NOT edit by hand.'
    echo '# No default-route gateway discovered (or discovery failed) this startup —'
    echo '# falling back to the static LOCAL_TRUSTED pin only'
    echo '# (nginx/cloudflare-ips.txt / scripts/devops/generate-cloudflare-nginx-snippets.sh).'
  } >"$OUT_FILE" 2>/dev/null
}

discover() {
  if [ ! -r "$ROUTE_FILE" ]; then
    echo "==> origin-gate-runtime-trust: $ROUTE_FILE not readable — skipping runtime discovery"
    write_empty
    return
  fi

  GW_HEX=$(awk '$2 == "00000000" { print $3; exit }' "$ROUTE_FILE" 2>/dev/null)

  if [ -z "$GW_HEX" ] || [ "${#GW_HEX}" -ne 8 ]; then
    echo "==> origin-gate-runtime-trust: no usable default-route gateway found in $ROUTE_FILE — skipping runtime discovery"
    write_empty
    return
  fi

  case "$GW_HEX" in
    *[!0-9A-Fa-f]*)
      echo "==> origin-gate-runtime-trust: unexpected gateway field '$GW_HEX' (not hex) — skipping runtime discovery"
      write_empty
      return
      ;;
  esac

  b1=$(printf '%d' "0x$(echo "$GW_HEX" | cut -c7-8)" 2>/dev/null)
  b2=$(printf '%d' "0x$(echo "$GW_HEX" | cut -c5-6)" 2>/dev/null)
  b3=$(printf '%d' "0x$(echo "$GW_HEX" | cut -c3-4)" 2>/dev/null)
  b4=$(printf '%d' "0x$(echo "$GW_HEX" | cut -c1-2)" 2>/dev/null)

  if [ -z "$b1" ] || [ -z "$b2" ] || [ -z "$b3" ] || [ -z "$b4" ]; then
    echo "==> origin-gate-runtime-trust: hex-to-decimal conversion failed for '$GW_HEX' — skipping runtime discovery"
    write_empty
    return
  fi

  GW_IP="$b1.$b2.$b3.$b4"

  {
    echo '# GENERATED at container startup by'
    echo '# nginx/docker-entrypoint.d/25-origin-gate-runtime-trust.sh — do NOT edit by hand.'
    echo "# This container's own default-route gateway ($GW_IP), discovered from"
    echo '# /proc/net/route — trusted by the origin gate the same as the static'
    echo '# LOCAL_TRUSTED pin (nginx/cloudflare-ips.txt), independent of whether that'
    echo '# pin actually took effect on docker-compose.prod.yml'"'"'s frontend/backend'
    echo '# networks this deploy (security review, PR #439 follow-up, MED-1).'
    echo "$GW_IP 1;"
  } >"$OUT_FILE" 2>/dev/null

  if [ -s "$OUT_FILE" ]; then
    echo "==> origin-gate-runtime-trust: trusting default-route gateway $GW_IP"
  else
    echo "==> origin-gate-runtime-trust: failed to write $OUT_FILE — falling back to static pin only"
    write_empty
  fi
}

discover
exit 0
