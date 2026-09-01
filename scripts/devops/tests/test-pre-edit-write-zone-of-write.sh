#!/usr/bin/env bash
# test-pre-edit-write-zone-of-write.sh — proves .claude/hooks/pre-edit-write-zone-of-write.sh
# actually refuses a production-zone edit from a session that is not an isolated
# agent worktree, BY EXECUTION against forged PreToolUse payloads.
#
# WHY IT HAD NO TEST UNTIL 2026-09-01: the meta-guard
# scripts/devops/check-guard-tests-exist.sh took its inventory from
# `scripts/devops/check-*`, so no hook was ever in its field of view. It is
# read from `.claude/settings.json` now, and this file is one of the four gaps
# that came out the moment it was.
#
# WHAT IS ASSERTED, and why it is the exit code AND the body: a hook refuses by
# exiting 2 with {"decision": "block"} on stdout. A bash syntax error exits 2
# too. The cross-agent hooks shipped a draft that died at parse time and
# "passed" all eight of its block cases while doing nothing — so the code alone
# is not evidence of a refusal here.
#
# The two REFUSALS below are the two distinct ones this hook implements, and
# they are not variants of each other:
#   * a main-repo session editing apps/** — the original Phase 2.5 gate;
#   * FM-2 — an agent whose cwd IS a worktree writing to an ABSOLUTE path
#     outside it, the main-repo contamination class that the cwd check alone
#     let through (~5-6x per session, once flipping the owner's live stack).
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

HOOK="$REPO_ROOT/.claude/hooks/pre-edit-write-zone-of-write.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

echo "== test-pre-edit-write-zone-of-write.sh =="
echo

if ! bash -n "$HOOK" 2>/dev/null; then
  echo "FATAL: syntax error in $HOOK"
  bash -n "$HOOK"
  exit 1
fi

# ── fixtures ───────────────────────────────────────────────────────────────────
# A fake repo pinned to branch `main` on purpose. The hook has a second allow
# path for a cwd under /tmp whose branch looks like an agent branch
# (`^(coder|feature|fix|infra|test)/`), and `mktemp -d` lands under /tmp on a
# Linux runner but under /var/folders on macOS. Pinning the branch to `main`
# makes every case below decide the same way on both.
MAIN_REPO="$WS/main-repo"
mkdir -p "$MAIN_REPO"
(
  cd "$MAIN_REPO" || exit 1
  git init -q -b main
  git config user.email test@example.invalid
  git config user.name "guard test"
  git config commit.gpgsign false
  mkdir -p apps/web .claude
  echo seed >README.md
  git add README.md
  git commit -q -m init
) >/dev/null 2>&1

# A directory whose path contains /.claude/worktrees/<name>/ — which is the
# only signal the hook uses to recognise an isolated agent (it greps $PWD; the
# runtime does not propagate $CLAUDE_AGENT_ID, per the hook's own header).
WT_ROOT="$MAIN_REPO/.claude/worktrees/agent-MINE"
OTHER_WT="$MAIN_REPO/.claude/worktrees/agent-OTHER"
mkdir -p "$WT_ROOT/apps/web" "$OTHER_WT/apps/web"

# $1 = cwd to run from, $2 = tool name, $3 = file_path
run_hook() {
  local cwd="$1" tool="$2" path="$3"
  local json
  json=$(python3 -c 'import json,sys; print(json.dumps({"hook_event_name":"PreToolUse","tool_name":sys.argv[1],"tool_input":{"file_path":sys.argv[2]}}))' "$tool" "$path")
  (cd "$cwd" && printf '%s' "$json" | bash "$HOOK")
}

# ── fast no-ops ────────────────────────────────────────────────────────────────

assert_green "a non-edit tool is a silent no-op" \
  --not-contains "BLOCK" \
  -- run_hook "$MAIN_REPO" "Bash" "apps/web/app/x.tsx"

assert_green "an edit outside apps/** and packages/** is a no-op" \
  --not-contains "BLOCK" \
  -- run_hook "$MAIN_REPO" "Edit" "docs/architecture/adr.md"

assert_green "an empty file_path is a no-op" \
  --not-contains "BLOCK" \
  -- run_hook "$MAIN_REPO" "Edit" ""

# ── refusal 1: production zone from a main-repo session ───────────────────────

assert_red "Edit on apps/** from a main-repo session -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook "$MAIN_REPO" "Edit" "apps/web/app/routes/x.tsx"

assert_red "Write on packages/** from a main-repo session -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$MAIN_REPO" "Write" "packages/shared/src/schema.ts"

assert_red "MultiEdit is gated the same way as Edit" \
  --contains '"decision": "block"' \
  -- run_hook "$MAIN_REPO" "MultiEdit" "apps/api/src/finance/finance.service.ts"

# ── refusal 2: FM-2, worktree agent writing outside its own worktree ──────────
# This is the case the cwd check alone could not catch: the agent IS in its
# worktree (so allow #1 would fire), but the TARGET is an absolute path in
# somebody else's tree.

assert_red "FM-2: worktree agent writing an absolute path into the MAIN checkout -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "WORKTREE" \
  -- run_hook "$WT_ROOT" "Write" "$MAIN_REPO/apps/web/app/x.tsx"

assert_red "FM-2: worktree agent writing into ANOTHER agent's worktree -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$WT_ROOT" "Edit" "$OTHER_WT/apps/web/app/x.tsx"

# Lexical `..` is normalised first — otherwise "$WT/../agent-OTHER/apps/x"
# starts with "$WT/" as a string and would walk straight out of the worktree.
assert_red "FM-2: a '..' path that escapes the worktree is normalised, not trusted -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$WT_ROOT" "Edit" "$WT_ROOT/../agent-OTHER/apps/web/app/x.tsx"

# ── the allows, asserted as allows ────────────────────────────────────────────

assert_green "a worktree agent editing INSIDE its own worktree passes" \
  --not-contains "BLOCK" \
  -- run_hook "$WT_ROOT" "Edit" "apps/web/app/routes/x.tsx"

assert_green "a worktree agent using its own ABSOLUTE path passes" \
  --not-contains "BLOCK" \
  -- run_hook "$WT_ROOT" "Write" "$WT_ROOT/apps/web/app/x.tsx"

# The escape hatch is deliberate and gitignored; it exists so a false positive
# costs a `touch`, not a bypassed gate. Asserted so that removing it would be a
# visible test change.
touch "$MAIN_REPO/.claude/.allow-direct-edits"
assert_green "the .claude/.allow-direct-edits escape hatch passes" \
  --not-contains "BLOCK" \
  -- run_hook "$MAIN_REPO" "Edit" "apps/web/app/routes/x.tsx"
rm -f "$MAIN_REPO/.claude/.allow-direct-edits"

assert_red "removing the escape hatch restores the refusal" \
  --contains '"decision": "block"' \
  -- run_hook "$MAIN_REPO" "Edit" "apps/web/app/routes/x.tsx"

guard_test_summary "test-pre-edit-write-zone-of-write.sh"
