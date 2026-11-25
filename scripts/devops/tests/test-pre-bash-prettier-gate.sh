#!/usr/bin/env bash
# test-pre-bash-prettier-gate.sh — proves .claude/hooks/pre-bash-prettier-gate.sh
# refuses a push whose changed files are not formatted, AND refuses just as
# loudly when it cannot check at all, BY EXECUTION against fake repos.
#
# WHY IT HAD NO TEST UNTIL 2026-09-01: the meta-guard
# scripts/devops/check-guard-tests-exist.sh took its inventory from
# `scripts/devops/check-*`, so no hook in .claude/hooks/ was ever inside it.
# It reads .claude/settings.json now, and this was one of the four gaps that
# surfaced immediately.
#
# THE CASE THAT MATTERS MOST IS THE SECOND KIND OF RED. This hook's whole
# reason for existing is that the husky pre-commit hook SILENTLY does nothing in
# a fresh `isolation=worktree` worktree (no node_modules => no .husky/_ => git
# skips it without a word), and unformatted commits shipped to CI three times
# (#259 / #261 / #263). A formatter gate that silently skips when it cannot find
# a formatter would reproduce that exact defect one layer up, so "prettier is
# unreachable" must BLOCK, not pass. That is asserted below, and it is the case
# a green-only test would never have looked at.
#
# Real prettier is never invoked: a shim at node_modules/.bin/prettier reports
# whatever the case needs. What is under test is the hook's decision tree, not
# prettier's opinion about a semicolon.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

HOOK="$REPO_ROOT/.claude/hooks/pre-bash-prettier-gate.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

echo "== test-pre-bash-prettier-gate.sh =="
echo

if ! bash -n "$HOOK" 2>/dev/null; then
  echo "FATAL: syntax error in $HOOK"
  bash -n "$HOOK"
  exit 1
fi

unset CLAUDE_PROJECT_DIR # the hook skips other repos only when it is set; cases set it explicitly

# ── fixtures ───────────────────────────────────────────────────────────────────
# $1 = dir name, $2 = branch, $3 = file to add on the branch.
# The repo has a local `main`; the hook falls back to it when origin/main is
# absent, which is exactly the offline-worktree situation it ships for.
make_repo() {
  local root="$WS/$1" branch="$2" file="$3"
  mkdir -p "$root"
  (
    cd "$root" || exit 1
    git init -q -b main
    git config user.email test@example.invalid
    git config user.name "guard test"
    git config commit.gpgsign false
    echo "seed $1" >README.md # unique root commit per fixture repo
    git add README.md
    git commit -q -m init
    if [ "$branch" != "main" ]; then
      git checkout -q -b "$branch"
    fi
    mkdir -p "$(dirname "$file")"
    echo "export const x = 1" >"$file"
    git add "$file"
    git commit -q -m "add $file"
  ) >/dev/null 2>&1
  printf '%s' "$root"
}

# A prettier that always reports $1 as its exit code, placed exactly where the
# hook looks first (this worktree's own node_modules/.bin).
install_prettier_shim() {
  local root="$1" code="$2"
  mkdir -p "$root/node_modules/.bin"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'echo "[shim prettier] $*" >&2\n'
    printf 'exit %s\n' "$code"
  } >"$root/node_modules/.bin/prettier"
  chmod +x "$root/node_modules/.bin/prettier"
}

run_hook() {
  local root="$1" cmd="${2:-git push -u origin HEAD}"
  local json
  json=$(python3 -c 'import json,sys; print(json.dumps({"tool_name":"Bash","tool_input":{"command":sys.argv[1]}}))' "$cmd")
  (cd "$root" && printf '%s' "$json" | bash "$HOOK")
}

# Same, with PATH stripped down so that neither prettier nor pnpm can be found.
# This is how the "cannot check at all" branch is reached deterministically.
run_hook_bare_path() {
  local root="$1"
  local json
  json=$(python3 -c 'import json,sys; print(json.dumps({"tool_name":"Bash","tool_input":{"command":"git push"}}))')
  (cd "$root" && printf '%s' "$json" | PATH="/usr/bin:/bin" bash "$HOOK")
}

# ── fast no-ops ────────────────────────────────────────────────────────────────
NOOP="$(make_repo noop feat/x apps/web/x.ts)"
install_prettier_shim "$NOOP" 0

assert_green "a non-'git push' command is a silent no-op" \
  --not-contains "pre:bash:prettier-gate" \
  -- run_hook "$NOOP" "ls -la"

assert_green "'git push --help' is a no-op" \
  --not-contains "pre:bash:prettier-gate" \
  -- run_hook "$NOOP" "git push --help"

MAIN_REPO="$(make_repo on-main main apps/web/x.ts)"
install_prettier_shim "$MAIN_REPO" 1
assert_green "pushing from main is a no-op (we never push there directly)" \
  --not-contains "pre:bash:prettier-gate" \
  -- run_hook "$MAIN_REPO"

NO_FORMATTABLE="$(make_repo no-formattable feat/x docs/notes.txt)"
install_prettier_shim "$NO_FORMATTABLE" 1
assert_green "a branch that changed no formattable file is a no-op even with prettier failing" \
  --not-contains "pre:bash:prettier-gate" \
  -- run_hook "$NO_FORMATTABLE"

FOREIGN="$(make_repo foreign feat/x docs/guide.md)"
install_prettier_shim "$FOREIGN" 1
OWN_PROJECT="$(make_repo own-project feat/y docs/guide.md)"
assert_green "a push from another repository than the session's project is a no-op" \
  --not-contains "pre:bash:prettier-gate" \
  -- env CLAUDE_PROJECT_DIR="$OWN_PROJECT" bash -c "$(declare -f run_hook); HOOK='$HOOK'; run_hook '$FOREIGN'"

SAME_REPO_WT="$WS/dirty-wt"
DIRTY_WT_BASE="$(make_repo dirty-wt-base feat/z apps/web/x.ts)"
(cd "$DIRTY_WT_BASE" && git worktree add -q -b feat/wt "$SAME_REPO_WT" feat/z) >/dev/null 2>&1
install_prettier_shim "$SAME_REPO_WT" 1
assert_red "a worktree of the session's own repository is still gated" \
  --contains '"decision": "block"' \
  -- env CLAUDE_PROJECT_DIR="$DIRTY_WT_BASE" bash -c "$(declare -f run_hook); HOOK='$HOOK'; run_hook '$SAME_REPO_WT'"

NOT_A_REPO="$WS/not-a-repo"; mkdir -p "$NOT_A_REPO"
DIRTY_NR="$(make_repo dirty-nr feat/x apps/web/x.ts)"
install_prettier_shim "$DIRTY_NR" 1
assert_red "CLAUDE_PROJECT_DIR that git cannot resolve -> enforce, never skip" \
  --contains '"decision": "block"' \
  -- env CLAUDE_PROJECT_DIR="$NOT_A_REPO" bash -c "$(declare -f run_hook); HOOK='$HOOK'; run_hook '$DIRTY_NR'"

CLONE_SRC="$(make_repo clone-src feat/c apps/web/x.ts)"
SECOND_CLONE="$WS/second-clone"
git clone -q "$CLONE_SRC" "$SECOND_CLONE" >/dev/null 2>&1 # origin = a local path, unlike the source's
(cd "$SECOND_CLONE" && git checkout -q feat/c) >/dev/null 2>&1
install_prettier_shim "$SECOND_CLONE" 1
assert_red "a second clone of the same repository (any origin spelling) is still gated" \
  --contains '"decision": "block"' \
  -- env CLAUDE_PROJECT_DIR="$CLONE_SRC" bash -c "$(declare -f run_hook); HOOK='$HOOK'; run_hook '$SECOND_CLONE'"

DEEP_SRC="$(make_repo deep-src feat/d apps/web/x.ts)"
# main gets a second commit and feat/d sits on it, so a depth-2 clone holds the
# merge-base (main's tip) but not the real root: its reported root is the cut-off.
# (--no-single-branch would fetch main at depth 2 too, which reaches the real root.)
(cd "$DEEP_SRC" && git checkout -q main && echo more >>README.md && git commit -qam more \
  && git checkout -q feat/d && git rebase -q main) >/dev/null 2>&1
SHALLOW="$WS/shallow-clone"
git clone -q --depth 2 --single-branch --branch feat/d "file://$DEEP_SRC" "$SHALLOW" >/dev/null 2>&1
(cd "$SHALLOW" && git branch -q main HEAD~1) >/dev/null 2>&1 # main = the cut-off commit
install_prettier_shim "$SHALLOW" 1
assert_red "a shallow clone of the same repository (cut-off root) is still gated" \
  --contains '"decision": "block"' \
  -- env CLAUDE_PROJECT_DIR="$DEEP_SRC" bash -c "$(declare -f run_hook); HOOK='$HOOK'; run_hook '$SHALLOW'"

# The session project itself may be a shallow clone (the owner's main checkout is).
# Its parentless commits are then cut-off commits, and identity is containment:
# a foreign repo holds none of them, a full clone of the same repo holds them all.
PROJ_SRC="$(make_repo proj-src feat/p apps/web/x.ts)"
(cd "$PROJ_SRC" && git checkout -q main && echo more >>README.md && git commit -qam more \
  && git checkout -q feat/p && git rebase -q main) >/dev/null 2>&1
SHALLOW_PROJECT="$WS/shallow-project"
git clone -q --depth 1 --single-branch --branch feat/p "file://$PROJ_SRC" "$SHALLOW_PROJECT" >/dev/null 2>&1
FOREIGN_TO_SHALLOW="$(make_repo foreign-to-shallow feat/x apps/web/x.ts)"
install_prettier_shim "$FOREIGN_TO_SHALLOW" 1
assert_green "a foreign repo is a no-op even when the session project is a shallow clone" \
  --not-contains "pre:bash:prettier-gate" \
  -- env CLAUDE_PROJECT_DIR="$SHALLOW_PROJECT" bash -c "$(declare -f run_hook); HOOK='$HOOK'; run_hook '$FOREIGN_TO_SHALLOW'"

install_prettier_shim "$PROJ_SRC" 1 # PROJ_SRC = a full clone holding the project's cut-off commit
assert_red "a full clone of the same repository is gated when the session project is shallow" \
  --contains '"decision": "block"' \
  -- env CLAUDE_PROJECT_DIR="$SHALLOW_PROJECT" bash -c "$(declare -f run_hook); HOOK='$HOOK'; run_hook '$PROJ_SRC'"

# A full clone taken BEFORE the shallow project's cut-off commit lacks that commit;
# only the pinned REPO_ROOT_COMMIT identifies it. The hook pins this repo's root, so
# the case runs a copy of the hook pinned to the fixture's root instead.
STALE_SRC="$(make_repo stale-src feat/s apps/web/x.ts)"
STALE_CLONE="$WS/stale-clone"
git clone -q "$STALE_SRC" "$STALE_CLONE" >/dev/null 2>&1
(cd "$STALE_CLONE" && git checkout -q feat/s) >/dev/null 2>&1
(cd "$STALE_SRC" && echo newer >>README.md && git commit -qam newer) >/dev/null 2>&1
STALE_PROJECT="$WS/stale-project"
git clone -q --depth 1 --single-branch --branch feat/s "file://$STALE_SRC" "$STALE_PROJECT" >/dev/null 2>&1
STALE_ROOT=$(cd "$STALE_SRC" && git rev-list --max-parents=0 HEAD)
PINNED_HOOK="$WS/pinned-hook.sh"
sed "s/^REPO_ROOT_COMMIT=[0-9a-f]*/REPO_ROOT_COMMIT=$STALE_ROOT/" "$HOOK" >"$PINNED_HOOK"
install_prettier_shim "$STALE_CLONE" 1
assert_red "a stale full clone (older than the shallow project's cut-off) is still gated" \
  --contains '"decision": "block"' \
  -- env CLAUDE_PROJECT_DIR="$STALE_PROJECT" bash -c "$(declare -f run_hook); HOOK='$PINNED_HOOK'; run_hook '$STALE_CLONE'"

# ── the formatted / unformatted decision ──────────────────────────────────────

CLEAN="$(make_repo clean feat/x apps/web/x.ts)"
install_prettier_shim "$CLEAN" 0
assert_green "prettier --check passes -> push allowed" \
  --not-contains "BLOCK" \
  -- run_hook "$CLEAN"

DIRTY="$(make_repo dirty feat/x apps/web/x.ts)"
install_prettier_shim "$DIRTY" 1
# Note on what is asserted here: the reason text is Russian, and json.dumps
# escapes non-ASCII, so the body carries `из...` rather than the words
# themselves. Anchoring on Cyrillic substrings would fail against a hook that is
# working perfectly. The ASCII anchors below (`--write`, the branch name on the
# stderr line) are the parts that survive the encoding and are the parts an
# agent actually needs: which command fixes it, and on which branch.
assert_red "prettier --check fails -> BLOCK naming the branch and the exact fix command" \
  --contains '"decision": "block"' \
  --contains "PRE-PUSH BLOCK" \
  --contains "--write" \
  --contains "[pre:bash:prettier-gate] BLOCK branch=feat/x" \
  -- run_hook "$DIRTY"

DIRTY_MD="$(make_repo dirty-md feat/x docs/guide.md)"
install_prettier_shim "$DIRTY_MD" 1
assert_red "markdown counts as formattable too -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$DIRTY_MD"

# ── THE ONE THAT MATTERS: cannot check => refuse, never silent-skip ───────────

NO_FORMATTER="$(make_repo no-formatter feat/x apps/web/x.ts)"
# Deliberately NO shim installed: this worktree has no node_modules, which is
# the default state of a fresh isolation=worktree checkout.
assert_red "prettier unreachable -> BLOCK (fail loud), never a quiet pass" \
  --contains '"decision": "block"' \
  --contains "PRE-PUSH BLOCK" \
  -- run_hook_bare_path "$NO_FORMATTER"

guard_test_summary "test-pre-bash-prettier-gate.sh"
