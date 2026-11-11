#!/bin/bash
# ECC stable id: pre:bash:cross-agent-blast
#
# Purpose: stop ONE agent from reaching outside its own workspace and hitting
# ANOTHER agent — processes, worktree registration, or files. Three incidents
# in one week, all the same shape (agent could not see the other agent, so it
# could not reasonably judge that the target was free):
#
#   #547 (2026-08-17, backlog 72) — DevOps ran `pkill -f "apps/api/dist/main"`
#     twice and killed the dev-API of a Coder running in parallel.
#   #544 (2026-08-17, backlog 75) — Coder ran `git worktree remove --force` on
#     what it judged to be an abandoned worktree. It was the REVIEWER's, live,
#     waiting for the next round. The reviewer then ran in the shared checkout
#     and detached its HEAD.
#   #551 (2026-08-17, backlog 100) — code-reviewer ran a redness check inside
#     ANOTHER agent's live worktree, reverting a file there to see the test go
#     red. Timing luck only.
#   2026-09-02, twice in one session — the ORCHESTRATOR removed two live
#     reviewer checkouts with
#       for w in $(git worktree list | ...); do git worktree remove --force "$w"; done
#     This hook was already installed and said nothing. Two blindnesses stacked:
#     the target was a variable it cannot expand, and the loop body puts `do` in
#     command position so no predicate even looked. Both are fixed below; the
#     lesson that outlives the fix is in "WHAT SILENCE MEANS".
#
# Why a hook and not a rule: in all three the agent behaved reasonably given
# what it could see. It cannot see the other agents. No amount of "be careful"
# fixes a missing observation — see .claude/rules/common/agent-isolation.md.
#
# What the harness ALREADY does (verified by probe 2026-08-17, do NOT duplicate):
#   `git -C <path outside my worktree> ...`      → harness refuses
#   `cd <path outside my worktree> && git ...`   → harness refuses
# What the harness does NOT do (verified by the same probes — these are the
# holes this hook fills):
#   `cd <other worktree> && ls`                  → RUNS (containment is git-only)
#   `git worktree remove <other worktree>`       → RUNS (git runs in MY cwd)
#   `pkill -f <pattern>`                         → RUNS (processes aren't files)
#
# Contract:
#   - Reads tool-call JSON from stdin (PreToolUse).
#   - exit 0 silently → allow. exit 2 + JSON decision body → block.
#   - Fast-exits for every command that is not one of the three shapes below,
#     so the cost on the hot path is a handful of greps.
#
# FALSE-POSITIVE BUDGET (deliberate — see the rule file's "цена ложного
# срабатывания"): every predicate below is decided on the FIRST TOKEN of a
# command segment, never on a substring of the whole line. `grep -rn "pkill" x`
# and `echo "rm -rf /other"` are therefore allowed. This is the opposite of
# pre-bash-safety.sh, which greps the raw line and consequently blocks a plain
# `echo "... DROP DATABASE crm_db ..."` — a live false positive reproduced on
# 2026-08-17 while building this hook, and exactly the reflex-to-bypass that
# backlog 63 warned about.
#
# ---------------------------------------------------------------------------
# SCOPE AND KNOWN GAPS — read this before trusting the hook, and before
# "hardening" it. Recorded here rather than in a PR comment on purpose: a
# limitation known only to the people in one review thread survives exactly
# until the first person who was not in that thread (this repo spent 2026-08-17
# fixing three guards that failed that way).
#
# HOW IT DECIDES: the command is split into segments on `;`, `&&`, `||`, `|`
# and newlines, and each predicate looks at the FIRST TOKEN of a segment —
# never at a substring of the raw line. Leading `VAR=value` assignments and
# command wrappers (`xargs`, `sudo`, `env`, `nice`, `nohup`, `command`,
# `stdbuf`, `timeout`, `rtk` — the token-economy output filter) plus leading shell keywords (`do`, `then`, `if`, ...) are
# unwrapped first, so the effective command is what gets judged.
#
# WHAT SILENCE MEANS — the distinction this hook got wrong until 2026-09-02.
# A predicate that RESOLVES something and then concludes must be able to say
# "I could not resolve it". A predicate that merely SEARCHES for a known marker
# claims nothing by not finding it. Which one each predicate is:
#
#   BROADCAST-KILL   decides on the command NAME. A name is always a literal,
#                    so `pkill -f "$PAT"` is caught exactly like `pkill -f lit`.
#                    Silence means "no kill-by-pattern in command position".
#   WORKTREE-PRUNE   decides on the SUBCOMMAND token; `prune` takes no path, so
#                    there is nothing to resolve. A non-literal subcommand
#                    (`git worktree $SUB`) is reported as WORKTREE-OPAQUE.
#   WORKTREE-REMOVE  RESOLVES each target and concludes own/foreign — the one
#                    predicate that can be wrong in the dangerous direction, and
#                    was: `"$w"` looks relative, got joined onto cwd, landed
#                    inside my own worktree, and was recorded as MINE. "Could
#                    not check" became "checked, clean". A third outcome now
#                    exists (WORKTREE-OPAQUE) and it refuses. "Own" means my
#                    worktree (from my cwd) or a scratch path RECORDED against my
#                    agent_id when this hook watched me create it. The session
#                    scratchpad is shared between siblings, so a scratch path by
#                    itself proves nothing — see WORKTREE-UNRECORDED.
#   WORKTREE-UNRECORDED
#                    the target is in the shared session scratchpad and no
#                    ledger line ties it to THIS agent_id. Same silence rule as
#                    OPAQUE: not a claim that it is foreign, a statement that
#                    ownership was never recorded.
#   FOREIGN-WORKTREE searches the raw text for a `.claude/worktrees/<seg>`
#   SHARED-CHECKOUT  marker. Not finding one is not a safety claim — it is the
#                    same silence as for `ls`. Deliberately NOT extended to
#                    non-literals: see gap 1.
#
# CAUGHT (each verified by a case in tests/cross-agent-hooks-smoke.sh):
#   pkill / killall in command position, incl. behind a wrapper (`sudo pkill`)
#   git worktree remove <path that is not mine> / git worktree prune
#   rm|mv|cp|tee|truncate|dd|chmod|chown|ln|install|patch|touch|mkdir|rsync
#     and `sed -i` naming a path inside another agent worktree
#   git worktree remove <target that is not a literal> -> WORKTREE-OPAQUE, and
#     `git worktree $SUB` likewise: refusing to guess, not pretending to know
#   any of the above with a shell keyword in front (`; do pkill ...; done`)
#   the same behind a wrapper: `find <other> -type f | xargs rm`
#   `find <other> -delete` and `find <other> -exec rm {} \;`
#   `cd <other worktree> && <mutating command>`
#   `>`/`>>` redirect into another worktree or into the shared checkout
#   mutating git subcommands (checkout/restore/reset/clean/stash/...) aimed at
#     another worktree
#
# DELIBERATELY NOT CAUGHT — accepted gaps, not oversights:
#   1. Indirection through a variable in an ORDINARY mutator:
#      `D=<other worktree>; rm -rf "$D"`. Still open, now on purpose rather than
#      by omission. `git worktree remove` refuses an unresolvable target because
#      every invocation of it destroys a workspace — there is no benign majority
#      to protect, and the remedy is one command (`echo "$w"`, then pass the
#      literal). `rm "$x"` is the opposite on both counts: the overwhelming
#      majority is an agent's own tree or scratchpad, and there is no cheap
#      remedy to offer for a loop over two hundred files. Refusing it would buy
#      one class of miss at the price of the false positive this hook's own
#      budget below forbids. Pinned by a silence case in the smoke test, so
#      widening the rule is a deliberate act and not a drift.
#   2. Indirection through an interpreter: `eval "$CMD"`, `bash -c '...'`,
#      `./cleanup.sh`, a python/node one-liner that unlinks files. The inner
#      program is not parsed.
#   3. Relative traversal that never spells the marker path:
#      `cd <my worktree> && rm ../agent-OTHER/f` — the `.claude/worktrees/<seg>`
#      literal is what identifies a foreign tree.
#   4. `xargs -I {} rm {}` — the `-I` form puts the command after a
#      placeholder; only the plain `xargs rm` shape is unwrapped.
#   5. Symlinks pointing out of the worktree; paths reached through `$TMPDIR`
#      or similar env indirection.
#
# WHY THESE ARE LEFT OPEN: closing them means either evaluating the shell
# (impossible from a PreToolUse hook) or matching on the raw line, which is
# precisely what makes a gate fire on legitimate work — `pre:bash:safety` greps
# the raw line and therefore blocks a plain `echo` that merely quotes a live-DB
# drop phrase (reproduced three times on 2026-08-17, once on the command that
# was writing the PR description for this hook). This project's stated
# priority is explicit: a false positive costs trust in the whole hook layer,
# a miss costs one incident. Every gap above requires the agent to actively
# construct indirection; all seven real incidents used the direct forms, which
# are caught.
#
# THEREFORE: this hook is a backstop for the honest mistake, NOT a security
# boundary against a determined caller. The primary control is structural —
# every agent gets its own working directory (rules/common/agent-isolation.md),
# so there is no foreign tree in reach to begin with.
#
# IF YOU ADD A PREDICATE: add BOTH a blocking case and at least one legitimate
# command that must stay silent to tests/cross-agent-hooks-smoke.sh, and run it.
#
# LANGUAGE: the refusal strings here are Russian, which predates the 2026-10-05
# flip to English for all of .claude/** (rules/common/russian-language.md). New
# predicates are written in Russian too, deliberately: the strings are assembled
# into ONE message body with the shared epilogue below, and a single English line
# inside it reads as an oversight rather than as policy. Converting the file is a
# follow-up of its own — the wording is quoted by tests, so it needs a review pass
# rather than a sweep inside an unrelated PR.
# ---------------------------------------------------------------------------
#
# What stays possible on purpose:
#   - `kill <PID>` / `kill -TERM <PID>` — the prescribed replacement.
#   - `pgrep -f '<pattern>' | xargs kill -9` — the owner's documented sweep
#     (light-track.md "Zombie-профилактика"). It is deliberate and targeted by
#     the human, not a blind broadcast from inside a task.
#   - Removing YOUR OWN worktree, or a scratch checkout you CREATED AT A LITERAL
#     PATH (which is what records it as yours) — by an EXPLICIT path. A path the
#     hook cannot expand is a path it cannot attribute, so "it was mine" has to
#     be shown, not asserted. Cost: one `echo` before the command, for the add as
#     well as the remove. Before 2026-10-17 no scratch checkout could be removed
#     at all; the first fix for that permitted ANY path in the scratchpad, which
#     is shared between siblings — see the ownership comment in lib/cross_agent_blast_analyzer.py.
#   - READING another worktree (cat/grep/ls/git log). Only mutation is gated;
#     see the rule file for why reading a live tree is still a bad idea.

set -u

INPUT=$(cat)

read_field() {
  printf '%s' "$INPUT" | python3 -I -B -c "
import json, sys
# UTF-8 both ways, as in the analyzer: on Windows the locale code page cannot even
# decode some UTF-8 Cyrillic (the 0x98 of U+0418), and the command was refused unread.
sys.stdin.reconfigure(encoding='utf-8', errors=sys.stdin.errors)
sys.stdout.reconfigure(encoding='utf-8', errors=sys.stdout.errors)
d = json.load(sys.stdin)
cur = d
for key in sys.argv[1].split('.'):
    if not isinstance(cur, dict):
        cur = ''
        break
    cur = cur.get(key, '')
print(cur if isinstance(cur, str) else '')
" "$1" 2>/dev/null
}

CMD=$(read_field 'tool_input.command')
CMD_RC=$?
CWD=$(read_field 'cwd')
AGENT_ID=$(read_field 'agent_id')
CWD=${CWD//\\//} # Windows payloads use backslashes

# A command that could not be read is not "no command" (#1297 SR-L-4): python3 did not
# run, or the payload did not parse, or the command cannot be printed (a lone surrogate).
if [ "$CMD_RC" -ne 0 ]; then
  echo "[pre:bash:cross-agent-blast] INTERNAL ERROR: the command could not be read (python3 did not run, or the payload did not parse). Refused. Fix it first: python3 must run on PATH and the hook library must load. Bash stays refused until then." >&2
  exit 2
fi
[ -z "$CMD" ] && exit 0

# ---------------------------------------------------------------------------
# Context gate. Only agents are gated; the owner's own session is untouched.
#
# Primary signal: cwd inside an agent worktree or a claude scratchpad.
# Secondary signal: agent_id present. The harness sets it for subagent tool
# calls and leaves it empty on the main thread (createBaseHookInput in the
# Claude Code source: "Hooks use agent_id presence to distinguish subagent
# calls from main-thread calls"). It is used only to WIDEN the gate — if this
# runtime does not send the field, the cwd signal alone still covers all three
# incidents above, every one of which happened inside a worktree.
# ---------------------------------------------------------------------------
CONTEXT='\.claude/worktrees/|\.t3/worktrees/|/tmp/claude-|/private/tmp/claude-|AppData/Local/Temp/claude'
if ! echo "$CWD" | grep -qiE "$CONTEXT" && [ -z "$AGENT_ID" ]; then
  exit 0
fi

# Cheap pre-filter: if none of the three trigger words appear anywhere, leave.
# Case-insensitive: Windows and macOS accept any case for the same path.
# A T3 worktree lives outside its checkout, whose name can be anything, so it skips this filter.
# Quotes and backslashes are dropped first, as the other two fast paths do (`p''kill` runs
# pkill, SR-M-2 of #1294), and a `$`, backtick or backslash goes to the analyzer: the first
# two can build any word, a backslash-newline joins one (`p\<newline>kill`, SR-M-1).
# LC_ALL=C: under a UTF-8 locale macOS tr and grep fail on an invalid byte (#1297 SR-L-6).
echo "$CWD" | grep -qiE '\.t3/worktrees/' ||
  printf '%s' "$CMD" | LC_ALL=C tr -d "'\"\\\\" |
  LC_ALL=C grep -qiE 'pkill|killall|taskkill|kill[[:space:]]|worktree|\.t3/|\.claude/worktrees/|CheekyCheeseIT_CRM' ||
  printf '%s' "$CMD" | LC_ALL=C grep -q '[$`\]' || exit 0

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The analyzer is a file (lib/cross_agent_blast_analyzer.py), not a `python3 -c`
# argument: Windows caps a whole command line at 32767 characters, and a -c body
# past that fails to launch (E2BIG, rc 126), which the branch below turns into a
# refusal of EVERY command. scripts/devops/check-hook-inline-python-size.py keeps
# every inline -c body of the hooks under that limit.
REASONS=$(printf '%s' "$CMD" | CWD="$CWD" MSYS2_ENV_CONV_EXCL=CWD AGENT_ID="$AGENT_ID" \
  PYTHONDONTWRITEBYTECODE=1 CMDSCAN_LIB="$SELF_DIR/lib" \
  python3 -I -B "$SELF_DIR/lib/cross_agent_blast_analyzer.py" 2>/dev/null)
RC=$?

if [ "$RC" -ne 0 ]; then
  echo "[pre:bash:cross-agent-blast] INTERNAL ERROR: the analyzer did not run (rc=$RC), so this command was not read. Refused. Fix it first: python3 must run on PATH and the hook library must load. Bash stays refused until then." >&2
  exit 2
fi

[ -z "$REASONS" ] && exit 0

# NOTE: this heredoc-less `python3 -c "..."` is DOUBLE-quoted, so the shell
# still expands `$` and BACKTICKS inside it. A backtick here is command
# substitution, not markdown: until 2026-09-02 the line naming the forbidden
# commands contained bare `pkill -f` / `killall`, and the shell RAN both on
# every single refusal — harmless only because each demands an argument and
# refuses without one. Their empty stdout replaced the words, so the message
# lost exactly the two names it exists to say. Escape every backtick (\`) and
# every literal `$` here. Pinned by the message case in
# scripts/devops/tests/test-pre-bash-cross-agent-blast.sh.
python3 -I -B -c "
import json, sys

raw = [r for r in sys.argv[1].splitlines() if r.strip()]
lines = []
for r in raw:
    code, _, text = r.partition('|')
    lines.append(f'  [{code}] {text}')
body = '\n'.join(lines)

msg = f'''🚫 CROSS-AGENT BLAST: команда выходит за пределы твоего рабочего пространства и может задеть другого агента.

{body}

Ты НЕ ВИДИШЬ других агентов — ни их процессов, ни того, жив ли их worktree.
Поэтому «этот процесс/каталог выглядит брошенным» не является наблюдением,
на котором можно действовать. Три инцидента 2026-08-17 (#547, #544, #551)
именно так и выглядели изнутри.

Как сделать то же самое безопасно:
  • процессы  — найди СВОИ PID и убей их поимённо:
        lsof -ti tcp:<твой порт>            # порт, который поднимал ТЫ
        kill <PID>        (или kill -TERM <PID>)
    \`pkill -f\` / \`killall\` не различают твои процессы и чужие.
  • worktree  — удаляй только СВОЙ и ТОЛЬКО явным путём. Путь в переменной я
    развернуть не могу, а значит и не могу сказать, чей он:
        echo \\\"\$w\\\"                       # что там на самом деле
        git worktree remove --force /развёрнутый/путь
    Чужой стух? Не трогай: сообщи оркестратору,
    он видит всех агентов, а ты — нет. Массовую уборку делает владелец
    (см. docs/architecture/2026-08-17-agent-collision-mechanics.md §AC14).
  • чужое дерево — не мутируй его вообще. Нужна проверка красноты? Сделай
    СВОЙ чекаут нужного коммита (путь из ТВОЕГО идентификатора):
        git worktree add --detach \\\"\$SCRATCH/checkout\\\" <sha>
    и мутируй там. См. .claude/skills/code-review-discipline/SKILL.md §6.
  • общий чекаут — все правки только внутри своего worktree, относительными
    путями. Абсолютный путь в общий чекаут = MAIN-контаминация.

Правило: .claude/rules/common/agent-isolation.md'''
print(json.dumps({'decision': 'block', 'reason': msg}))
" "$REASONS" 2>/dev/null

echo "[pre:bash:cross-agent-blast] BLOCK: cross-agent reach from agent workspace" >&2
exit 2
