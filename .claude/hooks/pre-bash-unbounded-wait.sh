#!/bin/bash
# ECC stable id: pre:bash:unbounded-wait
#
# Purpose: refuse a shell wait that has no way to end. Three incidents, one
# family, each noticed by the OWNER in the background-tasks panel rather than by
# the agent that started it (the agent was long dead by then):
#
#   2026-09-21 — `cat` with no file argument inside a compound command waited on
#     stdin for 25 hours.
#   2026-09-24 — `until [ -f X ] && grep -qE "<expected Stryker line>" X; do
#     sleep 20; done`. Stryker never prints that line; the run finished, the
#     loop kept polling for ~3 hours.
#   2026-09-25 — `until [ -f …/tasks/<id>.status ]` and `until [ -f
#     …/tasks/<id>.exit ]`. The harness writes only `<id>.output` and never
#     either of those files: the exit condition was unreachable by construction.
#     11.5 hours.
#
# Why a hook and not a rule: after the second incident the instruction went into
# every dispatch prompt ("no home-made wait loops, wait for the harness
# notification"). The third incident happened anyway. The owner asked for
# mechanics, not discipline.
#
# WHY THE FOREGROUND TOOL TIMEOUT IS NOT A BOUND (checked in the Claude Code
# source, tools/BashTool/BashTool.tsx, 2026-09-25): a foreground command that
# exceeds its timeout is AUTO-BACKGROUNDED, not killed — `onTimeout` calls
# `startBackgrounding(...)`, and the only command exempt from that is a bare
# `sleep`. So a foreground `until` loop without a bound is exactly as immortal
# as a `run_in_background` one; it just takes two minutes longer to get there.
# The hook therefore does not look at `run_in_background` at all.
#
# Contract:
#   - Reads tool-call JSON from stdin (PreToolUse).
#   - exit 0 silently -> allow. exit 2 + {"decision":"block"} body -> block.
#   - Anything the analyzer cannot parse is ALLOWED (see "fail-open" below).
#   - Applies to every session, not only agents: there is no legitimate reason
#     for the owner's own session to start a wait that cannot end either, and
#     the incidents' cost (a task alive for a day) is the same whoever starts it.
#
# ---------------------------------------------------------------------------
# HOW IT DECIDES — command position, never substring.
#
# The command is lexed (quotes, `$(...)`, `${...}`, backticks, heredoc bodies
# are respected) into words and operators. A word is a KEYWORD or a COMMAND only
# when it sits in command position: at the start, after `;` `&&` `||` `|` `&`
# `(` or a newline, or after another keyword (`do`, `then`, `!`, `{`, ...).
# `grep -rn "until" .` and `echo "while x; do sleep 1; done"` are therefore a
# grep and an echo — the loop text is an argument, not a loop. This is the same
# budget as pre:bash:cross-agent-blast and .claude/rules/common/agent-isolation.md
# "Цена ложного срабатывания": a false positive costs trust in the whole hook
# layer, a miss costs one incident.
#
# PREDICATES
#
#   UNBOUNDED-LOOP  a `while`/`until` loop IN SCOPE and WITHOUT A BOUND.
#     In scope:  every `until` loop (it exists to wait for something);
#                a `while` loop whose condition or body runs `sleep`;
#                a `while true` / `while :` loop (no exit condition at all).
#     Out of scope: a `while` loop with no `sleep` and a real condition — that
#                is iteration, not waiting (`while read l; do …; done < f`).
#     A bound is any ONE of:
#       - the loop runs inside `timeout <N> bash -c '…'` (or sh/zsh -c);
#       - a deadline: `$SECONDS` / `$EPOCHSECONDS` / `date +%s` referenced in
#         the condition, or in the body together with `break`/`exit`/`return`,
#         or assigned to a variable in the body that the condition reads;
#       - a counter: a variable incremented/decremented in the loop (`n++`,
#         `n+=1`, `n=$((n+1))`, `expr`) that the condition reads, or that the
#         body compares before a `break`/`exit`/`return`;
#       - `while read …` — input-bounded, UNLESS the command also runs
#         `tail -f`/`-F`/`--follow`, whose input never ends.
#
#   UNREACHABLE-TASK-FILE  a loop (bounded or not) whose condition or body
#     names `…/tasks/<id>.status` or `…/tasks/<id>.exit`. The harness never
#     writes those files, so the loop can only ever end by its bound — a
#     guaranteed wasted wait. Refused outright, as the owner asked. Outside a
#     loop the same path is a one-shot test that costs nothing, and passes.
#
#   STDIN-CAT  `cat` in command position with no file operand (or only `-`),
#     no input redirect (`<`, `<<`, `<<-`, `<<<`, `<&`), and not fed by a pipe.
#     WHY IT HANGS ONLY SOMETIMES (Claude Code source, utils/bash/shellQuoting.ts
#     `shouldAddStdinRedirect`, 2026-09-25): the harness runs a command as
#     `eval '<cmd>' < /dev/null` — EXCEPT when the command text contains a
#     heredoc (`<<WORD`, even inside quotes, even a `<<<` here-string) or any
#     stdin redirect of its own (`< f`). Then no redirect is added, stdin is the
#     harness's own pipe, nobody ever closes it, and a bare `cat` elsewhere in
#     the same command waits for ever. So the same `cat` is harmless in one
#     command and a 25-hour hang in the next, depending on an unrelated heredoc.
#     A bare `cat` reads nothing useful in either case, so it is refused always
#     rather than second-guessing the harness's rule, which may change.
#     `cmd | cat`, `cat <<'EOF'`, `cat < f`, `cat f` pass.
#     `xargs cat` passes too: the cat is an argument there, and xargs supplies
#     the operands.
#
# A loop inside `bash -c '…'` / `sh -c` / `zsh -c` is analysed as well (one
# level of quoting is removed with shlex), so wrapping the loop in `bash -c`
# does not hide it — and `timeout N bash -c '…'` is recognised as a bound.
#
# FAIL-OPEN, deliberately. If the command does not lex (unbalanced quote,
# unmatched paren) the hook allows it. The shell would reject such a command
# with a syntax error before any loop starts, so there is no wait to prevent;
# refusing it would only produce a confusing message about a loop the shell
# never runs. A crash of the analyzer itself is also an allow — and the test
# refuses to count a bare exit code as a block (see the test header), so a
# broken analyzer shows up as failing red cases, not as a silently strict gate.
#
# DELIBERATELY NOT CAUGHT — accepted gaps, not oversights:
#   1. Indirection: `eval "$CMD"`, `./wait.sh`, a script written by a heredoc and
#      run afterwards, python/node polling loops. The inner program is not parsed.
#   2. Loops inside `$( … )` command substitution: the substitution is one word.
#   3. Other never-ending commands that are not loops: `tail -f`, `watch`,
#      `sleep infinity`, `read` with no timeout. Not in the three incidents;
#      `tail -f` in particular is also a legitimate way to follow a log that
#      the agent then kills by PID. Add a predicate when one of them bites.
#   4. zsh short loop forms (`while cond { … }`, `repeat`) and C-style
#      `for ((;;))`. Agents write the POSIX form; all three incidents did.
#   5. STDIN-CAT false positive: a `cat` inside a function body that is only
#      ever called with piped input (`f() { cat; }; x | f`), or a non-first
#      command of a piped group (`x | { true; cat; }`). Workaround that states
#      the intent: `cat /dev/stdin`.
#   6. A bound that is syntactically present but can never fire (a counter the
#      condition reads but compares to a huge number). The hook checks that a
#      bound EXISTS, not that it is sensible.
#   7. Tools other than Bash (the matcher is `Bash`). If a Monitor-style tool
#      that takes a shell command is used for waits, it is not seen here.
#
# IF YOU ADD A PREDICATE: add BOTH a refusal and at least one legitimate
# look-alike that must stay silent to
# scripts/devops/tests/test-pre-bash-unbounded-wait.sh, and run it.
# ---------------------------------------------------------------------------

set -u

INPUT=$(cat)

# Cheap pre-filter: no loop keyword and no `cat` anywhere -> nothing to analyse.
printf '%s' "$INPUT" | grep -qE 'until|while|cat' || exit 0

# The analyzer is a SINGLE-QUOTED heredoc on purpose: nothing inside is expanded
# by the shell. The sibling hook pre-bash-cross-agent-blast.sh assembled its
# message inside a double-quoted `python3 -c "…"` and the shell executed the
# backticked command names in it on every refusal (fixed 2026-09-02). A quoted
# heredoc makes that class of bug impossible here. It is read into a variable
# OUTSIDE `$( … )` because macOS /bin/bash 3.2 mis-parses quotes in a heredoc
# body nested inside a command substitution (a real syntax error, found while
# writing this hook).
read -r -d '' ANALYZER <<'PY'
import json, os, re, shlex, sys

try:
    payload = json.loads(os.environ.get("HOOK_INPUT", ""))
    cmd = payload.get("tool_input", {}).get("command", "")
except Exception:
    sys.exit(0)
if not isinstance(cmd, str) or not cmd.strip():
    sys.exit(0)


class ParseError(Exception):
    pass


# ---- lexer -----------------------------------------------------------------
OPS = sorted(
    ["&&", "||", "|&", ";;&", ";;", ";&", "<<<", "<<-", "<<", ">>", ">&", "<&",
     "&>>", "&>", ">|", "<>", ";", "&", "|", "(", ")", "<", ">"],
    key=len, reverse=True,
)
REDIR = {"<<<", "<<-", "<<", ">>", ">&", "<&", "&>>", "&>", ">|", "<>", "<", ">"}
INPUT_REDIR = {"<<<", "<<-", "<<", "<&", "<>", "<"}


def skip_single(s, i):
    k = s.find("'", i + 1)
    if k < 0:
        raise ParseError("unterminated '")
    return k + 1


def skip_backtick(s, i):
    j = i + 1
    while j < len(s):
        if s[j] == "\\":
            j += 2
            continue
        if s[j] == "`":
            return j + 1
        j += 1
    raise ParseError("unterminated `")


def skip_double(s, i):
    j = i + 1
    while j < len(s):
        c = s[j]
        if c == "\\":
            j += 2
            continue
        if c == '"':
            return j + 1
        if c == "$" and s.startswith("$(", j):
            j = skip_balanced(s, j + 1, "(", ")")
            continue
        if c == "`":
            j = skip_backtick(s, j)
            continue
        j += 1
    raise ParseError('unterminated "')


def skip_balanced(s, i, op, cl):
    depth = 0
    j = i
    while j < len(s):
        c = s[j]
        if c == "\\":
            j += 2
            continue
        if c == "'":
            j = skip_single(s, j)
            continue
        if c == '"':
            j = skip_double(s, j)
            continue
        if c == "`":
            j = skip_backtick(s, j)
            continue
        if c == op:
            depth += 1
        elif c == cl:
            depth -= 1
            if depth == 0:
                return j + 1
        j += 1
    raise ParseError("unbalanced " + op)


def read_word(s, i):
    j = i
    while j < len(s):
        c = s[j]
        if c in " \t\r\n;&|<>)":
            break
        if c == "(":
            # `arr=(a b)` — the parenthesised list belongs to the assignment
            if j > i and s[j - 1] == "=":
                j = skip_balanced(s, j, "(", ")")
                continue
            break
        if c == "\\":
            j += 2
            continue
        if c == "'":
            j = skip_single(s, j)
            continue
        if c == '"':
            j = skip_double(s, j)
            continue
        if c == "`":
            j = skip_backtick(s, j)
            continue
        if c == "$" and j + 1 < len(s) and s[j + 1] in "({":
            j = skip_balanced(s, j + 1, s[j + 1], ")" if s[j + 1] == "(" else "}")
            continue
        j += 1
    return j


def unquote(word):
    try:
        parts = shlex.split(word)
    except ValueError:
        return word
    return parts[0] if len(parts) == 1 else word


def lex(s):
    toks = []  # (kind, text, start, end)
    pending_heredocs = []  # (delimiter, strip_tabs)
    expect_delim = None
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if c in " \t\r":
            i += 1
            continue
        if c == "\\" and i + 1 < n and s[i + 1] == "\n":
            i += 2
            continue
        if c == "\n":
            toks.append(("op", "\n", i, i + 1))
            i += 1
            # heredoc bodies start on the line after their operator; skip them
            for delim, strip in pending_heredocs:
                while i < n:
                    e = s.find("\n", i)
                    line = s[i:] if e < 0 else s[i:e]
                    i = n if e < 0 else e + 1
                    if (line.lstrip("\t") if strip else line) == delim:
                        break
            pending_heredocs = []
            continue
        if c == "#":
            e = s.find("\n", i)
            i = n if e < 0 else e
            continue
        op = next((o for o in OPS if s.startswith(o, i)), None)
        if op:
            toks.append(("op", op, i, i + len(op)))
            if op in ("<<", "<<-"):
                expect_delim = op == "<<-"
            i += len(op)
            continue
        j = read_word(s, i)
        if j == i:  # defensive: never loop in place
            j = i + 1
        word = s[i:j]
        toks.append(("w", word, i, j))
        if expect_delim is not None:
            pending_heredocs.append((unquote(word), expect_delim))
            expect_delim = None
        i = j
    return toks


# ---- walk: keywords and simple commands, in order -------------------------
KEYWORDS = {"while", "until", "for", "select", "do", "done", "if", "then",
            "else", "elif", "fi", "case", "esac", "{", "}", "!", "time", "in"}
ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?\+?=")


class Cmd:
    def __init__(self, name, start, piped):
        self.name = name
        self.args = []
        self.redirs = []
        self.start = start
        self.end = start
        self.piped = piped


def walk(toks):
    events = []
    cur = None
    cmdpos = True
    piped = False
    want_target = False
    for_header = False
    case_state = None  # None | "header" | "pattern"

    def finish():
        nonlocal cur
        if cur is not None:
            events.append(("cmd", cur))
            cur = None

    for kind, text, st, en in toks:
        if kind == "op":
            if text in REDIR:
                if cur is not None:
                    # `2>&1`, `0<f`: a digit glued to the operator is its fd,
                    # not an operand of the command
                    if cur.args and cur.args[-1].isdigit() and cur.end == st:
                        cur.args.pop()
                    cur.redirs.append(text)
                want_target = True
                continue
            finish()
            if text in (";;", ";&", ";;&"):
                case_state = "pattern"
            elif text == ")" and case_state == "pattern":
                case_state = None
            if text in ("|", "|&"):
                piped = True
            elif text != "(":
                piped = False
            cmdpos = True
            continue

        if want_target:
            want_target = False
            continue
        if for_header:
            if text == "do":
                for_header = False
                events.append(("kw", "do", st, en))
                cmdpos = True
            continue
        if case_state == "header":
            if text == "in":
                case_state = "pattern"
            continue
        if case_state == "pattern":
            if text == "esac":
                events.append(("kw", "esac", st, en))
                case_state = None
                cmdpos = False
            continue
        if cur is None and cmdpos:
            if text in KEYWORDS:
                events.append(("kw", text, st, en))
                if text in ("for", "select"):
                    for_header = True
                elif text == "case":
                    case_state = "header"
                elif text in ("done", "fi", "esac", "}"):
                    cmdpos = False
                continue
            if ASSIGN.match(text):
                continue
            cur = Cmd(text, st, piped)
            cur.end = en
            piped = False
            cmdpos = False
            continue
        if cur is not None:
            cur.args.append(text)
            cur.end = en
    finish()
    return events


# ---- effective command name (behind wrappers) ------------------------------
PLAIN_WRAPPERS = {"nohup", "nice", "command", "builtin", "exec", "setsid",
                  "stdbuf", "env", "sudo", "caffeinate"}
TIMEOUT_WRAPPERS = {"timeout", "gtimeout"}


def effective(c):
    """(name, args, under_timeout) for a command, looking through wrappers."""
    words = [unquote(c.name)] + [unquote(a) for a in c.args]
    under_timeout = False
    for _ in range(4):
        while words and ASSIGN.match(words[0]):
            words.pop(0)
        if not words:
            return "", [], under_timeout
        base = os.path.basename(words[0])
        if base in TIMEOUT_WRAPPERS:
            words.pop(0)
            while words and words[0].startswith("-"):
                flag = words.pop(0)
                if flag in ("-s", "-k", "--signal", "--kill-after") and words:
                    words.pop(0)
            if words and re.match(r"^[0-9.]+[smhd]?$", words[0]):
                words.pop(0)
                under_timeout = True
            continue
        if base in PLAIN_WRAPPERS:
            words.pop(0)
            while words and (words[0].startswith("-") or ASSIGN.match(words[0])):
                words.pop(0)
            continue
        break
    if not words:
        return "", [], under_timeout
    return os.path.basename(words[0]), words[1:], under_timeout


# ---- loop reconstruction ---------------------------------------------------
def loops_of(events):
    loops, stack = [], []
    for ev in events:
        if ev[0] == "kw":
            _, kw, st, en = ev
            if kw in ("while", "until"):
                stack.append({"kind": kw, "start": st, "cond_start": en,
                              "state": "cond", "cond": [], "body": []})
            elif kw in ("for", "select"):
                stack.append({"kind": "for", "start": st, "cond_start": en,
                              "state": "cond", "cond": [], "body": []})
            elif kw == "do" and stack and stack[-1]["state"] == "cond":
                stack[-1]["state"] = "body"
                stack[-1]["cond_end"] = st
                stack[-1]["body_start"] = en
            elif kw == "done" and stack and stack[-1]["state"] == "body":
                L = stack.pop()
                L["body_end"] = st
                L["end"] = en
                loops.append(L)
        else:
            for L in stack:
                L[L["state"]].append(ev[1])
    return loops


EXIT_RE = re.compile(r"\b(break|exit|return)\b")
DEADLINE_RE = re.compile(r"\b(EPOCH)?SECONDS\b|\bdate\s+(-u\s+)?['\"]?\+%s")
DEADLINE_ASSIGN_RE = re.compile(
    r"\b([A-Za-z_]\w*)=(\$\(|`)\s*date\s+(-u\s+)?['\"]?\+%s")
COUNTER_RES = [
    re.compile(r"\b([A-Za-z_]\w*)(?:\+\+|--)(?![\w-])"),
    re.compile(r"(?<![\w+])\+\+([A-Za-z_]\w*)"),
    re.compile(r"\b([A-Za-z_]\w*)\s*[-+]=\s*[\$\w]"),
    re.compile(r"\b([A-Za-z_]\w*)=\$\(\(\s*\$?\{?\1\}?\s*[-+]"),
    re.compile(r"\b([A-Za-z_]\w*)\s*=\s*\$?\{?\1\}?\s*[-+]\s*\d"),
    re.compile(r"\b([A-Za-z_]\w*)=(?:\$\(|`)\s*expr\s+\$\{?\1\}?\s*[-+]"),
]
TASK_FILE_RE = re.compile(r"/tasks/[^\s'\"/;|&()]+\.(status|exit)\b")
FOLLOW_FLAG = re.compile(r"^(-[A-Za-z0-9]*[fF][A-Za-z0-9]*|--follow(=.*)?)$")


def has_word(var, text):
    return re.search(r"(?<![\w-])\$?\{?" + re.escape(var) + r"\b", text) is not None


def bounded(L, cond_text, body_text):
    if DEADLINE_RE.search(cond_text):
        return True
    if DEADLINE_RE.search(body_text):
        if EXIT_RE.search(body_text):
            return True
        for m in DEADLINE_ASSIGN_RE.finditer(body_text):
            if has_word(m.group(1), cond_text):
                return True
    full = cond_text + "\n" + body_text
    names = set()
    for rx in COUNTER_RES:
        names.update(m.group(1) for m in rx.finditer(full))
    for v in names:
        if has_word(v, cond_text):
            return True
        occurrences = len(re.findall(r"(?<![\w-])\$?\{?" + re.escape(v) + r"\b", body_text))
        if EXIT_RE.search(body_text) and occurrences >= 2:
            return True
    return False


def snippet(text, limit=140):
    one = " ".join(text.split())
    return one if len(one) <= limit else one[: limit - 1] + "…"


def analyse(s, outer_bounded, depth, reasons):
    toks = lex(s)
    events = walk(toks)
    cmds = [e[1] for e in events if e[0] == "cmd"]
    follow_fed = False
    for c in cmds:
        name, args, _ = effective(c)
        if name == "tail" and any(FOLLOW_FLAG.match(a) for a in args):
            follow_fed = True

    for L in loops_of(events):
        cond_text = s[L["cond_start"]:L["cond_end"]]
        body_text = s[L["body_start"]:L["body_end"]]
        whole = s[L["start"]:L["end"]]
        m = TASK_FILE_RE.search(cond_text + "\n" + body_text)
        if m:
            reasons.append((
                "UNREACHABLE-TASK-FILE",
                "цикл ждёт файл `%s`. Харнесс такие файлы НЕ создаёт — он пишет "
                "только `<id>.output`, а о завершении задачи сообщает сам, "
                "уведомлением. Условие недостижимо в принципе: 2026-09-25 два "
                "таких цикла прожили 11,5 часа. Цикл: `%s`" % (m.group(0).lstrip("/"), snippet(whole)),
            ))
            continue
        if L["kind"] == "for" or outer_bounded:
            continue
        names = [effective(c)[0] for c in L["cond"] + L["body"]]
        has_sleep = "sleep" in names
        cond_names = [effective(c) for c in L["cond"]]
        const_true = (len(cond_names) == 1 and cond_names[0][0] in ("true", ":")
                      and not cond_names[0][1])
        if L["kind"] == "while" and not (has_sleep or const_true):
            continue
        if (L["kind"] == "while" and cond_names and cond_names[0][0] == "read"
                and not follow_fed):
            continue
        if bounded(L, cond_text, body_text):
            continue
        reasons.append((
            "UNBOUNDED-LOOP",
            "цикл `%s` без предела: нет ни `timeout N` вокруг, ни дедлайна "
            "(`$SECONDS` / `date +%%s` в условии), ни счётчика итераций. Если "
            "ожидаемое не наступит — а 2026-09-24 ожидаемая строка Stryker "
            "не появилась вообще — цикл живёт, пока его не убьёт человек. "
            "Цикл: `%s`" % (L["kind"], snippet(whole)),
        ))

    for c in cmds:
        name, args, under_timeout = effective(c)
        if name in ("bash", "sh", "zsh", "dash", "ksh") and depth < 3:
            for k, a in enumerate(args):
                if re.match(r"^-[A-Za-z]*c[A-Za-z]*$", a) and k + 1 < len(args):
                    try:
                        analyse(args[k + 1], outer_bounded or under_timeout,
                                depth + 1, reasons)
                    except ParseError:
                        pass
                    break
            continue
        if name != "cat" or under_timeout or outer_bounded or c.piped:
            continue
        if any(r in INPUT_REDIR for r in c.redirs):
            continue
        operands = [a for a in args if a == "-" or not a.startswith("-")]
        if operands and operands != ["-"] * len(operands):
            continue
        reasons.append((
            "STDIN-CAT",
            "`%s` без файла читает stdin. Обычно харнесс подставляет "
            "`< /dev/null`, но если в команде есть heredoc (`<<EOF`) или свой "
            "`<`-редирект — не подставляет, stdin остаётся его трубой, которую "
            "никто не закроет, и `cat` ждёт вечно. 2026-09-21 такой `cat` в "
            "составной команде провисел 25 часов." % snippet(s[c.start:c.end], 60),
        ))


reasons = []
try:
    analyse(cmd, False, 0, reasons)
except ParseError:
    sys.exit(0)

if not reasons:
    sys.exit(0)

seen, lines = set(), []
for code, text in reasons:
    key = (code, text)
    if key in seen:
        continue
    seen.add(key)
    lines.append("  [%s] %s" % (code, text))

msg = """🚫 UNBOUNDED WAIT: команда может ждать вечно.

%s

Самодельное ожидание переживает агента, который его запустил: задача остаётся
«Running» в панели фоновых задач часами и сутками, и замечает её владелец, а не
ты. Три случая подряд (2026-09-21, 09-24, 09-25) — все именно так.

Как ждать правильно:
  • долгая команда — запусти её инструментом Bash с run_in_background: true и
    жди уведомления харнесса о завершении. Харнесс сам сообщит, когда процесс
    закончился, с кодом выхода; вывод лежит в `<id>.output`. Опрашивать ничего
    не нужно, и файлов `.status` / `.exit` не бывает.
  • если цикл действительно нужен — дай ему дедлайн. Переносимо (bash и zsh,
    `timeout` на macOS владельца НЕТ):
        SECONDS=0
        until [ -f X ] || [ "$SECONDS" -ge 600 ]; do sleep 10; done
    или счётчик:
        for i in $(seq 1 60); do [ -f X ] && break; sleep 10; done
    Условие выхода должно ловить и завершение процесса, а не только строку
    успеха: строка может так и не появиться.
  • `cat` — передай файл, heredoc или pipe. Если stdin действительно подаёт
    то, чего хук не видит, напиши это явно: `cat /dev/stdin`.

Правило: .claude/rules/common/light-track.md (Zombie-профилактика)""" % "\n".join(lines)

print(json.dumps({"decision": "block", "reason": msg}, ensure_ascii=False))
sys.exit(2)
PY

OUT=$(HOOK_INPUT="$INPUT" python3 -c "$ANALYZER" 2>/dev/null)
RC=$?

# Only a deliberate refusal blocks: exit 2 AND the decision body. A crashed
# analyzer (python traceback -> exit 1, empty stdout) is an allow, not a block.
if [ "$RC" -eq 2 ] && printf '%s' "$OUT" | grep -q '"decision": "block"'; then
  printf '%s\n' "$OUT"
  echo "[pre:bash:unbounded-wait] BLOCK: wait loop / stdin read with no bound" >&2
  exit 2
fi
# Fail-open, but not silently: a crashed analyzer says so on stderr, so the test
# can tell "allowed after analysis" from "allowed because python died".
if [ "$RC" -ne 0 ]; then
  echo "[pre:bash:unbounded-wait] analyzer crashed (rc=$RC) — allowing" >&2
fi
exit 0
