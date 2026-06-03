#!/bin/bash
# ECC stable id: pre:bash:safety
# Phase 2 ECC port of legacy .claude/hooks/safety.sh.
#
# Purpose: block truly catastrophic Bash commands — fork bombs, rm -rf on root
# paths, force push to main/master, DROP DATABASE crm_db. Everything else
# fast-exits so the hook never gates non-target commands.
#
# Contract:
#   - Reads tool-call JSON from stdin (Claude Code PreToolUse contract).
#   - exit 0 with no output  → allow.
#   - exit 2 with stderr     → block (ECC convention) AND emit JSON
#                              {"decision":"block","reason":"..."} to stdout for
#                              legacy compatibility with Claude Code's JSON
#                              control-flow path.
#
# Specific predicates implemented:
#   1. `rm -rf /<dir>` where <dir> starts with a letter/digit at root level
#      (intentionally NOT blocking `rm -rf /tmp/...`, `/var/...` paths under
#      well-known temp roots — see smoke test D1).
#   2. `rm -rf ~` / `rm -rf ~/...` (excluding `~/Downloads` & similar safe paths
#      kept from legacy regex).
#   3. Fork bomb pattern `:(){:|:&};:` (any whitespace variant).
#   4. Force push to main/master: `git push --force ... (main|master)`.
#   5. `DROP DATABASE crm_db` (case-insensitive).
#
# Performance note: every non-target command exits in microseconds via two
# cheap python+grep checks. No git/network calls on the hot path.

set -u

CMD=$(python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null || true)

# Fast exit: empty command or no command field.
[ -z "$CMD" ] && exit 0

BLOCKED=""

# Predicate 1+2: rm -rf on dangerous root/home paths.
# Matches:
#   - `rm -rf /<alpha>` — root-level system dirs (/etc, /usr, /var, /home, ...)
#     BUT exempt the obviously safe scratch roots /tmp/ and /var/folders/
#     so common test cleanup like `rm -rf /tmp/test-dir` is not gated.
#   - `rm -rf ~` or `rm -rf ~/<not-Downloads>` — home blast radius.
# Implementation: first check the exemption (fast positive — allow path), then
# the danger pattern. Single subshell per check; cost stays microseconds.
if echo "$CMD" | grep -qE 'rm[[:space:]]+-rf?[[:space:]]+/(tmp|var/folders)/'; then
  : # Allow: /tmp/** and /var/folders/** scratch paths.
elif echo "$CMD" | grep -qE 'rm[[:space:]]+-rf?[[:space:]]+(/[a-zA-Z]|~/?$|~/[^D])'; then
  BLOCKED="rm -rf on root/home path"
fi

# Predicate 3: classic bash fork bomb.
# Match :(){ :|:& };: with optional whitespace.
if echo "$CMD" | grep -qE ':[[:space:]]*\([[:space:]]*\)[[:space:]]*\{[[:space:]]*:[[:space:]]*\|[[:space:]]*:[[:space:]]*&[[:space:]]*\}[[:space:]]*;[[:space:]]*:'; then
  BLOCKED="fork bomb"
fi

# Predicate 4: force push to main/master.
if echo "$CMD" | grep -qE 'git[[:space:]]+push.*(--force|--force-with-lease|[[:space:]]-f([[:space:]]|$)).*((origin[[:space:]]+)?(main|master))'; then
  BLOCKED="force push to main/master"
fi

# Predicate 5: DROP DATABASE crm_db.
if echo "$CMD" | grep -qiE 'DROP[[:space:]]+DATABASE[[:space:]]+crm_db'; then
  BLOCKED="DROP DATABASE crm_db"
fi

if [ -z "$BLOCKED" ]; then
  exit 0
fi

# Block: stdout JSON for Claude Code legacy decision contract; stderr for ECC
# human-readable reason; exit 2 per ECC PreToolUse convention.
python3 -c "
import json, sys
reason = sys.argv[1]
msg = f'Заблокировано safety хуком: {reason}. Выполни вручную если уверен.'
print(json.dumps({'decision': 'block', 'reason': msg}))
" "$BLOCKED" 2>/dev/null

echo "[pre:bash:safety] BLOCK: $BLOCKED" >&2
exit 2
