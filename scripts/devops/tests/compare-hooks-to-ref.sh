#!/usr/bin/env bash
# compare-hooks-to-ref.sh — run lib/command-corpus.txt through the pre:bash hooks
# from TWO git refs and compare the verdicts pairwise (2026-08-18).
#
# WHY THIS EXISTS. PR #561 narrowed three hooks from "the line contains the word"
# to "the command being run is the word". It was checked twice by picking
# interesting-looking commands; the first pass missed `eval 'rm -rf /etc'` and
# the second missed thirteen more. The security reviewer found them in one go by
# doing something structurally different: deploy both versions, run ONE corpus
# through both, compare exit codes line by line. Any pair "older refused, newer
# permits" is a regression, no matter how exotic the form looks.
#
# So this is that method, kept. test-hook-command-corpus.sh is the permanent
# gate (it pins the verdicts that matter); this script is what you run WHILE
# editing the parser, against whatever baseline you are trying not to weaken:
#
#     scripts/devops/tests/compare-hooks-to-ref.sh              # vs origin/main
#     scripts/devops/tests/compare-hooks-to-ref.sh HEAD~1
#     scripts/devops/tests/compare-hooks-to-ref.sh v-before-refactor
#
# Every corpus line is run through ALL THREE hooks, not only the ones its row
# names: a regression in a hook the line was not written for is still a
# regression, and one of the thirteen was found exactly that way.
#
# Exit code: 0 = no regressions, 1 = at least one "ref blocked, working tree
# does not". Improvements (the reverse direction) are reported, never fatal.
set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/../../.." && pwd)"
CORPUS="$SELF_DIR/lib/command-corpus.txt"
REF="${1:-origin/main}"

HOOK_FILES="pre-bash-safety.sh pre-bash-live-db-guard.sh pre-bash-devserver-ttl-gate.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hookdiff-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# ── materialise the ref's hooks ───────────────────────────────────────────────
# A ref older than the shared analyzer simply has no lib/cmdscan.py; its hooks
# were self-contained, so the absence is correct and not an error.
mkdir -p "$WORK/ref/lib"
for f in $HOOK_FILES; do
  if ! git -C "$REPO_ROOT" show "$REF:.claude/hooks/$f" >"$WORK/ref/$f" 2>/dev/null; then
    echo "ERROR: $REF has no .claude/hooks/$f" >&2
    exit 2
  fi
done
git -C "$REPO_ROOT" show "$REF:.claude/hooks/lib/cmdscan.py" >"$WORK/ref/lib/cmdscan.py" 2>/dev/null ||
  rm -f "$WORK/ref/lib/cmdscan.py"

# A cwd that reads as an agent worktree: the two launcher hooks only enforce
# there, so comparing outside it would compare two fast-exits.
CWD="$REPO_ROOT/.claude/worktrees/agent-hookdiff"

verdict() { # $1 = tree, $2 = hook file, $3 = command  -> prints exit code
  CMD="$3" CWD="$CWD" python3 -c '
import json, os, sys
sys.stdout.write(json.dumps({
    "session_id": "hookdiff", "tool_name": "Bash", "cwd": os.environ["CWD"],
    "tool_input": {"command": os.environ["CMD"]},
}))
' | bash "$1/$2" >/dev/null 2>&1
  printf '%s' "$?"
}

echo "== compare-hooks-to-ref.sh: $REF  ->  working tree =="
echo "   corpus: $(basename "$CORPUS")"
echo

TOTAL=0
REGRESSIONS=0
IMPROVEMENTS=0
REG_LIST=""

while IFS=$'\t' read -r expect hooks cmd <&3; do
  case "${expect:-}" in
    "" | \#*) continue ;;
  esac
  [ -n "${cmd:-}" ] || continue
  for f in $HOOK_FILES; do
    TOTAL=$((TOTAL + 1))
    rc_ref="$(verdict "$WORK/ref" "$f" "$cmd")"
    rc_new="$(verdict "$REPO_ROOT/.claude/hooks" "$f" "$cmd")"
    if [ "$rc_ref" = "2" ] && [ "$rc_new" != "2" ]; then
      REGRESSIONS=$((REGRESSIONS + 1))
      REG_LIST="${REG_LIST}  [${f%.sh}] $cmd
"
      printf 'REGRESSION  %-34s ref=%s now=%s  %s\n' "${f%.sh}" "$rc_ref" "$rc_new" "$cmd"
    elif [ "$rc_ref" != "2" ] && [ "$rc_new" = "2" ]; then
      IMPROVEMENTS=$((IMPROVEMENTS + 1))
    fi
  done
done 3<"$CORPUS"

echo
echo "== $TOTAL pairs, $REGRESSIONS regressions, $IMPROVEMENTS newly blocked =="
if [ "$REGRESSIONS" -gt 0 ]; then
  echo
  echo "These were REFUSED by $REF and are PERMITTED now:"
  printf '%s' "$REG_LIST"
  echo
  echo "Each one is either a bug or a narrowing you can defend in writing."
  echo "If it is a narrowing, add the line to lib/command-corpus.txt so the claim"
  echo "is recorded and re-checked on every run. Which label to use is decided by"
  echo "the CURRENT degraded fallback, not by this comparison — run the corpus"
  echo "test and let it tell you: \`allow\` if the fallback has no objection,"
  echo "\`narrowed\` if it refuses. The two baselines are different on purpose."
  exit 1
fi
echo "No form that $REF refused is permitted now."
exit 0
