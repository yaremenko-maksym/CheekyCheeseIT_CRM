#!/usr/bin/env bash
# Move apt's downloaded .deb files between /var/cache/apt/archives (root-owned)
# and a runner-owned directory that actions/cache can tar.
#
#   apt-deb-cache.sh restore <dir>   <dir>/*.deb  -> /var/cache/apt/archives
#   apt-deb-cache.sh save    <dir>   /var/cache/apt/archives/*.deb -> <dir>
#
# WHY: the webkit deps step fetches 125 MB of .debs, and on AWS-region runners
# the Ubuntu ec2 mirror serves them at ~100 KB/s (measured, job 134915543321;
# see prefer-official-apt-mirror.sh for the numbers). The same job restored a
# 177 MB actions/cache entry at 22-41 MB/s, so the cache is two orders of
# magnitude faster than the mirror. apt reuses a .deb already present in its
# archives directory without re-downloading it, which is the whole mechanism:
# a hit turns `Need to get 125 MB` into `Need to get 0 B`.
#
# WHY A SEPARATE DIRECTORY: /var/cache/apt/archives is root-owned and its
# `partial/` subdirectory is `drwx------ _apt:root`, so the unprivileged runner
# cannot tar it — actions/cache would fail on exactly that directory (the same
# permission wall that silently broke the first progress sampler).
#
# NEVER fails the caller: a missing directory, an empty one or a failed copy is
# a cache miss, i.e. a normal download, not a broken step.
#
# ONE EXCEPTION TO "never fails, never deletes" (security review SR-M-1): a
# restored .deb is attacker-controlled input as far as this step is concerned —
# it comes back from a cache entry keyed on data a PR can influence, and dpkg
# installs it as root without ever re-checking its hash, because apt only
# verifies what IT downloaded. A flipped byte at equal size was measured to
# reach dpkg with `Need to get 0 B`. So every restored file is checked against
# apt's own index before it is allowed near the archives directory, and
# ANYTHING unverifiable is DELETED rather than kept: the cost of deleting a
# good file is a download, the cost of keeping a bad one is root.
set -uo pipefail

MODE="${1:-}"
DIR="${2:-}"
ARCHIVES="${APT_ARCHIVES_DIR:-/var/cache/apt/archives}"
SUDO="${APT_SUDO-sudo}"
# The index side of the SR-M-1 verification. Injectable because the guard tests
# run on macOS too, where neither apt-cache nor sha256sum exists.
APT_SHOW_CMD="${APT_SHOW_CMD:-apt-cache show}"
# Resolved at use time (sha256sum on Linux, shasum -a 256 on macOS) unless the
# caller names one.
SHA256_CMD="${SHA256_CMD:-}"

if [ -z "$MODE" ] || [ -z "$DIR" ]; then
  echo "::warning::apt-deb-cache.sh needs a mode (restore|save) and a directory — called with mode='${MODE}' dir='${DIR}'. Doing nothing; apt will download normally."
  exit 0
fi

# Count by listing, not by `ls | wc -l` on a glob that may not match: the count
# is evidence here (`.claude/rules/common/verification-integrity.md`), so it must
# distinguish "no files" from "could not read".
#
# STDERR DOES NOT REACH THE COUNT (round 4 review BM-M-3 / SR-L-6). `find … 2>&1
# | grep -c` counted the error text's own lines, so an unreadable directory
# could report a positive number of .debs that are not there — form (A) of
# verification-integrity.md, a silence turned into a positive finding. The error
# channel is not discarded either (no `2>/dev/null`): it goes to the step log,
# where a reader needs it, while the count sees stdout alone.
_count_debs() {
  local where="$1" n out err
  err="$(mktemp)"
  out="$(${SUDO} find "$where" -maxdepth 1 -name '*.deb' 2>"$err")" || true
  if [ -s "$err" ]; then
    echo "::warning::apt .deb cache: listing ${where} wrote to stderr; the count that follows counts stdout only:" >&2
    cat "$err" >&2
  fi
  rm -f "$err"
  if [ -z "$out" ]; then
    n=0
  else
    n="$(printf '%s\n' "$out" | grep -c '\.deb$' || true)"
  fi
  printf '%s' "$n"
}

# A `DPkg::Post-Invoke { "rm -f /var/cache/apt/archives/*.deb" }` drop-in (the
# `docker-clean` file that ships in the ubuntu docker images) deletes every .deb
# the moment the install finishes, so `save` would find nothing to cache.
# Measured in ubuntu:24.04: with that file present the archives directory is
# empty after an install EVEN WITH `APT::Keep-Downloaded-Packages "true"` — the
# post-invoke hook wins, so the file is the only lever. Renamed, not deleted, and
# only when it matches; reported either way, because "we cached nothing and did
# not notice" is the failure mode this whole script exists to avoid.
# NO `for f in $(grep -rl …)` (round 4 review BM-M-2): that splits the result on
# every space, so a drop-in whose path contains one is opened as two paths that
# do not exist, silently parking nothing. `read -r` takes one line as one name.
# The error channel is kept out of the NAME list for the same reason the count
# above keeps it out of the number: a `grep: … Permission denied` line would
# otherwise be treated as a filename.
_park_archive_cleanup_hooks() {
  local d="${APT_CONF_DIR:-/etc/apt/apt.conf.d}" f list
  [ -d "$d" ] || return 0
  list="$(grep -rl 'rm -f /var/cache/apt/archives' "$d")" || list=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in *.deb-cache-parked) continue ;; esac
    [ -f "$f" ] || continue
    if ${SUDO} mv "$f" "${f}.deb-cache-parked"; then
      echo "apt .deb cache: parked ${f} (it deletes every .deb right after the install, which would leave nothing to cache). The 'save' mode puts it back."
    else
      echo "::warning::apt .deb cache: ${f} deletes every .deb after the install and could not be parked — this run will probably have nothing to save."
    fi
  done <<<"$list"
}

# THE RESTORE HALF (round 4 review CR-M-3a / SPEC-L-2 / DS-L-4). It belongs in
# `save`, NOT in an EXIT trap of `restore`: the hook has to stay parked across
# the install step, which is a different process entirely, or it deletes the
# .debs the moment the install ends and `save` finds nothing to cache — the
# exact failure this park exists to prevent. `save` is the job's own exit path
# for this cache (its workflow step runs under `always()`), so the runner never
# keeps a configuration change this script made.
_unpark_archive_cleanup_hooks() {
  local d="${APT_CONF_DIR:-/etc/apt/apt.conf.d}" f orig list
  [ -d "$d" ] || return 0
  list="$(find "$d" -maxdepth 1 -name '*.deb-cache-parked')" || list=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    orig="${f%.deb-cache-parked}"
    if ${SUDO} mv "$f" "$orig"; then
      echo "apt .deb cache: un-parked ${orig} — the runner's apt configuration is back to what the image shipped."
    else
      echo "::warning::apt .deb cache: could not un-park ${f} back to ${orig}. apt on this runner keeps one fewer cleanup hook for the rest of the job."
    fi
  done <<<"$list"
}

_resolve_sha256_cmd() {
  [ -n "$SHA256_CMD" ] && return 0
  if command -v sha256sum >/dev/null 2>&1; then
    SHA256_CMD="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    SHA256_CMD="shasum -a 256"
  fi
}

# The SHA256 apt's own index records for exactly this package version, or
# nothing. Nothing is a VERDICT here, not an absence: the caller deletes.
_index_sha256() {
  local pkg="$1" ver="$2" out
  # shellcheck disable=SC2086  # APT_SHOW_CMD is a command line, not a path
  out="$(${APT_SHOW_CMD} "${pkg}=${ver}" 2>&1)" || true
  printf '%s\n' "$out" | sed -n 's/^SHA256: *\([0-9a-fA-F]\{64\}\).*/\1/p' | head -1
}

# Delete every restored .deb that apt's index does not vouch for (SR-M-1).
#
# Runs in the RUNNER-OWNED cache directory, before anything is copied into
# root-owned archives: a delete here needs no sudo, and nothing unverified ever
# reaches the directory dpkg installs from. apt re-fetches whatever is missing,
# so the worst outcome of a wrong delete is a download.
#
# `<pkg>_<version>_<arch>.deb` is apt's own archive naming; the epoch colon is
# URL-encoded as `%3a`, so `1%3a2.4-1` is the index's `1:2.4-1`.
_verify_cached_debs() {
  local dir="$1" f base pkg ver want got verified=0 deleted=0 shown=0
  _resolve_sha256_cmd
  if [ -z "$SHA256_CMD" ]; then
    rm -f "$dir"/*.deb
    echo "::warning::apt .deb cache: no sha256 tool (sha256sum or shasum) on this runner, so no restored .deb can be checked against apt's index. All of them were DELETED rather than installed unverified (security review SR-M-1); apt downloads them normally this run."
    return 0
  fi
  for f in "$dir"/*.deb; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    want=""
    case "$base" in
      *_*_*.deb)
        pkg="${base%%_*}"
        ver="${base#*_}"
        ver="${ver%_*}"
        ver="$(printf '%s' "$ver" | sed 's/%3[aA]/:/g')"
        want="$(_index_sha256 "$pkg" "$ver")"
        ;;
      *) ;;
    esac
    got="$(${SHA256_CMD} "$f" | awk '{print $1}')"
    if [ -n "$want" ] && [ "$want" = "$got" ]; then
      verified=$((verified + 1))
      continue
    fi
    rm -f "$f"
    deleted=$((deleted + 1))
    if [ "$shown" -lt 5 ]; then
      shown=$((shown + 1))
      if [ -z "$want" ]; then
        echo "apt .deb cache: deleted ${base} — apt's index has no SHA256 for it (unknown package, a version the index has moved past, or a name that is not apt's <pkg>_<version>_<arch>.deb). Unverifiable is treated as bad."
      else
        echo "::warning::apt .deb cache: deleted ${base} — its SHA256 does NOT match apt's index (index ${want}, file ${got}). A cached .deb that differs from the index is exactly what SR-M-1 is about; apt will fetch this one itself."
      fi
    fi
  done
  [ "$deleted" -gt 5 ] && echo "apt .deb cache: ${deleted} deletions in total; the first 5 are named above."
  echo "apt .deb cache: verified ${verified} file(s) against apt's index, deleted ${deleted}."
}

# GNU coreutils 9 prints "behavior of -n is non-portable" for a no-clobber copy,
# and `--update=none` does not exist on macOS, where the guard tests also run. So
# the skip is explicit — but the skip COMPARES (round 4 review BM-M-1). Same
# basename is not same file: a destination copy that is stale or was truncated
# mid-write by an earlier run's kill would otherwise be kept, and apt would
# install it without ever re-downloading. `cmp -s` is the byte answer; the
# alternative (size) is exactly what the measured SR-M-1 tamper defeats.
_copy_new_debs() {
  local from="$1" to="$2" f base rc=0
  for f in "$from"/*.deb; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    if [ -e "$to/$base" ] && cmp -s "$f" "$to/$base"; then
      continue
    fi
    ${SUDO} cp "$f" "$to/$base" || rc=1
  done
  return "$rc"
}

case "$MODE" in
restore)
  _park_archive_cleanup_hooks
  if [ ! -d "$DIR" ]; then
    echo "apt .deb cache: miss — ${DIR} does not exist. apt will download this run."
    exit 0
  fi
  have="$(_count_debs "$DIR")"
  if [ "$have" = "0" ]; then
    echo "apt .deb cache: miss — ${DIR} holds no .deb. apt will download this run."
    exit 0
  fi
  # Before the copy, never after: see _verify_cached_debs (SR-M-1).
  _verify_cached_debs "$DIR"
  have="$(_count_debs "$DIR")"
  if [ "$have" = "0" ]; then
    echo "apt .deb cache: miss — every cached .deb in ${DIR} failed the index check and was deleted, so none were restored. apt will download this run."
    exit 0
  fi
  if ! _copy_new_debs "$DIR" "$ARCHIVES"; then
    echo "::warning::apt .deb cache: could not copy ${have} file(s) from ${DIR} into ${ARCHIVES} — apt will download them instead."
    exit 0
  fi
  echo "apt .deb cache: restored ${have} file(s) into ${ARCHIVES} (now $(_count_debs "$ARCHIVES") there). apt re-uses these without downloading; expect 'Need to get 0 B' when the set matches."
  ;;
save)
  # FIRST, so that every exit path below is already past it: the install step is
  # over by the time `save` runs, so the parked cleanup hook has nothing left to
  # protect and the runner gets its own apt configuration back whatever else
  # this mode decides (CR-M-3a).
  _unpark_archive_cleanup_hooks
  have="$(_count_debs "$ARCHIVES")"
  if [ "$have" = "0" ]; then
    echo "::warning::apt .deb cache: nothing to save — ${ARCHIVES} holds no .deb. Either the install never downloaded (a cache hit, which is fine) or apt cleaned up."
    exit 0
  fi
  if ! mkdir -p "$DIR"; then
    echo "::warning::apt .deb cache: could not create ${DIR} — this run seeds no cache."
    exit 0
  fi
  if ! _copy_new_debs "$ARCHIVES" "$DIR"; then
    echo "::warning::apt .deb cache: could not copy ${have} file(s) from ${ARCHIVES} into ${DIR} — this run seeds no cache."
    exit 0
  fi
  # The runner, not root, must own what actions/cache tars.
  ${SUDO} chown -R "$(id -u):$(id -g)" "$DIR" || true
  echo "apt .deb cache: staged $(_count_debs "$DIR") file(s) in ${DIR} for actions/cache."
  ;;
*)
  echo "::warning::apt-deb-cache.sh: unknown mode '${MODE}' (expected restore or save). Doing nothing; apt will download normally."
  exit 0
  ;;
esac
