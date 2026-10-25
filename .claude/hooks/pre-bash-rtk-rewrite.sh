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
#   * rtk is resolved to a FIXED absolute path (RTK_INSTALL_DIR or ~/.local/share/rtk/bin, a directory that is NOT on PATH, where
#     scripts/devops/install-rtk.sh puts the sha256-pinned binary) — never through PATH, so a binary
#     named `rtk` earlier on PATH cannot supply the command that runs;
#   * the rewrite is applied ONLY if it is a pure `rtk ` prefixing of the original: removing every
#     `rtk ` token from the rewritten command must give back the original. Anything else (rtk
#     substituted, dropped or appended something) is discarded and the original runs. The command that
#     is returned carries the ABSOLUTE rtk path, not a bare `rtk` (no PATH lookup at run time).
#
# ADVISORY and FAIL-OPEN: it never refuses. No binary, a crash, bad JSON, or a failed sanity check =
# silent no-op, the original command runs unchanged. A missing optimisation must never block work.
# One command unfiltered (evidence you must read verbatim): prefix it with RTK_DISABLED=1. The rtk exec
# subcommands (bypass/err/test/run/summary) are refused by pre:bash:rtk-exec-gate.
# Rationale and the condition to reopen: docs/architecture/rules-rationale/token-economy.md

RTK_BIN="${RTK_INSTALL_DIR:-$HOME/.local/share/rtk/bin}/rtk"
[ -x "$RTK_BIN" ] || exit 0

INPUT=$(cat)
OUT=$(printf '%s' "$INPUT" | "$RTK_BIN" hook claude 2>/dev/null) || exit 0
[ -n "$OUT" ] || exit 0

# Pass the rewrite through only when it is a pure prefixing of the original command, and pin the
# executed binary: every `rtk ` token is replaced by the absolute path validated above, so the Bash tool
# does not resolve `rtk` through PATH at run time (SR-M-3, PR #1157). An original that already
# contains an `rtk ` token is not rewritten at all: the replacement could not tell its own tokens apart.
printf '%s' "$INPUT" | ORIG_OUT="$OUT" RTK_BIN="$RTK_BIN" python3 -I -c '
import json, os, re, shlex, sys
try:
    original = json.load(sys.stdin)["tool_input"]["command"]
    out = json.loads(os.environ["ORIG_OUT"])
    new = out["hookSpecificOutput"]["updatedInput"]["command"]
except Exception:
    sys.exit(1)
tok = r"(?<![\w-])rtk "
if re.search(tok, original):
    sys.exit(1)
if re.sub(tok, "", new) != original:
    sys.exit(1)
if "permissionDecision" in out["hookSpecificOutput"]:
    sys.exit(1)
out["hookSpecificOutput"]["updatedInput"]["command"] = re.sub(tok, lambda m: shlex.quote(os.environ["RTK_BIN"]) + " ", new)
sys.stdout.write(json.dumps(out))
' || exit 0
