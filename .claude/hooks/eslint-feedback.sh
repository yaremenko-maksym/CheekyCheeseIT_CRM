#!/bin/bash
# Fires after Edit/Write on TS/TSX files.
# Runs eslint --fix, then injects any remaining errors into Claude's context
# so it sees them immediately without needing a separate lint step.

FILE=$(python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null || true)

[[ "$FILE" =~ \.(ts|tsx)$ ]] && [ -f "$FILE" ] || exit 0

PROJECT_ROOT="/Users/maksym/Desktop/programming/CheekyCheeseIT_CRM"

if [[ "$FILE" == *"/apps/web/"* ]]; then
  ESLINT_DIR="$PROJECT_ROOT/apps/web"
elif [[ "$FILE" == *"/apps/api/"* ]]; then
  ESLINT_DIR="$PROJECT_ROOT/apps/api"
else
  exit 0
fi

ESLINT_BIN="$ESLINT_DIR/node_modules/.bin/eslint"
[ -f "$ESLINT_BIN" ] || exit 0

OUTPUT=$(cd "$ESLINT_DIR" && "$ESLINT_BIN" --fix "$FILE" 2>&1)
ERRORS=$(echo "$OUTPUT" | grep -E '^\s+[0-9]+:[0-9]+\s+error' | head -5)

if [ -n "$ERRORS" ]; then
  python3 -c "
import json, sys
errors = sys.argv[1]
fname = sys.argv[2]
ctx = f'ESLint errors (не auto-fixable) в {fname}:\n{errors}'
print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': ctx}}))
" "$ERRORS" "$(basename "$FILE")" 2>/dev/null || true
fi
