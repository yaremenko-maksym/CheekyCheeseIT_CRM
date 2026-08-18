#!/usr/bin/env bash
# fake-gh.sh — stub `gh` CLI for the devops guard/script tests (originally
# task-guards-that-do-not-guard 2026-08-17; extended
# task-infra-honest-ci-verdicts 2026-08-18 for label-delete + pr-merge).
#
# Three kinds of `gh` call are stubbed here, each driven entirely by ENV
# VARS — never by parsing argv beyond the subcommand name — so this file
# never has to track exactly which flags a caller happens to pass:
#
#   1. `gh pr checks <pr> --repo <repo> --json name,bucket,state`
#      — used by check-required-checks-complete.sh. See FAKE_GH_CHECKS_*
#        below.
#   2. `gh api -X DELETE repos/<repo>/issues/<pr>/labels/<label>`
#      — used by gh-clear-label-if-set.sh. See FAKE_GH_LABEL_DELETE_*
#        below.
#   3. `gh pr merge <pr> --repo <repo> --squash --delete-branch`
#      — used by gh-merge-pr-with-retry.sh. See FAKE_GH_MERGE_* below.
#
#   FAKE_GH_PROTECTION_FILE   path to the JSON body `gh api .../protection`
#                             should print, if that branch is ever exercised.
#   FAKE_GH_PROTECTION_EXIT   its exit code (default 0).
#
#   FAKE_GH_CHECKS_SEQUENCE   ':'-separated list of file paths. Each `gh pr
#                             checks` call advances one step through this
#                             list (a counter lives in FAKE_GH_CALL_COUNTER,
#                             since each invocation is a fresh process); once
#                             the list is exhausted, the LAST path repeats.
#                             This is what lets a test simulate "a required
#                             context is still missing on the first poll,
#                             then appears on the second" without a real
#                             15-second sleep loop — see the polling case in
#                             test-check-required-checks-complete.sh.
#   FAKE_GH_CALL_COUNTER      required alongside FAKE_GH_CHECKS_SEQUENCE — a
#                             fresh path this stub writes its call count into.
#   FAKE_GH_CHECKS_SLEEP_ON_FIRST_CALL   optional — if set, `sleep`s this
#                             long before answering ONLY the FIRST `pr checks`
#                             call (every later call in the same
#                             FAKE_GH_CALL_COUNTER answers immediately),
#                             simulating one `gh` invocation that hangs
#                             (network stall, GitHub API slowness) and then
#                             recovers. Lets a test prove the guard's
#                             per-attempt timeout wrapper (run_with_timeout)
#                             actually cuts the hung call off and retries,
#                             instead of blocking the whole poll loop on it
#                             forever — see the "hung call recovers" case in
#                             test-check-required-checks-complete.sh.
#
#   FAKE_GH_LABEL_DELETE_RC_SEQUENCE   ':'-separated exit codes, one per
#                             `gh api -X DELETE .../labels/<label>` call
#                             (e.g. "1:1:0" = fail, fail, succeed). Exhausted
#                             list repeats its last entry, same rule as
#                             FAKE_GH_CHECKS_SEQUENCE.
#   FAKE_GH_LABEL_DELETE_MSG_SEQUENCE  optional, '|'-separated (NOT ':' —
#                             see DELIM note on _fake_gh_next below) —
#                             the stderr text to print alongside each
#                             non-zero rc (e.g. to spell "HTTP 404" or
#                             "HTTP 503" so gh-clear-label-if-set.sh's
#                             pattern match has something real to match).
#   FAKE_GH_LABEL_CALL_COUNTER   required alongside
#                             FAKE_GH_LABEL_DELETE_RC_SEQUENCE — fresh path,
#                             same role as FAKE_GH_CALL_COUNTER.
#
#   FAKE_GH_MERGE_RC_SEQUENCE  ':'-separated exit codes, one per
#                             `gh pr merge` call. Same repeat-last-entry rule.
#   FAKE_GH_MERGE_MSG_SEQUENCE  optional, '|'-separated (NOT ':' — real
#                             GitHub error strings contain their own colons,
#                             see DELIM note on _fake_gh_next below) text
#                             printed alongside each call (stdout on
#                             success/rc=0, stderr on failure) — this is how
#                             a test spells out the exact GitHub error
#                             strings gh-merge-pr-with-retry.sh
#                             pattern-matches on ("Base branch was modified" /
#                             "the base branch policy prohibits the merge" /
#                             anything else).
#   FAKE_GH_MERGE_CALL_COUNTER  required alongside FAKE_GH_MERGE_RC_SEQUENCE
#                             — fresh path, same role as FAKE_GH_CALL_COUNTER.
#   FAKE_GH_MERGE_SLEEP_ON_FIRST_CALL_SECONDS   optional — sleeps this long
#                             before answering ONLY the FIRST `pr merge`
#                             call (every later call in the same
#                             FAKE_GH_MERGE_CALL_COUNTER answers
#                             immediately), simulating one hung call that
#                             then recovers. Same role as
#                             FAKE_GH_CHECKS_SLEEP_ON_FIRST_CALL above, for
#                             gh-merge-pr-with-retry.sh's own
#                             run_with_timeout wrapper (PR #558 review round
#                             2) instead of check-required-checks-complete.sh's.
#   FAKE_GH_MERGE_SLEEP_SECONDS   optional — sleeps this long before
#                             answering EVERY `pr merge` call (not just the
#                             first). Lets a test simulate a call that hangs
#                             on every attempt, so the caller's retry budget
#                             is exhausted and it gives up — as opposed to
#                             ...SLEEP_ON_FIRST_CALL_SECONDS, which proves
#                             the recovery path instead.
set -u

# Advances a DELIM-separated list by one entry per call, using a counter
# file (a fresh process per invocation cannot keep state any other way).
# Once the list is exhausted, the LAST entry repeats. Shared by the
# label-delete and pr-merge simulations below so each only wires up its own
# env-var names, not its own copy of this arithmetic. (The older `pr checks`
# branch below predates this helper and is left as its own inline copy,
# unmodified on purpose, to avoid touching working, already-tested logic for
# an unrelated change.)
#
# DELIM defaults to ':' (fine for exit codes and file paths, neither of
# which contains a colon) but callers splitting real GitHub error MESSAGES
# pass '|' instead — GraphQL error strings routinely contain their own ':'
# (e.g. "GraphQL: Base branch was modified..."), which a ':'-split would
# silently shred into extra, wrong entries. Plain `tr` (not awk/gawk RS,
# which does not portably support multi-char or exotic separators the same
# way across macOS/Linux) keeps this identical in spirit to the pre-existing
# `pr checks` splitting below, just parameterised.
_fake_gh_next() {
  local seq="$1" counter_file="$2" delim="${3:-:}"
  local n=0
  [ -f "$counter_file" ] && n="$(cat "$counter_file")"
  n=$((n + 1))
  printf '%s' "$n" >"$counter_file"
  _fake_gh_pick "$seq" "$n" "$delim"
}

# Non-incrementing counterpart to _fake_gh_next: reads the Nth entry of a
# DELIM-separated list without touching any counter file itself. Exists
# separately for the `pr merge` branch below, which — unlike label-delete —
# needs to know its own call number BEFORE choosing whether to sleep (a
# simulated hang must be reflected in the counter file BEFORE sleeping, not
# after, so a caller that kills this process mid-sleep does not replay call
# #1 forever; see the `merge)` branch's own comment).
_fake_gh_pick() {
  local seq="$1" n="$2" delim="${3:-:}"
  local total use_n
  # printf '%s\n' (NOT '%s') — a trailing newline is required for `wc -l` to
  # count a sequence with no delimiter in it as ONE line rather than zero.
  total="$(printf '%s\n' "$seq" | tr "$delim" '\n' | wc -l | tr -d ' ')"
  use_n="$n"
  [ "$use_n" -gt "$total" ] && use_n="$total"
  printf '%s\n' "$seq" | tr "$delim" '\n' | sed -n "${use_n}p"
}

case "${1:-}" in
  api)
    if [ "${2:-}" = "-X" ] && [ "${3:-}" = "DELETE" ]; then
      : "${FAKE_GH_LABEL_DELETE_RC_SEQUENCE:?FAKE_GH_LABEL_DELETE_RC_SEQUENCE not set}"
      : "${FAKE_GH_LABEL_CALL_COUNTER:?FAKE_GH_LABEL_CALL_COUNTER not set}"
      rc="$(_fake_gh_next "$FAKE_GH_LABEL_DELETE_RC_SEQUENCE" "$FAKE_GH_LABEL_CALL_COUNTER")"
      msg=""
      if [ -n "${FAKE_GH_LABEL_DELETE_MSG_SEQUENCE:-}" ]; then
        msg="$(_fake_gh_next "$FAKE_GH_LABEL_DELETE_MSG_SEQUENCE" "${FAKE_GH_LABEL_CALL_COUNTER}.msg" '|')"
      fi
      if [ "$rc" -eq 0 ]; then
        exit 0
      fi
      [ -n "$msg" ] && echo "$msg" >&2
      exit "$rc"
    fi
    cat "${FAKE_GH_PROTECTION_FILE:?FAKE_GH_PROTECTION_FILE not set}"
    exit "${FAKE_GH_PROTECTION_EXIT:-0}"
    ;;
  pr)
    case "${2:-}" in
      checks)
        : "${FAKE_GH_CHECKS_SEQUENCE:?FAKE_GH_CHECKS_SEQUENCE not set}"
        : "${FAKE_GH_CALL_COUNTER:?FAKE_GH_CALL_COUNTER not set}"

        n=0
        [ -f "$FAKE_GH_CALL_COUNTER" ] && n="$(cat "$FAKE_GH_CALL_COUNTER")"
        was_first_call=0
        [ "$n" -eq 0 ] && was_first_call=1

        # Record the call BEFORE sleeping, not after: a caller simulating a
        # timeout (review round MED-4's test) KILLS this process mid-sleep,
        # which would otherwise mean the counter file update below never
        # runs and every retry re-reads n=0 forever — an infinite hang
        # disguised as "recovers on retry". Marking the turn used first is
        # what actually lets it recover.
        n=$((n + 1))
        printf '%s' "$n" >"$FAKE_GH_CALL_COUNTER"

        if [ -n "${FAKE_GH_CHECKS_SLEEP_ON_FIRST_CALL:-}" ] && [ "$was_first_call" -eq 1 ]; then
          sleep "$FAKE_GH_CHECKS_SLEEP_ON_FIRST_CALL"
        fi

        total="$(printf '%s\n' "$FAKE_GH_CHECKS_SEQUENCE" | tr ':' '\n' | wc -l | tr -d ' ')"
        use_n="$n"
        [ "$use_n" -gt "$total" ] && use_n="$total"
        chosen="$(printf '%s\n' "$FAKE_GH_CHECKS_SEQUENCE" | tr ':' '\n' | sed -n "${use_n}p")"
        cat "$chosen"
        exit 0
        ;;
      merge)
        : "${FAKE_GH_MERGE_RC_SEQUENCE:?FAKE_GH_MERGE_RC_SEQUENCE not set}"
        : "${FAKE_GH_MERGE_CALL_COUNTER:?FAKE_GH_MERGE_CALL_COUNTER not set}"

        n=0
        [ -f "$FAKE_GH_MERGE_CALL_COUNTER" ] && n="$(cat "$FAKE_GH_MERGE_CALL_COUNTER")"
        was_first_call=0
        [ "$n" -eq 0 ] && was_first_call=1

        # Record the call BEFORE sleeping, not after — same reasoning as the
        # `pr checks` branch above: gh-merge-pr-with-retry.sh's
        # run_with_timeout KILLS this process mid-sleep to simulate a hang,
        # which would otherwise mean the counter file update below never
        # runs and every retry re-reads n=0 forever — an infinite hang
        # disguised as "recovers on retry". Marking the turn used first is
        # what actually lets a subsequent call see n=1 and behave like the
        # SECOND call, not a repeat of the first.
        n=$((n + 1))
        printf '%s' "$n" >"$FAKE_GH_MERGE_CALL_COUNTER"

        if [ -n "${FAKE_GH_MERGE_SLEEP_SECONDS:-}" ]; then
          sleep "$FAKE_GH_MERGE_SLEEP_SECONDS"
        elif [ -n "${FAKE_GH_MERGE_SLEEP_ON_FIRST_CALL_SECONDS:-}" ] && [ "$was_first_call" -eq 1 ]; then
          sleep "$FAKE_GH_MERGE_SLEEP_ON_FIRST_CALL_SECONDS"
        fi

        rc="$(_fake_gh_pick "$FAKE_GH_MERGE_RC_SEQUENCE" "$n")"
        msg=""
        if [ -n "${FAKE_GH_MERGE_MSG_SEQUENCE:-}" ]; then
          msg="$(_fake_gh_pick "$FAKE_GH_MERGE_MSG_SEQUENCE" "$n" '|')"
        fi
        if [ "$rc" -eq 0 ]; then
          [ -n "$msg" ] && echo "$msg"
          exit 0
        fi
        [ -n "$msg" ] && echo "$msg" >&2
        exit "$rc"
        ;;
      *)
        echo "fake-gh: unexpected 'gh pr ${2:-}' invocation" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    echo "fake-gh: unexpected invocation: $*" >&2
    exit 2
    ;;
esac
