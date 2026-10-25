#!/bin/bash
# ECC stable id: pre:bash:rtk-exec-gate
#
# Purpose: close the whole class of "run a command THROUGH rtk" (SR-H-1, SR-H-3, SR-H-4, SR-H-5, SR-M-4,
# SR-M-5, SR-M-6, SR-M-7, SR-M-8 on PR #1157). rtk has subcommands that execute their operand themselves:
# bypass (alias proxy), err, test, run, summary — the operand may be a quoted string that rtk splits or hands
# to `sh -c`. Five review rounds kept finding one more spelling that some guard did not look inside, because
# the guards decide on the command word and each guard splits and unquotes differently. Parsing every form in
# every guard is a losing game; refusing the form in ONE place is not. Nothing in the project needs it:
#   * filtered output   -> just run the command; pre:bash:rtk-rewrite adds `rtk` for you (the rewrite only
#                          ever produces TOOL subcommands: rtk git ..., rtk pnpm ..., rtk grep ...)
#   * unfiltered output -> prefix the command with RTK_DISABLED=1, e.g. `RTK_DISABLED=1 git diff`
#
# Decided on the RAW command text, after one NORMALISATION step that does what the shell does when it builds
# a word: it deletes backslash-newline continuations, DECODES ANSI-C strings ($'\x62ypass' -> bypass; an
# undecodable body becomes a `$`, which trips the non-literal rule), then drops the remaining quote characters
# and backslashes. So `byp''ass`, `te\st`, `"te"st`, `$'bypass'`, `$'\x62ypass'`, `byp\<NL>ass` and a split
# `r''tk` all read as the plain word they become. After that:
#   1. the word after `rtk` (+ flags) is an exec subcommand            -> refused anywhere in the text;
#   2. the binary is in COMMAND POSITION (line start, after ; & | ( { or after then/do/else/time/env/sudo/
#      command/exec/nohup/xargs/eval) and the word after it is not a literal word (contains { } $ ` * ?)
#      -> refused, because nobody can say what rtk would run. Not applied to mere mentions such as
#      `grep -rn rtk $DIR` or a commit message with `$(date)`: the binary is not in command position there.
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
import codecs, json, re, sys
try:
    cmd = json.load(sys.stdin)["tool_input"]["command"]
except Exception:
    sys.exit(0)

def ansi_c(m):
    try:
        return codecs.decode(m.group(1).encode("latin-1", "ignore"), "unicode_escape")
    except Exception:
        return "$"

norm = cmd.replace("\\\n", "")
norm = re.sub(r"\$\x27((?:[^\x27\\]|\\.)*)\x27", ansi_c, norm, flags=re.S)
norm = re.sub(r"\$(?=[\x27\x22])", "", norm)
norm = re.sub(r"[\\\x27\x22]", "", norm)

gap = r"\s+"
flags = r"(?:" + gap + r"-{1,2}[\w-]+(?:=\S+)?)*"
binary = r"(?<![\w.-])(?:[\w./~$-]*/)?rtk"
exec_word = r"(?:bypass|proxy|err|test|run|summary)(?![\w-])"
nonlit = r"[^\s;&|]*[{}$`*?][^\s;&|]*"
cmdpos = r"(?:^|[;&|({\n]|\b(?:then|do|else|time|env|sudo|command|exec|nohup|xargs|eval)\s)\s*"

pat_exec = re.compile(binary + flags + gap + exec_word)
pat_nonlit = re.compile(cmdpos + binary + flags + gap + nonlit, re.M)
m = pat_exec.search(norm) or pat_nonlit.search(norm)
if m:
    print(m.group(0).strip(" ;&|({\n"))
' 2>/dev/null) || exit 0

[ -n "$HIT" ] || exit 0

MSG="BLOCKED (pre:bash:rtk-exec-gate): '${HIT}' runs its operand through rtk, outside the view of the other pre:bash guards (or puts a glob, variable or command substitution where rtk expects its subcommand, so nobody can say what would run). Run the command directly: pre:bash:rtk-rewrite already filters its output. For UNFILTERED output prefix it with RTK_DISABLED=1 (e.g. RTK_DISABLED=1 git diff). If you only mention this text in a message or comment, rephrase it so the words rtk and run/test/err/summary/bypass/proxy are not adjacent."
printf '%s' "$MSG" | python3 -I -c 'import json,sys; print(json.dumps({"decision": "block", "reason": sys.stdin.read()}))'
exit 2
