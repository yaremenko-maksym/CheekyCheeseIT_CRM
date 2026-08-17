#!/usr/bin/env bash
# fake-freshness-check.sh — stub for check-cloudflare-ips-freshness.sh, used
# ONLY by test-cloudflare-ips-watch.sh to test cloudflare-ips-watch.sh's own
# classification/framing logic in ISOLATION from the real sub-check's
# fetch/format/count-floor guarantees (those are tested independently, and
# thoroughly, by test-check-cloudflare-ips-freshness.sh).
#
# WHY THIS EXISTS (security review PR #557, HIGH follow-up, 2026-08-18): the
# real sub-check's count-floor guard (closing the HIGH finding) makes a PURE
# single-direction removal — REMOVED_COUNT>0 with ADDED_COUNT=0, i.e. the
# exact shape cloudflare-ips-watch.sh's "cleanup" severity framing exists
# for — structurally unable to reach FRESH_RC=1 through the real fetch path
# ever again (a pure removal, by definition, means the repo's count for that
# family is now HIGHER than live's, which is exactly what the count-floor
# guard refuses to trust). That is the CORRECT behavior for the guard — see
# check-cloudflare-ips-freshness.sh's own header — but it means the
# watcher's cleanup-framing code can no longer be exercised end-to-end
# through the real chain, only through a controlled substitute that hands
# back a FRESH_RC=1 with a pre-decided added/removed split, same idea as
# lib/fake-gh.sh substituting `gh` for check-required-checks-complete.sh.
#
# Driven entirely by env vars, never by argv, matching this repo's other
# fakes:
#   FAKE_ADDED    newline-separated CIDRs to write to $ADDED_OUT (default: empty)
#   FAKE_REMOVED  newline-separated CIDRs to write to $REMOVED_OUT (default: empty)
#   FAKE_RC       exit code to return (default: 1 — "drifted")
set -u

if [ -n "${ADDED_OUT:-}" ]; then
  printf '%s' "${FAKE_ADDED:-}" >"$ADDED_OUT"
  # Ensure a trailing newline if non-empty content was given without one —
  # matches what the real script's `sort -u` output always guarantees, so
  # the watcher's own line-counting (grep -c '^') sees the same shape.
  [ -n "${FAKE_ADDED:-}" ] && printf '\n' >>"$ADDED_OUT"
fi
if [ -n "${REMOVED_OUT:-}" ]; then
  printf '%s' "${FAKE_REMOVED:-}" >"$REMOVED_OUT"
  [ -n "${FAKE_REMOVED:-}" ] && printf '\n' >>"$REMOVED_OUT"
fi

echo "[fake-freshness-check] FAKE_RC=${FAKE_RC:-1}"
exit "${FAKE_RC:-1}"
