#!/usr/bin/env bash
# install-rtk.sh — install the pinned RTK (Rust Token Killer) binary, verified by checksum.
#
# WHY a script and not `curl | sh`: the upstream installer takes whatever "latest" is and the hook
# registered in .claude/settings.json (pre:bash:rtk-rewrite) executes this binary on every Bash call
# — it is the highest-trust binary in the toolchain. Version, edition AND the expected sha256 of each
# platform tarball are pinned HERE, in-repo and reviewed (SR-M-1, PR #1157): a checksum fetched from
# the same release origin as the tarball only detects corruption, not a re-pointed tag. A mismatch
# refuses the install. On a version bump: read the changelog, then replace RTK_VERSION and all four
# hashes together (take them from the release's checksums.txt, rtk-oss-* lines) —
# docs/architecture/rules-rationale/token-economy.md.
#
# Edition: `rtk-oss` (Apache-2.0, built without the BUSL-1.1 engine). Do not switch to the default
# `rtk` asset without an owner decision — it bundles a BUSL-1.1 component.
#
# Usage:  scripts/devops/install-rtk.sh            # installs to ~/.local/share/rtk/bin (RTK_INSTALL_DIR overrides)
#         RTK_INSTALL_DIR=/usr/local/bin scripts/devops/install-rtk.sh
set -euo pipefail

RTK_VERSION="v1.0.1"
REPO="rtk-ai/rtk"
# NOT a PATH directory, on purpose (owner decision 2026-10-25, review of PR #1157): the binary has
# subcommands that execute their operand, and an agent that cannot type a bare `rtk` cannot reach them
# by accident or by injected text. The rewrite hook calls it by absolute path. For your own use:
#   alias rtk="$HOME/.local/share/rtk/bin/rtk"      # in ~/.zshrc, human shells only
INSTALL_DIR="${RTK_INSTALL_DIR:-$HOME/.local/share/rtk/bin}"

os="$(uname -s)"
arch="$(uname -m)"
case "${os}-${arch}" in
  Linux-x86_64)
    target="x86_64-unknown-linux-musl"
    expected="a44e8ffc43981100b4ddf1710399a1649a6c874591aa6d0c0727fe6cbd983c41"
    ;;
  Linux-aarch64 | Linux-arm64)
    target="aarch64-unknown-linux-gnu"
    expected="ee24a43dac9162de55fea8460b5efcd56d401ec28b5117c921bffa8a57bc136e"
    ;;
  Darwin-arm64)
    target="aarch64-apple-darwin"
    expected="4a4d9d09656ff29423336aa506e680afc3f7b6dafe84f0194a1c9a523a3c80e1"
    ;;
  Darwin-x86_64)
    target="x86_64-apple-darwin"
    expected="2cf4d6dd2cabccbc74aa6aba2a48e60aad85b1a31e3d740e6ca0b2fa0060b06a"
    ;;
  *)
    echo "install-rtk: unsupported platform ${os}-${arch}" >&2
    exit 1
    ;;
esac

asset="rtk-oss-${target}.tar.gz"
url="https://github.com/${REPO}/releases/download/${RTK_VERSION}/${asset}"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

curl -fsSL --max-time 120 -o "${tmp}/${asset}" "${url}"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${tmp}/${asset}" | awk '{ print $1 }')"
else
  actual="$(shasum -a 256 "${tmp}/${asset}" | awk '{ print $1 }')"
fi
if [ "${expected}" != "${actual}" ]; then
  echo "install-rtk: sha256 mismatch for ${asset}: pinned ${expected}, got ${actual} — refusing" >&2
  exit 1
fi

# The archive must hold exactly the member we extract (assumption checked on linux-musl and
# aarch64-apple-darwin releases of ${RTK_VERSION}); tar of one named member into a private dir.
members="$(tar tzf "${tmp}/${asset}")"
# here-string, not a pipe: `grep -q` closing a pipe early gives tar SIGPIPE, which pipefail turns into a failure
grep -qx 'rtk' <<<"${members}" || { echo "install-rtk: archive has no 'rtk' member — refusing" >&2; exit 1; }
tar xzf "${tmp}/${asset}" -C "${tmp}" rtk
mkdir -p "${INSTALL_DIR}"
install -m 0755 "${tmp}/rtk" "${INSTALL_DIR}/rtk"

# Assert the artifact, not the exit status (verification-integrity.md).
installed="$("${INSTALL_DIR}/rtk" --version)"
case "${installed}" in
  "rtk ${RTK_VERSION#v}") echo "install-rtk: ${installed} installed to ${INSTALL_DIR}/rtk (sha256 verified)" ;;
  *)
    echo "install-rtk: unexpected version output '${installed}'" >&2
    exit 1
    ;;
esac
echo "install-rtk: the hook pre:bash:rtk-rewrite looks for ${INSTALL_DIR}/rtk (a fixed path, not PATH);" >&2
echo "install-rtk: if you changed RTK_INSTALL_DIR, export the same value in the environment Claude Code runs in." >&2
