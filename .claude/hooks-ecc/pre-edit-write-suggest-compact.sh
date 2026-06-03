#!/usr/bin/env bash
# ECC stable id: pre:edit-write:suggest-compact
# Phase 2.5 — Option A bash port of ECC default
# `pre:edit-write:suggest-compact` (see hooks/hooks.json). Per User explicit
# request: adopt ECC convention name + matcher (`Edit|Write`).
#
# Why Option A (bash) instead of Option B (ECC's node bootstrap):
#   The upstream ECC hook is `node scripts/hooks/run-with-flags.js ...
#   suggest-compact.js` requiring CLAUDE_PLUGIN_ROOT and the ECC scripts/
#   tree shipped via plugin install. This project is not yet ECC-plugin-
#   installed (still standalone) so we replicate the spirit of the hook in
#   ~30 LoC bash: count tool invocations, surface a /compact suggestion
#   every N uses via stderr. Never blocks.
#
# Contract:
#   - PreToolUse Edit|Write hook.
#   - exit 0 always (suggestion-only; never blocks).
#   - Writes counter to <main-repo>/.claude/suggest-compact.counter (gitignored).
#   - At every COMPACT_INTERVAL invocations, emits a single stderr suggestion
#     hinting the user to consider running /compact.
#
# Tuning: COMPACT_INTERVAL=50 — matches ECC default suggestion cadence (see
# ECC scripts/hooks/suggest-compact.js source — every ~50 tool uses signal).
#
# Storage: counter file in main repo .claude/ shared across worktrees, so
# many edits in subagents still trigger the suggestion correctly.

set -u

COMPACT_INTERVAL=${COMPACT_INTERVAL:-50}

# Resolve counter location — main repo .claude/ preferred (shared across
# worktrees), else fall back to ~/.claude/ for non-git cwd cases.
COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null)
if [ -n "$COMMON_DIR" ]; then
  MAIN_REPO=$(cd "$COMMON_DIR/.." 2>/dev/null && pwd)
fi

if [ -n "${MAIN_REPO:-}" ] && [ -d "$MAIN_REPO/.claude" ]; then
  COUNTER_FILE="$MAIN_REPO/.claude/suggest-compact.counter"
else
  COUNTER_FILE="${HOME}/.claude/suggest-compact.counter"
  mkdir -p "${HOME}/.claude" 2>/dev/null || exit 0
fi

# Read current count (default 0); add 1; persist atomically.
CURRENT=0
if [ -f "$COUNTER_FILE" ]; then
  CURRENT=$(cat "$COUNTER_FILE" 2>/dev/null | tr -d '[:space:]')
  case "$CURRENT" in
    ''|*[!0-9]*) CURRENT=0 ;;
  esac
fi
NEXT=$((CURRENT + 1))

# Atomic-ish write via tmp+mv (best-effort on shared FS).
TMP_FILE="${COUNTER_FILE}.tmp.$$"
printf '%s' "$NEXT" > "$TMP_FILE" 2>/dev/null && mv -f "$TMP_FILE" "$COUNTER_FILE" 2>/dev/null

# Suggestion cadence — only at exact multiples to avoid spam.
if [ "$((NEXT % COMPACT_INTERVAL))" -eq 0 ]; then
  echo "[pre:edit-write:suggest-compact] ${NEXT} edit/write invocations recorded. Consider running /compact to free context window." >&2
fi

exit 0
