#!/usr/bin/env bash
# check-guard-tests-exist.sh — meta-guard (task-guards-teeth, 2026-08-07;
# widened to cover .claude/hooks on 2026-09-01).
#
# WHY: on 2026-08-07 this repo had nine check-* guards standing between it and
# production and zero tests for any of them. One of the nine
# (check-prod-ddl-wiring.py) turned out to be satisfiable by a COMMENT — it had
# been decorative since the day it was written, in direct response to a real prod
# outage. Writing tests for all nine fixes today. This script is what stops the
# tenth guard from arriving untested next month, which is the only reason today's
# fix means anything a year from now.
#
# ── WHY IT DID NOT STOP THE ELEVENTH (2026-09-01) ─────────────────────────────
#
# On 2026-09-01 `.claude/hooks/pre-bash-coder-push-gate.sh` — the gate that
# demands `ac_verified:` before a push — was found to have been blind to the
# `feat/` prefix since it was written, across 15 merged PRs. It also had no
# test. This script did not report that, and could not have: its inventory was
# `"$GUARDS_DIR"/check-*.{sh,py,mjs}` with `GUARDS_DIR` defaulting to
# scripts/devops. Every gate in `.claude/hooks/` is named `pre-bash-*`,
# `pre-edit-write-*`, `pre-agent-*` and lives in a different directory, so not
# one of them was ever in this script's field of view.
#
# It was NOT that the hook was "unregistered" somewhere. There was nothing to
# register with: the inventory was a naming convention in one directory, and
# anything outside it was invisible AND SILENT — which is the same failure this
# script was written to stop, one directory over. Four hooks had tests anyway,
# purely because their authors chose to write them; the header of
# test-pre-bash-mutation-gate.sh says so in as many words ("the hook is not
# itself a `check-*` script, so … does not require this file to exist — it is
# added anyway"). That comment was the defect, sitting in the repo, documented,
# for three weeks.
#
# The fix is to stop deriving the inventory from a filename pattern for the
# hooks half, and derive it from the thing that decides whether a hook RUNS:
# its registration in `.claude/settings.json`. A hook that is not registered
# does not execute; a hook that is registered and can refuse is a guard, and
# needs a test, wherever its file happens to be named or placed. Renaming a
# hook cannot hide it from this check, because the registry is what is read.
#
# WHAT IT REQUIRES
#
#   A. For every scripts/devops/check-*.{sh,py,mjs}:
#      1. A test file exists at scripts/devops/tests/test-<basename>.sh.
#      2. That test contains at least one NEGATIVE assertion (`assert_red` or
#         `assert_red_signal` from tests/lib/harness.sh).
#
#   B. For every hook registered in .claude/settings.json that CAN REFUSE:
#      the same two things, at the same path, with the same negative-assertion
#      rule. "Can refuse" = the hook's file contains the refusal contract of a
#      Claude Code hook — exit code 2 — spelled the way its language spells it
#      (`exit 2`, `process.exit(2)`, `sys.exit(2)`; see refusal_re_for).
#      Registered hooks that never refuse (`pre:edit-write:suggest-compact`,
#      `post:edit-write:coder-progress` — both advisory by design and by their
#      own settings.json description) are listed as advisory and not required
#      to have one, because there is no red for anyone to have watched.
#
#      The hook list itself is EXTENSION-AGNOSTIC: a registered command is
#      traced to any file it names under `.claude/hooks/`, whatever it is
#      called. A registration that names no such file is REPORTED, not skipped.
#
# Requirement 2 is the whole point. "A test exists" is satisfied by `touch`, and
# a test that only asserts the guard stays quiet on good input is satisfied by a
# guard whose body is `exit 0` — which is exactly the disease being treated one
# level up. A guard is only worth having if someone has watched it go red.
#
# WHY THE TEST PATH IS FIXED AT scripts/devops/tests/test-<basename>.sh, for
# hooks too, when `.claude/hooks/tests/` also exists. Because a test nobody runs
# is worth what a guard nobody tests is worth. `run-guard-tests.sh` globs
# `scripts/devops/tests/test-*.sh`, and CI runs that runner inside a REQUIRED
# check; `.claude/hooks/tests/cross-agent-hooks-smoke.sh` was referenced by no
# workflow at all — 42 real cases that CI had never once executed. Requiring the
# path that the runner already sweeps makes "has a test" and "is tested on every
# PR" the same statement instead of two.
#
# WHY THE ANCHOR (review round 2, H2). The first version grepped for the helper
# name anywhere in the file. A reviewer deleted all seven real negative calls
# from test-check-backup-freshness.sh, left only its header — which mentions
# `assert_red` twice while EXPLAINING the rule — and this script reported "10
# guarded, 0 unguarded". So the meta-guard was satisfiable by a comment: exactly
# the defect it was written to stop, reproduced inside the thing meant to stop
# it. The pattern is now anchored to the start of a line, so prose about the
# helper is not the helper.
#
# I had documented a limitation here ("`assert_red \"x\" -- false` would satisfy
# it") which was true but drew the line in the wrong place — the real hole was
# that no call had to exist at all. Keeping the note is worth more than deleting
# it: a stated boundary is only as good as the check under it.
#
# WHAT THIS ACTUALLY CHECKS, stated at the strength it holds (review round 3,
# LOW — the previous wording said "is a real call", which is more than a
# line-oriented grep can promise): a LINE THAT BEGINS with the helper name
# exists. That is strictly stronger than "the name appears somewhere", and
# strictly weaker than "the helper is invoked" — the body of a heredoc, or a
# multi-line string, whose line happens to start with `assert_red` would also
# satisfy it. Making a grep tell those apart is not possible line-by-line, and
# parsing bash to find out is far past what this check is worth.
#
# It does NOT check that the assertion is MEANINGFUL either: `assert_red "x" --
# false` passes. That is a deliberate stopping point — a check strong enough to
# judge meaningfulness is a code reviewer, not a grep. What this closes is the
# gap that actually occurred (a guard with no test; a test with no red case; a
# test whose only "red case" is prose), not every way to write a bad test on
# purpose.
#
# THE "CAN REFUSE" PREDICATE IS ALSO A GREP, and errs the same deliberate way:
# a line beginning `exit 2` inside a comment or a heredoc would count, and a
# hook that refused by some other means would not. It over-includes (demands a
# test where perhaps none is owed) rather than under-includes (lets a real gate
# through untested), which is the only direction worth being wrong in here. As
# of today it separates the nine refusing hooks from the two advisory ones
# exactly.
#
# WHY LANGUAGE-AGNOSTIC, when all eleven hooks are bash (review CR-M-3). The
# first version of part B matched `*.sh` and read only `exit 2`. Nothing was
# wrong yet — and that is the whole objection. An inventory that looks complete
# while silently dropping a category is the exact defect this script was just
# widened to fix, and repeating it one level down would be indefensible in the
# change that fixes it. The first hook written in anything but bash would have
# been invisible, and we would have learned that the way we learned about the
# blind spot above: by accident, months later.
#
# The load-bearing half is the UNKNOWN case. An extension with no reader here
# is treated as REFUSING, so it must have a test. Reading "I cannot parse this"
# as "this is probably harmless" is how a gate stops being checked; reading it
# as "prove it" costs somebody five minutes. Same for a registered command that
# names no file: it is a FAIL saying "this check cannot see what you run",
# because dropping the row is how an inventory starts lying.
#
# KNOWN REMAINING BLIND SPOT, stated because an unstated one is how we got here:
# part A still reads ONE directory. There are `check-*` scripts elsewhere in the
# repo — scripts/check-lessons-cap.sh, scripts/check-package-gates.mjs,
# scripts/architect/check-skill-registry.mjs, apps/api/scripts/check-di-metadata.cjs
# — and none of them has a test. Widening part A to find them is a separate
# change with four test files attached to it; naming them here is what keeps the
# gap from being invisible again in the meantime.
#
# Self-referential on purpose: this script is itself a check-*, so it must have
# its own test with its own negative case, and it does
# (scripts/devops/tests/test-check-guard-tests-exist.sh). If it ever stops
# holding itself to its own rule, it fails itself.
#
# Usage:
#   scripts/devops/check-guard-tests-exist.sh
#       this repo: both parts.
#   scripts/devops/check-guard-tests-exist.sh <guards_dir> <tests_dir>
#       part A only, against fixture directories.
#   scripts/devops/check-guard-tests-exist.sh <guards_dir> <tests_dir> \
#                                             <settings_json> <hooks_dir>
#       both parts, against fixture directories.
#
# The argument forms exist ONLY so the meta-guard's own test can point it at
# fixtures. They change what is inspected, never how strictly.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

GUARDS_DIR="${1:-$SCRIPT_DIR}"
TESTS_DIR="${2:-$SCRIPT_DIR/tests}"

# Part B runs in the no-argument (real repo) form and in the explicit 4-argument
# fixture form. The 2-argument form predates it and stays part-A-only, so the
# fixture cases written for part A keep asserting exactly what they asserted.
HOOKS_MODE=0
SETTINGS_JSON=""
HOOKS_DIR=""
case "$#" in
  0)
    HOOKS_MODE=1
    SETTINGS_JSON="$REPO_DIR/.claude/settings.json"
    HOOKS_DIR="$REPO_DIR/.claude/hooks"
    ;;
  2) ;;
  4)
    HOOKS_MODE=1
    SETTINGS_JSON="$3"
    HOOKS_DIR="$4"
    ;;
  *)
    echo "usage: $(basename "$0") [<guards_dir> <tests_dir> [<settings_json> <hooks_dir>]]" >&2
    exit 1
    ;;
esac

# The helper names from tests/lib/harness.sh that denote a negative case.
# Anchored to line start (leading whitespace allowed) so a mention inside a
# comment or mid-line prose does not count — see the header for exactly how far
# that goes and where it stops. `assert_red` without a `$` suffix so
# `assert_red_signal` (the stdout-contract variant, for check-backup-freshness.sh)
# counts too.
NEGATIVE_ASSERTION_RE='^[[:space:]]*assert_red'

# A hook refuses by exiting 2 with a decision body on stdout. HOW that is
# spelled depends on the language the hook is written in, so the predicate is
# chosen per extension rather than assumed to be bash (review CR-M-3: assuming
# one language is the same silent-inventory defect this script exists to stop,
# one level down).
#
# The UNKNOWN case is the load-bearing one: an extension nothing here recognises
# is treated as REFUSING, so it is required to have a test. Erring toward
# demanding a test costs somebody five minutes; erring the other way is how a
# live gate goes untested for months, which is the thing being fixed.
refusal_re_for() {
  case "$1" in
    *.sh | *.bash) printf '%s' '^[[:space:]]*exit 2' ;;
    *.mjs | *.cjs | *.js) printf '%s' '^[[:space:]]*(process\.exit\(2\)|return[[:space:]]+process\.exit\(2\))' ;;
    *.py) printf '%s' '^[[:space:]]*(sys\.exit\(2\)|raise[[:space:]]+SystemExit\(2\))' ;;
    *) printf '%s' '' ;;
  esac
}

PASS=0
FAIL=0

echo "== check-guard-tests-exist.sh =="
echo "   guards: $GUARDS_DIR"
echo "   tests:  $TESTS_DIR"
if [ "$HOOKS_MODE" = "1" ]; then
  echo "   hooks:  $HOOKS_DIR (registered in $SETTINGS_JSON)"
fi
echo

MISSING_TEST=""
NO_NEGATIVE=""
GUARD_COUNT=0

# ── part A: scripts/devops/check-* ─────────────────────────────────────────────
for guard_path in "$GUARDS_DIR"/check-*.sh "$GUARDS_DIR"/check-*.py "$GUARDS_DIR"/check-*.mjs; do
  # Unmatched globs expand to themselves — skip those.
  [ -f "$guard_path" ] || continue

  guard_name="$(basename "$guard_path")"
  base="${guard_name%.*}"
  test_path="$TESTS_DIR/test-$base.sh"
  GUARD_COUNT=$((GUARD_COUNT + 1))

  if [ ! -f "$test_path" ]; then
    FAIL=$((FAIL + 1))
    MISSING_TEST="${MISSING_TEST}  $guard_name -> expected $(basename "$test_path")
"
    printf 'FAIL  %-52s no test file\n' "$guard_name"
    continue
  fi

  if ! grep -qE "$NEGATIVE_ASSERTION_RE" "$test_path"; then
    FAIL=$((FAIL + 1))
    NO_NEGATIVE="${NO_NEGATIVE}  $guard_name -> $(basename "$test_path")
"
    printf 'FAIL  %-52s test has no negative case\n' "$guard_name"
    continue
  fi

  PASS=$((PASS + 1))
  printf 'PASS  %-52s %s\n' "$guard_name" "$(basename "$test_path")"
done

if [ "$GUARD_COUNT" -eq 0 ]; then
  echo "ERROR: no check-* scripts found in $GUARDS_DIR — wrong directory?" >&2
  exit 1
fi

echo
echo "== $PASS guarded, $FAIL unguarded =="

# ── part B: hooks registered in .claude/settings.json ─────────────────────────
HOOK_PASS=0
HOOK_FAIL=0
HOOK_ADVISORY=0
HOOK_MISSING_TEST=""
HOOK_NO_NEGATIVE=""
HOOK_NOT_ON_DISK=""
HOOK_UNRESOLVED=""

if [ "$HOOKS_MODE" = "1" ]; then
  echo
  echo "== registered hooks =="

  if [ ! -f "$SETTINGS_JSON" ]; then
    echo "ERROR: hook registry $SETTINGS_JSON not found — cannot tell which hooks run." >&2
    exit 1
  fi

  # The registered command carries an ABSOLUTE path baked in at registration
  # time (".../CheekyCheeseIT_CRM/.claude/hooks/x.sh"). That path is wrong in
  # every worktree and does not exist on a CI runner, so only the BASENAME is
  # taken from the registry and resolved against HOOKS_DIR. The registry is
  # being read for WHICH hooks are live, not for where the files are.
  REGISTERED="$(python3 - "$SETTINGS_JSON" <<'PY'
import json, re, sys

with open(sys.argv[1]) as fh:
    settings = json.load(fh)

# Any token that points INSIDE the hooks directory, whatever it is called and
# whatever language it is written in. The previous version matched `*.sh` only,
# which would have made the first hook written in anything else invisible —
# silently, exactly like the blind spot this whole change is about (CR-M-3).
HOOK_PATH = re.compile(r"[^\s'\"]*[/\\]\.claude[/\\]hooks[/\\]([^\s'\"/\\]+)")

seen = set()
rows = []
for entries in (settings.get("hooks") or {}).values():
    for entry in entries or []:
        for hook in entry.get("hooks") or []:
            command = hook.get("command", "")
            found = HOOK_PATH.findall(command)
            if not found:
                # A registered command this check cannot trace to a file. It is
                # reported rather than skipped: "I cannot see what this runs" is
                # information, and dropping it is how inventories start lying.
                rows.append(("unresolved", " ".join(command.split())[:120] or "(empty command)"))
                continue
            for name in found:
                if name not in seen:
                    seen.add(name)
                    rows.append(("hook", name))

print("\n".join("%s\t%s" % row for row in rows))
PY
  )" || {
    echo "ERROR: could not parse $SETTINGS_JSON" >&2
    exit 1
  }

  if [ -z "$REGISTERED" ]; then
    echo "ERROR: no hooks registered in $SETTINGS_JSON — wrong file?" >&2
    exit 1
  fi

  while IFS="$(printf '\t')" read -r kind hook_name; do
    [ -n "$kind" ] || continue

    if [ "$kind" = "unresolved" ]; then
      HOOK_FAIL=$((HOOK_FAIL + 1))
      HOOK_UNRESOLVED="${HOOK_UNRESOLVED}  $hook_name
"
      printf 'FAIL  %-52s registered command traces to no hook file\n' "${hook_name:0:52}"
      continue
    fi

    hook_path="$HOOKS_DIR/$hook_name"

    if [ ! -f "$hook_path" ]; then
      HOOK_FAIL=$((HOOK_FAIL + 1))
      HOOK_NOT_ON_DISK="${HOOK_NOT_ON_DISK}  $hook_name -> expected $hook_path
"
      printf 'FAIL  %-52s registered but not on disk\n' "$hook_name"
      continue
    fi

    # An extension nothing recognises yields an EMPTY pattern, and an empty
    # pattern means "assume it refuses" — so a hook in a new language is
    # required to have a test rather than quietly excused from one (CR-M-3).
    refusal_re="$(refusal_re_for "$hook_name")"
    if [ -n "$refusal_re" ] && ! grep -qE "$refusal_re" "$hook_path"; then
      HOOK_ADVISORY=$((HOOK_ADVISORY + 1))
      printf 'ADVS  %-52s never refuses (no test required)\n' "$hook_name"
      continue
    fi

    # Extension-agnostic, matching part A: check-foo.py -> test-check-foo.sh.
    base="${hook_name%.*}"
    test_path="$TESTS_DIR/test-$base.sh"

    if [ ! -f "$test_path" ]; then
      HOOK_FAIL=$((HOOK_FAIL + 1))
      HOOK_MISSING_TEST="${HOOK_MISSING_TEST}  $hook_name -> expected $(basename "$test_path")
"
      printf 'FAIL  %-52s no test file\n' "$hook_name"
      continue
    fi

    if ! grep -qE "$NEGATIVE_ASSERTION_RE" "$test_path"; then
      HOOK_FAIL=$((HOOK_FAIL + 1))
      HOOK_NO_NEGATIVE="${HOOK_NO_NEGATIVE}  $hook_name -> $(basename "$test_path")
"
      printf 'FAIL  %-52s test has no negative case\n' "$hook_name"
      continue
    fi

    HOOK_PASS=$((HOOK_PASS + 1))
    printf 'PASS  %-52s %s\n' "$hook_name" "$(basename "$test_path")"
  done <<EOF
$REGISTERED
EOF

  echo
  echo "== $HOOK_PASS hooks guarded, $HOOK_FAIL unguarded, $HOOK_ADVISORY advisory =="
fi

TOTAL_FAIL=$((FAIL + HOOK_FAIL))

if [ "$TOTAL_FAIL" -gt 0 ]; then
  echo
  if [ -n "$MISSING_TEST" ] || [ -n "$HOOK_MISSING_TEST" ]; then
    echo "FAIL: these guards have NO test at all:"
    printf '%s' "$MISSING_TEST"
    printf '%s' "$HOOK_MISSING_TEST"
    echo
    echo "  Add scripts/devops/tests/test-<basename>.sh. Start from an existing"
    echo "  one — they all follow the same shape: source lib/harness.sh, build a fixture"
    echo "  (fake repo / PATH shim / fake origin), then assert both directions."
    echo "  For a hook, the fixture is a forged PreToolUse payload on stdin; see"
    echo "  test-pre-bash-coder-push-gate.sh."
  fi
  if [ -n "$NO_NEGATIVE" ] || [ -n "$HOOK_NO_NEGATIVE" ]; then
    echo "FAIL: these tests never assert the guard goes RED:"
    printf '%s' "$NO_NEGATIVE"
    printf '%s' "$HOOK_NO_NEGATIVE"
    echo
    echo "  A test that only proves 'the guard is quiet on good input' is satisfied by a"
    echo "  guard that does nothing at all. Add at least one assert_red / assert_red_signal"
    echo "  case feeding the guard input it MUST reject."
  fi
  if [ -n "$HOOK_UNRESOLVED" ]; then
    echo "FAIL: these registered commands do not name a file under the hooks dir:"
    printf '%s' "$HOOK_UNRESOLVED"
    echo
    echo "  This check can only vouch for hooks it can find on disk. A registration it"
    echo "  cannot trace is reported, not skipped — an inventory that drops what it does"
    echo "  not understand is how this script missed every hook until 2026-09-01."
  fi
  if [ -n "$HOOK_NOT_ON_DISK" ]; then
    echo "FAIL: these hooks are registered in settings.json but absent from disk:"
    printf '%s' "$HOOK_NOT_ON_DISK"
    echo
    echo "  A registered hook that does not exist fails open on every tool call and"
    echo "  says nothing. Restore the file or remove the registration."
  fi
  echo
  echo "Rule: a guard nobody has watched go red is not a guard."
  exit 1
fi

echo
echo "OK: every check-* script has a test, and every test has a negative case."
if [ "$HOOKS_MODE" = "1" ]; then
  echo "OK: every registered hook that can refuse has one too."
fi
exit 0
