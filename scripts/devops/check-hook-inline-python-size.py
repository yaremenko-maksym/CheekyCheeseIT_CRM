#!/usr/bin/env python3
"""check-hook-inline-python-size.py - no hook passes python3 a -c body near the Windows limit.

Windows CreateProcess caps a WHOLE command line at 32767 UTF-16 code units. Git Bash
launches the native python3.exe through it, so a hook that hands python3 a large
inline program (`python3 -c '<body>'`) fails to start with "Argument list too long",
and bash reports rc 126. Linux allows 128 KiB per argument, so every test on CI stays
green while the hook is dead on every Windows machine. On 2026-11-11 the analyzer of
pre-bash-cross-agent-blast.sh reached 44186 characters, its fail-closed branch turned
rc 126 into a refusal, and every Bash call on Windows was refused.

This guard measures every `python3 -c` / `python3.X -c` / `python -c` body (any python
options before the `-c`) in .claude/hooks/**/*.sh,
as the whole shell word bash passes (quote splices included), and fails when one
exceeds BUDGET. The budget sits well under
the hard cap, because the rest of the command line (interpreter path, flags, other
arguments) shares the same 32767. The fix it asks for is the one the hooks already
use: put the program in .claude/hooks/lib/<name>.py and run `python3 -I -B <file>`.

A body passed as a variable (`-c "$SRC"`) is measured through the heredoc that fills
it (`read -r -d '' SRC <<'PY'`, as pre-bash-unbounded-wait.sh does). Everything the
guard cannot measure is a violation, not a pass: an unmeasured body is not a small
one. Two passes make sure of that:

1. A parser reads the forms it can measure: the interpreter word, python's options up
   to the `-c`, and the body. A body made only of expansions (`"$1"`, `"${VAR:-}"`,
   `"$A$B"`), or holding a positional, special or operator expansion anywhere, is
   UNMEASURED, and so are `$'...'`, a command substitution, and a `-c` behind an
   interpreter it cannot name (`"$PY"`, `"$HOME/bin/python3"`). A plain `$NAME` inside
   literal program text is counted as its own text (shortcut: its value is unknown,
   fine while hook bodies only embed short names such as a branch; trace it if one
   embeds anything longer).
2. A catch-all then reads every simple command. One with a python-like word (any word
   containing `python`, `py`, `pypy3`, `python.exe`, or a variable whose name
   contains `PY`) before a `-c` word, where pass 1 read no interpreter, is UNMEASURED
   too: `timeout 5 "$PY" -c`, `py -3 -c`, `$(command -v python3) -c`. So a form the
   parser does not know is reported, never skipped. A python-like word right after an
   option is that option's argument only for a command named in NON_WRAPPERS
   (`git -C "$PYDIR" -c x=y`); after any other command it is still reported.
An expansion between the interpreter and the `-c` (`"$PY" "$OPT" -c`, `python3
"$SCRIPT" a -c b`) cannot be read, so the body is UNMEASURED: fail closed.
"""

import os
import re
import sys

BUDGET = 24000  # UTF-16 code units, the unit of the Windows limit
HARD_CAP = 32767

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
HOOKS = os.path.join(REPO_ROOT, ".claude", "hooks")

# The interpreter is found as a shell WORD, then its options are read word by word up
# to the `-c` (python's own option grammar, so `find ... -exec` is not one of them).
# python's options without an argument; `-c`, `-m`, `-W`, `-X` take one.
NOARG = set("bBdEhiIOPqRsSuvVx?")
LONG_WITH_ARG = {"--check-hash-based-pycs"}
PY_NAME = re.compile(r"(?<![A-Za-z0-9_])python(?:3(?:\.\d+)?)?(?![\w.])")
# The interpreter word, quotes and a closing brace removed, ends in a python name:
# `python3`, `/usr/bin/python3`, `"$HOME/bin/python3"`, `${PY:-python3}`.
PY_WORD = re.compile(r"(?:^|[/:-])python(?:3(?:\.\d+)?)?$")
C_OPTION = re.compile(r"^-[A-Za-z?]*c")
# A -c word for the catch-all: python's no-argument letters, then c (`-c`, `-IBc`).
C_WORD = re.compile(r"^-[bBdEhiIOPqRsSuvVx?]*c")
PY_LIKE_BASE = re.compile(r"^(?:py|pypy3?(?:\.\d+)?)(?:\.exe)?$", re.I)
PY_LIKE_VAR = re.compile(r"\$\{?[A-Za-z0-9_]*PY")
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
# Commands that run the next command: an option right before the interpreter is theirs.
WRAPPERS = {"timeout", "xargs", "sudo", "doas", "env", "nice", "nohup", "stdbuf", "ionice",
            "chrt", "taskset", "setsid", "flock", "time", "command", "exec", "builtin"}
# Commands whose own `-c` follows an option argument: `git -C "$PYDIR" -c user.name=x`.
NON_WRAPPERS = {"git"}
VAR_START = re.compile(r"^\"?\$\{?([A-Za-z_][A-Za-z0-9_]*)")
TRACED_VAR = re.compile(r'^"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"$')
EXPANSION = re.compile(r"\$(?:\{|[A-Za-z_0-9@*#?$!-])")
PLAIN_EXPANSION = re.compile(r"\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)")
# A shell (`"$SHELL" -c`) is not python and is left alone.
SHELL_VARS = {"SHELL", "BASH", "SH", "ZSH"}
WORD_BREAK = " \t\n;|&()<>`"
END_OF_COMMAND = ";|&\n)"
REDIRECT = re.compile(r"[0-9]*(?:<<<|<<-?|>>|<>|>&|<&|>\||>|<)")
HEREDOC = re.compile(r"<<(-?)[ \t]*")
# Words after which the next word is a command again (`then python3 -c ...`).
PREFIX_WORDS = {"then", "do", "else", "elif", "if", "while", "until", "exec", "command",
                "time", "!", "nohup", "env", "sudo", "{"}

UNMEASURED = object()  # there is (or may be) a -c body, and it cannot be measured
NO_C = object()  # the interpreter's command was read to its end: no -c
UNREADABLE = object()  # catch-all: the tokenizer lost the file from here to its end


def heredoc_var(text, name):
    """The body of `read -r -d '' NAME <<'TAG' ... TAG`, or None when there is none."""
    m = re.search(
        r"read\s+-r\s+-d\s+''\s+%s\s+<<-?\s*(['\"]?)(\w+)\1[^\n]*\n(.*?)\n\2\n" % re.escape(name),
        text,
        re.S,
    )
    return m.group(3) if m else None


def skip_subst(text, i):
    """Index just past the `)` that closes a `$(` whose contents start at text[i]."""
    depth = 1
    while i < len(text) and depth:
        c = text[i]
        if c == "'":
            j = text.find("'", i + 1)
            i = len(text) if j == -1 else j + 1
            continue
        if c == '"':
            j = i + 1
            while j < len(text) and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            i = j + 1
            continue
        if c == "\\":
            i += 2
            continue
        depth += {"(": 1, ")": -1}.get(c, 0)
        i += 1
    return i


def bash_word(text, i):
    """(value, end, expands) of the shell word starting at text[i], as bash builds it:
    quoted segments run together (`'a'"b"'c'` is one word, and a hook that splices a
    quote into a single-quoted body as `'\\''` has a body longer than its first
    segment). value is None when a quote never closes, or when the word holds a
    command substitution (`"$(cat f)"`, a backtick) or an ANSI-C string (`$'...'`): its
    length is not the length of its text. expands is True when the word holds a
    parameter expansion outside single quotes, whose value is unknown here."""
    out = []
    dynamic = expands = False
    while i < len(text):
        c = text[i]
        if text.startswith("$(", i):
            j = skip_subst(text, i + 2)
            dynamic = True
            out.append(text[i:j])
            i = j
        elif c == "`":
            j = text.find("`", i + 1)
            if j == -1:
                return None, len(text), expands
            dynamic = True
            out.append(text[i:j + 1])
            i = j + 1
        elif text.startswith("$'", i):
            dynamic = True  # `\'` does not close an ANSI-C string
            j = i + 2
            while j < len(text) and text[j] != "'":
                j += 2 if text[j] == "\\" else 1
            if j >= len(text):
                return None, len(text), expands
            out.append(text[i:j + 1])
            i = j + 1
        elif EXPANSION.match(text, i):
            expands = True
            out.append(c)
            i += 1
        elif c == "'":
            j = text.find("'", i + 1)
            if j == -1:
                return None, len(text), expands
            out.append(text[i + 1:j])
            i = j + 1
        elif c == '"':
            i += 1
            while i < len(text) and text[i] != '"':
                if text[i] == "\\" and text[i + 1:i + 2] in ('\\', '"', '$', '`', '\n'):
                    out.append("" if text[i + 1] == "\n" else text[i + 1])
                    i += 2
                else:
                    if text[i] == "`" or text.startswith("$(", i):
                        dynamic = True
                    elif EXPANSION.match(text, i):
                        expands = True
                    out.append(text[i])
                    i += 1
            if i >= len(text):
                return None, len(text), expands
            i += 1
        elif c == "\\":
            out.append("" if text[i + 1:i + 2] == "\n" else text[i + 1:i + 2])
            i += 2
        elif c in WORD_BREAK:
            break
        else:
            out.append(c)
            i += 1
    return (None if dynamic else "".join(out)), i, expands


def next_word(text, i):
    """(value, raw, end, expands) of the next argument of the current command,
    skipping redirections; None when the command ends first."""
    while True:
        while i < len(text) and (text[i] in " \t" or text.startswith("\\\n", i)):
            i += 2 if text[i] == "\\" else 1
        if i >= len(text) or text[i] in END_OF_COMMAND:
            return None
        r = REDIRECT.match(text, i)
        if r:
            i = r.end()
            while i < len(text) and text[i] in " \t":
                i += 1
            if i < len(text) and text[i] not in END_OF_COMMAND:
                i = bash_word(text, i)[1]
            continue
        if text[i] == "(":
            return None
        value, end, expands = bash_word(text, i)
        if end == i:
            return None
        return value, text[i:end], end, expands


def word_start(text, k):
    """Start of the shell word holding text[k] (a word has no unquoted break in it)."""
    while k > 0 and text[k - 1] not in WORD_BREAK:
        k -= 1
    return k


def command_position(text, start):
    """True when the word at `start` is where bash looks for a command."""
    line_start = text.rfind("\n", 0, start) + 1
    prefix = text[line_start:start].rstrip()
    if not prefix or prefix[-1] in ";|&({`":
        return True
    last = re.split(r"[\s;|&({`]+", prefix)[-1]  # `n=$(grep`: the command is grep
    return last in PREFIX_WORDS or re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", last) is not None


def later_c(text, i):
    """True when a word after text[i] in the same command looks like a `-c` option."""
    while True:
        w = next_word(text, i)
        if w is None:
            return False
        if C_OPTION.match(w[0] if w[0] is not None else w[1]):
            return True
        i = w[2]


def c_body(text, i):
    """Read python's options from text[i] up to `-c`. NO_C = no -c in this command,
    UNMEASURED = there may be one but the options or the body cannot be read, else
    the body text."""
    while True:
        w = next_word(text, i)
        if w is None:
            return NO_C
        value, raw, i, expands = w
        if value is None or expands:
            # `$FLAGS`, `"$OPT"` (quoted or not, it may be an option) or a substitution:
            # unreadable. So `python3 "$SCRIPT" a -c b` is reported too (fail closed).
            return UNMEASURED if C_OPTION.match(raw) or later_c(text, i) else NO_C
        if value.startswith("--"):
            if value in LONG_WITH_ARG:
                nxt = next_word(text, i)
                if nxt is None:
                    return NO_C
                i = nxt[2]
            continue
        if not value.startswith("-") or value == "-":
            return NO_C  # a script, `-` (stdin): the options ended without a -c
        letters = value[1:]
        for n, ch in enumerate(letters):
            if ch in NOARG:
                continue
            rest = letters[n + 1:]
            if ch == "c":
                return body_of(text, i) if not rest else rest
            if ch in "XW":
                if not rest:  # `-X utf8`, `-W 'ignore'`: the argument is the next word
                    nxt = next_word(text, i)
                    if nxt is None:
                        return NO_C
                    i = nxt[2]
                break
            if ch == "m":
                return NO_C
            # a letter python does not have: what follows is not read as python's
            return UNMEASURED if "c" in rest or later_c(text, i) else NO_C


def body_of(text, i):
    w = next_word(text, i)
    if w is None or w[0] is None:
        return UNMEASURED
    value, raw, _, expands = w
    if not expands:
        return value
    m = TRACED_VAR.match(raw)
    if m:  # `-c "$SRC"`: measure the heredoc that fills SRC
        body = heredoc_var(text, m.group(1))
        return UNMEASURED if body is None else body
    if not raw.startswith('"') and not raw.startswith("'"):
        return UNMEASURED  # unquoted `$SRC`: split into words, never measured
    rest = PLAIN_EXPANSION.sub("", value)
    if not rest.strip() or EXPANSION.search(rest):
        return UNMEASURED  # `"$1"`, `"${V:-}"`, `"$A$B"`: the body is values nobody knows
    for name in PLAIN_EXPANSION.findall(value):
        if heredoc_var(text, name.strip("${}")) is not None:
            return UNMEASURED  # `-c "import sys; $SRC"`: a program spliced in (CR3-L-4)
    return value


def interpreters(text):
    """Yield (start, line, result) for every interpreter word pass 1 reads, outside a
    comment line. result: a body, UNMEASURED, or NO_C."""
    seen = set()
    candidates = sorted({m.start() for m in PY_NAME.finditer(text)}
                        | {m.start() for m in re.finditer(r"\$", text)})
    for k in candidates:
        start = word_start(text, k)
        if start in seen:
            continue
        seen.add(start)
        line_start = text.rfind("\n", 0, start) + 1
        if text[line_start:start].lstrip().startswith("#"):
            continue
        value, end, expands = bash_word(text, start)
        raw = text[start:end]
        if raw.startswith("#"):
            continue
        if PY_WORD.search(raw.strip("\"'").rstrip("}")):
            dynamic = value is None or expands  # `"$HOME/bin/python3"`, `${PY:-python3}`
        else:
            v = VAR_START.match(raw)
            if not v or v.group(1) in SHELL_VARS or not command_position(text, start):
                continue  # `grep "$PAT" -c "$FILE"`: $PAT is not the command
            dynamic = True
        result = c_body(text, end)
        if dynamic and result is not NO_C:
            result = UNMEASURED
        yield start, text.count("\n", 0, start) + 1, result


def commands(text):
    """Yield each simple command as a list of (start, raw, value) words. Heredoc
    bodies and comments are not commands; a `$(...)` stays inside its word."""
    i, n, seg, heredocs = 0, len(text), [], []
    while i < n:
        c = text[i]
        if text.startswith("\\\n", i):
            i += 2
        elif c in " \t":
            i += 1
        elif c == "\n":
            if seg:
                yield seg
                seg = []
            i += 1
            for tag, strip, at in heredocs:
                while i < n:
                    j = text.find("\n", i)
                    j = n if j == -1 else j
                    line, i = text[i:j], j + 1
                    if (line.lstrip("\t") if strip else line) == tag:
                        break
                else:  # never closed (`(( a << 2 ))` read as a heredoc): the rest is unread
                    yield [(at, UNREADABLE, None)]
                    return
            heredocs = []
        elif c in ";|&()":
            if seg:
                yield seg
                seg = []
            i += 1
        elif c == "#":
            j = text.find("\n", i)
            i = n if j == -1 else j
        elif text.startswith("<<<", i):
            i += 3
        elif HEREDOC.match(text, i):
            m = HEREDOC.match(text, i)
            value, end, _ = bash_word(text, m.end())
            if value:
                heredocs.append((value, m.group(1) == "-", i))
            i = max(end, m.end())
        elif c in "<>":
            i += 1
        else:
            value, end, _ = bash_word(text, i)
            if end == i:
                i += 1
                continue
            if end >= n and "\n" in text[i:end].rstrip("\n"):
                # A quote or `$(` that never closed swallowed the rest of the file
                # (CR3-L-3: an apostrophe in a heredoc inside `$(...)`): unread, so
                # UNMEASURED. shortcut: a mis-pairing that resyncs before the end is
                # not detected; make skip_subst heredoc-aware if a hook hits one.
                yield seg + [(i, UNREADABLE, None)]
                return
            seg.append((i, text[i:end], value))
            i = end
    if seg:
        yield seg


def python_like(raw):
    base = re.split(r"[/\\]", raw.strip("\"'"))[-1]
    return "python" in raw.lower() or bool(PY_LIKE_BASE.match(base) or PY_LIKE_VAR.search(raw))


def catch_all(text, read_starts):
    """Yield the line of every command with a python-like word before a -c word in
    which pass 1 read no interpreter."""
    for seg in commands(text):
        if seg[-1][1] is UNREADABLE:
            yield text.count("\n", 0, seg[-1][0]) + 1
            continue
        if any(start in read_starts for start, _, _ in seg):
            continue
        names = [v if v is not None else r for _, r, v in seg]
        # the command word: past assignments and keywords (`then sudo`, `if ! timeout`)
        cmd_k = next((k for k, w in enumerate(names)
                      if not ASSIGNMENT.match(w) and w not in PREFIX_WORDS - WRAPPERS), 0)
        cmd = re.split(r"[/\\]", names[cmd_k])[-1]
        wrapper = cmd in WRAPPERS
        for k, (start, raw, _) in enumerate(seg):
            v = VAR_START.match(raw)
            variable = v is not None and v.group(1) not in SHELL_VARS
            # `timeout 5 "$INTERP" -c`: a variable may be any interpreter (CR3-L-2)
            if not (python_like(raw) or (variable and (wrapper or k == cmd_k))):
                continue
            if k and names[k - 1].startswith("-") and names[k - 1] != "--" and cmd in NON_WRAPPERS:
                # `git -C "$PYDIR" -c x=y`: the argument of an option, not the command.
                # Only for commands known not to run another one: an unknown command
                # (`strace -f "$PY" -c`, `firejail -q "$PY" -c`) stays fail closed.
                continue
            if any(C_WORD.match(w) for w in names[k + 1:]):
                yield text.count("\n", 0, start) + 1
            break


def bodies(text):
    """Yield (line, body) for every -c body; body None = unmeasured."""
    read_starts = set()
    found = []
    for start, line_no, result in interpreters(text):
        read_starts.add(start)
        if result is not NO_C:
            found.append((line_no, None if result is UNMEASURED else result))
    found += [(line_no, None) for line_no in catch_all(text, read_starts)]
    return sorted(found, key=lambda r: r[0])


def units(s):
    return len(s.encode("utf-16-le")) // 2


def main():
    if not os.path.isdir(HOOKS):
        print("FAIL: %s not found - nothing was measured" % HOOKS)
        return 1
    rows, violations = [], 0
    for root, _, files in os.walk(HOOKS):
        for name in sorted(files):
            if not name.endswith(".sh"):
                continue
            path = os.path.join(root, name)
            rel = os.path.relpath(path, REPO_ROOT).replace(os.sep, "/")
            with open(path, encoding="utf-8") as f:
                text = f.read().replace("\r\n", "\n")
            for line_no, body in bodies(text):
                if body is None:
                    rows.append((rel, line_no, "unmeasured"))
                    violations += 1
                    continue
                n = units(body)
                rows.append((rel, line_no, n))
                if n > BUDGET:
                    violations += 1
    for rel, line_no, n in sorted(rows, key=lambda r: (r[0], r[1])):
        status = "UNMEASURED" if n == "unmeasured" else ("OVER" if n > BUDGET else "ok")
        print("%-60s line %-5d %8s  %s" % (rel, line_no, n, status))
    print()
    print("Inline python3 -c bodies measured: %d" % len(rows))
    print("Violations found:              %d" % violations)
    if not rows:
        print("FAIL: no inline python3 -c body found at all - the scan read nothing")
        return 1
    if violations:
        print(
            "FAIL: a hook passes python3 an inline -c body over budget or one this guard "
            "cannot measure (budget %d, Windows command-line cap %d). On Windows it fails "
            "with \"Argument list too long\" (rc 126). Move the body into "
            ".claude/hooks/lib/<name>.py and run it as `python3 -I -B <file>`." % (BUDGET, HARD_CAP)
        )
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
