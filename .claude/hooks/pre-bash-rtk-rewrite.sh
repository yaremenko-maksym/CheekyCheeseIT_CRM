#!/bin/bash
# ECC stable id: pre:bash:rtk-rewrite
#
# Purpose: token-economy (rules/common/token-economy.md). Hand the Bash tool call to RTK
# (`rtk hook claude`), which rewrites e.g. `git status` -> `rtk git status` so the command's output is
# compacted before it reaches the model.
#
# ADVISORY by construction: this hook never refuses. It is FAIL-OPEN —
#   * no `rtk` binary on PATH  -> silent no-op (install: scripts/devops/install-rtk.sh, pinned + sha256);
#   * `rtk hook claude` errors -> swallowed, the original command runs unchanged.
# A missing optimisation must never block work. The original command string is what the other
# pre:bash:* guards see; this hook only supplies `updatedInput`.
#
# One command unfiltered (evidence you must read verbatim): `rtk bypass <cmd>`.
# Rationale and the condition to reopen: docs/architecture/rules-rationale/token-economy.md

if command -v rtk >/dev/null 2>&1; then
  rtk hook claude || true
fi
