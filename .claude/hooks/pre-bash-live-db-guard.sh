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
# ---------------------------------------------------------------------------
# HOW IT DECIDES WHAT IS BEING LAUNCHED (rewritten 2026-08-18, backlog 63)
#
# It used to grep the raw command line for `vite`, `nest start`, `pnpm dev`,
# `dist/main`. A word in ANY position was enough, so this hook refused
#
#     git show <ref>:pnpm-lock.yaml | grep -n vite      (pure read, no process)
#     ls -la node_modules/.bin/vite
#     node -e "console.log('apps/api/dist/main.js')"
#
# with a wall of text about booting a dev server against the live database.
# That is not a cosmetic annoyance: the workaround is printed inside the
# refusal itself, so two false hits are enough to train "prepend `DATABASE_URL=`
# and retry" — a reflex that then fires on a REAL launch too. The predicates
# are NOT relaxed; the question changed from "does the line contain X" to
# "is X the command being executed", which is the only difference between
# `grep vite` and `vite`.
#
# The parse lives in lib/cmdscan.py (shared with pre-bash-devserver-ttl-gate.sh,
# which must agree token-for-token on what a launch is — they used to carry the
# same regex twice, which is why narrowing one alone would still have left this
# `grep` refused). It splits on `;`/`&&`/`||`/`|`/`&`/newline, recurses into
# `sh -c` and `$( )`, unwraps `VAR=v`, `env`, `sudo`, `nohup`, `timeout`,
# `xargs`, `npx`, `dev-ttl.sh --`, and decides on the COMMAND WORD.
# An unresolvable command word (`$RUNNER dev`) falls back to the old coarse
# test — conservative by construction.
# ---------------------------------------------------------------------------
#
# Contract:
#   - Reads tool-call JSON from stdin.
#   - Fast-exit 0 for non-dev-server commands.
#   - Fast-exit 0 outside agent worktree / claude scratchpad context — the
#     owner's own main-checkout session is legitimate and untouched.
#   - exit 2 + JSON decision body on block.
#   - exit 1 + `INTERNAL ERROR` on stderr when the ANALYZER itself fails:
#     a broken hook must never be mistaken for a hook that refused. Both used
#     to be "non-zero exit"; a bash syntax error still exits 2 exactly like a
#     verdict, so the distinguishing mark is the contract: a real verdict ALWAYS
#     carries a {"decision":"block"} body on stdout. If the analyzer dies while
#     the coarse test says a launcher is present, the fallback still blocks —
#     but labels itself ДЕГРАДИРОВАННЫЙ РЕЖИМ, so nobody debugs the wrong thing.
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
#   - READING about a launcher: grep/rg/ls/git show/echo naming `vite`,
#     `pnpm dev`, `dist/main` in any position.

set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT=$(cat)

[ -z "$INPUT" ] && exit 0

# Hot path: if no launcher word occurs anywhere in the payload, nothing below
# can fire — leave before paying for a python start. Deliberately a SUPERSET of
# what the analyzer can block (never a second, divergent policy).
echo "$INPUT" | grep -qE 'vite|nest|dev|dist/main' || exit 0

printf '%s' "$INPUT" | CMDSCAN_LIB="$SELF_DIR/lib" python3 -c '
import json, os, re, sys

sys.path.insert(0, os.environ["CMDSCAN_LIB"])
import cmdscan

data = json.load(sys.stdin)
cmd = (data.get("tool_input") or {}).get("command") or ""
cwd = data.get("cwd") or ""
if not cmd:
    sys.exit(0)

# Same worktree/scratchpad context gate as the sibling hook — the owner s
# main checkout is out of scope by design.
CONTEXT = re.compile(r"\.claude/worktrees/|/tmp/claude-")
if not CONTEXT.search(cmd) and not CONTEXT.search(cwd):
    sys.exit(0)

scan = cmdscan.scan(cmd)
hits = cmdscan.launches(scan)

# Unparseable quoting must not read as "found nothing": fall back to the coarse
# test rather than going quiet.
if not hits and scan.degraded and cmdscan.LEGACY_LAUNCHER_RE.search(cmd):
    hits = [(None, "деградированный разбор строки")]

if not hits:
    sys.exit(0)

label = hits[0][1]
segs = [s for s, _ in hits if s is not None]
reasons = []

db = scan.assigns.get("DATABASE_URL")
if db is None:
    reasons.append(
        "DATABASE_URL не задана инлайн в этой команде — унаследуется из "
        "окружения сессии, а не из .env worktree (dotenv НЕ перезаписывает "
        "уже установленную process.env переменную). Именно так утекло PR #485."
    )
elif db != "":
    db_name = db.rsplit("/", 1)[-1].split("?", 1)[0]
    if db_name == "crm_db":
        reasons.append(
            "DATABASE_URL указывает на живую базу владельца crm_db (%s)" % db
        )

port_values = []
for var in ("API_PORT", "PORT", "WEB_PORT"):
    val = scan.assigns.get(var)
    if val is not None and val.isdigit():
        port_values.append(val)
for seg in segs:
    argv = seg.argv
    for i, tok in enumerate(argv):
        m = re.match(r"^--port=(\d+)$", tok)
        if m:
            port_values.append(m.group(1))
        elif tok == "--port" and i + 1 < len(argv) and argv[i + 1].isdigit():
            port_values.append(argv[i + 1])
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

if not reasons:
    sys.exit(0)

reason_lines = "\n".join("  - %s" % r for r in reasons)
msg = """🚫 LIVE-DB GUARD: команда запускает dev-сервер из agent-worktree/scratchpad без доказуемо безопасных DATABASE_URL/порта.

Запуск, который распознан: %s

%s

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

Читать про запуск (grep/ls/git show, где слово vite или pnpm dev стоит аргументом) этот хук
больше не мешает — он смотрит только на команду в позиции запуска.

См. .claude/hooks/pre-bash-devserver-ttl-gate.sh и .claude/rules/common/light-track.md
(«Параллельный диспатч» — список свободных портов).""" % (label, reason_lines)

print(json.dumps({"decision": "block", "reason": msg}))
sys.stderr.write(
    "[pre:bash:live-db-guard] BLOCK unsafe dev-server launch in worktree/scratchpad (%s)\n" % label
)
sys.exit(10)
'
RC=$?

case "$RC" in
  0) exit 0 ;;
  10) exit 2 ;;
esac

# ── analyzer failure — NOT a verdict ──────────────────────────────────────────
# Everything below runs only when the python above could not finish (missing
# python3, missing lib/cmdscan.py, an edit that broke it). It says so loudly and
# falls back to the pre-2026-08-18 coarse test, so the protection does not
# silently disappear — but it never impersonates a decision on the merits.
echo "[pre:bash:live-db-guard] INTERNAL ERROR: анализатор не отработал (rc=$RC) — это НЕ вердикт хука." >&2

LEGACY='(^|[/[:space:]])nest(\.js)?[[:space:]]+start|(^|[/[:space:]])vite([[:space:]]|$)|(^|[[:space:]])(pnpm|npm|yarn|turbo)([[:space:]]+(-[^[:space:]]+|--filter[[:space:]]+[^[:space:]]+|run))*[[:space:]]+dev(:start)?([[:space:]]|$)|node[[:space:]][^;|&]*dist/main'
# The raw stdin is JSON, so the command's last token is followed by `"` — the
# legacy pattern's `([[:space:]]|$)` boundary would silently never match and the
# fallback would let everything through. Turning JSON punctuation into spaces
# restores the token boundaries without needing a parser (python3 may be exactly
# what is missing here). Verified by test case "СЛОМАННЫЙ анализатор + опасный запуск".
FLAT=$(printf '%s' "$INPUT" | tr '"{},' '    ')
if echo "$FLAT" | grep -qE "$LEGACY" && echo "$FLAT" | grep -qE '\.claude/worktrees/|/tmp/claude-'; then
  printf '%s\n' '{"decision":"block","reason":"⚠️ ДЕГРАДИРОВАННЫЙ РЕЖИМ live-db-guard: анализатор команды не отработал (см. INTERNAL ERROR в stderr), поэтому применено старое грубое правило «слово-подстрока». Это может быть ЛОЖНОЕ срабатывание. Почини .claude/hooks/lib/cmdscan.py вместо обхода: bash .claude/hooks/pre-bash-live-db-guard.sh < <(echo JSON) покажет причину."}'
  echo "[pre:bash:live-db-guard] BLOCK (degraded fallback, coarse substring rule)" >&2
  exit 2
fi
exit 1
