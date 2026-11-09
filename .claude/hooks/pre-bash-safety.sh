#!/bin/bash
# ECC stable id: pre:bash:safety
# Phase 2 ECC port of legacy .claude/hooks/safety.sh.
#
# Purpose: block truly catastrophic Bash commands — fork bombs, rm -rf on root
# paths, force push to main/master, dropping the live crm_db. Everything else
# fast-exits so the hook never gates non-target commands.
#
# ---------------------------------------------------------------------------
# QUOTING IS NOT EXECUTION (rewritten 2026-08-18, backlog 106)
#
# This hook used to grep the RAW command line, so a command that merely QUOTED
# a dangerous phrase was refused:
#
#     echo "... DROP DATABASE crm_db ..."          -> BLOCK
#     gh pr create --body "... DROP DATABASE ..."  -> BLOCK  (this actually
#         happened while writing the PR description for pre-bash-cross-agent-blast)
#     echo "never: git push --force origin main" -> BLOCK
#
# Reproduced four times on 2026-08-17/18 — the fourth time on the very probe
# command written to demonstrate the bug. The damage is not the lost minute: a
# refusal that is obviously wrong teaches the reader to route around the hook,
# and that habit does not distinguish the wrong refusals from the right ones.
#
# No predicate is relaxed. The question changed from "does the line contain the
# phrase" to "is the dangerous thing what the line EXECUTES". `echo "rm -rf /"`
# and `rm -rf /` differ in exactly one respect — which token is in command
# position — so command position is what is now examined, via lib/cmdscan.py
# (segments split on ;/&&/||/|/&/newline and on shell grouping, `sh -c`, `eval`,
# `find -exec` and `$( )` recursed into, `VAR=v` and the wrapper commands
# unwrapped, heredoc bodies treated as data). Danger behind any of those forms is
# still caught; see scripts/devops/tests/test-pre-bash-safety.sh, which runs both
# directions.
#
# AND WHEN THE PARSE CANNOT BE TRUSTED (security review, 2026-08-18). The first
# version of this rewrite trusted its own answer unless `shlex` had thrown. The
# review produced 13 reproduced misses — `sudo -s rm -rf /etc` read as command
# `etc`, `{ rm -rf /etc ; }` as command `{`, `if …; then rm …; fi` as `then` —
# with the parser reporting no failure at all. The measure of it: with a BROKEN
# analyzer `sudo -s rm -rf /etc` was blocked, and with a working one it was not.
# So an unresolved segment is no longer judged by its command word; it is judged
# by every "the command might start here" reading of itself, through these same
# predicates. Unknown wrappers fail toward blocking, which is the only direction
# a list-based approach could never guarantee.
#
# AND WHAT "UNDERSTOOD" HAD TO MEAN (third round of the same review). The
# conservative path above is reached only for segments cmdscan does NOT claim to
# understand — and that list still held `tar`, `rsync`, `ssh`, `nc`, `psql` and
# `git`, all of which run what they are handed. Eleven forms on THIS hook were
# allowed here and refused by main, `tar --use-compress-program 'rm -rf /etc'`
# among them, with the marker file to prove the payload really runs. The list is
# pruned to what it always claimed to be, and the two commands that had to stay
# (git and psql — an agent types them all day, and reading their prose through
# readings() would refuse `git commit -m "…pnpm dev…"`) now hand over what they
# execute the way `find -exec` always did. See lib/cmdscan.py, UNDERSTOOD.
# ---------------------------------------------------------------------------
#
# Contract:
#   - Reads tool-call JSON from stdin (Claude Code PreToolUse contract).
#   - exit 0 with no output  → allow.
#   - exit 2 with stderr     → block (ECC convention) AND emit JSON
#                              {"decision":"block","reason":"..."} to stdout for
#                              legacy compatibility with Claude Code's JSON
#                              control-flow path.
#   - exit 2 + `INTERNAL ERROR` on stderr, no decision body → the analyzer itself
#     failed. This is NOT a verdict, but the command is still refused, because
#     nobody read it. The exit code alone cannot tell this from a block (a hook
#     that dies on a syntax error exits 2 too), so the contract is: a real verdict
#     ALWAYS carries the decision JSON on stdout, and an analyzer failure ALWAYS
#     says INTERNAL ERROR on stderr. If the old coarse test still sees something
#     catastrophic, the fallback also prints a decision body labelled DEGRADED MODE
#     (still exit 2, still INTERNAL ERROR on stderr).
#
# Specific predicates implemented (each decided on the executed command):
#   1. `rm -r[f]` whose target is a root-level path (`/`, `/*`, `/etc`, ...),
#      excluding the scratch roots /tmp/**, /private/tmp/**, /var/folders/**,
#      /private/var/folders/**.
#   2. `rm -r[f]` on `~`, `~/...`, `$HOME`, `${HOME}/...` — home blast radius.
#      `~/Downloads/...` stays allowed (kept from the legacy regex).
#   3. Fork bomb pattern `:(){:|:&};:` (any whitespace variant), matched against
#      the UNQUOTED text only, so `echo ':(){ :|:& };:'` is not a fork bomb.
#   4. Force push to main/master: `git push --force|-f|--force-with-lease` (or a
#      `+refs/...` refspec) aimed at a ref whose name is main/master.
#   5. Dropping the live database: `DROP DATABASE [IF EXISTS] crm_db` reaching a
#      command that is not a plain text consumer, and `dropdb crm_db`.
#   6. Writing that same SQL to a file and executing the file in the same line
#      (`echo "…" > /tmp/x.sql && psql -f /tmp/x.sql`). Each segment alone looks
#      innocent; the chain does not, and the whole chain is right there.
#
# Deliberate, stated gaps (same line the sibling pre-bash-cross-agent-blast.sh
# draws, and for the same reason — closing them means either evaluating the
# shell or going back to matching the raw line, which is the disease):
#   - indirection through a variable: `SQL="DROP DATABASE crm_db"; psql "$SQL"`,
#     `D=/etc; rm -rf "$D"`;
#   - a dangerous command inside a script file this hook cannot read.
# `eval "<literal>"` is NOT a gap — its argument is parsed as code. Neither is an
# interpreter s inline program (`python3 -c`, `awk BEGIN{system(…)}`): it cannot
# be parsed as that language, so it is re-read the coarse way instead of trusted.
# Every real incident used a direct form, and every direct form is caught.
#
# Performance note: one python3 start per Bash call — the same cost as the
# previous version, which already needed python3 just to read the JSON.

set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT=$(cat)

[ -z "$INPUT" ] && exit 0

printf '%s' "$INPUT" | PYTHONDONTWRITEBYTECODE=1 CMDSCAN_LIB="$SELF_DIR/lib" python3 -c '
import importlib.util, json, os, re, shlex, sys

# Loaded by absolute path instead of sys.path.insert: putting lib/ on the import
# path made every stdlib module cmdscan imports (shlex) resolvable from that
# directory, on EVERY Bash call. The bar to abuse it was high, but the directory
# had no business being importable at all (review LOW).
_spec = importlib.util.spec_from_file_location(
    "cmdscan", os.path.join(os.environ["CMDSCAN_LIB"], "cmdscan.py"))
cmdscan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cmdscan)

data = json.load(sys.stdin)
cmd = (data.get("tool_input") or {}).get("command") or ""
if not cmd:
    sys.exit(0)

scan = cmdscan.scan(cmd)
blocked = []

# Every predicate below judges CANDIDATES, not segments. For a segment the
# analyzer understood, the candidate list is just the segment. For one it could
# not (`script -q /dev/null rm -rf /etc`, `sudo -T 5 rm -rf /etc`, an unknown
# wrapper) it is every "the real command might start here" reading — so a
# wrapper nobody has added to the list still cannot hide the command it runs.
# This is the fix for the review finding that 13 misses all had degraded=False:
# the parser had not failed, it had been confidently wrong, and nothing checked.
#
# `code=True` also re-reads the inline program of an interpreter — python3 -c,
# perl -e, awk BEGIN{system(...)} — through a punctuation split, because a
# dangerous command hidden inside another language was caught by the old
# substring rule and dropping it would be a narrowing nobody agreed to. This
# hook can afford the resulting false positives; the launcher hooks cannot (the
# false positive that started all of this was an inline node -e), and do not ask.
#
# NB for editors: this python source is a single-quoted bash string. It must not
# contain a single quote anywhere — use \x27 in patterns, and avoid apostrophes
# in comments.
def candidates(seg):
    # A dynamic command word is additionally read as each dangerous command this
    # hook knows: `$(echo rm) -rf /etc` names nothing resolvable, but `-rf /etc`
    # is not ambiguous. Both versions of this hook let that through.
    return cmdscan.candidates(seg, code=True) + cmdscan.as_if(
        seg, ("rm", "git", "dropdb"))

# ── predicate 1+2: rm -rf on root / home paths ───────────────────────────────
SAFE_ROOTS = ("/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/")
HOME_SAFE = ("~/Downloads", "$HOME/Downloads", "${HOME}/Downloads",
             "$USERPROFILE/Downloads", "${USERPROFILE}/Downloads")


def dangerous_rm_target(tok):
    # Windows: C:/x and a quoted C:\x are the same absolute path as /c/x, not a
    # relative one; \\server\x is absolute too, and "$USERPROFILE\x" is a home path.
    # /tmp/x\..\y climbs on Windows too. A plain a\b stays a relative name.
    t = tok.replace(chr(92), "/") if re.match(r"^([A-Za-z]:|\\|\$|/|~)", tok) else tok
    t = re.sub(r"^([A-Za-z]):(?=/|$)", lambda m: "/" + m.group(1).lower(), t)
    t = t.rstrip("/") or "/"
    if t in ("/", "/*", "/.", "~", "$HOME", "${HOME}", "$USERPROFILE", "${USERPROFILE}"):
        return True
    # A .. segment can climb out of a safe root, so it never counts as safe.
    climbs = ".." in t.split("/")
    for safe in HOME_SAFE:
        if not climbs and (t == safe or t.startswith(safe + "/")):
            return False
    if t.startswith(("~/", "$HOME/", "${HOME}/", "$USERPROFILE/", "${USERPROFILE}/")):
        return True
    if not t.startswith("/"):
        return False
    for root in SAFE_ROOTS:
        if not climbs and (t + "/").startswith(root):
            return False
    return True


for seg in scan.segments:
    for cand in candidates(seg):
        if cand.name not in ("rm", "rmdir"):
            continue
        flags = [t for t in cand.argv if t.startswith("-") and t != "-"]
        # `-R` is the same as `-r` for rm on both BSD and GNU; the first version
        # compared case-sensitively, so `rm -Rf /etc` read as non-recursive.
        recursive = any(
            ("r" in f[1:].lower() and not f.startswith("--")) or f in ("--recursive",)
            for f in flags
        )
        if cand.name == "rm" and not recursive:
            continue
        for tok in cand.positionals():
            if dangerous_rm_target(tok):
                blocked.append("rm -rf on root/home path (%s)" % tok)
                break
        if blocked:
            break
    if blocked:
        break

# ── predicate 3: classic bash fork bomb ──────────────────────────────────────
# Matched on the UNQUOTED text: a fork bomb inside quotes is a string.
FORK_BOMB = re.compile(r":\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:")
if FORK_BOMB.search(scan.code_view):
    blocked.append("fork bomb")

# ── predicate 4: force push to main/master ───────────────────────────────────
FORCE_FLAGS = ("--force", "-f", "--force-with-lease")


def targets_protected_ref(tokens):
    for tok in tokens:
        ref = tok.lstrip("+")
        ref = ref.split(":")[-1]
        ref = ref.rsplit("/", 1)[-1]
        if ref in ("main", "master"):
            return True
    return False


# git s own global flags take values, and `positionals()` did not know that —
# so `git -C <path> push --force origin main` read as subcommand `<path>` and
# left before the check (review MED-4). `-C` is also the idiom our own rules
# prescribe for checking MAIN after a Coder, so the shape is a live one.
GIT_VALUE_FLAGS = {
    "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path",
    "--super-prefix", "--config-env",
}
for seg in scan.segments:
    for cand in candidates(seg):
        if cand.name != "git":
            continue
        pos = cand.positionals(GIT_VALUE_FLAGS)
        if not pos or pos[0] != "push":
            continue
        # `--force-with-lease=main` takes a value, so exact membership missed it
        # and the short-flag heuristic below only looks at single-dash flags.
        # Compare the part before the `=`.
        forced = any(
            f.split("=", 1)[0] in FORCE_FLAGS
            or (f.startswith("-") and not f.startswith("--") and "f" in f[1:])
            for f in cand.argv if f.startswith("-")
        )
        forced = forced or any(t.startswith("+") for t in pos[1:])
        if forced and targets_protected_ref(pos[1:]):
            blocked.append("force push to main/master")
            break
    if blocked:
        break

# ── predicate 5: dropping the live database ─────────────────────────────────
# The phrase reaching a command that could execute it is the danger; the same
# phrase reaching `echo`, `gh pr create --body`, `git commit -m` or a heredoc
# that writes a file is a quotation. Unknown commands count as dangerous — the
# allowlist says what is inert, it does not enumerate what is dangerous.
DROP_RE = re.compile(r"DROP\s+DATABASE\s+(IF\s+EXISTS\s+)?[\"\x27`]?crm_db", re.I)
# Text consumers only. `sed` (GNU `e`), `awk` (`system()`), `less`/`more` (shell
# escape), `open`/`code` (hand the file to an application) were on this list and
# are not inert — `awk "BEGIN{system(\"psql -c ...\")}"` executed straight
# through it (review MED-2). `cp`/`mv`/`tee` stay: they move bytes, they do not
# run them — the write-then-execute chain below is what covers materialising a
# file and feeding it to psql in the same line.
INERT = {
    "", "echo", "printf", "cat", "tee", "gh", "git", "jq", "yq", "head", "tail",
    "grep", "egrep", "fgrep", "rg", "ag", "wc", "sort", "uniq", "cut", "tr",
    "diff", "comm", "column", "pbcopy", "true", ":", "test", "cp", "mv",
    "touch", "bat", "prettier", "date",
}
# `git -c core.pager="psql -c ..." log -1` runs psql. So does an alias set the
# same way. `git` is inert only when it is not being handed configuration.
# Belt AND braces since the third review round: cmdscan now also lifts the value
# of every `git -c` out as a segment of its own, so that command is caught twice
# over. Neither check makes the other redundant — this one says "the phrase
# reached a git that is not inert", the other says "and here is what it ran".
GIT_EXEC_FLAGS = ("-c", "--config-env", "--exec-path")


def is_inert(seg):
    name = os.path.basename(seg.name)
    if name not in INERT:
        return False
    # An uncertain parse must not be able to CLAIM inertness — that direction is
    # the one that loses data.
    if not seg.confident:
        return False
    if name == "git" and any(
        t == f or t.startswith(f + "=") for t in seg.argv for f in GIT_EXEC_FLAGS
    ):
        return False
    return True


for seg in scan.segments:
    if DROP_RE.search(seg.text()) and not is_inert(seg):
        blocked.append("DROP DATABASE crm_db (executed through `%s`)" % (seg.name or "?"))
        break
    for cand in candidates(seg):
        if cand.name == "dropdb" and "crm_db" in cand.positionals():
            blocked.append("dropdb crm_db")
            break
    if blocked:
        break

# ── predicate 6: write the SQL in one segment, execute the file in the next ──
# `echo "DROP DATABASE crm_db;" > /tmp/x.sql && psql -f /tmp/x.sql` slipped past
# predicate 5 because each segment on its own is innocent: the first is `echo`,
# the second no longer contains the phrase. This is not the stated gap about a
# script the hook cannot read — the whole chain is right there in the line.
if not blocked:
    line_text = "\n".join(seg.text() for seg in scan.segments)
    if DROP_RE.search(line_text):
        written = {}
        for seg in scan.segments:
            argv = seg.argv
            for i, tok in enumerate(argv):
                if tok in (">", ">>", "1>", "&>") and i + 1 < len(argv):
                    written[argv[i + 1]] = seg
                elif tok.startswith(">") and len(tok.lstrip(">")) > 0:
                    written[tok.lstrip(">")] = seg
            if os.path.basename(seg.name) == "tee":
                for tok in seg.positionals(("-o",)):
                    written[tok] = seg
        for seg in scan.segments:
            if is_inert(seg):
                continue
            for tok in seg.argv:
                path = tok.lstrip("<")
                if path in written and written[path] is not seg:
                    blocked.append(
                        "DROP DATABASE crm_db is written into %s and executed right away through `%s`"
                        % (path, seg.name or "?")
                    )
                    break
            if blocked:
                break

# ── predicate 7: a shell no gate can read ───────────────────────────────────
# Every gate reads bash syntax, so what powershell, pwsh or cmd run was never judged. The
# PowerShell tool is denied for the same reason. Confident segments (echo, git commit -m)
# yield no argument readings, so a message that names a shell is never judged here.
# Fail closed (Master decision on #1294, after shape-by-shape patches kept leaking): any
# reading of the three shells refuses, by name, wherever it stands and whatever follows.
# Accepted false refusals: `go run ./cmd`, `pnpm add powershell`, `x=ls; $x` - run those by hand.
UNREAD_SHELLS = ("powershell", "pwsh", "cmd")


def unread_shell(word):
    # The last path part, any directory (`..\\x\\cmd`, drive-relative `C:cmd`) and an
    # extension stripped. `$COMSPEC` / `%COMSPEC%` name cmd.exe and nothing else.
    last = re.split(r"[/\\:]", word)[-1]
    # A package version (`npx pwsh@$VER`, `pwsh@7`) does not change the binary.
    last = re.sub(r"(?<=[\w.])@.*$", "", last)
    last = re.sub(r"^[^\w.]+|[^\w.]+$", "", last)
    last = re.sub(r"\.(exe|cmd|bat|com)$", "", last, flags=re.I).lower()
    # An 8.3 short name (`C:/PROGRA~1/POWERS~1/7/pwsh~1.exe`) is the same binary.
    short = re.fullmatch(r"(powers|pwsh|cmd)[^~]*~\d+", last)
    if short:
        return {"powers": "powershell"}.get(short.group(1), short.group(1))
    return "cmd" if last == "comspec" else last


def seg_words(seg):
    for tok in [seg.name] + list(seg.argv):
        for word in cmdscan._expand_token(tok, True):
            yield word


def ansi_c_spells(body):
    # An ANSI-C escape other than a quote or a backslash can spell a name (`\x63md`).
    # `\\` pairs are consumed first, so `foo\\bar` is a literal backslash, not `\b`.
    return re.search(r"\\[^\x22\x27]", re.sub(r"\\\\", "", body)) is not None


def dynamic_word(word):
    # `$x`, `${x}`, `${!v}`, `$(...)` (the analyzer marks it with a `$`) and backticks.
    # A `$` that opens ANSI-C or locale quoting (`$\x27...\x27`, `$"..."`) expands nothing.
    if re.search(r"\$\x27", word) and ansi_c_spells(word):
        return True
    word = re.sub(r"\$(?=[\x22\x27])", "", word)
    return "$" in word or "\x60" in word


def refuse_dynamic(word):
    blocked.append("`%s` is a word the hook cannot know; it may run a shell whose syntax "
                   "no gate reads" % word)


# A dynamic word fails closed with no resolution (AUTO-SR-7 on #1294): the union of
# same-line assignments drifts from the shell state (`+=`, `read`, `for`, `export`,
# subshells). Accepted false refusal: `x=ls; $x`. Only command positions are judged
# (CR-M-8): the segment name, `seg.dynamic` and every candidate name. candidates()
# already unwraps the known wrappers and inline programs, so `env $x`, `timeout 5 $x`,
# `xargs $x`, `nice $x` and `bash -c "$x"` are judged through their candidate names.
# Arguments are never judged here, so a `$` inside single quotes (`awk \x27{print $1}\x27`)
# and an option value (`make test ARGS=$X`) stay allowed.
# shortcut: an unknown wrapper that executes a dynamic argument (`unknown-tool $x`) is
# not judged; upgrade by adding that wrapper to the cmdscan wrapper table.
# No exception for a package version (AUTO-SR-12 / AUTO-SR-15): the analyzer names a
# segment by its basename and splits runner flags into words, so an exemption keyed on
# the name was unsafe. Accepted false refusal: `npx -y pkg@$VER`.
# A truncated scan is refused below with its own reason; do not mask it.
for seg in scan.segments:
    if blocked:
        break
    if not scan.truncated:
        # seg.dynamic too: the name is a basename, so its `$` may be gone (`$\x27\\x63md\x27`).
        dyn = [c.name for c in [seg] + candidates(seg) if dynamic_word(c.name)]
        if seg.dynamic:
            dyn.insert(0, seg.name)
        if dyn:
            refuse_dynamic(dyn[0])
            break
    # SO-M-5 (#1294): an assignment that names a shell (`(PAGER=powershell; git log)`) is
    # read by whatever runs later with that variable in its environment, so any assignment
    # word whose value names one of the three shells refuses, prefix or standalone.
    shell_vars = ["%s=%s" % (k, v) for k, v in seg.env.items()
                  if any(unread_shell(w) in UNREAD_SHELLS for w in str(v).split())]
    if shell_vars:
        blocked.append("`%s` names a shell whose syntax no gate reads" % shell_vars[0])
        break
    # A segment the analyzer did not understand: every word may be the command, including
    # the ones too odd to be a reading (a quoted path).
    words = [] if seg.confident else list(seg_words(seg))
    named = [w for w in words if unread_shell(w) in UNREAD_SHELLS]
    if named:
        blocked.append("`%s` runs a shell whose syntax no gate reads" % named[0])
        break
    for cand in candidates(seg):
        if unread_shell(cand.name) in UNREAD_SHELLS:
            blocked.append("`%s` runs a shell whose syntax no gate reads" % cand.name)
            break

# ── predicate 8: an alias body no gate reads ────────────────────────────────
# SR-M-7 (#1294): `alias ls=\x27rm -rf /etc\x27` turns a later `ls` into anything, and no
# gate reads the body. Agents never need an alias or expand_aliases, so defining one (an
# `=` in the arguments), writing BASH_ALIASES, or `shopt -s expand_aliases` refuses.
# Listing (`alias`, `alias ls`) stays allowed.
# AUTO-SR-11: any word naming BASH_ALIASES refuses (assignment, `+=`, compound,
# `printf -v`, `read`, `declare`, `mapfile`), and so does posix mode, which turns alias
# expansion on in a non-interactive bash: `set -o posix`, `shopt -so posix`,
# `bash --posix` and any POSIXLY_CORRECT assignment. Accepted false refusal: a message or
# a search that mentions BASH_ALIASES.
# AUTO-SR-13: a nameref (`declare -n a=BASH_ALIASES`) or a dynamic assignment target
# (`printf -v "$t"`, `read "$t"`, `declare "$t"=x`) can write the alias table under a
# name no check sees, so both refuse. AUTO-SR-14: SHELLOPTS turns posix mode on like
# POSIXLY_CORRECT, and a dynamic option to set, shopt or `bash -o` may be posix.
POSIX_VARS = ("POSIXLY_CORRECT", "SHELLOPTS")
DECLARERS = ("declare", "typeset", "local", "export", "readonly")


def assignment_targets(name, args):
    # The words a builtin assigns to: `printf -v T`, the operands of read / mapfile, the
    # names before `=` for declare and friends. Option values of read count too (fail closed).
    if name == "printf":
        for i, a in enumerate(args):
            if a == "-v" and i + 1 < len(args):
                yield args[i + 1]
            elif a.startswith("-v") and len(a) > 2:
                yield a[2:]
    elif name in ("read", "mapfile", "readarray") + DECLARERS:
        for i, a in enumerate(args):
            # A reading repeats the value of `x=$1` as its own word; that copy is a value, not a target.
            if i and "=" in args[i - 1] and args[i - 1].split("=", 1)[1] == a:
                continue
            if a != "--" and not a.startswith(("-", "+")):
                yield a.split("=", 1)[0]


def alias_route(seg, cand):
    name = cand.name.lstrip("\\")
    args = list(cand.argv)
    opts = [a for a in args if a.startswith(("-", "+")) and a not in ("-", "--")]
    if name == "alias" and any("=" in a for a in args):
        return True
    if name == "shopt" and "expand_aliases" in args:
        return True
    if name in ("set", "shopt", "bash", "sh") and ("posix" in args or "--posix" in args):
        return True
    if name in ("set", "shopt"):
        before = args[:args.index("--")] if "--" in args else args
        if any(dynamic_word(a) for a in before):
            return True
    if name in ("bash", "sh"):
        for i, a in enumerate(args):
            if a in ("-o", "+o") and i + 1 < len(args) and dynamic_word(args[i + 1]):
                return True
    if name in ("declare", "typeset", "local") and any(
            "n" in o.lstrip("-+") for o in opts if not o.startswith("--")):
        return True
    if any(dynamic_word(t) for t in assignment_targets(name, args)):
        return True
    if any(v in seg.env or v in cand.env for v in POSIX_VARS):
        return True
    if re.search(r"\b(POSIXLY_CORRECT|SHELLOPTS)\s*\+?=", seg.raw or ""):
        return True
    return "BASH_ALIASES" in (seg.raw or "")


for seg in scan.segments:
    if blocked:
        break
    if any(alias_route(seg, cand) for cand in candidates(seg)):
        blocked.append("defining an alias, or enabling alias expansion, hides a command "
                       "body no gate reads")

# ── the analyzer admitting it did not finish ────────────────────────────────
# `$( $( … 200 deep … ) )` walks past MAX_DEPTH and leaves code unread. Silence
# about code nobody looked at is exactly the failure mode this hook was rewritten
# for, so it refuses instead.
if not blocked and scan.truncated:
    blocked.append(
        "the command nests deeper than the parse limit — some code was not read"
    )

if not blocked:
    sys.exit(0)

reason = blocked[0]
msg = (
    "Blocked by the safety hook: %s. Run it by hand if you are sure.\n\n"
    "The hook looks at the COMMAND, not at a substring: quoting a dangerous phrase "
    "(echo, git commit -m, gh pr create --body, a heredoc into a file) is free — "
    "what is blocked is executing it." % reason
)
print(json.dumps({"decision": "block", "reason": msg}))
sys.stderr.write("[pre:bash:safety] BLOCK: %s\n" % reason)
sys.exit(10)
'
RC=$?

case "$RC" in
  0) exit 0 ;;
  10) exit 2 ;;
esac

# ── analyzer failure — NOT a verdict ──────────────────────────────────────────
echo "[pre:bash:safety] INTERNAL ERROR: the analyzer did not run (rc=$RC) — this is NOT a verdict of the hook." >&2

# JSON punctuation flattened to spaces: the raw stdin is JSON, so a command's
# last token is followed by `"` and the patterns' `([[:space:]]|$)` boundaries
# would never match — a fallback that quietly matches nothing is worse than no
# fallback, because it looks like protection.
FLAT=$(printf '%s' "$INPUT" | tr '"{},' '    ')
if echo "$FLAT" | grep -qE 'rm[[:space:]]+-rf?[[:space:]]+(/[a-zA-Z]|/[[:space:]]|~/?|\$HOME)' ||
  echo "$FLAT" | grep -qE ':[[:space:]]*\([[:space:]]*\)[[:space:]]*\{[[:space:]]*:[[:space:]]*\|[[:space:]]*:[[:space:]]*&[[:space:]]*\}[[:space:]]*;[[:space:]]*:' ||
  echo "$FLAT" | grep -qE 'git[[:space:]]+push.*(--force|--force-with-lease|[[:space:]]-f([[:space:]]|$)).*((origin[[:space:]]+)?(main|master))' ||
  echo "$FLAT" | grep -qiE 'DROP[[:space:]]+DATABASE[[:space:]]+crm_db'; then
  printf '%s\n' '{"decision":"block","reason":"⚠️ DEGRADED MODE of the safety hook: the command analyzer did not run (see INTERNAL ERROR on stderr), so the old coarse word-substring rule was applied. This may be a FALSE POSITIVE (it fires on ordinary quoting too). Fix .claude/hooks/lib/cmdscan.py instead of bypassing the hook."}'
  echo "[pre:bash:safety] BLOCK (degraded fallback, coarse substring rule)" >&2
  exit 2
fi
# Refused, because a command nobody read is not a command that was cleared.
echo "[pre:bash:safety] Refused: no analyzer, so this command was not read. Fix it first: python3 must run on PATH and the hook library must load. Bash stays refused until then." >&2
exit 2
