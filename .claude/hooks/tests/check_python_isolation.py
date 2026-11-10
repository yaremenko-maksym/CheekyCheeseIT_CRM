"""Gate 0 of cross-agent-hooks-smoke.sh: every python run in a hook is isolated (-I).

A hook runs in the agent's cwd. Without -I, `python3 -c` / `python3 -` puts that cwd on
sys.path (and honours PYTHONPATH), so a planted json.py runs inside the hook (#1304).

Usage: python3 -I check_python_isolation.py <hooks dir>
Prints one `<file>:<line>` per unisolated run, then `scanned <n>` last. The caller treats a
missing or low `scanned` line as a failure, so a scan that did not run is never a pass.
"""
import os
import re
import sys

# Where a command word can start: after a separator, a `{` group or function body, a
# `)` case arm. `=` only as an assignment (PY=python3), never the `[ "$x" = python3 ]` /
# `==` / `!=` comparison; `!` only as negation, never `!=`.
BASE = (
    r"(?:^|[|;&`]|(?<!\$)\{|\)|(?<![\s!=])=(?!=)|!(?!=)|\$\(|\s-c\s+"
    r"|\b(?:if|elif|while|until|then|do|else)\s+|\s-exec(?:dir)?\s+|\$\{\w+:?[-=+])"
)
# a launcher in command position itself (so prose like "this command was ... python3" is
# not one), then up to 6 of its own words (sudo -n -u root python3, env -i python3);
# `command -v` / `-V` only looks the name up, it runs nothing
LAUNCH = (
    BASE + r"\s*(?:[^\s\"'|;&]*/)?(?:eval|sudo|doas|env|nice|ionice|nohup|setsid|stdbuf|flock|unbuffer|caffeinate"
    r"|strace|ltrace|chroot|runuser|parallel|watch|timeout|xargs|time|exec|command(?!\s+-[vV]\b))"
    r"(?:\s+[^\s|;&]+){0,6}?\s+"
)
POS = "(?:" + LAUNCH + "|" + BASE + ")"
# an optional ( / { group opener, env assignments (VAR=1 python3), an optional quote, an optional path (/usr/bin/, "$VENV/bin/")
INTERP = re.compile(
    POS + r"\s*(?:[({]\s*)*(?:[A-Za-z_]\w*=(?:\"[^\"]*\"|'[^']*'|\S*)\s+)*[\"']?(?:[^\s\"'|;&]*/)?python3?(?:\.\d+)?[\"'}]*(?![\w./-])(?=((?:\s+\S+)*))"
)


def isolated(rest):
    """True if -I appears among the interpreter options, before the program or script."""
    words = rest.split()
    i = 0
    while i < len(words):
        word = words[i]
        if not word.startswith("-") or word in ("-", "--"):
            return False  # the script, `-` (stdin) or `--`: options are over
        if word.startswith("--"):
            i += 2 if word == "--check-hash-based-pycs" else 1
            continue
        # a short cluster, read left to right: after c / m / W / X the rest of the word
        # (or the next word) is their value, so `-mIPython` is the module IPython, not -I
        for ch in word[1:]:
            if ch == "I":
                return True
            if ch in "cm":
                return False  # the rest is the program or the module
            if ch in "WX":
                break
        else:
            i += 1
            continue
        i += 1 if word[-1] not in "WX" else 2
    return False


def main(hooks_dir):
    # every .sh below the hooks dir, the smoke test itself included
    files = sorted(os.path.join(d, f) for d, _, fs in os.walk(hooks_dir) for f in fs if f.endswith(".sh"))
    for f in files:
        # a backslash-continued line is one command (`python3 \<newline> -c`)
        lines = open(f, errors="replace").read().replace("\\\n", " ").split("\n")
        for n, line in enumerate(lines, 1):
            if line.lstrip().startswith("#"):
                continue
            if unisolated(line):
                print("%s:%d" % (f, n))
    print("scanned %d" % len(files))


# an interpreter resolved into a variable: the run goes through "$PY", which no scan reads
RESOLVED = re.compile(r"(?:\$\(|`)\s*(?:command\s+-[vV]|which|type\s+-[pP])\s+python3?(?:\.\d+)?\b")


def unisolated(line):
    return bool(RESOLVED.search(line)) or any(not isolated(m.group(1)) for m in INTERP.finditer(line))


# (line, must be flagged). Every form a review round found; run by the smoke before the scan.
SELF_TEST = [
    ("x=$(python3 <<EOF", True), ("echo a | python3", True), ('X=$("python3" -c "1")', True),
    ("python -c 1", True), ("PY=python3", True), ("if python3 -c 1; then :; fi", True),
    ("y=$(python3 -B -c 1)", True), ("/usr/bin/python3 -c 1", True), ("./python3 -c 1", True),
    ('"$VENV/bin/python3" -c 1', True), ("sudo -u root python3 -c 1", True),
    ("env -i python3 -c 1", True), ("xargs python3 -c 1", True), ("sh -c 'python3 -c 1'", True),
    ("( python3 -c 1 )", True), ("time python3 -W ignore -c 1", True),
    ("a=$(python3 -I -c 1 | python3 -c 2)", True), ("x=$(python3 -mIPython)", True),
    ('VAR="a b" python3 -c 1', True), ("case $x in a) python3 script.py ;; esac", True),
    ("f() { python3 -c 'x'; }", True), ("nohup python3 -c x", True),
    ("flock /tmp/l python3 -c x", True), ("VAR=1 python3 -c 1", True),
    ("strace -f python3 -c x", True), ("chroot /r python3 -c x", True),
    ("sudo -n -C2 -u root python3 -c x", True), ("command python3 -c x", True),
    ("command -v python3 >/dev/null", False),
    ("PY=$(command -v python3)", True), ('"${PYTHON:-python3}" -c 1', True),
    ("/usr/bin/env python3 -c 1", True), ('eval "python3 -c 1"', True),
    ("find . -exec python3 -c 1 {} +", True), ('"${PYTHON:-python3}" -I -c 1', False),
    ('echo "this command was not read. Fix it first: python3 must run"', False),
    ("ok=$(python3 -I -B -c 1); ok2=$(python3 -B -I script.py)", False),
    ("python3 -E -s -I -c 1", False), ("python3 -W ignore -I -c 1", False),
    ("ok=$(python3 -Wignore -I -c 1)", False), ("z=$(python3.12 -IB -c 1)", False),
    ('[ "$x" = python3 ] && [ "$x" != python3 ]', False), ("[[ $x == python3 ]]", False),
    ('echo "read (python3 did not run)"', False), ('ok=$("python3" -I -c 1)', False),
    ('ok3=$(VAR="a b" python3 -I -c 1)', False), ('echo "${x} python3 runs"', False),
    ("PY=`command -v python3`", True), ("PY=`type -p python3`", True),
    ('"${USE:+python3}" -c 1', True), ('"${USE+python3}" -c 1', True),
]


def self_test():
    bad = [(l, want) for l, want in SELF_TEST if unisolated(l) != want]
    for l, want in bad:
        print("self-test: %s should %sbe flagged" % (l, "" if want else "not "))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(self_test() if sys.argv[1] == "--self-test" else main(sys.argv[1]))
