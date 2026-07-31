#!/bin/sh
# generate-cloudflare-nginx-snippets.sh — build nginx/conf.d/
# cloudflare-real-ip-from.conf + nginx/conf.d/origin-gate-geo.conf FROM
# nginx/cloudflare-ips.txt (the one canonical CIDR list — see that file's
# header for the "why" of this generation step, security review PR #437
# follow-up, MED-2: the list used to be hand-duplicated in five places).
#
# POSIX `sh`, not bash: runs inside the `nginx:1.27-alpine` Docker build
# stage (nginx/Dockerfile), which has no bash by default. Portable — no
# bashisms, tested locally with both `sh` and `bash` before every commit.
#
# Usage:
#   scripts/devops/generate-cloudflare-nginx-snippets.sh <cf-ips-file> <out-dir>
#
# Writes:
#   <out-dir>/cloudflare-real-ip-from.conf — `set_real_ip_from <cidr>;` per
#     line, one per range in <cf-ips-file>. `include`d from crm.conf /
#     landing.conf (both :80 and :443) in place of the 4 previously
#     hand-duplicated blocks.
#   <out-dir>/origin-gate-geo.conf — `geo $realip_remote_addr
#     $origin_gate_allowed { ... }` — keyed on `$realip_remote_addr`
#     (the PRE-realip-substitution TCP peer, see origin-gate.conf's own
#     header comment for why this is the ONLY correct variable to gate
#     on), NOT `$remote_addr` (see the reverted origin-access.conf's bug).
#     `default 0`, every Cloudflare range from <cf-ips-file> plus a small
#     fixed set of local/intra-host addresses (loopback + the PINNED
#     docker-compose.prod.yml frontend/backend subnet — see that file's
#     `ipam.config.subnet` — NOT a guessed range like the reverted PR's
#     172.16.0.0/12, which security review found does not match every
#     Docker networking setup) map to `1`.
set -eu

CF_IPS_FILE="${1:?usage: $0 <cf-ips-file> <out-dir>}"
OUT_DIR="${2:?usage: $0 <cf-ips-file> <out-dir>}"

if [ ! -f "$CF_IPS_FILE" ]; then
  echo "ERROR: $CF_IPS_FILE not found." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

RIF_FILE="$OUT_DIR/cloudflare-real-ip-from.conf"
GEO_FILE="$OUT_DIR/origin-gate-geo.conf"

# Local/intra-host addresses ALWAYS trusted by the origin gate, independent
# of Cloudflare. 127.0.0.1/::1 — the nginx container's own loopback (its
# docker-compose healthcheck genuinely connects this way). The pinned
# subnet below MUST match docker-compose.prod.yml's `frontend`/`backend`
# networks' `ipam.config.subnet` exactly — deploy.yml's post-deploy smoke
# tests curl the HOST-published port from the VPS shell, which Docker's
# userland-proxy NATs through the bridge gateway (NOT literal 127.0.0.1 —
# security review confirmed this empirically, and separately confirmed the
# PREVIOUS guess (172.16.0.0/12, the Docker DEFAULT allocation range) is
# NOT universal — the reviewer's own Docker Desktop environment used
# 192.168.65.1, outside that range). Pinning an EXPLICIT subnet in compose
# removes the guesswork entirely.
LOCAL_TRUSTED='127.0.0.1
::1
172.30.0.0/23'

# security review (PR #439 follow-up, MED-1, 2026-07-31): the pin above is
# BUILD-TIME static — it documents and enforces the INTENDED topology, but
# deploy.yml's `docker compose up -d` never recreates an already-existing
# network, so on any deploy where frontend/backend already exist with a
# DIFFERENT (Docker-auto-allocated) subnet, this pin can silently fail to
# apply. nginx/docker-entrypoint.d/25-origin-gate-runtime-trust.sh runs at
# CONTAINER STARTUP (every deploy, unconditionally) and discovers THIS
# container's actual default-route gateway straight from the kernel,
# writing it to /etc/nginx/origin-gate-runtime-trusted.conf — `include`d
# into the geo block below ALONGSIDE the static pin, so the FATAL
# post-deploy smoke tests (deploy.yml) trust whichever address traffic
# ACTUALLY arrives from, regardless of whether the static pin took effect
# on this particular deploy. See that script's header comment for the full
# rationale. The file is created empty (comment-only, matches no address)
# by the Dockerfile at BUILD time so `nginx -t` has something to include
# before the entrypoint has ever run; the entrypoint overwrites it at
# every container start.
RUNTIME_TRUSTED_INCLUDE='/etc/nginx/origin-gate-runtime-trusted.conf'

{
  echo '# GENERATED — do NOT edit by hand.'
  echo '# Source: nginx/cloudflare-ips.txt, via scripts/devops/generate-cloudflare-nginx-snippets.sh'
  echo '# Edit nginx/cloudflare-ips.txt and rebuild to change this file.'
  grep -v '^[[:space:]]*#' "$CF_IPS_FILE" | grep -v '^[[:space:]]*$' | while IFS= read -r cidr; do
    echo "set_real_ip_from $cidr;"
  done
} >"$RIF_FILE"

{
  echo '# GENERATED — do NOT edit by hand.'
  echo '# Source: nginx/cloudflare-ips.txt, via scripts/devops/generate-cloudflare-nginx-snippets.sh'
  echo '# Edit nginx/cloudflare-ips.txt (Cloudflare ranges) or this script'
  echo '# (LOCAL_TRUSTED — must match docker-compose.prod.yml network subnets)'
  echo '# and rebuild to change this file.'
  echo ''
  echo '# security review (PR #437 follow-up): keyed on $realip_remote_addr —'
  echo '# the ORIGINAL TCP peer address BEFORE ngx_http_realip_module'
  echo '# substitutes it with the client-supplied CF-Connecting-IP header.'
  echo '# Gating on plain $remote_addr here would repeat the reverted bug'
  echo '# (blocks every real visitor, passes an attacker who omits that'
  echo '# header from an IP inside a Cloudflare range) — see'
  echo '# nginx/snippets/origin-gate.conf for the full writeup.'
  # shellcheck disable=SC2016 # intentional — these are nginx variable
  # names being WRITTEN into the generated config, not shell expansions.
  echo 'geo $realip_remote_addr $origin_gate_allowed {'
  echo '    default 0;'
  printf '%s\n' "$LOCAL_TRUSTED" | while IFS= read -r cidr; do
    echo "    $cidr 1;"
  done
  # MED-1 follow-up (see LOCAL_TRUSTED comment above): runtime-discovered
  # trust entry, written at container startup by
  # nginx/docker-entrypoint.d/25-origin-gate-runtime-trust.sh. Lives OUTSIDE
  # conf.d/ (nginx.conf's wildcard `include conf.d/*.conf;` would otherwise
  # ALSO try to load this file directly at http level, where a bare
  # `<cidr> <value>;` geo-body line is invalid syntax — same class of
  # mistake origin-gate.conf's own header comment documents for the `if`
  # snippet). Build-time placeholder (empty/comment-only) written by
  # nginx/Dockerfile so `nginx -t` has a valid, existing file to include
  # before the entrypoint has ever run.
  echo "    include $RUNTIME_TRUSTED_INCLUDE;"
  grep -v '^[[:space:]]*#' "$CF_IPS_FILE" | grep -v '^[[:space:]]*$' | while IFS= read -r cidr; do
    echo "    $cidr 1;"
  done
  echo '}'
} >"$GEO_FILE"

RANGE_COUNT=$(grep -v '^[[:space:]]*#' "$CF_IPS_FILE" | grep -vc '^[[:space:]]*$')
LOCAL_COUNT=$(printf '%s\n' "$LOCAL_TRUSTED" | wc -l | tr -d ' ')
echo "==> Generated $RIF_FILE and $GEO_FILE from $CF_IPS_FILE ($RANGE_COUNT Cloudflare ranges + $LOCAL_COUNT local-trusted entries)"
