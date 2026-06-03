#!/bin/bash
# DEPRECATED (Phase 2.5): replaced by .claude/hooks-ecc/pre-bash-safety.sh.
# Kept as rollback fallback artifact; will be removed in Phase 6 cleanup.
# Active registration lives in .claude/settings.json which now points at
# hooks-ecc/. If you are editing this file you almost certainly want to
# edit the ECC port instead.
#
# Fires before every Bash tool call.
# Blocks truly catastrophic commands that can't be undone —
# force push to main/master, rm -rf on root paths, DROP DATABASE.

CMD=$(python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null || true)

[ -z "$CMD" ] && exit 0

BLOCKED=""

if echo "$CMD" | grep -qE 'git push.*--force.*(origin +(main|master)|main|master)'; then
  BLOCKED="force push to main/master"
fi

if echo "$CMD" | grep -qE 'rm -rf (/[^a-zA-Z]|~/?$|~/[^D])'; then
  BLOCKED="rm -rf on root/home path"
fi

if echo "$CMD" | grep -qiE 'DROP\s+DATABASE\s+crm_db'; then
  BLOCKED="DROP DATABASE crm_db"
fi

if [ -n "$BLOCKED" ]; then
  python3 -c "
import json, sys
reason = sys.argv[1]
print(json.dumps({'decision': 'block', 'reason': f'Заблокировано safety хуком: {reason}. Выполни вручную если уверен.'}))
" "$BLOCKED" 2>/dev/null
fi
