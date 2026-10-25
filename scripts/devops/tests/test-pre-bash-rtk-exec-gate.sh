#!/usr/bin/env bash
# test-pre-bash-rtk-exec-gate.sh — proves .claude/hooks/pre-bash-rtk-exec-gate.sh refuses every typed form of
# "run a command THROUGH rtk" (bypass / proxy / err / test / run / summary, quoted operand included) and stays
# silent on everything else, including the tool subcommands pre:bash:rtk-rewrite itself produces.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"
HOOK="$REPO_ROOT/.claude/hooks/pre-bash-rtk-exec-gate.sh"
echo "== test-pre-bash-rtk-exec-gate.sh =="
echo
if ! bash -n "$HOOK" 2>/dev/null; then
  echo "FATAL: syntax error in $HOOK"
  bash -n "$HOOK"
  exit 1
fi

run_hook() {
  python3 -c 'import json,sys; print(json.dumps({"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":sys.argv[1]}}))' "$1" | bash "$HOOK"
}

# ── refusals: the contract body must be present (a bash syntax error also exits 2) ──
for cmd in \
  "rtk bypass rm -rf /etc" \
  "rtk \$'\\x62ypass' ls" \
  "rtk \$'\\142ypass' ls" \
  "rtk \$'\\U00000062ypass' ls" \
  "rtk \$'\\x2dv' bypass ls" \
  "\$'\\x72tk' bypass ls" \
  "~/.local/bin/\$'\\x72tk' bypass ls" \
  "rtk byp\\
ass ls" \
  "rt\\
k bypass ls" \
  "echo ok; rtk \$(echo bypass) ls" \
  "sudo rtk \$SUB ls" \
  "echo '\$'; rtk bypass \\U1; echo 'x'" \
  "awk '{print \$'; rtk run ls; echo 'x'" \
  "if true; then rtk \$SUB ls; fi" \
  "for i in 1; do rtk \$SUB ls; done" \
  "if false; then :; else rtk \$SUB ls; fi" \
  "time rtk \$SUB ls" \
  "env -i rtk \$SUB ls" \
  "command rtk \$SUB ls" \
  "exec rtk \$SUB ls" \
  "nohup rtk \$SUB ls" \
  "xargs -n1 rtk \$SUB" \
  "eval rtk \$SUB ls" \
  "(rtk \$SUB ls)" \
  "{ rtk \$SUB ls; }" \
  "echo a
rtk \$SUB ls" \
  "FOO=1 rtk \$SUB ls" \
  "RTK_DISABLED=1 rtk \$SUB ls" \
  "nice rtk \$SUB ls" \
  "timeout 5 rtk \$SUB ls" \
  "! rtk \$SUB ls" \
  "bash -c 'rtk \$SUB ls'" \
  "sh -lc \"rtk \$SUB ls\"" \
  "\$'\\x72\\u74k' bypass ls" \
  "bash -c \"\$'\\u72'tk bypass ls\"" \
  "sh -c \"rtk \$'\\u62ypass' ls\"" \
  "bash -c \"rtk \$'\\u62'ypass ls\"" \
  "rtk {bypass,echo,\$'\\ud800'} ." \
  "FOO=1 rtk {bypass,echo} hi" \
  "env B=1 rtk \$SUB hi" \
  "sudo -u x rtk \$SUB hi" \
  "time -p rtk \$SUB hi" \
  "command -p rtk \$SUB hi" \
  "nohup nice rtk \$SUB hi" \
  "B=1; rtk {bypass,echo} hi" \
  "rtk 3>\"f g\" test echo MARK" \
  "rtk 3>'f g' bypass echo MARK" \
  "rtk 2>\"a b\" -v proxy echo MARK" \
  "rtk 2>f\\ g test echo MARK" \
  "rtk 2>\"a b\"\"c d\" test echo MARK" \
  "rtk 2>\"e f\" run echo MARK" \
  "rtk 2>\$'f g' test echo MARK" \
  "echo '>' ; rtk run ls; echo 'x'" \
  "echo \"a > b\" ; rtk run ls" \
  "rtk init -g" \
  "rtk init --show" \
  "timeout -k 5 10 rtk \$SUB ls" \
  "timeout 5 10 rtk \$SUB ls" \
  "rtk \$'\\0'bypass ls" \
  "rtk \$'\\x00'proxy ls" \
  "rtk \$'\\400'run ls" \
  "rtk byp\$'\\0'ass ls" \
  "r\$'\\0'tk bypass ls" \
  "rtk \$'\\x74est' ls" \
  "rtk \$'\\u0074est' ls" \
  "rtk \$'\\u0072un' ls" \
  "ionice rtk \$SUB ls" \
  "stdbuf -oL rtk \$SUB ls" \
  "setsid rtk \$SUB ls" \
  "unbuffer rtk \$SUB ls" \
  "watch -n 5 rtk \$SUB ls" \
  "doas rtk \$SUB ls" \
  "bash -ec 'rtk \$SUB ls'" \
  "bash -xc 'rtk \$SUB ls'" \
  "echo \`rtk \$SUB ls\`" \
  "case a in a) rtk \$SUB ls;; esac" \
  ">/dev/null rtk \$SUB ls" \
  "rtk 2>/dev/null run 'touch M'" \
  "rtk >/dev/null run ls" \
  "rtk <&- run ls" \
  "rtk &>/dev/null run ls" \
  "rtk 3>&1 run ls" \
  "rtk -v 2>&1 test ls" \
  "rtk 2> /dev/null bypass ls" \
  "rtk {fd}>/dev/null run ls" \
  "rtk\${IFS}run 'touch M'" \
  "rtk\$IFS\$9run ls" \
  "rtk\${IFS}bypass ls" \
  "rtk\$X run ls" \
  "echo ok; rtk\`echo\` run ls" \
  "rtk byp''ass rm -rf /x/node_modules" \
  "rtk \$'bypass' rm -rf /x/node_modules" \
  "rtk {bypass,} rm -rf /x/node_modules" \
  "rtk {test,} ls" \
  "rtk \$'bypass' git worktree remove --force /x" \
  "rtk te\\st ls" \
  "rtk \"te\"st ls" \
  "rtk pr\\oxy ls" \
  "rtk su''mmary ls" \
  "rtk byp''ass 'git push origin feat/x'" \
  "rtk \$'bypass' 'git push origin feat/x'" \
  "r''tk byp''ass 'git push origin feat/x'" \
  "rt\\k run ls" \
  "\"rtk\" run ls" \
  "rtk \$(echo bypass) ls" \
  "rtk \`echo test\` ls" \
  "rtk \$SUB ls" \
  "rtk ru? ls" \
  "rtk -v \$'run' ls" \
  "rtk proxy ls" \
  "rtk err ls" \
  "rtk test echo hi" \
  "rtk run echo hi" \
  "rtk summary ls" \
  "rtk -v bypass ls" \
  "rtk --skip-env run ls" \
  "rtk run 'pkill -f main || true'" \
  "rtk bypass 'git worktree remove --force x;'" \
  "rtk run \"vite\"" \
  "rtk test --shell sh 'pnpm dev'" \
  "/home/u/.local/bin/rtk bypass ls" \
  "sudo rtk err ls" \
  "echo ok; rtk summary ls" \
  "echo ok && rtk run ls" \
  "x | rtk test cat" \
  "rtk'' run ls" \
  "rtk \\
run ls" \
  "rtk	test	ls"; do
  assert_red "refuses: $cmd" \
    --contains '"decision": "block"' \
    -- run_hook "$cmd"
done

# ── silence: tool subcommands, rtk's own utilities, RTK_DISABLED, plain commands ──
for cmd in \
  "grep -rn rtk .claude/hooks/*.sh" \
  "git grep -n rtk -- '*.md'" \
  "rg rtk -g '*.sh'" \
  "grep -rn \"rtk\" \$CLAUDE_PROJECT_DIR/docs" \
  "git commit -m \"fix: rtk \$(date)\"" \
  "grep -l rtk \$(git ls-files docs)" \
  "rtk test-foo ls" \
  "rtk runner ls" \
  "rtk tests ls" \
  "grep -n rtk \$'\\x2e'" \
  "echo \$'\\x68ello'" \
  "git commit -m \"use the rtk filter for output\"" \
  "echo 'the rtk hook rewrites commands'" \
  "rtk git status" \
  "rtk git add a && rtk git commit -m x" \
  "rtk pnpm --filter @crm/api test" \
  "rtk grep -rn test ." \
  "rtk gain" \
  "rtk --version" \
  "rtk hook claude" \
  "echo 'a > b' ; git status" \
  "echo hi >/dev/null 2>&1 ; git status" \
  "RTK_DISABLED=1 git diff" \
  "git status" \
  "pnpm test" \
  "echo hello" \
  "grep -rn rtk ." \
  "cat nortk-run.txt"; do
  assert_green "allows: $cmd" \
    --not-contains '"decision"' \
    -- run_hook "$cmd"
done

# ── performance: padding must not make the regexes quadratic (SR-M-12) ──
assert_green "padding and adversarial wrapper chains (20k newlines, path runs, nice -n 5 x40, a=b; x50k, 300 KB chain) all finish fast" \
  --contains "FAST" \
  -- python3 -c '
import json, subprocess, sys, time
hook = sys.argv[1]
for cmd in ("echo ok" + "\n" * 20000, "echo ok" + " \n" * 10000, "echo " + "a/" * 80000, "echo " + "~" * 100000,
            "nice -n 5 " * 40 + "ls", "time -p " * 60 + "ls", "sudo -u x " * 40 + "ls", "a=b;" * 50000, ";" * 100000,
            "nice -n 5 " * 30000, "sudo" + " -a" * 60 + " x", "time" + " -n 1" * 40 + " x", "A=1 " * 50000 + "ls",
            "time -p nice -n 1 " * 40 + "x", "sudo -u x -g y " * 40 + "ls",
            "nice -n -5 " * 40 + "rtk zzz", "nice --adj " * 40 + "ls", "sudo -u -x " * 40 + "ls", "env --foo=bar " * 40 + "ls",
            "rtk --adj " * 40 + "zzz", "echo " + "1" * 100000 + " ; rtk run ls", "echo {" + "1" * 100000 + " ; rtk run ls",
            "{1" * 50000, "echo " + "1 " * 50000, "{" * 100000, "&" * 100000, "<" * 100000, ">" * 100000, "echo " + ">\"" * 50000, "echo " + ">\x27" * 50000, "echo " + ">\\" * 50000):
    t = time.time()
    try:
        subprocess.run(["bash", hook], input=json.dumps({"tool_input": {"command": cmd}}).encode(), capture_output=True, timeout=10)
    except subprocess.TimeoutExpired:
        print("HANG", len(cmd), cmd[:60])
        sys.exit(1)
    if time.time() - t > 5:
        print("SLOW", len(cmd), round(time.time() - t, 1))
        sys.exit(1)
print("FAST")
' "$HOOK"

assert_green "a 30k digit run (or {+digits) before an exec form is still refused, and fast (SR-H-17)" \
  --contains "REFUSED-FAST" \
  -- python3 -c '
import json, subprocess, sys, time
hook = sys.argv[1]
b = "r" + "tk"
for cmd in ("echo " + "1" * 30000 + " ; " + b + " ru" + "n ls", "echo {" + "1" * 30000 + " ; " + b + " ru" + "n ls"):
    t = time.time()
    try:
        r = subprocess.run(["bash", hook], input=json.dumps({"tool_input": {"command": cmd}}).encode(), capture_output=True, timeout=10)
    except subprocess.TimeoutExpired:
        print("HANG", len(cmd))
        sys.exit(1)
    if r.returncode != 2 or time.time() - t > 2:
        print("BAD", r.returncode, round(time.time() - t, 1))
        sys.exit(1)
print("REFUSED-FAST")
' "$HOOK"

# ── fail-open: garbage input must never become a block ──
assert_green "garbage stdin is allowed (fail-open)" \
  --not-contains '"decision"' \
  -- bash -c 'printf "%s" "not json" | bash "$0"' "$HOOK"

guard_test_summary "test-pre-bash-rtk-exec-gate.sh"
