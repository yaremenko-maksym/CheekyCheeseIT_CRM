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
set -uo pipefail

MODE="${1:-}"
DIR="${2:-}"
ARCHIVES="${APT_ARCHIVES_DIR:-/var/cache/apt/archives}"
SUDO="${APT_SUDO-sudo}"

if [ -z "$MODE" ] || [ -z "$DIR" ]; then
  echo "::warning::apt-deb-cache.sh needs a mode (restore|save) and a directory — called with mode='${MODE}' dir='${DIR}'. Doing nothing; apt will download normally."
  exit 0
fi

# Count by listing, not by `ls | wc -l` on a glob that may not match: the count
# is evidence here (`.claude/rules/common/verification-integrity.md`), so it must
# distinguish "no files" from "could not read".
_count_debs() {
  local where="$1" n
  n="$(${SUDO} find "$where" -maxdepth 1 -name '*.deb' 2>&1 | grep -c '\.deb$' || true)"
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
_park_archive_cleanup_hooks() {
  local d="${APT_CONF_DIR:-/etc/apt/apt.conf.d}" f
  [ -d "$d" ] || return 0
  for f in $(grep -rl 'rm -f /var/cache/apt/archives' "$d" 2>&1 | grep -v '\.deb-cache-parked$' || true); do
    [ -f "$f" ] || continue
    if ${SUDO} mv "$f" "${f}.deb-cache-parked" 2>&1; then
      echo "apt .deb cache: parked ${f} (it deletes every .deb right after the install, which would leave nothing to cache)."
    else
      echo "::warning::apt .deb cache: ${f} deletes every .deb after the install and could not be parked — this run will probably have nothing to save."
    fi
  done
}

# GNU coreutils 9 prints "behavior of -n is non-portable" for a no-clobber copy,
# and `--update=none` does not exist on macOS, where the guard tests also run. So
# the skip is explicit: copy a file only when the destination does not have it.
_copy_new_debs() {
  local from="$1" to="$2" f base rc=0
  for f in "$from"/*.deb; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    [ -e "$to/$base" ] && continue
    ${SUDO} cp "$f" "$to/$base" 2>&1 || rc=1
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
  if ! _copy_new_debs "$DIR" "$ARCHIVES"; then
    echo "::warning::apt .deb cache: could not copy ${have} file(s) from ${DIR} into ${ARCHIVES} — apt will download them instead."
    exit 0
  fi
  echo "apt .deb cache: restored ${have} file(s) into ${ARCHIVES} (now $(_count_debs "$ARCHIVES") there). apt re-uses these without downloading; expect 'Need to get 0 B' when the set matches."
  ;;
save)
  have="$(_count_debs "$ARCHIVES")"
  if [ "$have" = "0" ]; then
    echo "::warning::apt .deb cache: nothing to save — ${ARCHIVES} holds no .deb. Either the install never downloaded (a cache hit, which is fine) or apt cleaned up."
    exit 0
  fi
  if ! mkdir -p "$DIR" 2>&1; then
    echo "::warning::apt .deb cache: could not create ${DIR} — this run seeds no cache."
    exit 0
  fi
  if ! _copy_new_debs "$ARCHIVES" "$DIR"; then
    echo "::warning::apt .deb cache: could not copy ${have} file(s) from ${ARCHIVES} into ${DIR} — this run seeds no cache."
    exit 0
  fi
  # The runner, not root, must own what actions/cache tars.
  ${SUDO} chown -R "$(id -u):$(id -g)" "$DIR" 2>&1 || true
  echo "apt .deb cache: staged $(_count_debs "$DIR") file(s) in ${DIR} for actions/cache."
  ;;
*)
  echo "::warning::apt-deb-cache.sh: unknown mode '${MODE}' (expected restore or save). Doing nothing; apt will download normally."
  exit 0
  ;;
esac
