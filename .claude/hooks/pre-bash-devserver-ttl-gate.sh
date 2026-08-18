#!/bin/bash
# ECC stable id: pre:bash:devserver-ttl-gate
#
# Purpose: prevent zombie dev-server accumulation. 2026-07-24 incident: 67
# orphaned nest/vite processes from agent worktrees (booted 2026-07-12..15,
# never stopped) drove the host into swap thrash (load average 70). The
# procedural "sweep zombie ports" rule failed — sessions die uncleanly, so
# the cleanup invariant moves into mechanics: any dev-server boot inside an
# agent worktree or claude scratchpad MUST go through
# scripts/devops/dev-ttl.sh (self-expiring process group).
#
# ---------------------------------------------------------------------------
# HOW IT DECIDES WHAT IS BEING LAUNCHED (rewritten 2026-08-18, backlog 63)
#
# This hook carried the SAME launcher regex as pre-bash-live-db-guard.sh,
# copy-pasted, matching a word in any position. So it refused
#
#     git show <ref>:pnpm-lock.yaml | grep -n vite
#
# — reproduced again on 2026-08-18 while fixing the sibling: narrowing only
# live-db-guard left this hook still blocking the very same honest read. That
# is why the definition of "a launch" now lives in ONE place, lib/cmdscan.py,
# and both hooks ask it the same question: is the launcher the COMMAND WORD of
# some segment, rather than a substring of the line. Nothing is relaxed —
# `pnpm dev` behind `&&`, `sh -c`, `env VAR=v`, `nohup`, `timeout`, an absolute
# path, or a command substitution is still caught (see the guard tests).
# ---------------------------------------------------------------------------
#
# Contract (mirrors pre-bash-coder-push-gate.sh):
#   - Reads tool-call JSON from stdin.
#   - Fast-exit 0 for non-dev-server commands.
#   - exit 2 + JSON decision body on block.
#   - exit 1 + `INTERNAL ERROR` on stderr when the analyzer itself fails — a
#     broken hook must not be mistaken for a hook that refused (a bash syntax
#     error exits 2 exactly like a verdict does; the distinguishing mark is
#     that a real verdict always carries a {"decision":"block"} body).
#
# Decision tree:
#   - the launching segment is itself wrapped in dev-ttl.sh → allow
#   - no segment actually launches a dev server        → allow (vitest/E2E
#     runs intentionally NOT matched — they self-terminate; and so is any
#     command that merely NAMES a launcher: grep/ls/git show/echo)
#   - neither cwd nor command references a worktree/
#     scratchpad path                                 → allow (main-repo
#     standing UT stack on :3000/:3001 is legit)
#   - otherwise                                       → BLOCK

set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT=$(cat)

[ -z "$INPUT" ] && exit 0

# Hot path: a superset of everything the analyzer can block, so a command with
# none of these words never pays for a python start.
echo "$INPUT" | grep -qE 'vite|nest|dev|dist/main' || exit 0

printf '%s' "$INPUT" | PYTHONDONTWRITEBYTECODE=1 CMDSCAN_LIB="$SELF_DIR/lib" python3 -c '
import importlib.util, json, os, re, sys

# By absolute path, not via sys.path — see the note in pre-bash-safety.sh.
_spec = importlib.util.spec_from_file_location(
    "cmdscan", os.path.join(os.environ["CMDSCAN_LIB"], "cmdscan.py"))
cmdscan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cmdscan)

data = json.load(sys.stdin)
cmd = (data.get("tool_input") or {}).get("command") or ""
cwd = data.get("cwd") or ""
if not cmd:
    sys.exit(0)

# Enforce only in agent worktree / claude scratchpad context.
CONTEXT = re.compile(r"\.claude/worktrees/|/tmp/claude-")
if not CONTEXT.search(cmd) and not CONTEXT.search(cwd):
    sys.exit(0)

scan = cmdscan.scan(cmd)
# Confidence-aware (see the sibling hook): a segment whose command word could
# not be resolved contributes every reading of itself, so an unknown wrapper
# cannot smuggle a boot past the gate. The old `scan.degraded` special case is
# gone with it.
hits = cmdscan.launches(scan)

# Code the analyzer never reached (nesting past MAX_DEPTH) is refused rather
# than reported clean — with no wrappers, so the TTL check below fails it.
if not hits and scan.truncated:
    hits = [(
        cmdscan.Segment("", [], [], [], False, cmd, 0, {}, False, None),
        "вложенность глубже предела разбора — код не прочитан",
    )]

# A decoy mention of dev-ttl.sh in one segment must not whitelist an unwrapped
# boot in another: the wrapper has to sit on the LAUNCHING segment itself.
unwrapped = [
    (seg, label) for seg, label in hits
    if "dev-ttl.sh" not in seg.wrappers
]
if not unwrapped:
    sys.exit(0)

label = unwrapped[0][1]
reason = """🚫 DEVSERVER-TTL BLOCK: старт dev-сервера в agent-worktree/scratchpad без TTL-обёртки.

Запуск, который распознан: %s

Причина: инцидент 2026-07-24 — 67 зомби nest/vite процессов из worktree загнали Mac
в swap-трэшинг (load average 70). Dev-сервер в .claude/worktrees/** обязан
самоликвидироваться по TTL, а не полагаться на cleanup сессии.

Правильно (обёртка даёт группе процессов TTL, default 4ч):
    scripts/devops/dev-ttl.sh -- <твоя команда>
    scripts/devops/dev-ttl.sh --ttl 7200 -- pnpm --filter @crm/api dev

Перед бутом проверь, не занят ли порт твоим же старым сервером:
    lsof -ti tcp:<PORT> | xargs kill -9

Читать про запуск (grep/ls/git show, где слово стоит аргументом) хук не мешает —
он смотрит только на команду в позиции запуска.

См. .claude/rules/common/light-track.md («Параллельный диспатч») и scripts/devops/dev-ttl.sh.""" % label

print(json.dumps({"decision": "block", "reason": reason}))
sys.stderr.write(
    "[pre:bash:devserver-ttl-gate] BLOCK unwrapped dev-server boot in worktree/scratchpad (%s)\n" % label
)
sys.exit(10)
'
RC=$?

case "$RC" in
  0) exit 0 ;;
  10) exit 2 ;;
esac

# ── analyzer failure — NOT a verdict ──────────────────────────────────────────
echo "[pre:bash:devserver-ttl-gate] INTERNAL ERROR: анализатор не отработал (rc=$RC) — это НЕ вердикт хука." >&2

LEGACY='(^|[/[:space:]])nest(\.js)?[[:space:]]+start|(^|[/[:space:]])vite([[:space:]]|$)|(^|[[:space:]])(pnpm|npm|yarn|turbo)([[:space:]]+(-[^[:space:]]+|--filter[[:space:]]+[^[:space:]]+|run))*[[:space:]]+dev(:start)?([[:space:]]|$)|node[[:space:]][^;|&]*dist/main'
# JSON punctuation flattened to spaces so the legacy pattern's `([[:space:]]|$)`
# boundaries still hold on the raw stdin (see the sibling hook for the full note).
FLAT=$(printf '%s' "$INPUT" | tr '"{},' '    ')
if echo "$FLAT" | grep -qE "$LEGACY" &&
  echo "$FLAT" | grep -qE '\.claude/worktrees/|/tmp/claude-' &&
  ! echo "$FLAT" | grep -q 'dev-ttl\.sh'; then
  printf '%s\n' '{"decision":"block","reason":"⚠️ ДЕГРАДИРОВАННЫЙ РЕЖИМ devserver-ttl-gate: анализатор команды не отработал (см. INTERNAL ERROR в stderr), поэтому применено старое грубое правило «слово-подстрока». Это может быть ЛОЖНОЕ срабатывание. Чини .claude/hooks/lib/cmdscan.py, а не обходи хук."}'
  echo "[pre:bash:devserver-ttl-gate] BLOCK (degraded fallback, coarse substring rule)" >&2
  exit 2
fi
exit 1
