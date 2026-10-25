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
# \u with 1-4 hex digits, \U with 1-8, octal, \x with 1-2; an escape bash would not decode is kept as text;
# the string is cut at the first NUL as bash does; a code point above 0x10FFFF becomes `$`, and `\c?` gives
# 0x1f where bash gives 0x7f — both only ever cause an extra refusal, never hide a word),
# then drops the remaining quote characters and backslashes, turns $IFS / ${IFS} / $IFS$9 into a space and
# deletes redirections (2>/dev/null, >&2, <&-, {fd}>f ...) that may sit between the binary and its subcommand.
# Whitespace runs are collapsed so that no regex below can go quadratic on padding, and the command-position
# prefix is written with DISJOINT alternatives so it cannot backtrack exponentially either (both pinned by the
# timing row in the test). A binary glued to an expansion (rtk$X, rtk followed by a backtick) is refused too. So `byp''ass`, `te\st`, `"te"st`, `$'bypass'`, `$'\x62ypass'`,
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
# Known limits, shared by every guard in this directory (see cmdscan.py) and ACCEPTED by the owner on
# 2026-10-25 (list in the rationale file): the binary or the subcommand rebuilt in a variable, a command
# substitution, an alias/function or a script; a GLOB in the binary word (r?k); a copy or symlink of the
# binary under another name; payloads outside the shell word model (sh -c "$VAR", eval "$(...)", base64 | sh);
# command-position gaps for rare syntax (case arms, if/while conditions, find -exec, flock, coproc ...).
# The binary is installed OUTSIDE PATH (scripts/devops/install-rtk.sh), so a bare typed `rtk ...` is
# "command not found" for an agent; this gate is the second layer, not the only one.
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
        res = "".join(out)
        # bash cuts an ANSI-C string at the first NUL ($x27by\0pass x27 is "by", $x27\0x27 is empty), so
        # the word around it is rebuilt; keeping the NUL would hide an exec word that bash reassembles
        cut = res.find("\x00")
        return res if cut < 0 else res[:cut]
    except Exception:
        return "$" + body

Q1 = "\x27"
Q2 = "\x22"
OPS = re.compile(r"(?:&>>?|[<>]&|<<<|<<?|>>?\|?)")
FDVAR = re.compile(r"\{\w+\}")

def skip_quoted(s, i):
    # end index of the quoted region that starts at s[i] (single, double or ANSI-C dollar-single quote)
    n = len(s)
    if s[i] == Q1:
        k = s.find(Q1, i + 1)
        return n if k < 0 else k + 1
    k = i + (2 if s[i] == "$" else 1)
    end = Q1 if s[i] == "$" else Q2
    while k < n and s[k] != end:
        k += 2 if s[k] == "\\" else 1
    return min(n, k + 1)

def skip_word(s, j):
    # one shell word from s[j], quote aware, stopping at unquoted whitespace or a metacharacter
    n = len(s)
    while j < n:
        c = s[j]
        if c == "\\" and j + 1 < n:
            j += 2
        elif c in (Q1, Q2) or (c == "$" and j + 1 < n and s[j + 1] == Q1):
            j = skip_quoted(s, j)
        elif c in " \t\n;&|()<>":
            break
        else:
            j += 1
    return j

def strip_redirects(s):
    # Delete redirections WITH their target word, honouring quotes: an operator inside quotes is text, and
    # a quoted/escaped/ANSI-C target that contains a space is ONE word (SR-H-13, SR-H-16). A regex on raw
    # text cannot do this: a quote opened in a decoy can swallow the real command up to a later quote.
    out, i, n = [], 0, len(s)
    while i < n:
        c = s[i]
        if c == "\\" and i + 1 < n:
            out.append(s[i:i + 2])
            i += 2
        elif c in (Q1, Q2) or (c == "$" and i + 1 < n and s[i + 1] == Q1):
            k = skip_quoted(s, i)
            out.append(s[i:k])
            i = k
        elif c in "0123456789{&<>":
            # fd prefix first: a WHOLE digit run (or a {name}), never re-scanned character by character
            # (a run of N digits with no operator after it was O(N^2), SR-H-17)
            j = i
            if c in "0123456789":
                while j < n and s[j] in "0123456789":
                    j += 1
            elif c == "{":
                mf = FDVAR.match(s, i)
                if mf is not None:
                    j = mf.end()
            m = OPS.match(s, j)
            if m is None:
                k = max(j, i + 1)
                out.append(s[i:k])
                i = k
                continue
            j = m.end()
            while j < n and s[j] in " \t":
                j += 1
            j = skip_word(s, j)
            out.append(" ")
            i = max(j, m.end())
        else:
            out.append(c)
            i += 1
    return "".join(out)

norm = cmd.replace("\\\n", "")
norm = strip_redirects(norm)
norm = re.sub(r"[ \t\r\f\v]+", " ", norm)
norm = re.sub(r"\s*\n\s*", "\n", norm)
norm = re.sub(r"\$\x27((?:[^\x27\\]|\\.)*)\x27", ansi_c, norm, flags=re.S)
norm = re.sub(r"\$(?=[\x27\x22])", "", norm)
norm = re.sub(r"[\\\x27\x22]", "", norm)
# $IFS (and the $IFS$9 idiom) is a word separator the shell expands to whitespace (SR-H-14)
norm = re.sub(r"\$\{?IFS\}?(?:\$\{?[0-9@*]\}?)*", " ", norm)
norm = re.sub(r"[ \t\r\f\v]+", " ", norm)

gap = r"\s+"
flags = r"(?:" + gap + r"--?(?:\w[\w-]*)?(?:=\S+)?)*"
binary = r"(?<![\w.~$/-])(?:[\w./~$-]*/)?rtk"
# `init` is not an exec subcommand but it rewrites the agent settings of the tool itself (it installs a second hook
# next to ours); an agent has no reason to run it, so it is refused with the exec words (hardening, SR round 8)
exec_word = r"(?:bypass|proxy|err|test|run|summary|init)(?![\w-])"
nonlit = r"[^\s;&|]*[{}$`*?][^\s;&|]*"
wrapper = r"(?:time|env|sudo|doas|command|exec|nohup|xargs|nice|ionice|timeout|stdbuf|setsid|eval|unbuffer|watch)"
# The alternatives below are DISJOINT on purpose (SR-M-13): a flag value never matches a bare duration
# (`-n 5` parses one way only), and an assignment value stops at a separator, so no input can make the
# prefix backtrack exponentially or quadratically.
wflag = (
    r"\s+--?(?:\w[\w-]*)?(?:=\S+)?"
    r"(?:\s+(?!-)(?!rtk\b)(?!" + wrapper + r"\b)(?!\d+[smhd]?(?:\s|$))[\w.@:/][\w.@:/-]*)?"
)
# DISJOINT alternatives (CR-H-2, round 7: both of these were exponential): the flag value cannot start
# with `-` (it would also parse as the next flag), cannot be a bare duration (`-n 5` parses one way only:
# the 5 is the duration) and cannot be a wrapper word; the duration (`timeout 5 cmd`) is ONE optional item
# after the flags. Consequence, accepted: a SECOND numeric flag value (`nice -n 5 -n 5 rtk $X`) is not
# followed.
cmdpos = (
    r"(?:^|[;&|({)\x60\n]|\b(?:then|do|else)\b|\s-\w*c\s)\s*"
    r"(?:(?:\w+=[^\s;&|]*|!|" + wrapper + r"(?:" + wflag + r")*(?:\s+\d+[smhd]?)*)\s+)*"
)

pat_exec = re.compile(binary + flags + gap + exec_word)
pat_nonlit = re.compile(cmdpos + binary + flags + gap + nonlit, re.M)
# the binary glued to an expansion with no whitespace (rtk$X, rtk`cmd`) is as unreadable as a non-literal word
pat_glue = re.compile(cmdpos + binary + r"[$`]", re.M)
m = pat_exec.search(norm) or pat_nonlit.search(norm) or pat_glue.search(norm)
if m:
    hit = m.group(0).strip(" ;&|({\n")
    # ascii only: a lone surrogate must not crash the print and turn the gate fail-open
    sys.stdout.write(hit.encode("ascii", "backslashreplace").decode("ascii"))
' 2>/dev/null) || exit 0

[ -n "$HIT" ] || exit 0

MSG="BLOCKED (pre:bash:rtk-exec-gate): '${HIT}' runs its operand through rtk, outside the view of the other pre:bash guards (or puts a glob, variable or command substitution where rtk expects its subcommand, so nobody can say what would run: write a literal tool subcommand, or just run the command without rtk). Run the command directly: pre:bash:rtk-rewrite already filters its output. For UNFILTERED output prefix it with RTK_DISABLED=1 (e.g. RTK_DISABLED=1 git diff). If you only mention this text in a message or comment, rephrase it so the words rtk and run/test/err/summary/bypass/proxy are not adjacent."
printf '%s' "$MSG" | python3 -I -c 'import json,sys; print(json.dumps({"decision": "block", "reason": sys.stdin.read()}))'
exit 2
