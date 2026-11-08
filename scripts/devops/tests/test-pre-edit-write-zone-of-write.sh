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
# A fake main checkout. (The /tmp + agent-branch allow that once made the
# branch name matter was removed — SR-L-9.)
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

# Agent worktrees laid out like the Agent tool's `isolation:"worktree"`:
# REAL `git worktree add` trees under .claude/worktrees/<name>. The hook
# recognises them by git (linked worktree), not by the path string; a plain
# directory under .claude/worktrees/ is no longer an allow (see F1-F3 below).
WT_ROOT="$MAIN_REPO/.claude/worktrees/agent-MINE"
OTHER_WT="$MAIN_REPO/.claude/worktrees/agent-OTHER"
(
  cd "$MAIN_REPO" || exit 1
  git worktree add -q -b wt-mine "$WT_ROOT"
  git worktree add -q -b wt-other "$OTHER_WT"
) >/dev/null 2>&1
mkdir -p "$WT_ROOT/apps/web" "$OTHER_WT/apps/web"

# $1 = cwd to run from, $2 = tool name, $3 = file_path
run_hook() {
  local cwd="$1" tool="$2" path="$3"
  local json
  # The exclusion stops Git Bash rewriting /tmp/x in argv, so the payload holds the path as given.
  json=$(MSYS2_ARG_CONV_EXCL='*' python3 -c 'import json,sys; print(json.dumps({"hook_event_name":"PreToolUse","tool_name":sys.argv[1],"tool_input":{"file_path":sys.argv[2]}}))' "$tool" "$path")
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
# This is the case a cwd check alone could not catch: the agent IS in its
# worktree, but the TARGET is an absolute path in somebody else's tree.

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

# ── Windows payloads ──────────────────────────────────────────────────────────
# Claude Code on Windows reports C:\x while Git Bash $PWD says /c/x. Before the
# hook compared one form, a backslash path missed the apps|packages grep and
# exited 0: the whole gate failed open. These paths are plain strings, so the
# cases decide the same way on a Linux runner and on Windows.
assert_red "Windows payload: main-session Edit of a backslash apps/ path -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook "$MAIN_REPO" "Edit" 'C:\x\apps\web\y.ts'

assert_red "Windows payload: main-session Write of a C:/ packages/ path -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook "$MAIN_REPO" "Write" 'C:/x/packages/shared/y.ts'

assert_red "Windows payload: a drive-relative C:apps/ path -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook "$MAIN_REPO" "Edit" 'C:apps/web/y.ts'

assert_red "a case variant of the production zone -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook "$MAIN_REPO" "Edit" 'C:\x\Apps\web\y.ts'

assert_green "Windows payload: a backslash path outside the production zones is a no-op" \
  --not-contains "BLOCK" \
  -- run_hook "$MAIN_REPO" "Edit" 'C:\x\docs\architecture\adr.md'

# The stderr line is asserted because it prints the normalised target: the
# JSON body goes through python argv, which Git Bash rewrites back to C:/x.
assert_red "Windows payload: FM-2, worktree agent writing C:\\x into another tree -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "WORKTREE" \
  --contains "target=/c/x/apps/web/y.ts" \
  -- run_hook "$WT_ROOT" "Edit" 'C:\x\apps\web\y.ts'

WT_PWD="$(cd "$WT_ROOT" && pwd)"
WT_BACKSLASH="$(printf '%s' "$WT_PWD" | tr '/' '\\')"

assert_green "Windows payload: own worktree spelled with backslashes is not a false FM-2" \
  --not-contains "BLOCK" \
  -- run_hook "$WT_ROOT" "Edit" "$WT_BACKSLASH\\apps\\web\\app\\x.tsx"

assert_red "Windows payload: a backslash '..' escape is normalised, not trusted -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "WORKTREE" \
  -- run_hook "$WT_ROOT" "Edit" "$WT_BACKSLASH\\..\\agent-OTHER\\apps\\web\\app\\x.tsx"

# ── linked git worktrees outside .claude/worktrees/ (2026-11-08) ──────────────
# The hook used to recognise a worktree only by the string /.claude/worktrees/
# in $PWD. A T3 `delegate_task isolation:"worktree"` child runs in
# ~/.t3/worktrees/<project>/t3-xxxx — a real linked worktree — and was refused
# in its OWN tree; a main-checkout session editing a file inside a linked
# worktree was refused too, because the hook judged the cwd, not the target.
# These fixtures are REAL `git worktree add` trees (git-dir != git-common-dir),
# laid out like T3's, so the decision rests on git, not on a path string.
LW_MAIN="$WS/lw/crm"
LW_A="$WS/lw/t3/worktrees/crm/t3-aaaa"
LW_B="$WS/lw/t3/worktrees/crm/t3-bbbb"
mkdir -p "$LW_MAIN" "$WS/lw/t3/worktrees/crm"
(
  cd "$LW_MAIN" || exit 1
  git init -q -b main
  git config user.email test@example.invalid
  git config user.name "guard test"
  git config commit.gpgsign false
  mkdir -p apps/api/src .claude
  echo seed >apps/api/src/main.ts
  git add apps/api/src/main.ts
  git commit -q -m init
  git worktree add -q -b wt-aaaa "$LW_A"
  git worktree add -q -b wt-bbbb "$LW_B"
  # A nested, independent repo inside the main checkout: its own main checkout.
  mkdir -p vendor/nested && git -C vendor/nested init -q -b main
) >/dev/null 2>&1
# A symlink that leads out of worktree A into the main checkout's apps/.
ln -s "$LW_MAIN/apps/api" "$LW_A/apps/link"

assert_green "linked worktree (T3 layout) editing its own apps file, relative path -> allow" \
  --not-contains "BLOCK" \
  -- run_hook "$LW_A" "Edit" "apps/api/src/main.ts"

assert_green "linked worktree editing its own apps file, absolute path -> allow" \
  --not-contains "BLOCK" \
  -- run_hook "$LW_A" "Edit" "$LW_A/apps/api/src/main.ts"

assert_green "linked worktree writing a NEW file in a new directory of its own tree -> allow" \
  --not-contains "BLOCK" \
  -- run_hook "$LW_A" "Write" "$LW_A/packages/new-pkg/src/index.ts"

assert_red "SR-M-3: main-checkout session editing a file inside a linked worktree -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook "$LW_MAIN" "Edit" "$LW_A/apps/api/src/main.ts"

assert_green "linked worktree editing a non-production path -> allow" \
  --not-contains "BLOCK" \
  -- run_hook "$LW_A" "Edit" "docs/notes.md"

assert_red "FM-2: linked worktree writing into the MAIN checkout's apps -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "WORKTREE" \
  -- run_hook "$LW_A" "Edit" "$LW_MAIN/apps/api/src/main.ts"

assert_red "FM-2: linked worktree writing into a DIFFERENT linked worktree -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "WORKTREE" \
  -- run_hook "$LW_A" "Edit" "$LW_B/apps/api/src/main.ts"

assert_red "FM-2: an absolute '..' escape from a linked worktree into main -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "WORKTREE" \
  -- run_hook "$LW_A" "Edit" "$LW_A/../../../../crm/apps/api/src/main.ts"

assert_red "FM-2: a relative '..' escape from a linked worktree into main -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "WORKTREE" \
  -- run_hook "$LW_A" "Edit" "../../../../crm/apps/api/src/main.ts"

assert_red "FM-2: a symlink inside a linked worktree that resolves into main -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "WORKTREE" \
  -- run_hook "$LW_A" "Edit" "apps/link/src/main.ts"

assert_red "main-checkout session reaching main through a worktree's symlink -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook "$LW_MAIN" "Edit" "$LW_A/apps/link/src/main.ts"

assert_red "main-checkout session editing its own apps file without the escape hatch -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook "$LW_MAIN" "Edit" "apps/api/src/main.ts"

assert_red "a nested independent repo is a main checkout, not a worktree -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook "$LW_MAIN" "Write" "$LW_MAIN/vendor/nested/apps/x.ts"

# ── security review of PR #1297: forged git state must not become an allow ─────
# SR-M-1: an inherited GIT_DIR pointing at a worktree's gitdir made the main
# checkout look linked (git-dir != common-dir, toplevel = cwd).
run_hook_with_git_dir() { GIT_DIR="$1" run_hook "${@:2}"; }
assert_red "SR-M-1: inherited GIT_DIR cannot make the main checkout look like a linked worktree" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook_with_git_dir "$LW_MAIN/.git/worktrees/t3-aaaa" "$LW_MAIN" "Edit" "$LW_MAIN/apps/api/src/main.ts"

# SR-M-2: Write can plant <main>/.git/commondir (no apps/ in that path), after
# which git reports a common dir != git dir for the MAIN checkout.
run_hook_with_forged_commondir() {
  mkdir -p "$WS/fake-common/objects" "$WS/fake-common/refs"
  printf '%s\n' "$WS/fake-common" >"$LW_MAIN/.git/commondir"
  run_hook "$@"
  local rc=$?
  rm -f "$LW_MAIN/.git/commondir"
  return $rc
}
assert_red "SR-M-2: a forged .git/commondir in the main checkout is not a linked worktree" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook_with_forged_commondir "$LW_MAIN" "Edit" "$LW_MAIN/apps/api/src/main.ts"

# SR-M-2 follow-up: a per-worktree core.worktree (writable via Write in the
# gitdir) moves --show-toplevel to a parent directory that holds a forged `.git`
# FILE, widening a linked worktree over the main checkout.
run_hook_with_widened_worktree() {
  git -C "$LW_A" config extensions.worktreeConfig true
  git -C "$LW_A" config --worktree core.worktree "$WS/lw"
  printf 'gitdir: %s\n' "$LW_MAIN/.git/worktrees/t3-aaaa" >"$WS/lw/.git"
  run_hook "$@"
  local rc=$?
  git -C "$LW_A" config --worktree --unset core.worktree
  git -C "$LW_A" config --unset extensions.worktreeConfig
  rm -f "$WS/lw/.git"
  return $rc
}
assert_red "SR-M-2: a per-worktree core.worktree cannot widen a linked worktree over main" \
  --contains '"decision": "block"' \
  -- run_hook_with_widened_worktree "$LW_A" "Edit" "$LW_MAIN/apps/api/src/main.ts"

# SR-L-1: the production-zone check must see the RESOLVED target, not only the raw string.
ln -s "$LW_MAIN/apps" "$LW_A/lnk"
assert_red "SR-L-1: a symlink with no apps/ in its raw path, from a linked worktree into main -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "WORKTREE" \
  -- run_hook "$LW_A" "Edit" "lnk/api/src/main.ts"

assert_red "SR-L-1: the same symlink, from the main checkout -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook "$LW_MAIN" "Edit" "$LW_A/lnk/api/src/main.ts"

assert_red "SR-L-1: a relative path from a cwd inside main's apps/ -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook "$LW_MAIN/apps/api" "Edit" "src/main.ts"

# SR-L-2: a raw ~/ path is the home directory, not a directory named ~ in the worktree.
run_hook_with_home() { HOME="$1" run_hook "${@:2}"; }
mkdir -p "$WS/home"
assert_red "SR-L-2: a ~/ path from a linked worktree resolves to HOME, outside it -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "WORKTREE" \
  -- run_hook_with_home "$WS/home" "$LW_A" "Edit" "~/apps/api/x.ts"

# SR-L-4: payload with lone surrogate in file_path must fail closed (exit 2), not allow.
run_hook_raw_payload() {
  local cwd="$1" payload="$2"
  (cd "$cwd" && printf '%s' "$payload" | bash "$HOOK")
}
assert_red "SR-L-4: payload with \\ud800 in file_path -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook_raw_payload "$MAIN_REPO" '{"tool_name":"Write","tool_input":{"file_path":"apps/api/\ud800.ts"}}'

# SR-L-5: lexical normalization before realpath stops symlink + '..' escaping a linked worktree.
mkdir -p "$LW_A/d1/d2" "$LW_A/main/apps/api/src"
ln -s "$LW_A/d1/d2" "$LW_A/sym_deep"
assert_red "SR-L-5: symlink + '..' resolving physically into wt but lexically outside -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "WORKTREE" \
  -- run_hook "$LW_A" "Edit" "sym_deep/../../main/apps/api/src/main.ts"

# ── second opinion on PR #1297: the legacy /.claude/worktrees/ string allow ────
# A PLAIN directory under .claude/worktrees/ (not a linked worktree) used to be
# allowed by the path string alone (legacy allow #1); the legacy FM-2 beside it
# checked only absolute paths, lexically. Real agent worktrees are linked, so
# the string allow is gone: such a cwd is judged like any other session.
FAKE_WT="$MAIN_REPO/.claude/worktrees/agent-FAKE"
mkdir -p "$FAKE_WT/apps/web"
ln -s "$MAIN_REPO/apps" "$FAKE_WT/lnk"

assert_red "F1: plain dir under .claude/worktrees/, relative '..' into MAIN's apps -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook "$FAKE_WT" "Edit" "../../../apps/web/x.ts"

assert_red "F2: plain dir under .claude/worktrees/, absolute path through a symlink into MAIN -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook "$FAKE_WT" "Edit" "$FAKE_WT/lnk/web/x.ts"

assert_red "a plain dir under .claude/worktrees/ editing its own apps file is no longer an allow -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook "$FAKE_WT" "Edit" "apps/web/x.ts"

# F3: when the linked-worktree check cannot decide (no repo, or its python
# crashes), the hook must end in the refusal, not in the string allow.
NOREPO_WT="$WS/norepo/.claude/worktrees/agent-X"
mkdir -p "$NOREPO_WT/apps/web"
assert_red "F3: cwd under .claude/worktrees/ that is not a git repo at all -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook "$NOREPO_WT" "Edit" "apps/web/x.ts"

# A `git` that prints non-UTF-8 makes the check's python raise (text=True decode),
# so LW_VERDICT is empty — the real failure mode, from a REAL linked worktree.
GIT_STUB="$WS/git-stub"
mkdir -p "$GIT_STUB"
printf '#!/bin/sh\nprintf "\\377\\376\\n\\377\\n\\377\\n"\n' >"$GIT_STUB/git"
chmod +x "$GIT_STUB/git"
run_hook_with_broken_git() { PATH="$GIT_STUB:$PATH" run_hook "$@"; }
assert_red "F3: the linked-worktree check crashing in an agent worktree fails closed -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook_with_broken_git "$WT_ROOT" "Edit" "apps/web/x.ts"

# F4: a surrogate-escaped (non-UTF-8 byte) path made print() raise, RESOLVED was
# empty, and the raw path (no apps/ in it) fast-exited the hook. print() raises
# only with a strict stdout: UTF-8 mode off and a non-C UTF-8 locale (a dev shell
# exporting PYTHONUTF8=1 hides it), so the case pins both.
run_hook_strict_stdout() { PYTHONUTF8=0 LC_ALL=en_US.UTF-8 run_hook_raw_payload "$@"; }
assert_red "F4: a non-UTF-8 byte in a relative path from inside main's apps/ -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook_strict_stdout "$MAIN_REPO/apps/web" '{"tool_name":"Edit","tool_input":{"file_path":"src\udcff.ts"}}'

assert_green "F4: the same byte outside the production zones is still a no-op" \
  --not-contains "BLOCK" \
  -- run_hook_strict_stdout "$MAIN_REPO" '{"tool_name":"Edit","tool_input":{"file_path":"docs/\udcff.md"}}'

# ── security review of PR #1297 on 99c994ffc: SR-L-6..9, SO-M-1 ──────────────
# SR-L-6: macOS /usr/bin/grep under a UTF-8 locale fails to match `apps/` on a
# line holding an invalid byte, so the production-zone fast-exit let it through.
run_hook_utf8_locale() { LC_ALL=en_US.UTF-8 run_hook_raw_payload "$@"; }
assert_red "SR-L-6: an invalid byte in an apps/ DIRECTORY name from the main checkout -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook_utf8_locale "$MAIN_REPO" '{"tool_name":"Edit","tool_input":{"file_path":"apps/\udcff/x.ts"}}'

assert_red "SR-L-6: an invalid byte in an absolute main apps/ path from an agent worktree -> FM-2 BLOCK" \
  --contains '"decision": "block"' \
  --contains "WORKTREE" \
  -- run_hook_utf8_locale "$LW_A" '{"tool_name":"Write","tool_input":{"file_path":"'"$LW_MAIN"'/apps/\udcff.ts"}}'

# SR-L-7: a linked worktree nested inside another one's tree (Agent isolation
# dispatched from a T3 session lands in <wt>/.claude/worktrees/). A prefix check
# on the cwd's toplevel let the parent write into the nested agent's tree.
NESTED_WT="$LW_A/.claude/worktrees/agent-nested"
git -C "$LW_MAIN" worktree add -q -b wt-nested "$NESTED_WT" >/dev/null 2>&1
mkdir -p "$NESTED_WT/apps/api/src"
assert_red "SR-L-7: parent worktree writing into a NESTED linked worktree -> FM-2 BLOCK" \
  --contains '"decision": "block"' \
  --contains "WORKTREE" \
  -- run_hook "$LW_A" "Edit" "$NESTED_WT/apps/api/src/main.ts"

assert_green "SR-L-7: the nested worktree writing its own apps file -> allow" \
  --not-contains "BLOCK" \
  -- run_hook "$NESTED_WT" "Edit" "apps/api/src/main.ts"

assert_red "SR-L-7: the nested worktree writing into its parent worktree -> FM-2 BLOCK" \
  --contains '"decision": "block"' \
  --contains "WORKTREE" \
  -- run_hook "$NESTED_WT" "Edit" "$LW_A/apps/api/src/main.ts"

# SR-L-8: a planted `<parent>/.git` FILE plus a fake `<common>/worktrees/fake`
# (all outside the zone, so Write can create them) makes a cwd ABOVE main a
# "linked worktree" whose toplevel contains main.
run_hook_with_planted_parent() {
  local fake="$LW_MAIN/.git/worktrees/fake"
  mkdir -p "$fake"
  printf '%s\n' "$WS/lw/.git" >"$fake/gitdir"
  printf '../..\n' >"$fake/commondir"
  cp "$LW_MAIN/.git/HEAD" "$fake/HEAD"
  printf 'gitdir: %s\n' "$fake" >"$WS/lw/.git"
  run_hook "$@"
  local rc=$?
  rm -rf "$fake" "$WS/lw/.git"
  return $rc
}
assert_red "SR-L-8: a planted parent .git file cannot make main part of a linked worktree -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook_with_planted_parent "$WS/lw" "Write" "$LW_MAIN/apps/api/src/main.ts"

# SR-L-9: the removed allow #2 (/tmp cwd + agent-style branch) never looked at
# the target. Fixtures must really sit under /tmp, so they get their own dir.
TMP_WS="$(mktemp -d /tmp/zow-test.XXXXXX)"
trap 'rm -rf "$WS" "$TMP_WS"' EXIT
git clone -q "$LW_MAIN" "$TMP_WS/clone" >/dev/null 2>&1
git -C "$TMP_WS/clone" checkout -q -b fix/y >/dev/null 2>&1
git -C "$LW_MAIN" worktree add -q -b coder/x "$TMP_WS/linked" >/dev/null 2>&1
assert_red "SR-L-9: a non-linked /tmp clone on fix/y writing into another checkout's apps -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook "$TMP_WS/clone" "Write" "$LW_MAIN/apps/api/src/main.ts"

assert_green "SR-L-9: a linked worktree under /tmp on coder/x writing its own apps file -> allow" \
  --not-contains "BLOCK" \
  -- run_hook "$TMP_WS/linked" "Edit" "apps/api/src/main.ts"

# SO-M-1: the removed allow #3 (CLAUDE_AGENT_ID=coder) never looked at the target.
run_hook_as_coder() { CLAUDE_AGENT_ID=coder run_hook "$@"; }
assert_red "SO-M-1: a non-linked cwd with CLAUDE_AGENT_ID=coder writing into another checkout's apps -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "PRODUCTION-EDIT BLOCK" \
  -- run_hook_as_coder "$TMP_WS/clone" "Write" "$LW_MAIN/apps/api/src/x.ts"

assert_green "SO-M-1: a linked worktree with CLAUDE_AGENT_ID=coder writing its own apps file -> allow" \
  --not-contains "BLOCK" \
  -- run_hook_as_coder "$LW_A" "Write" "$LW_A/apps/api/src/x.ts"

guard_test_summary "test-pre-edit-write-zone-of-write.sh"
