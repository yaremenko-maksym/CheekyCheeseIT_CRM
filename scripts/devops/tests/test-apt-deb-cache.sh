#!/usr/bin/env bash
# Guard test for scripts/devops/apt-deb-cache.sh.
#
# Same STDOUT contract as the mirror script: it must never fail the step, so the
# negative cases are `assert_red_signal` — a miss, a bad argument or a failed
# copy has to SAY so on exit 0. The shape that must never appear is a line
# claiming files were restored when none were: the step after it would then read
# `Need to get 125 MB` and nobody would know why.
#
# THE ONE PLACE THIS SCRIPT IS ALLOWED TO DESTROY SOMETHING is the SR-M-1 index
# check, and the cases below pin both halves of it: a file apt's index vouches
# for survives, and a file it does not is DELETED rather than handed to dpkg.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

SUBJECT="$GUARD_DIR/apt-deb-cache.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A fake apt index: one line per package version it knows, `pkg=ver <sha256>`.
# Stands in for `apt-cache show`, which does not exist on macOS and on Linux
# would answer about the HOST's packages. Rewritten per case.
FAKE_INDEX="$WORK/fake-index"
: > "$FAKE_INDEX"
cat > "$WORK/fake-apt-cache" << 'FAKE'
#!/usr/bin/env bash
# argv: show <pkg>=<ver>
want="${2:-}"
while IFS=' ' read -r spec sha; do
  [ -n "$spec" ] || continue
  if [ "$spec" = "$want" ]; then
    echo "Package: ${spec%%=*}"
    echo "SHA256: ${sha}"
    exit 0
  fi
done < "$FAKE_INDEX"
echo "N: Unable to locate package ${want}" >&2
exit 100
FAKE
chmod +x "$WORK/fake-apt-cache"

# A `sudo` that writes an unrelated line to STDERR before doing its job, used to
# prove the .deb COUNT cannot be inflated by the error channel (BM-M-3).
cat > "$WORK/noisy-sudo" << 'NOISY'
#!/usr/bin/env bash
echo "/tmp/ghost-from-stderr.deb" >&2
exec "$@"
NOISY
chmod +x "$WORK/noisy-sudo"

# Hash the way the subject does, so a case states the EXPECTED sha of a file it
# just wrote instead of hardcoding one.
sha_of() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# APT_SUDO empty (set, not unset) so the subject runs unprivileged;
# APT_ARCHIVES_DIR replaces /var/cache/apt/archives; APT_SHOW_CMD replaces
# apt-cache; APT_CONF_DIR replaces /etc/apt/apt.conf.d so that no case can touch
# the real one (CR-M-3a / SPEC-L-2 / DS-L-4 — the earlier suite left it unset,
# so the park path was never exercised at all).
mkdir -p "$WORK/apt.conf.d-empty"
run_subject() {
  local archives="$1"
  shift
  # SHA256_CMD empty = let the subject resolve sha256sum/shasum itself, which is
  # the production path; a case that names one is testing the hash side.
  APT_SUDO="${APT_SUDO_FOR_CASE-}" APT_ARCHIVES_DIR="$archives" \
    APT_CONF_DIR="${APT_CONF_DIR_FOR_CASE:-$WORK/apt.conf.d-empty}" \
    FAKE_INDEX="$FAKE_INDEX" APT_SHOW_CMD="$WORK/fake-apt-cache show" \
    SHA256_CMD="${SHA256_CMD_FOR_CASE-}" \
    bash "$SUBJECT" "$@"
}

# ── 1. restore: a populated, index-vouched cache lands in apt's archives ─────
mkdir -p "$WORK/cache-hit" "$WORK/archives-empty"
echo "foo-payload" > "$WORK/cache-hit/libfoo_1.0_amd64.deb"
echo "bar-payload" > "$WORK/cache-hit/libbar_2.0_amd64.deb"
{
  echo "libfoo=1.0 $(sha_of "$WORK/cache-hit/libfoo_1.0_amd64.deb")"
  echo "libbar=2.0 $(sha_of "$WORK/cache-hit/libbar_2.0_amd64.deb")"
} > "$FAKE_INDEX"
assert_green "restore copies the index-vouched .debs into apt's archives and reports how many" \
  --contains "verified 2 file(s) against apt's index, deleted 0" \
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

# ── 3. SR-M-1: a tampered .deb is DELETED, not restored ─────────────────────
# The measured shape: one flipped byte, so apt's `Need to get 0 B` path would
# hand dpkg a file the index does not describe.
mkdir -p "$WORK/cache-tampered" "$WORK/archives-t"
echo "good-payload" > "$WORK/cache-tampered/libgood_1.0_amd64.deb"
echo "evil-payload" > "$WORK/cache-tampered/libevil_1.0_amd64.deb"
{
  echo "libgood=1.0 $(sha_of "$WORK/cache-tampered/libgood_1.0_amd64.deb")"
  # The index describes a DIFFERENT byte sequence for libevil than the file has.
  echo "libevil=1.0 0000000000000000000000000000000000000000000000000000000000000000"
} > "$FAKE_INDEX"
assert_red_signal "a cached .deb whose SHA256 differs from apt's index is deleted and named, never restored (SR-M-1)" \
  --contains "::warning::" \
  --contains "deleted libevil_1.0_amd64.deb" \
  --contains "does NOT match apt's index" \
  --contains "verified 1 file(s) against apt's index, deleted 1" \
  --contains "restored 1 file(s)" \
  -- run_subject "$WORK/archives-t" restore "$WORK/cache-tampered"

assert_green "the tampered file reached neither the cache directory nor apt's archives" \
  --contains "libgood_1.0_amd64.deb" \
  --not-contains "libevil" \
  -- ls "$WORK/archives-t" "$WORK/cache-tampered"

# ── 4. nothing survives the check -> a named miss, not a claimed restore ────
mkdir -p "$WORK/cache-unknown" "$WORK/archives-u"
echo "payload" > "$WORK/cache-unknown/libnotinindex_9.9_amd64.deb"
: > "$FAKE_INDEX"
assert_red_signal "a .deb apt's index has no SHA256 for is deleted, and the restore reports a miss" \
  --contains "has no SHA256 for it" \
  --contains "verified 0 file(s) against apt's index, deleted 1" \
  --contains "failed the index check and was deleted" \
  --not-contains "restored 1 file(s)" \
  -- run_subject "$WORK/archives-u" restore "$WORK/cache-unknown"

# ── 5. the epoch colon is %3a in apt's archive names ────────────────────────
mkdir -p "$WORK/cache-epoch" "$WORK/archives-e"
echo "epoch-payload" > "$WORK/cache-epoch/libepoch_1%3a2.4-1_amd64.deb"
echo "libepoch=1:2.4-1 $(sha_of "$WORK/cache-epoch/libepoch_1%3a2.4-1_amd64.deb")" > "$FAKE_INDEX"
assert_green "a %3a-encoded epoch in the filename is asked of the index as a colon" \
  --contains "verified 1 file(s) against apt's index, deleted 0" \
  --contains "restored 1 file(s)" \
  --not-contains "::warning::" \
  -- run_subject "$WORK/archives-e" restore "$WORK/cache-epoch"

# ── 6. fail CLOSED: no usable hash answer deletes the file, never keeps it ──
mkdir -p "$WORK/cache-nohash" "$WORK/archives-nh"
echo "payload" > "$WORK/cache-nohash/libfoo_1.0_amd64.deb"
echo "libfoo=1.0 $(sha_of "$WORK/cache-nohash/libfoo_1.0_amd64.deb")" > "$FAKE_INDEX"
SHA256_CMD_FOR_CASE="$WORK/no-such-hasher"
assert_red_signal "a hash tool that cannot answer deletes the .deb (fail closed), it does not pass it through" \
  --contains "verified 0 file(s) against apt's index, deleted 1" \
  --contains "failed the index check and was deleted" \
  -- run_subject "$WORK/archives-nh" restore "$WORK/cache-nohash"
unset SHA256_CMD_FOR_CASE

# ── 7. BM-M-1: same basename, different bytes is NOT skipped ────────────────
mkdir -p "$WORK/cache-same" "$WORK/archives-stale"
echo "fresh-payload" > "$WORK/cache-same/libsame_1.0_amd64.deb"
echo "stale-truncated" > "$WORK/archives-stale/libsame_1.0_amd64.deb"
echo "libsame=1.0 $(sha_of "$WORK/cache-same/libsame_1.0_amd64.deb")" > "$FAKE_INDEX"
assert_green "restore overwrites a same-named but DIFFERENT file in the archives instead of keeping the stale one" \
  --contains "restored 1 file(s)" \
  --not-contains "::warning::" \
  -- run_subject "$WORK/archives-stale" restore "$WORK/cache-same"

assert_green "the archives copy now holds the cache's bytes, not the stale ones" \
  --contains "fresh-payload" \
  --not-contains "stale-truncated" \
  -- cat "$WORK/archives-stale/libsame_1.0_amd64.deb"

# ── 8. save: what apt downloaded is staged for actions/cache ────────────────
mkdir -p "$WORK/archives-full"
: > "$WORK/archives-full/libbaz_3.0_amd64.deb"
assert_green "save stages apt's downloaded .debs in the cache directory and counts them" \
  --contains "staged 1 file(s)" \
  --not-contains "::warning::" \
  -- run_subject "$WORK/archives-full" save "$WORK/cache-out"

assert_green "the staged file exists in the cache directory" \
  --contains "libbaz_3.0_amd64.deb" \
  -- ls "$WORK/cache-out"

# ── 9. save with nothing to save (the cache-HIT run) ───────────────────────
mkdir -p "$WORK/archives-none"
assert_red_signal "save with no .deb in apt's archives warns instead of seeding an empty cache entry" \
  --contains "::warning::" \
  --contains "nothing to save" \
  --not-contains "staged" \
  -- run_subject "$WORK/archives-none" save "$WORK/cache-out2"

# ── 10. the cleanup-hook park, and its restore in `save` (CR-M-3a) ──────────
# The park must SURVIVE restore (the install step runs in between, in its own
# process) and be undone by save, which the workflow runs under always().
APT_CONF_DIR_FOR_CASE="$WORK/apt.conf.d-park"
mkdir -p "$APT_CONF_DIR_FOR_CASE"
printf 'DPkg::Post-Invoke { "rm -f /var/cache/apt/archives/*.deb"; };\n' \
  > "$APT_CONF_DIR_FOR_CASE/docker-clean"
# A second drop-in WITH A SPACE in its name: `for f in $(grep -rl …)` split that
# into two non-existent paths and parked neither (BM-M-2).
printf 'DPkg::Post-Invoke { "rm -f /var/cache/apt/archives/*.deb"; };\n' \
  > "$APT_CONF_DIR_FOR_CASE/99 local clean"
mkdir -p "$WORK/cache-park" "$WORK/archives-park"
echo "park-payload" > "$WORK/cache-park/libpark_1.0_amd64.deb"
echo "libpark=1.0 $(sha_of "$WORK/cache-park/libpark_1.0_amd64.deb")" > "$FAKE_INDEX"
assert_green "restore parks every drop-in that would delete the .debs, including one whose name has a space" \
  --contains "parked ${APT_CONF_DIR_FOR_CASE}/docker-clean" \
  --contains "parked ${APT_CONF_DIR_FOR_CASE}/99 local clean" \
  -- run_subject "$WORK/archives-park" restore "$WORK/cache-park"

assert_green "the parked names are what is on disk after restore — the originals are gone" \
  --contains "docker-clean.deb-cache-parked" \
  --contains "99 local clean.deb-cache-parked" \
  -- ls "$APT_CONF_DIR_FOR_CASE"

assert_green "save puts both drop-ins back under their original names" \
  --contains "un-parked ${APT_CONF_DIR_FOR_CASE}/docker-clean" \
  --contains "un-parked ${APT_CONF_DIR_FOR_CASE}/99 local clean" \
  -- run_subject "$WORK/archives-park" save "$WORK/cache-park-out"

assert_contract "apt.conf.d is byte-for-byte what it was before the park (no .deb-cache-parked left)" \
  --contains "docker-clean" \
  --contains "99 local clean" \
  --not-contains "deb-cache-parked" \
  -- ls "$APT_CONF_DIR_FOR_CASE"
unset APT_CONF_DIR_FOR_CASE

# ── 11. BM-M-3: the error channel cannot inflate the .deb count ─────────────
mkdir -p "$WORK/cache-noisy" "$WORK/archives-noisy"
echo "noisy-payload" > "$WORK/cache-noisy/libnoisy_1.0_amd64.deb"
echo "libnoisy=1.0 $(sha_of "$WORK/cache-noisy/libnoisy_1.0_amd64.deb")" > "$FAKE_INDEX"
APT_SUDO_FOR_CASE="$WORK/noisy-sudo"
assert_red_signal "a line on stderr that looks like a .deb path is reported, and does NOT become part of the count" \
  --contains "wrote to stderr" \
  --contains "ghost-from-stderr.deb" \
  --contains "restored 1 file(s)" \
  --not-contains "restored 2 file(s)" \
  -- run_subject "$WORK/archives-noisy" restore "$WORK/cache-noisy"
unset APT_SUDO_FOR_CASE

# ── 12. bad invocations are warnings, never failures of the CI step ─────────
assert_red_signal "an unknown mode is a warning and a no-op" \
  --contains "::warning::" \
  --contains "unknown mode" \
  -- run_subject "$WORK/archives-full" frobnicate "$WORK/cache-out"

assert_red_signal "a missing directory argument is a warning and a no-op" \
  --contains "::warning::" \
  --contains "needs a mode" \
  -- run_subject "$WORK/archives-full" restore

guard_test_summary "test-apt-deb-cache.sh"
