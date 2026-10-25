#!/bin/bash
# ECC stable id: pre:bash:rtk-rewrite
#
# Purpose: token-economy (rules/common/token-economy.md). Hand the Bash tool call to RTK
# (`rtk hook claude`), which rewrites e.g. `git status` -> `rtk git status` so the command's output is
# compacted before it reaches the model.
#
# This hook decides what actually RUNS (updatedInput), after the other pre:bash guards have judged the
# ORIGINAL command in parallel. So it is the highest-trust step in the Bash path and is hardened
# (SR-M-2, PR #1157):
#   * rtk is resolved to a FIXED absolute path (RTK_INSTALL_DIR or ~/.local/bin, where
#     scripts/devops/install-rtk.sh puts the sha256-pinned binary) — never through PATH, so a binary
#     named `rtk` earlier on PATH cannot supply the command that runs;
#   * the rewrite is applied ONLY if it is a pure `rtk ` prefixing of the original: removing every
#     `rtk ` token from both the rewritten and the original command must give the same string. Anything
#     else (rtk substituted, dropped or appended something) is discarded and the original runs.
#
# ADVISORY and FAIL-OPEN: it never refuses. No binary, a crash, bad JSON, or a failed sanity check =
# silent no-op, the original command runs unchanged. A missing optimisation must never block work.
# One command unfiltered (evidence you must read verbatim): `rtk bypass <cmd>`.
# Rationale and the condition to reopen: docs/architecture/rules-rationale/token-economy.md

RTK_BIN="${RTK_INSTALL_DIR:-$HOME/.local/bin}/rtk"
[ -x "$RTK_BIN" ] || exit 0

INPUT=$(cat)
OUT=$(printf '%s' "$INPUT" | "$RTK_BIN" hook claude 2>/dev/null) || exit 0
[ -n "$OUT" ] || exit 0

# Pass the rewrite through only when it is a pure prefixing of the original command.
printf '%s' "$INPUT" | ORIG_OUT="$OUT" python3 -c '
import json, os, re, sys
try:
    original = json.load(sys.stdin)["tool_input"]["command"]
    out = json.loads(os.environ["ORIG_OUT"])
    new = out["hookSpecificOutput"]["updatedInput"]["command"]
except Exception:
    sys.exit(1)
strip = lambda s: re.sub(r"(?<![\w-])rtk ", "", s)
if strip(new) != strip(original):
    sys.exit(1)
if "permissionDecision" in out.get("hookSpecificOutput", {}):
    sys.exit(1)
sys.stdout.write(os.environ["ORIG_OUT"])
' || exit 0
