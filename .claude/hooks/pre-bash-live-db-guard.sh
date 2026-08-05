#!/bin/bash
# ECC stable id: pre:bash:live-db-guard
#
# Purpose: make it mechanically impossible for an agent worktree/scratchpad
# process to reach the OWNER'S live dev database or collide with the
# owner's live dev ports. 2026-08-05 incident (PR #485): an agent's dev-API
# process inherited API_PORT=3000 and DATABASE_URL=.../crm_db from the
# parent session's environment — its OWN .env in the worktree was silently
# ignored, because dotenv (and NestJS ConfigModule) never overwrite a
# process.env var that is already set. The API listened on :3000 against
# the live crm_db for ~2 minutes. No data was touched, only by luck; a
# migration or a write endpoint hit a minute later could have corrupted
# real financial records. The dispatch-prompt warning "set DATABASE_URL /
# API_PORT explicitly" is repeated in every agent prompt already and did
# NOT prevent this — so the fix has to be mechanical, not another warning.
#
# Root cause, precisely: inline env-var prefixes (VAR=value cmd) and
# `export VAR=value` DO override inherited env — but a bare .env file
# loaded by dotenv does NOT, if the shell already exported the var. The
# only reliably-safe pattern is an EXPLICIT inline override on the command
# itself. Absence of an explicit override is therefore treated as unsafe,
# even though "nothing was written" looks like the safe default — it is
# exactly the opposite (see class 3 below).
#
# Contract (mirrors pre-bash-devserver-ttl-gate.sh, the sibling hook this
# one is modeled on — same launcher/context detection idiom, deliberately
# duplicated rather than shared: no hook in this repo sources a common
# lib, and the two concerns are procedurally different (TTL-wrap vs
# explicit-env-override) so each keeps its own independently actionable
# block message instead of one hook doing two unrelated things):
#   - Reads tool-call JSON from stdin.
#   - Fast-exit 0 for non-dev-server commands.
#   - Fast-exit 0 outside agent worktree / claude scratchpad context — the
#     owner's own main-checkout session is legitimate and untouched.
#   - exit 2 + JSON decision body on block.
#   - CI runners never see this file at all (hooks are a local Claude Code
#     mechanism; GitHub Actions does not invoke .claude/hooks/**).
#
# What gets blocked, once command+context match (any ONE reason is enough):
#   1. DATABASE_URL explicitly set inline to a value whose db name is
#      exactly `crm_db` (the one shared live Postgres db — see
#      docker-compose.yml POSTGRES_DB). `crm_qa` / `crm_qa_*` (the
#      designated scratch db) and an explicit EMPTY value are both safe.
#   2. A port explicitly set inline (API_PORT=/PORT=/WEB_PORT=/--port) to
#      3000 or 3001 — the live pair (web/api, see apps/web/vite.config.ts
#      server.port and apps/api/src/main.ts API_PORT default).
#   3. Neither DATABASE_URL nor a port is set inline AT ALL — the covert
#      inheritance case, and the one that actually caused PR #485: no
#      override present reads as "will inherit whatever the parent shell
#      already exported", which this hook cannot verify and therefore
#      treats as unsafe by default.
#
# What stays possible (must NOT be blocked — see PR body for proof runs):
#   - Any command outside .claude/worktrees/** and claude scratchpads
#     (owner / master session on the live stack is legitimate work).
#   - Explicit safe values (non-crm_db db name + non-3000/3001 port).
#   - `DATABASE_URL=` (explicitly empty) — the established safe idiom for
#     feature-branch pushes (git-policy.md); this hook never even fires on
#     a `git push`, since it only matches dev-server launchers below.
#   - vitest / Playwright runs (not in the launcher pattern — see sibling
#     hook's header for why; unchanged here).

set -u

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null || true)
CWD=$(printf '%s' "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null || true)

# Fast exit: empty command.
[ -z "$CMD" ] && exit 0

# Same launcher surface as pre-bash-devserver-ttl-gate.sh (deliberately
# duplicated — see header): nest start / vite / pnpm|npm|yarn|turbo
# dev(:start) / node ... dist/main.
LAUNCHER='(^|[/[:space:]])nest(\.js)?[[:space:]]+start|(^|[/[:space:]])vite([[:space:]]|$)|(^|[[:space:]])(pnpm|npm|yarn|turbo)([[:space:]]+(-[^[:space:]]+|--filter[[:space:]]+[^[:space:]]+|run))*[[:space:]]+dev(:start)?([[:space:]]|$)|node[[:space:]][^;|&]*dist/main'
echo "$CMD" | grep -qE "$LAUNCHER" || exit 0

# Same worktree/scratchpad context gate as the sibling hook — the owner's
# main checkout is out of scope by design.
CONTEXT='\.claude/worktrees/|/tmp/claude-'
if ! echo "$CMD" | grep -qE "$CONTEXT" && ! echo "$CWD" | grep -qE "$CONTEXT"; then
  exit 0
fi

# Authoritative check: does this command explicitly declare a safe
# DATABASE_URL and a safe port? Reads CMD via stdin (no shell-quoting
# hazards) and prints one reason line per violation found, if any.
REASONS=$(printf '%s' "$CMD" | python3 -c '
import re, sys

cmd = sys.stdin.read()
reasons = []

db_match = re.search(r"DATABASE_URL=([\"\x27]?)([^\s\"\x27]*)\1", cmd)
if db_match is None:
    reasons.append(
        "DATABASE_URL не задана инлайн в этой команде — унаследуется из "
        "окружения сессии, а не из .env worktree (dotenv НЕ перезаписывает "
        "уже установленную process.env переменную). Именно так утекло PR #485."
    )
else:
    val = db_match.group(2)
    if val != "":
        db_name = val.rsplit("/", 1)[-1].split("?", 1)[0]
        if db_name == "crm_db":
            reasons.append(
                "DATABASE_URL указывает на живую базу владельца crm_db (%s)" % val
            )

port_values = []
port_values += re.findall(r"--port[=\s]+(\d+)", cmd)
port_values += re.findall(r"(?:^|[\s;&|])(?:API_PORT|PORT|WEB_PORT)=(\d+)", cmd)
if not port_values:
    reasons.append(
        "порт не задан инлайн в этой команде — унаследует живой порт по "
        "умолчанию (API_PORT default 3001 в apps/api/src/main.ts, vite "
        "server.port хардкожен 3000 в apps/web/vite.config.ts)"
    )
else:
    live = [p for p in port_values if p in ("3000", "3001")]
    if live:
        reasons.append(
            "порт %s явно задан из живой пары владельца (web:3000 / api:3001)" % live[0]
        )

for r in reasons:
    print(r)
' 2>/dev/null)

[ -z "$REASONS" ] && exit 0

# Block: build the JSON decision body via python (REASONS passed as argv to
# avoid re-quoting a multi-line string through the shell), stderr for the
# ECC human-readable line, exit 2 per convention.
python3 -c "
import json, sys

reasons = sys.argv[1].splitlines()
reason_lines = '\n'.join(f'  - {r}' for r in reasons)
msg = f'''🚫 LIVE-DB GUARD: команда запускает dev-сервер из agent-worktree/scratchpad без доказуемо безопасных DATABASE_URL/порта.

{reason_lines}

Инцидент 2026-08-05 (PR #485): унаследованные из родительской сессии DATABASE_URL/API_PORT
перебили .env worktree — API ~2 минуты слушал :3000 против ЖИВОЙ базы владельца. Обошлось
случайно (0 записей за сессию). Правило: любой запуск dev-сервера из worktree ОБЯЗАН явно
задавать И DATABASE_URL, И порт инлайн — .env файл сам по себе не гарантирует безопасность,
потому что уже установленная process.env переменная перекрывает его молча.

Правильно (безопасные значения — scratch DB crm_qa, свободные порты):
    DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa API_PORT=3011 pnpm --filter @crm/api dev
    DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa vite --port 3010

(web-сервер игнорирует PORT/API_PORT — vite.config.ts хардкодит server.port; порт меняется ТОЛЬКО через --port)

Если процесс осознанно не должен трогать БД — задай DATABASE_URL= (пустая строка) явно, а не
полагайся на умолчание.

Не забудь и TTL-обёртку (отдельное требование, тоже обязательное):
    scripts/devops/dev-ttl.sh -- DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa API_PORT=3011 pnpm --filter @crm/api dev

См. .claude/hooks/pre-bash-devserver-ttl-gate.sh и .claude/rules/common/light-track.md
(«Параллельный диспатч» — список свободных портов).'''
print(json.dumps({'decision': 'block', 'reason': msg}))
" "$REASONS" 2>/dev/null

echo "[pre:bash:live-db-guard] BLOCK unsafe dev-server launch in worktree/scratchpad" >&2
exit 2
