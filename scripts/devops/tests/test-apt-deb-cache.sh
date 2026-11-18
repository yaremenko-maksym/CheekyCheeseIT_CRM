#!/usr/bin/env bash
# Guard test for scripts/devops/apt-deb-cache.sh.
#
# Same STDOUT contract as the mirror script: it must never fail the step, so the
# negative cases are `assert_red_signal` — a miss, a bad argument or a failed
# copy has to SAY so on exit 0. The shape that must never appear is a line
# claiming files were restored when none were: the step after it would then read
# `Need to get 125 MB` and nobody would know why.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

SUBJECT="$GUARD_DIR/apt-deb-cache.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# APT_SUDO empty (set, not unset) so the subject runs unprivileged;
# APT_ARCHIVES_DIR replaces /var/cache/apt/archives.
run_subject() {
  local archives="$1"
  shift
  APT_SUDO="" APT_ARCHIVES_DIR="$archives" bash "$SUBJECT" "$@"
}

# ── 1. restore: a populated cache lands in apt's archives, with the COUNT ────
mkdir -p "$WORK/cache-hit" "$WORK/archives-empty"
: > "$WORK/cache-hit/libfoo_1.0_amd64.deb"
: > "$WORK/cache-hit/libbar_2.0_amd64.deb"
assert_green "restore copies the cached .debs into apt's archives and reports how many" \
  --contains "restored 2 file(s)" \
  --contains "now 2 there" \
  --not-contains "::warning::" \
  -- run_subject "$WORK/archives-empty" restore "$WORK/cache-hit"

assert_green "the .debs really are in apt's archives afterwards (the artifact, not the claim)" \
  --contains "libfoo_1.0_amd64.deb" \
  --contains "libbar_2.0_amd64.deb" \
  -- ls "$WORK/archives-empty"

# ── 2. restore misses ───────────────────────────────────────────────────────
assert_red_signal "restore from a directory that does not exist is a named MISS, never a claimed restore" \
  --contains "miss" \
  --contains "does not exist" \
  --not-contains "restored" \
  -- run_subject "$WORK/archives-empty" restore "$WORK/no-such-cache"

mkdir -p "$WORK/cache-empty"
assert_red_signal "restore from an empty directory is a named MISS, not 'restored 0 file(s)'" \
  --contains "miss" \
  --contains "holds no .deb" \
  --not-contains "restored" \
  -- run_subject "$WORK/archives-empty" restore "$WORK/cache-empty"

# ── 3. save: what apt downloaded is staged for actions/cache ────────────────
mkdir -p "$WORK/archives-full"
: > "$WORK/archives-full/libbaz_3.0_amd64.deb"
assert_green "save stages apt's downloaded .debs in the cache directory and counts them" \
  --contains "staged 1 file(s)" \
  --not-contains "::warning::" \
  -- run_subject "$WORK/archives-full" save "$WORK/cache-out"

assert_green "the staged file exists in the cache directory" \
  --contains "libbaz_3.0_amd64.deb" \
  -- ls "$WORK/cache-out"

# ── 4. save with nothing to save (the cache-HIT run) ───────────────────────
mkdir -p "$WORK/archives-none"
assert_red_signal "save with no .deb in apt's archives warns instead of seeding an empty cache entry" \
  --contains "::warning::" \
  --contains "nothing to save" \
  --not-contains "staged" \
  -- run_subject "$WORK/archives-none" save "$WORK/cache-out2"

# ── 5. bad invocations are warnings, never failures of the CI step ──────────
assert_red_signal "an unknown mode is a warning and a no-op" \
  --contains "::warning::" \
  --contains "unknown mode" \
  -- run_subject "$WORK/archives-full" frobnicate "$WORK/cache-out"

assert_red_signal "a missing directory argument is a warning and a no-op" \
  --contains "::warning::" \
  --contains "needs a mode" \
  -- run_subject "$WORK/archives-full" restore

guard_test_summary "test-apt-deb-cache.sh"
