#!/usr/bin/env bash
# test-install-typst-from-dockerfile.sh — proves
# scripts/devops/install-typst-from-dockerfile.sh (task-infra-typst-ci-and-resume-ddl,
# 2026-08-10) actually derives version + checksum from apps/api/Dockerfile instead of
# carrying its own copy, and REFUSES to install when either half of that contract
# breaks: a corrupted/mismatched download, or a Dockerfile whose typst stage no
# longer parses the way this script expects.
#
# `curl` is replaced by a PATH shim serving a REAL, locally-built .tar.xz fixture
# (built once below with `tar`/`xz` — the same tools the script itself needs, so a
# machine that can run this test can also run the script for real). This is the
# same reasoning as test-check-cloudflare-ips-freshness.sh's curl shim: a test that
# needed the real github.com/typst/typst release to be reachable would be a network
# flake generator, and could not exercise the "download does not match the pin"
# branch on demand. The fixture "typst" binary is a tiny shell script that prints a
# fabricated version string — the script under test only cares that SOMETHING
# executable answers `--version` with a string starting "typst <pinned-version>",
# and proving that check works is the point of the first negative case below.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

SCRIPT_UNDER_TEST="$GUARD_DIR/install-typst-from-dockerfile.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

FAKE_TARGET="x86_64-unknown-linux-musl"
FAKE_VERSION="9.9.9"

# ── build ONE real, valid .tar.xz fixture (tools: tar + xz, same as the script
#    under test needs at runtime) ──────────────────────────────────────────────
build_fixture_archive() {
  local out_tar="$1" version="$2"
  local build_dir
  build_dir="$(mktemp -d "$WS/build-XXXXXX")"
  mkdir -p "$build_dir/typst-${FAKE_TARGET}"
  cat >"$build_dir/typst-${FAKE_TARGET}/typst" <<EOF
#!/bin/sh
echo "typst ${version} (fixture)"
EOF
  chmod +x "$build_dir/typst-${FAKE_TARGET}/typst"
  ( cd "$build_dir" && tar -cJf "$out_tar" "typst-${FAKE_TARGET}/typst" )
}

GOOD_ARCHIVE="$WS/typst-good.tar.xz"
build_fixture_archive "$GOOD_ARCHIVE" "$FAKE_VERSION"
GOOD_SHA256="$(sha256sum "$GOOD_ARCHIVE" | awk '{print $1}')"

# A second, DIFFERENT archive (fixture "server" returns this while the pin in the
# Dockerfile fixture still names GOOD_SHA256) — simulates a corrupted transfer OR
# a stale/wrong pin. Either way the checksum step must refuse it.
BAD_ARCHIVE="$WS/typst-bad.tar.xz"
build_fixture_archive "$BAD_ARCHIVE" "0.0.0-corrupted"

# ── curl shim — understands just enough of the script's invocation:
#    `curl -fsSL -o <path> <url>` ────────────────────────────────────────────────
read -r -d '' SHIM_BODY <<'SHIM' || true
#!/bin/sh
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
cat "$SHIM_SERVE" >"$out"
SHIM
guard_test_shim "$WS" curl "$SHIM_BODY"

# ── Dockerfile fixture builder — mirrors the real apps/api/Dockerfile's typst
#    stage shape exactly (task-infra-typst-ci-and-resume-ddl's own script parses
#    THIS shape, so the fixture must too, or the test would validate a parser
#    that does not exist). $1 = amd64 sha line body (empty string -> line dropped
#    entirely, to prove the "no line at all" case is caught the same as "line
#    present but empty").
# ─────────────────────────────────────────────────────────────────────────────
write_dockerfile() {
  local path="$1" version="$2" sha="$3"
  {
    echo 'FROM node:20-alpine AS typst'
    echo "ARG TYPST_VERSION=${version}"
    echo 'ARG TARGETARCH'
    echo 'RUN set -eu; \'
    echo '  case "$TARGETARCH" in \'
    echo '    amd64) \'
    echo "      TYPST_TARGET=${FAKE_TARGET}; \\"
    if [ -n "$sha" ]; then
      echo "      TYPST_SHA256=${sha} ;; \\"
    fi
    echo '    arm64) \'
    echo '      TYPST_TARGET=aarch64-unknown-linux-musl; \'
    echo '      TYPST_SHA256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef ;; \'
    echo '    *) \'
    echo '      echo "unsupported" >&2; exit 1 ;; \'
    echo '  esac'
  } >"$path"
}

DF_GOOD="$WS/Dockerfile.good"
write_dockerfile "$DF_GOOD" "$FAKE_VERSION" "$GOOD_SHA256"

DF_MISSING_LINE="$WS/Dockerfile.missing-line"
write_dockerfile "$DF_MISSING_LINE" "$FAKE_VERSION" ""

DF_NO_VERSION="$WS/Dockerfile.no-version"
{
  echo 'FROM node:20-alpine AS typst'
  echo 'ARG TARGETARCH'
} >"$DF_NO_VERSION"

run_installer() {
  local dockerfile="$1" serve="$2" install_dir="$3"
  PATH="$WS/bin:$PATH" TYPST_DOCKERFILE="$dockerfile" SHIM_SERVE="$serve" \
    bash "$SCRIPT_UNDER_TEST" "$install_dir"
}

echo "== test-install-typst-from-dockerfile.sh =="
echo

# ── positive ─────────────────────────────────────────────────────────────────
OUT_DIR="$WS/install-good"
assert_green "valid Dockerfile + matching checksum -> installs and prints the install dir" \
  --contains "$OUT_DIR" \
  -- run_installer "$DF_GOOD" "$GOOD_ARCHIVE" "$OUT_DIR"

if [ -x "$OUT_DIR/typst" ]; then
  INSTALLED="$("$OUT_DIR/typst" --version)"
  case "$INSTALLED" in
    "typst $FAKE_VERSION"*)
      echo "PASS  [confirm] installed binary reports the pinned version ($INSTALLED)"
      GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
      ;;
    *)
      echo "FAIL  [confirm] installed binary reports '$INSTALLED', expected 'typst $FAKE_VERSION...'"
      GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
      ;;
  esac
else
  echo "FAIL  [confirm] $OUT_DIR/typst was not installed by the positive case"
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
fi

# ── negative: checksum mismatch (corrupted download OR a wrong pin) ────────────
assert_red "server serves an archive that does NOT match the pinned checksum -> refused" \
  --contains "checksum mismatch" \
  --not-contains "Installed:" \
  -- run_installer "$DF_GOOD" "$BAD_ARCHIVE" "$WS/install-badsha"

# ── negative: amd64 branch present but TYPST_SHA256 line missing entirely ──────
assert_red "Dockerfile's amd64 branch has no TYPST_SHA256 line at all -> parse fails loudly, no download attempted" \
  --contains "TYPST_SHA256 did not parse" \
  --not-contains "Downloading" \
  -- run_installer "$DF_MISSING_LINE" "$GOOD_ARCHIVE" "$WS/install-missingline"

# ── negative: no ARG TYPST_VERSION at all (Dockerfile stage restructured) ──────
assert_red "Dockerfile has no 'ARG TYPST_VERSION=' line -> parse fails loudly, no download attempted" \
  --contains "could not find 'ARG TYPST_VERSION" \
  --not-contains "Downloading" \
  -- run_installer "$DF_NO_VERSION" "$GOOD_ARCHIVE" "$WS/install-noversion"

# ── negative: missing Dockerfile entirely ───────────────────────────────────────
assert_red "Dockerfile path does not exist -> fails loudly" \
  --contains "Dockerfile not found" \
  -- run_installer "$WS/does-not-exist/Dockerfile" "$GOOD_ARCHIVE" "$WS/install-nodockerfile"

# ── negative: floating "latest" pin refused outright (never reached in this
#    repo's real Dockerfile, but the script must not silently accept it if
#    someone ever "simplifies" the pin away) ────────────────────────────────────
DF_LATEST="$WS/Dockerfile.latest"
write_dockerfile "$DF_LATEST" "latest" "$GOOD_SHA256"
assert_red "TYPST_VERSION=latest is refused — floating versions defeat the determinism guarantee" \
  --contains "floating version" \
  --not-contains "Downloading" \
  -- run_installer "$DF_LATEST" "$GOOD_ARCHIVE" "$WS/install-latest"

guard_test_summary "test-install-typst-from-dockerfile.sh"
