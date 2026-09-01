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
    echo seed >README.md
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
