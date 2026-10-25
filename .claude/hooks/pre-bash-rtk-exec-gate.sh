#!/bin/bash
# ECC stable id: pre:bash:rtk-exec-gate
#
# Purpose: close the whole class of "run a command THROUGH rtk" (SR-H-1, SR-H-3, SR-H-4, SR-H-5, SR-M-4,
# SR-M-5, SR-M-6 on PR #1157). rtk has subcommands that execute their operand themselves: bypass (alias
# proxy), err, test, run, summary — the operand may be a quoted string that rtk splits or hands to `sh -c`.
# Four review rounds kept finding one more quoting form that some guard did not look inside, because the
# guards decide on the command word and each guard splits and unquotes differently. Parsing every form in
# every guard is a losing game; refusing the form in ONE place is not. Nothing in the project needs it:
#   * filtered output   -> just run the command; pre:bash:rtk-rewrite adds `rtk` for you (the rewrite only
#                          ever produces TOOL subcommands: rtk git ..., rtk pnpm ..., rtk grep ...)
#   * unfiltered output -> prefix the command with RTK_DISABLED=1, e.g. `RTK_DISABLED=1 git diff`
#
# Decided on the RAW command text, after one NORMALISATION step that removes what the shell removes when it
# builds a word: quote characters, backslashes and the `$` of an ANSI-C `$'...'` string. So `byp''ass`,
# `te\st`, `"te"st`, `$'bypass'` and a split `r''tk` all read as the plain word they become. The word after
# `rtk` (and its flags) is refused when it is an exec subcommand, OR when it is not a literal word at all
# (contains { } $ ` * ?: brace expansion, command substitution, a variable) because then nobody can say what
# rtk will run. The cost is a false positive when TEXT merely mentions e.g. `rtk test` in an echo or a commit
# message; the block message says how to rephrase.
# Known limit, shared by every guard in this directory (see cmdscan.py): the binary or the subcommand rebuilt
# in a variable or assembled by a script. This closes the typed forms.
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
# what the shell strips when it builds a word: the $ of $x27...x27, quotes, backslashes
norm = re.sub(r"\$(?=[\x27\x22])", "", cmd)
norm = re.sub(r"[\\\x27\x22]", "", norm)
gap = r"\s+"
flags = r"(?:" + gap + r"-{1,2}[\w-]+(?:=\S+)?)*"
word = r"(?:(?:bypass|proxy|err|test|run|summary)(?![\w-])|[^\s;&|]*[{}$`*?][^\s;&|]*)"
pat = re.compile(r"(?<![\w.-])(?:[\w./~$-]*/)?rtk" + flags + gap + word)
m = pat.search(norm)
if m:
    print(m.group(0).strip())
' 2>/dev/null) || exit 0

[ -n "$HIT" ] || exit 0

MSG="BLOCKED (pre:bash:rtk-exec-gate): '${HIT}' runs its operand through rtk, outside the view of the other pre:bash guards. Run the command directly: pre:bash:rtk-rewrite already filters its output. For UNFILTERED output prefix it with RTK_DISABLED=1 (e.g. RTK_DISABLED=1 git diff). If you only mention this text in a message or comment, rephrase it so the words rtk and run/test/err/summary/bypass/proxy are not adjacent."
printf '%s' "$MSG" | python3 -I -c 'import json,sys; print(json.dumps({"decision": "block", "reason": sys.stdin.read()}))'
exit 2
