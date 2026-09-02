#!/bin/bash
# Smoke test for the two cross-agent hooks. Run it — do not read it and assume.
#
#   bash .claude/hooks/tests/cross-agent-hooks-smoke.sh
#
# Every case feeds a FORGED PreToolUse payload to the hook and asserts the exit
# code: 2 = blocked, 0 = allowed. Half the cases are legitimate commands that
# MUST stay silent — a hook that only proves it can say no has proved nothing,
# and a hook that says no to legitimate work trains people to bypass it
# (backlog 63, live-db-guard vs. a harmless grep).
#
# Exits non-zero if any case behaves differently than declared.

set -u

HOOK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BLAST="$HOOK_DIR/pre-bash-cross-agent-blast.sh"
DISPATCH="$HOOK_DIR/pre-agent-dispatch-isolation.sh"

REPO="/Users/maksym/Desktop/programming/CheekyCheeseIT_CRM"
MINE="$REPO/.claude/worktrees/agent-MINE"
OTHER="$REPO/.claude/worktrees/agent-OTHER"

PASS=0
FAIL=0

# Gate 0. A bash syntax error also exits 2 — indistinguishable from a block by
# exit code alone. That is not hypothetical: the first draft of the blast hook
# had an apostrophe inside a single-quoted python block, died at parse time,
# and "passed" all eight block cases while doing nothing. Check syntax first,
# and assert the decision body below, not just the code.
for h in "$BLAST" "$DISPATCH"; do
  if ! bash -n "$h" 2>/dev/null; then
    echo "FATAL: syntax error in $h"
    bash -n "$h"
    exit 1
  fi
done

# bash_case <expect:block|allow> <cwd> <command> <label>
bash_case() {
  local expect="$1" cwd="$2" cmd="$3" label="$4"
  local payload rc
  payload=$(CWD="$cwd" CMD="$cmd" python3 -c '
import json, os
print(json.dumps({
    "hook_event_name": "PreToolUse",
    "tool_name": "Bash",
    "cwd": os.environ["CWD"],
    "tool_input": {"command": os.environ["CMD"]},
}))')
  OUT=$(printf '%s' "$payload" | bash "$BLAST" 2>/dev/null)
  rc=$?
  assert "$expect" "$rc" "$label"
}

# agent_case <expect> <json tool_input> <label>
agent_case() {
  local expect="$1" ti="$2" label="$3"
  local payload rc
  payload=$(TI="$ti" python3 -c '
import json, os
print(json.dumps({
    "hook_event_name": "PreToolUse",
    "tool_name": "Agent",
    "cwd": "/Users/maksym/Desktop/programming/CheekyCheeseIT_CRM",
    "agent_id": "orchestrator",
    "tool_input": json.loads(os.environ["TI"]),
}))')
  OUT=$(printf '%s' "$payload" | bash "$DISPATCH" 2>/dev/null)
  rc=$?
  assert "$expect" "$rc" "$label"
}

assert() {
  local expect="$1" rc="$2" label="$3"
  local got
  if [ "$rc" -eq 2 ]; then got="block"; else got="allow"; fi
  # A real block must also emit the decision body the harness consumes; a hook
  # that merely exits 2 (crash) is a failure, not a block.
  if [ "$got" = "block" ] && ! printf '%s' "$OUT" | grep -q '"decision": *"block"'; then
    printf '  FAIL  rc=2 but no {"decision":"block"} body — hook crashed? — %s\n' "$label"
    FAIL=$((FAIL + 1))
    return
  fi
  if [ "$got" = "$expect" ]; then
    printf '  ok    %-6s %s\n' "$got" "$label"
    PASS=$((PASS + 1))
  else
    printf '  FAIL  expected %s, got %s (rc=%s) — %s\n' "$expect" "$got" "$rc" "$label"
    FAIL=$((FAIL + 1))
  fi
}

echo "== pre:bash:cross-agent-blast — MUST BLOCK =="
bash_case block "$MINE" 'pkill -f "apps/api/dist/main"'                     'pkill -f pattern (PR #547, backlog 72)'
bash_case block "$MINE" 'killall node'                                      'killall node'
bash_case block "$MINE" "git worktree remove --force $OTHER"                "git worktree remove <other> (PR #544, backlog 75)"
bash_case block "$MINE" 'git worktree prune'                                'git worktree prune'
bash_case block "$MINE" "cd $OTHER && git checkout -- apps/api/src/x.ts"    'redness-check revert in another live tree (PR #551, backlog 100)'
bash_case block "$MINE" "rm -rf $OTHER/node_modules"                        'rm -rf inside another worktree'
bash_case block "$MINE" "sed -i '' 's/a/b/' $OTHER/apps/web/src/f.ts"       'sed -i inside another worktree'
bash_case block "$MINE" "echo hack > $REPO/apps/web/src/x.ts"               'redirect into the shared checkout (MAIN contamination)'
bash_case block "$MINE" "find $OTHER -name '*.log' | xargs rm"              'CR-M-1: mutator behind xargs (PR #553 review)'
bash_case block "$MINE" "find $OTHER -name '*.log' -delete"                 'CR-M-1: find -delete'
bash_case block "$MINE" "find $OTHER -type f -exec rm {} ;"                 'CR-M-1: find -exec rm'
bash_case block "$MINE" "sudo pkill -f node"                                'CR-M-1: pkill behind sudo'
bash_case block "$MINE" "timeout 60 rm -rf $OTHER/dist"                     'CR-M-1: mutator behind timeout'

# ── the target is not a literal, so ownership cannot be established ───────────
# 2026-09-02: the orchestrator removed two live reviewer checkouts with the loop
# below. The literal form of the SAME command was refused; the variable form was
# not merely missed — the relative-looking token "$w" was joined onto cwd and
# thereby classified as MINE. "Could not check" was collapsed into "checked,
# clean". These cases pin the third outcome.
bash_case block "$MINE" 'git worktree remove --force "$W"'                                    'target via variable — ownership unknowable'
bash_case block "$MINE" 'for w in $(git worktree list --porcelain | awk "/^worktree /{print \$2}"); do git worktree remove --force "$w"; done' \
                                                                            "the cleanup loop that cost two reviewers their trees (2026-09-02)"
bash_case block "$MINE" 'git worktree remove --force "$(cat /tmp/victims)"' 'target via command substitution'
bash_case block "$MINE" 'git worktree remove --force .claude/worktrees/agent-*' 'target via glob — matches trees I cannot enumerate'
bash_case block "$MINE" 'git worktree $SUB --force /some/path'              'the SUBCOMMAND itself is not a literal'
bash_case block "$MINE" 'git worktree remove --force ~/orphaned-wt'         'tilde resolves to a real path outside my tree'

# ── a leading shell keyword hid the command from EVERY predicate ──────────────
# Found by writing the loop case above: the body of a loop splits as `do <cmd>`,
# so the first token was `do` and nothing matched — pkill included, which had
# been assumed immune because it is decided on the command NAME.
bash_case block "$MINE" 'while read p; do pkill -f "$p"; done < /tmp/list'  'pkill hidden behind the `do` of a loop body'
bash_case block "$MINE" 'if [ -f /tmp/x ]; then pkill -f node; fi'         'pkill hidden behind `then`'
bash_case block "$MINE" 'for x in 1; do sudo killall node; done'           'killall behind `do` AND a wrapper'

echo "== pre:bash:cross-agent-blast — MUST STAY SILENT =="
bash_case allow "$MINE" 'kill 12345'                                        'kill <PID> — the prescribed replacement (AC11)'
bash_case allow "$MINE" 'kill -TERM 12345'                                  'kill -TERM <PID> (AC11)'
bash_case allow "$MINE" 'lsof -ti tcp:3011 | xargs kill -9'                 'kill own dev port by PID'
bash_case allow "$MINE" "pgrep -f 'worktrees[/]agent-' | xargs kill -9"     "owner's documented zombie sweep (light-track.md)"
bash_case allow "$MINE" 'grep -rn "pkill" .claude/hooks/'                   'grep for the word pkill — argument, not command'
bash_case allow "$MINE" 'echo "не запускай pkill -f node"'                  'echo mentioning pkill'
bash_case allow "$MINE" "git worktree remove $MINE"                         'removing MY OWN worktree is allowed'
bash_case allow "$MINE" 'git worktree list'                                 'git worktree list (read-only)'
bash_case allow "$MINE" "cat $OTHER/README.md"                              'READING another worktree is not gated'
bash_case allow "$MINE" "rm -rf $MINE/tmp/scratch"                          'rm inside my own worktree, absolute path'
bash_case allow "$MINE" 'rm -rf ./node_modules/.cache'                      'rm inside my own worktree, relative path'
bash_case allow "$MINE" 'pnpm install --frozen-lockfile'                    'ordinary build command'
bash_case allow "$REPO" 'pkill -f node'                                     "owner's own session is out of scope"
bash_case allow "$MINE" "grep -rl TODO $OTHER | xargs wc -l"                'read-only payload behind xargs stays silent'
bash_case allow "$MINE" "find $OTHER -name '*.ts' -exec grep -l foo {} ;"   'find -exec with a read-only payload stays silent'
bash_case allow "$MINE" "find . -name '*.log' | xargs rm"                   'xargs rm inside MY OWN tree stays silent'
bash_case allow "$MINE" "find $MINE/dist -type f -delete"                   'find -delete inside MY OWN worktree stays silent'

# ── the non-literal refusal is scoped to `git worktree remove`, deliberately ──
# It is NOT extended to ordinary mutators: `rm "$x"` has an overwhelming benign
# majority (own tree, own scratchpad) and no cheap remedy to offer, so refusing
# it would be the trust-burning false positive this hook's own header warns
# about. These cases pin that scope — if a later "hardening" widens the rule,
# they go red.
bash_case allow "$MINE" 'rm -rf "$TMPDIR/worktree-cache"'                   'ordinary mutator with a variable target stays silent'
bash_case allow "$MINE" 'git worktree add --detach "$SCRATCH/checkout" abc123' 'creating MY OWN checkout by variable stays silent'
bash_case allow "$MINE" 'git worktree list --porcelain'                     'read-only worktree subcommand stays silent'

echo "== pre:agent:dispatch-isolation — MUST BLOCK =="
agent_case block '{"subagent_type":"coder","prompt":"fix it"}'                          'coder without isolation (PR #497, backlog 36)'
agent_case block '{"subagent_type":"devops","prompt":"ci"}'                             'devops without isolation'
agent_case block '{"subagent_type":"architect","prompt":"adr"}'                         'architect without isolation'
agent_case block '{"subagent_type":"code-reviewer","prompt":"работай в /tmp/rev493"}'   'shared measurement dir in prompt (PR #493, backlog 27)'

echo "== pre:agent:dispatch-isolation — MUST STAY SILENT =="
agent_case allow '{"subagent_type":"coder","isolation":"worktree","prompt":"fix"}'      'coder WITH isolation=worktree'
agent_case allow '{"subagent_type":"coder","cwd":"/abs/path","prompt":"fix"}'           'coder WITH explicit cwd'
agent_case allow '{"subagent_type":"code-reviewer","prompt":"PR #493 review"}'          'code-reviewer, no worktree forced (AC6)'
agent_case allow '{"subagent_type":"security-reviewer","prompt":"PR #493"}'             'security-reviewer, no worktree forced (AC6)'
agent_case allow '{"subagent_type":"copy-reviewer","prompt":"PR #493"}'                 'copy-reviewer, no worktree forced (AC6)'
agent_case allow '{"subagent_type":"Explore","prompt":"find X"}'                        'Explore fan-out, no worktree forced (AC6)'
agent_case allow '{"subagent_type":"some-plugin-agent","prompt":"x"}'                   'unknown subagent type — default allow'
agent_case allow '{"subagent_type":"code-reviewer","prompt":"PR для review: #493, repo: yaremenko-maksym/CheekyCheeseIT_CRM"}' 'PR number in prose is not a shared path'

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
