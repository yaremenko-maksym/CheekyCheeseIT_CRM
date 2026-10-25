#!/usr/bin/env bash
# test-pre-bash-rtk-exec-gate.sh — proves .claude/hooks/pre-bash-rtk-exec-gate.sh refuses every typed form of
# "run a command THROUGH rtk" (bypass / proxy / err / test / run / summary, quoted operand included) and stays
# silent on everything else, including the tool subcommands pre:bash:rtk-rewrite itself produces.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"
HOOK="$REPO_ROOT/.claude/hooks/pre-bash-rtk-exec-gate.sh"
echo "== test-pre-bash-rtk-exec-gate.sh =="
echo
if ! bash -n "$HOOK" 2>/dev/null; then
  echo "FATAL: syntax error in $HOOK"
  bash -n "$HOOK"
  exit 1
fi

run_hook() {
  python3 -c 'import json,sys; print(json.dumps({"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":sys.argv[1]}}))' "$1" | bash "$HOOK"
}

# ── refusals: the contract body must be present (a bash syntax error also exits 2) ──
for cmd in \
  "rtk bypass rm -rf /etc" \
  "rtk proxy ls" \
  "rtk err ls" \
  "rtk test echo hi" \
  "rtk run echo hi" \
  "rtk summary ls" \
  "rtk -v bypass ls" \
  "rtk --skip-env run ls" \
  "rtk run 'pkill -f main || true'" \
  "rtk bypass 'git worktree remove --force x;'" \
  "rtk run \"vite\"" \
  "rtk test --shell sh 'pnpm dev'" \
  "/home/u/.local/bin/rtk bypass ls" \
  "sudo rtk err ls" \
  "echo ok; rtk summary ls" \
  "echo ok && rtk run ls" \
  "x | rtk test cat" \
  "rtk'' run ls" \
  "rtk \\
run ls" \
  "rtk	test	ls"; do
  assert_red "refuses: $cmd" \
    --contains '"decision": "block"' \
    -- run_hook "$cmd"
done

# ── silence: tool subcommands, rtk's own utilities, RTK_DISABLED, plain commands ──
for cmd in \
  "rtk git status" \
  "rtk git add a && rtk git commit -m x" \
  "rtk pnpm --filter @crm/api test" \
  "rtk grep -rn test ." \
  "rtk gain" \
  "rtk --version" \
  "rtk hook claude" \
  "rtk init --show" \
  "RTK_DISABLED=1 git diff" \
  "git status" \
  "pnpm test" \
  "echo hello" \
  "grep -rn rtk ." \
  "cat nortk-run.txt"; do
  assert_green "allows: $cmd" \
    --not-contains '"decision"' \
    -- run_hook "$cmd"
done

# ── fail-open: garbage input must never become a block ──
assert_green "garbage stdin is allowed (fail-open)" \
  --not-contains '"decision"' \
  -- bash -c 'printf "%s" "not json" | bash "$0"' "$HOOK"

guard_test_summary "test-pre-bash-rtk-exec-gate.sh"
