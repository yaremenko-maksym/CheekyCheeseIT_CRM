#!/bin/bash
# ECC stable id: pre:bash:live-db-guard
#
# Purpose: make it mechanically impossible for an agent worktree/scratchpad
# process to reach the OWNER'S live dev database or collide with the
# owner's live dev ports. 2026-08-05 incident (PR #485): an agent's dev-API
# process inherited API_PORT=3000 and DATABASE_URL=.../crm_db from the
# parent session's environment — its OWN .env in the worktree was silently
# ignored, because dotenv (and NestJS ConfigModule) never overwrite a
# process.env var that is already set. The API listened on :3000 against
# the live crm_db for ~2 minutes. No data was touched, only by luck; a
# migration or a write endpoint hit a minute later could have corrupted
# real financial records. The dispatch-prompt warning "set DATABASE_URL /
# API_PORT explicitly" is repeated in every agent prompt already and did
# NOT prevent this — so the fix has to be mechanical, not another warning.
#
# Root cause, precisely: inline env-var prefixes (VAR=value cmd) and
# `export VAR=value` DO override inherited env — but a bare .env file
# loaded by dotenv does NOT, if the shell already exported the var. The
# only reliably-safe pattern is an EXPLICIT inline override on the command
# itself. Absence of an explicit override is therefore treated as unsafe,
# even though "nothing was written" looks like the safe default — it is
# exactly the opposite (see class 3 below).
#
# ---------------------------------------------------------------------------
# WARNING - READ BEFORE EDITING THE PYTHON BELOW. It sits inside a bash
# single-quoted string (python3 -c '...'), so ONE apostrophe anywhere in it - in a
# comment, a docstring, a message ("someone else's", "libpq's") - ends the string
# early, and bash dies at PARSE time with a syntax error. A hook that dies on a
# syntax error exits 2, which is indistinguishable from an honest block. It has
# happened twice in this repository. Write "the libpq user-name fallback", never
# the possessive; use \x27 inside a regex. Before every commit:
#     bash -n .claude/hooks/pre-bash-live-db-guard.sh && <run the suite>
# chained with &&, not ;. The suite shows it loudly (nearly every case fails with
# "syntax error near unexpected token"), but only if it is run.
#
# ---------------------------------------------------------------------------
# HOW IT DECIDES WHAT IS BEING LAUNCHED (rewritten 2026-08-18, backlog 63)
#
# It used to grep the raw command line for `vite`, `nest start`, `pnpm dev`,
# `dist/main`. A word in ANY position was enough, so this hook refused
#
#     git show <ref>:pnpm-lock.yaml | grep -n vite      (pure read, no process)
#     ls -la node_modules/.bin/vite
#     node -e "console.log('apps/api/dist/main.js')"
#
# with a wall of text about booting a dev server against the live database.
# That is not a cosmetic annoyance: the workaround is printed inside the
# refusal itself, so two false hits are enough to train "prepend `DATABASE_URL=`
# and retry" — a reflex that then fires on a REAL launch too. The predicates
# are NOT relaxed; the question changed from "does the line contain X" to
# "is X the command being executed", which is the only difference between
# `grep vite` and `vite`.
#
# The parse lives in lib/cmdscan.py (shared with pre-bash-devserver-ttl-gate.sh,
# which must agree token-for-token on what a launch is — they used to carry the
# same regex twice, which is why narrowing one alone would still have left this
# `grep` refused). It splits on `;`/`&&`/`||`/`|`/`&`/newline and on shell
# grouping, recurses into `sh -c`, `eval`, `find -exec` and `$( )`, unwraps
# `VAR=v` and the wrapper commands, and decides on the COMMAND WORD.
#
# WHAT THE FIRST VERSION GOT WRONG (security review, 2026-08-18). It trusted the
# parse unless `shlex` had thrown. The review produced 13 reproduced misses —
# `env -i pnpm dev`, `sudo -s pnpm dev`, `{ pnpm dev ; }`, `script -q /dev/null
# pnpm dev` — in every one of which the parser had NOT failed; it had answered
# confidently and wrong. So the trust boundary moved: cmdscan marks a segment
# `confident` only when it resolved the command word AND understands the command,
# and an unconfident segment is judged by every "the command might start here"
# reading of itself. `$RUNNER dev` and an unknown wrapper are now the same case,
# and neither can turn a would-be block into an allow.
#
# The third round then fixed the OTHER half of that sentence — "AND understands
# the command". The understood list contained commands that run their argument
# (`tar`, `rsync`, `ssh`, `pnpm exec`, …), and being on it skips the re-reading
# entirely, so `bun x pnpm dev` reached this hook as "a bun command". Pruned in
# lib/cmdscan.py; `git` and `psql` stay and surrender their exec surface instead.
#
# The environment is read PER SEGMENT: an inline prefix reaches only the command
# it is glued to, `export` reaches later segments. `DATABASE_URL=…/crm_qa echo ok
# && pnpm dev` gives the launch nothing, and is refused.
# ---------------------------------------------------------------------------
#
# Contract:
#   - Reads tool-call JSON from stdin.
#   - Fast-exit 0 for non-dev-server commands.
#   - Fast-exit 0 outside agent worktree / claude scratchpad context — the
#     owner's own main-checkout session is legitimate and untouched.
#   - exit 2 + JSON decision body on block.
#   - exit 1 + `INTERNAL ERROR` on stderr when the ANALYZER itself fails:
#     a broken hook must never be mistaken for a hook that refused. Both used
#     to be "non-zero exit"; a bash syntax error still exits 2 exactly like a
#     verdict, so the distinguishing mark is the contract: a real verdict ALWAYS
#     carries a {"decision":"block"} body on stdout. If the analyzer dies while
#     the coarse test says a launcher is present, the fallback still blocks —
#     but labels itself ДЕГРАДИРОВАННЫЙ РЕЖИМ, so nobody debugs the wrong thing.
#   - CI runners never see this file at all (hooks are a local Claude Code
#     mechanism; GitHub Actions does not invoke .claude/hooks/**).
#
# What gets blocked, once command+context match (any ONE reason is enough):
#   1. DATABASE_URL explicitly set inline to a value whose db name is
#      exactly `crm_db` (the one shared live Postgres db — see
#      docker-compose.yml POSTGRES_DB). `crm_qa` / `crm_qa_*` (the
#      designated scratch db) and an explicit EMPTY value are both safe.
#   2. A port explicitly set inline (API_PORT=/PORT=/WEB_PORT=/--port) to
#      3000 or 3001 — the live pair (web/api, see apps/web/vite.config.ts
#      server.port and apps/api/src/main.ts API_PORT default).
#   3. Neither DATABASE_URL nor a port is set inline AT ALL — the covert
#      inheritance case, and the one that actually caused PR #485: no
#      override present reads as "will inherit whatever the parent shell
#      already exported", which this hook cannot verify and therefore
#      treats as unsafe by default.
#
# What stays possible (must NOT be blocked — see PR body for proof runs):
#   - Any command outside .claude/worktrees/** and claude scratchpads
#     (owner / master session on the live stack is legitimate work).
#   - Explicit safe values (non-crm_db db name + non-3000/3001 port).
#   - `DATABASE_URL=` (explicitly empty) — the established safe idiom for
#     feature-branch pushes (git-policy.md); this hook never even fires on
#     a `git push`, since it only matches dev-server launchers below.
#   - vitest / Playwright runs (not in the launcher pattern — see sibling
#     hook's header for why; unchanged here).
#   - READING about a launcher: grep/rg/ls/git show/echo naming `vite`,
#     `pnpm dev`, `dist/main` in any position.

set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT=$(cat)

[ -z "$INPUT" ] && exit 0

# Hot path: if no launcher word occurs anywhere in the payload, nothing below
# can fire — leave before paying for a python start. Deliberately a SUPERSET of
# what the analyzer can block (never a second, divergent policy).
echo "$INPUT" | grep -qE 'vite|nest|dev|dist/main' || exit 0

printf '%s' "$INPUT" | PYTHONDONTWRITEBYTECODE=1 CMDSCAN_LIB="$SELF_DIR/lib" python3 -c '
import importlib.util, json, os, re, shlex, sys, urllib.parse

# By absolute path, not via sys.path — see the note in pre-bash-safety.sh.
_spec = importlib.util.spec_from_file_location(
    "cmdscan", os.path.join(os.environ["CMDSCAN_LIB"], "cmdscan.py"))
cmdscan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cmdscan)

data = json.load(sys.stdin)
cmd = (data.get("tool_input") or {}).get("command") or ""
cwd = data.get("cwd") or ""
if not cmd:
    sys.exit(0)

# Same worktree/scratchpad context gate as the sibling hook — the owner s
# main checkout is out of scope by design.
CONTEXT = re.compile(r"\.claude/worktrees/|/tmp/claude-")
if not CONTEXT.search(cmd) and not CONTEXT.search(cwd):
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
if not hits and scan.truncated:
    hits = [(
        cmdscan.Segment("", [], [], [], False, cmd, 0, {}, False, None),
        "вложенность глубже предела разбора — код не прочитан",
    )]

if not hits:
    sys.exit(0)

seg, label = hits[0]
segs = [s for s, _ in hits]

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
        "DATABASE_URL не задана инлайн в этой команде — унаследуется из "
        "окружения сессии, а не из .env worktree (dotenv НЕ перезаписывает "
        "уже установленную process.env переменную). Именно так утекло PR #485."
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
# If a fifth round finds another divergence between this hook model of bash and
# bash, the authoritative check belongs in the dev-server start itself (a preflight
# that prints current_database() and refuses the live name), with this hook advisory.
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
DEVTTL_TTL = re.compile(r"^--ttl=[0-9]+$")

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
            while i < n and toks[i] != "--":
                if toks[i] == "--ttl" and i + 1 < n and toks[i + 1].isdigit():
                    i += 2
                elif DEVTTL_TTL.match(toks[i]):
                    i += 1
                else:
                    return names, ["dev-ttl.sh is followed by %r, which the hook does not understand" % toks[i]]
            i += 1
        else:
            break
    if i >= n:
        return names, ["no command word found in the launch"]
    word = toks[i]
    if not PLAIN_WORD.match(word):
        return names, ["the command word %r is not a plain literal (a variable, a substitution, a brace or glob) - the shell computes it, the hook cannot" % word]
    if seg.wrappers and any(w not in ("env", "dev-ttl.sh") for w in seg.wrappers):
        return names, ["the launch goes through a wrapper the hook does not model (%s) - write the launcher directly" % ", ".join(seg.wrappers)]
    if word.rsplit("/", 1)[-1] != seg.name:
        return names, ["the written command word %r is not the launcher the analyzer resolved (%r) - write the launcher directly" % (word, seg.name)]
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
        "порт не задан инлайн в этой команде — унаследует живой порт по "
        "умолчанию (API_PORT default 3001 в apps/api/src/main.ts, vite "
        "server.port хардкожен 3000 в apps/web/vite.config.ts)"
    )
else:
    # Compared as numbers: `API_PORT=03001` is 3001 to Node and was "not 3001"
    # to a string comparison (review LOW).
    live = [p for p in port_values if int(p) in (3000, 3001)]
    if live:
        reasons.append(
            "порт %s явно задан из живой пары владельца (web:3000 / api:3001)" % live[0]
        )

if not reasons:
    sys.exit(0)

reason_lines = "\n".join("  - %s" % r for r in reasons)
msg = """🚫 LIVE-DB GUARD: команда запускает dev-сервер из agent-worktree/scratchpad без доказуемо безопасных DATABASE_URL/порта.

Запуск, который распознан: %s

%s

Инцидент 2026-08-05 (PR #485): унаследованные из родительской сессии DATABASE_URL/API_PORT
перебили .env worktree — API ~2 минуты слушал :3000 против ЖИВОЙ базы владельца. Обошлось
случайно (0 записей за сессию). Правило: любой запуск dev-сервера из worktree ОБЯЗАН явно
задавать И DATABASE_URL, И порт инлайн — .env файл сам по себе не гарантирует безопасность,
потому что уже установленная process.env переменная перекрывает его молча.

Правильно (безопасные значения — scratch DB crm_qa, свободные порты):
    DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa API_PORT=3011 pnpm --filter @crm/api dev
    DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa vite --port 3010

(web-сервер игнорирует PORT/API_PORT — vite.config.ts хардкодит server.port; порт меняется ТОЛЬКО через --port)

If the process deliberately must not touch the database, set DATABASE_URL= (empty) explicitly AND pin
PGDATABASE=crm_qa as a prefix on the same launch: with an empty URL libpq falls back to PGSERVICE or
the user name (PGUSER=crm_db is the live database), so an empty URL alone is no longer enough.
Full launches (copy one; the port is still required):
    DATABASE_URL= PGDATABASE=crm_qa vite --port 3010
    DATABASE_URL= PGDATABASE=crm_qa API_PORT=3011 pnpm --filter @crm/api dev

Не забудь и TTL-обёртку (отдельное требование, тоже обязательное):
    scripts/devops/dev-ttl.sh -- DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa API_PORT=3011 pnpm --filter @crm/api dev

Читать про запуск (grep/ls/git show, где слово vite или pnpm dev стоит аргументом) этот хук
больше не мешает — он смотрит только на команду в позиции запуска.

См. .claude/hooks/pre-bash-devserver-ttl-gate.sh и .claude/rules/common/light-track.md
(«Параллельный диспатч» — список свободных портов).""" % (label, reason_lines)

print(json.dumps({"decision": "block", "reason": msg}))
sys.stderr.write(
    "[pre:bash:live-db-guard] BLOCK unsafe dev-server launch in worktree/scratchpad (%s)\n" % label
)
sys.exit(10)
'
RC=$?

case "$RC" in
  0) exit 0 ;;
  10) exit 2 ;;
esac

# ── analyzer failure — NOT a verdict ──────────────────────────────────────────
# Everything below runs only when the python above could not finish (missing
# python3, missing lib/cmdscan.py, an edit that broke it). It says so loudly and
# falls back to the pre-2026-08-18 coarse test, so the protection does not
# silently disappear — but it never impersonates a decision on the merits.
echo "[pre:bash:live-db-guard] INTERNAL ERROR: анализатор не отработал (rc=$RC) — это НЕ вердикт хука." >&2

LEGACY='(^|[/[:space:]])nest(\.js)?[[:space:]]+start|(^|[/[:space:]])vite([[:space:]]|$)|(^|[[:space:]])(pnpm|npm|yarn|turbo)([[:space:]]+(-[^[:space:]]+|--filter[[:space:]]+[^[:space:]]+|run))*[[:space:]]+dev(:start)?([[:space:]]|$)|node[[:space:]][^;|&]*dist/main'
# The raw stdin is JSON, so the command's last token is followed by `"` — the
# legacy pattern's `([[:space:]]|$)` boundary would silently never match and the
# fallback would let everything through. Turning JSON punctuation into spaces
# restores the token boundaries without needing a parser (python3 may be exactly
# what is missing here). Verified by test case "СЛОМАННЫЙ анализатор + опасный запуск".
FLAT=$(printf '%s' "$INPUT" | tr '"{},' '    ')
if echo "$FLAT" | grep -qE "$LEGACY" && echo "$FLAT" | grep -qE '\.claude/worktrees/|/tmp/claude-'; then
  printf '%s\n' '{"decision":"block","reason":"⚠️ ДЕГРАДИРОВАННЫЙ РЕЖИМ live-db-guard: анализатор команды не отработал (см. INTERNAL ERROR в stderr), поэтому применено старое грубое правило «слово-подстрока». Это может быть ЛОЖНОЕ срабатывание. Почини .claude/hooks/lib/cmdscan.py вместо обхода: bash .claude/hooks/pre-bash-live-db-guard.sh < <(echo JSON) покажет причину."}'
  echo "[pre:bash:live-db-guard] BLOCK (degraded fallback, coarse substring rule)" >&2
  exit 2
fi
exit 1
