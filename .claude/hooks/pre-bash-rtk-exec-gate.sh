#!/bin/bash
# ECC stable id: pre:bash:rtk-exec-gate
#
# Purpose: close the whole class of "run a command THROUGH rtk" (SR-H-1, SR-H-3, SR-H-4, SR-H-5, SR-M-4,
# SR-M-5, SR-M-6 .. SR-M-12 on PR #1157). rtk has subcommands that execute their operand themselves:
# bypass (alias proxy), err, test, run, summary — the operand may be a quoted string that rtk splits or hands
# to `sh -c`. Several review rounds kept finding one more spelling that some guard did not look inside,
# because the guards decide on the command word and each guard splits and unquotes differently. Parsing every
# form in every guard is a losing game; refusing the form in ONE place is not. Nothing in the project needs it:
#   * filtered output   -> just run the command; pre:bash:rtk-rewrite adds `rtk` for you (the rewrite only
#                          ever produces TOOL subcommands: rtk git ..., rtk pnpm ..., rtk grep ...)
#   * unfiltered output -> prefix the command with RTK_DISABLED=1, e.g. `RTK_DISABLED=1 git diff`
#
# Decided on the RAW command text, after one NORMALISATION step that does what the shell does when it builds
# a word: it deletes backslash-newline continuations, DECODES ANSI-C strings with BASH semantics ($'\x62ypass',
# \u with 1-4 hex digits, \U with 1-8, octal, \x with 1-2; an escape bash would not decode is kept as text),
# then drops the remaining quote characters and backslashes. Whitespace runs are collapsed first so that no
# regex below can go quadratic on padding. So `byp''ass`, `te\st`, `"te"st`, `$'bypass'`, `$'\x62ypass'`,
# `$'\u62'ypass`, `byp\<NL>ass` and a split `r''tk` all read as the plain word they become. After that:
#   1. the word after `rtk` (+ flags) is an exec subcommand            -> refused anywhere in the text;
#   2. the binary is in COMMAND POSITION and the word after it is not a literal word (contains { } $ ` * ?)
#      -> refused, because nobody can say what rtk would run. Command position = line start, after ; & | ( {
#      newline, after then/do/else, after `-c` / `-lc` (a nested shell string), and after any run of leading
#      VAR=value assignments, `!` and wrappers (time env sudo doas command exec nohup xargs nice ionice
#      timeout stdbuf setsid eval unbuffer watch, with their flags, a flag's value and a numeric duration).
#      Not applied to mere mentions such as `grep -rn rtk $DIR` or a commit message with `$(date)`: the binary
#      is not in command position there.
# The cost of rule 1 is a false positive when TEXT mentions e.g. `rtk test` in an echo or a commit message;
# the block message says how to rephrase.
# Known limits, shared by every guard in this directory (see cmdscan.py): the binary or the subcommand rebuilt
# in a variable or assembled by a script; a GLOB in the binary word (r?k); a copy or symlink of the binary
# under another name (needs a file the attacker created first). This closes the typed forms.
#
# Contract: exit 0 = allow; exit 2 + {"decision":"block","reason":...} on stdout = refuse. It never
# crashes into a block: any internal failure exits 0 (fail-open) — the other guards still run.
# Test: scripts/devops/tests/test-pre-bash-rtk-exec-gate.sh
# Rationale: docs/architecture/rules-rationale/token-economy.md

INPUT=$(cat)
HIT=$(printf '%s' "$INPUT" | python3 -I -c '
import json, re, sys
try:
    cmd = json.load(sys.stdin)["tool_input"]["command"]
except Exception:
    sys.exit(0)
if not isinstance(cmd, str):
    sys.exit(0)

SIMPLE = {"a": "\a", "b": "\b", "e": "\x1b", "E": "\x1b", "f": "\f", "n": "\n", "r": "\r", "t": "\t",
          "v": "\v", "\\": "\\", "\x27": "\x27", "\x22": "\x22", "?": "?"}
HEX = "0123456789abcdefABCDEF"

def take(body, i, digits, limit):
    j = i
    while j < len(body) and j - i < limit and body[j] in digits:
        j += 1
    return body[i:j], j

def ansi_c(m):
    # bash semantics for $x27...x27 strings; an escape bash does not decode stays as text. Never raises, and
    # never drops the body (the match has no quoting context: dropping it could erase a real command).
    body = m.group(1)
    try:
        out, i = [], 0
        while i < len(body):
            ch = body[i]
            if ch != "\\" or i + 1 >= len(body):
                out.append(ch)
                i += 1
                continue
            n = body[i + 1]
            if n in SIMPLE:
                out.append(SIMPLE[n])
                i += 2
            elif n in "xuU":
                digs, j = take(body, i + 2, HEX, {"x": 2, "u": 4, "U": 8}[n])
                if digs:
                    out.append(chr(int(digs, 16)) if int(digs, 16) <= 0x10FFFF else "$")
                    i = j
                else:
                    out.append("\\" + n)
                    i += 2
            elif n in "01234567":
                digs, j = take(body, i + 1, "01234567", 3)
                out.append(chr(int(digs, 8) & 0xFF))
                i = j
            elif n == "c" and i + 2 < len(body):
                out.append(chr(ord(body[i + 2]) & 0x1F))
                i += 3
            else:
                out.append("\\" + n)
                i += 2
        return "".join(out)
    except Exception:
        return "$" + body

norm = cmd.replace("\\\n", "")
norm = re.sub(r"[ \t\r\f\v]+", " ", norm)
norm = re.sub(r"\s*\n\s*", "\n", norm)
norm = re.sub(r"\$\x27((?:[^\x27\\]|\\.)*)\x27", ansi_c, norm, flags=re.S)
norm = re.sub(r"\$(?=[\x27\x22])", "", norm)
norm = re.sub(r"[\\\x27\x22]", "", norm)
norm = re.sub(r"[ \t\r\f\v]+", " ", norm)

gap = r"\s+"
flags = r"(?:" + gap + r"-{1,2}[\w-]+(?:=\S+)?)*"
binary = r"(?<![\w.~$/-])(?:[\w./~$-]*/)?rtk"
exec_word = r"(?:bypass|proxy|err|test|run|summary)(?![\w-])"
nonlit = r"[^\s;&|]*[{}$`*?][^\s;&|]*"
wrapper = r"(?:time|env|sudo|doas|command|exec|nohup|xargs|nice|ionice|timeout|stdbuf|setsid|eval|unbuffer|watch)"
wflag = r"\s+-{1,2}[\w-]+(?:=\S+)?(?:\s+(?!rtk\b)[\w.@:/-]+)?"
cmdpos = (
    r"(?:^|[;&|({\n]|\b(?:then|do|else)\b|\s-l?c\s)\s*"
    r"(?:(?:\w+=\S*|!|" + wrapper + r"(?:" + wflag + r"|\s+\d+[smhd]?)*)\s+)*"
)

pat_exec = re.compile(binary + flags + gap + exec_word)
pat_nonlit = re.compile(cmdpos + binary + flags + gap + nonlit, re.M)
m = pat_exec.search(norm) or pat_nonlit.search(norm)
if m:
    hit = m.group(0).strip(" ;&|({\n")
    # ascii only: a lone surrogate must not crash the print and turn the gate fail-open
    sys.stdout.write(hit.encode("ascii", "backslashreplace").decode("ascii"))
' 2>/dev/null) || exit 0

[ -n "$HIT" ] || exit 0

MSG="BLOCKED (pre:bash:rtk-exec-gate): '${HIT}' runs its operand through rtk, outside the view of the other pre:bash guards (or puts a glob, variable or command substitution where rtk expects its subcommand, so nobody can say what would run: write a literal tool subcommand, or just run the command without rtk). Run the command directly: pre:bash:rtk-rewrite already filters its output. For UNFILTERED output prefix it with RTK_DISABLED=1 (e.g. RTK_DISABLED=1 git diff). If you only mention this text in a message or comment, rephrase it so the words rtk and run/test/err/summary/bypass/proxy are not adjacent."
printf '%s' "$MSG" | python3 -I -c 'import json,sys; print(json.dumps({"decision": "block", "reason": sys.stdin.read()}))'
exit 2
