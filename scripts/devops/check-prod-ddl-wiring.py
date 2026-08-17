#!/usr/bin/env python3
"""
Prod DDL Wiring Guard — incident fix (task-infra-vacancy-i18n-ddl, 2026-07-25).

Incident this guards against: PR #422 shipped
apps/api/drizzle/manual/2026-07-25_vacancy_i18n_seo.sql (new `vacancies` columns)
and the already-deployed API code started querying those columns immediately —
but NOTHING in .github/workflows/deploy.yml ever copied that file to the VPS or
applied it. The migration and its application live in different zones of
ownership (apps/api/** is Coder's, .github/workflows/** is DevOps's) and silently
drifted apart: the file merged, the wiring never got a task, prod started
500ing on GET /api/public/vacancies the moment the image shipped.

Verifies that every apps/api/drizzle/manual/*.sql file is either:
  (a) STRUCTURALLY wired into .github/workflows/deploy.yml — its filename must
      appear BOTH in a step that copies it to the server AND in a step that
      applies it with psql (see "WHAT COUNTS AS WIRED" below), OR
  (b) explicitly listed in KNOWN_NOT_WIRED below, with a reason.

WHAT COUNTS AS WIRED (task-guards-teeth, 2026-08-07 — this guard's own fix)
--------------------------------------------------------------------------
Until 2026-08-07 this guard did:

    wired = {f for f in all_files if f in deploy_yml_content}

i.e. a plain substring search over the WHOLE file. That proved only that the
filename is MENTIONED somewhere — a comment was enough. deploy.yml mentions
every DDL file in prose several times over (step headers, "SOURCE:" comments,
incident write-ups), so the guard would have stayed green on the exact incident
it was created for: PR #422's file was named in prose in this very workflow's
comments while nothing copied or applied it. Found on PR #498, where the author
noted the guard "goes green because my own comments and step names contain the
string". A guard that a comment can satisfy is decoration.

Now BOTH of these must hold:

  COPY  — the filename appears in the `source:` value of an appleboy/scp-action
          step (inline or `|` block scalar). If that `source:` is an expression
          (`${{ steps.X.outputs.Y }}` — used by the guarded, conditional copies),
          the referenced step X's own body is searched instead, since that is
          where the file list is built.
  APPLY — the filename appears together with the server-side path root
          (/opt/crm) inside a step that actually INVOKES `psql`. That is the
          `FOO_FILE="/opt/crm/apps/api/drizzle/manual/..."` assignment that gets
          fed to psql — writing it is doing the work.

Text a human reads, rather than text the deploy acts on, is removed before any
matching happens — in three places, each one a hole someone walked through:
  - whole-line comments;
  - TRAILING comments (`source: 'x.yml'   # also ships foo.sql`) — added review
    round 2 after a reviewer made the guard green with zero copies and zero
    applies while it printed "Comment-only mentions do NOT count";
  - GitHub log annotations (`echo "::notice::foo.sql not found — skipping
    copy"`), which assert the opposite of wiring;
and `psql` must be invoked rather than named, so a step that only ECHOES a psql
command line no longer counts as applying anything.

Failure modes are reported separately (never copied / copied but never applied /
applied but never copied), because "the scp list was updated but the apply step
was forgotten" is a real and differently-diagnosed bug from "nothing at all".

KNOWN LIMITATIONS, stated rather than implied: this proves the two steps EXIST
and name the file. It does not prove the apply step runs on every deploy (it may
sit behind an `if:`), nor that the SQL itself is correct or idempotent. A shell
variable holding a psql command STRING without ever running it would also still
count (no test — the shape does not occur in this repo's deploy.yml, which
always runs psql directly rather than through an intermediate command
variable). It is a wiring check. The proof that a migration actually applied is
deploy.yml's own fail-loud apply step and the prod schema afterwards.

DEAD-ASSIGNMENT FIX (item 67, task-ddl-guard-and-ci-noise, 2026-08-17) — closes
the limitation this paragraph used to state here ("that the psql invocation it
found is the one that consumes THIS file") without a test: until this fix, ANY
`/opt/crm/....sql` path text inside a step that ran psql SOMEWHERE counted as
applied, so `OTHER_FILE="/opt/crm/.../this.sql"` — assigned, then never fed to
any psql call — was indistinguishable from a genuine `< "$OTHER_FILE"`
consumption. `resolve_applied_files()` now requires the path (literal or via a
variable) to sit on the SAME backslash-joined logical command as the psql
invocation. Test: scripts/devops/tests/test-check-prod-ddl-wiring.sh
"dead-assignment" case. Residual, deliberately uncovered gap: if a step
reassigned the SAME shell variable name to two different `/opt/crm/....sql`
paths, `resolve_applied_files()` keeps only the LAST assignment seen (no
line-position-aware scoping) — a real psql call between the two assignments
using the first value would be mis-attributed to the second path's file. No
test for this: it requires deploy.yml to reuse a variable name across two
different DDL files in the same step, which is not this repo's convention
(every apply step below picks a distinct, file-specific variable name) and
would itself be a readability smell worth catching in review before it reached
this guard.

REVIEW ROUND 2 FIXES (task-ddl-guard-and-ci-noise, 2026-08-17) — two more gaps
in the item-67 fix above, both found by fixture, both in the direction this
guard is supposed to lean AWAY from (a guard refusing something LEGITIMATE —
worse than staying quiet, because a false-red guard trains people to stop
reading it, which is how #422 happened in the first place):

  MED-1 — VAR_ASSIGN_RE only matched double-quoted assignments
  (`VAR="/opt/crm/...sql"`). deploy.yml's `..._FILE=` assignments are all
  double-quoted today (24/24, grepped) but scp `source:` values in this same
  file routinely use SINGLE quotes, and a single-quoted `..._FILE=` assignment
  is equally valid bash — a file wired that way reported `COPIED BUT NEVER
  APPLIED` despite being genuinely applied. VAR_ASSIGN_RE now accepts either
  quote style. Test: "single-quote apply assignment" case.

  MED-2 — variable resolution was scoped to a single Step object, so
  `DDL_FILE="/opt/crm/.../x.sql"` in one step followed by `psql ... <
  "$DDL_FILE"` in a LATER step of the SAME job reported the same false
  `COPIED BUT NEVER APPLIED` — even though cross-step data flow via
  `$GITHUB_ENV` (assign in step N, `echo "VAR=$VAR" >> "$GITHUB_ENV"`, read in
  step N+k) is ordinary GitHub Actions and this file already uses the sibling
  idiom (`steps.X.outputs.Y`) on the COPY side. `build_zones()` now accumulates
  a `var_files` dict per JOB (not per step), in file order, across every step
  of that job — resolution stops at job boundaries because GitHub Actions env
  vars do not cross them (each job is a fresh runner). Test: "cross-step
  $GITHUB_ENV apply assignment" case. Does NOT change today's real deploy.yml
  behavior: its apply side is still one monolithic `run:` block per the module
  docstring above, so every assignment and every psql call already shared one
  Step; this fix only matters if that block is ever split into named steps —
  which the copy side already is, making it the more natural refactor to
  expect eventually, not a hypothetical.

REVERSE INVARIANT (security-review, PR #517) — apps/api/drizzle/manual-private/
---------------------------------------------------------------------------------
apps/api/drizzle/manual-private/ holds SQL meant to be run BY HAND on the VPS,
never through CI: it prints row-level financial detail (client names, drop
names, per-transaction USDT amounts) that must never reach a log, and this
repo's Actions logs are public. Everything above proves a file IS wired; this
directory must prove the opposite — that none of its files are wired ANYWHERE.
An exclusion is a positive claim someone wrote and someone read; a separate
directory alone is the absence of a claim, so this guard also fails loudly if
any apps/api/drizzle/manual-private/*.sql filename appears anywhere under
.github/workflows/**, and prints that directory's inventory every run so a new
file landing there is visible to a human, not just to this check.

Tests: scripts/devops/tests/test-check-prod-ddl-wiring.sh (positive AND negative
cases — including the comment-only cheat above, which must go red).

Run: python3 scripts/devops/check-prod-ddl-wiring.py
"""

import os
import re
import sys

# ---------------------------------------------------------------------------
# Root of the repo — resolve relative to this script location
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
DDL_MANUAL_DIR = os.path.join(REPO_ROOT, "apps", "api", "drizzle", "manual")
DEPLOY_YML = os.path.join(REPO_ROOT, ".github", "workflows", "deploy.yml")
MANUAL_PRIVATE_DIR = os.path.join(REPO_ROOT, "apps", "api", "drizzle", "manual-private")
WORKFLOWS_DIR = os.path.join(REPO_ROOT, ".github", "workflows")

# ---------------------------------------------------------------------------
# KNOWN_NOT_WIRED — explicit, reasoned exceptions. A file only belongs here if
# it is DELIBERATELY not applied by deploy.yml — not "forgotten", not "will
# get to it later". If you are adding a NEW manual DDL file and are not 100%
# sure it should run on every deploy, wire it in instead of adding it here.
# ---------------------------------------------------------------------------
KNOWN_NOT_WIRED = {
    "2026-07-15_settle_phantom_cleanup.sql",  # deliberately NOT wired — dry-run/manual
    # variant of the ONE-TIME settle-phantom data-fix. Its "_auto" sibling
    # (2026-07-15_settle_phantom_cleanup_auto.sql, see below) is the version
    # that was actually auto-wired and applied on prod (PR #382 "auto-wire
    # settle phantom-cleanup data-fix (owner-authorized)").
    "2026-07-15_settle_phantom_cleanup_auto.sql",  # deliberately DE-WIRED after a
    # single successful prod apply (see deploy.yml git history around PR #382/#383
    # and docs/architecture/2026-07-14-settle-transition-in-place.md) — this was a
    # one-time cosmetic/UX data-fix (dangling phantom rows from an earlier settle
    # bug), not a recurring schema change. Re-running it is safe (idempotent,
    # asserts 0 rows affected on an already-clean DB) but it is intentionally not
    # part of every deploy going forward — the backup table it wrote
    # (_settle_phantom_backup_20260715) is kept, never dropped, per the incident
    # runbook convention (apply-then-de-wire, don't re-run forever).
    "2026-07-27_drop_share_pending_parity_backfill.sql",  # deliberately DE-WIRED,
    # never applied — task-infra-drop-share-backfill-dewire, 2026-08-01. Application
    # is not required: the drop-share pending-parity PRE-COUNT (the permanent,
    # read-only sibling wired into deploy.yml — see the "PRE-COUNT" step) ran on the
    # first prod deploy after PR #443 merged (run 30691783655) and printed 0 Path-B
    # rows — nothing on prod was ever created via the pre-#443 bypass, so there was
    # nothing for this backfill to migrate, and the guarded settle code shipped in
    # the same PR #443 means no new such rows can appear going forward. See
    # scripts/devops/drop-share-pending-parity-backfill-runbook.md for the full
    # history. Not re-wired if this file is ever touched again for unrelated
    # reasons — it stays a historical artifact.
    "2026-08-12_admin_income_drop_backfill_apply.sql",  # deliberately NOT wired —
    # task-admin-income-drop-backfill (PR #517, fix/admin-income-drop-backfill), same
    # "report-first, apply-only-after-go-ahead" shape as the 2026-07-27 drop-share-
    # pending-parity precedent above. This file creates REAL financial obligations
    # (DROP_PENDING_PAYOUT rows + their paired pending_obligations) for historical
    # ADMIN_INCOME rows that never went through bookCompanyObligations. Its own
    # sibling, `2026-08-12_admin_income_drop_backfill_report.sql`, IS wired (fully
    # read-only — makes zero writes) precisely so the OWNER can read its candidate +
    # ambiguous list in a deploy log FIRST; this file is only meant to run once the
    # owner has reviewed that output and explicitly confirmed proceeding — never
    # automatically on every deploy. Wire it in a SEPARATE follow-up PR after that
    # confirmation (mirrors how the drop-share-pending-parity backfill above was
    # applied once, then immediately de-wired — this one starts pre-wired-out
    # instead, since the owner's confirmation has not happened yet). The column file,
    # `2026-08-12_admin_income_drop_backfill_column.sql`, is wired normally (additive,
    # idempotent schema change, safe on every deploy regardless of whether the
    # backfill itself is ever applied).
}


def read_deploy_yml():
    with open(DEPLOY_YML, "r") as f:
        return f.read()


def collect_all_ddl_files(ddl_dir):
    """Return the set of *.sql filenames (not full paths) directly under ddl_dir."""
    if not os.path.isdir(ddl_dir):
        return set()
    return {f for f in os.listdir(ddl_dir) if f.endswith(".sql")}


def find_private_leaks(private_files):
    """Reverse invariant (see module docstring): none of `private_files` may be
    named anywhere under .github/workflows/**. Missing directory -> empty set ->
    no leaks, silently. Returns sorted (filename, workflow-relpath) pairs.
    """
    hits = []
    if not private_files or not os.path.isdir(WORKFLOWS_DIR):
        return hits
    for dirpath, _dirs, filenames in os.walk(WORKFLOWS_DIR):
        for name in filenames:
            path = os.path.join(dirpath, name)
            with open(path, "r") as f:
                content = f.read()
            for private_file in private_files:
                if mentions(content, private_file):
                    hits.append((private_file, os.path.relpath(path, REPO_ROOT)))
    return sorted(hits)


# ---------------------------------------------------------------------------
# Structural parse of deploy.yml
#
# Deliberately NOT a full YAML parse (no PyYAML dependency — same reasoning as
# check-ssh-action-capture-stdout-version.py's header: this repo's workflow YAML
# is consistently 2-space-indented with no tabs, and a step-boundary-by-
# indentation walk is enough to tell "inside the scp step's source:" from
# "inside a prose comment three steps away", which is the entire distinction
# this guard needs to make).
# ---------------------------------------------------------------------------
STEP_START_RE = re.compile(
    r"^(\s+)- (?:name|uses|id|if|run|with|env|shell|continue-on-error|working-directory):"
)
COMMENT_LINE_RE = re.compile(r"^\s*#")
ID_RE = re.compile(r"^\s*id:\s*(\S+)\s*$")
SOURCE_KEY_RE = re.compile(r"^(\s*)source:\s*(.*?)\s*$")
BLOCK_SCALAR_RE = re.compile(r"^[|>][+-]?$")
STEPS_EXPR_RE = re.compile(r"\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.[A-Za-z0-9_-]+\s*\}\}")

# GitHub Actions log annotations are human-facing prose that happens to live on
# an executable line. `echo "::notice::<file> not found — skipping copy"` says
# the OPPOSITE of "this file is wired", so counting it as evidence of wiring
# inverts the guard's meaning (review round 2, MED). Same reasoning as comments:
# text a person reads is not text the deploy acts on.
ANNOTATION_RE = re.compile(r"::(?:notice|warning|error|debug)\s*(?:::|\s|$)")

# `psql` must be INVOKED, not merely named. `echo "then run: psql -f ..."`
# documents an apply step; it does not perform one (review round 2, MED).
#
# KNOWN GAP, deliberately not closed (review round 3, LOW): a line that PIPES
# into psql — `echo "..." | psql -U ...` — starts with `echo` and is therefore
# treated as not-applying, i.e. a FALSE RED. No such line exists in deploy.yml
# today (every apply step redirects a file with `< "$VAR"`), and the obvious fix
# — accept an echo line when a `|` appears before the psql match — would let
# `echo "run | psql later"` count as a real apply. That trades a hypothetical
# false red for an actual false green, which is the wrong direction for this
# guard: a false red gets noticed and fixed within minutes, a false green is
# what put the #422 DDL on prod unapplied. If a piped form ever lands, widen
# this deliberately and add a case for it.
PSQL_INVOCATION_RE = re.compile(r"(?:^|[|&;()]|\s)psql\b")
ECHO_LINE_RE = re.compile(r"^\s*(?:echo|printf)\b")


def strip_trailing_comment(line):
    """Drop a trailing ` # ...` comment, respecting quotes.

    THE H1 FIX (review round 2). Dropping whole comment LINES was not enough:
    `source: 'docker-compose.prod.yml'   # also ships 2026-08-07_x.sql` and
    `F="/opt/crm/.../other.sql"   # supersedes 2026-08-07_x.sql` made the guard
    green with zero copies and zero applies — the same "prose satisfies the
    check" defect this guard was rewritten to remove, just moved to the right
    of the code instead of above it. Worse, the guard printed "Comment-only
    mentions do NOT count" while accepting exactly that.

    A `#` only opens a comment when it is outside quotes AND preceded by
    whitespace (or starts the line). The two conditions earn their keep in
    different places, and the first version of this docstring credited the wrong
    one for both (review round 3 — the same "claim that reads well and isn't
    checked" this guard exists to refuse):

      - the WHITESPACE condition covers a `#` glued to the character before it:
        `echo "#0000ff"`, `https://host/path#frag`. Of those, only the quoted-
        string form occurs in deploy.yml today (once); the URL-fragment form
        does not occur at all and is listed as a shape, not as a sighting.
      - the QUOTE condition covers a SPACE-preceded `#` inside a string, which
        the whitespace rule alone would happily cut at: `PR #412` inside echoed
        prose (5+ occurrences today, all on lines that are filtered as
        annotations anyway) and — the one that would actually cost something —
        `psql -c "SET application_name = 'deploy #1'" -f /opt/crm/...`, where
        cutting at the `#` would discard the server-side path and report a
        genuinely-wired file as never applied.

    Pinned by test-check-prod-ddl-wiring.sh's hash-inside-quotes case; deleting
    the quote tracking makes exactly that case fail.
    """
    in_single = False
    in_double = False
    for i, ch in enumerate(line):
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        elif ch == "#" and not in_single and not in_double:
            if i == 0 or line[i - 1] in " \t":
                return line[:i]
    return line


# A job-name key: `  <job-id>:` at exactly 2-space indent under top-level
# `jobs:` (indent 0) — one level shallower than anything inside a job (steps
# live at indent 6+, job-level keys like `runs-on:`/`env:`/`steps:` at 4).
# Same "not a full YAML parse, indentation is consistent 2-space, that's
# enough" reasoning as STEP_START_RE above — used ONLY to scope cross-step
# variable resolution (resolve_applied_files) to a single JOB, since GitHub
# Actions env propagation (`$GITHUB_ENV`) does not cross job boundaries (each
# job is a fresh runner).
JOB_KEY_RE = re.compile(r"^  [A-Za-z0-9_-]+:\s*$")


class Step(object):
    def __init__(self, indent, job_id):
        self.indent = indent
        self.lines = []  # comment-only lines dropped, trailing comments stripped
        self.step_id = None
        self.job_id = job_id  # groups steps for cross-step var resolution

    @property
    def text(self):
        return "\n".join(self.lines)


def parse_steps(content):
    """Split deploy.yml into step blocks with all comment text removed.

    Comment stripping is the load-bearing part: the cheat this guard exists to
    refuse ("the filename is mentioned, therefore it must be wired") lives
    entirely in comments — whole-line ones above the code and trailing ones
    beside it.
    """
    steps = []
    current = None
    job_id = 0
    for raw in content.splitlines():
        if COMMENT_LINE_RE.match(raw):
            continue
        if JOB_KEY_RE.match(raw):
            job_id += 1
        m = STEP_START_RE.match(raw)
        if m:
            current = Step(len(m.group(1)), job_id)
            steps.append(current)
        elif current is not None:
            stripped = raw.strip()
            if stripped:
                indent = len(raw) - len(raw.lstrip(" "))
                if indent <= current.indent:
                    # Dedented back out of this step's body (next job / top-level
                    # key) — nothing further belongs to it.
                    current = None
        if current is None:
            continue
        line = strip_trailing_comment(raw)
        current.lines.append(line)
        m_id = ID_RE.match(line)
        if m_id:
            current.step_id = m_id.group(1)
    return steps


def source_values(step):
    """Values of every `source:` key in this step, block scalars included.

    `source: |` puts the real file list on the FOLLOWING, more-indented lines.
    Reading only the text on the `source:` line itself saw an empty value there
    and reported a legitimately-wired file as unwired — a false RED, which is
    the one failure mode that gets a guard disabled rather than fixed (review
    round 2, MED).
    """
    values = []
    lines = step.lines
    i = 0
    while i < len(lines):
        m = SOURCE_KEY_RE.match(lines[i])
        if not m:
            i += 1
            continue
        key_indent = len(m.group(1))
        inline_value = m.group(2)
        if BLOCK_SCALAR_RE.match(inline_value):
            block = []
            j = i + 1
            while j < len(lines):
                nxt = lines[j]
                if not nxt.strip():
                    block.append("")
                    j += 1
                    continue
                if len(nxt) - len(nxt.lstrip(" ")) <= key_indent:
                    break
                block.append(nxt)
                j += 1
            values.append("\n".join(block))
            i = j
        else:
            values.append(inline_value)
            i += 1
    return values


def mentions(text, filename):
    """Filename occurrence with a right-hand boundary.

    Stops `foo.sql` from being 'found' inside `foo.sql.bak` / `foo.sql_old`.
    """
    return re.search(re.escape(filename) + r"(?![\w.-])", text) is not None


def evidence_lines(text):
    """Lines of `text` that carry wiring, with prose-only lines removed."""
    return [ln for ln in text.split("\n") if not ANNOTATION_RE.search(ln)]


# ---------------------------------------------------------------------------
# Dead-assignment fix (task-ddl-guard-and-ci-noise, item 67, 2026-08-17)
# ---------------------------------------------------------------------------
# `VAR="/opt/crm/.../file.sql"` — a shell variable assignment naming a
# server-side DDL path. Deploy.yml's real apply step is one long multi-file
# script (task-guards-teeth's own docstring above documents this shape): many
# `FOO_FILE="/opt/crm/.../a.sql"` assignments followed, much later in the same
# STEP, by several independent `docker compose ... psql ... < "$FOO_FILE"`
# invocations, one per file.
# Both quote styles are real: deploy.yml's `..._FILE=` assignments are all
# double-quoted today (24/24, grepped), but its scp `source:` values are
# routinely SINGLE-quoted (`source: 'apps/api/drizzle/manual/x.sql'`) — single
# quotes are ordinary, valid bash for this exact shape. Double-quote-only
# matching here produced a FALSE `COPIED BUT NEVER APPLIED` on any apply
# assignment written with single quotes (review round 2, MED-1) — the guard
# refusing something legitimate, which is worse than staying quiet, because a
# false-red guard trains people to stop reading it.
VAR_ASSIGN_RE = re.compile(
    r"^\s*([A-Za-z_][A-Za-z0-9_]*)=(?:\"(/opt/crm/[^\"]*)\"|'(/opt/crm/[^']*)')\s*$"
)


def join_logical_commands(lines):
    """Join `\\`-continued lines into one logical shell command per entry.

    `docker compose \\` / `  -f ... \\` / `  psql ... \\` / `  < "$VAR"` is ONE
    command as far as the shell (and this guard) is concerned. Reading it
    line-by-line is what let a psql invocation five lines away make an
    unrelated `$OTHER_FILE="/opt/crm/.../dead.sql"` assignment look "applied"
    merely by sharing a STEP with it — see resolve_applied_files below.
    """
    logical = []
    buf = []
    for ln in lines:
        if ln.endswith("\\"):
            buf.append(ln[:-1])
            continue
        buf.append(ln)
        logical.append("\n".join(buf))
        buf = []
    if buf:
        logical.append("\n".join(buf))
    return logical


def resolve_applied_files(step, var_files):
    """Server-side paths this step's psql invocation(s) genuinely consume.

    Until the item-67 fix, ANY line containing `/opt/crm` inside a step that
    ran psql ANYWHERE counted as "applied" — so a dead `OTHER_FILE="/opt/crm/
    .../dead.sql"` assignment, written and never referenced again, was
    indistinguishable from the real `DDL_FILE="/opt/crm/.../real.sql"` that a
    `psql ... < "$DDL_FILE"` call three sections later actually reads. Found
    on this guard's own known-limitations paragraph (module docstring above),
    which named the gap but shipped no test for it.

    Fix: a path counts only if it appears on the SAME logical (backslash-
    joined) command as an actual psql invocation — either directly (a literal
    `/opt/crm/....sql` argument, e.g. `-f /opt/crm/.../x.sql`) or indirectly
    through a shell variable referenced on that command (`< "$VAR"`) whose
    assignment is a `/opt/crm/....sql` path. A variable that is assigned but
    never referenced by a psql-invoking command resolves to nothing — exactly
    the dead-assignment case above.

    `var_files` (review round 2, MED-2): a dict the CALLER accumulates and
    mutates across every step of the same JOB, in file order — not rebuilt
    fresh per step. deploy.yml's copy side already uses cross-step data flow
    (`source: '${{ steps.X.outputs.source_list }}'`, handled separately in
    build_zones via STEPS_EXPR_RE); the apply side's idiomatic equivalent is
    `echo "VAR=value" >> "$GITHUB_ENV"` in one step making `$VAR` available to
    every LATER step of the same job. Scoping resolution to a single Step
    object made that shape (assign in step 1, apply in step 3) a false
    `COPIED BUT NEVER APPLIED` — the guard refusing legitimate wiring, which
    is worse than staying quiet (a false-red guard trains people to stop
    reading it). This function updates `var_files` with THIS step's own
    assignments before resolving, so later calls in the same job see them.
    """
    for ln in step.lines:
        m = VAR_ASSIGN_RE.match(ln)
        if m:
            var_files[m.group(1)] = m.group(2) if m.group(2) is not None else m.group(3)

    applied = set()
    for cmd in join_logical_commands(step.lines):
        cmd_lines = cmd.split("\n")
        runs_psql = any(
            PSQL_INVOCATION_RE.search(ln) and not ECHO_LINE_RE.match(ln) for ln in cmd_lines
        )
        if not runs_psql:
            continue
        for varname, path in var_files.items():
            ref_re = re.compile(r"\$\{?" + re.escape(varname) + r"\}?(?![A-Za-z0-9_])")
            if ref_re.search(cmd):
                applied.add(path)
        for m in re.finditer(r"/opt/crm/\S+\.sql", cmd):
            applied.add(m.group(0).rstrip("\"'),;"))
    return applied


def build_zones(steps):
    """Return (copy_texts, apply_texts): the two zones a file must appear in."""
    by_id = {s.step_id: s for s in steps if s.step_id}

    copy_texts = []
    apply_texts = []
    # Job-scoped, cumulative var-assignment maps (MED-2 fix — see
    # resolve_applied_files docstring). Reset whenever job_id changes; steps
    # is already in file order, so iterating it in order and keying by
    # job_id reproduces "every step so far in THIS job", never crossing into
    # a different job (GitHub Actions env vars do not cross job boundaries).
    job_var_files = {}
    for step in steps:
        if "appleboy/scp-action" in step.text:
            for value in source_values(step):
                copy_texts.extend(evidence_lines(value))
                # `source: '${{ steps.X.outputs.source_list }}'` — the real file
                # list lives in step X, which is where to look instead.
                for ref in STEPS_EXPR_RE.findall(value):
                    producer = by_id.get(ref)
                    if producer is not None:
                        copy_texts.extend(evidence_lines(producer.text))

        var_files = job_var_files.setdefault(step.job_id, {})
        apply_texts.extend(resolve_applied_files(step, var_files))

    return copy_texts, apply_texts


def main():
    if not os.path.isfile(DEPLOY_YML):
        print("ERROR: deploy.yml not found: {}".format(DEPLOY_YML))
        return 1

    all_files = collect_all_ddl_files(DDL_MANUAL_DIR)
    deploy_yml_content = read_deploy_yml()

    steps = parse_steps(deploy_yml_content)
    copy_texts, apply_texts = build_zones(steps)
    copy_blob = "\n".join(copy_texts)
    apply_blob = "\n".join(apply_texts)

    candidates = sorted(all_files - KNOWN_NOT_WIRED)
    fully_wired = []
    copy_only = []
    apply_only = []
    unwired = []
    for f in candidates:
        copied = mentions(copy_blob, f)
        applied = mentions(apply_blob, f)
        if copied and applied:
            fully_wired.append(f)
        elif copied:
            copy_only.append(f)
        elif applied:
            apply_only.append(f)
        else:
            unwired.append(f)

    ghost_allowlist = sorted(KNOWN_NOT_WIRED - all_files)
    broken = copy_only + apply_only + unwired

    private_files = collect_all_ddl_files(MANUAL_PRIVATE_DIR)
    private_leaks = find_private_leaks(private_files)

    print("Prod DDL Wiring Guard")
    print("  Total manual DDL files:  {}".format(len(all_files)))
    print("  Copied AND applied:      {}".format(len(fully_wired)))
    print("  Known not-wired (debt):  {}".format(len(KNOWN_NOT_WIRED)))
    print("  Ghost allow-list entries:{}".format(len(ghost_allowlist)))
    print("  BROKEN WIRING:           {}".format(len(broken)))
    print("  Manual-private files:    {}".format(len(private_files)))
    print("  Manual-private LEAKED:   {}".format(len(private_leaks)))

    if ghost_allowlist:
        print()
        print("WARNING: KNOWN_NOT_WIRED entries that no longer exist on disk:")
        for f in ghost_allowlist:
            print("  {}".format(f))
        print("  -> Remove these stale entries from KNOWN_NOT_WIRED in this script.")

    print()
    print("Manual-private DDL inventory (apps/api/drizzle/manual-private/ — hand-run")
    print("only, must NEVER be wired into .github/workflows/**):")
    if private_files:
        for f in sorted(private_files):
            print("  {}".format(f))
    else:
        print("  (none — directory absent or empty)")

    if broken:
        print()
        print("FAIL: the following apps/api/drizzle/manual/*.sql files are not properly")
        print("wired into .github/workflows/deploy.yml and are NOT in KNOWN_NOT_WIRED.")
        print("(Comment-only mentions do NOT count — this guard reads the scp `source:`")
        print("list and the psql apply step, not the prose around them.)")
        if unwired:
            print()
            print("  NEVER COPIED, NEVER APPLIED — nothing in deploy.yml touches these:")
            for f in unwired:
                print("    {}".format(f))
        if copy_only:
            print()
            print("  COPIED BUT NEVER APPLIED — the file lands on the VPS and is then")
            print("  ignored; prod schema stays unchanged while CI looks fine:")
            for f in copy_only:
                print("    {}".format(f))
        if apply_only:
            print()
            print("  APPLIED BUT NEVER COPIED — the apply step will hit its own")
            print("  'DDL file not found' branch on every deploy:")
            for f in apply_only:
                print("    {}".format(f))
        print()
        print("This is exactly the gap that caused the 2026-07-25 prod incident (PR #422's")
        print("vacancy i18n DDL merged but was never applied — GET /api/public/vacancies 500'd).")
        print()
        print("Fix options:")
        print("  1. Wire the file into deploy.yml: add it to the copy-compose job's scp")
        print("     source: list AND add a fail-loud apply step in the deploy job (copy the")
        print("     pattern used for e.g. 2026-07-22_vacancies.sql — that is the DEFAULT for")
        print("     any new schema-changing DDL that should run on every deploy). Both halves")
        print("     are required; either one alone is a silent no-op on prod.")
        print("  2. If the file is genuinely NOT meant to run on every deploy (a one-time")
        print("     data-fix already applied and deliberately de-wired, or a manual/dry-run")
        print("     sibling of an auto-wired file), add it to KNOWN_NOT_WIRED in")
        print("     scripts/devops/check-prod-ddl-wiring.py with a comment explaining why.")
        print()
        print("Rule: every manual DDL file must either run on every deploy or be an explicit,")
        print("reasoned exception — never just forgotten.")

    if private_leaks:
        print()
        print("FAIL: the following apps/api/drizzle/manual-private/*.sql files are")
        print("referenced inside .github/workflows/** — that directory is for SQL run BY")
        print("HAND on the VPS, never through CI: it holds row-level financial detail")
        print("(client names, drop names, per-transaction USDT amounts), and this repo's")
        print("Actions logs are PUBLIC. A workflow that names one of these files risks")
        print("printing that detail into a public log the moment it runs.")
        for filename, wf in private_leaks:
            print("  {} referenced in {}".format(filename, wf))
        print()
        print("Fix: remove the reference. Files under manual-private/ must never be copied")
        print("or applied by any workflow — only run by hand, directly on the VPS.")

    if broken or private_leaks:
        return 1

    print()
    print("OK: every manual DDL file is either copied AND applied by deploy.yml, or")
    print("explicitly acknowledged as intentionally not wired, and no manual-private")
    print("file is referenced by any workflow.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
