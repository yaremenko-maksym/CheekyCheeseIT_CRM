#!/usr/bin/env bash
# test-pre-bash-mutation-gate.sh — proves the pre-push hook
# .claude/hooks/pre-bash-mutation-gate.sh (task-mutation-gate-mechanical AC1)
# makes the right BLOCK / SKIP / PASS decision, by EXECUTION against a fake git
# repo, not by reading the script (AC6: "проверить исполнением, а не вычиткой").
#
# The hook is not itself a `check-*` script, so scripts/devops/
# check-guard-tests-exist.sh does not require this file to exist — it is added
# anyway, next to its siblings, because AC6 asks for exactly this: the four
# outcomes shown by running the real thing.
#
#   (a) changed code + a surviving mutant  -> BLOCK, message on point
#   (b) a clean diff                       -> PASS, no unnecessary delay
#   (c) [covered by test-mutation-gate-reporting.sh: the printed COUNT]
#   (d) the gate cannot run at all         -> visible SKIP, never silent success
#
# Real Stryker is never invoked here: `scripts/devops/mutation-gate.mjs` is
# replaced, inside each fake repo, by a stub that reads its verdict from
# STUB_EXIT/STUB_OUTPUT — this test is about the HOOK's own decision tree
# (which exit code becomes BLOCK vs SKIP vs PASS), not about Stryker.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

# The hook under test. The override exists so the red-first demonstration is
# repeatable by anyone instead of being a claim in a PR body: point it at the
# previous revision of the hook and the runtime cases below must go red.
#
#   git show <sha>:.claude/hooks/pre-bash-mutation-gate.sh >/tmp/hook-before.sh
#   MUTATION_GATE_HOOK_UNDER_TEST=/tmp/hook-before.sh bash "$0"
HOOK="${MUTATION_GATE_HOOK_UNDER_TEST:-$REPO_ROOT/.claude/hooks/pre-bash-mutation-gate.sh}"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# $1 = name. Builds a fake repo on `main`, checked out to `feature/x`, WITHOUT
# Stryker/shared-dist (callers opt in via provide_infra) — that absence is
# itself one of the cases under test.
make_repo() {
  local root="$WS/$1"
  mkdir -p "$root"
  (
    cd "$root" || exit 1
    git init -q -b main
    git config user.email test@example.invalid
    git config user.name "guard test"
    mkdir -p scripts/devops
    echo placeholder >README.md
    git add -A
    git commit -q -m init
    git checkout -q -b feature/x
  ) >/dev/null
  printf '%s' "$root"
}

# A stub scripts/devops/mutation-gate.mjs that ignores its argv and reports
# whatever STUB_EXIT / STUB_OUTPUT say at call time — the hook's env-passing IS
# part of what is under test (it must actually reach the child process).
# STUB_SLEEP_MS (optional, read at CALL time) holds the stub open that many
# milliseconds before exiting — this is what lets a test below assert on REAL
# elapsed wall-clock time instead of a fixed shape (see "elapsed_s() actually
# measures" further down).
write_stub_gate() {
  local root="$1"
  mkdir -p "$root/scripts/devops"
  cat >"$root/scripts/devops/mutation-gate.mjs" <<'EOF'
#!/usr/bin/env node
const ms = Number(process.env.STUB_SLEEP_MS || '0')
if (ms > 0) await new Promise((r) => setTimeout(r, ms))
if (process.env.STUB_OUTPUT) console.log(process.env.STUB_OUTPUT)
process.exit(Number(process.env.STUB_EXIT || '0'))
EOF
}

provide_infra() {
  local root="$1"
  mkdir -p "$root/node_modules/@stryker-mutator/core/bin"
  : >"$root/node_modules/@stryker-mutator/core/bin/stryker.js"
  mkdir -p "$root/packages/shared/dist"
  : >"$root/packages/shared/dist/index.js"
}

# Feeds the hook the same stdin shape Claude Code's PreToolUse:Bash hook gets,
# from inside the fake repo — `cd` here is scoped to this function's own
# subshell (assert_* captures via `$(...)`), it never leaks into the test
# script's own cwd.
run_hook() {
  local root="$1" cmd="$2"
  local json
  json=$(python3 -c 'import json,sys; print(json.dumps({"tool_input":{"command":sys.argv[1]}}))' "$cmd")
  (cd "$root" && printf '%s' "$json" | bash "$HOOK")
}

echo "== test-pre-bash-mutation-gate.sh =="
echo

# ── fast no-ops: never even reach the infra checks ──────────────────────────

ROOT_NOOP="$(make_repo noop)"

assert_green "a non-'git push' command is a silent no-op" \
  --not-contains "pre:bash:mutation-gate" \
  -- run_hook "$ROOT_NOOP" "ls -la"

(cd "$ROOT_NOOP" && git checkout -q main)
assert_green "pushing FROM main/master is a silent no-op (we never push there directly)" \
  --not-contains "pre:bash:mutation-gate" \
  -- run_hook "$ROOT_NOOP" "git push"

# ── (d) the gate cannot run at all -> visible SKIP, never silent ────────────

ROOT_NO_STRYKER="$(make_repo no-stryker)"
write_stub_gate "$ROOT_NO_STRYKER"
# Deliberately NOT calling provide_infra: no Stryker binary in this worktree.

assert_green "Stryker not installed in this worktree -> visible SKIP, push still allowed" \
  --contains "[pre:bash:mutation-gate] SKIP" \
  --contains "StrykerJS is not installed" \
  --contains "NOT verified locally" \
  --not-contains "PASS" \
  -- run_hook "$ROOT_NO_STRYKER" "git push"

ROOT_NO_DIST="$(make_repo no-dist)"
write_stub_gate "$ROOT_NO_DIST"
mkdir -p "$ROOT_NO_DIST/node_modules/@stryker-mutator/core/bin"
: >"$ROOT_NO_DIST/node_modules/@stryker-mutator/core/bin/stryker.js"
# Stryker present, packages/shared/dist absent.

assert_green "packages/shared not built -> visible SKIP naming the exact fix command" \
  --contains "[pre:bash:mutation-gate] SKIP" \
  --contains "packages/shared is not built" \
  --contains "pnpm --filter @crm/shared build" \
  -- run_hook "$ROOT_NO_DIST" "git push"

ROOT_BUDGET="$(make_repo budget-exceeded)"
provide_infra "$ROOT_BUDGET"
write_stub_gate "$ROOT_BUDGET"

STUB_EXIT=2
STUB_OUTPUT="::error::mutation-gate: time budget of 120s exhausted after 121.3s while mutating @crm/api. Completed before the cut-off: @crm/shared (4.1s)."
export STUB_EXIT STUB_OUTPUT
assert_green "the gate itself could not finish (exit 2, e.g. budget exceeded) -> SKIP, not BLOCK" \
  --contains "[pre:bash:mutation-gate] SKIP" \
  --contains "could not complete locally" \
  --contains "budget of 120s exhausted" \
  --not-contains "BLOCK" \
  -- run_hook "$ROOT_BUDGET" "git push"
unset STUB_EXIT STUB_OUTPUT

# ── the runtime: the one environmental case that BLOCKS (2026-10-17) ─────────
#
# These cases use the REAL scripts/devops/lib/ensure-node.sh, not a stub: the
# whole point of the change is that the hook's runtime verdict is the shared
# lib's verdict (the one .husky/pre-push sources and mutation-gate.mjs probes),
# so a stub would prove the fixture and not the coupling. What the fixture
# controls is only the lib's INPUT — .nvmrc, package.json engines.node, and
# NVM_DIR — exactly the three things that decide its answer.
#
# Red-first: against the previous revision of the hook (see
# MUTATION_GATE_HOOK_UNDER_TEST at the top) the first case below reports PASS,
# which is the defect — the gate had not run on a usable runtime at all.
provide_node_pin_lib() {
  local root="$1" major="$2" minor="$3"
  mkdir -p "$root/scripts/devops/lib"
  cp "$REPO_ROOT/scripts/devops/lib/ensure-node.sh" "$root/scripts/devops/lib/ensure-node.sh"
  printf '%s\n' "$major" >"$root/.nvmrc"
  printf '{\n  "name": "fixture",\n  "engines": { "node": ">=%s.%s" }\n}\n' "$major" "$minor" >"$root/package.json"
}

RUNNING_MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"

# The caller's own NVM_DIR is restored after the cases that need to control it;
# clobbering the environment of the suite that invoked us is not this test's
# business (review CR-L-5).
NVM_DIR_SAVED="${NVM_DIR-}"
NVM_DIR_WAS_SET=0
[ -n "${NVM_DIR+x}" ] && NVM_DIR_WAS_SET=1
restore_nvm_dir() {
  if [ "$NVM_DIR_WAS_SET" -eq 1 ]; then
    export NVM_DIR="$NVM_DIR_SAVED"
  else
    unset NVM_DIR
  fi
}

ROOT_WRONG_NODE="$(make_repo wrong-node)"
provide_infra "$ROOT_WRONG_NODE"
write_stub_gate "$ROOT_WRONG_NODE"
# A Node major nothing can satisfy, and an NVM_DIR with no installs in it, so
# the lib has nowhere to switch to and reaches its refusal.
provide_node_pin_lib "$ROOT_WRONG_NODE" 99 0
mkdir -p "$WS/empty-nvm"
export NVM_DIR="$WS/empty-nvm"

STUB_EXIT=0
STUB_OUTPUT="mutation-gate: PASS"
export STUB_EXIT STUB_OUTPUT
assert_red "the gate would run on the WRONG Node -> BLOCK naming both versions, never a SKIP" \
  --contains '"decision": "block"' \
  --contains "[pre:bash:mutation-gate] BLOCK" \
  --contains "does not satisfy Node 99.0+" \
  --contains "cannot run on this runtime" \
  --not-contains "mutation-gate] SKIP" \
  --not-contains "PASS branch=" \
  -- run_hook "$ROOT_WRONG_NODE" "git push"
unset STUB_EXIT STUB_OUTPUT
restore_nvm_dir

# The acceptable-runtime side of the same probe: every other outcome is decided
# by the gate exactly as before. Without this pair the case above is also
# satisfied by a hook that blocks every push.
ROOT_RIGHT_NODE="$(make_repo right-node)"
provide_infra "$ROOT_RIGHT_NODE"
write_stub_gate "$ROOT_RIGHT_NODE"
provide_node_pin_lib "$ROOT_RIGHT_NODE" "$RUNNING_MAJOR" 0

STUB_EXIT=0
STUB_OUTPUT="mutation-gate: PASS"
export STUB_EXIT STUB_OUTPUT
assert_green "the running Node satisfies .nvmrc + engines -> the gate's own PASS stands" \
  --contains "[pre:bash:mutation-gate] PASS" \
  --not-contains "BLOCK" \
  --not-contains "runtime NOT verified" \
  -- run_hook "$ROOT_RIGHT_NODE" "git push"
unset STUB_EXIT STUB_OUTPUT

STUB_EXIT=2
STUB_OUTPUT="::error::mutation-gate: time budget of 120s exhausted after 121.3s while mutating @crm/api."
export STUB_EXIT STUB_OUTPUT
assert_green "an acceptable runtime + exit 2 for ANY OTHER reason -> still a SKIP (the other skip paths are untouched)" \
  --contains "[pre:bash:mutation-gate] SKIP" \
  --contains "could not complete locally" \
  --not-contains "BLOCK" \
  -- run_hook "$ROOT_RIGHT_NODE" "git push"
unset STUB_EXIT STUB_OUTPUT

# ── "the lib says no" vs "the lib could not be consulted" (CR-M-2) ──────────
#
# Only exit 1 WITH output is a verdict — `die` and the final refusal are the only
# paths in ensure-node.sh that exit 1, and both print first. A broken library
# (unreadable, not sourceable, no ensure_node, no `sh`) must NOT block the push
# while advising `nvm use 22`: that is wrong advice for a broken file and a way to
# wedge every push on an environment defect. It also must not pass silently.
ROOT_BROKEN_LIB="$(make_repo broken-lib)"
provide_infra "$ROOT_BROKEN_LIB"
write_stub_gate "$ROOT_BROKEN_LIB"
mkdir -p "$ROOT_BROKEN_LIB/scripts/devops/lib"
# Sourceable, but defines no ensure_node -> the probe exits 127.
: >"$ROOT_BROKEN_LIB/scripts/devops/lib/ensure-node.sh"

STUB_EXIT=0
STUB_OUTPUT="mutation-gate: PASS"
export STUB_EXIT STUB_OUTPUT
assert_green "a lib with no ensure_node (exit 127) is NOT a verdict -> no block, loud notice, gate decides" \
  --contains "runtime NOT verified" \
  --contains "could not be consulted" \
  --contains "exited 127" \
  --contains "Fix the library, not your Node" \
  --contains "[pre:bash:mutation-gate] PASS" \
  --not-contains '"decision": "block"' \
  --not-contains "nvm install" \
  -- run_hook "$ROOT_BROKEN_LIB" "git push"
unset STUB_EXIT STUB_OUTPUT

ROOT_UNREADABLE_LIB="$(make_repo unreadable-lib)"
provide_infra "$ROOT_UNREADABLE_LIB"
write_stub_gate "$ROOT_UNREADABLE_LIB"
provide_node_pin_lib "$ROOT_UNREADABLE_LIB" 99 0
chmod 000 "$ROOT_UNREADABLE_LIB/scripts/devops/lib/ensure-node.sh"

STUB_EXIT=0
STUB_OUTPUT="mutation-gate: PASS"
export STUB_EXIT STUB_OUTPUT
assert_green "a lib that cannot be READ is not a verdict either (it demands Node 99 but nobody can see that)" \
  --contains "runtime NOT verified" \
  --contains "missing or unreadable" \
  --not-contains '"decision": "block"' \
  -- run_hook "$ROOT_UNREADABLE_LIB" "git push"
unset STUB_EXIT STUB_OUTPUT
chmod 644 "$ROOT_UNREADABLE_LIB/scripts/devops/lib/ensure-node.sh"

ROOT_SYNTAX_LIB="$(make_repo syntax-lib)"
provide_infra "$ROOT_SYNTAX_LIB"
write_stub_gate "$ROOT_SYNTAX_LIB"
mkdir -p "$ROOT_SYNTAX_LIB/scripts/devops/lib"
printf 'ensure_node() {\n  if [ \n}\n' >"$ROOT_SYNTAX_LIB/scripts/devops/lib/ensure-node.sh"

STUB_EXIT=0
STUB_OUTPUT="mutation-gate: PASS"
export STUB_EXIT STUB_OUTPUT
assert_green "a lib with a syntax error is NOT a verdict either -> no block, loud notice" \
  --contains "runtime NOT verified" \
  --contains "could not be consulted" \
  --not-contains '"decision": "block"' \
  -- run_hook "$ROOT_SYNTAX_LIB" "git push"
unset STUB_EXIT STUB_OUTPUT

# ── the caveat must survive to the FINAL banner (CR-M-3) ────────────────────
#
# A notice printed only before a 25-53s gate run has scrolled past by the time
# the verdict appears. An unverified runtime ending in a bare PASS is the same
# "not checked reads as fine" collapse, one line later.
STUB_EXIT=0
STUB_OUTPUT="mutation-gate: PASS"
export STUB_EXIT STUB_OUTPUT
assert_green "PASS after an unverified runtime carries the caveat on the verdict line, not only before it" \
  --contains "this verdict was produced on a Node nobody checked" \
  -- run_hook "$ROOT_BROKEN_LIB" "git push"
unset STUB_EXIT STUB_OUTPUT

STUB_EXIT=2
STUB_OUTPUT="::error::mutation-gate: time budget of 120s exhausted after 121.3s."
export STUB_EXIT STUB_OUTPUT
assert_green "a SKIP after an unverified runtime carries it too" \
  --contains "[pre:bash:mutation-gate] SKIP" \
  --contains "this verdict was produced on a Node nobody checked" \
  -- run_hook "$ROOT_BROKEN_LIB" "git push"
unset STUB_EXIT STUB_OUTPUT

# And the normal case stays clean: no caveat when the runtime WAS judged.
STUB_EXIT=0
STUB_OUTPUT="mutation-gate: PASS"
export STUB_EXIT STUB_OUTPUT
assert_green "a verified runtime leaves the banner unchanged (no caveat noise)" \
  --contains "[pre:bash:mutation-gate] PASS" \
  --not-contains "nobody checked" \
  -- run_hook "$ROOT_RIGHT_NODE" "git push"
unset STUB_EXIT STUB_OUTPUT

# ── the probe's third outcome: the lib SWITCHES (CR-L-4) ────────────────────
#
# A satisfying nvm install exists but is not the running node: ensure_node
# prepends it and returns 0. mutation-gate.mjs re-executes itself under it, so
# the hook must stay out of the way — no block, and no doubling of the notice the
# gate prints for itself.
ROOT_SWITCH="$(make_repo switch-node)"
provide_infra "$ROOT_SWITCH"
write_stub_gate "$ROOT_SWITCH"
# Demand a minor the running node cannot satisfy, and plant an nvm install that can.
provide_node_pin_lib "$ROOT_SWITCH" "$RUNNING_MAJOR" 9999
FAKE_NVM="$WS/fake-nvm/versions/node/v$RUNNING_MAJOR.9999.0/bin"
mkdir -p "$FAKE_NVM"
printf '#!/bin/sh\necho "v%s.9999.0"\n' "$RUNNING_MAJOR" >"$FAKE_NVM/node"
chmod +x "$FAKE_NVM/node"
export NVM_DIR="$WS/fake-nvm"

STUB_EXIT=0
STUB_OUTPUT="mutation-gate: PASS"
export STUB_EXIT STUB_OUTPUT
assert_green "a switchable runtime is neither blocked nor flagged — the gate re-executes itself" \
  --contains "[pre:bash:mutation-gate] PASS" \
  --not-contains '"decision": "block"' \
  --not-contains "runtime NOT verified" \
  --not-contains "nobody checked" \
  -- run_hook "$ROOT_SWITCH" "git push"
unset STUB_EXIT STUB_OUTPUT
restore_nvm_dir

# The lib itself absent (a checkout older than PR #1021): the runtime cannot be
# judged, so the hook says so OUT LOUD and still runs the gate. Silence here
# would re-create the exact collapse of "not checked" into "fine".
STUB_EXIT=1
STUB_OUTPUT='::error::mutant SURVIVED (ConditionalExpression)'
export STUB_EXIT STUB_OUTPUT
assert_red "no ensure-node.sh in this checkout -> 'runtime NOT verified' said out loud, the gate still decides" \
  --contains "runtime NOT verified" \
  --contains "[pre:bash:mutation-gate] BLOCK" \
  --contains "mutant SURVIVED" \
  -- run_hook "$ROOT_BUDGET" "git push"
unset STUB_EXIT STUB_OUTPUT

# ── (a) a real finding blocks the push ───────────────────────────────────────

ROOT_SURVIVOR="$(make_repo survivor)"
provide_infra "$ROOT_SURVIVOR"
write_stub_gate "$ROOT_SURVIVOR"

STUB_EXIT=1
STUB_OUTPUT='::error::mutant SURVIVED (ConditionalExpression) — the tests pass with this change applied: true'
export STUB_EXIT STUB_OUTPUT
assert_red "changed code with a surviving mutant -> BLOCK, message names the actual problem" \
  --contains '"decision": "block"' \
  --contains "BLOCK" \
  --contains "mutant SURVIVED" \
  -- run_hook "$ROOT_SURVIVOR" "git push"
unset STUB_EXIT STUB_OUTPUT

# ── (b) a clean diff passes, and a passing push still surfaces AC2 warnings ─

ROOT_CLEAN="$(make_repo clean-diff)"
provide_infra "$ROOT_CLEAN"
write_stub_gate "$ROOT_CLEAN"

STUB_EXIT=0
STUB_OUTPUT="mutation-gate: no mutable source lines changed vs the base — nothing to mutate."
export STUB_EXIT STUB_OUTPUT
assert_green "a clean diff (nothing to mutate) passes" \
  --contains "[pre:bash:mutation-gate] PASS" \
  -- run_hook "$ROOT_CLEAN" "git push"
unset STUB_EXIT STUB_OUTPUT

STUB_EXIT=0
STUB_OUTPUT=$'mutation-gate: PASS\n::warning::suppression at packages/shared/src/thing.ts:42 (ArrowFunction) silences 8 mutant(s) — COVERS MORE THAN ONE MUTANT, verify each is intended'
export STUB_EXIT STUB_OUTPUT
assert_green "a passing push still surfaces a multi-mutant suppression count verbatim (AC2, end to end)" \
  --contains "[pre:bash:mutation-gate] PASS" \
  --contains "COVERS MORE THAN ONE MUTANT" \
  --contains "silences 8 mutant(s)" \
  -- run_hook "$ROOT_CLEAN" "git push"
unset STUB_EXIT STUB_OUTPUT

# ── real, printed wall-clock time (review round 2, 2026-08-18) ──────────────
#
# The header's estimate was quoted as ONE number and measured 10x off for
# apps/api by a reviewer — the fix is not a better estimate, it is printing
# the ACTUAL elapsed time on every verdict so nobody has to trust a comment.
# This proves the number is real (computed via python3's clock), not the "?"
# fallback that only fires when the clock read itself fails.

STUB_EXIT=0
STUB_OUTPUT="mutation-gate: no mutable source lines changed vs the base — nothing to mutate."
export STUB_EXIT STUB_OUTPUT
assert_green "PASS banner carries the elapsed segment right after branch=, not the '?' fallback" \
  --contains "[pre:bash:mutation-gate] PASS branch=feature/x (" \
  --not-contains "(?s)" \
  -- run_hook "$ROOT_CLEAN" "git push"
unset STUB_EXIT STUB_OUTPUT

STUB_EXIT=1
STUB_OUTPUT='::error::mutant SURVIVED (ConditionalExpression) — the tests pass with this change applied: true'
export STUB_EXIT STUB_OUTPUT
assert_red "BLOCK banner also carries a real elapsed segment, not the '?' fallback" \
  --contains "[pre:bash:mutation-gate] BLOCK branch=feature/x (" \
  --not-contains "(?s)" \
  -- run_hook "$ROOT_SURVIVOR" "git push"
unset STUB_EXIT STUB_OUTPUT

assert_green "SKIP banner (Stryker missing, no gate ever ran) still carries a real elapsed segment" \
  --contains "[pre:bash:mutation-gate] SKIP branch=feature/x (" \
  --not-contains "(?s)" \
  -- run_hook "$ROOT_NO_STRYKER" "git push"

# ── elapsed_s() actually measures, not just "looks like a number" ──────────
# (review round 3, 2026-08-18 — the three cases above only proved the SHAPE
# of the elapsed segment: that it appears, and that it is not the "?" clock-
# failure fallback. A reviewer applied exactly the mutation this class of bug
# needs — replaced elapsed_s()'s body with a hardcoded "0.0" — and all three
# stayed green, because a constant satisfies "is present" and "is not '?'"
# equally well. That is the same defect this whole task exists to catch,
# reproduced in its own test: an assertion that cannot tell measurement from
# mock. The fix mirrors the project's own mutate-the-input convention: don't
# read the code, feed it two inputs whose correct outputs MUST differ, and
# assert the difference. Here the "input" is real wall-clock time, so the
# fixture is a stub that sleeps a known amount before the hook computes
# elapsed_s() — a fast run (stub sleeps ~0ms) and a slow run (stub sleeps
# ~1500ms) MUST report different numbers if elapsed_s() reads a real clock,
# and CANNOT if it returns a constant.
elapsed_reflects_real_time() {
  local root="$1"
  local fast_out slow_out fast_s slow_s

  export STUB_EXIT=0
  export STUB_OUTPUT="mutation-gate: no mutable source lines changed vs the base — nothing to mutate."
  export STUB_SLEEP_MS=0
  fast_out=$(run_hook "$root" "git push" 2>&1)

  export STUB_SLEEP_MS=1500
  slow_out=$(run_hook "$root" "git push" 2>&1)

  unset STUB_EXIT STUB_OUTPUT STUB_SLEEP_MS

  fast_s=$(printf '%s' "$fast_out" | grep -oE '\([0-9]+\.[0-9]+s\)' | head -1 | tr -d '()s')
  slow_s=$(printf '%s' "$slow_out" | grep -oE '\([0-9]+\.[0-9]+s\)' | head -1 | tr -d '()s')

  echo "fast run (stub slept 0ms):    banner elapsed = ${fast_s:-<none extracted>}s"
  echo "slow run (stub slept 1500ms): banner elapsed = ${slow_s:-<none extracted>}s"

  if [ -z "$fast_s" ] || [ -z "$slow_s" ]; then
    echo "FAIL: could not extract a numeric elapsed segment from one of the two banners"
    return 1
  fi

  python3 -c "
import sys
fast, slow = float(sys.argv[1]), float(sys.argv[2])
print(f'delta = {slow - fast:.2f}s (need >= 1.0s -- comfortably under the 1.5s injected delay, ' \
      f'so scheduling jitter cannot flip this, but a constant elapsed_s() -- delta 0.00s -- fails it)')
sys.exit(0 if (slow - fast) >= 1.0 else 1)
" "$fast_s" "$slow_s"
}

assert_green "elapsed_s() reports a LARGER number for a deliberately slower run (kills the constant-'0.0' mutation)" \
  -- elapsed_reflects_real_time "$ROOT_CLEAN"

guard_test_summary "test-pre-bash-mutation-gate.sh"
