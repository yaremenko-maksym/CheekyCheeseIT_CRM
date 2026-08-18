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

HOOK="$REPO_ROOT/.claude/hooks/pre-bash-mutation-gate.sh"

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
