#!/usr/bin/env bash
# test-mutation-gate-node-pin.sh -- proves scripts/devops/mutation-gate.mjs pins its OWN
# runtime at its entry point (PR #1016 follow-up, 2026-10-17), by EXECUTION against fake
# Node installs, not by reading the code.
#
# WHY THIS EXISTS: the harness hook pre:bash:mutation-gate runs
# `node scripts/devops/mutation-gate.mjs --changed` on the SHELL's node before git ever
# starts husky, so .husky/pre-push's pin never applies to it. On Node 20 the shared i18n
# specs fail in Stryker's unmutated dry run ("Cannot use import statement outside a
# module", reproduced with the real hook), and the hook downgraded that to a SKIP -- the
# silent fallback the original task ruled out. The gate now asks the shared rule
# (scripts/devops/lib/ensure-node.sh, also sourced by .husky/pre-push) before doing
# anything, and either re-executes under a satisfying Node or exits 2 naming both
# versions.
#
# HOW: pinNodeOrExit()/resolveNodePin() accept {execPath, env, cwd}, so a fake `node`
# (a shell shim that prints a chosen version) plays "the running node" and a fixture
# repo supplies .nvmrc / package.json. The negative cases run the REAL pinNodeOrExit
# and assert a real exit code 2; the positive ones assert the resolved action. Every
# red case below FAILS against the pre-fix script (no pin: the function does not exist,
# the import throws, exit 1 without the version message).
#
# SIGNAL CASES (cases 11, 13, 14): the re-executed child is a real child process.
#   - SIGTERM / SIGHUP sent to the parent are forwarded to it (case 11);
#   - SIGINT is deliberately NOT forwarded: parent and child share a process group, so a
#     terminal Ctrl-C already reaches the child and forwarding it too delivers it twice.
#     Case 14 runs the gate in its own fresh process group (python3 setpgrp + exec, so a
#     child's `kill -INT 0` can never hit the test runner) and asserts the child's INT
#     trap fires exactly once; it also needs the parent's no-op SIGINT handler, since
#     without it the parent would die and lose the child's exit status;
#   - a child that dies by signal (`kill -KILL $$`) makes the parent exit exactly 2 and
#     name the signal (case 13), the gate's "could not run" contract.
# Residual, by design and not tested: a SIGINT sent to the parent's pid ALONE does not
# reach the child (see pinNodeOrExit's docblock for why it is not detached instead).
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GATE="$GUARD_DIR/mutation-gate.mjs"

WS="$(guard_test_workspace)"
WS="$(cd "$WS" && pwd)"
trap 'rm -rf "$WS"' EXIT

echo "== test-mutation-gate-node-pin.sh =="
echo

# Fixture repo the probe reads (.nvmrc + package.json engines), as the lib expects.
make_repo() {
  local dir="$WS/$1" engines="${2:->=22.19 <23}"
  mkdir -p "$dir"
  echo 22 >"$dir/.nvmrc"
  printf '{\n  "engines": {\n    "node": "%s"\n  }\n}\n' "$engines" >"$dir/package.json"
  printf '%s' "$dir"
}

# A fake node install: $1 = dir, $2 = version it reports.
make_node() {
  mkdir -p "$1"
  printf '#!/bin/sh\necho %s\n' "$2" >"$1/node"
  chmod +x "$1/node"
}

# nvm layout: $1 = root, rest = versions.
make_nvm() {
  local root="$1" v
  shift
  for v in "$@"; do
    make_node "$root/versions/node/$v/bin" "$v"
  done
}

NO_NVM="$WS/no-nvm"

# Runs the REAL pinNodeOrExit with a fake "running node". Prints RETURNED only if the
# pin let the process continue (i.e. it neither exited nor re-executed).
run_pin() {
  local node_dir="$1" repo="$2" nvm="$3" extra_env="${4:-}"
  node --input-type=module -e "
import { pinNodeOrExit } from '$GATE'
pinNodeOrExit({
  execPath: '$node_dir/node',
  env: { PATH: '$node_dir:/usr/bin:/bin', NVM_DIR: '$nvm'$extra_env },
  cwd: '$repo',
})
console.log('RETURNED')
"
}

# Prints the resolved action (no exit, no re-exec) -- for the positive branches.
resolve_pin() {
  local node_dir="$1" repo="$2" nvm="$3"
  node --input-type=module -e "
import { resolveNodePin } from '$GATE'
const r = resolveNodePin({
  execPath: '$node_dir/node',
  env: { PATH: '$node_dir:/usr/bin:/bin', NVM_DIR: '$nvm' },
  cwd: '$repo',
})
console.log('ACTION=' + r.action + ' NODE=' + (r.node ?? ''))
"
}

N20="$WS/node20"
make_node "$N20" v20.15.1
N22="$WS/node22"
make_node "$N22" v22.23.1

# 1 -- the incident: running node is v20, no v22 anywhere -> exit 2, both versions named.
assert_red "running node v20, no v22 install -> exits 2 naming the version found and the one required" \
  --contains "mutation-gate" \
  --contains "v20.15.1" \
  --contains "22.19" \
  --not-contains "RETURNED" \
  -- run_pin "$N20" "$(make_repo r1)" "$NO_NVM"

# 2 -- below the engines minimum, still major 22: not "a v22 is a v22".
N225="$WS/node22-5"
make_node "$N225" v22.5.0
assert_red "running node v22.5.0 (< engines >=22.19), no better install -> refuses" \
  --contains "v22.5.0" \
  --not-contains "RETURNED" \
  -- run_pin "$N225" "$(make_repo r2)" "$NO_NVM"

# 3 -- a NEWER major is as wrong as an older one (engines is "<23").
N24="$WS/node24"
make_node "$N24" v24.13.0
assert_red "running node v24 (above engines <23), no v22 install -> refuses" \
  --contains "v24.13.0" \
  --not-contains "RETURNED" \
  -- run_pin "$N24" "$(make_repo r3)" "$NO_NVM"

# 4 -- an undeterminable engines minimum refuses, it does not degrade to "any v22".
assert_red "engines.node 'latest' (undeterminable) with a v22.23.1 running -> refuses, naming engines.node" \
  --contains "engines.node" \
  --not-contains "RETURNED" \
  -- run_pin "$N22" "$(make_repo r4 latest)" "$NO_NVM"

# 5 -- a satisfying nvm install is found: re-exec under it (the real fix for the incident).
NVM_OK="$WS/nvm-ok"
make_nvm "$NVM_OK" v20.15.1 v22.4.0 v22.23.1
assert_green "running node v20 + v22.23.1 in nvm -> action reexec under that node" \
  --contains "ACTION=reexec" \
  --contains "NODE=$NVM_OK/versions/node/v22.23.1/bin/node" \
  -- resolve_pin "$N20" "$(make_repo r5)" "$NVM_OK"

# 6 -- a satisfying running node is left alone (no re-exec, no refusal).
assert_green "running node v22.23.1 -> action continue, nothing re-executed" \
  --contains "ACTION=continue" \
  -- resolve_pin "$N22" "$(make_repo r6)" "$NO_NVM"

# 7 -- the loop guard is NOT a bypass (CR-M-1): MUTATION_GATE_NODE_PINNED=1 means "the
# lib already chose this node", so a wrong running node under it must refuse, never run
# unpinned and never re-execute again.
assert_red "MUTATION_GATE_NODE_PINNED=1 on a v20 running node -> refuses (the guard is not a bypass)" \
  --contains "MUTATION_GATE_NODE_PINNED=1 is set" \
  --contains "v20.15.1" \
  --not-contains "RETURNED" \
  -- run_pin "$N20" "$(make_repo r7)" "$NVM_OK" ", MUTATION_GATE_NODE_PINNED: '1'"

assert_green "MUTATION_GATE_NODE_PINNED=1 on an acceptable running node -> continues (the re-executed child)" \
  --contains "RETURNED" \
  -- run_pin "$N22" "$(make_repo r7b)" "$NO_NVM" ", MUTATION_GATE_NODE_PINNED: '1'"

# ---------------------------------------------------------------------------
# Cases 8-14 run mutation-gate.mjs AS A SCRIPT (CR-M-2 / SPEC-M-1). Cases 1-7 call the
# exported functions, so deleting the pinNodeOrExit() call inside `if (isMain)` -- the
# line that IS the fix -- left all of them green. These execute the file the way the
# harness hook does: `node mutation-gate.mjs --changed`.
#
# The "running node" must be a real executable whose process.execPath sits in a
# directory we control, so the probe's `node -v` sees OUR shim: <dir>/real-node is a
# copy of the host node (a copy, not a symlink -- execPath is the resolved path on
# Linux), and <dir>/node is a shim that reports a chosen version for `-v` and otherwise
# execs real-node.
# ---------------------------------------------------------------------------
make_script_node() {
  local dir="$1" version="$2"
  mkdir -p "$dir"
  cp "$(command -v node)" "$dir/real-node"
  cat >"$dir/node" <<SHIM
#!/bin/sh
case "\$1" in
  -v) echo $version ;;
  *) exec "\$(dirname "\$0")/real-node" "\$@" ;;
esac
SHIM
  chmod +x "$dir/node"
}

# An nvm layout whose v22.23.1 "node" answers -v, and otherwise runs the given shell body
# (it plays the re-executed child).
make_child_nvm() {
  local root="$1" body="$2" bin="$1/versions/node/v22.23.1/bin"
  mkdir -p "$bin"
  cat >"$bin/node" <<SHIM
#!/bin/sh
if [ "\$1" = "-v" ]; then echo v22.23.1; exit 0; fi
$body
SHIM
  chmod +x "$bin/node"
  # A real nvm bin carries the pnpm installed under that node; the shared lib verifies it
  # against package.json's packageManager pin after a switch (the #1016 shadowing guard).
  printf '#!/bin/sh\necho 7.32.4\n' >"$bin/pnpm"
  chmod +x "$bin/pnpm"
}

S20="$WS/script-node20"
make_script_node "$S20" v20.15.1

# run_gate <running-node-dir> <NVM_DIR> [VAR=value ...] [-- node-flags...]
run_gate() {
  local dir="$1" nvm="$2"
  shift 2
  local envs=() flags=()
  while [ $# -gt 0 ]; do
    if [ "$1" = "--" ]; then
      shift
      flags=("$@")
      break
    fi
    envs+=("$1")
    shift
  done
  ${GATE_PREFIX[@]+"${GATE_PREFIX[@]}"} \
    env -i PATH="$dir:/usr/bin:/bin" HOME="$HOME" NVM_DIR="$nvm" ${envs[@]+"${envs[@]}"} \
    "$dir/node" ${flags[@]+"${flags[@]}"} "$GATE" --changed
}

# 8 -- the incident as the harness hook runs it: a v20 running node, no v22 anywhere ->
# exit 2, both versions named, and no doubled "mutation-gate:" prefix (CR-L-2).
assert_red "[script] v20 running node, no v22 install -> exits non-zero naming both versions" \
  --contains "::error::mutation-gate: REFUSING" \
  --contains "v20.15.1" \
  --contains "22.19" \
  --not-contains "mutation-gate: mutation-gate" \
  -- run_gate "$S20" "$NO_NVM"

# 9 -- the switch: v20 running + a v22 shim that exits 7 -> the switch line is printed
# and the parent's exit code IS the child's.
NVM_EXIT7="$WS/nvm-exit7"
make_child_nvm "$NVM_EXIT7" 'echo "CHILD-RAN pinned=$MUTATION_GATE_NODE_PINNED"; exit 7'
assert_red "[script] v20 + a v22 child that exits 7 -> switch line printed, child ran, exit code is the child's" \
  --contains "using $NVM_EXIT7/versions/node/v22.23.1/bin for this run" \
  --contains "CHILD-RAN pinned=1" \
  -- run_gate "$S20" "$NVM_EXIT7"

# 9b -- the exit code itself must be 7, not merely non-zero.
code_is() {
  local want="$1"
  shift
  "$@" >/dev/null 2>&1
  local got=$?
  echo "EXIT=$got"
  [ "$got" = "$want" ]
}
assert_green "[script] the parent exits with the child's code (7), not 0 / 1 / 2" \
  --contains "EXIT=7" \
  -- code_is 7 run_gate "$S20" "$NVM_EXIT7"

# 10 -- argv and execArgv reach the child.
NVM_ARGS="$WS/nvm-args"
make_child_nvm "$NVM_ARGS" 'echo "CHILD-ARGS $*"; exit 0'
assert_green "[script] the child receives the script path, --changed and the parent's node flags" \
  --contains "CHILD-ARGS --max-old-space-size=123" \
  --contains "mutation-gate.mjs --changed" \
  -- run_gate "$S20" "$NVM_ARGS" -- --max-old-space-size=123

# 11 -- a catchable signal sent to the parent reaches the child (no orphaned Node 22
# Stryker run). The child signals ITS parent, then waits for the forwarded TERM.
NVM_SIG="$WS/nvm-sig"
make_child_nvm "$NVM_SIG" 'trap "echo CHILD-GOT-TERM; exit 9" TERM; kill -TERM $PPID; sleep 5 & wait $!; echo CHILD-NOT-SIGNALLED; exit 0'
assert_red "[script] SIGTERM to the parent is forwarded to the child" \
  --contains "CHILD-GOT-TERM" \
  --not-contains "CHILD-NOT-SIGNALLED" \
  -- run_gate "$S20" "$NVM_SIG"

# 12 -- the loop guard on the real script: a preset guard on a wrong running node refuses.
assert_red "[script] MUTATION_GATE_NODE_PINNED=1 preset on a v20 running node -> refuses, child never runs" \
  --contains "MUTATION_GATE_NODE_PINNED=1 is set" \
  --not-contains "CHILD-RAN" \
  -- run_gate "$S20" "$NVM_EXIT7" MUTATION_GATE_NODE_PINNED=1

# 13 -- a child that DIES BY SIGNAL (CR-M-4): the parent must exit 2 and name the signal,
# not exit 0 or a bare non-zero. Case 11's child traps TERM and exits 9, so it never
# exercised this branch; this child kills itself outright.
NVM_KILLED="$WS/nvm-killed"
make_child_nvm "$NVM_KILLED" 'kill -KILL $$'
assert_red "[script] a child killed by SIGKILL -> the parent reports 'terminated by SIGKILL'" \
  --contains "::error::mutation-gate:" \
  --contains "terminated by SIGKILL" \
  -- run_gate "$S20" "$NVM_KILLED"
assert_green "[script] ...and exits with exactly 2 (the gate's could-not-run code), not 0 or the child's status" \
  --contains "EXIT=2" \
  -- code_is 2 run_gate "$S20" "$NVM_KILLED"

# 14 -- a group-wide interrupt reaches the child EXACTLY ONCE (CR-M-3). Parent and child
# share a process group, so a terminal Ctrl-C already delivers SIGINT to both; forwarding
# it too would deliver it twice. The gate runs in its own fresh process group (python3
# setpgrp + exec) so the child's `kill -INT 0` hits only this group, never the test runner.
# The child counts its INT traps over ~1.2s, long enough for a forwarded second one to land.
NVM_INT="$WS/nvm-int"
make_child_nvm "$NVM_INT" 'n=0; trap "n=\$((n+1))" INT; kill -INT 0; for i in 1 2 3 4; do sleep 0.3 & wait $!; done; echo "CHILD-INT-COUNT=$n"; exit 0'
GATE_PREFIX=(python3 -c 'import os, sys; os.setpgrp(); os.execvp(sys.argv[1], sys.argv[1:])')
assert_green "[script] a group-wide SIGINT reaches the child exactly once (not forwarded a second time)" \
  --contains "CHILD-INT-COUNT=1" \
  --not-contains "CHILD-INT-COUNT=2" \
  -- run_gate "$S20" "$NVM_INT"
GATE_PREFIX=()

guard_test_summary "test-mutation-gate-node-pin.sh"
