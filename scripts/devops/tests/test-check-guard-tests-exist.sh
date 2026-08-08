#!/usr/bin/env bash
# test-check-guard-tests-exist.sh — the meta-guard's own test.
#
# Without this file the task would reproduce its own subject one level up: a
# meta-guard that nobody ever watched go red, asserting that other guards have
# been watched go red. Both of its failure modes are exercised below — a guard
# with no test at all, and a test that exists but never asserts a red.
#
# The last case runs the meta-guard against THIS repo, with no fixtures, which is
# what CI runs.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/check-guard-tests-exist.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# Builds a fixture pair of directories: <case>/guards + <case>/tests.
# $1 = case name -> echoes the case root
new_case() {
  local root="$WS/$1"
  mkdir -p "$root/guards" "$root/tests"
  printf '%s' "$root"
}

write_guard() {
  printf '#!/usr/bin/env bash\nexit 0\n' >"$1"
}

write_test_with_negative() {
  cat >"$1" <<'EOF'
#!/usr/bin/env bash
set -u
. "$(dirname "${BASH_SOURCE[0]}")/lib/harness.sh"
assert_green "good input passes" -- true
assert_red "bad input is rejected" -- false
EOF
}

write_test_without_negative() {
  cat >"$1" <<'EOF'
#!/usr/bin/env bash
set -u
. "$(dirname "${BASH_SOURCE[0]}")/lib/harness.sh"
# Green-only. Satisfied by a guard whose entire body is `exit 0`.
assert_green "guard does not explode on good input" -- true
EOF
}

# Review round 2, H2 — the reviewer's exact attack. Every real negative call is
# deleted; only the header survives, and that header mentions the helper twice
# BECAUSE IT IS EXPLAINING THE RULE. This is the shape a well-documented test
# decays into when someone strips its body, which makes it the likeliest way
# this meta-guard would be fooled in practice rather than an adversarial edge.
write_test_with_negative_only_in_prose() {
  cat >"$1" <<'EOF'
#!/usr/bin/env bash
# This test asserts both directions. Every case below uses assert_green for the
# healthy input and assert_red for the input the guard MUST reject — see
# lib/harness.sh for why the negative half is the one that matters.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/lib/harness.sh"
assert_green "guard does not explode on good input" -- true
EOF
}

# A call that is indented inside a conditional — must still count. Guards
# against "fixing" the anchor into something that only accepts calls in column 0
# and quietly stops seeing most of the suite.
#
# Note this file is itself the clearest illustration of the anchor's documented
# ceiling: the heredocs below contain lines BEGINNING with `assert_red`, which
# the anchor cannot distinguish from a call. This test has real calls too, so
# nothing is masked here — but it is why the guard's header claims "a line that
# begins with the helper" rather than "a real call".
write_test_with_indented_negative() {
  cat >"$1" <<'EOF'
#!/usr/bin/env bash
set -u
. "$(dirname "${BASH_SOURCE[0]}")/lib/harness.sh"
assert_green "good input passes" -- true
if [ -n "${RUN_NEGATIVES:-1}" ]; then
    assert_red_signal "bad input is rejected" --contains "STATUS=stale" -- true
fi
EOF
}

# ── fixtures ───────────────────────────────────────────────────────────────────
COMPLIANT="$(new_case compliant)"
write_guard "$COMPLIANT/guards/check-fixture-alpha.sh"
write_test_with_negative "$COMPLIANT/tests/test-check-fixture-alpha.sh"

MIXED_EXT="$(new_case mixed-ext)"
write_guard "$MIXED_EXT/guards/check-fixture-alpha.sh"
write_test_with_negative "$MIXED_EXT/tests/test-check-fixture-alpha.sh"
printf '#!/usr/bin/env python3\n' >"$MIXED_EXT/guards/check-fixture-beta.py"
write_test_with_negative "$MIXED_EXT/tests/test-check-fixture-beta.sh"
printf '#!/usr/bin/env node\n' >"$MIXED_EXT/guards/check-fixture-gamma.mjs"
write_test_with_negative "$MIXED_EXT/tests/test-check-fixture-gamma.sh"

UNTESTED="$(new_case untested)"
write_guard "$UNTESTED/guards/check-fixture-alpha.sh"
write_test_with_negative "$UNTESTED/tests/test-check-fixture-alpha.sh"
# The tenth guard, arriving next month with no test — the exact scenario.
write_guard "$UNTESTED/guards/check-fixture-newcomer.sh"

GREEN_ONLY="$(new_case green-only)"
write_guard "$GREEN_ONLY/guards/check-fixture-alpha.sh"
write_test_without_negative "$GREEN_ONLY/tests/test-check-fixture-alpha.sh"

EMPTY_TEST="$(new_case empty-test)"
write_guard "$EMPTY_TEST/guards/check-fixture-alpha.sh"
: >"$EMPTY_TEST/tests/test-check-fixture-alpha.sh"

PROSE_ONLY="$(new_case prose-only-negative)"
write_guard "$PROSE_ONLY/guards/check-fixture-alpha.sh"
write_test_with_negative_only_in_prose "$PROSE_ONLY/tests/test-check-fixture-alpha.sh"

INDENTED="$(new_case indented-negative)"
write_guard "$INDENTED/guards/check-fixture-alpha.sh"
write_test_with_indented_negative "$INDENTED/tests/test-check-fixture-alpha.sh"

NO_GUARDS="$(new_case no-guards)"

run_guard() { bash "$GUARD" "$1/guards" "$1/tests"; }
run_guard_on_this_repo() { bash "$GUARD"; }

echo "== test-check-guard-tests-exist.sh =="
echo

# ── positive ───────────────────────────────────────────────────────────────────
assert_green "guard + test with a negative case passes" \
  --contains "1 guarded, 0 unguarded" \
  -- run_guard "$COMPLIANT"

assert_green "all three guard languages (.sh/.py/.mjs) map to test-<basename>.sh" \
  --contains "3 guarded, 0 unguarded" \
  -- run_guard "$MIXED_EXT"

assert_green "the real scripts/devops tree satisfies its own meta-guard" \
  --contains "every check-* script has a test" \
  -- run_guard_on_this_repo

assert_green "an indented assert_red (inside an if) still counts" \
  --contains "1 guarded, 0 unguarded" \
  -- run_guard "$INDENTED"

# ── negative ───────────────────────────────────────────────────────────────────
assert_red "THE POINT: a new guard arrives with no test -> red" \
  --contains "have NO test at all" \
  --contains "check-fixture-newcomer.sh" \
  -- run_guard "$UNTESTED"

assert_red "THE OTHER POINT: test exists but only ever asserts green -> red" \
  --contains "never assert the guard goes RED" \
  --contains "check-fixture-alpha.sh" \
  -- run_guard "$GREEN_ONLY"

assert_red "an empty test file (touch) does not count -> red" \
  --contains "never assert the guard goes RED" \
  -- run_guard "$EMPTY_TEST"

assert_red "H2: the only 'assert_red' is in a comment explaining the rule -> red" \
  --contains "never assert the guard goes RED" \
  --contains "check-fixture-alpha.sh" \
  -- run_guard "$PROSE_ONLY"

assert_red "pointed at a directory with no guards at all -> red, not vacuously green" \
  --contains "no check-* scripts found" \
  -- run_guard "$NO_GUARDS"

guard_test_summary "test-check-guard-tests-exist.sh"
