#!/usr/bin/env bash
# hook-harness.sh — the three lines every .claude/hooks test needs, so they are
# not copy-pasted three times (task-guards-narrow-to-actual-launch, 2026-08-18).
#
# The subjects here are PreToolUse hooks, not scripts/devops/check-* guards:
# they read a tool-call JSON on stdin and answer with an exit code —
#   0  allow
#   2  BLOCK, and stdout carries {"decision":"block","reason":...}
#   1  the hook's own analyzer failed. NOT a verdict.
#
# That last distinction is the whole reason this file exposes the raw exit code
# instead of hiding it: a hook that dies on a bash syntax error also exits 2, so
# "non-zero" alone cannot tell a refusal from a crash. The tests therefore
# assert on the CONTRACT (the decision body, the `BLOCK` / `INTERNAL ERROR`
# markers), never on rc≠0 alone.
#
# Source AFTER lib/harness.sh (it uses $REPO_ROOT from there).
set -u

# A cwd that looks like an agent worktree — the launcher hooks only enforce
# inside .claude/worktrees/** and claude scratchpads, and the directory never
# has to exist for that check.
HOOK_TEST_WORKTREE="$REPO_ROOT/.claude/worktrees/agent-guard-test"

# $1 = hook path, $2 = command line, $3 = cwd (default: fake worktree)
hook_at() {
  local hook="$1" cmd="$2" cwd="${3:-$HOOK_TEST_WORKTREE}"
  CMD="$cmd" CWD="$cwd" python3 -c '
import json, os, sys
sys.stdout.write(json.dumps({
    "session_id": "guard-test",
    "tool_name": "Bash",
    "cwd": os.environ["CWD"],
    "tool_input": {"command": os.environ["CMD"]},
}))
' | bash "$hook"
}

# Copies a hook into a scratch dir next to a DELIBERATELY BROKEN lib/cmdscan.py,
# so the "my analyzer died" branch can be exercised for real instead of read.
# Echoes the path of the copy.
hook_with_broken_lib() {
  local ws="$1" hook_name="$2"
  mkdir -p "$ws/broken/lib"
  cp "$REPO_ROOT/.claude/hooks/$hook_name" "$ws/broken/$hook_name"
  printf 'def scan(:\n    this is not python\n' >"$ws/broken/lib/cmdscan.py"
  printf '%s' "$ws/broken/$hook_name"
}

# A hook whose BASH is broken — the trap this class of guard already fell into:
# bash exits 2 on a syntax error, exactly like a block. Echoes its path.
hook_with_broken_bash() {
  local ws="$1"
  mkdir -p "$ws/brokenbash"
  printf '%s\n' '#!/bin/bash' 'set -u' 'if [ 1 = 1 ]; then' >"$ws/brokenbash/hook.sh"
  printf '%s' "$ws/brokenbash/hook.sh"
}
