#!/usr/bin/env bash
# test-check-pnpm-audit.sh — proves scripts/devops/check-pnpm-audit.mjs goes RED
# for an unaccepted vulnerability and for a reasonless exception, and goes GREEN
# once either is properly addressed (task-prod-runtime-vulns, 2026-08-16 — this
# is task AC7's own "gate proven both directions" requirement, applied to the
# gate itself).
#
# The guard takes an audit-report path and an (optional) exceptions-file path as
# its two arguments, so every case here is a throwaway pair of fabricated JSON
# files — never the real `pnpm audit` output or the real exceptions file. The
# guard itself is the real, unmodified one CI runs.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/check-pnpm-audit.mjs"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# $1 = advisory id, $2 = module, $3 = severity, $4 = ghsa id
one_advisory_json() {
  local id="$1" mod="$2" sev="$3" ghsa="$4"
  printf '"%s": {"module_name": "%s", "severity": "%s", "github_advisory_id": "%s", "title": "fixture advisory", "url": "https://github.com/advisories/%s", "vulnerable_versions": "<9.9.9", "patched_versions": ">=9.9.9"}' \
    "$id" "$mod" "$sev" "$ghsa" "$ghsa"
}

echo "== test-check-pnpm-audit.sh =="
echo

# ── Case: unaccepted HIGH severity advisory, no exceptions file entry at all ──
# This is the deliberately-vulnerable-version case AC7 asks for directly.
UNACCEPTED_AUDIT="$WS/unaccepted-audit.json"
printf '{"advisories": {%s}}' "$(one_advisory_json 1 evil-pkg high GHSA-aaaa-bbbb-cccc)" >"$UNACCEPTED_AUDIT"

EMPTY_EXCEPTIONS="$WS/empty-exceptions.json"
printf '{"audit_level": "moderate", "exceptions": []}' >"$EMPTY_EXCEPTIONS"

assert_red "unaccepted HIGH advisory with an empty exceptions file" \
  --contains "GATED" \
  --contains "evil-pkg" \
  --contains "GHSA-aaaa-bbbb-cccc" \
  -- node "$GUARD" "$UNACCEPTED_AUDIT" "$EMPTY_EXCEPTIONS"

# ── Same advisory, now properly excepted with a real reason -> GREEN ──────────
# Proves the gate reverses when the vulnerability is addressed (removed OR
# consciously accepted with a reason) — the second half of AC7.
VALID_EXCEPTIONS="$WS/valid-exceptions.json"
cat >"$VALID_EXCEPTIONS" <<'JSON'
{
  "audit_level": "moderate",
  "exceptions": [
    {
      "module": "evil-pkg",
      "tier": "build",
      "reason": "fixture: reachable only through the mutation-testing devDependency chain, never a runtime path, verified with pnpm why evil-pkg -r",
      "ghsa_ids": ["GHSA-aaaa-bbbb-cccc"]
    }
  ]
}
JSON

assert_green "same HIGH advisory, now covered by a valid reasoned exception" \
  --contains "OK: no unaccepted advisory" \
  --contains "accepted exceptions" \
  -- node "$GUARD" "$UNACCEPTED_AUDIT" "$VALID_EXCEPTIONS"

# ── Case: exception entry exists but its reason is empty -> still RED ─────────
# The exact "список исключений без написанной причины не принимается" case.
NO_REASON_EXCEPTIONS="$WS/no-reason-exceptions.json"
cat >"$NO_REASON_EXCEPTIONS" <<'JSON'
{
  "audit_level": "moderate",
  "exceptions": [
    {
      "module": "evil-pkg",
      "tier": "build",
      "reason": "",
      "ghsa_ids": ["GHSA-aaaa-bbbb-cccc"]
    }
  ]
}
JSON

assert_red "exception entry with an EMPTY reason does not save the advisory" \
  --contains "no (or too short a) reason" \
  --contains "evil-pkg" \
  --contains "GATED" \
  -- node "$GUARD" "$UNACCEPTED_AUDIT" "$NO_REASON_EXCEPTIONS"

# ── Case: exception entry with a too-short, non-meaningful reason -> RED ──────
SHORT_REASON_EXCEPTIONS="$WS/short-reason-exceptions.json"
cat >"$SHORT_REASON_EXCEPTIONS" <<'JSON'
{
  "audit_level": "moderate",
  "exceptions": [
    {
      "module": "evil-pkg",
      "tier": "build",
      "reason": "n/a",
      "ghsa_ids": ["GHSA-aaaa-bbbb-cccc"]
    }
  ]
}
JSON

assert_red "exception entry with a too-short reason ('n/a') does not save the advisory" \
  --contains "no (or too short a) reason" \
  -- node "$GUARD" "$UNACCEPTED_AUDIT" "$SHORT_REASON_EXCEPTIONS"

# ── Case: advisory below the gate threshold, unaccepted -> GREEN (informational) ──
LOW_AUDIT="$WS/low-audit.json"
printf '{"advisories": {%s}}' "$(one_advisory_json 2 harmless-pkg low GHSA-dddd-eeee-ffff)" >"$LOW_AUDIT"

assert_green "LOW severity, unaccepted, below the moderate threshold — informational only" \
  --contains "below threshold" \
  --contains "GATED (unaccepted, >= moderate): 0" \
  --not-contains "FAIL:" \
  -- node "$GUARD" "$LOW_AUDIT" "$EMPTY_EXCEPTIONS"

# ── Case: exception lists a GHSA that pnpm audit no longer reports -> warning, still GREEN ──
STALE_AUDIT="$WS/stale-audit.json"
printf '{"advisories": {}}' >"$STALE_AUDIT"

assert_green "stale exception (package already fixed) warns but does not fail" \
  --contains "WARNING" \
  --contains "no longer reported" \
  --contains "OK: no unaccepted advisory" \
  -- node "$GUARD" "$STALE_AUDIT" "$VALID_EXCEPTIONS"

# ── Case: no advisories at all, empty exceptions -> GREEN, clean run ──────────
CLEAN_AUDIT="$WS/clean-audit.json"
printf '{"advisories": {}}' >"$CLEAN_AUDIT"

assert_green "no advisories at all" \
  --contains "OK: no unaccepted advisory" \
  -- node "$GUARD" "$CLEAN_AUDIT" "$EMPTY_EXCEPTIONS"

# ── Sanity: the REAL exceptions file this repo ships must itself be well-formed ──
# (every group has a real reason) — run against an empty audit so this case
# only exercises the exceptions-file validation, not the live `pnpm audit`
# network/lockfile dependency the harness explicitly avoids elsewhere.
REAL_EXCEPTIONS="$GUARD_DIR/pnpm-audit-exceptions.json"
assert_green "the real pnpm-audit-exceptions.json shipped in this repo is well-formed" \
  --not-contains "no (or too short a) reason" \
  -- node "$GUARD" "$CLEAN_AUDIT" "$REAL_EXCEPTIONS"

guard_test_summary "test-check-pnpm-audit.sh"
