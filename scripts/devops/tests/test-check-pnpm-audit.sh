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
  --contains "pnpm-audit-runbook.md" \
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

# ── Case: `pnpm audit` output has no `advisories` key at all -> RED, never a ──
# ── silent "0 advisories = OK" (security-review PR #536 round 2, MED-2) ──────
NO_ADVISORIES_KEY_AUDIT="$WS/no-advisories-key-audit.json"
printf '{"actions": [], "metadata": {"vulnerabilities": {"high": 3}}}' >"$NO_ADVISORIES_KEY_AUDIT"

assert_red "audit report with no 'advisories' key at all is a hard failure, not a silent 0-count green" \
  --contains "no \`advisories\` object" \
  --not-contains "OK: no unaccepted advisory" \
  -- node "$GUARD" "$NO_ADVISORIES_KEY_AUDIT" "$EMPTY_EXCEPTIONS"

# `advisories` present but the wrong TYPE (e.g. an array, or a string) must be
# caught the same way — the check is "is this the object shape we expect",
# not just "is the key present".
WRONG_TYPE_ADVISORIES_AUDIT="$WS/wrong-type-advisories-audit.json"
printf '{"advisories": ["not an object"]}' >"$WRONG_TYPE_ADVISORIES_AUDIT"

assert_red "audit report where 'advisories' is not an object is also a hard failure" \
  --contains "no \`advisories\` object" \
  -- node "$GUARD" "$WRONG_TYPE_ADVISORIES_AUDIT" "$EMPTY_EXCEPTIONS"

# ── Case: an advisory carries a severity string this guard does not know -> ──
# ── RED, never silently treated as the lowest (harmless) rank (MED-3) ────────
UNKNOWN_SEVERITY_AUDIT="$WS/unknown-severity-audit.json"
printf '{"advisories": {%s}}' \
  "$(one_advisory_json 3 mystery-pkg apocalyptic GHSA-zzzz-yyyy-xxxx)" \
  >"$UNKNOWN_SEVERITY_AUDIT"

assert_red "an advisory with an unrecognized severity string fails loud, not silently below-threshold" \
  --contains "severity string this guard does" \
  --contains "apocalyptic" \
  --contains "mystery-pkg" \
  -- node "$GUARD" "$UNKNOWN_SEVERITY_AUDIT" "$EMPTY_EXCEPTIONS"

# ── Cases: registry unreachable — retries, and gives up with a DISTINCT ──────
# ── message from "output shape unrecognized" (security-review PR #536 ────────
# ── round 3, MED-B; budget widened by task-audit-gate-tolerance, ────────────
# ── 2026-09-04 — 3 attempts -> 5, flat 5s delay -> growing 15/30/60/120s). ───
# ── These invoke the guard with NO fixture args, so it goes through the real ──
# ── `runRealAudit()` retry path — PNPM_AUDIT_CMD points that path at ────────
# ── fake-pnpm-audit.mjs (offline, deterministic) instead of a real network ──
# ── call. PNPM_AUDIT_RETRY_DELAY_MS shrinks the backoff from seconds to ─────
# ── milliseconds (uniformly) so this test suite stays fast. ─────────────────
FAKE_AUDIT="$SELF_DIR/lib/fake-pnpm-audit.mjs"

# A registry that is down for the first 2 attempts and recovers on the 3rd
# (well within the 5-attempt budget) must still succeed — retrying IS the
# point, not merely detecting failure.
RECOVERS_STATE="$WS/recovers-state"
assert_green "registry down for 2 attempts, recovers on the 3rd (within retry budget) -> still succeeds" \
  --contains "attempt 1/5" \
  --contains "attempt 2/5" \
  --contains "OK: no unaccepted advisory" \
  -- env "PNPM_AUDIT_CMD=node $FAKE_AUDIT --state-file $RECOVERS_STATE --fail-count 2" \
     "PNPM_AUDIT_RETRY_DELAY_MS=10" \
     node "$GUARD"

# A registry that is down for 4 attempts and only recovers on the 5th (the
# LAST attempt in the widened budget) must still succeed — this is the exact
# case the old 3-attempt budget could never have reached at all, and the
# reason task-audit-gate-tolerance widened it: a registry this slow used to
# be indistinguishable from a dead one.
RecoversLateState="$WS/recovers-late-state"
assert_green "registry down for 4 attempts, recovers on the 5th (last attempt of the widened budget) -> still succeeds" \
  --contains "attempt 1/5" \
  --contains "attempt 2/5" \
  --contains "attempt 3/5" \
  --contains "attempt 4/5" \
  --contains "OK: no unaccepted advisory" \
  -- env "PNPM_AUDIT_CMD=node $FAKE_AUDIT --state-file $RecoversLateState --fail-count 4" \
     "PNPM_AUDIT_RETRY_DELAY_MS=10" \
     node "$GUARD"

# A healthy registry on the very first attempt must NOT be retried at all —
# proves the retry loop does not waste time/attempts on the happy path.
HEALTHY_STATE="$WS/healthy-state"
assert_green "healthy registry on the first attempt is not retried at all" \
  --not-contains "attempt 1/5" \
  --contains "OK: no unaccepted advisory" \
  -- env "PNPM_AUDIT_CMD=node $FAKE_AUDIT --state-file $HEALTHY_STATE --fail-count 0" \
     "PNPM_AUDIT_RETRY_DELAY_MS=10" \
     node "$GUARD"

# A registry that never recovers must be given up on with the DISTINCT
# "could not reach" message — never the MED-2 "output shape unrecognized"
# wording, which means something different (got JSON, wrong shape).
DEAD_STATE="$WS/dead-state"
assert_red "registry never recovers -> gives up after the retry budget with the DISTINCT 'could not reach' message" \
  --contains "could not reach the package registry after 5 attempts" \
  --contains "NOT an unrecognized output shape" \
  --not-contains "no \`advisories\` object" \
  -- env "PNPM_AUDIT_CMD=node $FAKE_AUDIT --state-file $DEAD_STATE --always-fail" \
     "PNPM_AUDIT_RETRY_DELAY_MS=10" \
     node "$GUARD"

# ── Case: the DEFAULT (un-overridden) backoff actually GROWS across attempts ──
# ── — 15s, 30s, 60s, 120s — not the flat 5s this guard shipped with ─────────
# ── originally (task-audit-gate-tolerance, 2026-09-04). PNPM_AUDIT_RETRY_DELAY_MS ──
# ── is deliberately left UNSET here so the guard computes its REAL production ──
# ── delay values; PNPM_AUDIT_SKIP_SLEEP=1 skips actually waiting on them so ──
# ── this stays a fast, deterministic assertion on the log output instead of ──
# ── a ~3.75-minute sleep. ─────────────────────────────────────────────────────
GROWTH_STATE="$WS/growth-state"
assert_red "default (un-overridden) backoff grows 15000 -> 30000 -> 60000 -> 120000ms across the 5-attempt budget" \
  --contains "retrying in 15000ms" \
  --contains "retrying in 30000ms" \
  --contains "retrying in 60000ms" \
  --contains "retrying in 120000ms" \
  --contains "could not reach the package registry after 5 attempts" \
  -- env "PNPM_AUDIT_CMD=node $FAKE_AUDIT --state-file $GROWTH_STATE --always-fail" \
     "PNPM_AUDIT_SKIP_SLEEP=1" \
     node "$GUARD"

# ── Sanity: the REAL exceptions file this repo ships must itself be well-formed ──
# (every group has a real reason) — run against an empty audit so this case
# only exercises the exceptions-file validation, not the live `pnpm audit`
# network/lockfile dependency the harness explicitly avoids elsewhere.
REAL_EXCEPTIONS="$GUARD_DIR/pnpm-audit-exceptions.json"
assert_green "the real pnpm-audit-exceptions.json shipped in this repo is well-formed" \
  --not-contains "no (or too short a) reason" \
  -- node "$GUARD" "$CLEAN_AUDIT" "$REAL_EXCEPTIONS"

guard_test_summary "test-check-pnpm-audit.sh"
