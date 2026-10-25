#!/bin/bash
# ECC stable id: pre:bash:rtk-exec-gate
#
# Purpose: close the whole class of "run a command THROUGH rtk" (SR-H-1, SR-H-3, SR-H-4, SR-M-4, SR-M-5 on
# PR #1157). rtk has subcommands that execute their operand themselves: bypass (alias proxy), err, test,
# run, summary — the operand may be a quoted string that rtk splits or hands to `sh -c`. Four review
# rounds kept finding one more quoting form that some guard did not look inside, because the guards
# decide on the command word and each guard splits and unquotes differently. Parsing every form is a
# losing game; refusing the form is not. Nothing in the project needs it:
#   * filtered output   -> just run the command; pre:bash:rtk-rewrite adds `rtk` for you (rewrite only
#                          ever produces TOOL subcommands: rtk git ..., rtk pnpm ..., rtk grep ...)
#   * unfiltered output -> prefix the command with RTK_DISABLED=1, e.g. `RTK_DISABLED=1 git diff`
#
# Decided on the RAW command text, not on a parsed command word, so quoting cannot hide it. The cost is
# a false positive when the text merely MENTIONS e.g. `rtk test` in an echo or a commit message; the block
# message says how to rephrase. rtk reached through a variable or a rebuilt string is the same
# non-expansion limit every guard in this directory has (see cmdscan.py) — this closes the typed forms.
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
gap = r"(?:\s|\\\n)+"
pat = re.compile(r"(?<![\w.-])(?:[\w./~$-]*/)?rtk[\x27\x22]*(?:" + gap + r"-{1,2}[\w-]+(?:=\S+)?)*" + gap + r"[\x27\x22]*(?:bypass|proxy|err|test|run|summary)(?![\w-])")
m = pat.search(cmd)
if m:
    print(m.group(0).strip())
' 2>/dev/null) || exit 0

[ -n "$HIT" ] || exit 0

MSG="BLOCKED (pre:bash:rtk-exec-gate): '${HIT}' runs its operand through rtk, outside the view of the other pre:bash guards. Run the command directly: pre:bash:rtk-rewrite already filters its output. For UNFILTERED output prefix it with RTK_DISABLED=1 (e.g. RTK_DISABLED=1 git diff). If you only mention this text in a message or comment, rephrase it so the words rtk and run/test/err/summary/bypass/proxy are not adjacent."
printf '%s' "$MSG" | python3 -I -c 'import json,sys; print(json.dumps({"decision": "block", "reason": sys.stdin.read()}))'
exit 2
