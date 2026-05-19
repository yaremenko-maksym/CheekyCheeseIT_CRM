#!/bin/bash
# Fires after every Bash tool call.
# Logs `gh workflow run` dispatches to .claude/dispatches.log for PM tracking.

CMD=$(python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null || true)

echo "$CMD" | grep -q "gh workflow run" || exit 0

LOG="/Users/maksym/Desktop/programming/CheekyCheeseIT_CRM/.claude/dispatches.log"
printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$CMD" >> "$LOG"
