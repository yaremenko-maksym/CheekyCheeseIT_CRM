"""cmdscan.py — "what does this command line actually RUN?" for the pre:bash:* hooks.

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

WHAT IT DOES NOT DO — it does not evaluate the shell. Values behind variables
(`C="pnpm dev"; $C`), `eval`, and a launcher hidden inside a script this hook
cannot read stay unresolved. Those are marked `dynamic` and handed back to the
caller, which falls back to the old coarse substring test for that segment —
conservative by construction: an unresolvable command word can never turn a
would-be block into an allow.

CONTRACT
--------
    scan(command_line) -> Scan
      .segments  list[Segment], in execution order, nested ones included
      .assigns   {NAME: value} — every assignment that really assigns
                 (segment prefix, `env VAR=v`, `export VAR=v`); an assignment
                 that is merely QUOTED inside an argument is not one
      .code_view raw text minus quoted spans and heredoc bodies (for the
                 handful of predicates that are about syntax, e.g. fork bombs)
      .degraded  True if some segment had to be split naively (unbalanced
                 quotes). The caller decides what to do with it; nothing here
                 silently pretends the parse succeeded.

    Segment
      .name      basename of the effective command ("" if none)
      .argv      tokens after it
      .payload   every literal token of the segment + attached heredoc bodies —
                 the DATA surface (what the command would read), as opposed to
                 what it EXECUTES
      .wrappers  wrapper chain that was unwrapped to reach .name
                 (e.g. ["sudo", "env"], or ["dev-ttl.sh"])
      .dynamic   command word could not be resolved statically
      .raw       the segment's source text

    is_dev_server_launch(seg) -> str | None   # label, e.g. "pnpm dev"

Python 3.9+ (macOS system python3 and ubuntu-latest runners both satisfy it).
"""

import os
import re
import shlex

MAX_DEPTH = 6

# Commands that RUN another command; unwrapped so the effective command is the
# one judged. Same list as pre-bash-cross-agent-blast.sh, plus the interpreters
# and the project's own TTL wrapper.
WRAPPERS = {
    "sudo", "doas", "env", "nice", "ionice", "nohup", "command", "builtin",
    "stdbuf", "timeout", "xargs", "setsid", "time", "exec", "npx", "bunx",
    "dev-ttl.sh",
}
# Wrapper flags that consume the NEXT token as their value.
VALUE_FLAGS = {"-I", "-i", "-n", "-P", "-d", "-E", "-s", "-L", "-a", "-u", "-p", "-k"}
INTERPRETERS = {"sh", "bash", "zsh", "dash", "ksh", "ash"}

ASSIGN_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", re.S)
HEREDOC_RE = re.compile(r"^<<(-?)\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\2")
OPERATORS = ("||", "&&", ";;", ";", "|", "&", "\n")
SUBST_MARKER = "$__CMDSCAN_SUBST__"


class Segment:
    __slots__ = ("name", "argv", "payload", "wrappers", "dynamic", "raw", "depth")

    def __init__(self, name, argv, payload, wrappers, dynamic, raw, depth):
        self.name = name
        self.argv = argv
        self.payload = payload
        self.wrappers = wrappers
        self.dynamic = dynamic
        self.raw = raw
        self.depth = depth

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
        return "Segment(name=%r, argv=%r, wrappers=%r, dynamic=%r)" % (
            self.name, self.argv, self.wrappers, self.dynamic,
        )


class Scan:
    __slots__ = ("segments", "assigns", "code_view", "degraded")

    def __init__(self, segments, assigns, code_view, degraded):
        self.segments = segments
        self.assigns = assigns
        self.code_view = code_view
        self.degraded = degraded


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


def _unwrap(tokens, assigns):
    """Drop leading assignments and command wrappers; return (tokens, wrappers)."""
    wrappers = []
    for _ in range(MAX_DEPTH):
        while tokens:
            m = ASSIGN_RE.match(tokens[0])
            if not m:
                break
            assigns[m.group(1)] = m.group(2)
            tokens.pop(0)
        if not tokens:
            break
        base = os.path.basename(tokens[0])
        if base not in WRAPPERS:
            break
        wrappers.append(base)
        tokens.pop(0)
        if base == "dev-ttl.sh" and "--" in tokens:
            # Its contract is `dev-ttl.sh [--ttl N] -- <command>`; everything
            # before the `--` is the wrapper's own business.
            tokens = tokens[tokens.index("--") + 1:]
            continue
        # wrapper flags (and their values)
        while tokens and tokens[0].startswith("-") and tokens[0] != "--":
            flag = tokens.pop(0)
            if flag in VALUE_FLAGS and tokens:
                tokens.pop(0)
        if tokens and tokens[0] == "--":
            tokens.pop(0)
        if base == "timeout" and tokens and re.match(r"^[0-9.]+[smhd]?$", tokens[0]):
            tokens.pop(0)
        if base == "env":
            while tokens and ASSIGN_RE.match(tokens[0]):
                m = ASSIGN_RE.match(tokens.pop(0))
                assigns[m.group(1)] = m.group(2)
    return tokens, wrappers


def _build_segment(raw, tokens, heredocs, assigns, depth):
    payload = list(tokens) + list(heredocs)
    tokens = list(tokens)
    tokens, wrappers = _unwrap(tokens, assigns)

    nested = []
    if not tokens:
        return Segment("", [], payload, wrappers, False, raw, depth), nested

    word = tokens[0]
    name = os.path.basename(word)
    argv = tokens[1:]
    dynamic = SUBST_MARKER in word or "$" in word

    # `export FOO=bar` really does override the inherited environment, so it
    # counts as an assignment (the live-db-guard's whole subject).
    if name == "export":
        for tok in argv:
            m = ASSIGN_RE.match(tok)
            if m:
                assigns[m.group(1)] = m.group(2)

    # `sh -c "<script>"` — the script is code, not an argument. Parse it.
    if name in INTERPRETERS:
        for idx, tok in enumerate(argv):
            if tok.startswith("-") and "c" in tok[1:] and idx + 1 < len(argv):
                nested.append(argv[idx + 1])
                break

    return Segment(name, argv, payload, wrappers, dynamic, raw, depth), nested


def scan(command_line, depth=0):
    text, inners = _extract_substitutions(command_line or "")
    raw_segments, code_view = _split_segments(text)

    segments = []
    assigns = {}
    degraded = False

    for raw, heredocs in raw_segments:
        tokens, deg = _tokenize(raw)
        degraded = degraded or deg
        seg, nested = _build_segment(raw, tokens, heredocs, assigns, depth)
        segments.append(seg)
        if depth < MAX_DEPTH:
            for inner in nested:
                sub = scan(inner, depth + 1)
                segments.extend(sub.segments)
                assigns.update(sub.assigns)
                code_view += "\n" + sub.code_view
                degraded = degraded or sub.degraded

    if depth < MAX_DEPTH:
        for inner in inners:
            sub = scan(inner, depth + 1)
            segments.extend(sub.segments)
            assigns.update(sub.assigns)
            code_view += "\n" + sub.code_view
            degraded = degraded or sub.degraded

    return Scan(segments, assigns, code_view, degraded)


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

# The old coarse regex, kept verbatim for ONE purpose: deciding an unresolvable
# (dynamic) command word conservatively. Never used to decide a resolvable one.
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
    """[(Segment, label)] for every segment that boots a dev server."""
    out = []
    for seg in scan_result.segments:
        label = is_dev_server_launch(seg)
        if label:
            out.append((seg, label))
    return out
