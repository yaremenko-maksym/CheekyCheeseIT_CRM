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
#   subshells. Only `CLAUDE_CODE_SESSION_ID` is reliably set. The env-var
#   allow built on it was removed 2026-11-08 (SO-M-1: target-blind; an env
#   var says who is writing, never where).
#
#   Operational allow paths today (fail-closed by default — safer for
#   production zone gating):
#
# Allow conditions (any one):
#   0. cwd is itself inside a linked git worktree (git-dir is
#      `<git-common-dir>/worktrees/<name>`, `<toplevel>/.git` is a regular
#      file, no core.worktree) and the realpath-resolved
#      target is inside THAT worktree (else FM-2 refusal). Covers T3
#      worktrees and Agent `isolation:"worktree"` trees under
#      `.claude/worktrees/` (both are linked worktrees). A main-checkout session
#      writing into a linked worktree is NOT allowed here; it falls through to #4.
#      The target's own checkout (git, run from the target's nearest existing
#      directory) must have the SAME toplevel as the cwd's: a linked worktree
#      nested inside another one is a different tree (SR-L-7), and a planted
#      `<parent>/.git` above main does not make main part of it (SR-L-8).
#   1. (removed 2026-11-08) the `/.claude/worktrees/` cwd string match. It let a
#      plain, non-linked directory there write into main via `..`, a symlink, or
#      a failed check #0 (PR #1297 second opinion F1-F3); #0 covers real ones.
#   2. (removed 2026-11-08) a /tmp/ cwd on a `coder|feature|fix|infra|test/*`
#      branch. It never looked at the target, so a /tmp clone could write into
#      main (SR-L-9); real /tmp agent worktrees are linked and covered by #0.
#   3. (removed 2026-11-08) `$CLAUDE_AGENT_ID == "coder"`. Also target-blind
#      (SO-M-1), and the runtime never set it (empirical finding above).
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

FILE_PATH_ERR=0
FILE_PATH=$(printf '%s' "$INPUT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
ti = d.get('tool_input', {})
p = ti.get('file_path') or ti.get('notebook_path') or ''
sys.stdout.buffer.write(p.encode('utf-8', 'surrogateescape'))
" 2>/dev/null) || FILE_PATH_ERR=$?

if [ "$FILE_PATH_ERR" -ne 0 ]; then
  python3 -c "
import json, sys
tool = sys.argv[1]
reason = f'''🚫 UNPARSABLE PATH BLOCK (SR-L-4): cannot extract a valid file_path from {tool} payload.

Failed-closed: when Edit/Write/MultiEdit/NotebookEdit targets an unparsable path (e.g. invalid surrogate encoding), the edit is blocked to protect production zones.'''
print(json.dumps({'decision': 'block', 'reason': reason}))
" "$TOOL_NAME" 2>/dev/null
  echo "[pre:edit-write:zone-of-write] BLOCK unparsable file_path tool=$TOOL_NAME" >&2
  exit 2
fi

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
# on the resolved one (~, cwd, `..`, symlinks of the existing prefix; SR-L-1, SR-L-5).
# Case-insensitive: Windows and macOS accept Apps/x as the same path as apps/x.
# LC_ALL=C: macOS grep under a UTF-8 locale skips a line with an invalid byte (SR-L-6).
# Raw bytes out (surrogateescape): print() raises on a non-UTF-8 byte (F4). An
# empty RESOLVED means python failed: do not fast-exit, run the checks (fail closed).
RESOLVED=$(python3 -c 'import os,sys; sys.stdout.buffer.write(os.path.realpath(os.path.normpath(os.path.join(sys.argv[1], os.path.expanduser(sys.argv[2])))).encode("utf-8", "surrogateescape"))' "$PWD" "$FILE_PATH" 2>/dev/null || true)
if [ -n "$RESOLVED" ] && ! printf '%s\n%s\n' "$FILE_PATH" "$RESOLVED" | LC_ALL=C grep -qiE '(^|/)(apps|packages)/'; then
  exit 0
fi

# Linked git worktrees (2026-11-08). FM-2 (2026-06-17): a worktree agent writes
# ONLY inside its own worktree; the incident class is an absolute main-repo path
# copied from codegraph output or a task file. The old check matched the string
# /.claude/worktrees/ in $PWD, so a T3 worktree (~/.t3/worktrees/<project>/t3-xxxx)
# was refused in its OWN tree, and a plain directory there escaped via '..' or a
# symlink. The gate protects the MAIN checkout, so it is decided by git (GIT_*
# stripped above) and by the resolved TARGET:
#   * cwd is a linked worktree -> the target's own checkout must be that same
#     worktree (same realpath toplevel, judged by git from the target side), else FM-2;
#   * anything else (main checkout, nested repo, no repo, error) -> fall through.
# A main-checkout session is never allowed into a linked worktree here (SR-M-3:
# a non-isolated reviewer would otherwise edit a live coder's tree).
# "Linked" also needs `<toplevel>/.git` to be a regular FILE (SR-M-2): Write can
# plant `<main>/.git/commondir`, but cannot turn the `.git` directory into a file.
# git-dir must be `<common>/worktrees/<name>`, and core.worktree must be unset
# (a per-worktree core.worktree widens the toplevel to a parent over main).
# realpath resolves `..` and symlinks of the existing prefix (a new file is
# judged by its nearest existing parent). Any failure prints nothing and falls
# through to the #4 escape-hatch file, then the refusal (no cwd- or env-based allow remains).
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
    # core.worktree (set via a Write into the gitdir) can move the toplevel to a parent dir.
    cw = subprocess.run(['git', '-C', d, 'config', '--get', 'core.worktree'],
                        capture_output=True, text=True, timeout=5)
    if cw.returncode != 1:
        return None
    top, git_dir, common_dir = (os.path.realpath(x) for x in lines)
    linked = (os.path.dirname(git_dir) == os.path.join(common_dir, 'worktrees')
              and os.path.isfile(os.path.join(top, '.git')))
    return top, linked

def inside(p, root):
    return p == root or p.startswith(root + os.sep)

real_cwd = os.path.realpath(cwd)
t = os.path.realpath(os.path.normpath(os.path.join(real_cwd, os.path.expanduser(target))))
c = checkout(real_cwd)
if c and c[1]:
    # SR-L-7/8: a prefix check is not enough; the target must be in THIS checkout.
    tc = checkout(t)
    print('ALLOW' if inside(t, c[0]) and tc and tc[0] == c[0] else 'FM2 ' + c[0])
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
