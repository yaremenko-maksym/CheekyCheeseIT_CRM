#!/usr/bin/env bash
# test-hook-command-corpus.sh — the three pre:bash hooks against one corpus of
# command-line forms, in both directions (2026-08-18, security review of PR #561).
#
# WHY A CORPUS INSTEAD OF MORE EXAMPLES. The narrowing in PR #561 was checked
# twice by picking interesting-looking commands. The first pass missed
# `eval 'rm -rf /etc'`; the second missed thirteen more, including `env -i`,
# `sudo -s`, `{ … ; }` and `if …; then …; fi` — forms an agent writes without
# any intent to evade. Hand-picked examples cannot cover a parser: what is
# needed is a corpus, run in both directions, every time the parser is touched.
#
# WHAT EACH LINE ASSERTS (see lib/command-corpus.txt for the format):
#   block     the hook refuses AND emits the decision contract. Exit code alone
#             proves nothing here — a hook that dies on a syntax error also
#             exits 2, which is the trap this whole family of guards fell into.
#   allow     the hook permits it, and so did the old coarse substring rule.
#   narrowed  the hook permits it although the coarse rule REFUSED it. Both
#             halves are asserted, which is what makes the annotation honest:
#             a `narrowed` line that the coarse rule stops refusing fails here
#             and has to be re-labelled `allow`.
#
# THE METRIC THIS LOCKS DOWN. The review's sharpest observation was that
# `sudo -s rm -rf /etc` was blocked when the analyzer was BROKEN and allowed when
# it worked — the broken guard was stricter than the working one. Running every
# line through the degraded fallback as well means that can only ever be true of
# a form somebody deliberately wrote down as `narrowed`.
#
# WHY THAT METRIC WAS GREEN AND STILL MISSED A HOLE (third review round). It was
# computed only where a corpus row named the hook, over a corpus that contained
# no example of the class that leaked: `UNDERSTOOD` claimed to list commands
# that do not execute their argument, and held `tar`, `rsync`, `ssh`, `nc`,
# `psql`, `git`, which all do. Zero matching lines meant zero measurements —
# the number was true about the corpus and silent about the code. A green check
# that cannot reach the defect is the third of its kind in this PR, so the
# widening is structural rather than a few more lines:
#
#   * the corpus gained the class (see the third-round section of the file), and
#   * the sweep at the bottom runs EVERY line through ALL THREE hooks under BOTH
#     baselines, and requires every "degraded refuses, analyzer permits" pair to
#     be a line explicitly labelled `narrowed` for that hook.
#
# So the metric no longer depends on anyone having written the row for the right
# hook, and a future line of an unforeseen class is measured the moment it lands.
#
# Nothing here executes any corpus command: each is handed to a hook as the text
# of a tool call, which is exactly the input the hook sees in production.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"
. "$SELF_DIR/lib/hook-harness.sh"

CORPUS="$SELF_DIR/lib/command-corpus.txt"

# ── running this file is optional; SAYING SO is not ──────────────────────────
# This is the expensive test in the suite: every line is handed to three hooks
# under two baselines, which is one python3 start per verdict — minutes on a
# loaded machine, against ~12 seconds for the other three hook tests. A PR that
# does not touch the hooks or the corpus cannot change any of those verdicts, so
# the caller may set GUARD_TEST_HOOKS_TOUCHED=0 to skip it.
#
# The default is 1. A gate that decides on its own to be cheap is a gate that
# quietly stops existing, so the skip has to be ASKED for, and it announces
# itself in the same breath: the banner below names what was NOT checked, in the
# same output stream a reader is already looking at. The failure mode being
# guarded against is not a slow CI run — it is a green tick that means less than
# the reader thinks it does, which is the third time that has come up in this PR.
if [ "${GUARD_TEST_HOOKS_TOUCHED:-1}" = "0" ]; then
  CORPUS_LINES="$(awk 'NF && $0 !~ /^[[:space:]]*#/' "$CORPUS" | wc -l | tr -d ' ')"
  echo "== test-hook-command-corpus.sh: SWEEP ПРОПУЩЕН =="
  echo "   причина:      GUARD_TEST_HOOKS_TOUCHED=0 — .claude/hooks/** и корпус"
  echo "                 в этом PR не менялись, значит ни один вердикт не мог измениться"
  echo "   НЕ проверено: $CORPUS_LINES строк корпуса через три хука в двух базисах"
  echo "                 и метрика «деградированный режим строже рабочего»"
  echo "   прогнать:     GUARD_TEST_HOOKS_TOUCHED=1 scripts/devops/tests/test-hook-command-corpus.sh"
  echo
  exit 0
fi

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

hook_file() {
  case "$1" in
    safety) printf '%s' "pre-bash-safety.sh" ;;
    db) printf '%s' "pre-bash-live-db-guard.sh" ;;
    ttl) printf '%s' "pre-bash-devserver-ttl-gate.sh" ;;
    *)
      echo "unknown hook key: $1" >&2
      exit 2
      ;;
  esac
}

# The degraded twin of each hook: same file, deliberately broken lib/cmdscan.py
# next to it, so the fallback path (the old coarse substring rule) is what runs.
broken_hook() {
  local key="$1" file
  file="$(hook_file "$key")"
  local path="$WS/broken/$file"
  [ -f "$path" ] || hook_with_broken_lib "$WS" "$file" >/dev/null
  printf '%s' "$path"
}

echo "== test-hook-command-corpus.sh =="
echo

LINE_NO=0
while IFS=$'\t' read -r expect hooks cmd <&3; do
  LINE_NO=$((LINE_NO + 1))
  case "${expect:-}" in
    "" | \#*) continue ;;
  esac
  if [ -z "${hooks:-}" ] || [ -z "${cmd:-}" ]; then
    echo "corpus line $LINE_NO is malformed (needs three tab-separated fields)" >&2
    exit 2
  fi
  [ "$hooks" = "all" ] && hooks="safety,db,ttl"

  for key in $(printf '%s' "$hooks" | tr ',' ' '); do
    hook="$REPO_ROOT/.claude/hooks/$(hook_file "$key")"
    case "$expect" in
      block)
        # `--not-contains INTERNAL ERROR` matters more than it looks: without it
        # this whole file would still pass with lib/cmdscan.py deleted, because
        # the degraded fallback catches most of the corpus. The assertion is
        # "the ANALYZER refused", not "something refused".
        assert_red "[$key] BLOCK: $cmd" \
          --contains '"decision"' \
          --not-contains "INTERNAL ERROR" \
          -- hook_at "$hook" "$cmd"
        ;;
      allow)
        assert_green "[$key] ALLOW: $cmd" \
          -- hook_at "$hook" "$cmd"
        # Exit code is not the question here: with a dead analyzer a hook may
        # answer 0 (fast-exit before it) or 1 (analyzer dead, fallback matched
        # nothing), and both mean the same thing. The decision contract is what
        # says whether it REFUSED — so that, and only that, is asserted.
        assert_contract "[$key] грубое правило тоже не возражало: $cmd" \
          --not-contains '"decision"' \
          -- hook_at "$(broken_hook "$key")" "$cmd"
        ;;
      narrowed)
        assert_green "[$key] ALLOW (заявленное сужение): $cmd" \
          -- hook_at "$hook" "$cmd"
        assert_red "[$key] грубое правило это ЗАПРЕЩАЛО — сужение реально: $cmd" \
          --contains "ДЕГРАДИРОВАННЫЙ РЕЖИМ" \
          -- hook_at "$(broken_hook "$key")" "$cmd"
        ;;
      *)
        echo "corpus line $LINE_NO: unknown expectation '$expect'" >&2
        exit 2
        ;;
    esac
  done
done 3<"$CORPUS"

# ── the metric, swept over the whole corpus ──────────────────────────────────
# For every line and EVERY hook — not just the hooks the row happens to name —
# ask the two questions that define the property: does the analyzer permit this,
# and would the coarse fallback have refused it? A yes/yes pair is a narrowing,
# and a narrowing that nobody wrote down is the shape the last three findings
# arrived in. Cost: the degraded run only happens where the analyzer permitted,
# so the sweep adds roughly twenty seconds, not a second run of the whole file.
ALL_HOOKS="safety db ttl"
DECLARED="$WS/declared-narrowings.txt"
: >"$DECLARED"
while IFS=$'\t' read -r expect hooks cmd <&3; do
  case "${expect:-}" in
    "" | \#*) continue ;;
  esac
  [ "$expect" = "narrowed" ] || continue
  [ "$hooks" = "all" ] && hooks="safety,db,ttl"
  for key in $(printf '%s' "$hooks" | tr ',' ' '); do
    printf '%s\t%s\n' "$key" "$cmd" >>"$DECLARED"
  done
done 3<"$CORPUS"

verdict_rc() { # $1 = hook path, $2 = command  -> prints the exit code
  hook_at "$1" "$2" >/dev/null 2>&1
  printf '%s' "$?"
}

METRIC_PAIRS=0
METRIC_STRICTER=0
METRIC_UNDECLARED=0
METRIC_LIST=""
while IFS=$'\t' read -r expect hooks cmd <&3; do
  case "${expect:-}" in
    "" | \#*) continue ;;
  esac
  [ -n "${cmd:-}" ] || continue
  for key in $ALL_HOOKS; do
    METRIC_PAIRS=$((METRIC_PAIRS + 1))
    file="$(hook_file "$key")"
    [ "$(verdict_rc "$REPO_ROOT/.claude/hooks/$file" "$cmd")" = "2" ] && continue
    [ "$(verdict_rc "$(broken_hook "$key")" "$cmd")" = "2" ] || continue
    METRIC_STRICTER=$((METRIC_STRICTER + 1))
    if ! printf '%s\t%s\n' "$key" "$cmd" | grep -Fxqf - "$DECLARED"; then
      METRIC_UNDECLARED=$((METRIC_UNDECLARED + 1))
      METRIC_LIST="${METRIC_LIST}  [$key] $cmd
"
    fi
  done
done 3<"$CORPUS"

metric_verdict() {
  [ "$METRIC_UNDECLARED" -eq 0 ] && return 0
  echo "деградированный режим строже рабочего на формах, которые никто не заявлял:"
  printf '%s' "$METRIC_LIST"
  echo "Каждая — либо регресс, либо сужение: пометь строку как \`narrowed\` для этого хука."
  return 1
}

echo
echo "-- метрика: деградированный строже рабочего в $METRIC_STRICTER из $METRIC_PAIRS пар"
assert_green "метрика: все $METRIC_STRICTER строгих пар заявлены как narrowed" \
  -- metric_verdict

guard_test_summary "test-hook-command-corpus.sh"
