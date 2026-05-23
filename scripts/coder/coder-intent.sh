#!/bin/bash
# scripts/coder/coder-intent.sh — explicit intent marker для Coder activity log.
#
# BACKGROUND
# ──────────
# Coder runtime watchdog обрезает stream после ~12 мин / ~200k токенов. Auto-hook
# `coder-progress-marker.sh` (PR #42) пишет Edit/Write активность в
# `.claude/coder-activity.log` — это detection layer. Но он показывает только
# ЧТО Coder писал, не ЧТО НАМЕРЕВАЛСЯ делать.
#
# Intent markers — третий слой watchdog-resilience (см. coder.md секция 8.1.1):
# Coder перед длинной операцией явно записывает namерение в тот же activity log.
# Если Coder обрывается посреди операции — PM при recovery видит:
#   - INTENT row: "intent: starting test run for auth module"
#   - последние EDIT rows перед остановом
#
# Это даёт PM семантический контекст без чтения git log + diff на дисках.
#
# USAGE
# ─────
#   bash scripts/coder/coder-intent.sh "starting test run for auth module"
#   bash scripts/coder/coder-intent.sh "AC #3: implementing form validation"
#   bash scripts/coder/coder-intent.sh "rebasing onto main"
#
# LOG FORMAT
# ──────────
# Tab-separated, совместимый с coder-progress-marker.sh:
#   <ISO timestamp>\tINTENT\t<branch>\t<cwd>\tintent: <text>
#
# Поле $2 = "INTENT" — discriminator для PM recovery:
#   awk -F'\t' '$2=="INTENT"' .claude/coder-activity.log
#
# WHERE LOG LIVES
# ───────────────
# `<main-repo>/.claude/coder-activity.log` (shared между worktrees, gitignored,
# rotated на 1 MB). Determined через `git rev-parse --git-common-dir`.
#
# CONSTRAINTS
# ───────────
# - Запускается ТОЛЬКО из subagent worktree (`.claude/worktrees/...`). Из main repo
#   — silent exit 0 (не загрязняет лог).
# - Intent text должен быть non-empty (exit 2 если пусто).
# - Newlines в intent text → заменяются на " | " (TSV integrity).
# - Tabs → заменяются на 4 spaces.
#
# EXIT CODES
# ──────────
#   0 — intent записан (или silently skipped из main repo)
#   2 — empty intent text

set -euo pipefail

INTENT_TEXT="${1:-}"

# Validation
if [ -z "$INTENT_TEXT" ]; then
  echo "[coder-intent] ERROR: intent text required" >&2
  echo "Usage: bash scripts/coder/coder-intent.sh \"<intent description>\"" >&2
  exit 2
fi

# Sanitize: newlines → " | ", tabs → 4 spaces (preserve TSV integrity)
INTENT_TEXT=$(echo "$INTENT_TEXT" | tr '\n' '|' | sed 's/|/ | /g; s/\t/    /g')

# Only fire from subagent worktrees — main repo user activity не отслеживаем
echo "$PWD" | grep -q '/\.claude/worktrees/' || exit 0

# Найти main repo (parent of git common dir) для shared log location
COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null || echo "")
[ -z "$COMMON_DIR" ] && exit 0
MAIN_REPO=$(cd "$COMMON_DIR/.." 2>/dev/null && pwd)
[ -z "$MAIN_REPO" ] && exit 0

LOG_DIR="$MAIN_REPO/.claude"
LOG_FILE="$LOG_DIR/coder-activity.log"
mkdir -p "$LOG_DIR" 2>/dev/null || exit 0

# Rotation: > 1 MB → .log.old (consistent с coder-progress-marker.sh)
if [ -f "$LOG_FILE" ]; then
  SIZE=$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "$SIZE" -gt 1048576 ]; then
    mv -f "$LOG_FILE" "$LOG_FILE.old" 2>/dev/null || true
  fi
fi

BRANCH=$(git branch --show-current 2>/dev/null || echo "<detached>")
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Append одной строкой (POSIX гарантирует атомарность для < PIPE_BUF записей).
# Тип записи в поле $2: INTENT (vs Edit/Write/MultiEdit от auto-hook).
printf '%s\t%s\t%s\t%s\tintent: %s\n' "$TS" "INTENT" "$BRANCH" "$PWD" "$INTENT_TEXT" >> "$LOG_FILE" 2>/dev/null || true

# Echo back to stdout (Coder видит в transcript что intent recorded)
echo "[coder-intent] ✓ recorded: $INTENT_TEXT"

exit 0
