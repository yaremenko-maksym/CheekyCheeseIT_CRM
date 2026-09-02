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
# `stdbuf`, `timeout`) plus leading shell keywords (`do`, `then`, `if`, ...) are
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
#                    exists (WORKTREE-OPAQUE) and it refuses.
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
# ---------------------------------------------------------------------------
#
# What stays possible on purpose:
#   - `kill <PID>` / `kill -TERM <PID>` — the prescribed replacement.
#   - `pgrep -f '<pattern>' | xargs kill -9` — the owner's documented sweep
#     (light-track.md "Zombie-профилактика"). It is deliberate and targeted by
#     the human, not a blind broadcast from inside a task.
#   - Removing YOUR OWN worktree — by an EXPLICIT path. A path the hook cannot
#     expand is a path it cannot attribute, so "it was mine" has to be shown,
#     not asserted. Cost: one `echo` before the command.
#   - READING another worktree (cat/grep/ls/git log). Only mutation is gated;
#     see the rule file for why reading a live tree is still a bad idea.

set -u

INPUT=$(cat)

read_field() {
  printf '%s' "$INPUT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
cur = d
for key in sys.argv[1].split('.'):
    if not isinstance(cur, dict):
        cur = ''
        break
    cur = cur.get(key, '')
print(cur if isinstance(cur, str) else '')
" "$1" 2>/dev/null || true
}

CMD=$(read_field 'tool_input.command')
CWD=$(read_field 'cwd')
AGENT_ID=$(read_field 'agent_id')

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
CONTEXT='\.claude/worktrees/|/tmp/claude-|/private/tmp/claude-'
if ! echo "$CWD" | grep -qE "$CONTEXT" && [ -z "$AGENT_ID" ]; then
  exit 0
fi

# Cheap pre-filter: if none of the three trigger words appear anywhere, leave.
echo "$CMD" | grep -qE 'pkill|killall|worktree|\.claude/worktrees/|CheekyCheeseIT_CRM' || exit 0

REASONS=$(CWD="$CWD" printf '%s' "$CMD" | CWD="$CWD" python3 -c '
import os, re, shlex, sys

cmd = sys.stdin.read()
cwd = os.environ.get("CWD", "")

# ---- identity: which worktree am I? -----------------------------------------
# own_wt  — absolute path of my own worktree (or "" if I am not in one)
# own_seg — its directory name, the token compared against other paths
# repo_root — the shared checkout that hosts .claude/worktrees/
own_wt = own_seg = repo_root = ""
m = re.match(r"^(?P<root>.*?)/\.claude/worktrees/(?P<seg>[^/]+)", cwd)
if m:
    repo_root = m.group("root")
    own_seg = m.group("seg")
    own_wt = f"{repo_root}/.claude/worktrees/{own_seg}"

reasons = []

# ---- split into command segments --------------------------------------------
# Decisions are made on the FIRST TOKEN of a segment, so a pattern quoted as an
# ARGUMENT (grep "pkill", echo "rm -rf") never trips a predicate.
segments = re.split(r"(?:\|\||&&|[;\n|&])", cmd)


# Wrappers that RUN another command. Without unwrapping them, the effective
# command sits in an argument position and every predicate below misses it:
# `find <other worktree> | xargs rm` was a real, reproduced miss (CR-M-1 on
# PR #553). Unwrapping is safe for the false-positive budget because a
# predicate still additionally requires a foreign path to be referenced.
WRAPPERS = {"xargs", "sudo", "env", "nice", "nohup", "command", "stdbuf", "timeout"}
# Wrapper flags that consume the NEXT token as their value.
VALUE_FLAGS = {"-I", "-i", "-n", "-P", "-d", "-E", "-s", "-L", "-a", "-u", "-p"}

# Shell keywords that sit in command position without BEING the command. The
# body of a loop splits as `do <cmd>`, so without stripping these the first
# token is `do` and EVERY predicate below misses — verified 2026-09-02 for
# pkill, killall and git worktree remove alike. The 2026-09-02 incident was
# written exactly this way: `for w in $(...); do git worktree remove "$w"; done`.
KEYWORDS = {"do", "then", "else", "elif", "if", "while", "until", "!", "time"}


def first_token(seg):
    seg = seg.strip()
    if not seg:
        return "", []
    seg = seg.lstrip("(){ \t")
    try:
        parts = shlex.split(seg, comments=True)
    except ValueError:
        parts = seg.split()

    for _ in range(4):  # bounded: `sudo env xargs rm` and the like
        # drop leading env assignments (FOO=bar cmd) and shell keywords (do cmd)
        while parts and (
            re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", parts[0]) or parts[0] in KEYWORDS
        ):
            parts.pop(0)
        if not parts or os.path.basename(parts[0]) not in WRAPPERS:
            break
        wrapper = os.path.basename(parts.pop(0))
        while parts and parts[0].startswith("-"):
            flag = parts.pop(0)
            if flag in VALUE_FLAGS and parts:
                parts.pop(0)
        # `timeout 60 rm ...` — the duration sits where the command would be
        if wrapper == "timeout" and parts and re.match(r"^[0-9.]+[smhd]?$", parts[0]):
            parts.pop(0)

    if not parts:
        return "", []
    return os.path.basename(parts[0]), parts[1:]


toks = [first_token(s) for s in segments]


# ---- literal or not? ---------------------------------------------------------
# A token the shell will expand is a token whose value this hook cannot know:
# resolving it would mean RUNNING it. That is a hard limit, not a bug to fix.
# What IS a bug is pretending the limit does not exist — see WORKTREE-OPAQUE.
# `~` is the exception: expanduser is deterministic and runs as the same user,
# so a tilde path can be resolved honestly instead of being called opaque.
NONLITERAL = re.compile(r"[$`*?\[]")


def resolve(tok):
    """Absolute path for a LITERAL token. Caller must reject non-literals first."""
    t = os.path.expanduser(tok)
    if not t.startswith("/"):
        t = os.path.join(cwd, t)
    return os.path.normpath(t).rstrip("/")

# ---- predicate 1: broadcast process kill (backlog 72 / PR #547) -------------
for name, args in toks:
    if name in ("pkill", "killall"):
        reasons.append(
            "BROADCAST-KILL|`%s` бьёт по шаблону/имени и гасит процессы ЛЮБОГО "
            "агента, не только твои. Именно так PR #547 дважды убил dev-API "
            "параллельно работавшего кодера." % name
        )
        break

# ---- predicate 2: unregistering a worktree that is not mine (backlog 75/#544) -
for name, args in toks:
    if name != "git" or "worktree" not in args:
        continue
    sub = ""
    for a in args[args.index("worktree") + 1:]:
        if not a.startswith("-"):
            sub = a
            break
    if sub and NONLITERAL.search(sub):
        reasons.append(
            "WORKTREE-OPAQUE|`git worktree %s` — подкоманда задана НЕ литералом, "
            "поэтому я не знаю, читающая она (`list`) или разрушающая "
            "(`remove`/`prune`). Напиши подкоманду явно." % sub
        )
        break
    if sub == "prune":
        reasons.append(
            "WORKTREE-PRUNE|`git worktree prune` снимает регистрацию ВСЕХ "
            "worktree, чьи каталоги git считает исчезнувшими — включая чужие "
            "живые. Ты не видишь других агентов и не можешь судить, брошен ли "
            "их worktree (PR #544)."
        )
        break
    if sub == "remove":
        targets = [a for a in args[args.index("worktree") + 1:]
                   if not a.startswith("-") and a != "remove"]
        for t in targets:
            # Third outcome: OWN / FOREIGN / UNKNOWN. Before this existed the
            # token "$w" was joined onto cwd, landed inside own_wt, and hit the
            # `continue` below — so "I could not check" was recorded as "I
            # checked, it is yours". That is how the 2026-09-02 cleanup loop
            # removed two live reviewer checkouts while the LITERAL form of the
            # same command was refused.
            if NONLITERAL.search(t):
                reasons.append(
                    "WORKTREE-OPAQUE|`git worktree remove %s` — путь задан НЕ "
                    "литералом (переменная / подстановка / glob). Развернуть его "
                    "я не могу: для этого пришлось бы его выполнить. Значит я не "
                    "знаю, ЧЕЙ это каталог, и промолчать не имею права — молчание "
                    "здесь неотличимо от «проверил, всё чисто». Разверни путь сам "
                    "и передай явным литералом (`echo %s`): свой я пропущу, чужой "
                    "назову. Убираешь пачкой — по одному." % (t, t)
                )
                continue
            t_abs = resolve(t)
            if own_wt and (t_abs == own_wt or t_abs.startswith(own_wt + "/")):
                continue  # removing my own worktree is fine
            reasons.append(
                "WORKTREE-REMOVE|`git worktree remove %s` — это НЕ твой worktree "
                "(твой: %s). На PR #544 ровно эта команда снесла worktree "
                "ревьюера, ждавшего следующего раунда, и выбросила его в общий "
                "чекаут." % (t, own_wt or "<не в worktree>")
            )
        break

# ---- predicate 3: mutating another agent tree or the shared checkout --------
# (backlog 27 / PR #493, backlog 100 / PR #551)
MUTATORS = {
    "rm", "rmdir", "mv", "cp", "tee", "truncate", "dd", "chmod", "chown",
    "ln", "install", "patch", "touch", "mkdir", "unlink", "rsync",
}
MUTATING_GIT = {
    "checkout", "restore", "reset", "clean", "stash", "apply", "revert",
    "merge", "rebase", "commit", "add", "rm", "mv", "switch", "cherry-pick",
}


def is_mutating(name, args):
    if name in MUTATORS:
        return True
    if name == "sed" and any(a == "-i" or a.startswith("-i") for a in args):
        return True
    # `find <path> -delete` and `find <path> -exec rm {} \;` — the mutation is
    # an ARGUMENT of find. Only a mutating -exec payload counts, so
    # `find <path> -exec grep ...` stays allowed.
    if name == "find":
        if "-delete" in args:
            return True
        for i, a in enumerate(args):
            if a in ("-exec", "-execdir", "-ok") and i + 1 < len(args):
                if os.path.basename(args[i + 1]) in MUTATORS:
                    return True
    if name == "git":
        for a in args:
            if a.startswith("-"):
                continue
            return a in MUTATING_GIT
    return False


mutating = any(is_mutating(n, a) for n, a in toks)
# a redirect into a path is a mutation regardless of the command doing it
redirect_targets = re.findall(r">>?\s*([^\s;|&()]+)", cmd)

if mutating or redirect_targets:
    referenced = set(re.findall(r"[^\s\"\x27;|&()]*/\.claude/worktrees/([^/\s\"\x27;|&()]+)", cmd))
    foreign = sorted(s for s in referenced if s != own_seg)
    if foreign:
        reasons.append(
            "FOREIGN-WORKTREE|команда мутирует дерево другого агента "
            "(.claude/worktrees/%s; твой — %s). На PR #551 ревьюер именно так "
            "откатывал файл в ЖИВОМ worktree работающего кодера ради проверки "
            "красноты." % (", ".join(foreign), own_seg or "<не в worktree>")
        )
    elif repo_root:
        # mutation aimed at the shared checkout itself (not via .claude/worktrees/)
        cand = [t for t in redirect_targets]
        for n, a in toks:
            if is_mutating(n, a):
                cand += [x for x in a if not x.startswith("-")]
        hits = []
        for c in cand:
            if not c.startswith("/"):
                continue
            c_norm = os.path.normpath(c)
            if c_norm.startswith(repo_root + "/") and "/.claude/worktrees/" not in c_norm:
                hits.append(c)
        if hits:
            reasons.append(
                "SHARED-CHECKOUT|команда мутирует ОБЩИЙ чекаут по абсолютному "
                "пути (%s), а не твой worktree (%s). Это рецидивирующая "
                "MAIN-контаминация (zone-of-write.md FM-2)."
                % (", ".join(sorted(set(hits))[:3]), own_wt)
            )

for r in reasons:
    print(r)
' 2>/dev/null)

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
python3 -c "
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
