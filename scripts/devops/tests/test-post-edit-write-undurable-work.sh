#!/usr/bin/env bash
# test-post-edit-write-undurable-work.sh — proves
# .claude/hooks/post-edit-write-undurable-work.sh demands a commit+push exactly
# in the state where a watchdog cut costs everything rather than a re-read, and
# stays silent everywhere else.
#
# The cases are built as throwaway git repositories under a path containing
# `.claude/worktrees/`, because that substring IS the hook's first predicate.
# The workspace is handed to the hook through the payload's `cwd` field (the
# same field pre:bash:devserver-ttl-gate reads), so no real agent has to be
# stood up to watch this go red.
#
# WHAT THE RED CASE IS WORTH: on 2026-10-20 an agent thought for a long stretch
# and then composed a 231-line workflow file in one tool call. It had committed
# nothing, the harness removed the worktree it judged unchanged, and the work
# was gone — not delayed. This hook is the one mechanical thing standing in
# that spot, so a green-only test here would be worth nothing.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

HOOK="$REPO_ROOT/.claude/hooks/post-edit-write-undurable-work.sh"

echo "== test-post-edit-write-undurable-work.sh =="
echo

if ! bash -n "$HOOK" 2>/dev/null; then
  echo "FATAL: syntax error in $HOOK"
  bash -n "$HOOK"
  exit 1
fi

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/undurable-work-test.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

# Builds a throwaway repo and echoes its path.
#   $1 = directory name under the fake worktrees root
#   $2 = how many lines of UNCOMMITTED work to leave in it
#   $3 = "own-commit" to also leave a commit of its own on the branch
make_ws() {
  local name="$1" lines="$2" mode="${3:-none}"
  local ws="$TMP_ROOT/.claude/worktrees/$name"
  mkdir -p "$ws"
  (
    cd "$ws" || exit 1
    git init -q -b main .
    git config user.email t@t.t
    git config user.name t
    echo base >base.txt
    git add base.txt
    git commit -q -m "base"
    git checkout -q -b "agent/$name"
    if [ "$mode" = "own-commit" ]; then
      echo durable >durable.txt
      git add durable.txt
      git commit -q -m "wip: durable"
    fi
    if [ "$lines" -gt 0 ]; then
      i=0
      while [ "$i" -lt "$lines" ]; do
        echo "line $i" >>composed.txt
        i=$((i + 1))
      done
    fi
  ) >/dev/null 2>&1
  printf '%s' "$ws"
}

# $1 = cwd to report in the payload
run_hook() {
  printf '{"hook_event_name":"PostToolUse","tool_name":"Write","cwd":"%s"}' "$1" |
    bash "$HOOK" 2>&1
}

WS_BIG=$(make_ws big 231)
WS_SMALL=$(make_ws small 42)
WS_COMMITTED=$(make_ws committed 231 own-commit)

OUTSIDE="$TMP_ROOT/plain-checkout"
mkdir -p "$OUTSIDE"
(
  cd "$OUTSIDE" || exit 1
  git init -q -b main .
  git config user.email t@t.t
  git config user.name t
  echo base >base.txt
  git add base.txt
  git commit -q -m base
  git checkout -q -b agent/outside
  i=0
  while [ "$i" -lt 231 ]; do
    echo "line $i" >>composed.txt
    i=$((i + 1))
  done
) >/dev/null 2>&1

# ── the refusal ───────────────────────────────────────────────────────────────

assert_red "231 uncommitted lines, no commit of its own -> demand commit+push (the 2026-10-20 loss)" \
  --contains "UNDURABLE WORK" \
  --contains "git push" \
  -- run_hook "$WS_BIG"

assert_red "the demand names the branch to push, so the fix is copy-pasteable" \
  --contains "push -u origin agent/big" \
  -- run_hook "$WS_BIG"

assert_red "the demand states WHY now: silence, and a workspace the harness may remove" \
  --contains "600 s" \
  --contains "judges unchanged" \
  -- run_hook "$WS_BIG"

assert_red "threshold is a threshold: UNDURABLE_LINES=10 fires on 42 lines too" \
  --contains "UNDURABLE WORK" \
  -- env UNDURABLE_LINES=10 bash -c 'printf "{\"cwd\":\"$1\"}" | bash "$0"' "$HOOK" "$WS_SMALL"

# ── the silences (each one is a false positive this hook must not produce) ────

assert_green "42 uncommitted lines is under the threshold -> silent" \
  --not-contains "UNDURABLE WORK" \
  -- run_hook "$WS_SMALL"

assert_green "a commit of its own already exists -> silent for the rest of the session" \
  --not-contains "UNDURABLE WORK" \
  -- run_hook "$WS_COMMITTED"

assert_green "a checkout outside .claude/worktrees (orchestrator / owner) -> never fires" \
  --not-contains "UNDURABLE WORK" \
  -- run_hook "$OUTSIDE"

assert_green "a path that is not a git repository at all -> silent" \
  --not-contains "UNDURABLE WORK" \
  -- run_hook "$TMP_ROOT/.claude/worktrees/does-not-exist"

assert_green "no cwd in the payload and no worktree in \$PWD -> silent" \
  --not-contains "UNDURABLE WORK" \
  -- bash -c 'printf "{}" | bash "$0"' "$HOOK"

guard_test_summary "test-post-edit-write-undurable-work.sh"
