#!/usr/bin/env bash
# test-pre-bash-unbounded-wait.sh — proves .claude/hooks/pre-bash-unbounded-wait.sh
# refuses the wait shapes that kept tasks "Running" for hours (three incidents,
# 2026-09-21 / 09-24 / 09-25), and stays silent on legitimate look-alikes.
#
# A REFUSAL IS THE DECISION BODY, NOT THE EXIT CODE. Every red case below also
# requires `"decision": "block"` on stdout. bash exits 2 on a syntax error too,
# and a hook that died on parsing once "passed" every blocking case of the
# cross-agent smoke while doing nothing (.claude/rules/common/agent-isolation.md,
# "Проверка гейтов"). The `bash -n` pre-check below makes the same point from
# the other side: a broken hook fails this file loudly, before any case runs.
#
# Nothing here executes any of the commands under test: each one is handed to
# the hook as the text of a tool call, which is exactly what it sees in
# production. The incident commands are reproduced with their real shape; only
# paths are shortened.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

HOOK="$REPO_ROOT/.claude/hooks/pre-bash-unbounded-wait.sh"

echo "== test-pre-bash-unbounded-wait.sh =="
echo

if ! bash -n "$HOOK" 2>/dev/null; then
  echo "FATAL: syntax error in $HOOK"
  bash -n "$HOOK"
  exit 1
fi

run_hook() {
  local json
  json=$(python3 -c 'import json,sys; print(json.dumps({"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"/fake/repo/.claude/worktrees/agent-MINE","tool_input":{"command":sys.argv[1]}}))' "$1")
  printf '%s' "$json" | bash "$HOOK"
}

run_hook_reason() {
  run_hook "$1" 2>/dev/null | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("reason", ""))
except Exception:
    pass'
}

TASKS="/private/tmp/claude-501/proj/sess/tasks"
NL=$'\n'

# ── the three incidents, as they were written ─────────────────────────────────

assert_red "2026-09-24: until-loop grepping for a Stryker line that never comes -> BLOCK" \
  --contains '"decision": "block"' --contains 'UNBOUNDED-LOOP' \
  -- run_hook 'until [ -f /tmp/m/stryker.log ] && grep -qE "^Mutation testing 100%|^Ran [0-9]+ mutant|clear-text-reporter" /tmp/m/stryker.log; do sleep 20; done'

assert_red "2026-09-25: until-loop waiting for tasks/<id>.status (never written) -> BLOCK" \
  --contains '"decision": "block"' --contains 'UNREACHABLE-TASK-FILE' \
  -- run_hook "until [ -f $TASKS/b8x2k.status ]; do sleep 30; done; cat $TASKS/b8x2k.output"

assert_red "2026-09-25: until-loop waiting for tasks/<id>.exit (never written) -> BLOCK" \
  --contains '"decision": "block"' --contains 'UNREACHABLE-TASK-FILE' \
  -- run_hook "until [ -f $TASKS/b8x2k.exit ]; do sleep 30; done"

assert_red "2026-09-21: bare \`cat\` in a compound command waits on stdin forever -> BLOCK" \
  --contains '"decision": "block"' --contains 'STDIN-CAT' \
  -- run_hook 'for f in a.ts b.ts; do grep -ho "t(\"[^\"]*\")" "$f"; done; cat | sort | uniq -c | wc -l'

# Why that `cat` hung at all: the harness appends `< /dev/null` to a command
# UNLESS the command contains a heredoc (or its own `<`) — then stdin is the
# harness pipe, never closed. This is the shape where bare `cat` really hangs.
assert_red "bare \`cat\` in a command that also has a heredoc (stdin never closed) -> BLOCK" \
  --contains '"decision": "block"' --contains 'STDIN-CAT' \
  -- run_hook "python3 - <<'EOF' > /tmp/slices.txt${NL}print('x')${NL}EOF${NL}cat | sort | uniq -c"

# CR-H-1 (PR #719 review): the bash pre-filter did not list `for`, so a `for`
# loop — the very form the refusal message recommends — waiting on a task file
# the harness never writes went straight past the analyzer.
assert_red "for-loop waiting on tasks/<id>.status -> BLOCK (pre-filter must admit \`for\`)" \
  --contains '"decision": "block"' --contains 'UNREACHABLE-TASK-FILE' \
  -- run_hook "for i in \$(seq 1 100); do [ -f $TASKS/x.status ] && break; sleep 5; done"

assert_red "select-loop naming tasks/<id>.exit -> BLOCK (every loop keyword is pre-filtered)" \
  --contains '"decision": "block"' --contains 'UNREACHABLE-TASK-FILE' \
  -- run_hook "select x in a b; do [ -f $TASKS/x.exit ] && break; done"

# CR-M-1 (PR #719 review): the deadline / counter only appears in a log line;
# the exit depends on an unrelated file. Both loops wait for ever and passed.
assert_red "\$SECONDS only LOGGED, break gated by an unrelated file -> BLOCK" \
  --contains '"decision": "block"' --contains 'UNBOUNDED-LOOP' \
  -- run_hook 'while true; do echo "elapsed=$SECONDS"; if [ -f /tmp/cancel ]; then break; fi; sleep 5; done'

assert_red "counter only LOGGED, break gated by an unrelated file -> BLOCK" \
  --contains '"decision": "block"' --contains 'UNBOUNDED-LOOP' \
  -- run_hook 'n=0; while true; do n=$((n+1)); echo "poll #$n"; if [ -f /tmp/cancel ]; then break; fi; sleep 5; done'

# ── the same family in other spellings ────────────────────────────────────────

assert_red "task-file wait is refused even WITH a deadline (condition is unreachable)" \
  --contains '"decision": "block"' --contains 'UNREACHABLE-TASK-FILE' \
  -- run_hook "SECONDS=0; until [ -f $TASKS/x.status ] || [ \$SECONDS -ge 600 ]; do sleep 5; done"

assert_red "while true + break on a file, no bound -> BLOCK" \
  --contains '"decision": "block"' --contains 'UNBOUNDED-LOOP' \
  -- run_hook 'while true; do [ -f /tmp/done ] && break; sleep 5; done'

assert_red "waiting on a PID with sleep, no bound -> BLOCK (the process may never exit)" \
  --contains '"decision": "block"' --contains 'UNBOUNDED-LOOP' \
  -- run_hook 'while kill -0 "$PID" 2>/dev/null; do sleep 5; done'

assert_red "multi-line until-loop (newlines, not semicolons) -> BLOCK" \
  --contains '"decision": "block"' --contains 'UNBOUNDED-LOOP' \
  -- run_hook "until curl -sf http://localhost:3001/health${NL}do${NL}  sleep 2${NL}done"

assert_red "per-iteration timeout does not bound the LOOP -> BLOCK" \
  --contains '"decision": "block"' --contains 'UNBOUNDED-LOOP' \
  -- run_hook 'until timeout 5 curl -sf http://localhost:3001/health; do sleep 2; done'

assert_red "loop hidden inside bash -c '...' -> BLOCK" \
  --contains '"decision": "block"' --contains 'UNBOUNDED-LOOP' \
  -- run_hook "bash -c 'until [ -f /tmp/x ]; do sleep 1; done'"

assert_red "loop inside nohup sh -c \"...\" & -> BLOCK" \
  --contains '"decision": "block"' --contains 'UNBOUNDED-LOOP' \
  -- run_hook 'nohup sh -c "until [ -f /tmp/x ]; do sleep 5; done" >/dev/null 2>&1 &'

assert_red "loop inside an if-branch -> BLOCK" \
  --contains '"decision": "block"' --contains 'UNBOUNDED-LOOP' \
  -- run_hook 'if true; then until [ -f /tmp/x ]; do sleep 1; done; fi'

assert_red "while read fed by tail -f never sees EOF -> BLOCK" \
  --contains '"decision": "block"' --contains 'UNBOUNDED-LOOP' \
  -- run_hook 'tail -f /tmp/app.log | while read l; do echo "$l"; sleep 1; done'

assert_red "busy while-true without sleep -> BLOCK" \
  --contains '"decision": "block"' --contains 'UNBOUNDED-LOOP' \
  -- run_hook 'while :; do date >> /tmp/t; done'

assert_red "\`cat > file\` without heredoc waits on stdin -> BLOCK" \
  --contains '"decision": "block"' --contains 'STDIN-CAT' \
  -- run_hook 'mkdir -p out && cat > out/notes.txt'

assert_red "\`cat -\` is still stdin -> BLOCK" \
  --contains '"decision": "block"' --contains 'STDIN-CAT' \
  -- run_hook 'cat - 2>/dev/null; echo done'

# ── the refusal MESSAGE, as the agent actually receives it ───────────────────
# The text is half the guard: it must name the alternative, or the next agent
# just rewrites the loop until it passes.
assert_contract "refusal names the alternative (run_in_background + deadline)" \
  --contains 'run_in_background' \
  --contains 'SECONDS' \
  --contains 'уведомления харнесса' \
  -- run_hook_reason 'until [ -f /tmp/x ]; do sleep 1; done'

assert_contract "task-file refusal says what the harness actually writes" \
  --contains '<id>.output' \
  --contains 'tasks/q1.exit' \
  -- run_hook_reason "until [ -f $TASKS/q1.exit ]; do sleep 1; done"

# ── silence: the half that keeps the gate worth having ────────────────────────

assert_green "grep for the word 'until' is an argument, not a loop" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook 'grep -rn "until" .claude/hooks/'

assert_green "echo of a whole loop is text, not a loop" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook 'echo "while true; do sleep 1; done"'

assert_green "quoted loop naming a tasks/*.status file is text" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook "printf '%s\n' 'until [ -f $TASKS/x.status ]; do sleep 1; done' >> notes.md"

assert_green "deadline via \$SECONDS -> passes" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook 'SECONDS=0; until [ -f /tmp/x ] || [ "$SECONDS" -ge 600 ]; do sleep 10; done'

assert_green "deadline via date +%s -> passes" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook 'deadline=$(( $(date +%s) + 600 )); until [ -f /tmp/x ] || [ "$(date +%s)" -ge "$deadline" ]; do sleep 10; done'

assert_green "deadline checked in the body with break -> passes" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook 'end=$(( $(date +%s) + 300 )); while true; do [ -f /tmp/x ] && break; [ "$(date +%s)" -gt "$end" ] && exit 1; sleep 5; done'

assert_green "counter read by the condition -> passes" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook 'n=0; until [ -f /tmp/x ] || [ $n -ge 60 ]; do n=$((n+1)); sleep 5; done'

assert_green "counter compared in the body before break -> passes" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook 'i=0; while true; do i=$((i+1)); [ $i -gt 30 ] && break; sleep 1; done'

assert_green "deadline in an if-guard around break, via a derived variable -> passes" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook "end=\$(( \$(date +%s) + 300 ))${NL}while true; do${NL}  now=\$(date +%s)${NL}  if [ -f /tmp/x ]; then break${NL}  elif [ \"\$now\" -gt \"\$end\" ]; then echo timeout; exit 1; fi${NL}  sleep 5${NL}done"

assert_green "deadline selects a case branch that breaks -> passes (fail-open tracing)" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook 'while true; do case "$(( SECONDS > 600 ))" in 1) break;; esac; sleep 5; done'

assert_green "deadline checked by a function defined in the same command -> passes" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook 'timed_out() { [ "$SECONDS" -ge 600 ]; }; until [ -f /tmp/x ] || timed_out; do sleep 5; done'

assert_green "arithmetic counter in the condition -> passes" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook 'tries=0; while ! curl -sf http://localhost:3001/health && (( tries++ < 30 )); do sleep 2; done'

assert_green "bounded for-seq wait -> passes" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook 'for i in $(seq 1 60); do [ -f /tmp/x ] && break; sleep 10; done'

assert_green "loop wrapped in timeout N bash -c -> passes" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook "timeout 600 bash -c 'until [ -f /tmp/x ]; do sleep 5; done'"

assert_green "while read < file (finite input, no sleep) -> passes" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook 'while read -r line; do echo "$line"; done < files.txt'

assert_green "cmd | while read (finite input, no sleep) -> passes" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook 'git diff --name-only origin/main | while read f; do wc -l "$f"; done'

assert_green "while read over a file WITH a rate-limit sleep -> passes (input-bounded)" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook 'while read u; do curl -s "$u" >/dev/null; sleep 1; done < urls.txt'

assert_green "while without sleep (argument parsing) -> passes" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook 'while [ $# -gt 0 ]; do shift; done'

assert_green "cmd | cat -> passes" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook 'git log --oneline -5 | cat'

assert_green "cat <<'EOF' whose body contains a loop -> passes (heredoc is data)" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook "cat <<'EOF' > script.txt${NL}until true; do sleep 1; done${NL}cat${NL}EOF${NL}wc -l script.txt"

assert_green "cat <file> / cat < file / cat <<< str -> pass" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook 'cat README.md; cat < input.txt; cat <<< "$JSON" | jq .'

assert_green "xargs cat -> passes (xargs supplies the operands)" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook "find . -name '*.ts' | xargs cat | wc -l"

assert_green "cat /dev/stdin — the documented escape hatch — passes" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook 'cat /dev/stdin'

assert_green "one-shot test of a tasks/*.exit path outside a loop -> passes" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook "[ -f $TASKS/x.exit ] && echo yes || echo no"

assert_green "a case pattern named cat is not a command" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook 'case "$animal" in cat) echo meow;; dog) echo woof;; esac'

assert_green "unparseable command (unbalanced quote) is allowed — bash would reject it" \
  --not-contains '"decision": "block"' --not-contains 'analyzer crashed' \
  -- run_hook 'until [ -f "/tmp/x ]; do sleep 1; done'

# ── the wrapper itself failing must ALLOW, never refuse (CR-M-2, PR #719) ─────
# For a PreToolUse hook exit 2 is a refusal, and bash exits 2 on a syntax error
# in the file. Without the EXIT trap at the top of the hook, a typo would refuse
# every Bash call in every session. This builds a copy of the REAL hook with a
# syntax error injected after the trap and an unbound variable in another copy,
# and requires both to exit 0 with the wrapper-failure line — while a copy that
# is intact still refuses, so the trap does not swallow deliberate refusals.
WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT
python3 - "$HOOK" "$WS" <<'PY'
import sys
src = open(sys.argv[1]).read()
marker = "\nset -u\n"
assert marker in src, "hook layout changed: no top-level `set -u` after the trap"
open(sys.argv[2] + "/syntax.sh", "w").write(src.replace(marker, "\nset -u\nif then\n", 1))
open(sys.argv[2] + "/unbound.sh", "w").write(src.replace(marker, "\nset -u\n: \"$UW_NO_SUCH_VAR\"\n", 1))
PY

run_hook_file() {
  local file="$1" cmd="$2" json
  json=$(python3 -c 'import json,sys; print(json.dumps({"tool_input":{"command":sys.argv[1]}}))' "$cmd")
  printf '%s' "$json" | bash "$file"
}

assert_green "syntax error in the wrapper -> exit 0 + logged, NOT a refusal" \
  --contains 'wrapper failed' --not-contains '"decision": "block"' \
  -- run_hook_file "$WS/syntax.sh" 'until [ -f /tmp/x ]; do sleep 1; done'

assert_green "unbound variable in the wrapper -> exit 0 + logged, NOT a refusal" \
  --contains 'wrapper failed' --not-contains '"decision": "block"' \
  -- run_hook_file "$WS/unbound.sh" 'until [ -f /tmp/x ]; do sleep 1; done'

assert_red "the trap lets a deliberate refusal through (exit 2 + body)" \
  --contains '"decision": "block"' --not-contains 'wrapper failed' \
  -- run_hook_file "$HOOK" 'until [ -f /tmp/x ]; do sleep 1; done'

guard_test_summary "test-pre-bash-unbounded-wait.sh"
