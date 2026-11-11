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
. "$SELF_DIR/lib/hook-harness.sh"

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
  # The exclusion stops Git Bash rewriting /fake/x in argv, so the payload holds the path as given.
  json=$(MSYS2_ARG_CONV_EXCL='*' python3 -c 'import json,sys; print(json.dumps({"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":sys.argv[1],"tool_input":{"command":sys.argv[2]}}))' "$cwd" "$cmd")
  printf '%s' "$json" | bash "$HOOK"
}

# ── refusals: one per incident this hook exists for ───────────────────────────

assert_red "pkill -f kills every agent's processes, not mine -> BLOCK (PR #547)" \
  --contains '"decision": "block"' \
  -- run_hook "$MINE" 'pkill -f "apps/api/dist/main"'

# The reason text crosses a pipe from the analyzer to the message block. On Windows
# that pipe used the locale code page, so the JSON carried mojibake escapes
# (\u00e1\u00fc...) instead of the Cyrillic ones below. Red on Windows before the fix.
assert_red "the analyzer reason reaches the refusal as UTF-8, not in the locale code page" \
  --contains '\u0431\u044c\u0451\u0442 \u043f\u043e \u0448\u0430\u0431\u043b\u043e\u043d\u0443' \
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

assert_red "SR-H-1: rtk test wrapping a foreign worktree removal -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$MINE" "rtk test git worktree remove --force $OTHER"

assert_red "SR-H-1: rtk err wrapping a foreign worktree removal -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$MINE" "rtk err git worktree remove --force $OTHER"

assert_red "SR-H-1: rtk run wrapping a foreign worktree removal -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$MINE" "rtk run git worktree remove --force $OTHER"

assert_red "SR-H-1: rtk summary wrapping a foreign worktree removal -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$MINE" "rtk summary git worktree remove --force $OTHER"

assert_red "SR-H-1: rtk bypass with a flag wrapping a foreign worktree removal -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$MINE" "rtk bypass -v git worktree remove --force $OTHER"

assert_red "SR-H-1: rtk run -c shell string wrapping a foreign worktree removal -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$MINE" "rtk run -c \"git worktree remove --force $OTHER\""

assert_red "SR-H-1: rtk test --shell string wrapping a foreign worktree removal -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$MINE" "rtk test --shell sh \"git worktree remove --force $OTHER\""

assert_red "SR-H-3: rtk bypass one quoted string wrapping a foreign worktree removal -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$MINE" "rtk bypass 'git worktree remove --force $OTHER'"

assert_red "SR-H-3: rtk test one quoted string wrapping a foreign worktree removal -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$MINE" "rtk test 'git worktree remove --force $OTHER'"

assert_red "SR-H-3: rtk -v summary one quoted string wrapping a foreign worktree removal -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$MINE" "rtk -v summary 'git worktree remove --force $OTHER'"

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

# A Cyrillic command (SO-sonnet-L of #1314). On Windows python read its stdin in the
# locale code page: CWD came in by the environment as real text and the command as
# mojibake, so the hook took my own tree for a foreign one (an escaped payload) or died
# printing an undecodable byte (a raw UTF-8 one). Both were red there before stdin was
# set to UTF-8. Built from \x escapes so this file adds no Cyrillic letters.
CYR_X='\xd0\x98\xd0\xb2\xd0\xb0\xd0\xbd'
MINE_CYR="$FAKE_REPO/.claude/worktrees/agent-$(printf "$CYR_X")"
MINE_CYR_X="$FAKE_REPO/.claude/worktrees/agent-$CYR_X"
assert_green "removing MY OWN Cyrillic-named worktree passes (escaped payload)" \
  -- run_hook "$MINE_CYR" "git worktree remove --force $MINE_CYR"
assert_green "removing MY OWN Cyrillic-named worktree passes (raw UTF-8 payload)" \
  -- hook_raw "$HOOK" '{"tool_name":"Bash","cwd":"'"$MINE_CYR_X"'","tool_input":{"command":"git worktree remove --force '"$MINE_CYR_X"'"}}'
assert_green "removing ANOTHER worktree from a Cyrillic-named one: exit 2 by the predicate, not a crash" \
  --contains '"decision": "block"' --contains '[WORKTREE-REMOVE]' --not-contains 'INTERNAL ERROR' \
  -- exits_2 hook_raw "$HOOK" '{"tool_name":"Bash","cwd":"'"$MINE_CYR_X"'","tool_input":{"command":"git worktree remove --force '"$OTHER"' # '"$CYR_X"'"}}'

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
  json=$(MSYS2_ARG_CONV_EXCL='*' python3 -c 'import json,sys; print(json.dumps({"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":sys.argv[1],"agent_id":sys.argv[2],"tool_input":{"command":sys.argv[3]}}))' "$cwd" "$agent" "$cmd")
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

# ── Windows payloads ──────────────────────────────────────────────────────────
# Windows spells one path as C:\x in the harness cwd and as C:/x or /c/x in a
# typed command. Before the hook compared one form, the cwd missed the CONTEXT
# regex and every refusal above exited 0 on that OS.
WIN_MINE='C:\x\CheekyCheeseIT_CRM\.claude\worktrees\agent-MINE'
WIN_OTHER_FWD='C:/x/CheekyCheeseIT_CRM/.claude/worktrees/agent-OTHER'
WIN_MINE_FWD='C:/x/CheekyCheeseIT_CRM/.claude/worktrees/agent-MINE'

assert_red "Windows payload: pkill -f from a backslash worktree cwd -> BLOCK" \
  --contains '"decision": "block"' \
  --contains 'BROADCAST-KILL' \
  -- run_hook "$WIN_MINE" 'pkill -f "apps/api/dist/main"'

assert_red "Windows payload: removing another worktree spelled C:/x -> BLOCK" \
  --contains '"decision": "block"' \
  --contains 'WORKTREE-REMOVE' \
  -- run_hook "$WIN_MINE" "git worktree remove --force $WIN_OTHER_FWD"

assert_red "Windows payload: removing another worktree spelled /c/x -> BLOCK" \
  --contains '"decision": "block"' \
  --contains 'WORKTREE-REMOVE' \
  -- run_hook "$WIN_MINE" "git worktree remove --force /c/x/CheekyCheeseIT_CRM/.claude/worktrees/agent-OTHER"

assert_red "Windows payload: writing into the shared checkout spelled C:/x -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$WIN_MINE" "echo hack > C:/x/CheekyCheeseIT_CRM/apps/web/src/x.ts"

assert_green "Windows payload: removing MY OWN worktree spelled C:/x passes" \
  --not-contains '"decision": "block"' \
  -- run_hook "$WIN_MINE" "git worktree remove $WIN_MINE_FWD"

assert_green "Windows payload: removing MY OWN worktree spelled /c/x passes" \
  --not-contains '"decision": "block"' \
  -- run_hook "$WIN_MINE" "git worktree remove /c/x/CheekyCheeseIT_CRM/.claude/worktrees/agent-MINE"

assert_green "Windows payload: reading another worktree is not gated" \
  --not-contains '"decision": "block"' \
  -- run_hook "$WIN_MINE" "cat $WIN_OTHER_FWD/README.md"

assert_red "a quoted redirect into the shared checkout -> BLOCK" \
  --contains 'SHARED-CHECKOUT' \
  -- run_hook "$WIN_MINE" "echo hack > '/c/x/CheekyCheeseIT_CRM/apps/web/src/x.ts'"

assert_red "Windows payload: a quoted backslash redirect into the shared checkout -> BLOCK" \
  --contains 'SHARED-CHECKOUT' \
  -- run_hook "$WIN_MINE" "echo hack > 'C:\x\CheekyCheeseIT_CRM\apps\web\src\x.ts'"

assert_red "a case variant of the shared checkout path -> BLOCK" \
  --contains 'SHARED-CHECKOUT' \
  -- run_hook "$WIN_MINE" "echo hack > c:/X/cheekycheeseit_crm/apps/web/src/x.ts"

assert_red "Windows payload: mutating another worktree spelled with backslashes -> BLOCK" \
  --contains 'FOREIGN-WORKTREE' \
  -- run_hook "$WIN_MINE" "rm -rf 'C:\x\CheekyCheeseIT_CRM\.claude\worktrees\agent-OTHER\src'"

assert_green "Windows payload: a quoted backslash redirect into MY OWN worktree passes" \
  --not-contains '"decision": "block"' \
  -- run_hook "$WIN_MINE" "echo ok > '$WIN_MINE\x.txt'"

# C:../x is relative to the cwd on drive C. Real git removes the sibling worktree.
assert_red "Windows payload: drive-relative removal of a sibling worktree -> BLOCK" \
  --contains '"decision": "block"' \
  --contains 'WORKTREE-REMOVE' \
  -- run_hook "$WIN_MINE" "git worktree remove C:../agent-OTHER"

assert_red "Windows payload: git.exe worktree prune -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$WIN_MINE" "git.exe worktree prune"

assert_red "Windows payload: taskkill by image name -> BLOCK" \
  --contains '"decision": "block"' \
  --contains 'BROADCAST-KILL' \
  -- run_hook "$WIN_MINE" "taskkill //F //IM node.exe"

assert_red "Windows payload: taskkill with dash flags -> BLOCK" \
  --contains 'BROADCAST-KILL' \
  -- run_hook "$WIN_MINE" "taskkill -f -im node.exe"

assert_red "Windows payload: taskkill with the colon form of /IM -> BLOCK" \
  --contains 'BROADCAST-KILL' \
  -- run_hook "$WIN_MINE" "taskkill //f //im:node.exe"

assert_red "Windows payload: taskkill by a name filter -> BLOCK" \
  --contains 'BROADCAST-KILL' \
  -- run_hook "$WIN_MINE" "taskkill //F //FI \"IMAGENAME eq node.exe\""

assert_red "Windows payload: pkill behind a wrapper spelled env.exe -> BLOCK" \
  --contains 'BROADCAST-KILL' \
  -- run_hook "$WIN_MINE" "env.exe pkill -f node"

assert_green "Windows payload: taskkill of one PID passes" \
  --not-contains '"decision": "block"' \
  -- run_hook "$WIN_MINE" "taskkill //F //PID 1234"

# ── T3 worktrees: the gate arms and knows whose tree is whose ───────────────
T3_MINE='/Users/dev/.t3/worktrees/crm/t3-abc'
assert_red "T3 worktree: pkill" --contains 'BROADCAST-KILL' -- run_hook "$T3_MINE" "pkill -f node"
assert_red "T3 worktree, Windows payload: pkill" \
  --contains 'BROADCAST-KILL' \
  -- run_hook 'C:\Users\dev\.t3\worktrees\crm\t3-abc' "pkill -f node"
assert_red "Windows scratchpad: pkill" \
  --contains 'BROADCAST-KILL' \
  -- run_hook 'C:\Users\dev\AppData\Local\Temp\claude\x' "pkill -f node"
assert_red "Windows scratchpad in another case: pkill" \
  --contains 'BROADCAST-KILL' \
  -- run_hook 'c:\users\dev\appdata\local\temp\claude\x' "pkill -f node"
assert_red "T3 worktree: mutating another T3 worktree" \
  --contains 'FOREIGN-WORKTREE' \
  -- run_hook "$T3_MINE" "rm -rf /Users/dev/.t3/worktrees/crm/t3-other/apps/x"
assert_green "T3 worktree: mutating my own worktree" \
  --not-contains '"decision": "block"' \
  -- run_hook "$T3_MINE" "rm -rf /Users/dev/.t3/worktrees/crm/t3-abc/tmp"
# SR-M-19: a directory above my T3 worktree holds the worktrees of others.
for c in "rm -rf /Users/dev/.t3/worktrees/crm/" "rm -rf /Users/dev/.t3/worktrees/crm" \
         "rm -rf /Users/dev/.t3/worktrees" "rm -rf .." "rm -rf ../../" \
         "rm -rf ../*" "rm -rf /Users/dev/.t3/worktrees/c*" "rm -rf ../{a,b}" "rm -rf /*" \
         "rm -rf ../t3-xyz" "rm -rf /Users/dev/.t3/worktrees/crm/t3-xyz/src" \
         "rm -rf {../*,x}" "touch {..,y}/t3-xyz" "rm -rf ..{/t3-xyz,}" "rm -rf .{.,}/t3-xyz" \
         "rm -rf ~+/../t3-xyz" "chmod -R 000 ..\$X"; do
  assert_red "T3 worktree: $c" --contains 'FOREIGN-WORKTREE' -- run_hook "$T3_MINE" "$c"
done
for c in "rm -rf 'C:\Users\dev\.t3\worktrees\crm'" "rm -rf C:/Users/dev/.t3/worktrees/"; do
  assert_red "T3 worktree, Windows payload: $c" \
    --contains 'FOREIGN-WORKTREE' \
    -- run_hook 'C:\Users\dev\.t3\worktrees\crm\t3-abc' "$c"
done
assert_green "T3 worktree: a sibling directory inside my worktree" \
  --not-contains '"decision": "block"' \
  -- run_hook "$T3_MINE" "rm -rf ./build ../t3-abc/dist ./build/* dist/*.map ./{a,b}/x ~+/tmp \$X"
assert_green "T3 worktree: killing one PID" \
  --not-contains '"decision": "block"' \
  -- run_hook "$T3_MINE" "kill 1234"

T3_WS="$(mktemp -d)"
(
  cd "$T3_WS" || exit 1
  git init -q -b main crm
  cd crm || exit 1
  git -c user.email=test@example.invalid -c user.name="guard test" -c commit.gpgsign=false commit -q --allow-empty -m init
  git worktree add -q -b t3-branch "$T3_WS/.t3/worktrees/crm/t3-abc"
) >/dev/null 2>&1
T3_CHECKOUT="$(git -C "$T3_WS/crm" rev-parse --show-toplevel)"
T3_WT="$(git -C "$T3_WS/.t3/worktrees/crm/t3-abc" rev-parse --show-toplevel)"
assert_red "T3 worktree: mutating the shared checkout, which only git can name" \
  --contains 'SHARED-CHECKOUT' \
  -- run_hook "$T3_WT" "rm -rf $T3_CHECKOUT/apps/x"
assert_green "T3 worktree: a path that merely looks like the checkout" \
  --not-contains '"decision": "block"' \
  -- run_hook "$T3_WT" "rm -rf $T3_CHECKOUT-other/apps/x"
# #1297 SR-M-1 class: an inherited GIT_DIR must not steer git to another repository.
git init -q "$T3_WS/decoy" >/dev/null 2>&1
run_hook_with_git_dir() { GIT_DIR="$T3_WS/decoy/.git" run_hook "$@"; }
assert_red "T3 worktree: an inherited GIT_DIR does not hide the shared checkout" \
  --contains 'SHARED-CHECKOUT' \
  -- run_hook_with_git_dir "$T3_WT" "rm -rf $T3_CHECKOUT/apps/x"
rm -rf "$T3_WS"

# ── no analyzer: refused, not waved through ─────────────────────────────────
assert_green "python3 cannot run: exit 2 with INTERNAL ERROR" \
  --contains "INTERNAL ERROR" \
  -- exits_2 hook_without_python "$HOOK" '{"tool_name":"Bash","cwd":"/x/.claude/worktrees/a","tool_input":{"command":"pkill -f node"}}'
# The copy carries the whole lib/, and only the analyzer file is broken, so the case
# fails for the reason it names (a copy without lib/ fails anyway, which once let a
# sed that matched nothing pass here).
BROKEN_DIR="$(mktemp -d)"
assert_green "analyzer crash (lib/cross_agent_blast_analyzer.py does not parse): exit 2 with INTERNAL ERROR" \
  --contains "INTERNAL ERROR" \
  --contains "the analyzer did not run" \
  -- exits_2 hook_at "$(hook_with_lib_file "$BROKEN_DIR" pre-bash-cross-agent-blast.sh cross_agent_blast_analyzer.py broken)" \
  "pkill -f node" "/x/.claude/worktrees/a"
assert_green "analyzer file missing (lib/cross_agent_blast_analyzer.py deleted): exit 2 with INTERNAL ERROR" \
  --contains "INTERNAL ERROR" \
  --contains "the analyzer did not run" \
  -- exits_2 hook_at "$(hook_with_lib_file "$BROKEN_DIR" pre-bash-cross-agent-blast.sh cross_agent_blast_analyzer.py missing)" \
  "pkill -f node" "/x/.claude/worktrees/a"
rm -rf "$BROKEN_DIR"

# ── an unreadable command is refused, not read as "no command" (#1297 SR-L-4 class) ──
assert_green "lone surrogate in the command: exit 2 with INTERNAL ERROR, not waved through" \
  --contains "INTERNAL ERROR" \
  -- exits_2 hook_raw "$HOOK" '{"tool_name":"Bash","cwd":"/x/.claude/worktrees/a","tool_input":{"command":"pkill -f node \\ud800"}}'
assert_green "an empty command still passes" \
  --not-contains "INTERNAL ERROR" \
  -- hook_raw "$HOOK" '{"tool_name":"Bash","cwd":"/x/.claude/worktrees/a","tool_input":{"command":""}}'

# SR-M-1 (#1294): a backslash-newline is a line continuation, so the shell joins the word.
for c in $'p\\\nkill -f node # worktree' $'p\\\nkill -f node' $'kill\\\nall node'; do
  assert_red "line continuation: ${c//$'\n'/<NL>}" --contains 'BROADCAST-KILL' -- run_hook "$MINE" "$c"
done
assert_green "a comment keeps its backslash-newline" \
  --not-contains '"decision": "block"' -- run_hook "$MINE" $'ls # p\\\nkill -f node'
# SR-M-2 (#1294): quotes inside a word do not get past the pre-filter.
for c in "p''kill -f node" 'p""kill -f node' "kill'all' node"; do
  assert_red "quote-spliced: $c" --contains 'BROADCAST-KILL' -- run_hook "$MINE" "$c"
done

# F1, round 2 of #1294: `<<<` is a here-string; the line after it runs.
for c in $'cat <<<x\npkill -f node' $'cat <<<x\npk\\\nill -f node'; do
  assert_red "here-string, not heredoc: ${c//$'\n'/<NL>}" --contains 'BROADCAST-KILL' -- run_hook "$MINE" "$c"
done
# F2/F3, round 2 of #1294: the joiner tracks quotes one level deep and reads `${x:- #}` as a
# comment (bash does not), so it leaves these continuations unjoined. Only the second
# reading, with every backslash-newline removed, sees the pkill.
for c in $'echo "$(echo "\'")"; pk\\\nill -f node' $'echo ${x:- #};p\\\nkill -f node'; do
  assert_red "naive-join reading: ${c//$'\n'/<NL>}" --contains 'BROADCAST-KILL' -- run_hook "$MINE" "$c"
done
# Round 3 of #1294: bash runs `$'pkill'` as pkill, and dev-ttl.sh runs what follows `--`.
for c in "\$'pkill' -f node" "\$'killall' node" "scripts/devops/dev-ttl.sh -- pkill -f node" \
         "scripts/devops/dev-ttl.sh --ttl 60 -- pkill -f node" "dev-ttl.sh --ttl=60 -- killall node"; do
  assert_red "wrapped broadcast kill: $c" --contains 'BROADCAST-KILL' -- run_hook "$MINE" "$c"
done
assert_green "dev-ttl.sh around a harmless command" -- run_hook "$MINE" "scripts/devops/dev-ttl.sh --ttl 60 -- ls"
# Round 3 of #1294 kept this shape allowed here while the cmdscan hooks refused it. This
# hook now reads nested code through cmdscan.scan, whose naive-join reading glues the last
# body line onto EOF and reads the backticked word as code, so it refuses the same shape:
# the known false refusal of the cmdscan hooks (accepted LOW), now shared by all of them.
assert_red "naive-join reading: a quoted heredoc body ending in a backslash" --contains 'BROADCAST-KILL' \
  -- run_hook "$MINE" $'cat > note.md <<\'EOF\'\nrun `pkill -f node` and\nline \\\nEOF'

guard_test_summary "test-pre-bash-cross-agent-blast.sh"
