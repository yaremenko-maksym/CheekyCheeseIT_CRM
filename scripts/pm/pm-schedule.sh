#!/bin/bash
# scripts/pm/pm-schedule.sh — helper для cross-session wake-up через MCP scheduled-tasks.
#
# BACKGROUND
# ──────────
# `ScheduleWakeup` (harness API) не переживает session boundary — это D1 [P0] из
# dev-flow RCA 2026-05-23. Если PM-сессия завершилась до fire'а, wake-up теряется,
# PR висит без действия.
#
# WORKAROUND
# ──────────
# Для cross-session waits (E2E на GHA > 5 мин, deploy verification, daily checks)
# PM использует `mcp__scheduled-tasks__create_scheduled_task` — это external scheduler
# который выживает session boundary. Каждый run стартует fresh Claude-сессию с
# self-contained prompt.
#
# Этот bash-скрипт — pre-processor перед MCP-вызовом:
#   1. Вычисляет fireAt в LOCAL TZ (BSD date на macOS / GNU date на Linux)
#   2. Генерит unique kebab-case taskId с timestamp suffix
#   3. Материализует prompt из template (substitution `{{KEY}}` → value)
#   4. Опционально — append event 'wakeup_scheduled' + `next_action` в pm-state.json
#
# OUTPUT
# ──────
# JSON в stdout:
#   {
#     "taskId":       "<hint>-<utc-ts>",
#     "fireAt":       "<ISO-with-local-offset>",
#     "description":  "...",
#     "promptPath":   "/tmp/pm-schedule-<ts>.prompt.md",
#     "promptSize":   <bytes>
#   }
#
# PM-агент:
#   1. Запускает этот скрипт
#   2. Читает stdout как JSON
#   3. Читает prompt: `cat $(jq -r .promptPath <json>)`
#   4. Вызывает `mcp__scheduled-tasks__create_scheduled_task({taskId, prompt, description, fireAt})`
#
# USAGE
# ─────
#   bash scripts/pm/pm-schedule.sh \
#     --delay-min 15 \
#     --task-id-hint poll-e2e-pr42 \
#     --description "Poll E2E run for PR #42" \
#     --prompt-template poll-e2e-run \
#     --prompt-var PR=42 \
#     --prompt-var RUN_ID=26298999300 \
#     --prompt-var REPO=yaremenko-maksym/CheekyCheeseIT_CRM \
#     --state-file docs/specs/pm-state.json \
#     --state-task-id task-knowledge-api
#
# FLAGS
# ─────
#   --delay-min N         (req)  Minutes from now, 1..720 (12h cap to avoid runaway).
#   --task-id-hint slug   (req)  Kebab-case hint (sanitized + ts suffix → unique taskId).
#   --description text    (req)  One-line description shown in sidebar.
#   --prompt-template id  (req)  Name (no .md) under scripts/pm/wakeup-prompts/.
#   --prompt-var KEY=val  (opt)  Repeatable. Substitutes `{{KEY}}` in template.
#   --state-file path     (opt)  pm-state.json path. If set → --state-task-id required.
#   --state-task-id id    (opt)  Active task id to attach event + next_action.
#   --max-age-min N       (opt)  next_action.max_age_min (default 30). When new session
#                                checks state, if `scheduled_at` older than this →
#                                missed wake-up → immediate execute.
#   --dry-run             (opt)  Print JSON to stdout but do NOT mutate state file.
#   --help                       Show this usage.
#
# EXIT CODES
# ──────────
#   0 — success, JSON in stdout
#   2 — usage error (missing/invalid args)
#   3 — template not found
#   4 — state file not found or invalid JSON
#   5 — jq/python3 not available
set -euo pipefail

# ─── helpers ──────────────────────────────────────────────────────────────────

_die() {
  echo "[pm-schedule] ERROR: $*" >&2
  exit "${2:-2}"
}

_usage() {
  sed -n '2,/^set -euo/p' "$0" | sed -E 's/^#( |$)//; /^set -euo/d'
  exit 0
}

# Future ISO-8601 timestamp with local TZ offset (e.g., 2026-05-23T22:30:00+03:00).
# BSD date (macOS): -v+NM. GNU date (Linux): -d "+N minutes".
_future_iso() {
  local delay_min="$1"
  local raw
  if date -v+1M +%s >/dev/null 2>&1; then
    raw=$(date -v+"${delay_min}"M "+%Y-%m-%dT%H:%M:%S%z")
  else
    raw=$(date -d "+${delay_min} minutes" "+%Y-%m-%dT%H:%M:%S%z")
  fi
  # Insert colon in offset: +0300 → +03:00 (canonical ISO 8601)
  echo "$raw" | sed -E 's/([+-][0-9]{2})([0-9]{2})$/\1:\2/'
}

# UTC compact timestamp for taskId uniqueness suffix.
_utc_compact() {
  date -u "+%Y%m%dt%H%M%Sz"
}

# Sanitize string → kebab-case [a-z0-9-]+ (collapse repeats, trim ends).
_kebab() {
  echo "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -c 'a-z0-9-' '-' \
    | sed -E 's/-+/-/g; s/^-//; s/-$//'
}

# ─── tool dependency check ────────────────────────────────────────────────────

command -v jq >/dev/null || _die "jq not installed (required for state file updates)" 5
command -v python3 >/dev/null || _die "python3 not installed (required for template substitution)" 5

# ─── arg parsing ──────────────────────────────────────────────────────────────

DELAY_MIN=""
HINT=""
DESCRIPTION=""
TEMPLATE_NAME=""
declare -a PROMPT_VARS=()
STATE_FILE=""
STATE_TASK_ID=""
MAX_AGE_MIN="30"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --delay-min)        DELAY_MIN="${2:?--delay-min requires value}"; shift 2 ;;
    --task-id-hint)     HINT="${2:?--task-id-hint requires value}"; shift 2 ;;
    --description)      DESCRIPTION="${2:?--description requires value}"; shift 2 ;;
    --prompt-template)  TEMPLATE_NAME="${2:?--prompt-template requires value}"; shift 2 ;;
    --prompt-var)       PROMPT_VARS+=("${2:?--prompt-var requires KEY=val}"); shift 2 ;;
    --state-file)       STATE_FILE="${2:?--state-file requires path}"; shift 2 ;;
    --state-task-id)    STATE_TASK_ID="${2:?--state-task-id requires value}"; shift 2 ;;
    --max-age-min)      MAX_AGE_MIN="${2:?--max-age-min requires value}"; shift 2 ;;
    --dry-run)          DRY_RUN=1; shift ;;
    --help|-h)          _usage ;;
    *)                  _die "Unknown flag: $1 (use --help)" ;;
  esac
done

# ─── validation ───────────────────────────────────────────────────────────────

[ -n "$DELAY_MIN" ] || _die "--delay-min required"
[ -n "$HINT" ] || _die "--task-id-hint required"
[ -n "$DESCRIPTION" ] || _die "--description required"
[ -n "$TEMPLATE_NAME" ] || _die "--prompt-template required"

[[ "$DELAY_MIN" =~ ^[0-9]+$ ]] || _die "--delay-min must be positive integer, got '$DELAY_MIN'"
[ "$DELAY_MIN" -ge 1 ] || _die "--delay-min must be ≥ 1 (got $DELAY_MIN)"
[ "$DELAY_MIN" -le 720 ] || _die "--delay-min must be ≤ 720 (12 hours cap, got $DELAY_MIN)"

[[ "$MAX_AGE_MIN" =~ ^[0-9]+$ ]] || _die "--max-age-min must be positive integer"

if [ -n "$STATE_FILE" ]; then
  [ -f "$STATE_FILE" ] || _die "--state-file not found: $STATE_FILE" 4
  jq empty "$STATE_FILE" 2>/dev/null || _die "--state-file is not valid JSON: $STATE_FILE" 4
  [ -n "$STATE_TASK_ID" ] || _die "--state-task-id required when --state-file given"
fi

# ─── locate template ─────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE_PATH="$SCRIPT_DIR/wakeup-prompts/${TEMPLATE_NAME}.md"
[ -f "$TEMPLATE_PATH" ] || _die "Template not found: $TEMPLATE_PATH" 3

# ─── compute taskId and fireAt ────────────────────────────────────────────────

HINT_SAFE=$(_kebab "$HINT")
[ -n "$HINT_SAFE" ] || _die "--task-id-hint sanitized to empty (use [a-z0-9-]+)"

TS_COMPACT=$(_utc_compact)
TASK_ID="${HINT_SAFE}-${TS_COMPACT}"
FIRE_AT=$(_future_iso "$DELAY_MIN")
SCHEDULED_AT=$(date -u "+%Y-%m-%dT%H:%M:%SZ")

# ─── materialize prompt ───────────────────────────────────────────────────────

# Build JSON dict of substitution vars, then call Python to do replace.
# Python over sed because values can contain `/`, `&`, `\n`, special chars.
VARS_JSON=$(printf '%s\n' "${PROMPT_VARS[@]:-}" \
  | python3 -c "
import sys, json
out = {}
for line in sys.stdin:
    line = line.rstrip('\n')
    if not line:
        continue
    if '=' not in line:
        raise SystemExit(f'--prompt-var must be KEY=val, got: {line!r}')
    k, v = line.split('=', 1)
    out[k] = v
print(json.dumps(out))
")

PROMPT_TMPFILE="/tmp/pm-schedule-${TASK_ID}.prompt.md"

python3 -c "
import sys, json
template_path = sys.argv[1]
vars_dict = json.loads(sys.argv[2])
out_path = sys.argv[3]
with open(template_path, 'r', encoding='utf-8') as f:
    template = f.read()
# Always-available built-ins:
vars_dict.setdefault('TASK_ID', sys.argv[4])
vars_dict.setdefault('FIRE_AT', sys.argv[5])
vars_dict.setdefault('SCHEDULED_AT', sys.argv[6])
for k, v in vars_dict.items():
    template = template.replace('{{' + k + '}}', str(v))
# Detect unsubstituted {{VAR}} → warn (does NOT fail — some templates have literal braces)
import re
remaining = re.findall(r'\{\{([A-Z_][A-Z0-9_]*)\}\}', template)
if remaining:
    print('[pm-schedule] WARN: unsubstituted vars in template: ' + ','.join(sorted(set(remaining))), file=sys.stderr)
with open(out_path, 'w', encoding='utf-8') as f:
    f.write(template)
" "$TEMPLATE_PATH" "$VARS_JSON" "$PROMPT_TMPFILE" "$TASK_ID" "$FIRE_AT" "$SCHEDULED_AT"

PROMPT_SIZE=$(wc -c < "$PROMPT_TMPFILE" | tr -d ' ')

# ─── optional: append event to pm-state.json ─────────────────────────────────

if [ -n "$STATE_FILE" ] && [ "$DRY_RUN" -eq 0 ]; then
  # Verify task_id exists in active[]
  EXISTS=$(jq --arg id "$STATE_TASK_ID" '[.active[]? | select(.id == $id)] | length' "$STATE_FILE")
  if [ "$EXISTS" -eq 0 ]; then
    _die "--state-task-id '$STATE_TASK_ID' not found in $STATE_FILE active[]" 4
  fi

  TMP_STATE=$(mktemp)
  jq \
    --arg id "$STATE_TASK_ID" \
    --arg at "$SCHEDULED_AT" \
    --arg sched_task_id "$TASK_ID" \
    --arg fire_at "$FIRE_AT" \
    --arg template "$TEMPLATE_NAME" \
    --argjson max_age "$MAX_AGE_MIN" \
    '
    (.active[] | select(.id == $id) | .events) += [{
      at: $at,
      type: "wakeup_scheduled",
      scheduled_task_id: $sched_task_id,
      fire_at: $fire_at,
      template: $template
    }] |
    (.active[] | select(.id == $id) | .next_action) = {
      type: $template,
      scheduled_task_id: $sched_task_id,
      scheduled_at: $at,
      fire_at: $fire_at,
      max_age_min: $max_age
    }
    ' "$STATE_FILE" > "$TMP_STATE"

  # Atomic replace (jq writes to tmp; only commit if exit was 0)
  mv "$TMP_STATE" "$STATE_FILE"
fi

# ─── emit JSON to stdout ──────────────────────────────────────────────────────

jq -n \
  --arg taskId "$TASK_ID" \
  --arg fireAt "$FIRE_AT" \
  --arg description "$DESCRIPTION" \
  --arg promptPath "$PROMPT_TMPFILE" \
  --argjson promptSize "$PROMPT_SIZE" \
  --arg template "$TEMPLATE_NAME" \
  --argjson dryRun "$DRY_RUN" \
  '{
    taskId: $taskId,
    fireAt: $fireAt,
    description: $description,
    promptPath: $promptPath,
    promptSize: $promptSize,
    template: $template,
    dryRun: ($dryRun == 1)
  }'
