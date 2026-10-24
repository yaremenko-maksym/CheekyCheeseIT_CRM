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

assert_red "RTK-wrapped removal of another agent's worktree -> BLOCK (token-economy: rtk is a transparent wrapper)" \
  --contains '"decision": "block"' \
  -- run_hook "$MINE" "rtk git worktree remove --force $OTHER"

assert_red "RTK bypass-wrapped removal of another agent's worktree -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$MINE" "rtk bypass git worktree remove --force $OTHER"

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

# ── a reviewer removing its OWN scratchpad checkout (2026-10-17/18) ──────────
# A read-only agent gets no worktree, so own_wt is empty for every reviewer and
# the checkout it made under the session scratchpad came out "not your worktree".
# Six reviewers in one session could not clean up after themselves.
#
# The scratchpad is SHARED between sibling agents of a session (measured: one
# flat directory, 190 entries, ~10 agents), so the path cannot say whose a
# checkout is and the first version of this widening — keyed on the path — let a
# reviewer remove a security reviewer's checkout. Ownership is recorded instead,
# against the one per-agent field the payload carries (agent_id), at the moment
# this hook watches the agent create the tree.
MY_SESSION="/tmp/claude-999/-fake-repo-CheekyCheeseIT-CRM/11111111-1111-1111-1111-111111111111"
OTHER_SESSION="/tmp/claude-999/-fake-repo-CheekyCheeseIT-CRM/22222222-2222-2222-2222-222222222222"
# Portable mktemp, as guard_test_workspace() in lib/harness.sh already does it:
# `mktemp -t <prefix>` is a BSD shorthand and GNU coreutils exits 1 on it ("too
# few X's in template"), which is what made this file pass locally and fail in CI.
OWNERS_LEDGER="$(mktemp "${TMPDIR:-/tmp}/guard-owners.XXXXXX")"
# A scratch-shaped root this test owns, for the one case that depends on what is
# actually on disk. The /tmp/claude-<something>/<a>/<b> shape is what the hook
# recognises as a scratchpad; the pid keeps concurrent runs apart. Spelled /tmp,
# not /private/tmp: Linux has no /private and a non-root user cannot create it.
LIVE_SESS="/tmp/claude-guard-$$/proj/sess"
mkdir -p "$LIVE_SESS/scratchpad/sibling-live"
trap 'rm -f "$OWNERS_LEDGER"; rm -rf "/tmp/claude-guard-$$"' EXIT

# The fixture is asserted, not assumed: when the ledger is unwritable or the live
# directory is missing, recording dies and this suite does not go red — it
# INVERTS (allow-cases red, block-cases green for the wrong reason).
if [ -z "$OWNERS_LEDGER" ] || ! : >>"$OWNERS_LEDGER" 2>/dev/null; then
  echo "FATAL: ownership ledger fixture is not writable (OWNERS_LEDGER='$OWNERS_LEDGER')"
  exit 1
fi
if [ ! -d "$LIVE_SESS/scratchpad/sibling-live" ]; then
  echo "FATAL: fixture directory $LIVE_SESS/scratchpad/sibling-live was not created"
  exit 1
fi

# $1 = agent_id, $2 = cwd, $3 = command
run_hook_as() {
  local agent="$1" cwd="$2" cmd="$3"
  local json
  json=$(python3 -c 'import json,sys; print(json.dumps({"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":sys.argv[1],"agent_id":sys.argv[2],"tool_input":{"command":sys.argv[3]}}))' "$cwd" "$agent" "$cmd")
  printf '%s' "$json" | CROSS_AGENT_WORKTREE_OWNERS="$OWNERS_LEDGER" bash "$HOOK"
}

assert_green "creating my checkout at a literal path is recorded, not blocked" \
  --not-contains '"decision": "block"' \
  -- run_hook_as agent-A "$MY_SESSION/scratchpad" "git worktree add --detach $MY_SESSION/scratchpad/co-A deadbeef"

# Asserted on the LEDGER, not on the absence of a refusal: a break in recording
# must turn a case red on its own, instead of silently making the guard more
# refusing (which every block-case below would still call a pass).
ledger_lines() { cat "$OWNERS_LEDGER" 2>/dev/null; }

assert_contract "the add actually WROTE a ledger line for that path" \
  --contains "agent-A	$MY_SESSION/scratchpad/co-A" \
  -- ledger_lines

assert_green "removing the checkout recorded against MY agent_id passes" \
  --not-contains '"decision": "block"' \
  -- run_hook_as agent-A "$MY_SESSION/scratchpad" "git worktree remove --force $MY_SESSION/scratchpad/co-A"

assert_red "a SIBLING of the same session cannot remove it -> BLOCK (CR-M-1)" \
  --contains 'WORKTREE-UNRECORDED' \
  -- run_hook_as agent-B "$MY_SESSION/scratchpad" "git worktree remove --force $MY_SESSION/scratchpad/co-A"

assert_red "a record of X does not cover X-notes -> BLOCK (prefix boundary)" \
  --contains 'WORKTREE-UNRECORDED' \
  -- run_hook_as agent-A "$MY_SESSION/scratchpad" "git worktree remove --force $MY_SESSION/scratchpad/co-A-notes"

# A PreToolUse hook records BEFORE git runs, so the recording rule must refuse to
# record what git is about to refuse to create. Without the existence test, an
# `add` aimed at a live sibling checkout wrote a line claiming it and the next
# `remove` was permitted — PR #544 between siblings, in two commands (L-1).
assert_green "an add aimed at an EXISTING tree stays silent (git refuses it, not this hook)" \
  --not-contains '"decision": "block"' \
  -- run_hook_as agent-A "$LIVE_SESS/scratchpad" "git worktree add --detach $LIVE_SESS/scratchpad/sibling-live deadbeef"

assert_red "...and records nothing, so removing that live tree is still refused -> BLOCK (L-1)" \
  --contains 'WORKTREE-UNRECORDED' \
  -- run_hook_as agent-A "$LIVE_SESS/scratchpad" "git worktree remove --force $LIVE_SESS/scratchpad/sibling-live"

assert_red "another session's scratchpad is as foreign as another agent's worktree -> BLOCK" \
  --contains 'WORKTREE-REMOVE' \
  -- run_hook_as agent-A "$MY_SESSION/scratchpad" "git worktree remove --force $OTHER_SESSION/scratchpad/checkout"

assert_red "an opaque target is still unattributable from a scratchpad cwd -> BLOCK" \
  --contains 'WORKTREE-OPAQUE' \
  -- run_hook_as agent-A "$MY_SESSION/scratchpad" 'git worktree remove --force "$W"'

# ── and the 42-case smoke, so CI finally runs it ──────────────────────────────
# Covers this hook AND pre-agent-dispatch-isolation.sh; it is invoked from here
# rather than from both files so it runs once per suite.

assert_green "the full cross-agent smoke (both hooks, both directions) passes" \
  --contains "failed: 0" \
  -- bash "$SMOKE"

guard_test_summary "test-pre-bash-cross-agent-blast.sh"
