# The analyzer of pre-bash-cross-agent-blast.sh (pre:bash:cross-agent-blast).
# Run by that hook as a FILE: `python3 -I -B <this file>`, the command on stdin,
# CWD / AGENT_ID / CMDSCAN_LIB in the environment; one `CODE|text` reason per line
# on stdout. It is not a `python3 -c` argument because Windows caps a whole command
# line at 32767 characters: the body outgrew that, failed to launch (bash rc 126)
# and the fail-closed branch of the hook refused every Bash call.
import importlib.util, os, posixpath, re, shlex, subprocess, sys

# The hook reads the reasons below as UTF-8. On Windows a pipe gets the locale code
# page (cp1251/cp1252) instead, and -I makes python ignore PYTHONIOENCODING /
# PYTHONUTF8, so every Cyrillic reason reached the refusal as mojibake. Set it here.
# stdin too: a Cyrillic command arrives as UTF-8; its error handler is kept as it was.
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
sys.stdin.reconfigure(encoding="utf-8", errors=sys.stdin.errors)

# The shared reading of a line continuation (SR-M-1 of #1294); loaded by absolute path,
# as pre-bash-safety.sh does. A load failure kills the analyzer, and the hook refuses.
_spec = importlib.util.spec_from_file_location(
    "cmdscan", os.path.join(os.environ["CMDSCAN_LIB"], "cmdscan.py"))
cmdscan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cmdscan)


def to_posix(p):
    """Windows spells one path as C:/x and /c/x, so compare one form. Paths here
    are compared as strings: posixpath, because os.path on Windows yields backslashes."""
    p = p.replace(chr(92), "/")
    p = re.sub(r"^([A-Za-z]):(?=/|$)", lambda m: "/" + m.group(1).lower(), p)
    # Drive-relative C:../x is relative to the cwd, so judge it as ../x.
    return re.sub(r"^[A-Za-z]:", "", p)


def cmd_name(word):
    """Git Bash on Windows runs git.exe and pnpm.cmd as git and pnpm."""
    return re.sub(r"\.(exe|cmd|bat)$", "", os.path.basename(word), flags=re.I)


raw_cmd = sys.stdin.read()
cmd = cmdscan.join_continuations(raw_cmd)
# The joiner is a lexer of its own (quotes one level deep, its own comment rule), so a
# slip in it hides a command split by a continuation (F2/F3, round 2 of #1294). Judge a
# second reading too, with every backslash-newline removed and nothing lexed: every
# predicate below works per segment or per match, so appending it can only add work.
if "\\\n" in raw_cmd:
    cmd += "\n" + raw_cmd.replace("\\\n", "")
cwd = to_posix(os.environ.get("CWD", ""))
agent_id = os.environ.get("AGENT_ID", "").strip()

# ---- identity: which worktree am I? -----------------------------------------
# own_wt  — absolute path of my own worktree (or "" if I am not in one)
# own_seg — its directory name, the token compared against other paths
# repo_root — the shared checkout that hosts .claude/worktrees/
own_wt = own_seg = repo_root = ""
in_t3 = False
m = re.match(r"^(?P<root>.*?)/\.claude/worktrees/(?P<seg>[^/]+)", cwd)
if m:
    repo_root = m.group("root")
    own_seg = m.group("seg")
    own_wt = f"{repo_root}/.claude/worktrees/{own_seg}"
else:
    # A T3 worktree lives outside the checkout, so only git can name that checkout.
    m = re.match(r"^(?P<wt>.*?/\.t3/worktrees/[^/]+/(?P<seg>[^/]+))", cwd, re.I)
    if m:
        in_t3 = True
        own_wt = m.group("wt")
        own_seg = m.group("seg")
        try:
            common = subprocess.run(
                ["git", "-C", os.environ.get("CWD", ""), "rev-parse",
                 "--path-format=absolute", "--git-common-dir"],
                capture_output=True, text=True, timeout=5,
                # An inherited GIT_DIR would name another repository (#1297 SR-M-1).
                env={k: v for k, v in os.environ.items() if not k.startswith("GIT_")},
            ).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            common = ""
        common = to_posix(common)
        if common.endswith("/.git"):
            repo_root = common[:-len("/.git")]


def tmp_norm(p):
    """/tmp is a symlink to /private/tmp on macOS, so the harness reports a cwd
    under one spelling while an agent types the other. Normalised textually, not
    by realpath: the target of a `git worktree remove` may already be gone, and a
    filesystem lookup would then answer a different question than the one asked."""
    return re.sub(r"^/private(/tmp/)", r"\1", p)


def native_path(p):
    """The path as the filesystem of THIS python knows it, for an existence test only.
    Native Windows python cannot see a Git Bash spelling (`/c/x` is `C:/x`, `/tmp/x`
    lives under the Git install), so os.path.exists answered False for a live tree and
    an `add` onto it was recorded as this agent's (SR-M-1 of #1317). Elsewhere the
    path is returned unchanged. None when the conversion fails (cygpath missing,
    non-zero, timed out, empty): the caller then treats the path as existing, because
    a fallback to the Git Bash spelling would answer "absent" and record a live tree."""
    if os.name != "nt" or not p.startswith("/"):
        return p
    m = re.match(r"^/([A-Za-z])(?=/|$)", p)
    if m:
        return m.group(1).upper() + ":" + p[2:]
    try:
        # utf-8: under -I the default is the ANSI code page, which mangles a Cyrillic path
        out = subprocess.run(["cygpath", "-w", p], capture_output=True, text=True,
                             encoding="utf-8", timeout=5)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    native = (out.stdout or "").strip()  # None when the output did not decode
    return native if out.returncode == 0 and native else None


# ---- identity: the scratchpad is SHARED, so the path cannot say whose it is --
# A read-only agent gets no worktree (agent-isolation.md rule 2), so own_wt above
# is empty for every reviewer — and a reviewer that needs to RUN something makes
# its own checkout under the session scratchpad (rule 4). Until 2026-10-17
# removing that checkout was reported as WORKTREE-REMOVE "not your worktree":
# correct by the letter of the predicate, wrong in substance, six times in one
# session, and the stale checkouts accumulated.
#
# THE FIRST FIX FOR THAT WAS WRONG, AND HOW IT WAS WRONG IS THE USEFUL PART. It
# treated "under my session scratchpad" as "mine", on the premise that the
# harness issues a scratchpad per agent. It does not. Measured 2026-10-18 under
# one session id: ONE flat directory, 190 entries, with the checkouts of about
# ten different agents side by side (checkout, co2, co3, cr-1017,
# cr-pr1021-checkout, cr1016-own ...). So that widening let any agent of the
# session remove any sibling checkout — the PR #544 incident reintroduced
# between siblings, demonstrated by a reviewer with rc 0 on a security
# reviewer checkout.
#
# Note also that the canonical name from the rule, "$SCRATCH/checkout", is a
# SHARED name in a shared directory: two agents of one session that both follow
# the example literally collide (the PR #493 class).
#
# own_scratch therefore means only "inside the shared scratchpad", never "mine".
# It bounds where a record can be honoured; it never grants anything by itself.
own_scratch = ""
m2 = re.match(r"^(?P<sess>(?:/private)?/tmp/claude-[^/]+/[^/]+/[^/]+)(?:/|$)", cwd)
if m2:
    own_scratch = tmp_norm(m2.group("sess"))

# ---- ownership: the only per-agent token the payload carries -----------------
# cwd is shared between siblings (above) and so is session_id. The one field that
# differs per agent is agent_id, which the harness fills from the subagent tool
# context and leaves empty on the main thread (utils/hooks.ts createBaseHookInput
# in the Claude Code source: "Hooks use agent_id presence to distinguish subagent
# calls from main-thread calls").
#
# So ownership of a scratch path is not read off the path at all. It is RECORDED,
# by this hook, at the moment it watches an agent create the worktree: one line
# "<agent_id>\t<literal path>" appended to a ledger in the shared scratchpad. At
# remove time the only scratch paths permitted are the ones recorded against THIS
# agent_id. A sibling checkout has a different agent_id on its line, so it is
# refused exactly like a foreign worktree.
#
# Why that is a check and not a claim: the key is supplied by the harness, not by
# the command, and the line is written by the hook, not by the caller. Two limits,
# both deliberate:
#   - a NON-LITERAL add target (`git worktree add "$SCRATCH/checkout"`) cannot be
#     resolved, so nothing is recorded and the later removal is refused. The
#     remedy is the one WORKTREE-OPAQUE already asks for: expand the path once
#     (`echo "$SCRATCH"`) and use the literal for both add and remove.
#   - a re-dispatched agent is a new agent_id and so cannot remove the checkout of
#     its own previous instance. That is rule 6 working as intended: it cannot
#     know whether that tree is abandoned.
# Without an agent_id (main thread, or a runtime that omits the field) nothing is
# recorded and nothing is permitted — i.e. the behaviour before this widening.
OWNERS = os.environ.get("CROSS_AGENT_WORKTREE_OWNERS", "")
if not OWNERS and own_scratch:
    OWNERS = os.path.join(own_scratch, ".cross-agent-worktree-owners")


def record_owned(path):
    """Append one ledger line. Failure is ignored on purpose: a hook that dies
    over a bookkeeping write would refuse the command it was only observing."""
    if not (OWNERS and agent_id):
        return
    try:
        with open(OWNERS, "a", encoding="utf-8") as fh:
            fh.write("%s\t%s\n" % (agent_id, path))
    except OSError:
        pass


def is_owned(path):
    """True when THIS agent_id has a recorded line for this path (or for a
    directory containing it). The trailing slash is load-bearing: a record of
    .../checkout must not cover .../checkout-sibling."""
    if not (OWNERS and agent_id):
        return False
    try:
        with open(OWNERS, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return False
    for line in lines:
        who, _, owned = line.partition("\t")
        if who != agent_id or not owned:
            continue
        owned = tmp_norm(owned)
        if path == owned or path.startswith(owned + "/"):
            return True
    return False

reasons = []

# ---- the tokenizer of record: cmdscan.scan ------------------------------------
# It reads quotes, heredocs and nested code (exec, bash -c, eval, $( ), backticks,
# find -exec, wrappers), so its segments are judged too: `bash -c "pkill -f node"` and
# `echo $(pkill -f node)` passed the quote-blind split below. A shell that reads a
# heredoc or a here-string on stdin (`bash <<EOF`, `cat <<EOF | sh`) runs that body, so
# the body is scanned as code. Bounded: 64 scans; past it, or past the cmdscan depth,
# the code was not read and the command is refused as NESTED-OPAQUE.
REDIRECT_TOKEN = re.compile(r"^\d*(?:<<<|<<-?|<>|>>?|<|>&|&>>?)")
FD_PATH = re.compile(r"^(?:/dev/fd/|/proc/self/fd/)(\d+)$")
SCRIPT_WORD = re.compile(r"^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(\S+)")


def stdin_feed(argv, fd):
    """The last redirection of `fd` in argv: "heredoc" (`<<`, `<<<`), "redir" (`<`, `<&`,
    `<>`, `<(...)`, whose source is unknown here) or None (inherited)."""
    feed = None
    for a in argv:
        m = re.match(r"^(\d*)(<<<|<<-?|<>|<&|<)", a)
        if m and int(m.group(1) or 0) == fd:
            feed = "heredoc" if m.group(2).startswith("<<") else "redir"
    return feed


def stdin_reader(seg):
    """(reads code from a fd, here-strings it runs, runs a script file, the fd) for a segment."""
    if seg.name not in cmdscan.INTERPRETERS and seg.name not in ("source", "."):
        # `./s.sh`, `scripts/x.sh`, `./deploy`: a file this command may have just written
        # (cmdscan keeps only the basename in seg.name, so the word is read from raw)
        w = SCRIPT_WORD.match(seg.raw)
        return False, [], bool(w) and ("/" in w.group(1) or seg.name.endswith(".sh")), 0
    argv, strings, i = [], [], 0
    while i < len(seg.argv):
        a = seg.argv[i]
        m = REDIRECT_TOKEN.match(a)
        if not m:
            argv.append(a)
        elif m.group(0).endswith("<<<"):
            rest = a[m.end():]
            if rest:
                strings.append(rest)
            elif i + 1 < len(seg.argv):
                i += 1
                strings.append(seg.argv[i])
        elif m.end() == len(a):
            i += 1  # the target of `> file` / `< file`, or the word after `<< ` (a delimiter)
        i += 1
    if seg.name in ("source", "."):
        ops = argv[1:] if argv[:1] == ["--"] else argv
        program, is_code = (ops[0] if ops else None), False
    else:
        program, is_code, flags = cmdscan.shell_program(argv)[:3]
        if any(f[:1] == "-" and f[1:2] != "-" and "s" in f[1:] for f in flags):
            program = None  # `bash -s x y`: x y are positional parameters, code comes on stdin
        if program is None and any(f in ("--version", "--help") for f in flags):
            return False, [], False, 0  # prints and exits, reads no code
    if is_code:
        return False, [], False, 0  # bash -c is read by cmdscan
    fdm = FD_PATH.match(program or "")
    if program is not None and not fdm and program not in ("-", "/dev/stdin"):
        return False, [], True, 0  # a script operand reads its own file
    return True, strings, False, int(fdm.group(1)) if fdm else 0


def heredoc_pass_through(p):
    """`cat <<EOF | sh`: a cat with no file operand prints exactly its heredoc. Any other
    source (`printf x <<EOF | sh`, `cat s.sh <<EOF | sh`) prints what the text does not show."""
    if cmd_name(p.name) != "cat" or stdin_feed(p.argv, 0) != "heredoc":
        return False
    i = 0
    while i < len(p.argv):
        a = p.argv[i]
        m = REDIRECT_TOKEN.match(a)
        if m:
            i += 1 if a[m.end():] else 2  # `<<EOF` / `<< EOF`, `2>&1` / `> f`
            continue
        if a != "-" and not a.startswith("-"):
            return False
        i += 1
    return True


# cmdscan hands every heredoc body of a line to the LAST segment of that line, whoever
# opened it (`bash <<EOF; cat` gives the body to cat). So when a scan holds a shell that
# reads code, every body of that scan is scanned as code, whichever segment carries it.
# The shell is BLIND (NESTED-OPAQUE) when its code comes from a pipe, `<`, `<(...)` or a
# fd with no heredoc of its own: code made at run time, which no reading of the text can
# judge (`echo x | bash`, `bash <(curl ..)`, `echo x | bash 3<<EOF`). Its own heredoc is
# one it opened on that fd (`bash <<EOF`), or, for a pipe, one the segment before it
# opened on stdin (`cat <<EOF | sh`). A shell with nothing on stdin reads nothing.
scanned, work, opaque, runs_file = [], [cmd], False, False
for _ in range(64):
    if not work:
        break
    sc = cmdscan.scan(work.pop())
    opaque = opaque or sc.truncated
    shell_reads = blind = False
    prev = {}  # depth -> the segment before, at that depth
    for g in sc.segments:
        scanned.append(g)
        reads, strings, runs, fd = stdin_reader(g)
        if reads:
            shell_reads = True
            feed = stdin_feed(g.argv, fd)
            if feed == "redir" or (feed is None and fd != 0):
                blind = True
            elif feed is None and g.piped and not strings:
                p = prev.get(g.depth)
                blind = blind or p is None or not heredoc_pass_through(p)
        runs_file = runs_file or runs
        work += strings
        prev[g.depth] = g
    if shell_reads:
        work += [b for g in sc.segments for b in g.heredocs]
    opaque = opaque or blind
opaque = opaque or bool(work)

# ---- split into command segments --------------------------------------------
# Decisions are made on the FIRST TOKEN of a segment, so a pattern quoted as an
# ARGUMENT (grep "pkill", echo "rm -rf") never trips a predicate. A heredoc body is
# data for its command (the scan above judges the one a shell runs), so it is cut out
# before this quote-blind split: `cat <<EOF` with a line `pkill -f node` is a note.
# Only for a consumer that treats its stdin as data: `xargs rm <<EOF` turns the body into
# arguments (its owner is rm), so that body stays in the text every predicate reads.
# Not stripped: inside $( ) (its output can be run: `eval "$(cat <<EOF`), `git apply` /
# `git am` (the body is a patch naming the files it writes), and when the command also
# runs a script file (`cat > s.sh <<EOF ... EOF; bash s.sh` runs the body).
DATA_SINKS = {"cat", "tee", "gh", "git", "jq", "grep", "wc", "head", "tail", "sort"}


def git_sub(argv):
    """The git subcommand: the first word after the global options (-C / -c take a value)."""
    i = 1 if argv[:1] == ["git"] else 0
    while i < len(argv) and argv[i].startswith("-"):
        i += 2 if argv[i] in ("-C", "-c", "--git-dir", "--work-tree", "--namespace") else 1
    return argv[i] if i < len(argv) else None


def written_file_named_again(g):
    """The body goes to a file (`> f`, `>> f`, `tee f`) whose name the command uses again:
    `cat > deploy <<EOF ...; sudo ./deploy` may run it, so the body is not data."""
    files, i = [], 0
    while i < len(g.argv):
        a = g.argv[i]
        m = re.match(r"^\d*(?:>>?|&>>?)(?!&)", a)
        if m:
            if a[m.end():]:
                files.append(a[m.end():])
            elif i + 1 < len(g.argv):
                i += 1
                files.append(g.argv[i])
        elif cmd_name(g.name) == "tee" and not a.startswith("-"):
            files.append(a)
        i += 1
    rest = cmd
    for body in g.heredocs:
        rest = rest.replace(body, "", 1)
    if files and any(s is not g for s in scanned):
        return True  # `make`, `git commit`, `npm run` read Makefile / a hook / a script by convention
    if files and re.search(r"[*?\[$`]", rest):
        return True  # `./*eploy`, `$f`, `$(ls)` may name the file without spelling it
    for f in files:
        base = posixpath.basename(f.rstrip("/"))
        if base and len(re.findall(r"(?<![\w.-])%s(?![\w.-])" % re.escape(base), rest)) > 1:
            return True
    return False


QUOTED = re.compile(r"\\.|(>>?\s*)?(\$\x27(?:[^\x27\\]|\\.)*\x27|\x27[^\x27]*\x27|\"(?:[^\"\\]|\\.)*\")", re.S)


def unquoted(text):
    return QUOTED.sub(lambda m: m.group(0) if m.group(0)[0] == chr(92) or m.group(1) else " ", text)


naive = cmd
for g in scanned:
    # stripped only when this segment opened every body it carries (see cmdscan above);
    # opened counts real openers, so a quoted `\x27<<X\x27` argument does not count
    if cmd_name(g.name) not in DATA_SINKS or g.opened != len(g.heredocs):
        continue
    if runs_file or g.depth > 0 or (cmd_name(g.name) == "git" and git_sub(g.argv) in ("apply", "am")):
        continue
    if written_file_named_again(g):
        continue
    for body in g.heredocs:
        if body.strip():
            naive = naive.replace(body, "", 1)
# Only single-quoted spans are blanked: `$( )` and backticks still run inside double
# quotes (`eval "$(cat <<EOF ...)"`), so a double-quoted span is skipped over, kept whole.
SINGLE_QUOTED = re.compile(r"\\.|\"(?:[^\"\\]|\\.)*\"|(\$\x27(?:[^\x27\\]|\\.)*\x27|\x27[^\x27]*\x27)", re.S)
# ...and only inside a top-level command known to read its arguments as data. Any other
# command may run a quoted argument as code (`ssh host \x27x; pkill -f node\x27`, `git -c
# core.pager=...`, `git rebase -x`, `git grep -O`, `rg --pre`, `sort --compress-program`),
# so its quotes stay in the split. sed counts only when no script word holds an `e` at all
# and no -f script file is named: `sed` may be GNU sed from PATH, whose `e` command and s///e
# flag run code, and its syntax is too loose to recognise (fail-closed).
QUOTE_DATA = {"sed", "grep", "echo", "printf", "gh", "jq", "cat", "head", "tail", "wc"}
QUOTE_DATA_GIT = {"commit", "tag", "log", "show", "diff", "status", "notes"}


def sed_may_exec(argv):
    # a short-option cluster can carry the script (`-ne...`) and long options abbreviate
    # (`--expr=`, `--fi`), so any option word with an e or f counts (fail-closed)
    for a in argv:  # cmdscan argv holds no command name
        if a.startswith("-") and ("e" in a.lstrip("-") or "f" in a.lstrip("-")):
            return True
        if not a.startswith("-") and "e" in a:  # the script, or a file name
            return True
    return False


def quotes_are_data(g):
    n = cmd_name(g.name)
    if g.depth or g.wrappers or g.dynamic:
        return False
    if n == "git":
        return git_sub(g.argv) in QUOTE_DATA_GIT and not any(
            a.startswith(("-c", "--config", "--exec")) for a in g.argv)
    if n == "sed" and sed_may_exec(g.argv):
        return False
    return n in QUOTE_DATA


split_src = naive
for g in scanned:
    if quotes_are_data(g) and g.raw and g.raw in split_src:
        split_src = split_src.replace(
            g.raw, SINGLE_QUOTED.sub(lambda m: " " if m.group(1) else m.group(0), g.raw), 1)
segments = re.split(r"(?:\|\||&&|[;\n|&])", split_src)


# Wrappers that RUN another command. Without unwrapping them, the effective
# command sits in an argument position and every predicate below misses it:
# `find <other worktree> | xargs rm` was a real, reproduced miss (CR-M-1 on
# PR #553). Unwrapping is safe for the false-positive budget because a
# predicate still additionally requires a foreign path to be referenced.
# dev-ttl.sh is the project TTL wrapper: `dev-ttl.sh [--ttl N] -- <command>` (round 3 of #1294).
WRAPPERS = {"xargs", "sudo", "env", "nice", "nohup", "command", "stdbuf", "timeout", "rtk", "dev-ttl.sh", "watch"}
RTK_EXEC = {"bypass", "proxy", "err", "test", "run", "summary"}
# watch long options (procps-ng src/watch.c longopts) -> the short letter of those taking a
# required value, "" for the rest (differences takes its optional value only after =)
WATCH_LONG = {
    "color": "", "no-color": "", "differences": "", "help": "", "interval": "n", "beep": "",
    "errexit": "", "follow": "", "chgexit": "", "equexit": "q", "exec": "", "precise": "",
    "no-rerun": "", "shotsdir": "s", "no-title": "", "no-wrap": "", "version": "",
}
# Wrapper flags that consume the NEXT token as their value.
VALUE_FLAGS = {"-I", "-i", "-n", "-P", "-d", "-E", "-s", "-L", "-a", "-u", "-p"}

# Shell keywords that sit in command position without BEING the command. The
# body of a loop splits as `do <cmd>`, so without stripping these the first
# token is `do` and EVERY predicate below misses — verified 2026-09-02 for
# pkill, killall and git worktree remove alike. The 2026-09-02 incident was
# written exactly this way: `for w in $(...); do git worktree remove "$w"; done`.
KEYWORDS = {"do", "then", "else", "elif", "if", "while", "until", "!", "time"}


def first_token(seg):
    seg = seg.strip()
    if not seg:
        return "", []
    seg = seg.lstrip("(){ \t")
    # bash runs ANSI-C quoted `$(q)pkill(q)` as pkill; shlex leaves `$pkill` (round 3 of #1294).
    seg = cmdscan._ansi_c_alt(seg) or seg
    try:
        parts = shlex.split(seg, comments=True)
    except ValueError:
        parts = seg.split()

    for _ in range(4):  # bounded: `sudo env xargs rm` and the like
        # drop leading env assignments (FOO=bar cmd) and shell keywords (do cmd)
        while parts and (
            re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", parts[0]) or parts[0] in KEYWORDS
        ):
            parts.pop(0)
        if not parts or cmd_name(parts[0]) not in WRAPPERS:
            break
        wrapper = cmd_name(parts.pop(0))
        if wrapper == "dev-ttl.sh":
            if parts and parts[0] == "--ttl":
                parts = parts[2:]
            elif parts and parts[0].startswith("--ttl="):
                parts.pop(0)
            if parts and parts[0] == "--":
                parts.pop(0)
            continue
        if wrapper == "watch":
            # procps-ng watch: getopt_long(argv, "+bCcefd::ghq:n:prs:twvx", WATCH_LONG). n, q, s
            # take a value (glued, or the next word); d takes only a glued one, so in -dn the n
            # is the value of -d. The program is then sh -c of the remaining words.
            while parts and parts[0].startswith("-") and parts[0] not in ("-", "--"):
                flag = parts.pop(0)
                takes = ""
                if flag.startswith("--"):
                    # getopt_long takes a unique prefix (--int 2 is --interval 2); a value after
                    # = is glued; an ambiguous or unknown name makes watch refuse to run
                    name = flag[2:]
                    hits = [o for o in WATCH_LONG if o.startswith(name)] if name else []
                    if "=" not in name and (name in WATCH_LONG or len(hits) == 1):
                        takes = WATCH_LONG[name if name in WATCH_LONG else hits[0]]
                else:
                    for at, ch in enumerate(flag[1:], 1):
                        if ch == "d":
                            break  # the rest of the cluster is its optional value
                        if ch in "nqs":
                            takes = ch if at == len(flag) - 1 else ""  # else the value is glued
                            break
                if parts and takes:
                    # always the next word, as getopt does: watch parses +2, " 2", 2,5 as numbers,
                    # and for a value it rejects it exits before running anything (SR-M-5, CR-H-1)
                    parts.pop(0)
            if parts and parts[0] == "--":
                parts.pop(0)
            try:
                parts = shlex.split(" ".join(parts), comments=True)
            except ValueError:
                parts = " ".join(parts).split()
            # the segment was split at ; before quotes were read, so a quoted program holding
            # a ; arrives with the opening quote glued to its first word; a subshell keeps its (
            while parts:
                parts[0] = parts[0].lstrip("(){ \t\x27\"")
                if parts[0]:
                    break
                parts.pop(0)
            continue
        while parts and parts[0].startswith("-"):
            flag = parts.pop(0)
            if flag in VALUE_FLAGS and parts:
                parts.pop(0)
        # rtk is a proxy: `rtk git status` is `git status`. Its exec subcommands (bypass, proxy,
        # err, test, run, summary) run the rest of the line, optionally as one shell string
        # (--shell SH, run -c STR). Unwrap them and judge the real command (SR-H-1, PR 1157).
        if wrapper == "rtk":
            while parts and parts[0].startswith("-") and parts[0] not in ("-", "--"):
                parts.pop(0)
            if parts and parts[0] in RTK_EXEC:
                parts.pop(0)
                payload = None
                shell_mode = False
                while parts and parts[0].startswith("-") and parts[0] not in ("-", "--"):
                    flag = parts.pop(0)
                    key = flag.split("=", 1)[0]
                    if key == "--shell":
                        shell_mode = True
                        if "=" not in flag and parts:
                            parts.pop(0)
                    elif key in ("-c", "--command"):
                        payload = flag.split("=", 1)[1] if "=" in flag else (parts.pop(0) if parts else "")
                if parts and parts[0] == "--":
                    parts.pop(0)
                if payload is None and shell_mode and parts:
                    payload = " ".join(parts)
                if payload is None and len(parts) == 1 and re.search(r"[\s;&|<>]", parts[0]):
                    payload = parts[0]
                if payload is not None:
                    try:
                        parts = shlex.split(payload)
                    except ValueError:
                        parts = payload.split()
        # `timeout 60 rm ...` — the duration sits where the command would be
        if wrapper == "timeout" and parts and re.match(r"^[0-9.]+[smhd]?$", parts[0]):
            parts.pop(0)

    if not parts:
        return "", []
    return cmd_name(parts[0]), parts[1:]


toks = [first_token(s) for s in segments]
toks += [first_token(g.raw) for g in scanned]
toks += [(cmd_name(g.name), list(g.argv)) for g in scanned if g.name]
if opaque:
    reasons.append(
        "NESTED-OPAQUE|the command nests code (bash -c, $( ), eval, a heredoc for a shell) "
        "deeper than this hook reads, so it cannot say what that code kills or removes. "
        "Run the inner command on its own."
    )


# ---- literal or not? ---------------------------------------------------------
# A token the shell will expand is a token whose value this hook cannot know:
# resolving it would mean RUNNING it. That is a hard limit, not a bug to fix.
# What IS a bug is pretending the limit does not exist — see WORKTREE-OPAQUE.
# `~` is the exception: expanduser is deterministic and runs as the same user,
# so a tilde path can be resolved honestly instead of being called opaque.
NONLITERAL = re.compile(r"[$`*?\[]")


def resolve(tok, base=None):
    """Absolute path for a LITERAL token, relative to base (default cwd). Caller must reject
    non-literals first."""
    t = to_posix(os.path.expanduser(tok))
    if not t.startswith("/"):
        t = posixpath.join(base or cwd, t)
    return posixpath.normpath(t).rstrip("/")


def kill_broadcast(args):
    """`kill -9 -1` signals every process the user owns, `kill 0` the whole process group."""
    if args[:1] and args[0] in ("-l", "-L"):
        return False  # lists signal names, signals nothing
    i = 0
    if args[:1] in (["-s"], ["-n"]):
        i = 2
    elif args[:1] and args[0].startswith("-") and args[0] != "--":
        i = 1  # the signal: `kill -1 1234` is SIGHUP to 1234
    # kill reads a pid as a number: `-01`, `+0`, `-0` and " -1" are -1 and 0 too
    return any(re.fullmatch(r"\s*[+-]?\d+\s*", a) and int(a) in (-1, 0)
               for a in args[i:] if a != "--")

# ---- predicate 1: broadcast process kill (backlog 72 / PR #547) -------------
for name, args in toks:
    # taskkill /IM and /FI are the Windows pkill. /PID names one process, so it stays allowed.
    if name in ("pkill", "killall") or (name == "kill" and kill_broadcast(args)) or (
        name == "taskkill" and any(re.match(r"^[/-]+(im|fi)(:|$)", a, re.I) for a in args)
    ):
        reasons.append(
            "BROADCAST-KILL|`%s` бьёт по шаблону/имени и гасит процессы ЛЮБОГО "
            "агента, не только твои. Именно так PR #547 дважды убил dev-API "
            "параллельно работавшего кодера." % name
        )
        break

# git -c alias.x=... x / --config-env: the alias, not the word after it, is what runs
# (`git -c alias.wr="worktree remove" wr <tree>`, `git -c alias.x="!sh" x`)
for name, args in toks:
    if name == "git" and any(
        a.lower().startswith(("-calias.", "--config-env"))  # config sections ignore case
        or (a == "-c" and k + 1 < len(args) and args[k + 1].lower().startswith("alias."))
        for k, a in enumerate(args)
    ) or (name == "git" and re.search(r"\bGIT_CONFIG_(?:COUNT|KEY_\d+|PARAMETERS)\b", cmd)):
        reasons.append(
            "NESTED-OPAQUE|`git -c alias.*` / `--config-env` defines what the subcommand runs, "
            "so the word after it says nothing about what happens. Run the real git "
            "subcommand directly."
        )
        break

# ---- predicate 2: unregistering a worktree that is not mine (backlog 75/#544) -
for name, args in toks:
    if name != "git" or "worktree" not in args:
        continue
    # `git -C <dir> worktree remove .`: relative targets are read from <dir>, not cwd
    gdir, i, gdir_literal = cwd, 0, True
    while i < len(args) and args[i].startswith("-"):
        if args[i] == "-C" and i + 1 < len(args):
            gdir_literal = gdir_literal and not NONLITERAL.search(args[i + 1])
            gdir = resolve(args[i + 1], gdir)
        i += 2 if args[i] in ("-C", "-c", "--git-dir", "--work-tree", "--namespace") else 1
    if not gdir_literal:
        reasons.append(
            "WORKTREE-OPAQUE|`git -C <dir> worktree ...` with a non-literal <dir>: I cannot "
            "tell which tree the command runs in. Pass the directory as a literal."
        )
        break
    sub = ""
    for a in args[args.index("worktree") + 1:]:
        if not a.startswith("-"):
            sub = a
            break
    if sub and NONLITERAL.search(sub):
        reasons.append(
            "WORKTREE-OPAQUE|`git worktree %s` — подкоманда задана НЕ литералом, "
            "поэтому я не знаю, читающая она (`list`) или разрушающая "
            "(`remove`/`prune`). Напиши подкоманду явно." % sub
        )
        break
    if sub == "prune":
        reasons.append(
            "WORKTREE-PRUNE|`git worktree prune` снимает регистрацию ВСЕХ "
            "worktree, чьи каталоги git считает исчезнувшими — включая чужие "
            "живые. Ты не видишь других агентов и не можешь судить, брошен ли "
            "их worktree (PR #544)."
        )
        break
    if sub == "add":
        # Observation only — `add` creates a tree, it destroys nothing, so no
        # predicate fires here. This is where ownership of a scratch checkout is
        # recorded, while the agent that made it is known.
        #
        # THREE CONDITIONS, AND NONE OF THEM IS DECORATION (review round 2):
        #
        #   absolute          — a target worth recording is an absolute path. This
        #                       is a TRAIT, not a list of options that take a
        #                       value: `git worktree add -b mybranch /p/co` offers
        #                       `mybranch` in argument position, and the earlier
        #                       draft resolved it against cwd and recorded
        #                       <cwd>/mybranch — a path git never creates, named by
        #                       whoever wrote the branch name. Enumerating -b/-B/
        #                       --reason instead would break the quiet way this
        #                       repo was bitten by twice this month (the pre-push
        #                       prefix list, the commit-type list).
        #   below own_scratch — strictly below, by at least one component. The
        #                       scratch ROOT must never be recorded: is_owned
        #                       matches prefixes, so one root line would make
        #                       every sibling checkout "mine" and re-open the very
        #                       defect this ledger was written to close.
        #   does not exist    — THE LOAD-BEARING HALF. A PreToolUse hook records
        #                       BEFORE git runs, so without this test
        #                       `git worktree add <a live sibling checkout>` fails
        #                       in git and still leaves a line claiming it, and the
        #                       next `remove` is permitted: PR #544 between
        #                       siblings in two commands. A tree that already
        #                       exists is not a tree this command is about to
        #                       create. Do not simplify this away.
        #
        # Residual, stated because it cannot be closed from PreToolUse: if the add
        # fails for an unrelated reason (bad sha) the line survives for a path that
        # was never created, so a sibling that later picks the SAME literal path
        # could have it removed by this agent. It needs both agents to choose one
        # name, which is why rule 4 now asks for a name of your own rather than
        # `checkout`. Closing it properly needs a PostToolUse companion that
        # records only after git reports success.
        for a in args[args.index("worktree") + 1:]:
            if a == "add" or NONLITERAL.search(a):
                continue
            t = to_posix(os.path.expanduser(a))
            if not t.startswith("/"):
                continue
            cand = tmp_norm(posixpath.normpath(t).rstrip("/"))
            if not own_scratch or not cand.startswith(own_scratch + "/"):
                continue
            native = native_path(cand)
            if native is None or os.path.exists(native):
                continue  # unconvertible counts as existing: never record what may be live
            record_owned(cand)
        continue  # a later worktree command on the line is judged too
    if sub in ("remove", "move"):
        targets = [a for a in args[args.index("worktree") + 1:]
                   if not a.startswith("-") and a != sub and not REDIRECT_TOKEN.match(a)]
        if sub == "move":
            targets = targets[:1]  # `git worktree move <tree> <new-path>`: the tree is the first
        if not targets:
            # `xargs git worktree remove <<EOF` / `... | xargs git worktree remove`:
            # the path arrives on stdin, so whose tree it is cannot be read here
            reasons.append(
                "WORKTREE-OPAQUE|`git worktree remove` without a literal path: the path "
                "comes from stdin (xargs, a pipe, a heredoc), so I cannot tell whose tree "
                "it is. Pass each path as a literal argument, one command per tree."
            )
        if re.search(r"\b(?:xargs|find)\b", cmd):  # cmdscan unwraps both, so read the text
            # `xargs -I{} git worktree remove {}`, `find .. -exec git worktree remove {} ;`:
            # any word may be the placeholder (`-I /x/ph`), filled in at run time
            reasons.append(
                "WORKTREE-OPAQUE|`git worktree remove` under xargs / find: the path is "
                "filled in at run time, so I cannot tell whose tree it is. Pass each path "
                "as an absolute literal, one command per tree."
            )
            targets = []
        for t in targets:
            # Third outcome: OWN / FOREIGN / UNKNOWN. Before this existed the
            # token "$w" was joined onto cwd, landed inside own_wt, and hit the
            # `continue` below — so "I could not check" was recorded as "I
            # checked, it is yours". That is how the 2026-09-02 cleanup loop
            # removed two live reviewer checkouts while the LITERAL form of the
            # same command was refused.
            if NONLITERAL.search(t):
                reasons.append(
                    "WORKTREE-OPAQUE|`git worktree remove %s` — путь задан НЕ "
                    "литералом (переменная / подстановка / glob). Развернуть его "
                    "я не могу: для этого пришлось бы его выполнить. Значит я не "
                    "знаю, ЧЕЙ это каталог, и промолчать не имею права — молчание "
                    "здесь неотличимо от «проверил, всё чисто». Разверни путь сам "
                    "и передай явным литералом (`echo %s`): свой я пропущу, чужой "
                    "назову. Убираешь пачкой — по одному." % (t, t)
                )
                continue
            t_abs = resolve(t, gdir)
            if own_wt and (t_abs == own_wt or t_abs.startswith(own_wt + "/")):
                continue  # removing my own worktree is fine
            t_tmp = tmp_norm(t_abs)
            in_scratch = own_scratch and (
                t_tmp == own_scratch or t_tmp.startswith(own_scratch + "/")
            )
            if in_scratch and is_owned(t_tmp):
                continue  # recorded against THIS agent_id when it made the tree
            if in_scratch:
                reasons.append(
                    "WORKTREE-UNRECORDED|`git worktree remove %s` — этот путь в "
                    "ОБЩЕМ scratchpad сессии (там лежат чекауты всех агентов "
                    "сессии, а не только твои), и записи о том, что его создал "
                    "ТЫ, у меня нет. Поэтому я не знаю, чей он. Запись делается "
                    "при создании, если путь задан литералом: разверни "
                    "переменную один раз (echo), и дальше используй литерал и в "
                    "`add`, и в `remove`. Чужой стух — сообщи оркестратору, он "
                    "видит всех агентов, а ты нет." % t
                )
                continue
            reasons.append(
                "WORKTREE-REMOVE|`git worktree remove %s` — это НЕ твой worktree "
                "(твой: %s). На PR #544 ровно эта команда снесла worktree "
                "ревьюера, ждавшего следующего раунда, и выбросила его в общий "
                "чекаут." % (t, own_wt or own_scratch or "<не в worktree>")
            )
        continue

# ---- predicate 3: mutating another agent tree or the shared checkout --------
# (backlog 27 / PR #493, backlog 100 / PR #551)
MUTATORS = {
    "rm", "rmdir", "mv", "cp", "tee", "truncate", "dd", "chmod", "chown",
    "ln", "install", "patch", "touch", "mkdir", "unlink", "rsync",
}
MUTATING_GIT = {
    "checkout", "restore", "reset", "clean", "stash", "apply", "revert",
    "merge", "rebase", "commit", "add", "rm", "mv", "switch", "cherry-pick", "am",
}


def is_mutating(name, args):
    if name in MUTATORS:
        return True
    if name == "sed" and any(a == "-i" or a.startswith("-i") for a in args):
        return True
    # `find <path> -delete` and `find <path> -exec rm {} \;` — the mutation is
    # an ARGUMENT of find. Only a mutating -exec payload counts, so
    # `find <path> -exec grep ...` stays allowed.
    if name == "find":
        if "-delete" in args:
            return True
        for i, a in enumerate(args):
            if a in ("-exec", "-execdir", "-ok") and i + 1 < len(args):
                if cmd_name(args[i + 1]) in MUTATORS:
                    return True
    if name == "git":
        return git_sub(args) in MUTATING_GIT  # `git -C <dir> clean`: -C takes a value
    return False


mutating = any(is_mutating(n, a) for n, a in toks)
# a redirect into a path is a mutation regardless of the command doing it. A quoted
# word is data unless it is the target itself (`sed "s|a|b 2>\&1|"` redirects nothing),
# so quoted spans are blanked first; nested code is read through the scanned segments.
# An escaped character outside quotes is matched first and kept, so `\x27` or `\"` there
# opens no span: `echo \x27 > f \x27` still redirects into f. `$\x27...\x27` is ANSI-C
# quoted, where a backslash escapes the closing quote too.


redirect_targets = re.findall(
    r">>?\s*([^\s;|&()]+)", "\n".join([unquoted(naive)] + [unquoted(g.raw) for g in scanned]))

if mutating or redirect_targets:
    # read without heredoc bodies: a note that names a worktree path is not a mutation of it
    seen = "\n".join([naive] + [g.raw for g in scanned]).replace(chr(92), "/")
    referenced = set(re.findall(r"[^\s\"\x27;|&()]*/\.claude/worktrees/([^/\s\"\x27;|&()]+)", seen))
    referenced |= set(re.findall(r"[^\s\"\x27;|&()]*/\.t3/worktrees/[^/\s\"\x27;|&()]+/([^/\s\"\x27;|&()]+)", seen))
    foreign = sorted(s for s in referenced if s != own_seg)
    if foreign:
        reasons.append(
            "FOREIGN-WORKTREE|команда мутирует дерево другого агента "
            "(.claude/worktrees/%s; твой — %s). На PR #551 ревьюер именно так "
            "откатывал файл в ЖИВОМ worktree работающего кодера ради проверки "
            "красноты." % (", ".join(foreign), own_seg or "<не в worktree>")
        )
    elif repo_root:
        # mutation aimed at the shared checkout itself (not via .claude/worktrees/)
        # The redirect regex reads raw text, so a quoted target keeps its quotes.
        cand = [t.strip("\x22\x27") for t in redirect_targets]
        for n, a in toks:
            if is_mutating(n, a):
                cand += [x for x in a if not x.startswith("-")]
        hits = []
        for c in map(to_posix, cand):
            if not c.startswith("/"):
                continue
            c_norm = posixpath.normpath(c)
            if c_norm.lower().startswith(repo_root.lower() + "/") and "/.claude/worktrees/" not in c_norm:
                hits.append(c)
        if hits:
            reasons.append(
                "SHARED-CHECKOUT|команда мутирует ОБЩИЙ чекаут по абсолютному "
                "пути (%s), а не твой worktree (%s). Это рецидивирующая "
                "MAIN-контаминация (zone-of-write.md FM-2)."
                % (", ".join(sorted(set(hits))[:3]), own_wt)
            )
    if in_t3 and not foreign:
        # T3 keeps every worktree of a project side by side, so a directory above
        # mine (`rm -rf ~/.t3/worktrees`, `rm -rf ..`) holds the trees of others too.
        cand = [t.strip("\x22\x27") for t in redirect_targets]
        for n, a in toks:
            if is_mutating(n, a):
                cand += [x for x in a if not x.startswith("-")]
        def braces(s):
            # bash brace expansion, so `{..,x}/t3-y` and `..{/t3-y,}` are judged as each word it makes.
            m = re.search(r"\{([^{}]*,[^{}]*)\}", s)
            if not m:
                return [s]
            return [y for alt in m.group(1).split(",")
                    for y in braces(s[:m.start()] + alt + s[m.end():])][:64]
        up = []
        for c, w in [(c, y) for c in cand for y in braces(c)]:
            # `~+` is $PWD and `~-` is $OLDPWD; expanduser leaves both alone.
            w = re.sub(r"^~\+(?=/|$)", cwd, re.sub(r"^~-(?=/|$)", "$OLDPWD", w))
            p = to_posix(os.path.expandvars(os.path.expanduser(w) if w.startswith("~") else w))
            # A glob or an unknown variable (`../*`, `$X/y`) is judged by the directory
            # of its literal prefix; with no literal prefix, by the current directory.
            g = re.search(r"[*?\[$\x60]", p)
            if g:
                pre = p[:g.start()]
                # `..$X` is `..` itself when X is empty.
                p = pre if pre.endswith("/") or posixpath.basename(pre) in (".", "..") else posixpath.dirname(pre)
            p = posixpath.normpath(posixpath.join(cwd, p or ".")).lower().rstrip("/")
            mine = own_wt.lower().rstrip("/")
            if mine.startswith(p + "/") or (
                    (p + "/").startswith(posixpath.dirname(mine) + "/")
                    and p != mine and not p.startswith(mine + "/")):
                up.append(c)
        if up:
            reasons.append(
                "FOREIGN-WORKTREE|the command changes a directory above or next to "
                "your T3 worktree (%s), where the worktrees of other agents are. Yours: %s."
                % (", ".join(sorted(set(up))[:3]), own_wt)
            )

for r in reasons:
    print(r)
