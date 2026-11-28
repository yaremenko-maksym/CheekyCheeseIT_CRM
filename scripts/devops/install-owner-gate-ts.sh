#!/usr/bin/env bash
# install-owner-gate-ts.sh — fetches the TypeScript parser for check-owner-approval.mjs in the two
# owner-verdict workflows, pinned by INTEGRITY, not only by version: the job then runs with a write
# token. The tarball is `npm pack`ed (no install, no lifecycle scripts), its sha512 must equal the
# pnpm-lock.yaml entry below, and only then is it unpacked. The gate jobs check out main sparse
# (no lockfile), so the hash is copied here; the unit test fails when it drifts from the lockfile.
# Env: TS_DIR (output dir), NPM_BIN (default npm; tests point it at a stub), GITHUB_ENV (optional:
#      receives OWNER_GATE_TS=<dir>).
# Exit: 0 unpacked and verified; 1 a fetch failure or a hash mismatch (nothing unpacked).
# Tests: scripts/devops/tests/test-check-owner-approval.sh (section "TypeScript pin").
set -euo pipefail
TS_VERSION=5.9.3
TS_INTEGRITY='sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw=='
: "${TS_DIR:?}"
NPM_BIN="${NPM_BIN:-npm}"
mkdir -p "$TS_DIR"

tgz=$("$NPM_BIN" pack "typescript@$TS_VERSION" --silent --pack-destination "$TS_DIR" | tail -n 1)
[ -s "$TS_DIR/$tgz" ] || { echo "::error::npm pack produced no tarball"; exit 1; }
got="sha512-$(openssl dgst -sha512 -binary "$TS_DIR/$tgz" | base64 | tr -d '\n')"
if [ "$got" != "$TS_INTEGRITY" ]; then
  echo "::error::typescript@$TS_VERSION tarball integrity mismatch: got $got"
  exit 1
fi
tar -xzf "$TS_DIR/$tgz" -C "$TS_DIR"
[ -f "$TS_DIR/package/lib/typescript.js" ] || { echo "::error::no lib/typescript.js in the tarball"; exit 1; }
echo "typescript@$TS_VERSION verified ($TS_INTEGRITY)"
if [ -n "${GITHUB_ENV:-}" ]; then echo "OWNER_GATE_TS=$TS_DIR/package" >>"$GITHUB_ENV"; fi
