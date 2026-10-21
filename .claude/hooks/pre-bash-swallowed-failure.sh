#!/bin/bash
# ECC stable id: pre:bash:swallowed-failure
#
# ADVISORY. This hook NEVER refuses. It prints one note on stderr and exits 0.
# That is the whole design, not a limitation — see "WHY ADVISORY" below.
#
# Purpose: say out loud, at the moment it is typed, that a command cannot tell
# "nothing matched" from "nothing was read". Two instances of 2026-10-21 had
# exactly this shape and produced two consecutive WRONG verifications before the
# third attempt produced facts:
#
#   <read one named object> 2>/dev/null | grep -c <symbol>
#
# The producer failed (wrong path; mangled revision), its error went to the
# discarded channel, the counter counted an EMPTY INPUT and printed `0`, and the
# `0` was reported as "the symbol is absent" when the truth was "the file was
# never read". The consumer was not broken: a counter handed nothing correctly
# says zero. Nothing in the pipeline was obliged to mention that the input was
# empty for a reason.
#
# Rule: .claude/rules/common/verification-integrity.md
# Rationale + the eight instances: docs/architecture/rules-rationale/verification-integrity.md
#
# ---------------------------------------------------------------------------
# WHY ADVISORY, AND NOT A REFUSAL
#
# The first design of this gate was REJECTED, then reinstated as an advisory
# after the rejection's measurement turned out to be wrong. Both halves of that
# history matter, because they are the reason this file refuses nothing:
#
#   - The rejection rested on "the shape occurs once in this repo, and that once
#     is legitimate". That measurement was made with a regex that required the
#     grep flag cluster to END in `c` or `q` (so `grep -qE` never matched) and
#     enumerated `wc -l` while missing `wc -w`. Corrected, the strict conjunction
#     occurs TWICE, and the second one is a live latent defect of exactly this
#     class in a guard of our own — a parent count derived from a `git log` whose
#     stderr is discarded, which reads as "not a merge commit" whenever the read
#     fails. A miscounting counter, inside the analysis of miscounting counters.
#   - It also rested on "stream-watchdog.md prescribes this shape". It does not:
#     it prescribes `curl --max-time 5` and `gh pr checks`, neither of which
#     discards stderr or pipes into a matcher. That was an inference presented as
#     a citation, and it is withdrawn.
#
# What survived the correction is the FALSE-POSITIVE population, which is real
# and is the reason this is not a block: the one legitimate corpus case is a
# READINESS PROBE (scan a port until a service answers), where the producer is
# EXPECTED to fail and the discard is correct. Probes are typed ad hoc constantly.
#
# So the cost table that governs the other pre:bash gates does not apply here:
#
#   pre:bash:safety        miss = the owner's database      FP = one minute
#   pre:bash:live-db-guard miss = the owner's database      FP = one minute
#   THIS HOOK              miss = one wrong answer,         FP = one line of
#                                 recoverable by the next         ignorable text
#                                 command
#
# A refusal would trade a cheap, recoverable miss for the expensive failure named
# in lib/cmdscan.py's header: the documented workaround sits inside the refusal
# text, two false hits train "prepend and retry", and that reflex then fires on a
# real launch. An advisory has no workaround to learn, so it cannot teach one.
#
# ---------------------------------------------------------------------------
# HOW IT DECIDES — command position, via the shared analyzer, never a substring.
#
# lib/cmdscan.py does the lexing (quotes, $( ), backticks, heredoc bodies). Two
# properties of it are load-bearing and were verified by running it, not by
# reading it:
#   - a QUOTED-delimiter heredoc body is NOT code, so a markdown note or a PR
#     body that spells this shape in prose produces no segments and no note. That
#     closes, for free, the class of four false positives that the launcher gates
#     produced in one day before they were narrowed.
#   - `$( ... )` contents ARE scanned, so the shape hidden in a command
#     substitution (which is how the live defect in our own guard is written) is
#     still seen.
#
# PREDICATES (both advisory)
#
#   SWALLOWED-COUNT  in ONE pipeline: a NAMED-OBJECT READER whose stderr is
#     discarded, piped into a COUNTER.
#       reader  = git show / git cat-file / git log / git diff, cat, head, tail, jq
#       counter = grep with `c` or `q` in its flag cluster, or wc -l / -w / -c
#     WHY THE READER LIST IS AN ALLOWLIST OF *REPORTED* COMMANDS, and why it is
#     allowed to be an enumeration here when lib/cmdscan.py's header argues the
#     opposite for the launcher gates: the direction of failure is reversed. For
#     a REFUSAL, a command left out of a list costs a false positive and one
#     wrongly left in costs a miss, so the list must fail toward inspecting.
#     Here a command left out costs a MISSED NOTE — nothing — while one wrongly
#     left in costs NOISE, which is the only thing that can kill an advisory. So
#     this list fails toward SILENCE on purpose, and the discrimination it buys
#     is exactly the one the corpus asked for: a named-object read failing makes
#     the count meaningless, while a service probe failing is the probe working.
#     `curl`, `nc`, `ssh-keyscan`, `pg_isready`, `lsof`, `docker ps` are
#     deliberately NOT readers — that is the readiness-probe exemption, and it is
#     what keeps the legitimate corpus case quiet.
#
#   ZSH-REVSPEC  a reader argument containing an UNBRACED `$NAME:` — e.g. a
#     revision passed as `$REV:path` instead of `${REV}:path`. Reported whether
#     or not stderr is discarded, because in zsh it is wrong on its own: zsh
#     reads what follows the colon as a modifier of the expansion and mangles the
#     word into something that names nothing. QUOTING DOES NOT HELP; braces do.
#     THE SHELL FACT THAT MAKES THIS APPLY, measured rather than assumed: the
#     harness's Bash tool runs zsh here (`$0` is /bin/zsh, `BASH_VERSION` unset),
#     so zsh's word rules govern every command any agent sends. Combined with
#     SWALLOWED-COUNT this is the complete failure of 2026-10-21: mangled
#     argument -> error to the discarded channel -> a confident `0`.
#
# DELIBERATELY NOT CAUGHT — accepted gaps, each one a missed note and nothing more:
#   1. Script interiors. `bash scripts/foo.sh` is one segment; the shape INSIDE
#      the script is invisible here. This is the big one, and it is where the
#      measured population lives: every strict-conjunction occurrence found in
#      this repo is in an authored script, not an ad-hoc command. A static
#      scanner over committed scripts is the instrument for that half and is NOT
#      this hook (see the rule's "when to reconsider").
#   2. A counter whose emptiness is read but which is not in this list
#      (`awk 'END{print NR}'`, `sort -u | head -1`, `jq length`).
#   3. A discard-into-FILTER whose empty output is then read as an answer
#      (`curl ... 2>/dev/null | grep -i '^Vary:'` assigned to a variable). Same
#      defect, wider shape, much larger legitimate population — left out so the
#      note stays worth reading.
#   4. `2>&-`, `2>/dev/null` moved by `exec`, or a discard inherited from the
#      caller. Only a literal per-segment redirect is seen.
#   5. A git global option that consumes its argument and is NOT in
#      GIT_VALUE_OPTS: the subcommand scan would read that option value as the
#      subcommand and go silent. `git -C <dir> show` was exactly this bug
#      (CR-M-2) and is now handled; the list is still an enumeration, so the
#      next unlisted one fails the same way. It fails toward SILENCE, which is
#      the correct direction for an advisory but is a gap, not a property.
#
# IF YOU ADD A PREDICATE: add BOTH an `assert_red_signal` (the note fires) and an
# `assert_green --not-contains` (a legitimate look-alike stays silent) to
# scripts/devops/tests/test-pre-bash-swallowed-failure.sh, and run it. A gate
# proven only by firing is the defect this hook is about, one level up.
# ---------------------------------------------------------------------------

# WRAPPER FAILURE IS AN ALLOW *AND* A SILENCE. For a PreToolUse hook exit 2 means
# refuse, and bash exits 2 on a syntax error in this very file. This hook must
# never refuse anything, so the trap turns every non-zero exit into 0. Kept first
# and trivial, as in the sibling hooks.
trap 'sf_rc=$?; if [ "$sf_rc" -ne 0 ]; then echo "[pre:bash:swallowed-failure] advisory wrapper failed (rc=$sf_rc) — allowing" >&2; fi; exit 0' EXIT

set -u

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
INPUT=$(cat)

# Cheap pre-filter: a stderr discard, or an unbraced `$NAME:`. Nothing else can
# match either predicate, so there is nothing to analyse without one of them.
printf '%s' "$INPUT" | grep -qE '2>[[:space:]]*/dev/null|\$[A-Za-z_][A-Za-z0-9_]*:' || exit 0

printf '%s' "$INPUT" | PYTHONDONTWRITEBYTECODE=1 CMDSCAN_LIB="$SELF_DIR/lib" python3 -c '
import importlib.util, json, os, re, sys

# By absolute path, not via sys.path — same reason as the sibling hooks.
try:
    _spec = importlib.util.spec_from_file_location(
        "cmdscan", os.path.join(os.environ["CMDSCAN_LIB"], "cmdscan.py"))
    cmdscan = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(cmdscan)
except Exception:
    sys.exit(0)          # advisory: an unavailable analyzer is a silence

try:
    payload = json.load(sys.stdin)
    cmd = payload.get("tool_input", {}).get("command", "")
except Exception:
    sys.exit(0)
if not isinstance(cmd, str) or not cmd.strip():
    sys.exit(0)

try:
    scan = cmdscan.scan(cmd)
except Exception:
    sys.exit(0)

READERS = ("git", "cat", "head", "tail", "jq")
GIT_READ_SUBCMDS = ("show", "cat-file", "log", "diff")
DISCARD_RE = re.compile(r"2>[\s]*/dev/null")
UNBRACED_RE = re.compile(r"\$[A-Za-z_][A-Za-z0-9_]*:")

# Global git options that CONSUME THE NEXT ARGUMENT. Taking the first
# non-dash token as the subcommand was wrong and mattered more than it looks
# (CR-M-2): this project steers agents to `git -C <dir>` precisely because they
# work in worktrees, so the commonest form here was the one that escaped — and
# it is the form that produced real false zeros.
GIT_VALUE_OPTS = ("-C", "-c", "--git-dir", "--work-tree", "--namespace",
                  "--exec-path", "--config-env")


def git_subcommand(argv):
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in GIT_VALUE_OPTS:
            i += 2                      # option plus its value
            continue
        if a.startswith("-"):
            i += 1                      # boolean flag, or --opt=value
            continue
        return a
    return ""


def is_reader(seg):
    if seg.name not in READERS:
        return False
    if seg.name == "git":
        return git_subcommand(seg.argv) in GIT_READ_SUBCMDS
    return True

def is_counter(seg):
    if seg.name == "wc":
        return any(a in ("-l", "-w", "-c") or
                   (a.startswith("-") and not a.startswith("--") and
                    any(ch in a[1:] for ch in "lwc"))
                   for a in seg.argv)
    if seg.name == "grep":
        for a in seg.argv:
            if a.startswith("-") and not a.startswith("--"):
                if "c" in a[1:] or "q" in a[1:]:
                    return True
            elif a in ("--count", "--quiet", "--silent"):
                return True
    return False

# Pipeline adjacency comes from code_view, where cmdscan joins piped segments
# with " | " and separates statements with a newline. Splitting on statement
# boundaries first keeps a reader in one statement from pairing with a counter
# in the next.
notes = []
segs = list(scan.segments)

# Align pipeline stages to segments with ONE FORWARD CURSOR, matching on the
# COMMAND WORD. Matching a stage to a segment by string equality was the first
# attempt and it is wrong: code_view has quoted literals removed, while
# seg.raw keeps them, so any quoted argument broke the match and the note went
# silent. That silence is this hook failing in the exact shape it exists to
# report, so the matcher is deliberately structural rather than textual.
ASSIGN_TOK = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
CURSOR = [0]

def stage_word(stage):
    toks = stage.split()
    i = 0
    while i < len(toks) and ASSIGN_TOK.match(toks[i]):
        i += 1
    return toks[i] if i < len(toks) else ""

def take(word):
    k = CURSOR[0]
    while k < len(segs):
        nm = segs[k].name
        if nm and word and (word == nm or word.endswith("/" + nm)):
            CURSOR[0] = k + 1
            return segs[k]
        k += 1
    return None

for stmt in re.split(r"\n|&&|\|\||;", scan.code_view):
    stages = [x.strip() for x in stmt.split("|")]
    # Mapped for EVERY statement, including single-stage ones, so the cursor
    # stays in step with source order.
    mapped = [(st, take(stage_word(st))) for st in stages]
    if len(stages) < 2:
        continue
    for i, (st, prod) in enumerate(mapped[:-1]):
        if prod is None or not DISCARD_RE.search(st) or not is_reader(prod):
            continue
        for _unused, cons in mapped[i + 1:]:
            if cons is not None and is_counter(cons):
                notes.append(
                    "SWALLOWED-COUNT: `%s` discards stderr and feeds `%s`.\n"
                    "  An empty result here means \"nothing matched\" OR \"nothing was read\" — "
                    "`-c` prints 0,\n  `-q` reports false, and NEITHER can tell you which. The "
                    "second one is a failed read\n  reported as a fact.\n"
                    "  Do not discard stderr while verifying. Read the producer into a variable, "
                    "confirm it is\n  non-empty, then count — or drop `2>/dev/null` and look at "
                    "the error."
                    % (prod.raw.strip(), cons.raw.strip()))
                break

for seg in segs:
    if not is_reader(seg):
        continue
    for a in seg.argv:
        m = UNBRACED_RE.search(a)
        if m:
            notes.append(
                "ZSH-REVSPEC: `%s` passes an UNBRACED `%s` — write `${...}:path`.\n"
                "  The harness shell here is zsh, which reads what follows the colon as a "
                "modifier of the\n  expansion and mangles the word into a path that names nothing. "
                "Quoting does NOT help;\n  braces do. With a discarded stderr this is how a "
                "confident `0` gets reported for a file\n  that was never opened."
                % (seg.raw.strip(), m.group(0)))
            break

if notes:
    seen = set()
    out = []
    for n in notes:
        if n not in seen:
            seen.add(n)
            out.append(n)
    text = (
        "SWALLOWED FAILURE (advisory — nothing was refused). This command cannot tell "
        "\"nothing matched\" from \"nothing was read\":\n"
        + "".join("  " + n.replace("\n", "\n  ") + "\n" for n in out)
        + "  Rule: .claude/rules/common/verification-integrity.md")
    # THE CHANNEL IS THE WHOLE POINT (CR-H-1 on this PR). The first version wrote
    # this to STDERR, which for a PreToolUse hook that exits 0 does NOT reach the
    # model: stderr is surfaced on a REFUSAL (exit 2), and this hook never
    # refuses. So the advisory was an instrument reporting into a channel nobody
    # reads — this rule own defect, shipped inside the rule.
    # The model-visible channel for a non-blocking PreToolUse hook is
    # hookSpecificOutput.additionalContext on STDOUT, which is the mechanism the
    # operator reminder in this environment uses and the only one observed to
    # reach an agent. json.dumps does the escaping; a note containing quotes and
    # newlines would otherwise emit malformed JSON and be dropped silently.
    sys.stdout.write(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": text,
        }
    }))
sys.exit(0)
' || exit 0

exit 0
