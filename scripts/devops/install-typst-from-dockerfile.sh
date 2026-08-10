#!/usr/bin/env bash
# install-typst-from-dockerfile.sh — task-infra-typst-ci-and-resume-ddl, 2026-08-10.
#
# WHY THIS EXISTS: apps/api/src/test/typst-availability.ts (task-resume-template,
# PR #504) asserts loudly rather than skipping when the Typst binary is missing —
# "a suite that quietly does nothing when a tool is missing is the exact failure
# this project keeps paying for". That means the `quality` CI job needs a real
# Typst binary on PATH, and it needs to be the EXACT version apps/api/Dockerfile's
# `typst` build stage pins — résumé PDF determinism (AC1 in PR #504) depends on
# every environment (CI, prod, a developer's machine) rendering with the same
# build, since Typst does not guarantee stable glyph shaping/layout across
# versions.
#
# THE DRIFT PROBLEM, stated instead of assumed: a version + a SHA-256 checksum
# hardcoded a SECOND time in .github/workflows/ci.yml would be a second place
# that can go stale the moment someone bumps TYPST_VERSION in the Dockerfile and
# does not think to grep for the CI copy — exactly the class of incident this
# repo's other guards exist to catch after the fact (check-prod-ddl-wiring.py,
# check-ssh-action-capture-stdout-version.py). This script closes the gap a
# different way: instead of a second guard that COULD catch a mismatch, there is
# no second value to mismatch. This script PARSES apps/api/Dockerfile's `typst`
# stage at every CI run and installs exactly what it finds — version and
# checksum both. Bump the Dockerfile, and the next CI run installs the new
# version with no second edit anywhere. The single failure mode left is "the
# Dockerfile's own pin is wrong" (e.g. a hand-typed checksum typo) — and that is
# not a silent failure either: `sha256sum -c` on the real downloaded asset
# rejects a wrong checksum outright, in CI, on the very first PR that touches
# it (see the negative case in this script's test file).
#
# WHY BASH REGEX PARSING AND NOT A DOCKERFILE PARSER LIBRARY: the same pragmatic
# choice the project's other guards make (check-prod-ddl-wiring.py's header) —
# this repo's Dockerfile is hand-written in one consistent shape, and the two
# lines this script needs (`ARG TYPST_VERSION=...` and the `amd64)` case
# branch's `TYPST_TARGET=...` / `TYPST_SHA256=...` assignments) are simple
# enough that a real Dockerfile parser would be a heavier dependency for no
# extra correctness. If the Dockerfile's typst stage is ever restructured
# enough to break this parse, the script FAILS LOUDLY (see below) rather than
# falling back to a stale hardcoded default — a parse that quietly returned
# nothing would be the exact "silent drift" this script exists to prevent, one
# refactor away.
#
# ONLY amd64 IS PARSED: GitHub-hosted `ubuntu-latest` runners are x86_64. The
# Dockerfile's arm64 branch exists for Apple Silicon local `docker build`, which
# is out of scope for CI. If this ever runs on an arm64 runner, it fails loudly
# instead of silently installing the wrong architecture's binary (see the
# uname -m check below).
#
# USAGE
#   scripts/devops/install-typst-from-dockerfile.sh [install_dir]
#
#   install_dir defaults to a fresh `mktemp -d`. On success, the resolved
#   install directory containing the `typst` binary is printed as the ONLY line
#   on stdout — every other message goes to stderr — so a caller can do:
#
#     TYPST_DIR="$(scripts/devops/install-typst-from-dockerfile.sh "$HOME/.cache/crm-typst-bin")"
#     echo "$TYPST_DIR" >> "$GITHUB_PATH"
#
# Tests: scripts/devops/tests/test-install-typst-from-dockerfile.sh — positive
# case (valid Dockerfile + shimmed curl serving a real matching archive) AND
# negative cases (corrupted download caught by the checksum check; a Dockerfile
# missing the SHA256 line caught by the parse-loudly check).
set -eu

# ---------------------------------------------------------------------------
# Resolve repo root relative to this script's own location — works regardless
# of the caller's CWD (same convention as the check-*.py guards).
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DOCKERFILE="${TYPST_DOCKERFILE:-$REPO_ROOT/apps/api/Dockerfile}"

INSTALL_DIR="${1:-}"
if [ -z "$INSTALL_DIR" ]; then
  INSTALL_DIR="$(mktemp -d)"
fi

log() {
  echo "install-typst-from-dockerfile: $*" >&2
}

fail() {
  echo "::error::install-typst-from-dockerfile: $*" >&2
  exit 1
}

[ -f "$DOCKERFILE" ] || fail "Dockerfile not found at $DOCKERFILE"

# ---------------------------------------------------------------------------
# 1. Parse TYPST_VERSION — the `ARG TYPST_VERSION=<value>` line, exact pin
#    (never "latest" — that guarantee lives in the Dockerfile itself and this
#    script inherits it by construction, since it only ever reads that value).
# ---------------------------------------------------------------------------
TYPST_VERSION="$(grep -m1 -E '^ARG[[:space:]]+TYPST_VERSION=' "$DOCKERFILE" | sed -E 's/^ARG[[:space:]]+TYPST_VERSION=//' | tr -d '[:space:]')"
if [ -z "$TYPST_VERSION" ]; then
  fail "could not find 'ARG TYPST_VERSION=<version>' in $DOCKERFILE — the typst stage may have been restructured. Fix this script's parse, do not hardcode a version here."
fi
case "$TYPST_VERSION" in
  latest | LATEST)
    fail "Dockerfile pins TYPST_VERSION=$TYPST_VERSION — a floating version defeats the determinism this whole mechanism exists to protect (see apps/api/Dockerfile's own comment on why the pin is exact)."
    ;;
esac

# ---------------------------------------------------------------------------
# 2. Parse the amd64 case branch — TYPST_TARGET + TYPST_SHA256. Only amd64:
#    GitHub-hosted ubuntu-latest runners are x86_64.
# ---------------------------------------------------------------------------
UNAME_M="$(uname -m)"
case "$UNAME_M" in
  x86_64 | amd64) ;;
  *) fail "runner arch '$UNAME_M' is not amd64/x86_64 — this script only parses the Dockerfile's amd64 branch (GitHub-hosted ubuntu-latest is x86_64). Extend it deliberately if CI ever runs on arm64, do not assume the amd64 asset works there." ;;
esac

# Isolate the `amd64) ... ;;` block so a same-named variable elsewhere in the
# file (e.g. the arm64 branch) can never be picked up by accident. Stops at
# EITHER `;;` OR the start of the next case label (`arm64)`, `*)`, ...),
# whichever comes first — not just `;;` alone. A case branch that is missing
# its TYPST_SHA256 line entirely (as opposed to present-but-empty) has no `;;`
# of its own to stop at either, and a scan that only watched for `;;` would
# silently run on into the NEXT branch and pick up ITS checksum under the
# amd64 label — wrong value, no error, until the mismatched download is
# rejected downstream for a less specific reason. Stopping at the next label
# turns that into the same clean "TYPST_SHA256 did not parse" failure as an
# empty line (caught by the guard test's "no TYPST_SHA256 line at all" case).
AMD64_BLOCK="$(awk '
  /^[[:space:]]*amd64\)/ { flag=1; print; next }
  flag && /^[[:space:]]*(\*|[A-Za-z0-9_]+)\)/ { exit }
  flag { print }
  flag && /;;/ { exit }
' "$DOCKERFILE")"

if [ -z "$AMD64_BLOCK" ]; then
  fail "could not find the 'amd64)' case branch in $DOCKERFILE's typst stage — the case statement may have been restructured. Fix this script's parse, do not hardcode a target/checksum here."
fi

# `grep -oE` on a non-match prints nothing and exits 1 — `|| true` keeps that
# from tripping `set -e`, and the resulting empty string is exactly what the
# validation below needs to report a clean "<empty>" instead of echoing back
# a whole unparsed line (which a naive sed substitution does on no-match: it
# passes the input through unchanged).
TYPST_TARGET="$(printf '%s\n' "$AMD64_BLOCK" | grep -m1 'TYPST_TARGET=' | grep -oE '[A-Za-z0-9_.-]+-unknown-linux-[a-z]+' || true)"
TYPST_SHA256="$(printf '%s\n' "$AMD64_BLOCK" | grep -m1 'TYPST_SHA256=' | grep -oE '[0-9a-fA-F]{64}' || true)"

if [ -z "$TYPST_TARGET" ]; then
  fail "found the amd64 case branch but could not parse TYPST_TARGET= out of it. Fix this script's parse, do not hardcode a target here."
fi
if [ -z "$TYPST_SHA256" ]; then
  fail "found the amd64 case branch but TYPST_SHA256 did not parse to a 64-char hex digest. Fix this script's parse, do not hardcode a checksum here."
fi

log "Parsed from $DOCKERFILE: TYPST_VERSION=$TYPST_VERSION TYPST_TARGET=$TYPST_TARGET"

# xz-utils ships on GitHub-hosted ubuntu-latest runners by default (verified
# against actions/runner-images' own package manifest), but a stripped-down
# container (e.g. a local reproduction of this script) may not have it — GNU
# tar shells out to a separate `xz` binary for `.tar.xz`, unlike the Dockerfile's
# BusyBox tar (Alpine), which has xz support built in. Check explicitly so a
# missing tool fails with an actionable message instead of tar's own opaque
# "Cannot exec: No such file or directory".
command -v xz >/dev/null 2>&1 || fail "the 'xz' command is not on PATH — required to extract the .tar.xz release asset. GitHub-hosted ubuntu-latest runners ship xz-utils by default; install it explicitly if running this elsewhere (e.g. 'apt-get install -y xz-utils')."

# ---------------------------------------------------------------------------
# 3. Download + checksum-verify, exactly like the Dockerfile's own RUN step —
#    same source (GitHub Releases), same fail-closed `sha256sum -c`.
# ---------------------------------------------------------------------------
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ARCHIVE="typst-${TYPST_TARGET}.tar.xz"
URL="https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/${ARCHIVE}"

log "Downloading $URL"
curl -fsSL -o "$WORK/$ARCHIVE" "$URL" || fail "download failed: $URL"

log "Verifying checksum against the value pinned in $DOCKERFILE"
( cd "$WORK" && echo "${TYPST_SHA256}  ${ARCHIVE}" | sha256sum -c - ) \
  || fail "checksum mismatch — the downloaded $ARCHIVE does NOT match the SHA-256 pinned in $DOCKERFILE. Refusing to install an unverified binary. Either the release asset changed (should never happen for an already-published GitHub release) or the pin in the Dockerfile is wrong — do not silently proceed either way."

log "Checksum OK. Extracting."
tar -xJf "$WORK/$ARCHIVE" -C "$WORK" "typst-${TYPST_TARGET}/typst"

mkdir -p "$INSTALL_DIR"
mv "$WORK/typst-${TYPST_TARGET}/typst" "$INSTALL_DIR/typst"
chmod 755 "$INSTALL_DIR/typst"

INSTALLED_VERSION="$("$INSTALL_DIR/typst" --version 2>&1)" || fail "installed binary at $INSTALL_DIR/typst did not run: $INSTALLED_VERSION"
log "Installed: $INSTALLED_VERSION (from $INSTALL_DIR/typst)"

case "$INSTALLED_VERSION" in
  "typst $TYPST_VERSION"*) ;;
  *) fail "installed binary reports '$INSTALLED_VERSION', expected to start with 'typst $TYPST_VERSION' — this should be unreachable given the checksum just verified, but refusing to hand back a binary that disagrees with the pin it claims to be." ;;
esac

# Contract: the resolved install dir, and ONLY that, on stdout.
printf '%s\n' "$INSTALL_DIR"
