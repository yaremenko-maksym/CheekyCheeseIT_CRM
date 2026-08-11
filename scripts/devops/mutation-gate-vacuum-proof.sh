#!/usr/bin/env bash
# mutation-gate-vacuum-proof.sh — proves the mutation gate catches the REAL
# vacuum test of 2026-08-07 (task-mutation-gate AC4, 2026-08-11).
#
# WHY THIS EXISTS
# ---------------
# "The tool is wired in" is not evidence that a gate works. This repo has been
# burned by that exact claim more than once in one week, so the mutation gate has
# to be shown catching a defect that actually happened, not a synthetic one.
#
# THE SUBJECT: apps/web/app/test/fixtures/2026-08-07-JobSuggestionDialog.vacuum.tsx.txt
# is a verbatim copy of `JobSuggestionDialog.test.tsx` as it stood in c71f7fe2
# (branch feature/job-sourcing-slice1), before the security fix. Its AC6 tests
# read `container` — the render root — while the dialog renders through a Radix
# PORTAL into `document.body`. `container.querySelector('script')` is therefore
# null no matter what the component does, and `container.innerHTML` never
# contains anything at all. The file passes, all of it, against the CURRENT
# hardened component. Run it: it is 11 green tests.
#
# WHAT THIS SCRIPT SHOWS, in four arms against the component's render-side XSS
# defence (`MARKDOWN_URL_TRANSFORM` + `MARKDOWN_COMPONENTS`):
#
#   1  real test              → 4 killed, 1 survivor  → gate RED  (AC2: a
#                               surviving mutant in changed code fails the check)
#   2  real test + suppression WITH a reason          → gate GREEN (AC3)
#   3  real test + suppression WITHOUT a reason       → gate RED   (AC3)
#   4  VACUUM test            → 0 killed, 5 survivors → gate RED   (AC4)
#
# Arm 4 is the one that matters, and the assertion is deliberately harsh: the
# vacuum test must kill ZERO of those five mutants. One of the five deletes the
# entire `MARKDOWN_COMPONENTS` object — the whole render-side defence — and the
# pre-fix suite stays green through it. If a future change makes the vacuum test
# kill even one, this script FAILS: either the fixture stopped reproducing the
# original state or the gate's configuration drifted, and both are things you
# want to hear about rather than discover later.
#
# The arms run through scripts/devops/mutation-gate.mjs — the real gate, the real
# diff machinery — not through a hand-rolled Stryker invocation. The scope comes
# from the gate's own changed-line logic: the base is the commit BEFORE the one
# that added the component, so every line of the file counts as changed, and
# MUTATION_ONLY_FILES then narrows that to the defence block. MUTATION_ONLY_FILES
# can only ever SHRINK the scope (see the gate's env docs), so nothing here can
# manufacture a green.
#
# Every file this script touches is restored on exit, including on Ctrl-C.
#
# Usage:  scripts/devops/mutation-gate-vacuum-proof.sh
# Needs:  pnpm install && pnpm --filter @crm/shared build (the sandboxed vitest
#         run resolves @crm/shared through its built entry point).
set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/../.." && pwd)"
cd "$REPO_ROOT" || exit 2

COMPONENT="apps/web/app/components/job-sourcing/JobSuggestionDialog.tsx"
TEST_FILE="apps/web/app/components/job-sourcing/__tests__/JobSuggestionDialog.test.tsx"
VACUUM_FIXTURE="apps/web/app/test/fixtures/2026-08-07-JobSuggestionDialog.vacuum.tsx.txt"
REPORT="reports/mutation/-crm-web.report.json"

for f in "$COMPONENT" "$TEST_FILE" "$VACUUM_FIXTURE"; do
  if [ ! -f "$f" ]; then
    echo "::error::vacuum-proof: $f is missing — the proof cannot run against a file that is not there." >&2
    exit 2
  fi
done

if [ ! -d node_modules ] || [ ! -f packages/shared/dist/index.js ]; then
  echo "::error::vacuum-proof: run 'pnpm install --frozen-lockfile && pnpm --filter @crm/shared build' first." >&2
  exit 2
fi

BACKUP="$(mktemp -d "${TMPDIR:-/tmp}/vacuum-proof-XXXXXX")"
cp "$COMPONENT" "$BACKUP/component"
cp "$TEST_FILE" "$BACKUP/test"
restore() {
  cp "$BACKUP/component" "$COMPONENT"
  cp "$BACKUP/test" "$TEST_FILE"
  rm -rf "$BACKUP"
}
trap restore EXIT INT TERM

# The commit that ADDED the component; its parent is a tree where the whole file
# is "new", which is what makes every line of it count as changed. Derived, not
# hardcoded, so a rebase/squash of that history does not silently break the proof.
ADD_COMMIT="$(git log --diff-filter=A --format=%H -1 -- "$COMPONENT")"
if [ -z "$ADD_COMMIT" ]; then
  echo "::error::vacuum-proof: cannot find the commit that added $COMPONENT (shallow clone?). Fetch full history." >&2
  exit 2
fi
BASE="$ADD_COMMIT^"

PASS=0
FAIL=0

# Line range of the render-side defence, recomputed each arm because arm 2/3
# insert a comment line above `img:` and shift everything below it.
defence_range() {
  awk '
    /export const MARKDOWN_URL_TRANSFORM/ && !start { start = NR }
    start && /^}$/ { print start "-" NR; exit }
  ' "$COMPONENT"
}

# $1 = arm name. Runs the gate over the defence block; echoes its exit code.
run_gate() {
  local name="$1" range
  range="$(defence_range)"
  echo
  echo "──────────────────────────────────────────────────────────────────────"
  echo "ARM: $name   (mutating $COMPONENT:$range)"
  echo "──────────────────────────────────────────────────────────────────────"
  # Output is NOT filtered: the whole point of this script is that its output is
  # the evidence, and a filtered log is a log you have to be trusted about.
  MUTATION_BASE_SHA="$BASE" \
    MUTATION_PACKAGES="@crm/web" \
    MUTATION_ONLY_FILES="$COMPONENT:$range" \
    node scripts/devops/mutation-gate.mjs --changed 2>&1
  return $?
}

# Inserts a line directly above the `img: () => null,` property, preserving its
# indentation. python3 rather than sed/perl: it is already a hard dependency of
# every guard in this directory, and its behaviour does not differ between the
# BSD tools on macOS and the GNU tools on the runner.
insert_above_img() {
  python3 - "$COMPONENT" "$1" <<'PY'
import re, sys
path, directive = sys.argv[1], sys.argv[2]
src = open(path, encoding='utf-8').read()
m = re.search(r'^([ \t]*)img: \(\) => null,$', src, re.M)
if not m:
    sys.exit("vacuum-proof: could not find the `img: () => null,` property to annotate")
indent = m.group(1)
src = src[:m.start()] + f"{indent}// {directive}\n" + src[m.start():]
open(path, 'w', encoding='utf-8').write(src)
PY
}

# Counts mutants by status in the last report. $1 = status name.
count_status() {
  node -e '
    const fs = require("fs")
    const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    let n = 0
    for (const entry of Object.values(report.files ?? {}))
      for (const m of entry.mutants ?? []) if (m.status === process.argv[2]) n++
    console.log(n)
  ' "$REPORT" "$1"
}

expect() {
  local desc="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1))
    printf 'PASS  %s (%s)\n' "$desc" "$actual"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %s — expected %s, got %s\n' "$desc" "$expected" "$actual"
  fi
}

expect_at_least() {
  local desc="$1" actual="$2" minimum="$3"
  if [ "$actual" -ge "$minimum" ] 2>/dev/null; then
    PASS=$((PASS + 1))
    printf 'PASS  %s (%s >= %s)\n' "$desc" "$actual" "$minimum"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %s — expected at least %s, got %s\n' "$desc" "$minimum" "$actual"
  fi
}

echo "######################################################################"
echo "# mutation gate — vacuum proof"
echo "#   component : $COMPONENT"
echo "#   real test : $TEST_FILE"
echo "#   vacuum    : $VACUUM_FIXTURE"
echo "#   diff base : $BASE ($ADD_COMMIT — the commit that added the component)"
echo "######################################################################"

# ── ARM 1: the real test ──────────────────────────────────────────────────────
run_gate "1/4  real test (as it is on main)"
RC=$?
KILLED_REAL="$(count_status Killed)"
SURVIVED_REAL="$(count_status Survived)"
echo
expect       "arm 1 — gate is RED (a survivor in changed code fails the check)" "$RC" 1
expect_at_least "arm 1 — the real test kills the defence mutants"              "$KILLED_REAL" 4
expect       "arm 1 — exactly one survivor left (the equivalent img mutant)"   "$SURVIVED_REAL" 1

# ── ARM 2: suppression WITH a reason ──────────────────────────────────────────
insert_above_img 'Stryker disable next-line ArrowFunction: React renders nothing for both null and undefined, so no assertion can distinguish the two' || exit 2
run_gate "2/4  real test + suppression WITH a reason"
RC=$?
expect "arm 2 — a suppression that states why is accepted" "$RC" 0

# ── ARM 3: suppression WITHOUT a reason ───────────────────────────────────────
cp "$BACKUP/component" "$COMPONENT"
insert_above_img 'Stryker disable next-line ArrowFunction' || exit 2
GATE3_OUT="$(
  run_gate "3/4  real test + suppression WITHOUT a reason"
  echo "RC=$?"
)"
printf '%s\n' "$GATE3_OUT"
RC="${GATE3_OUT##*RC=}"
expect "arm 3 — a suppression with no stated reason is REJECTED" "$RC" 1
case "$GATE3_OUT" in
  *"without a usable reason"*)
    PASS=$((PASS + 1))
    echo "PASS  arm 3 — the refusal names the missing reason"
    ;;
  *)
    FAIL=$((FAIL + 1))
    echo "FAIL  arm 3 — the refusal did not mention the missing reason"
    ;;
esac

# ── ARM 4: the vacuum test (the whole point) ──────────────────────────────────
cp "$BACKUP/component" "$COMPONENT"
cp "$VACUUM_FIXTURE" "$TEST_FILE"
run_gate "4/4  VACUUM test (c71f7fe2, pre-fix — 11 green tests)"
RC=$?
KILLED_VACUUM="$(count_status Killed)"
SURVIVED_VACUUM="$(count_status Survived)"
echo
expect "arm 4 — gate is RED against the vacuum test"                    "$RC" 1
expect "arm 4 — the vacuum test kills NOTHING"                          "$KILLED_VACUUM" 0
expect "arm 4 — every defence mutant survives it"                       "$SURVIVED_VACUUM" "$((KILLED_REAL + SURVIVED_REAL))"

echo
echo "######################################################################"
echo "# real test  : killed $KILLED_REAL, survived $SURVIVED_REAL"
echo "# vacuum test: killed $KILLED_VACUUM, survived $SURVIVED_VACUUM"
echo "# $PASS passed, $FAIL failed"
echo "######################################################################"

[ "$FAIL" -eq 0 ] || exit 1
exit 0
