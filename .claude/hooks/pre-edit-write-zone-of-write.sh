#!/usr/bin/env bash
# ECC stable id: pre:edit-write:zone-of-write
# Phase 2.5 — hardened ECC port of legacy .claude/hooks/block-production-edits.sh.
#
# Purpose: enforce that Edit/Write/MultiEdit/NotebookEdit on production zones
# (apps/**, packages/**) only happens from Coder-isolated subagent worktrees.
# PM/Architect/Legal/Reviewer sessions in main repo cwd are blocked — they
# must dispatch Coder via task-file.
#
# Contract:
#   - Reads tool-call JSON from stdin.
#   - Fast-exit (0) on non-Edit/Write tools.
#   - Fast-exit (0) on file paths outside apps/**, packages/**.
#   - exit 2 + JSON decision body on block.
#
# AGENT DETECTION (Phase 2.5 empirical finding):
#   Tested 2026-06-03 against Claude Code v2.1.148: `$CLAUDE_AGENT_ID` and
#   `$CLAUDE_SUBAGENT_TYPE` are NOT propagated by the runtime to hook
#   subshells. Only `CLAUDE_CODE_SESSION_ID` is reliably set. This makes the
#   env-var detection path a *dead branch* under current runtime, but we
#   keep it for forward-compat with future ECC plugin install.
#
#   Operational allow paths today (fail-closed by default — safer for
#   production zone gating):
#
# Allow conditions (any one):
#   0. cwd is itself inside a linked git worktree (git-dir != git-common-dir
#      AND `<toplevel>/.git` is a regular file) and the realpath-resolved
#      target is inside THAT worktree (else FM-2 refusal). Covers T3
#      worktrees. A main-checkout session writing into a linked worktree is
#      NOT allowed here; it falls through to #1-#4.
#   1. cwd contains `/.claude/worktrees/` (primary path — Coder/AutoTest
#      subagent worktree; this is how PM dispatches isolated work).
#   2. cwd starts with /tmp/ AND git branch matches `coder/*|feature/*|
#      fix/*|infra/*|test/*` (heuristic — manual `git worktree add /tmp/...`
#      with agent branch naming).
#   3. Env var `$CLAUDE_AGENT_ID == "coder"` (forward-compat — currently
#      unused per empirical finding above).
#   4. Escape hatch file `<repo>/.claude/.allow-direct-edits` (gitignored;
#      user-explicit opt-out for emergency edits).
#
# Default: deny (fail-closed). Better to surface a false-positive block
# (easy to unblock via escape hatch) than to silently allow a stray edit
# from PM/Architect/Legal sessions.

set -u

# SR-M-1: an inherited GIT_DIR / GIT_COMMON_DIR / GIT_WORK_TREE would steer every
# git call below (and make the main checkout look linked). Judge by cwd only.
for _v in $(compgen -e); do [[ $_v == GIT_* ]] && unset "$_v"; done

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || true)

# Fast exit: not a target tool.
case "$TOOL_NAME" in
  Edit|Write|MultiEdit|NotebookEdit) ;;
  *) exit 0 ;;
esac

FILE_PATH=$(echo "$INPUT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
ti = d.get('tool_input', {})
print(ti.get('file_path') or ti.get('notebook_path') or '')
" 2>/dev/null || true)

# Fast exit: no file path.
[ -z "$FILE_PATH" ] && exit 0

# Windows: the payload says C:\x while Git Bash $PWD says /c/x. Compare one form.
FILE_PATH=${FILE_PATH//\\//}
if [[ "$FILE_PATH" =~ ^([A-Za-z]):(/.*)$ ]]; then
  FILE_PATH="/$(printf '%s' "${BASH_REMATCH[1]}" | tr 'A-Z' 'a-z')${BASH_REMATCH[2]}"
elif [[ "$FILE_PATH" =~ ^[A-Za-z]:(.+)$ ]]; then
  # C:apps/x is relative to the cwd on drive C, so judge it as apps/x.
  FILE_PATH="${BASH_REMATCH[1]}"
fi

# Fast exit: file path is not in production zones — judged on the raw path AND
# on the resolved one (~, cwd, `..`, symlinks of the existing prefix; SR-L-1).
# Case-insensitive: Windows and macOS accept Apps/x as the same path as apps/x.
RESOLVED=$(python3 -c 'import os,sys; print(os.path.realpath(os.path.join(sys.argv[1], os.path.expanduser(sys.argv[2]))))' "$PWD" "$FILE_PATH" 2>/dev/null || true)
if ! printf '%s\n%s\n' "$FILE_PATH" "$RESOLVED" | grep -qiE '(^|/)(apps|packages)/'; then
  exit 0
fi

# FM-2 guard (2026-06-17, ADR 2026-06-16 follow-up #2): a worktree subagent
# must write ONLY inside its own worktree. The contamination class: an agent
# whose cwd is a worktree writes to an ABSOLUTE main-repo path
# (/…/CheekyCheeseIT_CRM/apps/…) — copied from codegraph output or a task-file
# main-repo path. Allow #1 below checks cwd (where the agent IS) but never the
# TARGET (where it writes), so it permitted these stray main writes (~5-6×/session,
# once flipping the user's live :3000 stack). Block when: cwd is a worktree,
# FILE_PATH is absolute + in apps/packages, but NOT under this worktree root.
# Note: lexical `..` is normalized first (else "$WT/../other/apps/x" lexically
# starts with "$WT/" and would slip through). Symlink-based escape is a residual
# edge (normpath does not resolve symlinks; realpath needs the file to exist,
# but Write targets may be new) — acceptable vs the observed abs-path class.
if echo "$PWD" | grep -q '/\.claude/worktrees/'; then
  WT_ABS=$(echo "$PWD" | sed -E 's#(.*/\.claude/worktrees/[^/]+).*#\1#')
  case "$FILE_PATH" in
    /*)
      NORM=$(printf '%s' "$FILE_PATH" | python3 -c "import posixpath,sys; print(posixpath.normpath(sys.stdin.read()))" 2>/dev/null || echo "$FILE_PATH")
      if echo "$NORM" | grep -qiE '(^|/)(apps|packages)/' && [ -n "$WT_ABS" ] && [[ "$NORM" != "$WT_ABS"/* ]]; then
        python3 -c "
import json, sys
file_path, wt = sys.argv[1], sys.argv[2]
reason = f'''🚫 WORKTREE→MAIN CONTAMINATION BLOCK (FM-2): worktree-агент пишет в {file_path},
который ВНЕ его worktree ({wt}).

Это класс инцидента FM-2: агент скопировал main-repo абсолютный путь (из codegraph /
task-файла) и пишет в MAIN-чекаут вместо своего worktree. ВСЕ Edit/Write — ВНУТРИ своего worktree.

Исправь путь: замени префикс на {wt}/… (твой worktree). Проверь cwd: `git -C \"{wt}\" status`.'''
print(json.dumps({'decision': 'block', 'reason': reason}))
" "$FILE_PATH" "$WT_ABS" 2>/dev/null
        echo "[pre:edit-write:zone-of-write] FM-2 BLOCK worktree=$WT_ABS target=$FILE_PATH" >&2
        exit 2
      fi
      ;;
  esac
fi

# Linked git worktrees (2026-11-08). The string check above knows only
# /.claude/worktrees/, so a T3 worktree (~/.t3/worktrees/<project>/t3-xxxx) was
# refused in its OWN tree. The gate protects the MAIN checkout, so it is
# decided by git (GIT_* stripped above) and by the resolved TARGET:
#   * cwd is a linked worktree -> the target must resolve inside it, else FM-2;
#   * anything else (main checkout, nested repo, no repo, error) -> fall through.
# A main-checkout session is never allowed into a linked worktree here (SR-M-3:
# a non-isolated reviewer would otherwise edit a live coder's tree).
# "Linked" also needs `<toplevel>/.git` to be a regular FILE (SR-M-2): Write can
# plant `<main>/.git/commondir`, but cannot turn the `.git` directory into a file.
# realpath resolves `..` and symlinks of the existing prefix (a new file is
# judged by its nearest existing parent). Any failure prints nothing and falls
# through to the old rules, which end in a refusal.
# SR-L-3 accepted: a symlink swapped between this check and the write (needs Bash) is not caught.
LW_VERDICT=$(python3 - "$PWD" "$FILE_PATH" <<'PY' 2>/dev/null || true
import os, subprocess, sys
cwd, target = sys.argv[1], sys.argv[2]

def checkout(path):
    """(toplevel, is_linked_worktree) of the git checkout holding path, or None."""
    d = path
    while not os.path.isdir(d):
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent
    r = subprocess.run(['git', '-C', d, 'rev-parse', '--path-format=absolute',
                        '--show-toplevel', '--git-dir', '--git-common-dir'],
                       capture_output=True, text=True, timeout=5)
    lines = r.stdout.splitlines()
    if r.returncode != 0 or len(lines) != 3 or not all(lines):
        return None
    top, git_dir, common_dir = (os.path.realpath(x) for x in lines)
    return top, git_dir != common_dir and os.path.isfile(os.path.join(top, '.git'))

def inside(p, root):
    return p == root or p.startswith(root + os.sep)

real_cwd = os.path.realpath(cwd)
t = os.path.realpath(os.path.join(real_cwd, os.path.expanduser(target)))
c = checkout(real_cwd)
if c and c[1]:
    print('ALLOW' if inside(t, c[0]) else 'FM2 ' + c[0])
else:
    print('NONE')
PY
)
case "$LW_VERDICT" in
  ALLOW) exit 0 ;;
  "FM2 "*)
    LW_ROOT=${LW_VERDICT#FM2 }
    python3 -c "
import json, sys
file_path, wt = sys.argv[1], sys.argv[2]
reason = f'''🚫 WORKTREE CONTAMINATION BLOCK (FM-2): this session runs in the linked worktree {wt},
but the edit target {file_path} resolves OUTSIDE it (another checkout, via an absolute path, '..' or a symlink).

Every Edit/Write goes INSIDE your own worktree. Fix the path: use the {wt}/… prefix. Check: git -C \"{wt}\" status'''
print(json.dumps({'decision': 'block', 'reason': reason}))
" "$FILE_PATH" "$LW_ROOT" 2>/dev/null
    echo "[pre:edit-write:zone-of-write] FM-2 BLOCK worktree=$LW_ROOT target=$FILE_PATH" >&2
    exit 2
    ;;
esac

# Allow #1: subagent worktree cwd (primary path).
if echo "$PWD" | grep -q '/\.claude/worktrees/'; then
  exit 0
fi

# Allow #2: /tmp/ worktree with agent-style branch naming (heuristic per
# Step 3 — fallback when CLAUDE_AGENT_ID is not propagated by runtime).
if echo "$PWD" | grep -qE '^/tmp/' ; then
  BRANCH_FOR_HEURISTIC=$(git branch --show-current 2>/dev/null || echo "")
  if echo "$BRANCH_FOR_HEURISTIC" | grep -qE '^(coder|feature|fix|infra|test)/'; then
    exit 0
  fi
fi

# Allow #3: explicit Coder agent-id (forward-compat; currently dead branch
# per empirical finding — runtime does not propagate this var as of
# Claude Code v2.1.148).
if [ "${CLAUDE_AGENT_ID:-}" = "coder" ]; then
  exit 0
fi

# Allow #4: escape hatch file.
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/.claude/.allow-direct-edits" ]; then
  exit 0
fi

# Block.
python3 -c "
import json, sys
file_path = sys.argv[1]
reason = f'''🚫 PRODUCTION-EDIT BLOCK: попытка править {file_path} из main-repo сессии (не Coder worktree).

PM/Architect/Legal/Reviewer не редактируют apps/** или packages/** напрямую — это работа Coder через task-файл.

Если ты НЕ Coder (например, user-сессия):
  1. Эскейп-хатч: touch \$REPO/.claude/.allow-direct-edits  (gitignored)
  2. Или работа через worktree: git worktree add /tmp/work main
  3. Или сними этот hook в .claude/settings.json временно

Если ты PM/Architect:
  — Создай task-файл по шаблону .claude/tasks/templates/task.md.tpl
  — Запусти Coder через skill pm-dispatching'''
print(json.dumps({'decision': 'block', 'reason': reason}))
" "$FILE_PATH" 2>/dev/null

echo "[pre:edit-write:zone-of-write] BLOCK path=$FILE_PATH cwd=$PWD" >&2
exit 2
