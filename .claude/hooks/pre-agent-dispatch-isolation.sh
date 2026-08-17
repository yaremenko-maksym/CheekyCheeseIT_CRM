#!/bin/bash
# ECC stable id: pre:agent:dispatch-isolation
#
# Purpose: catch the DISPATCHER'S error, not the agent's. Two incidents:
#
#   #497 (2026-08-08, backlog 36) — rounds 2-3 dispatched WITHOUT
#     isolation="worktree". The Coder therefore inherited the orchestrator's
#     working directory and eventually moved that checkout onto
#     feature/resume-base. The zone-of-write hook warned, the agent behaved
#     correctly. The dispatcher was wrong, and nothing gated the dispatcher.
#   #551 (2026-08-17, backlog 100) — a reviewer dispatched with neither
#     isolation nor cwd ran its commands in the orchestrator's tree.
#
# Both are the same root cause, and it is mechanical: an agent without its own
# cwd inherits a SHARED one. Combined with the harness resetting cwd back to
# the session directory between Bash calls (verified 2026-08-17, and stated
# outright in the agent system prompt: "Agent threads always have their cwd
# reset between bash calls"), a `cd` cannot rescue it — every later call lands
# back in the shared tree. See .claude/rules/common/agent-isolation.md.
#
# ---------------------------------------------------------------------------
# FEASIBILITY (backlog 36 / AC4) — established by fact, not by assumption:
#
#  (a) PreToolUse hooks are dispatched generically by tool name. In the Claude
#      Code source, services/tools/toolExecution.ts calls runPreToolUseHooks()
#      for every tool, which calls executePreToolHooks(tool.name, ...) with
#      matchQuery = tool.name and tool_input = the tool's parsed input. There
#      is no per-tool allow-list, so the Agent tool is included.
#  (b) The tool is named `Agent`, with alias `Task` kept expressly for hooks
#      ("Legacy wire name for backward compat (permission rules, hooks,
#      resumed sessions)" — tools/AgentTool/constants.ts). matchesPattern()
#      normalises legacy names, so the matcher "Agent|Task" covers both.
#  (c) `isolation` and `cwd` are real optional fields of the Agent tool input
#      schema (tools/AgentTool/AgentTool.tsx), alongside `subagent_type` — so
#      they arrive inside tool_input and are readable here.
#  (d) Project hooks DO fire for subagent tool calls in this runtime — verified
#      2026-08-17 by tripping pre:bash:safety from inside a subagent.
#
#  NOT verified end-to-end: a subagent cannot itself dispatch an Agent, so the
#  author of this hook could not fire a real Agent tool call and watch this
#  hook block it. (a)-(c) come from a leaked source snapshot that is OLDER than
#  the running app (a live worktree-guard string present in this runtime is
#  absent from that snapshot). Therefore this hook is belt, and the
#  report-observable requirement in agent-isolation.md is suspenders — per
#  AC5, which asks for exactly that pairing rather than a bet on one of them.
# ---------------------------------------------------------------------------
#
# Contract: PreToolUse, matcher "Agent|Task". stdin = tool-call JSON.
#   exit 0 silently → allow. exit 2 + JSON decision body → block.
#
# FALSE-POSITIVE BUDGET: default-ALLOW on anything not explicitly known to be a
# writing agent. Unknown/built-in subagent types (Explore, Plan,
# general-purpose, plugin agents) pass untouched — an unknown type is not
# evidence of a mistake, and a gate that fires on surprises teaches people to
# route around it (backlog 63).

set -u

INPUT=$(cat)

REASONS=$(printf '%s' "$INPUT" | python3 -c '
import json, re, sys

try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)

ti = d.get("tool_input") or {}
if not isinstance(ti, dict):
    sys.exit(0)

subagent = str(ti.get("subagent_type") or "").strip()
isolation = str(ti.get("isolation") or "").strip()
cwd_override = str(ti.get("cwd") or "").strip()
prompt = str(ti.get("prompt") or "")

# Agents that WRITE to the repo. Anything not on this list is allowed through.
WRITERS = {
    "coder", "autotest", "devops", "ui-ux-designer", "manual-qa",
    "legal", "pm", "architect",
}
# Read-only roles, listed only for the explicit no-op case (AC6): they must NOT
# be forced to pay for a worktree. Kept as a named set so the intent is
# legible, and so a future edit cannot quietly promote one into WRITERS.
READERS = {
    "code-reviewer", "security-reviewer", "copy-reviewer",
    "explore", "plan", "general-purpose", "codebase-audit",
}

reasons = []
key = subagent.lower()

if key in WRITERS and not isolation and not cwd_override:
    reasons.append(
        "NO-ISOLATION|субагент `%s` пишет в репозиторий, но диспатчится без "
        "isolation=\"worktree\" и без cwd — он унаследует рабочий каталог "
        "ОРКЕСТРАТОРА и будет коммитить/переключать ветки в общем чекауте "
        "(PR #497)." % subagent
    )

# Shared measurement directory handed down in the prompt (backlog 27 / PR #493).
# Narrow on purpose: requires an ABSOLUTE path whose last segment looks like a
# per-PR scratch dir. "PR для review: #493" has no path and is not matched.
shared = re.findall(r"(/(?:tmp|Users|private)/(?:\S*?/)?(?:rev|review|pr)[-_]?\d+)\b", prompt, re.I)
if shared:
    reasons.append(
        "SHARED-WORKDIR|в промпте задан общий рабочий каталог по абсолютному "
        "пути (%s). Два ревьюера, получив один и тот же путь, мутируют дерево "
        "друг друга — на PR #493 чужая правка попала в замеры как свойство "
        "кода. Путь рабочего каталога должен выводиться из идентификатора "
        "САМОГО агента, а не из номера PR." % shared[0]
    )

for r in reasons:
    print(r)
' 2>/dev/null)

[ -z "$REASONS" ] && exit 0

python3 -c "
import json, sys

raw = [r for r in sys.argv[1].splitlines() if r.strip()]
lines = []
for r in raw:
    code, _, text = r.partition('|')
    lines.append(f'  [{code}] {text}')
body = '\n'.join(lines)

msg = f'''🚫 DISPATCH ISOLATION: ошибка ДИСПЕТЧЕРА, а не агента.

{body}

Почему это не лечится инструкцией внутри промпта: рабочий каталог агента
сбрасывается на каталог его сессии между вызовами Bash (харнесс сообщает это
прямо: «Agent threads always have their cwd reset between bash calls»).
Значит `cd` в начале работы НЕ удержится — со второго вызова агент снова
окажется в общем дереве. Единственная точка, где это решается, — сам диспатч.

Как надо:
  • пишущий агент (coder / autotest / devops / ui-ux-designer / manual-qa /
    legal / pm / architect):
        Agent(isolation=\\\"worktree\\\", subagent_type=\\\"coder\\\", ...)
  • нужен конкретный существующий каталог вместо нового worktree:
        Agent(cwd=\\\"/abs/path\\\", ...)   # взаимоисключимо с isolation
  • read-only агент (code-reviewer / security-reviewer / copy-reviewer /
    Explore / Plan) — изоляция НЕ нужна и НЕ навязывается: он читает diff через
    gh/GitHub MCP. Если по ходу ревью понадобится ЗАПУСТИТЬ или откатить код —
    ревьюер сам делает СВОЙ чекаут в своём scratchpad
    (.claude/skills/code-review-discipline/SKILL.md §6), а не работает в чужом
    или общем дереве.
  • рабочий каталог НИКОГДА не задаётся в промпте общим абсолютным путём
    вида /tmp/rev<PR> — он выводится из идентификатора самого агента.

Правило: .claude/rules/common/agent-isolation.md
Сниппеты диспатча: .claude/agents/pm-snippets.md'''
print(json.dumps({'decision': 'block', 'reason': msg}))
" "$REASONS" 2>/dev/null

echo "[pre:agent:dispatch-isolation] BLOCK: writing subagent dispatched without its own workspace" >&2
exit 2
