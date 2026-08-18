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
# scripts/devops/origin-gate-rollout-runbook.md's flip procedure (§3.2 /
# §5 checklist / §7 inventory) — run it and get a clean result BEFORE
# flipping ORIGIN_GATE_MODE to enforce, not "at some point" as a follow-up.
#
# task-cloudflare-ips-watch (2026-08-18): the reasoning that used to live here
# ("deliberately NOT wired into a scheduled job — no unnecessary recurring CI
# jobs, golden rule #4") no longer holds. The owner applied the Hetzner
# network firewall the same day (docs/runbooks/origin-mtls-and-firewall.md
# §1) restricting :80/:443 to Cloudflare's published ranges ONLY — after
# that, a stale list does not just degrade the realip/rate-limit signal
# above, it drops real visitors on a timeout the instant Cloudflare
# publishes a range this file does not have yet. Staleness went from "noise
# in logs" to "part of the site is down". This is now called TWICE A DAY by
# `.github/workflows/cloudflare-ips-watch.yml`, machine-parseable via the
# ADDED_OUT/REMOVED_OUT env vars below — see that workflow's own header for
# why the comparison logic still lives in exactly ONE place (here) rather
# than being re-implemented a second time in the watcher (it patches the
# repo file's EXISTING line order by ADDED_OUT/REMOVED_OUT rather than
# asking this script to hand back the raw live lists — Cloudflare's own
# publish order is not guaranteed stable between fetches, and rebuilding
# from it wholesale produced a fully-reshuffled, unreviewable diff for a
# single-line change; see that script's own header). The manual
# precondition-check usage (plain human-readable stdout, no env vars set)
# is completely unchanged — this is an additive extension, not a rewrite.
#
# security review (PR #557, 2026-08-18, HIGH): the ORIGINAL version of this
# script treated ANY successful, non-empty HTTP response as a valid range
# list — it never checked that the body actually looked like CIDRs of the
# right family, and never checked that the count was plausible. Two
# real-run-reproduced failure modes followed directly from that:
#   (a) the endpoint answers 200 with an HTML error/redirect page instead of
#       the text list (proxy hiccup, WAF page, etc.) — every "line" of that
#       HTML fails to match anything in the repo file, so ALL real ranges
#       for that family show up as "extra" (Cloudflare no longer publishes
#       them) — a scheduled run would have opened a PR/issue instructing the
#       owner to strip their ENTIRE IPv6 allow-list from the firewall.
#   (b) the response is truncated by exactly ONE line (a dropped connection
#       mid-transfer that curl's own `--fail`/Content-Length check did not
#       catch, or a caching layer serving a stale partial object) — every
#       remaining line is a perfectly well-formed CIDR, so format alone
#       cannot distinguish this from Cloudflare genuinely retiring one
#       range. The dangerous direction is IDENTICAL either way: the file's
#       one legitimately-still-active range reads as "safe to remove", and
#       cleanup framing (AC2) makes it look unhurried and certain — the
#       exact shape a human skims past.
# Two independent checks close these, in order:
#   1. FORMAT — every non-blank line of the raw response must match a CIDR
#      shape for the family being fetched (see CIDR_V4_RE/CIDR_V6_RE below).
#      Closes (a): an HTML body fails on line one.
#   2. COUNT FLOOR — the fetched count for a family must not be LOWER than
#      what the repo file currently records for that family (LOCAL_TRUSTED
#      excluded). Closes (b). This is deliberately a ZERO-tolerance floor,
#      not a "the drop looked large enough" percentage threshold: a
#      genuine single-range Cloudflare retirement and a single-line
#      truncation produce the EXACT SAME numeric signature (one family's
#      count goes down by one) — there is no way to tell them apart from
#      the CIDR list content alone, so a percentage threshold tuned to
#      "obviously wrong" would never catch a one-line drop, which is
#      exactly the case that matters. The accepted cost: a genuine
#      Cloudflare range retirement now also fails this check (exit 2,
#      loud) instead of being auto-detected as a cleanup PR — a human has
#      to notice, re-verify by hand, and edit the repo file once. That
#      cost is a single failed scheduled run; the alternative cost is
#      telling the owner to remove a range that is still live. See PR #557
#      review: "ложная тревога здесь стоит одного письма, ложное «удали» —
#      простоя" — the asymmetry is deliberate, not an oversight.
#
# Its behaviour in all three directions — fresh, drifted, and "could not
# check" — is proven by
# scripts/devops/tests/test-check-cloudflare-ips-freshness.sh.
#
# Fails LOUD, not silent, on any of: network/fetch failure, mismatch in
# either direction, or an unparseable Cloudflare response — this is a
# fail-CLOSED precondition gate, "could not verify freshness" must never be
# treated the same as "verified fresh". "Could not verify" and "verified
# drifted" are ALSO never the same thing to a caller that has to decide what
# to DO about the result (open a PR vs. just fail loud) — see the distinct
# exit codes below.
#
# Exit codes (task-cloudflare-ips-watch, 2026-08-18 — previously both
# "could not check" and "mismatch" exited 1 indistinguishably; the only
# caller was a human reading stdout, for whom that distinction did not
# matter. It matters to an automated caller):
#   0   fresh — repo CF ranges match Cloudflare exactly (LOCAL_TRUSTED lines
#       in the repo file, if any, are ignored — see below).
#   1   drifted — comparison SUCCEEDED and found a real difference. This is
#       the "act on it" case, not a broken sentinel.
#   2   could not verify at all (file missing, fetch failed, empty response,
#       response body does not look like CIDRs of the right family, fetched
#       count below the repo's current count for that family, or REPO_FILE
#       argument invalid) — the sentinel itself is down, or cannot be
#       trusted. A caller must treat this as loud failure, never as "no
#       drift" and never as "safe to remove".
#
# Usage:
#   scripts/devops/check-cloudflare-ips-freshness.sh
#   scripts/devops/check-cloudflare-ips-freshness.sh path/to/cloudflare-ips.txt
#
# Optional env (all unset by default — the plain manual/runbook invocation
# above is unaffected by any of them):
#   ADDED_OUT     path — write the sorted, de-duplicated list of CIDRs
#                 Cloudflare publishes that the repo file lacks (v4+v6
#                 combined, one per line; empty file if none). This is the
#                 "add to the firewall, urgent" side.
#   REMOVED_OUT   path — same shape, for CIDRs the repo file has that
#                 Cloudflare no longer publishes (after LOCAL_TRUSTED is
#                 excluded). This is the "safe to remove, cleanup" side.
# Both are written whenever set, on BOTH the fresh (empty file) and the
# drifted path — never on the "could not verify" (exit 2) path, where there
# is nothing trustworthy to write.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CF_IPS_FILE="${1:-$SCRIPT_DIR/../../nginx/cloudflare-ips.txt}"

if [ ! -f "$CF_IPS_FILE" ]; then
  echo "ERROR: $CF_IPS_FILE not found." >&2
  exit 2
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "== check-cloudflare-ips-freshness.sh — comparing $CF_IPS_FILE against live Cloudflare ranges =="
echo

FAIL=0

# LOCAL_TRUSTED — subnets that legitimately live in nginx/cloudflare-ips.txt
# (or a future revision of it) WITHOUT coming from Cloudflare, so their
# absence from cloudflare.com/ips-v4|v6 is not drift. Today's actual repo
# file carries none of these (it is 100% Cloudflare-sourced — confirmed by
# reading it 2026-08-18); this list exists so that stays true by choice, not
# by accident: if a local/intra-host subnet is ever folded into the repo
# file directly, it is excluded from the "extra" (repo-only) side of the
# diff below instead of permanently reading as unexplained staleness. MUST
# match the `LOCAL_TRUSTED` constant in
# generate-cloudflare-nginx-snippets.sh (the origin gate's OWN local-trust
# list, which is separately baked into the generated nginx config, not
# sourced from this file) — same "two descriptions of one zone" risk that
# constant's own header warns about; keep them equal by hand until one can
# be generated from the other. Checked by
# scripts/devops/tests/test-cloudflare-local-trusted-sync.sh — a shared data
# file was the first choice (security review PR #557, informational) but
# generate-cloudflare-nginx-snippets.sh runs inside the nginx Docker build
# stage, which COPYs only that one script in, not a shared file alongside
# it; changing that COPY line is nginx/Dockerfile, outside this task's zone.
LOCAL_TRUSTED='127.0.0.1
::1
172.30.0.0/23'

# ── repo-side parsing FIRST — pure local file work, no network involved ────────
# Computed before any fetch so the count-floor guard inside fetch() below has
# a trusted prior state to anchor against.
#
# nginx/cloudflare-ips.txt interleaves IPv4/IPv6 (`#`-prefixed comments and
# blank lines ignored, same convention the generator script itself uses) —
# split by presence of a `:` (IPv6) vs not (IPv4), same distinction
# Cloudflare's own two separate live endpoints already make.
grep -v '^[[:space:]]*#' "$CF_IPS_FILE" | grep -v '^[[:space:]]*$' | grep -v ':' | sort >"$WORKDIR/repo-v4.txt"
grep -v '^[[:space:]]*#' "$CF_IPS_FILE" | grep -v '^[[:space:]]*$' | grep ':' | sort >"$WORKDIR/repo-v6.txt"

# Exclude LOCAL_TRUSTED lines from BOTH repo-side files before diffing, so
# they can never surface as "extra" (Cloudflare no longer publishes them) —
# they were never Cloudflare's to publish in the first place.
printf '%s\n' "$LOCAL_TRUSTED" | grep -v ':' | sort >"$WORKDIR/local-trusted-v4.txt"
printf '%s\n' "$LOCAL_TRUSTED" | grep ':' | sort >"$WORKDIR/local-trusted-v6.txt"
comm -23 "$WORKDIR/repo-v4.txt" "$WORKDIR/local-trusted-v4.txt" >"$WORKDIR/repo-v4-cf-only.txt"
comm -23 "$WORKDIR/repo-v6.txt" "$WORKDIR/local-trusted-v6.txt" >"$WORKDIR/repo-v6-cf-only.txt"

# count_lines: `grep -c '^'`, NOT `wc -l`. Found by running this script
# against the REAL cloudflare.com/ips-v4 response while verifying the fix
# below (not by reading it): Cloudflare's actual body has NO trailing
# newline after the last CIDR. `wc -l` counts newline CHARACTERS, so it
# silently undercounts by exactly one on that real response — which would
# have made the brand-new count-floor guard permanently misfire on
# perfectly fresh data (every scheduled run believing the live fetch was
# truncated by one line, because it always was, by this counting method).
# The very guard meant to stop the sentinel from causing an outage would
# have caused one. `grep -c '^'` counts LINES (a trailing newline is not
# required for the last one to count) and is used for every count in this
# file from here on, including the repo-side counts, for the same reason —
# not because repo-side files are currently at risk (they pass through
# `sort`/`comm`, which do terminate their last line), but because "this
# specific file happens to be safe today" is exactly the kind of assumption
# that already broke once here.
# `|| true`: this script only runs under `set -u` (no `-e`), so `grep`
# exiting 1 on a zero-line file would not itself abort anything here — but
# cloudflare-ips-watch.sh's OWN copy of this idiom runs under `set -e`,
# where that exit code silently kills the whole script on the most common
# input (an empty ADDED/REMOVED file — see that script's count_lines()).
# Keeping the same defensive `|| true` in both, rather than "this file
# happens to be fine without it", is the whole point after getting bitten
# by "safe today" once already in this same file (see LOCAL_TRUSTED above).
count_lines() { grep -c '^' "$1" || true; }

REPO_V4_COUNT="$(count_lines "$WORKDIR/repo-v4-cf-only.txt")"
REPO_V6_COUNT="$(count_lines "$WORKDIR/repo-v6-cf-only.txt")"

# ── fetch + validate (format AND count) — see the HIGH writeup above ───────────
CIDR_V4_RE='^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$'
CIDR_V6_RE='^[0-9A-Fa-f:]+/[0-9]{1,3}$'

fetch() {
  local family="$1" url="$2" out="$3" repo_count="$4"
  local cidr_re
  case "$family" in
    v4) cidr_re="$CIDR_V4_RE" ;;
    v6) cidr_re="$CIDR_V6_RE" ;;
  esac

  if ! curl -sS --max-time 15 --fail "$url" -o "$out" 2>"$WORKDIR/curl-err.log"; then
    echo "ERROR: could not fetch $url — freshness NOT verified (fail-closed, this is not a PASS)." >&2
    cat "$WORKDIR/curl-err.log" >&2
    return 1
  fi
  if [ ! -s "$out" ]; then
    echo "ERROR: $url returned an empty response — freshness NOT verified (fail-closed, this is not a PASS)." >&2
    return 1
  fi

  # CHECK 1 — format. Every non-blank line must look like a CIDR of the
  # right family. Rejects an HTML error/redirect body outright (Case A).
  local bad
  bad="$(grep -v '^[[:space:]]*$' "$out" | grep -vE "$cidr_re" || true)"
  if [ -n "$bad" ]; then
    echo "ERROR: $url did not return a clean list of $family CIDR ranges — found line(s) that are not $family CIDRs (HTML error page / redirect body / garbage response — fail-closed, this is not a PASS):" >&2
    echo "$bad" | sed 's/^/  /' >&2
    return 1
  fi

  # CHECK 2 — count floor. The fetched count must not be LOWER than what the
  # repo already trusts for this family. See the header's HIGH writeup for
  # why this is zero-tolerance rather than a percentage threshold (Case B).
  local live_count
  live_count="$(count_lines "$out")"
  if [ "$repo_count" -gt 0 ] && [ "$live_count" -lt "$repo_count" ]; then
    echo "ERROR: $url returned only $live_count $family range(s) — fewer than the $repo_count this repo currently trusts. This looks like a truncated/incomplete fetch, not a genuine Cloudflare change (fail-closed, this is not a PASS). If Cloudflare genuinely retired a range, re-run this check and inspect the result by hand before trusting a drop — do not let an automated caller act on it." >&2
    return 1
  fi
}

if ! fetch v4 'https://www.cloudflare.com/ips-v4' "$WORKDIR/live-v4.txt" "$REPO_V4_COUNT"; then
  exit 2
fi
if ! fetch v6 'https://www.cloudflare.com/ips-v6' "$WORKDIR/live-v6.txt" "$REPO_V6_COUNT"; then
  exit 2
fi

sort "$WORKDIR/live-v4.txt" >"$WORKDIR/live-v4-sorted.txt"
sort "$WORKDIR/live-v6.txt" >"$WORKDIR/live-v6-sorted.txt"

: >"$WORKDIR/added-all.txt"
: >"$WORKDIR/removed-all.txt"

check_set() {
  local label="$1" repo="$2" live="$3"
  local missing extra
  # In live, not in repo — Cloudflare added a range we don't have yet.
  missing="$(comm -23 "$live" "$repo")"
  # In repo, not in live — Cloudflare removed/renumbered a range we still have.
  extra="$(comm -13 "$live" "$repo")"

  [ -n "$missing" ] && printf '%s\n' "$missing" >>"$WORKDIR/added-all.txt"
  [ -n "$extra" ] && printf '%s\n' "$extra" >>"$WORKDIR/removed-all.txt"

  if [ -z "$missing" ] && [ -z "$extra" ]; then
    echo "PASS  $label — $(count_lines "$repo") range(s), matches Cloudflare exactly"
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

check_set "IPv4" "$WORKDIR/repo-v4-cf-only.txt" "$WORKDIR/live-v4-sorted.txt"
check_set "IPv6" "$WORKDIR/repo-v6-cf-only.txt" "$WORKDIR/live-v6-sorted.txt"

if [ -n "${ADDED_OUT:-}" ]; then
  sort -u "$WORKDIR/added-all.txt" >"$ADDED_OUT"
fi
if [ -n "${REMOVED_OUT:-}" ]; then
  sort -u "$WORKDIR/removed-all.txt" >"$REMOVED_OUT"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "== nginx/cloudflare-ips.txt is FRESH — safe to proceed =="
  exit 0
else
  echo "== STALE — update nginx/cloudflare-ips.txt (both cloudflare.com/ips-v4 and /ips-v6), rebuild, re-run this script =="
  exit 1
fi
