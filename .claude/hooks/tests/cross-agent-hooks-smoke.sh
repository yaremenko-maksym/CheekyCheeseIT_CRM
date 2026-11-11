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
# Overridable so a claim about these cases can be re-demonstrated instead of
# trusted: point it at a previous revision, or at a deliberately mutated copy,
# and the cases that cover the difference must go red.
#   CROSS_AGENT_BLAST_HOOK=/tmp/blast-mutated.sh bash "$0"
BLAST="${CROSS_AGENT_BLAST_HOOK:-$HOOK_DIR/pre-bash-cross-agent-blast.sh}"
DISPATCH="$HOOK_DIR/pre-agent-dispatch-isolation.sh"

REPO="/Users/maksym/Desktop/programming/CheekyCheeseIT_CRM"
MINE="$REPO/.claude/worktrees/agent-MINE"
OTHER="$REPO/.claude/worktrees/agent-OTHER"

# A reviewer is not given a worktree (agent-isolation.md rule 2), so its checkout
# lives in the session scratchpad — which is SHARED with every sibling agent of
# that session (measured: one flat directory, 190 entries, ~10 agents). The path
# therefore says nothing about whose it is; ownership comes from the ledger this
# hook writes against agent_id, exercised by scratch_case below.
SESS="/private/tmp/claude-501/-Users-maksym-Desktop-programming-CheekyCheeseIT-CRM"
MY_SCRATCH="$SESS/11111111-1111-1111-1111-111111111111/scratchpad"
OTHER_SCRATCH="$SESS/22222222-2222-2222-2222-222222222222/scratchpad"
# PORTABLE mktemp, as `lib/harness.sh` already does it. `mktemp -t <prefix>` is a
# BSD shorthand: GNU coreutils reads the argument as a TEMPLATE and exits 1 with
# "too few X's in template". That is not a style point — it is the defect that
# made this suite green on macOS and red in CI (see "fidelity" below).
LEDGER="$(mktemp "${TMPDIR:-/tmp}/cross-agent-owners.XXXXXX")"

# Scratch-shaped roots this test OWNS, so the cases about what is on disk can
# create directories without touching the real session scratchpad. The name has
# to match the hook's /tmp/claude-<something>/<a>/<b> shape to be recognised as a
# scratchpad at all, and the pid keeps concurrent runs apart.
#
# Spelled /tmp, never /private/tmp: on Linux `/private` does not exist and a
# non-root user cannot create it (`mkdir: cannot create directory '/private':
# Permission denied`), so a /private-rooted fixture is silently never created in
# CI. The hook accepts either spelling, so one /private case is kept deliberately
# further down — on a path that needs no disk.
SMOKE_SESS="/tmp/claude-smoke-$$/proj/sess"
SMOKE_SCRATCH="$SMOKE_SESS/scratchpad"
# A second root where NOTHING is created, so the "scratch root itself" case is
# decided by the one-component rule and not by the existence test.
EMPTY_SESS="/tmp/claude-smokeb-$$/proj/sess"
mkdir -p "$SMOKE_SCRATCH/sibling-live"
trap 'rm -f "$LEDGER"; rm -rf "/tmp/claude-smoke-$$" "/tmp/claude-smokeb-$$"' EXIT

PASS=0
FAIL=0

# Gate 0. A bash syntax error also exits 2 — indistinguishable from a block by
# exit code alone. That is not hypothetical: the first draft of the blast hook
# had an apostrophe inside a single-quoted python block, died at parse time,
# and "passed" all eight block cases while doing nothing. Check syntax first,
# and assert the decision body below, not just the code.
#
# WIDENED 2026-10-21 to EVERY hook, not just these two (CR-M-3). The same defect
# recurred while translating the refusal texts: an English apostrophe in
# `flag's` closed the single-quoted bash string holding the python program and
# broke pre-bash-devserver-ttl-gate.sh outright. A one-off `bash -n` caught it;
# nothing standing would have. Behaviour tests cannot reach it either, because
# the quoting error sat on lines that run ONLY when the analyzer fails — the
# DEGRADED `printf` branch — which no passing test exercises.
#
# This is the only test file inside .claude/hooks, so the property "every hook
# parses" lives here even though it is not about cross-agent isolation.
HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYNTAX_CHECKED=0
for h in "$HOOKS_DIR"/*.sh; do
  [ -f "$h" ] || continue
  if ! bash -n "$h" 2>/dev/null; then
    echo "FATAL: syntax error in $h"
    bash -n "$h"
    exit 1
  fi
  SYNTAX_CHECKED=$((SYNTAX_CHECKED + 1))
done
# The shared analyzer is python, and a broken one makes every hook fall back to
# its coarse rule while still exiting 2 — a degraded guard that looks like a
# working one.
# Every hook analyzer that lives in lib/ is compiled here, not only the shared one.
LIB_COMPILED=0
for lib_py in "$HOOKS_DIR"/lib/*.py; do
  if ! python3 -I -B -c "import py_compile,sys; py_compile.compile(sys.argv[1], doraise=True)" \
    "$lib_py" >/dev/null 2>&1; then
    echo "FATAL: lib/$(basename "$lib_py") does not compile"
    python3 -I -B -c "import py_compile,sys; py_compile.compile(sys.argv[1], doraise=True)" \
      "$lib_py"
    exit 1
  fi
  LIB_COMPILED=$((LIB_COMPILED + 1))
done
# fail closed: the analyzers the hooks run must be among the files compiled
for lib_py in cmdscan.py pre_bash_safety.py cross_agent_blast_analyzer.py live_db_guard_analyzer.py; do
  if [ ! -f "$HOOKS_DIR/lib/$lib_py" ]; then
    echo "FATAL: lib/$lib_py is missing"
    exit 1
  fi
done
# #1304 follow-up: a hook runs in the agent's cwd, so `python3 -c` / `python3 -` without
# -I puts that cwd on sys.path and a planted json.py runs inside the hook.
# The scan lives in its own file: inline in bash single quotes, one stray quote made it
# silently never run (gate 0 still printed success).
if ! python3 -I "$HOOKS_DIR/tests/check_python_isolation.py" --self-test; then
  echo "FATAL: the python3 isolation scanner fails its own self-test"
  exit 1
fi
UNISOLATED=$(python3 -I "$HOOKS_DIR/tests/check_python_isolation.py" "$HOOKS_DIR")
UNISOLATED_RC=$?
# fail closed: a scan that did not run, or read no hooks, is not a pass
SCANNED=$(printf '%s\n' "$UNISOLATED" | sed -n 's/^scanned \([0-9][0-9]*\)$/\1/p')
if [ "$UNISOLATED_RC" -ne 0 ] || [ -z "$SCANNED" ] || [ "$SCANNED" -lt 10 ]; then
  echo "FATAL: the python3 isolation scan did not run (rc=$UNISOLATED_RC, scanned='${SCANNED}')"
  exit 1
fi
UNISOLATED=$(printf '%s\n' "$UNISOLATED" | grep -v '^scanned [0-9]*$' || true)
if [ -n "$UNISOLATED" ]; then
  echo "FATAL: python3 without -I in a hook (cwd on sys.path):"
  echo "$UNISOLATED"
  exit 1
fi
echo "gate 0: $SYNTAX_CHECKED hooks parse, $LIB_COMPILED lib/*.py analyzers compile, every python3 call is isolated (-I)"

# Gate 0b. FIXTURE FIDELITY — the same class of problem as gate 0, learned the
# hard way (PR #1025: green here, red in CI).
#
# The ownership cases need two things to exist before they mean anything: a
# writable ledger, and a directory on disk for the "add onto an existing tree"
# case. When either is silently absent, the suite does not go red — it INVERTS:
# recording dies, so every "expect allow" case fails while every "expect block"
# case still passes, including the three that are supposed to prove the recording
# rule discriminates. A broken fixture made the guard look MORE refusing, which
# is the direction no assertion was watching.
#
# So the fixture is asserted, not assumed, and it fails LOUDLY rather than
# inverting. The ledger assertions further down are the other half: they fail on
# the "allow" side too, so recording cannot die quietly either.
if [ -z "$LEDGER" ] || ! : >>"$LEDGER" 2>/dev/null; then
  echo "FATAL: ledger fixture is not writable (LEDGER='$LEDGER')."
  echo "       Without it nothing is ever recorded, and the suite would INVERT rather than fail:"
  echo "       every allow-case red, every block-case green for the wrong reason."
  exit 1
fi
if [ ! -d "$SMOKE_SCRATCH/sibling-live" ]; then
  echo "FATAL: fixture directory $SMOKE_SCRATCH/sibling-live was not created."
  echo "       The L-1 case (an add onto an EXISTING tree records nothing) would then"
  echo "       pass because the path does not exist, not because the rule held."
  exit 1
fi

# ledger_case <expect:recorded|absent> <agent_id> <path> <label>
# Asserts on the LEDGER rather than on a refusal, so a break in recording turns a
# case red by itself instead of only inverting the allow-cases. Matches a whole
# line, so a record of a parent cannot be mistaken for a record of a child.
# Paths are tmp-normalised the way the hook stores them.
ledger_case() {
  local expect="$1" agent="$2" path="$3" label="$4" got line
  path="${path#/private}"
  line="$(printf '%s\t%s' "$agent" "$path")"
  if grep -qxF "$line" "$LEDGER" 2>/dev/null; then got="recorded"; else got="absent"; fi
  if [ "$got" = "$expect" ]; then
    printf '  ok    %-8s %s\n' "$got" "$label"
    PASS=$((PASS + 1))
  else
    printf '  FAIL  expected %s, got %s — %s\n' "$expect" "$got" "$label"
    FAIL=$((FAIL + 1))
  fi
}

# bash_case <expect:block|allow> <cwd> <command> <label>
bash_case() {
  local expect="$1" cwd="$2" cmd="$3" label="$4"
  local payload rc
  payload=$(MSYS2_ENV_CONV_EXCL='*' CWD="$cwd" CMD="$cmd" python3 -I -B -c '
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

# scratch_case <expect:block|allow> <agent_id> <cwd> <command> <label>
# Same as bash_case but carries an agent_id and points the ownership ledger at a
# temp file, which is what makes "mine" answerable for a scratchpad path.
scratch_case() {
  local expect="$1" agent="$2" cwd="$3" cmd="$4" label="$5"
  local payload rc
  payload=$(MSYS2_ENV_CONV_EXCL='*' CWD="$cwd" CMD="$cmd" AID="$agent" python3 -I -B -c '
import json, os
print(json.dumps({
    "hook_event_name": "PreToolUse",
    "tool_name": "Bash",
    "cwd": os.environ["CWD"],
    "agent_id": os.environ["AID"],
    "tool_input": {"command": os.environ["CMD"]},
}))')
  OUT=$(printf '%s' "$payload" | CROSS_AGENT_WORKTREE_OWNERS="$LEDGER" bash "$BLAST" 2>/dev/null)
  rc=$?
  assert "$expect" "$rc" "$label"
}

# agent_case <expect> <json tool_input> <label>
agent_case() {
  local expect="$1" ti="$2" label="$3"
  local payload rc
  payload=$(TI="$ti" python3 -I -B -c '
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
bash_case block "$MINE" "watch -q 3 pkill -f node"                          'pkill behind watch, -q takes the number'
bash_case block "$MINE" "watch -d 'pkill -f node'"                          'pkill as the watch program string'
bash_case block "$MINE" "watch -bn 2 pkill -f node"                         'SR-M-1: -n at the end of a short cluster takes the value'
bash_case block "$MINE" "watch -dn pkill -f node"                           'SR-M-3: in -dn the n is the glued value of -d, not -n'
bash_case block "$MINE" "watch -s /tmp pkill -f node"                       'SR-M-4: -s takes a value (shotsdir)'
bash_case block "$MINE" "watch -n +2 pkill -f node"                         'SR-M-5: watch parses +2 as an interval'
bash_case block "$MINE" "watch -n 2,5 pkill -f node"                        'SR-M-5: a comma decimal interval'
bash_case block "$MINE" "watch -q +3 pkill -f node"                         'SR-M-6: watch parses +3 as an equexit count'
bash_case block "$MINE" "watch -n 2 ' ( pkill -f node; date)'"             'CR-M-4: several leading empty words before the program'
bash_case block "$MINE" "watch --int 2 pkill -f node"                       'an abbreviated long option (getopt_long prefix) takes the value'
bash_case block "$MINE" "watch -n 2 'pkill -f node; date'"                  'SR-M-2: a ; inside the quoted watch program'
bash_case allow "$MINE" "watch -n 2 git status"                             'watch of a harmless command'

# Nested code, read through cmdscan.scan: each of these passed this hook on origin/main.
bash_case block "$MINE" "exec pkill -f node"                                 'exec runs its operand in place of the shell'
bash_case block "$MINE" "exec -a foo pkill -f node"                          'exec -a takes a value'
bash_case block "$MINE" "bash -c 'pkill -f node'"                            'the program of bash -c'
bash_case block "$MINE" "sudo -u x zsh -lc 'killall node'"                   'a clustered -lc behind sudo'
bash_case block "$MINE" "echo \$(pkill -f node)"                             'a $( ) substitution'
bash_case block "$MINE" 'x=`killall node`'                                   'a backtick substitution in an assignment'
bash_case block "$MINE" "eval 'pkill node'"                                  'eval runs its arguments'
bash_case block "$MINE" "bash -c 'git worktree prune'"                       'git worktree prune inside bash -c'
bash_case block "$MINE" "bash -c 'rm -rf $OTHER/src'"                        'a foreign tree mutated inside bash -c'
bash_case block "$MINE" $'bash <<EOF\npkill -f node\nEOF'                    'a shell runs its heredoc'
bash_case block "$MINE" $'cat <<-EOF | sh\n\tpkill -f node\n\tEOF'           'a heredoc piped into a shell'
bash_case block "$MINE" "bash <<< 'pkill -f node'"                           'a shell runs its here-string'
bash_case block "$MINE" $'cat <<EOF\n$(pkill -f node)\nEOF'                  'an unquoted heredoc expands its $( )'
bash_case allow "$MINE" 'echo $(echo $(echo $(echo $(echo $(echo $(x))))))'   'six nested $( ) are within the scan depth and read'
bash_case block "$MINE" 'echo $(echo $(echo $(echo $(echo $(echo $(echo $(x)))))))' 'NESTED-OPAQUE: seven nested $( ) are past the scan depth'
# Second-opinion round 1 on this change: each one passed it before the fix.
bash_case block "$MINE" $'git apply <<EOF\n+++ b/'"$OTHER"$'/evil\nEOF'        'git apply: a heredoc patch names the files it writes'
bash_case block "$MINE" "bash <(echo 'pkill -f node')"                      'NESTED-OPAQUE: a shell runs a process substitution'
bash_case block "$MINE" "echo 'pkill -f node' | bash"                       'NESTED-OPAQUE: a shell runs code from a pipe'
bash_case block "$MINE" $'xargs git worktree remove <<EOF\n'"$OTHER"$'\nEOF' 'WORKTREE-OPAQUE: the path comes from a heredoc via xargs'
bash_case block "$MINE" "echo $OTHER | xargs git worktree remove"           'WORKTREE-OPAQUE: the path comes from a pipe via xargs'
bash_case block "$MINE" $'eval "$(cat <<EOF\npkill -f node\nEOF\n)"'        'a data-sink body inside $( ) is run by eval'
bash_case block "$MINE" $'bash << EOF; true\nexec pkill -f node\nEOF'       'a delimiter after a space is not a script operand'
bash_case block "$MINE" "bash -s x <<< 'pkill -f node'"                     'bash -s: operands are parameters, code is on stdin'
bash_case block "$MINE" $'cat > s.sh <<\'EOF\'\npkill -f node\nEOF\nbash s.sh' 'a heredoc written to a script the same command runs'
bash_case block "$MINE" "bash -c \$'bash <<EOF\\npkill -f node\\nEOF'"      'an ANSI-C \n in bash -c makes heredoc lines'
bash_case block "$MINE" $'echo \'pkill -f node\' | bash; cat <<EOF\nx\nEOF'  'NESTED-OPAQUE: a heredoc on another segment does not feed a piped shell'
bash_case block "$MINE" "bash -c \$'bash <<EOF\\x0apkill -f node\\012EOF'"  'ANSI-C \x0a and \012 decode to newlines'
# Second-opinion round 2 and the commit security review.
bash_case block "$MINE" $'echo \'pkill -f node\' | bash 3<<\'E\'\nx\nE'      'NESTED-OPAQUE: a heredoc on fd 3 does not feed stdin'
bash_case block "$MINE" "bash /dev/fd/3 3< <(echo 'pkill -f node')"         'NESTED-OPAQUE: code from a fd fed by a process substitution'
bash_case block "$MINE" $'cat <<EOF >/dev/null; echo \'pkill -f node\' | sh\nx\nEOF' 'NESTED-OPAQUE: a body carried from another segment'
bash_case block "$MINE" "echo $OTHER | xargs -I{} git worktree remove --force {}" 'WORKTREE-OPAQUE: an xargs -I placeholder'
bash_case block "$MINE" "find $OTHER -maxdepth 0 -exec git worktree remove {} ;" 'WORKTREE-OPAQUE: a find -exec placeholder'
bash_case block "$MINE" $'git am <<EOF\n+++ b/'"$OTHER"$'/evil\nEOF'          'git am: a heredoc patch names the files it writes'
bash_case block "$MINE" $'cat > deploy <<EOF\npkill -f node\nEOF\n./deploy'   'an extensionless script written and run by the same command'
bash_case block "$MINE" "echo \$'x\\c'; pkill -f node"                      'ANSI-C \c never eats the closing quote'
bash_case block "$MINE" $'cat > deploy <<EOF\npkill -f node\nEOF\nsudo ./deploy' 'a written file run through a wrapper is named again'
bash_case block "$MINE" $'tee run.sh <<EOF\npkill -f node\nEOF\nnohup ./run.sh' 'a tee target run later is named again'
bash_case block "$MINE" "echo $OTHER | xargs -I/x/ph git worktree remove /x/ph" 'WORKTREE-OPAQUE: an xargs placeholder that looks like a path'
bash_case allow "$MINE" $'cat > /tmp/note.md <<EOF\npkill -f node\nEOF'      'a heredoc written to a file nobody runs'
# Second-opinion round 3.
bash_case block "$MINE" $'printf \'pkill -f node\' <<EOF | bash\nx\nEOF'     'NESTED-OPAQUE: a pipe source that owns a heredoc but prints something else'
bash_case block "$MINE" $'cat s.sh <<EOF | bash\ngit worktree list\nEOF'     'NESTED-OPAQUE: cat with a file operand prints the file, not the heredoc'
bash_case block "$MINE" $'cat > deploy <<EOF\npkill -f node\nEOF\nsudo ./*eploy' 'a glob may name the written file'
bash_case block "$MINE" "git -C $OTHER clean -fd"                             'git -C <foreign> takes a value: clean is the subcommand'
bash_case block "$MINE" "git -C $OTHER worktree remove --force ."             'a relative worktree target is read from git -C'
bash_case block "$MINE" "git worktree add /tmp/zz-r3; git worktree remove --force $OTHER" 'a later worktree command on the line is judged'
bash_case block "$MINE" "git worktree move $OTHER /tmp/gone"                  'git worktree move relocates a foreign tree'
bash_case block "$MINE" 'kill -9 -1'                                          'BROADCAST-KILL: pid -1 is every process the user owns'
# PR #1310 review (security, code, spec).
bash_case block "$MINE" 'kill -9 -01'                                         'BROADCAST-KILL: kill reads -01 as -1'
bash_case block "$MINE" 'kill -9 +0'                                          'BROADCAST-KILL: +0 is the process group'
bash_case block "$MINE" 'kill -s TERM -- -1'                                  'BROADCAST-KILL: -s takes a value, -- ends options'
bash_case block "$MINE" 'kill 0'                                              'BROADCAST-KILL: pid 0 is the process group'
bash_case allow "$MINE" 'kill -l 0'                                           'kill -l lists signal names'
bash_case allow "$MINE" 'kill -- -1234'                                       'a negative pid other than -1 is one process group'
bash_case block "$MINE" "git -c alias.wr='worktree remove --force' wr $OTHER"       'NESTED-OPAQUE: a git alias hides the subcommand'
bash_case block "$MINE" "git -C \$X worktree remove ."                              'WORKTREE-OPAQUE: a non-literal git -C directory'
bash_case block "$MINE" $'cat > Makefile <<\'EOF\'\nall:\n\tpkill -f node\nEOF\nmake all' 'a file read by convention (make) is code'
bash_case block "$MINE" "echo 'pkill -f node' |& bash"                           'NESTED-OPAQUE: |& pipes into the shell too'
bash_case block "$MINE" "echo 'pkill -f node' | (bash)"                          'NESTED-OPAQUE: a shell in a subshell reads the pipe'
bash_case block "$MINE" "bash /proc/self/fd/3 3< <(echo 'pkill -f node')"        'NESTED-OPAQUE: /proc/self/fd/N is a fd too'
bash_case allow "$MINE" 'bash --help'                                         'a shell that prints its help reads no code'
bash_case allow "$MINE" "sed -i '' 's|pkill -f|kill|' /tmp/x.sh"                 'a pipe inside a quoted sed script splits nothing'
bash_case block "$MINE" "git -c ALIAS.wr='worktree remove --force' wr $OTHER"       'NESTED-OPAQUE: config section names ignore case'
bash_case block "$MINE" "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.wr GIT_CONFIG_VALUE_0='worktree remove' git wr $OTHER" 'NESTED-OPAQUE: an alias set through GIT_CONFIG_*'
bash_case block "$MINE" $'eval "$(cat <<EOF\ndon\'t\npkill -f node\nEOF\n)"'   'an apostrophe in a double-quoted $( ) body opens no span'
bash_case block "$MINE" $'x=1 \'a\'; pkill -f node; echo \'b\''                  'code between two single-quoted spans is still read'
bash_case block "$MINE" "ssh localhost 'true; pkill -f node'"                     'quoted code for a runner this hook does not read stays in the split'
bash_case block "$MINE" "git -c core.pager='less; pkill -f node' log"             'git -c can run a quoted value: its quotes stay in the split'
bash_case block "$MINE" "git rebase -x 'true; pkill -f node' main"                'git rebase -x runs its quoted argument'
bash_case allow "$MINE" "git commit -m 'drop the pkill -f node; use kill'"        'a quoted commit message is data'
bash_case block "$MINE" "git grep --open-files-in-pager='true; pkill -f node' x" 'git grep -O runs its quoted argument'
bash_case block "$MINE" "rg --pre='true; pkill -f node' x ."                      'rg --pre runs its quoted argument'
bash_case block "$MINE" "sed 's|x|y; pkill -f node|e' f"                          'GNU sed s///e runs the replacement'
bash_case block "$MINE" "sed '1e true; pkill -f node' f"                          'GNU sed e command runs its argument'
bash_case block "$MINE" "sed -f s.sed 's|x|y|; pkill -f node' f"                  'a sed -f script file is not read'
bash_case block "$MINE" "sed -ne's|x|y; pkill -f node|e' f"                  'a script glued into a short-option cluster'
bash_case block "$MINE" "sed --expr='s|x|y; pkill -f node|e' f"              'an abbreviated --expression'
bash_case allow "$MINE" 'kill -1 1234'                                        'a signal number before one pid'
bash_case block "$MINE" "find . -exec sh -c 'x; git worktree remove {}' \\;" 'WORKTREE-OPAQUE: find anywhere on the line, quotes may hide a separator'
bash_case allow "$MINE" $'git commit -m apply <<\'EOF\'\npkill -f node is deprecated\nEOF' 'apply as a commit message word is not the git subcommand'
bash_case allow "$MINE" 'bash --version'                                    'a shell that prints its version reads no code'
bash_case allow "$MINE" $'cat <<EOF | bash\necho hi\nEOF'                   'a harmless heredoc piped into a shell'
bash_case allow "$MINE" $'git commit -F - <<\'EOF\'\nfix: pkill handling\nEOF' 'a commit message that mentions pkill'
# False positives on origin/main: a heredoc body is data, a quoted word is not a redirect.
bash_case allow "$MINE" $'cat <<\'EOF\'\npkill -f node\nEOF'                 'a quoted heredoc that mentions pkill'
bash_case allow "$MINE" $'cat <<EOF\npkill -f node\nEOF'                     'an unquoted heredoc body is still data for cat'
bash_case allow "$MINE" $'cat > /tmp/note.md <<\'EOF\'\nsee '"$OTHER"$'/src\nEOF' 'a note that names a foreign tree'
bash_case allow "$MINE" "sed -i '' 's|a|b 2>\\&1; c|' /tmp/x.sh"             'a quoted sed script holding 2>\&1 redirects nothing'
bash_case allow "$MINE" "bash -c 'git status'"                               'a harmless bash -c'
# Security review of 813a320: a heredoc stays code or arguments unless its consumer reads data.
bash_case block "$MINE" $'xargs rm -rf <<EOF\n'"$OTHER"$'/src\nEOF'             'a heredoc read as xargs arguments names a foreign tree'
bash_case block "$MINE" $'bash /dev/stdin <<EOF\npkill -f node\nEOF'           'a shell reading /dev/stdin runs the heredoc'
bash_case block "$MINE" $'source /dev/stdin <<EOF\npkill -f node\nEOF'         'source /dev/stdin runs the heredoc'
bash_case block "$MINE" $'cat <<EOF | tee /tmp/x | sh\npkill -f node\nEOF'     'the heredoc reaches the shell at the end of the pipeline'
bash_case block "$MINE" "echo \\' > $OTHER/f \\'"                             'an escaped quote outside quotes opens no quoted span'
# Security review of b8580e5: a body is handed to the last segment of its line, not its opener.
bash_case block "$MINE" $'xargs rm -rf <<EOF; cat\n'"$OTHER"$'/src\nEOF'        'the body of xargs, carried by cat, is not stripped'
bash_case block "$MINE" $'bash <<EOF; true\nsh -c \'pkill -f node\'\nEOF'     'the body of bash, carried by true, is scanned as code'
bash_case block "$MINE" "source /dev/stdin <<< 'pkill -f node'"                'source /dev/stdin runs its here-string'
bash_case block "$MINE" $'source -- /dev/stdin <<EOF\npkill -f node\nEOF'      'source -- /dev/stdin runs the heredoc'
bash_case block "$MINE" "echo \$'\\'' > $OTHER/f; echo 'x'"                  'an ANSI-C quoted escaped quote opens no long span'
bash_case allow "$MINE" "source ./env.sh"                                       'source of a script file'
bash_case block "$MINE" $'xargs rm -rf <<EOF; cat \'<<X\'\n'"$OTHER"$'/src\nEOF' 'a quoted <<X argument is not a heredoc opener'
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

# ── the scratchpad widening must not leak (2026-10-17/18) ────────────────────
# Permitting a recorded scratch checkout is a widening, so each neighbour of it
# is pinned here. The first four are the reviewer-confirmed protections; the
# sibling cases below are the defect the first version of this widening had.
bash_case block "$MY_SCRATCH" "git worktree remove --force $OTHER_SCRATCH/checkout" 'another SESSION scratchpad is foreign (different session id)'
bash_case block "$MY_SCRATCH" "git worktree remove --force $OTHER"                  "another agent's worktree, judged from a scratchpad cwd"
bash_case block "$MY_SCRATCH" 'git worktree remove --force "$W"'                    'opaque target from a scratchpad cwd is still WORKTREE-OPAQUE'
bash_case block "$MY_SCRATCH" "git worktree remove --force $REPO"                   'the primary checkout is nobody-removes-it'
bash_case block "$MINE" "git worktree remove --force $OTHER_SCRATCH/checkout"        'a scratch path I cannot attribute to myself stays foreign'

# THE DEFECT THE PATH-BASED WIDENING HAD (CR-M-1, demonstrated with rc 0 on a
# security reviewer checkout). The sibling runs in the SAME session and the SAME
# scratchpad; only its agent_id differs, and that is now what decides.
scratch_case allow agent-A "$MY_SCRATCH" "git worktree add --detach $MY_SCRATCH/sr-pr1024 deadbeef" 'agent A records its own checkout (fixture for the two cases below)'
scratch_case block agent-B "$MY_SCRATCH" "git worktree remove --force $MY_SCRATCH/sr-pr1024" "a SIBLING agent of the same session cannot remove it"
scratch_case block agent-A "$MY_SCRATCH" "git worktree remove --force $MY_SCRATCH/sr-pr1024-notes" 'a record of X does not cover X-notes (prefix boundary)'
scratch_case block ""        "$MY_SCRATCH" "git worktree remove --force $MY_SCRATCH/sr-pr1024" 'without an agent_id nothing is attributable, so nothing is permitted'
# A non-literal `add` cannot be resolved, so it records nothing — and the later
# removal of that same tree by its real owner is refused. That is the cost of the
# canonical "$SCRATCH/checkout" form, and the remedy is one `echo`.
scratch_case allow agent-C "$MY_SCRATCH" 'git worktree add --detach "$SCRATCH/co-C" deadbeef' 'a non-literal add stays silent (and records nothing)'
scratch_case block agent-C "$MY_SCRATCH" "git worktree remove --force $MY_SCRATCH/co-C" 'what was never recorded cannot be removed, even by its maker'

# ── what may be RECORDED: the add branch decides ownership, so it is pinned ──
# A PreToolUse hook records BEFORE git runs, and the first draft recorded any
# literal-looking argument anywhere under the scratchpad. Each case below went
# red against that draft; together they are the recording rule.
#
# L-1: the path of a live sibling checkout. `add` fails in git, but the line was
# written anyway, and the next `remove` was permitted — PR #544 between siblings
# in two commands. A tree that already exists is not one this command creates.
scratch_case allow agent-A "$SMOKE_SCRATCH" "git worktree add --detach $SMOKE_SCRATCH/sibling-live deadbeef" 'adding onto an EXISTING path stays silent (git will refuse it, not this hook)'
ledger_case absent agent-A "$SMOKE_SCRATCH/sibling-live" 'L-1: and it wrote NO line — asserted on the ledger, not inferred from the refusal'
scratch_case block agent-A "$SMOKE_SCRATCH" "git worktree remove --force $SMOKE_SCRATCH/sibling-live" 'L-1: an add onto an existing tree records nothing, so removing it is still refused'

# L-2: `-b mybranch` puts a BRANCH NAME in argument position. It was resolved
# against cwd and recorded as a path. The trait that rejects it is absoluteness,
# not a list of options that take a value.
scratch_case allow agent-A "$SMOKE_SCRATCH" "git worktree add -b mybranch $SMOKE_SCRATCH/co-B deadbeef" 'an add with -b records the PATH argument (and stays silent)'
ledger_case recorded agent-A "$SMOKE_SCRATCH/co-B" 'L-2: the PATH argument is what got recorded'
ledger_case absent agent-A "$SMOKE_SCRATCH/mybranch" 'L-2: the BRANCH NAME did not — the two halves asserted separately'
scratch_case block agent-A "$SMOKE_SCRATCH" "git worktree remove --force $SMOKE_SCRATCH/mybranch" 'L-2: a branch name is not a path, so nothing was recorded for it'
scratch_case allow agent-A "$SMOKE_SCRATCH" "git worktree remove --force $SMOKE_SCRATCH/co-B" 'the real target of that same add IS recorded (the trait keeps the legitimate half)'

# L-3: the scratch ROOT. is_owned matches prefixes, so one root line makes every
# sibling checkout "mine" — CR-M-1 re-opened by the fix for CR-M-1.
scratch_case allow agent-A "$EMPTY_SESS/scratchpad" "git worktree add --detach $EMPTY_SESS deadbeef" 'adding the scratch root itself stays silent'
ledger_case absent agent-A "$EMPTY_SESS" 'L-3: and the ROOT itself was not recorded'
scratch_case block agent-A "$EMPTY_SESS/scratchpad" "git worktree remove --force $EMPTY_SESS/scratchpad/anyones-co" 'L-3: the root is never recorded, so it grants nothing below it'

echo "== pre:bash:cross-agent-blast — MUST STAY SILENT =="
bash_case allow "$MINE" 'kill 12345'                                        'kill <PID> — the prescribed replacement (AC11)'
bash_case allow "$MINE" 'kill -TERM 12345'                                  'kill -TERM <PID> (AC11)'
bash_case allow "$MINE" 'lsof -ti tcp:3011 | xargs kill -9'                 'kill own dev port by PID'
bash_case allow "$MINE" "pgrep -f 'worktrees[/]agent-' | xargs kill -9"     "owner's documented zombie sweep (light-track.md)"
bash_case allow "$MINE" 'grep -rn "pkill" .claude/hooks/'                   'grep for the word pkill — argument, not command'
bash_case allow "$MINE" 'echo "не запускай pkill -f node"'                  'echo mentioning pkill'
bash_case allow "$MINE" "git worktree remove $MINE"                         'removing MY OWN worktree is allowed'

# ── a reviewer cleaning up after itself (2026-10-17/18) ──────────────────────
# Six reviewers in one session could not: own_wt is empty when the cwd is a
# scratchpad, so their OWN checkout came out "not your worktree". Every refusal
# was correct by the predicate's letter and wrong in substance.
#
# The first fix keyed "mine" on the scratchpad path, which was wrong: that
# directory is SHARED by all sibling agents of the session, so it also permitted
# removing a sibling checkout. Ownership is now recorded against agent_id when
# this hook watches the agent create the tree, and the pair below is the whole
# mechanism — the `add` writes the record, the `remove` reads it.
scratch_case allow agent-A "$MY_SCRATCH" "git worktree add --detach $MY_SCRATCH/co-A deadbeef" 'creating my checkout at a literal path is recorded, not blocked'
ledger_case recorded agent-A "$MY_SCRATCH/co-A" 'the add WROTE a ledger line (not merely "was not blocked")'
scratch_case allow agent-A "$MY_SCRATCH" "git worktree remove --force $MY_SCRATCH/co-A" 'removing the checkout recorded against MY agent_id'
# /tmp is a symlink to /private/tmp on macOS, so the harness reports the cwd
# under one spelling and an agent types the other. Same directory, and the record
# must match across the two spellings.
scratch_case allow agent-A "$MY_SCRATCH" "git worktree remove --force /tmp/claude-501/-Users-maksym-Desktop-programming-CheekyCheeseIT-CRM/11111111-1111-1111-1111-111111111111/scratchpad/co-A" '/tmp vs /private/tmp spelling of my own recorded checkout'
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
