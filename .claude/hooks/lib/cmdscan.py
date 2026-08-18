r"""cmdscan.py — "what does this command line actually RUN?" for the pre:bash:* hooks.

WHY THIS EXISTS (backlog 63 + 106, 2026-08-18)
----------------------------------------------
Three hooks used to decide by substring over the raw command line. A word in
ANY position tripped them, so all three refused on plain reading:

    git show <ref>:pnpm-lock.yaml | grep -n vite   -> live-db-guard BLOCK,
                                                      devserver-ttl-gate BLOCK
    echo "... DROP DATABASE crm_db ..."            -> safety BLOCK (reproduced
                                                      four times on 2026-08-17/18,
                                                      once on the command that was
                                                      writing a PR description —
                                                      and once on the probe command
                                                      written to demonstrate it)

The cost of that is not a lost minute. The documented workaround sits inside the
refusal text itself, so two false hits are enough to train "prepend the prefix and
retry" — and that reflex then fires on a REAL launch too. A guard that cries wolf
is a guard that gets routed around.

The fix is NOT to relax any predicate. It is to answer a different question:
instead of "does this string contain X", ask "is X the command being executed".
`echo "rm -rf /"` and `rm -rf /` differ only in which token sits in command
position — nowhere else. So command position is the thing to look at.

WHY A SHARED FILE, when every other hook inlines its python (pre-bash-safety.sh,
pre-bash-cross-agent-blast.sh): the two launcher hooks (live-db-guard,
devserver-ttl-gate) must agree, token for token, on what "a dev-server launch"
is. They already carried the same LAUNCHER regex copy-pasted into both, with a
header comment blessing the duplication — and that is exactly why narrowing one
of them would have left the other refusing the same honest `grep`. One
definition, one place, one test. Hook-SPECIFIC policy (which env vars are safe,
which TTL wrapper is required, which safety predicates exist) deliberately stays
inline in each hook, where a reader of that hook can see it.

CONFIDENCE, NOT JUST FAILURE (rewritten after security review of PR #561)
-------------------------------------------------------------------------
The first version had exactly one conservative trigger: `shlex` raising
ValueError. Everything else was trusted. A security review then produced 13
reproduced pairs "main blocked -> this PR allows", and in EVERY one of them the
parser had not failed — it had answered confidently and WRONG:

    sudo -s rm -rf /etc   ->  name='etc'    (`-s` swallowed as a flag value)
    env -i pnpm dev       ->  name='dev'    (same)
    { rm -rf /etc ; }     ->  name='{'      (grouping token read as a command)
    if …; then rm …; fi   ->  name='then'   (shell keyword read as a command)
    (git push --force …)  ->  name='(git'   (subshell parens glued to the word)
    find . -exec rm … \;  ->  name='find'   (the -exec payload never looked at)
    script -q /dev/null … ->  name='script' (wrapper not in the list)

The measure of how bad that is: `sudo -s rm -rf /etc` was blocked when the
analyzer was BROKEN (degraded fallback) and allowed when it worked. A broken
guard was stricter than a working one.

So the trust boundary moved. A segment is now CONFIDENT only if all of this
holds:

  - the line tokenised cleanly (no ValueError);
  - the command word is not produced by a substitution or a variable;
  - the command word looks like a command name (not `{`, `!`, `then`, `5`, …);
  - every wrapper that was unwrapped has an EXACT model here (`script`,
    `parallel`, `watch`, `flock`, `su` are marked inexact on purpose — their
    argument grammars differ between BSD and GNU);
  - the command itself is one this module claims to understand (UNDERSTOOD).

Anything else is UNCERTAIN, and an uncertain segment is not judged by its
command word at all. It is judged by `readings()`: every "what if the real
command starts at token i" reading of the segment, re-expanded through quoted
sub-strings, each run through the SAME predicates. `script -q /dev/null pnpm dev`
therefore blocks because one of its readings IS `pnpm dev` — no wrapper list
needed. That is the property the wrapper list could never have: it fails toward
blocking on the wrapper nobody has heard of yet.

The cost is false positives on unknown commands that carry launcher-looking or
rm-looking arguments. That is the deliberate trade: a false positive costs a
minute, a miss costs the owner's database.

WHAT IT STILL DOES NOT DO — it does not evaluate the shell.

STATED GAPS (accepted, same line pre-bash-cross-agent-blast.sh draws):
  - the command text produced by a substitution: `sh -c "$(cat run.sh)"`;
  - a launcher inside a script file this scanner cannot read: `./boot.sh`;
  - indirection through a variable: `C="pnpm dev"; $C` (the value is not
    tracked across segments).
`eval "<code>"` is NOT in that list — its argument is parsed as code, because
trying to fool the first version of this scanner showed `eval 'pnpm dev'` and
`eval 'rm -rf /etc'` slipping through while the old substring rule had caught
them. Closing a gap found by execution beat every gap found by reading.

CONTRACT
--------
    scan(command_line) -> Scan
      .segments  list[Segment], in execution order, nested ones included
      .assigns   {NAME: value} — line-wide UNION of every assignment. Kept for
                 debugging only: policy must read Segment.env, because a prefix
                 on one segment does not reach another (see MED-5 of the review:
                 `DATABASE_URL=…/crm_qa echo ok && pnpm dev` gives the launch
                 NOTHING).
      .code_view raw text minus quoted spans and heredoc bodies (for the
                 handful of predicates that are about syntax, e.g. fork bombs)
      .degraded  True if some segment had to be split naively (unbalanced
                 quotes). Per-segment this shows up as .confident = False.
      .truncated True if MAX_DEPTH stopped the walk with nested code unread.
                 The hooks refuse on it: "I did not look" is not "nothing there".

    Segment
      .name      basename of the effective command ("" if none)
      .argv      tokens after it
      .payload   every literal token of the segment + attached heredoc bodies —
                 the DATA surface (what the command would read), as opposed to
                 what it EXECUTES
      .wrappers  wrapper chain that was unwrapped to reach .name
                 (e.g. ["sudo", "env"], or ["dev-ttl.sh"])
      .env       the environment this segment actually runs with: assignments
                 exported by EARLIER segments, plus its own inline prefix and
                 its own `env VAR=v`
      .dynamic   command word could not be resolved statically
      .confident the parse of THIS segment can be trusted to name the command
      .why       when not confident: why not (human-readable, ends up in the
                 refusal text so the reader can see what confused the analyzer)
      .raw       the segment's source text

    readings(seg) -> [Segment]   # conservative re-readings of an uncertain one
    is_dev_server_launch(seg) -> str | None   # label, e.g. "pnpm dev"
    launches(scan) -> [(Segment, label)]      # confidence-aware

Python 3.9+ (macOS system python3 and ubuntu-latest runners both satisfy it).
"""

import os
import re
import shlex

MAX_DEPTH = 6
READING_ARGV_WINDOW = 64


# ── wrapper models ────────────────────────────────────────────────────────────
# Commands that RUN another command. Each carries its OWN flag grammar: the
# first version used one global VALUE_FLAGS set for every wrapper, which is how
# `env -i pnpm dev` came to mean "run `dev`" — `-i` takes no value for `env`,
# but did for `xargs`, and one set cannot be both.
#
#   value_flags — consume the NEXT token as their value
#   code_flags  — consume the next token AS A COMMAND LINE (parsed, not ignored)
#   operands    — positional operands belonging to the wrapper before the
#                 command starts (`chroot <dir> cmd`), or "duration" for timeout
#   exact       — False when the real grammar varies between BSD and GNU, or is
#                 too rich to model. Such a segment is never trusted; it goes
#                 through readings() as well. Unwrapping is still attempted,
#                 because a good guess plus a conservative fallback beats either
#                 one alone.
#
# UNKNOWN FLAGS ARE TREATED AS BOOLEAN on purpose. If that guess is wrong the
# command word becomes some flag's value — which then fails the plausibility or
# the UNDERSTOOD test and lands in readings() anyway. The wrong guess degrades
# into caution instead of into silence.
def _w(value_flags=(), code_flags=(), operands=0, exact=True):
    return {
        "value_flags": frozenset(value_flags),
        "code_flags": frozenset(code_flags),
        "operands": operands,
        "exact": exact,
    }


WRAPPER_SPEC = {
    "sudo": _w(value_flags=(
        "-u", "--user", "-g", "--group", "-U", "--other-user", "-p", "--prompt",
        "-C", "--close-from", "-r", "--role", "-t", "--type", "-h", "--host",
        "-D", "--chdir", "-R", "--chroot", "-T", "--command-timeout",
    )),
    "doas": _w(value_flags=("-u", "-C")),
    "env": _w(value_flags=("-u", "--unset", "-C", "--chdir", "-S", "--split-string")),
    "nice": _w(value_flags=("-n", "--adjustment")),
    "ionice": _w(value_flags=(
        "-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid",
        "-u", "--uid",
    )),
    "nohup": _w(),
    "setsid": _w(),
    "stdbuf": _w(value_flags=("-i", "--input", "-o", "--output", "-e", "--error")),
    "command": _w(),
    "builtin": _w(),
    "exec": _w(value_flags=("-a",)),
    "time": _w(value_flags=("-f", "--format", "-o", "--output")),
    "timeout": _w(
        value_flags=("-s", "--signal", "-k", "--kill-after"), operands="duration",
    ),
    "xargs": _w(value_flags=(
        "-I", "-i", "--replace", "-L", "--max-lines", "-n", "--max-args",
        "-P", "--max-procs", "-s", "--max-chars", "-a", "--arg-file",
        "-E", "-e", "--eof", "-d", "--delimiter",
    )),
    "npx": _w(value_flags=("-p", "--package", "--node-arg"), code_flags=("-c", "--call")),
    "bunx": _w(),
    "unbuffer": _w(value_flags=("-p",)),
    "caffeinate": _w(value_flags=("-t", "-w")),
    "strace": _w(value_flags=("-o", "--output", "-e", "-p", "-s", "-E", "-P", "-b")),
    "ltrace": _w(value_flags=("-o", "-e", "-p", "-s", "-l", "-n")),
    "chroot": _w(value_flags=("--userspec", "--groups"), operands=1),
    # ── inexact on purpose (see `exact` above) ──
    "script": _w(code_flags=("-c", "--command"), operands=1, exact=False),
    "parallel": _w(value_flags=("-j", "--jobs", "-N", "-d", "--colsep", "-S"), exact=False),
    "watch": _w(value_flags=("-n", "--interval"), exact=False),
    "flock": _w(
        value_flags=("-w", "--wait", "--timeout", "-E", "--conflict-exit-code"),
        code_flags=("-c", "--command"), operands=1, exact=False,
    ),
    "su": _w(value_flags=("-s", "--shell", "-g", "--group"),
             code_flags=("-c", "--command"), operands=1, exact=False),
    "runuser": _w(value_flags=("-s", "--shell", "-g", "--group"),
                  code_flags=("-c", "--command"), operands=1, exact=False),
    # the project's own TTL wrapper: `dev-ttl.sh [--ttl N] -- <command>`
    "dev-ttl.sh": _w(),
}

INTERPRETERS = {"sh", "bash", "zsh", "dash", "ksh", "ash"}

# Commands this module claims to understand well enough to judge by name alone:
# either it models them (`node`, `pnpm`, `rm`, `git`) or they demonstrably do not
# execute an argument as a command line (`grep`, `ls`, `cat`). Everything NOT
# here is uncertain — which is the point. This list is allowed to be incomplete;
# incompleteness costs a false positive, never a miss. Add to it only for
# commands whose argument handling you have actually checked.
UNDERSTOOD = set(INTERPRETERS) | {
    # text in, text out
    "echo", "printf", "cat", "tee", "head", "tail", "grep", "egrep", "fgrep",
    "rg", "ag", "wc", "sort", "uniq", "cut", "tr", "diff", "comm", "column",
    "pbcopy", "pbpaste", "jq", "yq", "base64", "shasum", "md5", "sha1sum",
    "sha256sum", "fold", "paste", "join", "rev", "expand", "unexpand", "nl",
    "strings", "xxd", "od", "bat",
    # shell builtins / trivia
    "true", "false", ":", "test", "[", "cd", "pwd", "source", ".", "export",
    "set", "unset", "shift", "read", "wait", "sleep", "date", "seq", "expr",
    "basename", "dirname", "realpath", "readlink", "which", "type", "whoami",
    "id", "hostname", "uname", "sw_vers", "printenv", "alias", "history",
    # filesystem
    "ls", "stat", "file", "find", "mkdir", "rmdir", "rm", "cp", "mv", "ln",
    "touch", "chmod", "chown", "du", "df", "tar", "zip", "unzip", "gzip",
    "gunzip", "mktemp", "install", "rsync", "diskutil",
    # processes / network
    "ps", "pgrep", "pkill", "kill", "killall", "lsof", "top", "uptime",
    "curl", "wget", "ping", "dig", "nslookup", "host", "nc", "ssh", "scp",
    "openssl", "launchctl",
    # this project's toolchain (each modelled below or provably not a launcher)
    "git", "gh", "node", "python", "python3", "pip", "pip3", "pnpm", "npm",
    "yarn", "turbo", "bun", "vite", "nest", "tsc", "vitest", "playwright",
    "prettier", "eslint", "tsx", "psql", "pg_dump", "pg_restore", "createdb",
    "dropdb", "pg_isready", "redis-cli", "brew",
}

ASSIGN_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", re.S)
HEREDOC_RE = re.compile(r"^<<(-?)\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\2")
OPERATORS = ("||", "&&", ";;", ";", "|", "&", "\n")
SUBST_MARKER = "$__CMDSCAN_SUBST__"

# Grouping tokens and reserved words. `{ rm -rf /etc ; }` and
# `if true; then rm -rf /etc; fi` used to report `{` and `then` as the command.
SHELL_KEYWORDS = {
    "{", "}", "(", ")", "!", "if", "then", "elif", "else", "fi", "while",
    "until", "do", "done", "for", "in", "case", "esac", "select", "function",
    "coproc", "[[", "]]",
}

# A command name, as opposed to punctuation, a number, or a fragment of syntax.
COMMAND_WORD_RE = re.compile(r"^[A-Za-z0-9_@.+:^%~/-][A-Za-z0-9_@.+:^%~/,-]*$")


def _plausible_command_word(name):
    if not name or name in SHELL_KEYWORDS:
        return False
    if name.startswith("-"):
        return False
    if name.isdigit():
        return False
    return bool(COMMAND_WORD_RE.match(name))


class Segment:
    __slots__ = (
        "name", "argv", "payload", "wrappers", "dynamic", "raw", "depth",
        "env", "confident", "why",
    )

    def __init__(self, name, argv, payload, wrappers, dynamic, raw, depth,
                 env=None, confident=True, why=None):
        self.name = name
        self.argv = argv
        self.payload = payload
        self.wrappers = wrappers
        self.dynamic = dynamic
        self.raw = raw
        self.depth = depth
        self.env = env if env is not None else {}
        self.confident = confident
        self.why = why

    def positionals(self, value_flags=()):
        """argv minus flags and the values consumed by `value_flags`."""
        out = []
        skip = False
        for tok in self.argv:
            if skip:
                skip = False
                continue
            if tok.startswith("-") and tok != "-":
                if tok in value_flags:
                    skip = True
                continue
            out.append(tok)
        return out

    def text(self):
        """Everything the segment carries as data, joined — for phrase lookups."""
        return "\n".join(self.payload)

    def __repr__(self):  # debugging aid only
        return "Segment(name=%r, argv=%r, wrappers=%r, confident=%r, why=%r)" % (
            self.name, self.argv, self.wrappers, self.confident, self.why,
        )


class Scan:
    __slots__ = ("segments", "assigns", "code_view", "degraded", "truncated")

    def __init__(self, segments, assigns, code_view, degraded, truncated=False):
        self.segments = segments
        self.assigns = assigns
        self.code_view = code_view
        self.degraded = degraded
        # True when MAX_DEPTH stopped the scan with nested code still unread.
        # There is no honest verdict about code that was never looked at, so the
        # hooks refuse instead of reporting "nothing found" — dropping it quietly
        # is the same failure this whole rewrite is about.
        self.truncated = truncated


# ── stage 1: command substitutions ────────────────────────────────────────────
# $( ... ) and ` ... ` RUN commands, so their contents are parsed as commands of
# their own. In command position they leave a marker, so the segment's command
# word reads as unresolvable (dynamic) rather than as the literal "$(".
def _extract_substitutions(text):
    out = []
    inners = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "'":  # single quotes suppress substitution entirely
            j = text.find("'", i + 1)
            j = n - 1 if j < 0 else j
            out.append(text[i:j + 1])
            i = j + 1
            continue
        if ch == "\\" and i + 1 < n:
            out.append(text[i:i + 2])
            i += 2
            continue
        if text.startswith("$(", i):
            depth = 1
            j = i + 2
            while j < n and depth:
                if text[j] == "(":
                    depth += 1
                elif text[j] == ")":
                    depth -= 1
                j += 1
            inners.append(text[i + 2:j - 1] if depth == 0 else text[i + 2:])
            out.append(SUBST_MARKER)
            i = j
            continue
        if ch == "`":
            j = text.find("`", i + 1)
            j = n if j < 0 else j
            inners.append(text[i + 1:j])
            out.append(SUBST_MARKER)
            i = j + 1
            continue
        out.append(ch)
        i += 1
    return "".join(out), inners


# ── stage 2: quote-aware segmentation + heredoc capture ───────────────────────
# A heredoc body is DATA, never code: `cat > pr-body.md <<EOF ... EOF` must not
# be read as running whatever the body happens to spell. It is attached to the
# segment that opened it, so `psql <<EOF ... EOF` still exposes the SQL as that
# segment's payload — the consuming command is what decides, not the text.
#
# Grouping is a separator too (review HIGH-2): `( … )` starts a subshell and a
# standalone `{` / `}` starts a group, so `(pnpm dev)` and `{ rm -rf /etc ; }`
# must break into their own segments instead of yielding `(pnpm` and `{` as
# command words. Braces only count when they stand alone as a word — `-I{}`
# (xargs) and `{}` (find) are ordinary tokens.
def _brace_stands_alone(text, i):
    """True when text[i] (`{` or `}`) is a word of its own, i.e. shell grouping.

    `{ rm -rf /etc ; }` groups; `-I{}` (xargs) and `{}` (find -exec) do not.
    """
    before = text[i - 1] if i > 0 else " "
    after = text[i + 1] if i + 1 < len(text) else " "
    left = i == 0 or before.isspace() or before in ";&|"
    right = i + 1 == len(text) or after.isspace() or after in ";&|)"
    return left and right


def _split_segments(text):
    segs = []
    cur = []
    cur_heredocs = []
    code = []
    pending = []
    quote = None
    i = 0
    n = len(text)

    def flush():
        raw = "".join(cur).strip()
        if raw or cur_heredocs:
            segs.append((raw, list(cur_heredocs)))
        del cur[:]
        del cur_heredocs[:]

    while i < n:
        ch = text[i]

        if quote is not None:
            cur.append(ch)
            if ch == "\\" and quote == '"' and i + 1 < n:
                cur.append(text[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue

        if ch in ("'", '"'):
            quote = ch
            cur.append(ch)
            i += 1
            continue

        if ch == "\\" and i + 1 < n:
            cur.append(ch)
            cur.append(text[i + 1])
            code.append(text[i + 1])
            i += 2
            continue

        if text.startswith("<<", i) and not text.startswith("<<<", i):
            m = HEREDOC_RE.match(text[i:])
            if m:
                pending.append((m.group(3), m.group(1) == "-"))
                cur.append(m.group(0))
                code.append(m.group(0))
                i += m.end()
                continue

        if ch == "\n" and pending:
            i += 1
            for delim, strip_tabs in pending:
                body = []
                while i < n:
                    j = text.find("\n", i)
                    line = text[i:] if j < 0 else text[i:j]
                    i = n if j < 0 else j + 1
                    cand = line.lstrip("\t") if strip_tabs else line
                    if cand.strip() == delim:
                        break
                    body.append(line)
                cur_heredocs.append("\n".join(body))
            pending = []
            flush()
            continue

        # subshell parens: always a boundary (they are shell metacharacters,
        # and $( ) was already lifted out in stage 1)
        if ch in "()":
            flush()
            code.append(" %s " % ch)
            i += 1
            continue

        # group braces: only when the brace stands alone as a word
        if ch in "{}" and _brace_stands_alone(text, i):
            flush()
            code.append(" %s " % ch)
            i += 1
            continue

        op = None
        for cand in OPERATORS:
            if text.startswith(cand, i):
                op = cand
                break
        if op is not None:
            flush()
            code.append(" %s " % op)
            i += len(op)
            continue

        cur.append(ch)
        code.append(ch)
        i += 1

    flush()
    return segs, "".join(code)


# ── stage 3: tokenise + unwrap ────────────────────────────────────────────────
def _tokenize(raw):
    try:
        return shlex.split(raw, comments=False), False
    except ValueError:
        # Unbalanced quote / stray backslash. Fall back to a naive split and SAY
        # SO — a caller that treats a degraded parse as a clean "nothing found"
        # is how a guard goes quiet without anyone noticing.
        return raw.split(), True


def _strip_keywords(tokens):
    i = 0
    while i < len(tokens) and tokens[i] in SHELL_KEYWORDS:
        i += 1
    return tokens[i:]


def _consume_flags(tokens, spec, code_out):
    while tokens and tokens[0].startswith("-") and tokens[0] not in ("-", "--"):
        flag = tokens.pop(0)
        key = flag.split("=", 1)[0]
        if key in spec["code_flags"]:
            if "=" in flag:
                code_out.append(flag.split("=", 1)[1])
            elif tokens:
                code_out.append(tokens.pop(0))
        elif key in spec["value_flags"] and "=" not in flag and tokens:
            tokens.pop(0)
    return tokens


def _unwrap(tokens, assigns):
    """Drop keywords, leading assignments and wrappers; reach the real command.

    Returns (tokens, wrappers, inexact_wrapper, nested_code).
    """
    wrappers = []
    inexact = None
    nested_code = []
    for _ in range(MAX_DEPTH):
        tokens = _strip_keywords(tokens)
        while tokens:
            m = ASSIGN_RE.match(tokens[0])
            if not m:
                break
            assigns[m.group(1)] = m.group(2)
            tokens.pop(0)
        tokens = _strip_keywords(tokens)
        if not tokens:
            break
        base = os.path.basename(tokens[0])
        spec = WRAPPER_SPEC.get(base)
        if spec is None:
            break
        wrappers.append(base)
        tokens.pop(0)
        if not spec["exact"] and inexact is None:
            inexact = base
        if base == "dev-ttl.sh" and "--" in tokens:
            # Its contract is `dev-ttl.sh [--ttl N] -- <command>`; everything
            # before the `--` is the wrapper's own business.
            tokens = tokens[tokens.index("--") + 1:]
            continue
        tokens = _consume_flags(tokens, spec, nested_code)
        if tokens and tokens[0] == "--":
            tokens.pop(0)
        if spec["operands"] == "duration":
            if tokens and re.match(r"^[0-9.]+[smhd]?$", tokens[0]):
                tokens.pop(0)
        else:
            for _ in range(spec["operands"]):
                if tokens and not tokens[0].startswith("-"):
                    tokens.pop(0)
        # flags may follow the wrapper's own operands (`flock /tmp/l -c '…'`)
        tokens = _consume_flags(tokens, spec, nested_code)
        if base == "env":
            while tokens and ASSIGN_RE.match(tokens[0]):
                m = ASSIGN_RE.match(tokens.pop(0))
                assigns[m.group(1)] = m.group(2)
    return tokens, wrappers, inexact, nested_code


# `find … -exec <command> \;` runs <command>. shlex turns `\;` into `;`.
FIND_EXEC_FLAGS = ("-exec", "-execdir", "-ok", "-okdir")


def _find_exec_commands(argv):
    out = []
    i = 0
    while i < len(argv):
        if argv[i] in FIND_EXEC_FLAGS:
            body = []
            i += 1
            while i < len(argv) and argv[i] not in (";", "+"):
                body.append(argv[i])
                i += 1
            if body:
                out.append(" ".join(shlex.quote(t) for t in body))
        i += 1
    return out


def _build_segment(raw, tokens, heredocs, running_env, depth, degraded):
    payload = list(tokens) + list(heredocs)
    own = {}
    toks, wrappers, inexact, nested = _unwrap(list(tokens), own)

    env = dict(running_env)
    env.update(own)

    if not toks:
        empty = Segment("", [], payload, wrappers, False, raw, depth, env, True, None)
        return empty, nested, {}

    word = toks[0]
    name = os.path.basename(word)
    argv = toks[1:]
    dynamic = SUBST_MARKER in word or "$" in word

    # `export FOO=bar` really does override the inherited environment for every
    # LATER segment — that is what makes it different from a `VAR=v cmd` prefix,
    # which reaches only the command it is glued to (review MED-5).
    exports = {}
    if name == "export":
        for tok in argv:
            m = ASSIGN_RE.match(tok)
            if m:
                exports[m.group(1)] = m.group(2)
        env.update(exports)

    # `eval "<script>"` — its arguments are concatenated and executed as code.
    # Found by trying to fool the narrowed hooks, not by reading them: without
    # this branch `eval "pnpm dev"` and `eval "rm -rf /etc"` both slipped
    # through, while the old substring rule had caught them.
    if name == "eval" and argv:
        nested.append(" ".join(argv))

    # `sh -c "<script>"` — the script is code, not an argument. Parse it.
    if name in INTERPRETERS:
        for idx, tok in enumerate(argv):
            if tok.startswith("-") and "c" in tok[1:] and idx + 1 < len(argv):
                nested.append(argv[idx + 1])
                break

    if name == "find":
        nested.extend(_find_exec_commands(argv))

    # ── the confidence verdict ────────────────────────────────────────────────
    why = None
    if degraded:
        why = "строка не разобралась (незакрытые кавычки)"
    elif dynamic:
        why = "командное слово вычисляется (подстановка или переменная)"
    elif inexact:
        why = "обёртка `%s` не имеет однозначной грамматики аргументов" % inexact
    elif not _plausible_command_word(name):
        why = "командное слово `%s` не похоже на имя команды" % name
    elif name not in UNDERSTOOD:
        why = "команда `%s` не входит в список разбираемых" % name

    seg = Segment(name, argv, payload, wrappers, dynamic, raw, depth, env,
                  why is None, why)
    return seg, nested, exports


def _expand_token(tok):
    """Split a token that itself carries a command line (`su -c 'pnpm dev'`)."""
    if not tok or not any(c.isspace() for c in tok):
        return [tok]
    try:
        parts = shlex.split(tok, comments=False)
    except ValueError:
        parts = tok.split()
    return parts or [tok]


def readings(seg):
    """Every "the real command might start HERE" reading of an uncertain segment.

    This is the answer to "what do we do about a parse we cannot trust". Not a
    coarse substring rule (that was the disease), and not a longer wrapper list
    (that only ever covers the wrappers someone remembered) — the SAME
    predicates, applied to every position the command could actually begin at,
    with quoted sub-commands expanded. `script -q /dev/null pnpm dev` blocks
    because one of its readings is literally `pnpm dev`.

    Confident segments never go through here: `grep -n vite` is understood, so
    its `vite` argument is an argument. That is the whole difference between
    this and the substring rule it replaces.
    """
    if seg.confident:
        return []
    toks = []
    for tok in ([seg.name] if seg.name else []) + list(seg.argv):
        toks.extend(_expand_token(tok))
    out = []
    for i, word in enumerate(toks):
        base = os.path.basename(word)
        if not _plausible_command_word(base):
            continue
        # EVERY position is read — the window bounds only how far each reading
        # looks for its arguments. Truncating the position list instead would
        # have created a bypass by padding (`unknowncmd <300 args> pnpm dev`),
        # and no predicate here inspects more than a handful of arguments.
        out.append(Segment(
            base, toks[i + 1:i + 1 + READING_ARGV_WINDOW], seg.payload,
            seg.wrappers, False, seg.raw, seg.depth, seg.env, True, None,
        ))
    return out


def candidates(seg):
    """The segment itself, plus its conservative re-readings when uncertain."""
    return [seg] + readings(seg)


def scan(command_line, depth=0, env=None):
    text, inners = _extract_substitutions(command_line or "")
    raw_segments, code_view = _split_segments(text)

    segments = []
    assigns = {}
    degraded = False
    truncated = False
    running_env = dict(env or {})

    def recurse(inner, inner_env):
        sub = scan(inner, depth + 1, inner_env)
        segments.extend(sub.segments)
        assigns.update(sub.assigns)
        return sub.code_view, sub.degraded, sub.truncated

    for raw, heredocs in raw_segments:
        tokens, deg = _tokenize(raw)
        degraded = degraded or deg
        seg, nested, exports = _build_segment(
            raw, tokens, heredocs, running_env, depth, deg,
        )
        segments.append(seg)
        assigns.update(seg.env)
        # exports outlive their segment; an inline prefix does not.
        running_env.update(exports)
        if depth < MAX_DEPTH:
            for inner in nested:
                # `DATABASE_URL=… sh -c '<launch>'` really does hand the prefix
                # to the inner command, so the inner scan inherits seg.env.
                view, deg2, trunc2 = recurse(inner, seg.env)
                code_view += "\n" + view
                degraded = degraded or deg2
                truncated = truncated or trunc2
        elif nested:
            truncated = True

    if depth < MAX_DEPTH:
        for inner in inners:
            view, deg2, trunc2 = recurse(inner, running_env)
            code_view += "\n" + view
            degraded = degraded or deg2
            truncated = truncated or trunc2
    elif inners:
        truncated = True

    return Scan(segments, assigns, code_view, degraded, truncated)


# ── the shared "is this a dev-server launch" predicate ────────────────────────
# Same surface the two launcher hooks matched with their shared LAUNCHER regex —
# nest start / vite / pnpm|npm|yarn|turbo dev / node ... dist/main — but decided
# on the COMMAND WORD instead of on a substring.
PKG_RUNNERS = {"pnpm", "npm", "yarn", "turbo", "bun"}
# Package-manager subcommands that are definitely not "run a script".
PKG_NON_RUN = {
    "add", "remove", "rm", "install", "i", "update", "up", "why", "list", "ls",
    "audit", "publish", "store", "config", "link", "unlink", "init", "create",
    "licenses", "outdated", "pack", "prune", "rebuild", "root", "setup", "test",
    "build", "lint", "typecheck", "format",
}
PKG_VALUE_FLAGS = {"--filter", "-F", "-C", "--dir", "--workspace", "-r"}
DEV_SCRIPT_RE = re.compile(r"^dev(:[A-Za-z0-9_.-]+)?$")
NODE_VALUE_FLAGS = {
    "-e", "--eval", "-p", "--print", "-r", "--require", "--import",
    "--experimental-loader", "--loader", "--conditions", "--max-old-space-size",
}
DIST_MAIN_RE = re.compile(r"(^|/)dist/main(\.[cm]?js)?$")

# The old coarse regex, kept for ONE purpose: deciding a DYNAMIC command word
# (`$(echo pnpm) dev`) conservatively. Never used to decide a resolvable one.
LEGACY_LAUNCHER_RE = re.compile(
    r"(^|[/\s])nest(\.js)?\s+start"
    r"|(^|[/\s])vite(\s|$)"
    r"|(^|\s)(pnpm|npm|yarn|turbo)(\s+(-\S+|--filter\s+\S+|run))*\s+dev(:start)?(\s|$)"
    r"|node\s[^;|&]*dist/main"
)


def is_dev_server_launch(seg):
    """Return a human label if this segment actually boots a dev server."""
    name = seg.name

    if seg.dynamic:
        # Command word behind a substitution/variable (`$(echo pnpm) dev`,
        # `$RUNNER dev`). Nothing here can resolve it, so decide conservatively:
        # the old coarse test on this segment, PLUS "an argument that looks like
        # a dev script / the built API". Strictly wider than the pre-narrowing
        # behaviour, so a dynamic launcher cannot become an allow.
        if LEGACY_LAUNCHER_RE.search(seg.raw):
            return "динамическая команда"
        for tok in seg.positionals():
            if DEV_SCRIPT_RE.match(tok) or DIST_MAIN_RE.search(tok):
                return "динамическая команда (%s)" % tok
        return None

    if name == "vite":
        return "vite"

    if name in ("nest", "nest.js"):
        pos = seg.positionals()
        if pos and pos[0] == "start":
            return "nest start"
        return None

    if name in PKG_RUNNERS:
        pos = seg.positionals(PKG_VALUE_FLAGS)
        if not pos:
            return None
        if pos[0] in ("exec", "dlx", "x", "run-script"):
            # `pnpm exec vite` — the real command follows.
            inner = pos[1:]
            if inner and os.path.basename(inner[0]) == "vite":
                return "%s exec vite" % name
            return None
        if pos[0] in PKG_NON_RUN:
            return None
        for tok in pos:
            if DEV_SCRIPT_RE.match(tok):
                return "%s %s" % (name, tok)
        return None

    if name == "node":
        pos = seg.positionals(NODE_VALUE_FLAGS)
        # Only the SCRIPT argument counts. `node -e "...dist/main..."` prints a
        # string; it does not boot the API.
        if pos and DIST_MAIN_RE.search(pos[0]):
            return "node %s" % pos[0]
        return None

    return None


def launches(scan_result):
    """[(Segment, label)] for every segment that boots a dev server.

    An uncertain segment contributes its readings() instead of itself, so the
    returned Segment is the one that carries the launch — its `.wrappers` and
    `.env` are the ones the caller must judge (the TTL gate asks whether the
    LAUNCHING segment was wrapped; the live-db guard asks what environment the
    LAUNCHING segment gets).
    """
    out = []
    for seg in scan_result.segments:
        for cand in candidates(seg):
            label = is_dev_server_launch(cand)
            if label:
                if not seg.confident:
                    label = "%s — %s" % (label, seg.why)
                out.append((cand, label))
                break
    return out
