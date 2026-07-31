#!/bin/bash
# check-cloudflare-ips-freshness.sh — diffs nginx/cloudflare-ips.txt against
# Cloudflare's LIVE published edge ranges (cloudflare.com/ips-v4, /ips-v6).
#
# security review (PR #439 follow-up, MED-4, 2026-07-31): nginx/cloudflare-
# ips.txt is the ONE canonical source for BOTH `set_real_ip_from` (which
# realip trusts to substitute CF-Connecting-IP for the real visitor IP —
# recorded as legal-proof IP on contract/ToS signatures, AND used as the
# nginx-level rate-limit key, see nginx/conf.d/crm.conf's own comments) AND
# the origin gate's allow-list (nginx/snippets/origin-gate.conf). A stale
# list degrades TWO different ways depending on direction:
#   - Cloudflare ADDS a range not in this file yet: realip does not fire for
#     visitors arriving via that range -> the "real" IP recorded/rate-
#     limited on is Cloudflare's OWN edge IP, not the visitor's (bites TODAY,
#     independent of ORIGIN_GATE_MODE) -> the rate-limit key collapses onto
#     one shared bucket for every visitor via that range, and the origin
#     gate additionally denies (fail-closed, 403 once enforce) a genuine
#     visitor whose realip-substituted IP happens to fall outside every
#     OTHER trusted range too.
#   - Cloudflare REMOVES/renumbers a range still in this file: harmless on
#     its own (an unused CIDR sitting in an allow-list), but signals the
#     list has not been re-verified in a while — a proxy for "how stale is
#     this", worth surfacing even though it is not independently dangerous.
#
# This script is the MANDATORY precondition check referenced by
# scripts/devops/origin-gate-rollout-runbook.md's flip procedure — run it
# and get a clean result BEFORE flipping ORIGIN_GATE_MODE to enforce, not
# "at some point" as a follow-up. Deliberately NOT wired into a scheduled
# GitHub Actions job (DevOps golden rule: no unnecessary recurring CI jobs —
# see RULES.md §5); it is a mandatory, documented STEP in the one procedure
# that actually needs it, run on demand.
#
# Fails LOUD, not silent, on any of: network/fetch failure, mismatch in
# either direction, or an unparseable Cloudflare response — this is a
# fail-CLOSED precondition gate, "could not verify freshness" must never be
# treated the same as "verified fresh".
#
# Usage:
#   scripts/devops/check-cloudflare-ips-freshness.sh
#   scripts/devops/check-cloudflare-ips-freshness.sh path/to/cloudflare-ips.txt
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CF_IPS_FILE="${1:-$SCRIPT_DIR/../../nginx/cloudflare-ips.txt}"

if [ ! -f "$CF_IPS_FILE" ]; then
  echo "ERROR: $CF_IPS_FILE not found." >&2
  exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "== check-cloudflare-ips-freshness.sh — comparing $CF_IPS_FILE against live Cloudflare ranges =="
echo

FAIL=0

fetch() {
  local url="$1" out="$2"
  if ! curl -sS --max-time 15 --fail "$url" -o "$out" 2>"$WORKDIR/curl-err.log"; then
    echo "ERROR: could not fetch $url — freshness NOT verified (fail-closed, this is not a PASS)." >&2
    cat "$WORKDIR/curl-err.log" >&2
    return 1
  fi
  if [ ! -s "$out" ]; then
    echo "ERROR: $url returned an empty response — freshness NOT verified (fail-closed, this is not a PASS)." >&2
    return 1
  fi
}

if ! fetch 'https://www.cloudflare.com/ips-v4' "$WORKDIR/live-v4.txt"; then
  exit 1
fi
if ! fetch 'https://www.cloudflare.com/ips-v6' "$WORKDIR/live-v6.txt"; then
  exit 1
fi

# nginx/cloudflare-ips.txt interleaves IPv4/IPv6 (`#`-prefixed comments and
# blank lines ignored, same convention the generator script itself uses) —
# split by presence of a `:` (IPv6) vs not (IPv4), same distinction
# Cloudflare's own two separate live endpoints already make.
grep -v '^[[:space:]]*#' "$CF_IPS_FILE" | grep -v '^[[:space:]]*$' | grep -v ':' | sort >"$WORKDIR/repo-v4.txt"
grep -v '^[[:space:]]*#' "$CF_IPS_FILE" | grep -v '^[[:space:]]*$' | grep ':' | sort >"$WORKDIR/repo-v6.txt"
sort "$WORKDIR/live-v4.txt" >"$WORKDIR/live-v4-sorted.txt"
sort "$WORKDIR/live-v6.txt" >"$WORKDIR/live-v6-sorted.txt"

check_set() {
  local label="$1" repo="$2" live="$3"
  local missing extra
  # In live, not in repo — Cloudflare added a range we don't have yet.
  missing="$(comm -23 "$live" "$repo")"
  # In repo, not in live — Cloudflare removed/renumbered a range we still have.
  extra="$(comm -13 "$live" "$repo")"

  if [ -z "$missing" ] && [ -z "$extra" ]; then
    echo "PASS  $label — $(wc -l <"$repo" | tr -d ' ') range(s), matches Cloudflare exactly"
  else
    FAIL=1
    echo "FAIL  $label — MISMATCH"
    if [ -n "$missing" ]; then
      echo "      Cloudflare has these ranges, nginx/cloudflare-ips.txt does NOT (stale — visitors"
      echo "      from these ranges will have their real IP unrecorded / rate-limit-bucket-collapsed"
      echo "      TODAY, and denied outright once ORIGIN_GATE_MODE=enforce):"
      echo "$missing" | sed 's/^/        /'
    fi
    if [ -n "$extra" ]; then
      echo "      nginx/cloudflare-ips.txt has these ranges, Cloudflare no longer publishes them"
      echo "      (not independently dangerous, but a signal the list needs re-verification):"
      echo "$extra" | sed 's/^/        /'
    fi
  fi
}

check_set "IPv4" "$WORKDIR/repo-v4.txt" "$WORKDIR/live-v4-sorted.txt"
check_set "IPv6" "$WORKDIR/repo-v6.txt" "$WORKDIR/live-v6-sorted.txt"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "== nginx/cloudflare-ips.txt is FRESH — safe to proceed =="
  exit 0
else
  echo "== STALE — update nginx/cloudflare-ips.txt (both cloudflare.com/ips-v4 and /ips-v6), rebuild, re-run this script =="
  exit 1
fi
