#!/usr/bin/env python3
"""check-hook-inline-python-size.py - no hook passes python3 a -c body near the Windows limit.

Windows CreateProcess caps a WHOLE command line at 32767 UTF-16 code units. Git Bash
launches the native python3.exe through it, so a hook that hands python3 a large
inline program (`python3 -c '<body>'`) fails to start with "Argument list too long",
and bash reports rc 126. Linux allows 128 KiB per argument, so every test on CI stays
green while the hook is dead on every Windows machine. On 2026-11-11 the analyzer of
pre-bash-cross-agent-blast.sh reached 44186 characters, its fail-closed branch turned
rc 126 into a refusal, and every Bash call on Windows was refused.

This guard measures every `python3 -c` / `python -c` body in .claude/hooks/**/*.sh,
as the whole shell word bash passes (quote splices included), and fails when one
exceeds BUDGET. The budget sits well under
the hard cap, because the rest of the command line (interpreter path, flags, other
arguments) shares the same 32767. The fix it asks for is the one the hooks already
use: put the program in .claude/hooks/lib/<name>.py and run `python3 -I -B <file>`.

A body passed as a variable (`-c "$SRC"`) is measured through the heredoc that fills
it (`read -r -d '' SRC <<'PY'`, as pre-bash-unbounded-wait.sh does). A variable the
guard cannot trace to such a heredoc is a violation, not a pass: an unmeasured body
is not a small one.
"""

import os
import re
import sys

BUDGET = 24000  # UTF-16 code units, the unit of the Windows limit
HARD_CAP = 32767

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
HOOKS = os.path.join(REPO_ROOT, ".claude", "hooks")

# `python3`, optional flags (possibly over a line continuation), then `-c` and the
# opening quote of its argument.
OPEN = re.compile(r"\bpython3?(?:(?:\s|\\\n)+-[A-Za-z]+)*?(?:\s|\\\n)+-c(?:\s|\\\n)+(['\"])")
VAR_REF = re.compile(r"^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$")


def heredoc_var(text, name):
    """The body of `read -r -d '' NAME <<'TAG' ... TAG`, or None when there is none."""
    m = re.search(
        r"read\s+-r\s+-d\s+''\s+%s\s+<<-?\s*(['\"]?)(\w+)\1[^\n]*\n(.*?)\n\2\n" % re.escape(name),
        text,
        re.S,
    )
    return m.group(3) if m else None


def bash_word(text, i):
    """(value, end) of the shell word starting at text[i], as bash builds it: quoted
    segments run together (`'a'"b"'c'` is one word, and a hook that splices a quote
    into a single-quoted body as `'\\''` has a body longer than its first segment).
    An expansion is counted as its own text (shortcut: its value is unknown, fine
    while hook bodies only expand short names). value is None when a quote never closes."""
    out = []
    while i < len(text):
        c = text[i]
        if c == "'":
            j = text.find("'", i + 1)
            if j == -1:
                return None, len(text)
            out.append(text[i + 1:j])
            i = j + 1
        elif c == '"':
            i += 1
            while i < len(text) and text[i] != '"':
                if text[i] == "\\" and text[i + 1:i + 2] in ('\\', '"', '$', '`', '\n'):
                    out.append("" if text[i + 1] == "\n" else text[i + 1])
                    i += 2
                else:
                    out.append(text[i])
                    i += 1
            if i >= len(text):
                return None, len(text)
            i += 1
        elif c == "\\":
            out.append("" if text[i + 1:i + 2] == "\n" else text[i + 1:i + 2])
            i += 2
        elif c in " \t\n;|&()<>":
            break
        else:
            out.append(c)
            i += 1
    return "".join(out), i


def bodies(text):
    """Yield (line, body) for every -c body outside a comment line; body None = unmeasured."""
    pos = 0
    while True:
        m = OPEN.search(text, pos)
        if not m:
            return
        line_start = text.rfind("\n", 0, m.start()) + 1
        line_no = text.count("\n", 0, m.start()) + 1
        if text[line_start:m.start()].lstrip().startswith("#"):
            pos = m.end()
            continue
        body, end = bash_word(text, m.end() - 1)
        if body is not None and m.group(1) == '"' and VAR_REF.match(text[m.end():end - 1]):
            # `-c "$SRC"`: measure the heredoc that fills SRC. None: untraceable, reported.
            body = heredoc_var(text, VAR_REF.match(text[m.end():end - 1]).group(1))
        # An unterminated or untraceable body is not a small body: report it, never skip it.
        yield line_no, body
        pos = max(end, m.end())


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
            "FAIL: a hook passes python3 an inline -c body over budget (budget %d, Windows "
            "command-line cap %d). On Windows it fails with \"Argument list too long\" "
            "(rc 126). Move the body into .claude/hooks/lib/<name>.py and run it as "
            "`python3 -I -B <file>`." % (BUDGET, HARD_CAP)
        )
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
