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
# Nothing here executes any corpus command: each is handed to a hook as the text
# of a tool call, which is exactly the input the hook sees in production.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"
. "$SELF_DIR/lib/hook-harness.sh"

CORPUS="$SELF_DIR/lib/command-corpus.txt"

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

guard_test_summary "test-hook-command-corpus.sh"
