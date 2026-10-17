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

# 7 -- the loop guard: the re-executed child was already resolved by the lib and must
# not probe again (it would fail only if the pin recursed forever).
assert_green "MUTATION_GATE_NODE_PINNED=1 -> the pin steps aside (re-exec loop guard)" \
  --contains "RETURNED" \
  -- run_pin "$N20" "$(make_repo r7)" "$NO_NVM" ", MUTATION_GATE_NODE_PINNED: '1'"

guard_test_summary "test-mutation-gate-node-pin.sh"
