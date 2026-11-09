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
# WHERE THE DEFENCE LIVES NOW (r5 Task 7.3, PR #1302): the render-side defence
# was extracted from JobSuggestionDialog.tsx into PostingMarkdown.tsx, which both
# the dialog and the vacancy-queue card (JobQueueCard) render. The dialog still
# renders it, so the vacuum fixture — a copy of the DIALOG's test — is still the
# subject; only the mutated file moved. The defence block is everything from
# `MARKDOWN_URL_TRANSFORM` to the end of `MARKDOWN_COMPONENTS`, which now also
# spans `NO_IMAGES` (the `disallowedElements` list that replaced `img: () => null`).
#
# THE PLANTED SURVIVOR. Arms 1-3 need exactly one known, equivalent survivor to
# go red on and then suppress. Before the extraction that was the production
# `img: () => null` (null vs undefined: React renders nothing for both). The
# extraction replaced it with `disallowedElements`, so the shipped component has
# no known equivalent mutant left. Every arm therefore plants one line into the
# working copy, just above `MARKDOWN_COMPONENTS` (inside the defence range):
#
#   export const VACUUM_PROOF_PLANT = 'inert'
#
# It yields exactly ONE mutant (StringLiteral `""`). Nothing reads it, so no test
# can kill it; it is exported, so no unused-variable check can trip on it.
#
# Why NOT an image-related plant (finding SO-2b, PR #1302): re-planting
# `img: () => null` adds a SECOND image ban. With it present, emptying
# `NO_IMAGES` (the real defence) is unobservable, so the plant turned two real
# defence mutants (NO_IMAGES `[]` and `""`) into survivors: arm 1 saw 3
# survivors, not 1. A plant must not overlap any defence behaviour. Restored on
# exit like every other edit here.
#
# WHAT THIS SCRIPT SHOWS, in four arms against that defence block:
#
#   1  real tests             → ≥4 killed, 1 survivor (the plant) → gate RED
#                               (AC2: a surviving mutant in changed code fails)
#   2  real tests + suppression WITH a reason         → gate GREEN (AC3)
#   3  real tests + suppression WITHOUT a reason      → gate RED   (AC3)
#   4  VACUUM test            → 0 killed, all survive → gate RED   (AC4)
#
# Arm 4 is the one that matters, and the assertion is deliberately harsh: the
# vacuum test must kill ZERO of the defence mutants. One of them deletes the
# entire `MARKDOWN_COMPONENTS` object, another empties `NO_IMAGES` — the
# render-side defence — and the pre-fix suite stays green through it. If a
# future change makes the vacuum arm kill even one, this script FAILS: either
# the fixture stopped reproducing the original state, the gate's configuration
# drifted, or a NEW test now exercises the defence and must be added to
# NEWER_DEFENCE_TESTS below — all things you want to hear about.
#
# Arm 4 also sets aside NEWER_DEFENCE_TESTS: the suites written AFTER 2026-08-07
# that pin the same defence (PostingMarkdown's own test, the queue card's
# "renders the untrusted description inert"). Stryker runs every test that covers
# a mutant — the whole package for a static one — so leaving them in place would
# measure today's suite, not the 2026-08-07 one. Before the extraction no other
# test reached the dialog's defence, so this reproduces the original arm exactly.
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

COMPONENT="apps/web/app/components/job-sourcing/PostingMarkdown.tsx"
# The vacuum fixture replaces THIS file: it is a copy of the dialog's own test.
TEST_FILE="apps/web/app/components/job-sourcing/__tests__/JobSuggestionDialog.test.tsx"
VACUUM_FIXTURE="apps/web/app/test/fixtures/2026-08-07-JobSuggestionDialog.vacuum.tsx.txt"
# Post-2026-08-07 suites that also pin the defence; set aside in arm 4 only.
NEWER_DEFENCE_TESTS=(
  "apps/web/app/components/job-sourcing/__tests__/PostingMarkdown.test.tsx"
  "apps/web/app/components/job-queue/__tests__/JobQueueCard.test.tsx"
)
REPORT="reports/mutation/-crm-web.report.json"

for f in "$COMPONENT" "$TEST_FILE" "$VACUUM_FIXTURE" "${NEWER_DEFENCE_TESTS[@]}"; do
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
for i in "${!NEWER_DEFENCE_TESTS[@]}"; do cp "${NEWER_DEFENCE_TESTS[$i]}" "$BACKUP/newer-$i"; done
RESTORED=0
# Idempotent: INT/TERM restore and then `exit`, which fires the EXIT trap, so
# restore runs twice; the second call must be a no-op (the backup is gone).
restore() {
  [ "$RESTORED" = 1 ] && return 0
  RESTORED=1
  cp "$BACKUP/component" "$COMPONENT"
  cp "$BACKUP/test" "$TEST_FILE"
  for i in "${!NEWER_DEFENCE_TESTS[@]}"; do cp "$BACKUP/newer-$i" "${NEWER_DEFENCE_TESTS[$i]}"; done
  rm -rf "$BACKUP"
}
# A signal must STOP the script after restoring: otherwise later steps (the
# `rm -f` of NEWER_DEFENCE_TESTS, the vacuum fixture copy) run with no backup.
trap restore EXIT
trap 'restore; exit 130' INT
trap 'restore; exit 143' TERM

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

# Line range of the render-side defence: from `MARKDOWN_URL_TRANSFORM` to the
# closing `}` of `MARKDOWN_COMPONENTS` (so `NO_IMAGES` and the planted constant are
# inside). Anchored on the END symbol, not on the first `^}$`: the transform has
# its own closing brace, and stopping there silently drops the rest of the
# defence. Recomputed each arm because the plant shifts the lines. Prints
# nothing if either symbol is missing; run_gate refuses an empty range.
defence_range() {
  awk '
    /^export const MARKDOWN_URL_TRANSFORM/ && !start { start = NR }
    start && /^const MARKDOWN_COMPONENTS/ { comps = 1 }
    comps && /^}$/ { print start "-" NR; exit }
  ' "$COMPONENT"
}

# $1 = arm name. Runs the gate over the defence block; echoes its exit code.
run_gate() {
  local name="$1" range
  range="$(defence_range)"
  if [ -z "$range" ]; then
    echo "::error::vacuum-proof: cannot find MARKDOWN_URL_TRANSFORM … MARKDOWN_COMPONENTS in $COMPONENT" >&2
    return 2
  fi
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

# Rewrites $COMPONENT from the pristine backup with the planted
# `export const VACUUM_PROOF_PLANT = 'inert'` on the line just above
# `MARKDOWN_COMPONENTS` (see the header), optionally preceded by a
# `// <directive>` comment ($1). python3 rather than sed/perl: it is already a
# hard dependency of every guard in this directory, and its behaviour does not
# differ between the BSD tools on macOS and the GNU tools on the runner.
plant_inert() {
  python3 - "$BACKUP/component" "$COMPONENT" "${1:-}" <<'PY'
import re, sys
src_path, out_path, directive = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(src_path, encoding='utf-8').read()
m = re.search(r'^const MARKDOWN_COMPONENTS: Components = \{\n', src, re.M)
if not m:
    sys.exit("vacuum-proof: could not find `const MARKDOWN_COMPONENTS: Components = {` to plant above")
plant = (f"// {directive}\n" if directive else "") + "export const VACUUM_PROOF_PLANT = 'inert'\n\n"
open(out_path, 'w', encoding='utf-8').write(src[:m.start()] + plant + src[m.start():])
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
plant_inert || exit 2
run_gate "1/4  real tests (as they are on main) + the planted inert survivor"
RC=$?
KILLED_REAL="$(count_status Killed)"
SURVIVED_REAL="$(count_status Survived)"
echo
expect       "arm 1 — gate is RED (a survivor in changed code fails the check)" "$RC" 1
expect_at_least "arm 1 — the real test kills the defence mutants"              "$KILLED_REAL" 4
expect       "arm 1 — exactly one survivor left (the planted inert mutant)"      "$SURVIVED_REAL" 1

# ── ARM 2: suppression WITH a reason ──────────────────────────────────────────
plant_inert 'Stryker disable next-line StringLiteral: the planted constant is read by nothing, so no assertion can observe its value' || exit 2
run_gate "2/4  real test + suppression WITH a reason"
RC=$?
expect "arm 2 — a suppression that states why is accepted" "$RC" 0

# ── ARM 3: suppression WITHOUT a reason ───────────────────────────────────────
plant_inert 'Stryker disable next-line StringLiteral' || exit 2
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
plant_inert || exit 2
cp "$VACUUM_FIXTURE" "$TEST_FILE"
rm -f "${NEWER_DEFENCE_TESTS[@]}"
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
