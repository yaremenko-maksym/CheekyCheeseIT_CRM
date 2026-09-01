#!/usr/bin/env bash
# test-pre-agent-dispatch-isolation.sh — proves .claude/hooks/pre-agent-dispatch-isolation.sh
# refuses to dispatch a WRITING subagent without its own workspace, and leaves
# read-only agents alone.
#
# WHY IT HAD NO TEST HERE UNTIL 2026-09-01: same reason as its sibling. Its
# cases lived in .claude/hooks/tests/cross-agent-hooks-smoke.sh, which no
# workflow referenced, and the meta-guard scripts/devops/check-guard-tests-exist.sh
# read only `scripts/devops/check-*` and so had never seen a hook.
#
# The 42-case smoke that covers this hook is executed once per suite, from
# test-pre-bash-cross-agent-blast.sh. The cases below are this file's own, in
# the harness's vocabulary, so that "this hook has been watched go red" is true
# of a red in this file rather than of a delegation to another one.
#
# WHOSE MISTAKE THIS GATE CATCHES: the dispatcher's, not the agent's. On PR #497
# the Coder behaved correctly once it saw the warning — what was wrong was the
# call that launched it without isolation. That is why the refusal happens at
# dispatch time and not inside the agent.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

HOOK="$REPO_ROOT/.claude/hooks/pre-agent-dispatch-isolation.sh"

echo "== test-pre-agent-dispatch-isolation.sh =="
echo

if ! bash -n "$HOOK" 2>/dev/null; then
  echo "FATAL: syntax error in $HOOK"
  bash -n "$HOOK"
  exit 1
fi

# $1 = tool_input as JSON
run_hook() {
  local ti="$1"
  local json
  json=$(TI="$ti" python3 -c '
import json, os, sys
print(json.dumps({
    "hook_event_name": "PreToolUse",
    "tool_name": "Agent",
    "cwd": "/fake/repo/CheekyCheeseIT_CRM",
    "agent_id": "orchestrator",
    "tool_input": json.loads(os.environ["TI"]),
}))')
  printf '%s' "$json" | bash "$HOOK"
}

# ── refusals ──────────────────────────────────────────────────────────────────

assert_red "a coder dispatched without isolation -> BLOCK (PR #497)" \
  --contains '"decision": "block"' \
  -- run_hook '{"subagent_type":"coder","prompt":"fix it"}'

assert_red "a devops agent dispatched without isolation -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook '{"subagent_type":"devops","prompt":"ci"}'

assert_red "an architect dispatched without isolation -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook '{"subagent_type":"architect","prompt":"adr"}'

# The path is shared BY CONSTRUCTION: the PR number is the same for every
# reviewer of that PR, so two reviewers handed it land in one directory and
# measure each other's edits as if they were properties of the code (PR #493).
assert_red "a shared absolute work dir handed in the prompt -> BLOCK (PR #493)" \
  --contains '"decision": "block"' \
  -- run_hook '{"subagent_type":"code-reviewer","prompt":"работай в /tmp/rev493"}'

# ── silence ───────────────────────────────────────────────────────────────────
# Read-only agents must NOT be forced to pay for a worktree they never write to
# (AC6). A gate that taxes correct behaviour gets routed around.

assert_green "a coder WITH isolation=worktree passes" \
  --not-contains '"decision": "block"' \
  -- run_hook '{"subagent_type":"coder","isolation":"worktree","prompt":"fix"}'

assert_green "a coder WITH an explicit cwd passes" \
  --not-contains '"decision": "block"' \
  -- run_hook '{"subagent_type":"coder","cwd":"/abs/path","prompt":"fix"}'

assert_green "code-reviewer needs no worktree (AC6)" \
  --not-contains '"decision": "block"' \
  -- run_hook '{"subagent_type":"code-reviewer","prompt":"PR #493 review"}'

assert_green "security-reviewer needs no worktree (AC6)" \
  --not-contains '"decision": "block"' \
  -- run_hook '{"subagent_type":"security-reviewer","prompt":"PR #493"}'

assert_green "an unknown subagent type defaults to allow" \
  --not-contains '"decision": "block"' \
  -- run_hook '{"subagent_type":"some-plugin-agent","prompt":"x"}'

assert_green "a PR number in prose is not a shared path" \
  --not-contains '"decision": "block"' \
  -- run_hook '{"subagent_type":"code-reviewer","prompt":"PR для review: #493, repo: yaremenko-maksym/CheekyCheeseIT_CRM"}'

guard_test_summary "test-pre-agent-dispatch-isolation.sh"
