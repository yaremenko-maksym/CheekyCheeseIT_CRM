#!/usr/bin/env bash
# test-check-stream-silence.sh — proves scripts/devops/check-stream-silence.sh
# finds the silence that the watchdog kills on, and stays quiet on a ledger
# whose agents kept talking.
#
# WHAT THE RED IS WORTH: on 2026-10-20 five agents were cut in one day and
# nothing in the repository recorded one of them. The checker's whole claim is
# that a gap is now a number somebody can be shown; a test that only proved it
# prints "OK" on a healthy ledger would leave that claim unexamined, which is
# the disease scripts/devops/check-guard-tests-exist.sh exists to treat.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

CHECK="$GUARD_DIR/check-stream-silence.sh"
HOOK="$REPO_ROOT/.claude/hooks/post-any-heartbeat.sh"

echo "== test-check-stream-silence.sh =="
echo

for f in "$CHECK" "$HOOK"; do
  if ! bash -n "$f" 2>/dev/null; then
    echo "FATAL: syntax error in $f"
    bash -n "$f"
    exit 1
  fi
done

TMP=$(mktemp -d "${TMPDIR:-/tmp}/stream-silence-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

WS=/Users/x/repo/.claude/worktrees/agent-cut
WS2=/Users/x/repo/.claude/worktrees/agent-chatty

# A ledger with a 700 s hole in the middle of one agent's run: exactly the
# shape of 2026-10-20 agent #1, two foreground suites with nothing written
# between them.
hb() { printf '%s\t%s\t%s\t%s\n' "$1" "1970-01-01T00:00:00Z" "$2" "$3" >>"$4"; }

GAPPY="$TMP/gappy.log"
hb 1000 Bash "$WS" "$GAPPY"
hb 1010 Read "$WS" "$GAPPY"
hb 1710 Bash "$WS" "$GAPPY" # 700 s of silence
hb 1720 Write "$WS" "$GAPPY"

TIGHT="$TMP/tight.log"
hb 1000 Bash "$WS2" "$TIGHT"
hb 1100 Read "$WS2" "$TIGHT"
hb 1250 Bash "$WS2" "$TIGHT"
hb 1300 Write "$WS2" "$TIGHT"

# Two agents interleaved: agent-chatty's lines fall inside agent-cut's hole, so
# a checker that did not group by workspace would miss the gap entirely.
MIXED="$TMP/mixed.log"
hb 1000 Bash "$WS" "$MIXED"
hb 1100 Bash "$WS2" "$MIXED"
hb 1300 Read "$WS2" "$MIXED"
hb 1600 Bash "$WS2" "$MIXED"
hb 1710 Write "$WS" "$MIXED" # agent-cut: 710 s silent

# ── the reds ──────────────────────────────────────────────────────────────────

assert_red "a 700 s hole between two heartbeats of one workspace -> reported, with the number" \
  --contains "SURVIVED" \
  --contains "700" \
  --contains "agent-cut" \
  -- bash "$CHECK" --log "$GAPPY" --now 1720

assert_red "a ledger that just stops -> TRAILING (cut, or silent right now)" \
  --contains "TRAILING" \
  -- bash "$CHECK" --log "$TIGHT" --now 2000

assert_red "gaps are per workspace: another agent's chatter inside the hole hides nothing" \
  --contains "SURVIVED" \
  --contains "710" \
  --contains "agent-cut" \
  -- bash "$CHECK" --log "$MIXED" --now 1710

assert_red "a tight ledger goes red once the threshold is dropped below its gaps" \
  --contains "SURVIVED" \
  -- bash "$CHECK" --log "$TIGHT" --threshold 100 --now 1300

assert_red "an unreadable ledger is an error, not a clean bill of health" \
  --contains "no heartbeat ledger" \
  -- bash "$CHECK" --log "$TMP/absent.log"

# ── the greens ────────────────────────────────────────────────────────────────

assert_green "every gap under the threshold -> OK" \
  --contains "no agent workspace went quiet" \
  --not-contains "SURVIVED" \
  -- bash "$CHECK" --log "$TIGHT" --threshold 480 --now 1300

assert_green "an empty ledger has no silence to report" \
  -- bash -c ': > "$1"/empty.log; bash "$0" --log "$1"/empty.log --now 1' "$CHECK" "$TMP"

# ── the hook that feeds it ────────────────────────────────────────────────────

assert_green "the heartbeat hook never refuses, whatever it is fed" \
  -- bash -c 'printf "not json at all" | bash "$0"' "$HOOK"

assert_green "a tool call outside an agent worktree writes nothing" \
  --not-contains "Bash" \
  -- bash -c '
     log="$1/outside.log"
     cd "$1" && printf "{\"tool_name\":\"Bash\"}" | HEARTBEAT_LOG="$log" bash "$0"
     cat "$log" 2>/dev/null; exit 0' "$HOOK" "$TMP"

assert_green "a tool call inside an agent worktree appends epoch, ISO, tool and workspace" \
  --contains "Bash" \
  --contains ".claude/worktrees/agent-probe" \
  -- bash -c '
     ws="$1/.claude/worktrees/agent-probe"; log="$1/probe.log"
     mkdir -p "$ws"
     cd "$ws" && printf "{\"tool_name\":\"Bash\"}" | HEARTBEAT_LOG="$log" bash "$0"
     cat "$log"' "$HOOK" "$TMP"

guard_test_summary "test-check-stream-silence.sh"
