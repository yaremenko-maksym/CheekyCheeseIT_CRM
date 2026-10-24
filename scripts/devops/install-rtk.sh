#!/usr/bin/env bash
# install-rtk.sh — install the pinned RTK (Rust Token Killer) binary, verified by checksum.
#
# WHY a script and not `curl | sh`: the upstream installer takes whatever "latest" is and the hook
# registered in .claude/settings.json (pre:bash:rtk-rewrite) executes this binary on every Bash call.
# Version and edition are pinned here; the tarball is checked against the release's checksums.txt
# and the install is refused on any mismatch. Bump deliberately (read the changelog first) — see
# docs/architecture/rules-rationale/token-economy.md.
#
# Edition: `rtk-oss` (Apache-2.0, built without the BUSL-1.1 engine). Do not switch to the default
# `rtk` asset without an owner decision — it bundles a BUSL-1.1 component.
#
# Usage:  scripts/devops/install-rtk.sh            # installs to ~/.local/bin (RTK_INSTALL_DIR overrides)
#         RTK_INSTALL_DIR=/usr/local/bin scripts/devops/install-rtk.sh
set -euo pipefail

RTK_VERSION="v1.0.1"
REPO="rtk-ai/rtk"
INSTALL_DIR="${RTK_INSTALL_DIR:-$HOME/.local/bin}"

os="$(uname -s)"
arch="$(uname -m)"
case "${os}-${arch}" in
  Linux-x86_64) target="x86_64-unknown-linux-musl" ;;
  Linux-aarch64 | Linux-arm64) target="aarch64-unknown-linux-gnu" ;;
  Darwin-arm64) target="aarch64-apple-darwin" ;;
  Darwin-x86_64) target="x86_64-apple-darwin" ;;
  *)
    echo "install-rtk: unsupported platform ${os}-${arch}" >&2
    exit 1
    ;;
esac

asset="rtk-oss-${target}.tar.gz"
base="https://github.com/${REPO}/releases/download/${RTK_VERSION}"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

curl -fsSL --max-time 120 -o "${tmp}/${asset}" "${base}/${asset}"
curl -fsSL --max-time 60 -o "${tmp}/checksums.txt" "${base}/checksums.txt"

expected="$(awk -v a="${asset}" '$2 == a { print $1 }' "${tmp}/checksums.txt")"
if [ -z "${expected}" ]; then
  echo "install-rtk: ${asset} is not listed in checksums.txt — refusing" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${tmp}/${asset}" | awk '{ print $1 }')"
else
  actual="$(shasum -a 256 "${tmp}/${asset}" | awk '{ print $1 }')"
fi
if [ "${expected}" != "${actual}" ]; then
  echo "install-rtk: checksum mismatch for ${asset} (expected ${expected}, got ${actual}) — refusing" >&2
  exit 1
fi

mkdir -p "${INSTALL_DIR}"
tar xzf "${tmp}/${asset}" -C "${tmp}" rtk
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
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "install-rtk: add ${INSTALL_DIR} to PATH for the hook to find rtk" >&2 ;;
esac
