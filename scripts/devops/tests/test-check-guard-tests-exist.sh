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

# ── fixtures for the hooks half (added 2026-09-01) ─────────────────────────────
# The meta-guard grew a second inventory: hooks registered in
# .claude/settings.json. Its own test has to watch THAT half go red too, or the
# widening is exactly the kind of thing it was written to stop — a check nobody
# has seen refuse anything.
#
# Every hooks fixture also gets a compliant check-* pair, because part A still
# runs and errors out on a directory with no guards in it (deliberately: a
# vacuous green is the failure mode of the whole family).

new_hook_case() {
  local root
  root="$(new_case "$1")"
  mkdir -p "$root/hooks"
  write_guard "$root/guards/check-fixture-alpha.sh"
  write_test_with_negative "$root/tests/test-check-fixture-alpha.sh"
  printf '%s' "$root"
}

# A hook that CAN refuse: it has a line beginning `exit 2`, which is the
# documented refusal contract of a Claude Code hook.
write_refusing_hook() {
  printf '#!/usr/bin/env bash\nif [ "${X:-}" = bad ]; then\n  exit 2\nfi\nexit 0\n' >"$1"
}

# A hook that never refuses — the advisory shape (`suggest-compact`,
# `coder-progress`). No test is owed, because there is no red to watch.
write_advisory_hook() {
  printf '#!/usr/bin/env bash\necho "just a nudge"\nexit 0\n' >"$1"
}

# The registry names hooks by an ABSOLUTE path baked in at registration time.
# Writing a path that does not exist here is the point: the meta-guard must take
# the BASENAME and resolve it against the hooks dir it was given, or it would be
# broken in every worktree and on every CI runner.
write_settings() {
  local out="$1"
  shift
  python3 - "$out" "$@" <<'PY'
import json, sys

out, names = sys.argv[1], sys.argv[2:]
settings = {
    "PreToolUse": [
        {
            "matcher": "Bash",
            "hooks": [{"type": "command", "command": f"bash /nonexistent/repo/.claude/hooks/{n}"}],
            "id": f"pre:bash:{n}",
        }
        for n in names
    ]
}
with open(out, "w") as fh:
    json.dump({"hooks": settings}, fh, indent=1)
PY
}

HOOK_OK="$(new_hook_case hooks-compliant)"
write_refusing_hook "$HOOK_OK/hooks/pre-bash-fixture-gate.sh"
write_test_with_negative "$HOOK_OK/tests/test-pre-bash-fixture-gate.sh"
write_settings "$HOOK_OK/settings.json" pre-bash-fixture-gate.sh

HOOK_UNTESTED="$(new_hook_case hooks-untested)"
write_refusing_hook "$HOOK_UNTESTED/hooks/pre-bash-fixture-gate.sh"
# No test written on purpose — the pre-bash-coder-push-gate.sh scenario exactly.
write_settings "$HOOK_UNTESTED/settings.json" pre-bash-fixture-gate.sh

HOOK_GREEN_ONLY="$(new_hook_case hooks-green-only)"
write_refusing_hook "$HOOK_GREEN_ONLY/hooks/pre-bash-fixture-gate.sh"
write_test_without_negative "$HOOK_GREEN_ONLY/tests/test-pre-bash-fixture-gate.sh"
write_settings "$HOOK_GREEN_ONLY/settings.json" pre-bash-fixture-gate.sh

HOOK_ADVISORY="$(new_hook_case hooks-advisory)"
write_advisory_hook "$HOOK_ADVISORY/hooks/pre-edit-write-fixture-nudge.sh"
write_settings "$HOOK_ADVISORY/settings.json" pre-edit-write-fixture-nudge.sh

# Registered, but the file is gone. This fails OPEN at runtime on every tool
# call and says nothing — the quietest possible way for a gate to stop existing.
HOOK_ABSENT="$(new_hook_case hooks-absent)"
write_settings "$HOOK_ABSENT/settings.json" pre-bash-fixture-gate.sh

HOOK_EMPTY_REGISTRY="$(new_hook_case hooks-empty-registry)"
write_refusing_hook "$HOOK_EMPTY_REGISTRY/hooks/pre-bash-fixture-gate.sh"
write_test_with_negative "$HOOK_EMPTY_REGISTRY/tests/test-pre-bash-fixture-gate.sh"
printf '{"hooks":{}}\n' >"$HOOK_EMPTY_REGISTRY/settings.json"

HOOK_NO_SETTINGS="$(new_hook_case hooks-no-settings)"
write_refusing_hook "$HOOK_NO_SETTINGS/hooks/pre-bash-fixture-gate.sh"
write_test_with_negative "$HOOK_NO_SETTINGS/tests/test-pre-bash-fixture-gate.sh"
# settings.json deliberately never written.

run_guard() { bash "$GUARD" "$1/guards" "$1/tests"; }
run_guard4() { bash "$GUARD" "$1/guards" "$1/tests" "$1/settings.json" "$1/hooks"; }
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

# ── the hooks half (added 2026-09-01) ─────────────────────────────────────────

assert_green "a registered refusing hook WITH a negative-case test passes" \
  --contains "1 hooks guarded, 0 unguarded" \
  -- run_guard4 "$HOOK_OK"

assert_green "the real repo satisfies the hooks half too" \
  --contains "every registered hook that can refuse has one too" \
  -- run_guard_on_this_repo

# The 2-argument form predates the hooks half and must stay part-A-only:
# otherwise every part-A fixture case would silently start evaluating the real
# repo's hooks and report counts nobody asked it for.
assert_green "the 2-argument fixture form does not run the hooks half at all" \
  --not-contains "registered hooks" \
  -- run_guard "$COMPLIANT"

assert_green "a registered hook that never refuses is advisory, not a failure" \
  --contains "1 hooks guarded, 0 unguarded, 0 advisory" \
  --not-contains "never refuses" \
  -- run_guard4 "$HOOK_OK"

assert_green "an advisory-only registry passes with nothing owed" \
  --contains "0 hooks guarded, 0 unguarded, 1 advisory" \
  --contains "never refuses" \
  -- run_guard4 "$HOOK_ADVISORY"

assert_red "THE 2026-09-01 POINT: a registered refusing hook with no test -> red" \
  --contains "have NO test at all" \
  --contains "pre-bash-fixture-gate.sh" \
  -- run_guard4 "$HOOK_UNTESTED"

assert_red "a hook test that only ever asserts green -> red" \
  --contains "never assert the guard goes RED" \
  --contains "pre-bash-fixture-gate.sh" \
  -- run_guard4 "$HOOK_GREEN_ONLY"

assert_red "registered but absent from disk -> red (it fails open and says nothing)" \
  --contains "registered in settings.json but absent from disk" \
  -- run_guard4 "$HOOK_ABSENT"

assert_red "an empty registry is not a vacuous green" \
  --contains "no hooks registered" \
  -- run_guard4 "$HOOK_EMPTY_REGISTRY"

assert_red "a missing registry is not a vacuous green either" \
  --contains "hook registry" \
  -- run_guard4 "$HOOK_NO_SETTINGS"

assert_red "a wrong number of arguments is refused, not half-interpreted" \
  --contains "usage:" \
  -- bash "$GUARD" "$HOOK_OK/guards" "$HOOK_OK/tests" "$HOOK_OK/settings.json"

guard_test_summary "test-check-guard-tests-exist.sh"
