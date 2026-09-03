#!/usr/bin/env bash
# test-pre-bash-cross-agent-blast.sh — proves .claude/hooks/pre-bash-cross-agent-blast.sh
# refuses the three blast-radius commands it was written for, and stays silent
# on the legitimate work that looks like them.
#
# WHY IT HAD NO TEST HERE UNTIL 2026-09-01, DESPITE HAVING 42 CASES. The cases
# live in .claude/hooks/tests/cross-agent-hooks-smoke.sh, and until today NO
# WORKFLOW REFERENCED THAT FILE — `grep -rn cross-agent-hooks-smoke .github`
# returned nothing. Forty-two real cases, run only when a human remembered to
# run them by hand. The meta-guard could not have said so either: its inventory
# was `scripts/devops/check-*`, so no hook was in its field of view at all.
#
# This file closes both halves. It runs the existing smoke (so CI executes
# those 42 cases on every PR that touches code, via run-guard-tests.sh, which
# is inside a REQUIRED check), and it carries its own harness-native cases so
# the meta-guard's negative-assertion rule is satisfied by a real red rather
# than by a delegation.
#
# The smoke is portable despite hardcoding an absolute owner path: this hook
# reads `cwd` from the PAYLOAD, not from $PWD or `git rev-parse`, and analyses
# it as a STRING. Verified on 2026-09-01 — the paths it names
# (.claude/worktrees/agent-MINE, agent-OTHER) do not exist on disk and it passes
# anyway, so it decides the same way on a runner where they also do not exist.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

HOOK="$REPO_ROOT/.claude/hooks/pre-bash-cross-agent-blast.sh"
SMOKE="$REPO_ROOT/.claude/hooks/tests/cross-agent-hooks-smoke.sh"

echo "== test-pre-bash-cross-agent-blast.sh =="
echo

if ! bash -n "$HOOK" 2>/dev/null; then
  echo "FATAL: syntax error in $HOOK"
  bash -n "$HOOK"
  exit 1
fi

# Path strings only — nothing here is created on disk, and nothing needs to be.
FAKE_REPO="/fake/repo/CheekyCheeseIT_CRM"
MINE="$FAKE_REPO/.claude/worktrees/agent-MINE"
OTHER="$FAKE_REPO/.claude/worktrees/agent-OTHER"

# $1 = cwd reported in the payload, $2 = command
run_hook() {
  local cwd="$1" cmd="$2"
  local json
  json=$(python3 -c 'import json,sys; print(json.dumps({"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":sys.argv[1],"tool_input":{"command":sys.argv[2]}}))' "$cwd" "$cmd")
  printf '%s' "$json" | bash "$HOOK"
}

# ── refusals: one per incident this hook exists for ───────────────────────────

assert_red "pkill -f kills every agent's processes, not mine -> BLOCK (PR #547)" \
  --contains '"decision": "block"' \
  -- run_hook "$MINE" 'pkill -f "apps/api/dist/main"'

assert_red "removing another agent's worktree -> BLOCK (PR #544)" \
  --contains '"decision": "block"' \
  -- run_hook "$MINE" "git worktree remove --force $OTHER"

assert_red "mutating another agent's tree -> BLOCK (PR #551)" \
  --contains '"decision": "block"' \
  -- run_hook "$MINE" "cd $OTHER && git checkout -- apps/api/src/x.ts"

assert_red "writing into the shared checkout -> BLOCK (MAIN contamination)" \
  --contains '"decision": "block"' \
  -- run_hook "$MINE" "echo hack > $FAKE_REPO/apps/web/src/x.ts"

# ── the same command, written the way people actually write it (2026-09-02) ───
# The literal form above was refused. The loop below — the orchestrator's own
# cleanup, twice in one session — was not, and it removed two live reviewer
# checkouts. Two independent blindnesses stacked: the target was a variable the
# hook cannot expand, and the loop body put `do` in command position so no
# predicate even looked. A guard that only sees the form nobody writes is a
# guard that has never run.

assert_red "target via a variable -> BLOCK: ownership cannot be established" \
  --contains 'WORKTREE-OPAQUE' \
  -- run_hook "$MINE" 'git worktree remove --force "$W"'

assert_red "the cleanup loop that cost two reviewers their trees -> BLOCK" \
  --contains 'WORKTREE-OPAQUE' \
  -- run_hook "$MINE" 'for w in $(git worktree list --porcelain | awk "/^worktree /{print \$2}"); do git worktree remove --force "$w"; done'

assert_red "pkill hidden behind the \`do\` of a loop body -> BLOCK" \
  --contains 'BROADCAST-KILL' \
  -- run_hook "$MINE" 'while read p; do pkill -f "$p"; done < /tmp/list'

# ── the refusal MESSAGE, as the agent actually receives it ───────────────────
# The text is half the guard: a block that does not say what to do instead is a
# block people route around. It is assembled inside a double-quoted
# `python3 -c "..."`, where a backtick is COMMAND SUBSTITUTION — so the line
# naming the two forbidden commands was EXECUTED by the shell on every refusal
# (`pkill -f` and `killall`, both saved only by requiring an argument) and
# replaced with their empty stdout. Rendered, that line read
# "  /  не различают твои процессы и чужие." for as long as the hook existed.
#
# This must assert on the DECODED reason, not on the harness's raw capture:
# the capture merges stderr, and the defect itself writes `killall`'s usage
# text there — so a naive `--contains killall` against the raw capture passes
# while the message says nothing. Verified both ways on 2026-09-02.
run_hook_reason() {
  run_hook "$1" "$2" 2>/dev/null | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("reason", ""))
except Exception:
    pass'
}

assert_contract "the refusal NAMES the commands it forbids (no backtick substitution)" \
  --contains 'pkill -f' \
  --contains 'killall' \
  --not-contains 'usage:' \
  -- run_hook_reason "$MINE" 'pkill -f node'

# ── silence: the half that keeps the gate worth having ────────────────────────
# A gate that refuses legitimate work trains people to route around it — the
# documented reason (backlog 63) the live-db guard was narrowed. These cases
# are as load-bearing as the refusals above.

assert_green "kill <PID> — the prescribed replacement — passes" \
  --not-contains '"decision": "block"' \
  -- run_hook "$MINE" 'kill 12345'

assert_green "grep for the word pkill is an argument, not a command" \
  --not-contains '"decision": "block"' \
  -- run_hook "$MINE" 'grep -rn "pkill" .claude/hooks/'

assert_green "removing MY OWN worktree passes" \
  --not-contains '"decision": "block"' \
  -- run_hook "$MINE" "git worktree remove $MINE"

assert_green "READING another worktree is not gated" \
  --not-contains '"decision": "block"' \
  -- run_hook "$MINE" "cat $OTHER/README.md"

assert_green "the owner's documented zombie sweep still runs" \
  --not-contains '"decision": "block"' \
  -- run_hook "$MINE" "pgrep -f 'worktrees[/]agent-' | xargs kill -9"

# The non-literal refusal is scoped to `git worktree remove` on purpose. An
# ordinary mutator with a variable target has an overwhelming benign majority
# (own tree, own scratchpad) and no cheap remedy to offer — refusing it would be
# the trust-burning false positive the hook's own header argues against. This
# case pins the scope: it goes red if a later "hardening" widens the rule.
assert_green "ordinary mutator with a variable target stays silent" \
  --not-contains '"decision": "block"' \
  -- run_hook "$MINE" 'rm -rf "$TMPDIR/worktree-cache"'

assert_green "creating MY OWN checkout by variable stays silent" \
  --not-contains '"decision": "block"' \
  -- run_hook "$MINE" 'git worktree add --detach "$SCRATCH/checkout" abc123'

# ── and the 42-case smoke, so CI finally runs it ──────────────────────────────
# Covers this hook AND pre-agent-dispatch-isolation.sh; it is invoked from here
# rather than from both files so it runs once per suite.

assert_green "the full cross-agent smoke (both hooks, both directions) passes" \
  --contains "failed: 0" \
  -- bash "$SMOKE"

guard_test_summary "test-pre-bash-cross-agent-blast.sh"
