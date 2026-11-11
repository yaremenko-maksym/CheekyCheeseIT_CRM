# The analyzer of pre-bash-live-db-guard.sh (pre:bash:live-db-guard).
# Run by that hook as a FILE: `python3 -I -B <this file>`, the hook payload (JSON) on
# stdin, CMDSCAN_LIB in the environment. Exit 0 = allow, 10 = block (the decision JSON
# on stdout); anything else is an analyzer failure, which the hook reports as such.
# It is not a `python3 -c` argument because Windows caps a whole command line at
# 32767 characters, and this body had reached 32056 (a launch failure there is rc 126).
import importlib.util, json, os, re, shlex, sys, urllib.parse

# By absolute path, not via sys.path — see the note in pre-bash-safety.sh.
_spec = importlib.util.spec_from_file_location(
    "cmdscan", os.path.join(os.environ["CMDSCAN_LIB"], "cmdscan.py"))
cmdscan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cmdscan)

data = json.load(sys.stdin)
cmd = (data.get("tool_input") or {}).get("command") or ""
cwd = (data.get("cwd") or "").replace("\\", "/")  # Windows payloads use backslashes
if not cmd:
    sys.exit(0)

# Same worktree/scratchpad context gate as the sibling hook — the owner s
# main checkout is out of scope by design.
CONTEXT = re.compile(r"\.claude/worktrees/|\.t3/worktrees/|/tmp/claude-|AppData/Local/Temp/claude", re.I)
if not CONTEXT.search(cmd.replace("\\", "/")) and not CONTEXT.search(cwd):
    sys.exit(0)

scan = cmdscan.scan(cmd)
# cmdscan.launches() is confidence-aware: a segment whose command word it could
# not resolve is judged by every reading of it, so `script -q /dev/null pnpm dev`
# and `env -i pnpm dev` land here too. Broken quoting is one such case, which is
# why the old `scan.degraded` special case is gone — it covered the one failure
# mode that never actually happened, and none of the 13 the review found.
hits = cmdscan.launches(scan)

# Nesting deeper than the analyzer walks leaves code unread. An unread launch is
# not an absent launch, so it is refused with an env of its own (i.e. nothing
# proven safe) rather than reported as clean.
if scan.truncated:
    hits = hits + [(
        cmdscan.Segment("", [], [], [], False, cmd, 0, {}, False, None),
        "nesting deeper than the parse limit — the code was not read",
    )]

if not hits:
    sys.exit(0)

# SR-H-13: EVERY launch in the command is judged, not only the first. A command with a
# safe launch first and a live one second used to be allowed, because only hits[0] was
# looked at. judge() is the whole of the per-launch decision; the loop below unions
# the reasons of all launches.
def judge(seg):
    segs = [seg]

    # The environment of the LAUNCHING segment, not of the line. A prefix on some
    # other segment reaches nothing: `DATABASE_URL=…/crm_qa API_PORT=3011 echo ok &&
    # pnpm dev` gives the launch exactly nothing and inherits the live pair — the
    # shape of PR #485 (review MED-5).
    env = seg.env
    reasons = []

    # ── which database does this launch reach? ───────────────────────────────────
    # History: this used to be `db.rsplit("/")[-1].split("?")[0] == "crm_db"`. pg
    # percent-DECODES the name before connecting, so `crm%5Fdb` IS the live
    # database while the comparison saw the encoded text (PR #579 closed the same
    # hole in seed-db-guard.ts / integration-db-guard.ts; the TS helper
    # assert-not-live-db.ts is the shape this follows).
    #
    # It then took two security-review rounds to see that "decode, then compare"
    # is still a parser differential: dot segments, a query-string `dbname`, a
    # non-postgres scheme and an unescaped "/" in the password each make this
    # hook read a different name than libpq resolves. So the rule is not "spot
    # the live name in every spelling" (an enumeration of attacker encodings
    # that cannot be finished) but an ALLOWLIST OF SHAPE: after one decode and a
    # trim the name must be `[A-Za-z0-9_]+` and must not be exactly `crm_db`;
    # anything else - including a name that cannot be determined at all - is
    # refused. Case-sensitive on purpose, as Postgres identifiers are: `CRM_DB`
    # is another database. A name with a hyphen is refused too; scratch names here
    # are `crm_qa`-style, and the refusal message says why.
    LIVE = "crm_db"
    NAME_SHAPE = re.compile(r"^[A-Za-z0-9_]+$")
    DB_PARAMS = ("dbname", "db", "database")

    def name_problems(name, where):
        if name == "":
            return ["cannot determine the database name from %s - an unknown target is not a safe one" % where]
        if name == LIVE:
            return ["%s names the live database crm_db (%s)" % (where, name)]
        if not NAME_SHAPE.match(name):
            return ["%s database name %r is not a plain [A-Za-z0-9_]+ name - a path that is not a plain name may resolve differently in libpq than here, so it is refused" % (where, name)]
        return []

    def url_problems(url):
        where = "DATABASE_URL"
        # A "#" is refused outright. urlsplit cuts the string at "#" and so sees an
        # EMPTY query, while libpq ends the path only at "?" and still applies a
        # "?dbname=" that follows the fragment: `postgres://h/scratch#?dbname=crm_db`
        # is crm_db in libpq (measured with PQconnectStart + PQdb on libpq 15, and in
        # a fuzz of 142,272 URLs: all 360 that this hook allowed and libpq resolved
        # to crm_db contained "#"). node-pg, which the API uses, does not do this,
        # so today no launch path is exposed - but this hook claims libpq parity, and
        # a guard that claims parity with a consumer and lacks it is worse than one
        # that states its limits. A real scratch URL has no use for a fragment.
        if "#" in url:
            return ["%s contains a # fragment - libpq reads past it, this hook does not, so the database it reaches cannot be determined (write %%23 if a literal # is meant)" % where]
        # A "$" or a backtick means the SHELL rewrites the value after this hook read
        # it: `export U="h/crm_db?"` then `DATABASE_URL=postgres://$U/qa` becomes
        # `postgres://h/crm_db?/qa`, which pg-connection-string (the API Pool) resolves
        # to crm_db. The hook reads text; the process gets the expansion. A password
        # with a "$" must be percent-encoded (%24).
        if "$" in url or chr(96) in url:
            return ["%s contains shell expansion ($ or a backtick) - the shell rewrites it after this hook reads it, so the database it reaches cannot be determined (percent-encode a literal $ as %%24)" % where]
        try:
            sp = urllib.parse.urlsplit(url.strip())
            params = urllib.parse.parse_qsl(sp.query, keep_blank_values=True)
        except ValueError:
            return ["cannot determine the database name from %s (unparseable) - an unknown target is not a safe one" % where]
        if sp.scheme not in ("postgres", "postgresql"):
            return ["%s scheme %r is not postgres/postgresql - cannot tell which database it reaches" % (where, sp.scheme)]
        if not sp.path.startswith("/"):
            return ["cannot determine the database name from %s (no path) - an unknown target is not a safe one" % where]
        problems = name_problems(urllib.parse.unquote(sp.path[1:]).strip(), where + " path")
        # libpq honours `dbname` in the query string over the path, so
        # `.../scratch?dbname=crm_db` reaches the live database while the path says
        # `scratch`. Keys are decoded and case-folded (`dbn%61me`, `DBNAME`).
        for key, value in params:
            k = key.strip().lower()
            if k in DB_PARAMS:
                problems += name_problems(value.strip(), where + " ?" + k)
        # `options` is deliberately NOT inspected: it carries server settings (-c
        # name=value) and cannot select a database, so a check there does no work
        # and would trip on an unrelated setting that merely contains the text
        # crm_db_x. Do not add it back without a measurement showing it selects one.
        return problems

    db = env.get("DATABASE_URL")
    if db is None:
        reasons.append(
            "DATABASE_URL is not set inline on this command — it is inherited from "
            "the session environment, not from the worktree .env (dotenv does NOT "
            "overwrite an already-set process.env variable). That is exactly how "
            "PR #485 leaked."
        )
    elif db != "":
        for problem in url_problems(db):
            reasons.append(problem)

    # ── THE QUESTION THIS HOOK KEEPS HAVING TO ASK ──────────────────────────────
    # "What else can libpq take the database from?" The path; a query-string
    # dbname=; a #fragment that libpq reads past and urlsplit does not; PGDATABASE;
    # a service file (PGSERVICE / PGSERVICEFILE - it BEATS PGDATABASE, measured);
    # and, when none of those names one, the USER NAME (PGUSER=crm_db is crm_db -
    # measured in libpq 15 and in node-pg). Each of these was found by a reviewer
    # after the check before it had "closed" the hole. The "#" refusal and the strict
    # PGDATABASE rule below are one lesson twice: wherever libpq resolves the database
    # from something this hook does not read, require an EXPLICIT value on the command
    # line instead of enumerating the ways round it. Whoever adds the next check asks
    # that question first, and measures the answer (PQconnectStart + PQdb against an
    # unreachable port - no server, no credential) rather than reading documentation.
    #
    # THAT AXIS IS NOW CLOSED, MEASURED: a differential fuzz of about 1.86M URLs (security
    # review of this PR) found zero URLs this hook allows that libpq resolves to the live
    # database. THE OPEN AXIS IS THE OTHER ONE, and it needs its own question every time:
    # "what can change the value between the text this hook reads and the process that
    # parses it?" Two answers so far, both refused rather than modelled:
    #   * the SHELL - a "$" or a backtick in DATABASE_URL (`export U="h/crm_db?"` then
    #     `DATABASE_URL=postgres://$U/qa` is `postgres://h/crm_db?/qa`, which the API
    #     Pool resolves to crm_db), and any assignment of the pinned names that is not a
    #     LEADING word of the launch (a look-alike argument after the launcher pins
    #     nothing - that decoy switched the whole rule off once);
    #   * `env` - `env -i`, `-u`, `--unset`, `-S` rewrite the environment after the pin
    #     was read (`env -u PGDATABASE` undoes it, and PGUSER=crm_db then wins).
    # That list kept growing - env was found by a regex, then by a tokenizer that knew
    # the option list, then spelled `$E`, a brace expansion or a glob, then given an
    # operand (`env -P /usr/bin -u ...`, which also let a pin be FORGED). Four review
    # rounds, four HIGH findings, one cause: this hook computing from text what bash
    # will do. So the answer is no longer a list. It is the STRONGEST form of the
    # standing rule below - FAIL CLOSED ON ANYTHING THE HOOK CANNOT RESOLVE TO A
    # LITERAL: the command word must be a plain literal AND the launcher cmdscan
    # resolved, and a dash-led word after env is refused outright (see launch_shape).
    # THE TRIPWIRE FIRED in the fifth round (SR-H-16, SR-H-17: shell functions, aliases,
    # PATH shims, startup files - not closable by reading text). The authoritative check
    # moved to the dev-server start itself (a preflight reading the database it really
    # connected to; backlog entry 247) and this hook is ADVISORY - see STATUS at the top.
    # A hook can never be bash.
    #
    # STANDING RULE OF THIS FILE: DELETE AN APPROXIMATION BEFORE ADDING A CLEVERER ONE.
    # Every hole found here had one shape - the hook re-implemented the parsing of
    # another tool with its own approximation: percent-decoding, the # fragment, the dbname
    # query key, the libpq user-name fallback, shell expansion, the whole-segment pin
    # match, the env regex, the PGSERVICE regex. The fixes that stuck stopped
    # approximating: urlsplit plus an allowlist of shape instead of a pattern for the
    # live name, an explicit pinned value instead of enumerated redirections, one shlex
    # walk (launch_shape) that REFUSES what it cannot read instead of an env option list,
    # assignments() instead of a PGSERVICE pattern.
    # When this file needs to know what a shell, libpq, pg or env will do, it asks a
    # parser or demands an explicit allowlisted value; it does not grow a pattern.
    # STILL APPROXIMATIONS, and the next candidates for the same treatment: ENV_LOAD and
    # assignments() (regexes over the command text). Both fail closed, and both run over
    # TWO views of the command (raw text and the shlex-normalized text) and refuse if
    # EITHER matches - see both_views(). That union is deliberate: normalizing loses
    # statement boundaries (a source on its own line), the raw text cannot see through
    # spliced quotes, and the hook cannot know which one bash will follow.
    #
    # A check added to this hook needs a decoy case in its test group (an argument that
    # merely looks like the thing being checked): without one, reverting the check turns
    # nothing red and the revert count measures the tests, not the rule.
    #
    # Door 3 of 3 (path, query string, environment). A URL that names a database wins
    # over PGDATABASE (measured, libpq and node-pg), so the environment decides only
    # when DATABASE_URL is the explicit empty string. THEN the rule is strict:
    # PGDATABASE must be pinned INLINE on the launching segment itself, non-empty and
    # an allowlisted name. That one requirement also defeats an inherited PGDATABASE,
    # an inherited PGUSER, and every way of exporting, loading or setting the variable
    # earlier in the command (export, declare -x, typeset -x, set -a, source, eval,
    # printf -v, read, ${V:=}) - an inline prefix beats all of them, so none needs to
    # be enumerated. What it costs: `DATABASE_URL= vite --port 3010` (a web server that
    # never opens a connection) is refused until it also says PGDATABASE=crm_qa. One
    # token, printed in the refusal; judged cheaper than a hook that cannot be sure.
    # An EMPTY PGDATABASE is refused too: it is the case where libpq falls back to the
    # user name, so it is not a way to scrub anything.
    #
    # PGSERVICE / PGSERVICEFILE are refused in every case, even with PGDATABASE pinned,
    # because a service file overrides it. A PGSERVICE inherited from the session is
    # not observable (the hook reads the command line, not the environment) - the same
    # blind spot as any inherited variable, and the only one left standing.
    def normalized(text):
        # The command as shlex reads it: quotes resolved, `;` `&` `|` `(` `)` split out.
        # Regexes below run over THIS, not over the raw text, so that quote-splicing
        # (a variable name or the word source spliced with empty quotes) cannot hide
        # from them (SR-M-11).
        # Comments are switched off, or a # would silently truncate the command.
        try:
            lex = shlex.shlex(text, posix=True, punctuation_chars=True)
            lex.whitespace_split = True
            lex.commenters = ""
            return " ".join(lex)
        except ValueError:
            return text

    ncmd = normalized(cmd)

    # TWO VIEWS, ALLOWED ONLY IF BOTH AGREE. `cmd` is the raw text; `ncmd` resolves
    # quote-splicing but FLATTENS the command - newlines vanish, so a pattern anchored on
    # the start of a statement (source .env on its own line) stops matching there. Neither
    # view is authoritative, and this hook cannot be bash, so it does not choose: every
    # check that reads text runs over BOTH and refuses if EITHER matches. Do not delete the
    # "redundant" raw-text pass - it is the one that sees statement boundaries; the
    # normalized pass is the one that sees through spliced quotes.
    def both_views(fn):
        return fn(cmd) or fn(ncmd)

    def assignments(name):
        n = r"(?<![A-Za-z0-9_])" + name
        def count(text):
            return (len(re.findall(n + r"\+?=", text))
                    + len(re.findall(r"\bprintf\s+-v\s+" + name + r"\b", text))
                    + len(re.findall(r"\bread\b[^;&|\n]*" + n + r"\b", text))
                    + len(re.findall(r"\$\{" + name + r":?=", text)))
        return max(count(cmd), count(ncmd))

    # ── the launch must be written PLAINLY (SR-H-5/6/8/9, SR-M-7/12, SRP-M-3) ───────
    # Four security rounds found four HIGHs, and every one was a new spelling of one
    # thing: this hook computing, from text, what bash will do. `env -u` was found by a
    # regex, then by a tokenizer that knew the option list, then spelled `$E`, `$-ANSI-C-quoted env`,
    # `{env,-u,PGDATABASE}`, `/usr/bin/en?`, then given an operand (`env -P /usr/bin -u`)
    # so that the walk counted a pin that real env had swallowed. The strongest form of
    # the standing rule is therefore not a better parser but a refusal: if the hook
    # cannot resolve the launch to literals, the launch is REFUSED and the refusal says
    # so. The closed definition of "plain":
    #   * leading words are only NAME=value assignments, the literal word env (a literal
    #     basename, shape-checked), and dev-ttl.sh [--ttl N] -- ;
    #   * a word directly after env is an assignment, a command word, or exactly --;
    #     ANY other dash-led word is refused (env -u/-i/-S/-C/-P/-v/lone - - all of
    #     them; none is needed for a launch, and options take operands the hook would
    #     have to model);
    #   * the first other word is the command word. It must be a plain literal
    #     ([A-Za-z0-9_./@+-]+) AND must be the launcher cmdscan resolved (seg.name).
    #     A computed word ($E, $(...), `...`, {a,b}, globs), or a wrapper the hook does
    #     not model (command, exec -c, sudo, npx...), fails one of the two.
    # Developers lose nothing they need: `NAME=value NAME=value vite --port 3010` is
    # plain by construction.
    ASSIGN_WORD = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\+?=")
    PLAIN_WORD = re.compile(r"^[A-Za-z0-9_./@+-]+$")
    # "write the launcher directly" is advice nobody can act on unless it names the forms.
    # These run the same thing without a runner or wrapper in between (node flags for the
    # api: `node --inspect apps/api/dist/main`, or the flag through NODE_OPTIONS in front
    # of the pnpm launch).
    LAUNCHER_FORMS = ("`node --inspect apps/api/dist/main` (api, built), "
                      "`NODE_OPTIONS=--inspect pnpm --filter @crm/api dev` (api, dev), "
                      "`vite --port 3010` (web) - each with the DATABASE_URL / PGDATABASE / port prefix")
    DEVTTL_TTL = re.compile(r"^--ttl=[0-9]+$")
    PINNED = ("DATABASE_URL", "PGDATABASE", "PGUSER", "PGHOST", "PGSERVICE", "PGSERVICEFILE",
              "API_PORT", "PORT", "WEB_PORT")
    INNER_PIN = re.compile(r"(?<![A-Za-z0-9_])(?:%s)=" % "|".join(PINNED))

    def launch_shape(seg):
        # Returns (names assigned among the leading words, [reasons the launch is not
        # plain]). Both come from ONE walk, so what counts as a pin and what counts as
        # plain cannot diverge.
        try:
            toks = shlex.split(seg.raw)
        except ValueError:
            return set(), ["the launch cannot be tokenized - it must be written plainly"]
        names = set()
        n = len(toks)
        i = 0
        while i < n:
            t = toks[i]
            m = ASSIGN_WORD.match(t)
            base = t.rsplit("/", 1)[-1]
            if m:
                names.add(m.group(1))
                i += 1
            elif base == "env" and PLAIN_WORD.match(t):
                i += 1
                if i < n and toks[i].startswith("-") and toks[i] != "--":
                    return names, ["env is followed by the option %r - env -i/-u/-S/-C/-P and friends rewrite the environment after this hook read it (and options take operands), so none is accepted; write the assignments as a plain prefix" % toks[i]]
                if i < n and toks[i] == "--":
                    i += 1
            elif base == "dev-ttl.sh" and PLAIN_WORD.match(t):
                i += 1
                # The script reads one `--ttl N` and nothing else before the `--`.
                if toks[i:i + 1] == ["--ttl"] and i + 1 < n and toks[i + 1].isdigit():
                    i += 2
                elif i < n and DEVTTL_TTL.match(toks[i]):
                    i += 1
                if i >= n or toks[i] != "--":
                    return names, ["dev-ttl.sh is followed by %r, which the hook does not understand" % (toks[i] if i < n else "")]
                i += 1
            else:
                break
        if i >= n:
            return names, ["no command word found in the launch"]
        word = toks[i]
        if not PLAIN_WORD.match(word):
            return names, ["the command word %r is not a plain literal (a variable, a substitution, a brace or glob) - the shell computes it, the hook cannot" % word]
        if seg.wrappers and any(w not in ("env", "dev-ttl.sh") for w in seg.wrappers):
            return names, ["the launch goes through a wrapper the hook does not model (%s) - write the launcher directly: %s" % (", ".join(seg.wrappers), LAUNCHER_FORMS)]
        if word.rsplit("/", 1)[-1] != seg.name:
            return names, ["the written command word %r is not the launcher the analyzer resolved (%r) - write the launcher directly: %s" % (word, seg.name, LAUNCHER_FORMS)]
        # SR-M-15: `pnpm exec env DATABASE_URL=<live> pnpm dev` overrides the leading pin.
        for t in toks[i + 1:]:
            tool = re.sub(r"\.(exe|cmd|bat)$", "", re.split(r"[/\\]", t)[-1], flags=re.I).lower()
            if tool in ("env", "cross-env", "dotenv") or INNER_PIN.search(t):
                return names, ["the launch rewrites its environment after the pin (%r) - the pin no longer decides what it reaches. Set each value once, as a prefix on the launch" % t]
        return names, []

    shapes = [launch_shape(s) for s in segs]
    for _names, _problems in shapes:
        for _p in _problems:
            if _p not in reasons:
                reasons.append(_p)

    def literal_inline(name):
        # On the launching segment itself, as a LEADING prefix - not satisfied by an
        # export in an earlier segment (cmdscan folds those into seg.env, but a later
        # bare assignment or a sourced file can still change them), and not by a
        # look-alike argument after the launcher.
        return bool(shapes) and all(name in names for names, _ in shapes)

    # SR-M-13: `false && export ...`, `if false; then export ...; fi` and `(export ...)`
    # never reach the launch, and cmdscan folds them all the same. A pin that comes
    # from an export counts only on a line of plain statements. `code_view` has no
    # quoted text, so a phrase in a string does not count. It spaces operators, so
    # `2>&1` reads `2> & 1`: a `&` right after `<` or `>` is a redirect, not a job.
    # `&>x` reads `& >x` exactly like `export X & >x`, so it stays not plain.
    NOT_PLAIN = re.compile(
        r"&|\||[(){}`]|\$\("
        r"|\b(?:if|then|elif|else|fi|for|while|until|do|done|case|esac|function|select|coproc)\b"
    )
    # Builtins that assign, un-export or defer code; and a command word the shell
    # computes (`$X DATABASE_URL`), which may be any of them.
    UNDOES = ("unset", "enable", "declare", "typeset", "local", "read", "mapfile", "readarray",
              "getopts", "wait", "trap", "eval", "source", ".", "printf")
    # A `#` that starts a word opens a comment; its words are not statements.
    # cmdscan decides that on the raw text (code_view has lost quotes and `\`).
    plain_view = re.sub(r"[<>]\s*&", " ", scan.plain_view)
    from_export = [v for v in PINNED if v in env and not literal_inline(v)]
    # declare/typeset +x and export -n un-export a name; any of them on the line counts.
    undone = any(s.name in UNDOES or (s.name and not PLAIN_WORD.match(s.name))
                 or (s.name == "export" and any(a[:1] == "-" and "n" in a for a in s.argv))
                 for s in scan.segments)
    if from_export and (undone or NOT_PLAIN.search(plain_view)):
        reasons.append(
            "%s reaches the launch only through an export, and this line may skip or undo "
            "that export (a condition, a subshell, a pipe, a background job, unset) - the "
            "effective value cannot be determined. Set it as a prefix on the launch"
            % ", ".join(from_export)
        )

    ENV_LOAD = re.compile(
        r"(?:^|[;&|(\n]\s*)(?:source|\.)\s+[^\s;&|]"
        r"|\bset\s+(?:-[A-Za-z]*a[A-Za-z]*|-o\s+allexport)\b"
        r"|--env-file|\beval\b|\bexport\s+\$"
    )

    # DATABASE_URL: same ambiguity as PGDATABASE, but the older rule (an export in an
    # earlier segment is accepted) stays for the plain case. It is refused only when
    # the value is not literally inline AND something could change it afterwards.
    if db is not None and not literal_inline("DATABASE_URL"):
        carried = sum(1 for s in segs if "DATABASE_URL" in s.env)
        if both_views(ENV_LOAD.search) or assignments("DATABASE_URL") > carried:
            reasons.append(
                "DATABASE_URL is not set inline on the launch itself and the command "
                "assigns or loads it elsewhere (export then bare assignment, source, "
                "set -a, eval, read, printf -v, ${V:=}) - the effective value cannot "
                "be determined. Set it once, as a prefix on the launch"
            )

    pgdb = env.get("PGDATABASE")
    if db == "":
        if pgdb is None:
            reasons.append(
                "DATABASE_URL is empty and PGDATABASE is not pinned inline - libpq then "
                "takes the database from a service file or the user name "
                "(PGUSER=crm_db is the live database). Corrected launches - copy one: "
                "`DATABASE_URL= PGDATABASE=crm_qa vite --port 3010` (web) or "
                "`DATABASE_URL= PGDATABASE=crm_qa API_PORT=3011 pnpm --filter @crm/api dev` (api)"
            )
        elif not literal_inline("PGDATABASE"):
            reasons.append(
                "PGDATABASE reaches the launch only through an earlier export or load, "
                "not as a prefix on the launching command itself - a later assignment or "
                "a sourced file can still change it. Pin it as a prefix on the launch - "
                "copy one: `DATABASE_URL= PGDATABASE=crm_qa vite --port 3010` (web) or "
                "`DATABASE_URL= PGDATABASE=crm_qa API_PORT=3011 pnpm --filter @crm/api dev` (api)"
            )
    if pgdb is not None and (db == "" or pgdb != ""):
        for problem in name_problems(pgdb.strip(), "PGDATABASE"):
            reasons.append(problem)

    # Detected with the helper this file already has (assignments(): NAME=, printf -v,
    # read, ${NAME:=}) and with the cmdscan env, not with a pattern of its own. That
    # fails closed on a command that merely MENTIONS PGSERVICE=... in an argument or an
    # echo; an odd false refusal is the price of not re-implementing the shell grammar
    # here (an earlier anchored regex was exactly that, and had gaps for declare/local/
    # readonly/export --/quoted prefix values). Nobody launches with a service file set
    # on purpose from a worktree.
    if ("PGSERVICE" in env or "PGSERVICEFILE" in env
            or assignments("PGSERVICE") or assignments("PGSERVICEFILE")):
        reasons.append(
            "PGSERVICE / PGSERVICEFILE is set or mentioned - a libpq service file overrides "
            "PGDATABASE (measured), so the database it reaches cannot be determined"
        )

    port_values = []
    for var in ("API_PORT", "PORT", "WEB_PORT"):
        val = env.get(var)
        if val is not None and val.isdigit():
            port_values.append(val)
    for s in segs:
        argv = s.argv
        for i, tok in enumerate(argv):
            m = re.match(r"^--port=(\d+)$", tok)
            if m:
                port_values.append(m.group(1))
            elif tok == "--port" and i + 1 < len(argv) and argv[i + 1].isdigit():
                port_values.append(argv[i + 1])
    if not port_values:
        reasons.append(
            "the port is not set inline on this command — it will inherit the live "
            "default (API_PORT defaults to 3001 in apps/api/src/main.ts, and vite "
            "server.port is hardcoded to 3000 in apps/web/vite.config.ts)"
        )
    else:
        # Compared as numbers: `API_PORT=03001` is 3001 to Node and was "not 3001"
        # to a string comparison (review LOW).
        live = [p for p in port_values if int(p) in (3000, 3001)]
        if live:
            reasons.append(
                "port %s is set explicitly to one of the owner’s live ports (web:3000 / api:3001)" % live[0]
            )

    return reasons

reasons = []
for _n, (_seg, _label) in enumerate(hits, 1):
    for _r in judge(_seg):
        if len(hits) > 1:
            _r = "launch %d (%s): %s" % (_n, _label, _r)
        if _r not in reasons:
            reasons.append(_r)
label = "; ".join(_l for _, _l in hits)

if not reasons:
    sys.exit(0)

reason_lines = "\n".join("  - %s" % r for r in reasons)
msg = """🚫 LIVE-DB GUARD: this command starts a dev server from an agent worktree/scratchpad without a provably safe DATABASE_URL/port.

The launch that was recognised: %s

%s

The 2026-08-05 incident (PR #485): DATABASE_URL/API_PORT inherited from the parent
session overrode the worktree .env — the API listened on :3000 against the owner’s LIVE
database for about two minutes. It ended well only by luck (0 writes that
session). The rule: any dev-server launch from a worktree MUST set BOTH
DATABASE_URL AND the port inline — an .env file alone guarantees nothing, because an
already-set process.env variable silently overrides it.

The right way (safe values — scratch DB crm_qa, free ports):
    DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa API_PORT=3011 pnpm --filter @crm/api dev
    DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa vite --port 3010

(the web server ignores PORT/API_PORT — vite.config.ts hardcodes server.port; the port changes ONLY via --port)

If the process deliberately must not touch the database, set DATABASE_URL= (empty) explicitly AND pin
PGDATABASE=crm_qa as a prefix on the same launch: with an empty URL libpq falls back to PGSERVICE or
the user name (PGUSER=crm_db is the live database), so an empty URL alone is no longer enough.
Full launches (copy one; the port is still required):
    DATABASE_URL= PGDATABASE=crm_qa vite --port 3010
    DATABASE_URL= PGDATABASE=crm_qa API_PORT=3011 pnpm --filter @crm/api dev

Do not forget the TTL wrapper either (a separate requirement, also mandatory):
    DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa PGDATABASE=crm_qa API_PORT=3011 scripts/devops/dev-ttl.sh -- pnpm --filter @crm/api dev
(assignments go BEFORE dev-ttl.sh: it runs its arguments as a command, so NAME=value after the double dash fails with "command not found")

NOT A LAUNCH (this hook lets these through): the word as an argument
(grep/ls/git show); a read-only subcommand of pnpm and npm ONLY (`pnpm why vite`,
`npm ls`); a heredoc body with a QUOTED delimiter (`<<EOF`, `<<\\EOF`).

REFUSED BY DESIGN, though not a launch either (not a bug; the wrapper will not
help): the same subcommands on turbo / yarn / bun (`yarn why`, `turbo ls dev`) —
for turbo the operand IS a task name and yarn falls through to
`yarn run <script>`, so the grant is withheld from them deliberately;
`pnpm version` / `npm audit fix` — they write the manifest and run lifecycle
scripts; and a command outside the understood list carrying a launcher-looking
word as its own token inside quotes (`for c in "pnpm dev"; do …`). The last one
is a deliberate trade: this same reading of quotes is what catches
`script -q /dev/null pnpm dev`, see CONFIDENCE in
.claude/hooks/lib/cmdscan.py. Rewrite the command so the word is not a token of
its own inside quotes, or move the text into a file.

See .claude/hooks/pre-bash-devserver-ttl-gate.sh and .claude/rules/common/light-track.md
("Parallel dispatch" — the list of free ports).""" % (label, reason_lines)

print(json.dumps({"decision": "block", "reason": msg}))
sys.stderr.write(
    "[pre:bash:live-db-guard] BLOCK unsafe dev-server launch in worktree/scratchpad (%s)\n" % label
)
sys.exit(10)
