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
  vars do not cross them (each job is a fresh runner). Positive test:
  "cross-step $GITHUB_ENV apply assignment" case (same job, resolves —
  proves the false-red is closed). Negative test: "$GITHUB_ENV assignment in
  a DIFFERENT job does not propagate" case (same assignment shape, but the
  psql call is in a different JOB — must stay red, proving the fix stops at
  the job boundary instead of over-correcting into "resolve anywhere in the
  file", which would trade this false-red for a false-green — the wrong
  direction for this guard, same reasoning as the two tests above it). Does
  NOT change today's real deploy.yml behavior: its apply side is still one
  monolithic `run:` block per the module docstring above, so every assignment
  and every psql call already shared one Step; this fix only matters if that
  block is ever split into named steps — which the copy side already is,
  making it the more natural refactor to expect eventually, not a
  hypothetical.

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

ON_ERROR_STOP INVARIANT (task-ddl-flag-audit, backlog item 141, 2026-08-19)
---------------------------------------------------------------------------------
Everything above proves a migration file is copied AND applied. Neither half
says anything about whether the apply actually SUCCEEDED. Measured twice,
independently, on scratch Postgres 16.14, against this repo's real migration
text: a psql invocation WITHOUT `-v ON_ERROR_STOP=1` that hits two `ERROR:`
lines mid-script still exits 0, and the constraint it was supposed to add is
absent from `pg_constraint` afterwards — a half-applied migration reports
SUCCESS. WITH the flag: exit code 3, psql stops at the first error. Every one
of this repo's manual DDL applies has depended, this whole time, on ONE flag
being present on the psql invocation that runs it — nothing in the SQL text
itself enforces it, and nothing until this fix would have caught a deploy
step that forgot it.

`find_psql_without_on_error_stop()` below re-walks the same `steps` this
module already parses for the wiring check and asserts, for every REAL psql
invocation (same definition as the apply-side check above — echoed-only
lines excluded via `ECHO_LINE_RE`, backslash-continued lines joined into one
logical command via `join_logical_commands`) that `-v ON_ERROR_STOP=1`
appears on that same logical command. Deliberately scoped to ALL of
deploy.yml, not just the manual-DDL apply steps the rest of this module
tracks — a health-check or report query is just as capable of masking a real
failure behind a false "success" if it is ever changed into something that
can fail loudly mid-script, and the cost of requiring the flag everywhere is
zero (`-v ON_ERROR_STOP=1` is a no-op for a query that cannot itself error
out of a valid syntax). No allowlist/escape-hatch for this one, unlike
KNOWN_NOT_WIRED above — every psql invocation in today's deploy.yml already
carries the flag (verified: 30/30, `grep -c 'psql -U' deploy.yml` ==
`grep -c` of the same restricted to lines that also carry the flag), so there
is no real exception to encode. If one is ever genuinely needed, add a
reasoned comment at the call site and a matching allowlist entry then —
never a silent omission.

SINGLE-TRANSACTION and HARD-REQUIRED LIST CONTINUATION (backlog 337, 2026-10-25)
---------------------------------------------------------------------------------
A file whose header declares `psql ... --single-transaction < <this file>` must be
applied with that flag (or `-1`), and both hard-required path lists must be
unbroken backslash-continued commands. See the sections of those names below.

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
RUNBOOK_MD = os.path.join(REPO_ROOT, "docs", "runbooks", "deployment.md")

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


# A step that passes its body as `script_path:` instead of an inline `script:`.
# `${{ github.workspace }}/` is the only expression this guard will resolve — a
# computed path is refused rather than skipped (see expand_script_paths).
# NB the value is NOT `\S+`: `${{ github.workspace }}` has spaces inside the
# expression, and an anchored `\S+` silently failed to match the real line —
# which made this whole expansion a no-op and the guard green with nothing to
# check. Caught only because the guard was re-run and still refused.
SCRIPT_PATH_RE = re.compile(r"^(\s*)script_path:\s*(.+?)\s*$")
WORKSPACE_PREFIX = "${{ github.workspace }}/"

# A step whose ENTIRE script is a dispatch to a file already on the VPS:
#   script: bash /opt/crm/scripts/devops/deploy-stack-on-vps.sh
# This is the shape the deploy step took after `script_path:` turned out to ship
# the body as a command string too (see expand_script_paths). The path is a VPS
# path; what must be opened is the REPOSITORY file that gets scp'd there, so the
# `/opt/crm/` prefix is translated to REPO_ROOT. Deliberately anchored to a
# whole-line match: a `bash /opt/crm/...` buried inside a larger script body is
# NOT followed, because then the body itself is still in view and recursing adds
# surface without adding visibility.
VPS_DISPATCH_RE = re.compile(r"^(\s*)script:\s*bash\s+/opt/crm/(\S+)\s*$")


def expand_script_paths(content):
    """Inline every `script_path:` file back into the YAML text.

    WHY (task-infra-deploy-arglist-too-long, 2026-10-19): the DDL apply steps
    this whole module reasons about used to sit in deploy.yml as one 2358-line
    inline `script:` block. That block hit Linux MAX_ARG_STRLEN — appleboy/
    ssh-action passes `script:` as the single env string INPUT_SCRIPT, so
    execve could no longer spawn bash and `main` stopped being deployable at
    all. The body moved to scripts/devops/deploy-stack-on-vps.sh.

    TWO delivery shapes are therefore followed, because the first attempt at
    that move did not work: `script_path:` (PR #1035) is still read into the
    same command string drone-ssh sends to ssh.Stream, so the remote /bin/bash
    refused it in turn, and the step became `script: bash /opt/crm/<path>` with
    the file delivered by scp. Both forms are expanded here — the one that
    failed included, since nothing stops a future step from using it.

    Had this function not been written in the same change, THIS GUARD WOULD
    HAVE GONE GREEN WITH ZERO APPLY STEPS IN ITS FIELD OF VIEW — the precise
    shape of the 2026-07-25 incident it exists to prevent, one file over, and
    with every DDL file on prod silently unwatched. It is the same failure as
    check-guard-tests-exist.sh's own blind spot: an inventory defined by where
    something lives rather than by what it is.

    So the deploy surface is defined as "deploy.yml plus whatever its steps
    execute", and the expansion is textual and in-place: the referenced file is
    spliced in under a synthetic `script: |` at the same indentation the inline
    block had. Every analysis downstream (step parsing, comment stripping,
    psql/ON_ERROR_STOP checks, apply ORDER) then sees text of exactly the shape
    it saw before the split, and needed no changes whatsoever — which is the
    point: this function is the only thing that knows about the split.
    """
    out = []
    for raw in content.splitlines():
        md = VPS_DISPATCH_RE.match(raw)
        if md:
            indent, rel = md.group(1), md.group(2)
            path = os.path.join(REPO_ROOT, rel)
            if not os.path.isfile(path):
                raise SystemExit(
                    "ERROR: {} dispatches the whole step to `bash /opt/crm/{}`, but this\n"
                    "repository has no {}. The VPS copy comes from the repository via scp, so a\n"
                    "path with no repository file behind it is a step whose contents this guard\n"
                    "cannot audit — and an unauditable step is how prod DDL stops being\n"
                    "watched. Fail loud rather than skip.".format(
                        os.path.relpath(DEPLOY_YML, REPO_ROOT), rel, rel
                    )
                )
            with open(path, "r") as f:
                body = f.read().splitlines()
            body_indent = indent + "  "
            out.append("{}script: |".format(indent))
            out.extend((body_indent + line) if line.strip() else "" for line in body)
            continue

        m = SCRIPT_PATH_RE.match(raw)
        if not m:
            out.append(raw)
            continue
        indent, ref = m.group(1), m.group(2)
        if not ref.startswith(WORKSPACE_PREFIX):
            raise SystemExit(
                "ERROR: {} has `script_path: {}`, which this guard cannot resolve.\n"
                "Only `{}<repo-relative path>` is understood. A path this guard cannot\n"
                "read is a step whose contents it cannot audit, and silently skipping it\n"
                "is how DDL stops being watched — so this is a hard failure. Use the\n"
                "workspace-relative form, or teach expand_script_paths() about the new one.".format(
                    os.path.relpath(DEPLOY_YML, REPO_ROOT), ref, WORKSPACE_PREFIX
                )
            )
        rel = ref[len(WORKSPACE_PREFIX) :]
        path = os.path.join(REPO_ROOT, rel)
        if not os.path.isfile(path):
            raise SystemExit(
                "ERROR: {} points `script_path:` at {}, which does not exist.\n"
                "That is a broken deploy, not a guard problem: the step would fail on the\n"
                "runner before it ever reached the VPS.".format(
                    os.path.relpath(DEPLOY_YML, REPO_ROOT), rel
                )
            )
        with open(path, "r") as f:
            body = f.read().splitlines()
        body_indent = indent + "  "
        out.append("{}script: |".format(indent))
        out.extend((body_indent + line) if line.strip() else "" for line in body)
    return "\n".join(out)


def read_deploy_yml():
    with open(DEPLOY_YML, "r") as f:
        return expand_script_paths(f.read())


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


# ---------------------------------------------------------------------------
# ON_ERROR_STOP invariant (task-ddl-flag-audit, item 141, 2026-08-19 — see the
# module docstring section of the same name for the measured incident this
# guards against).
# ---------------------------------------------------------------------------
ON_ERROR_STOP_RE = re.compile(r"-v\s+ON_ERROR_STOP=1")


def find_psql_without_on_error_stop(steps):
    """Every real psql invocation across ALL of deploy.yml must carry
    `-v ON_ERROR_STOP=1` on the SAME logical (backslash-joined) command —
    otherwise a failing statement partway through a multi-statement DDL file
    can leave psql to keep going, exit 0, and report success on a migration
    that only partially applied.

    Reuses PSQL_INVOCATION_RE / ECHO_LINE_RE / join_logical_commands from the
    wiring check above — same definition of "a real invocation" (an echoed
    `psql ...` inside a string does not count; a bare `docker compose exec
    postgres psql ...` line does), same edge cases already fought over there.

    Returns a list of (job_id, evidence_line) pairs, one per offending
    invocation. `evidence_line` is the line carrying the actual `psql` call
    (not just any line of the joined command), so the report points a human
    straight at the thing to fix.
    """
    missing = []
    for step in steps:
        for cmd in join_logical_commands(step.lines):
            cmd_lines = cmd.split("\n")
            invokes_psql = any(
                PSQL_INVOCATION_RE.search(ln) and not ECHO_LINE_RE.match(ln) for ln in cmd_lines
            )
            if not invokes_psql or ON_ERROR_STOP_RE.search(cmd):
                continue
            evidence = next(
                (ln.strip() for ln in cmd_lines if PSQL_INVOCATION_RE.search(ln)),
                cmd_lines[0].strip(),
            )
            missing.append((step.job_id, evidence))
    return missing


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


# ---------------------------------------------------------------------------
# HARD-REQUIRED FILE LIST MIRROR INVARIANT (task-infra-rollback-deploys-not-
# rebuilds, PR #615 round 4, 2026-08-30)
# ---------------------------------------------------------------------------
# PR #615 round 3 (SR-H-3) added a preflight step to deploy.yml's `build` job
# — "Verify rollback target commit has all hard-required files" — that checks
# a rollback target commit against a hardcoded `for FILE in \ ... ; do` list
# of every path the deploy pipeline treats as UNCONDITIONALLY present. The
# same round's SR-M-3 added a `git log -1 -- <paths>` command to
# docs/runbooks/deployment.md §9 that lets an operator compute today's actual
# rollback-depth floor WITHOUT waiting for the preflight to fail — and that
# command's own comment says the enforcement mechanism in so many words:
# "Список путей — сознательное зеркало ... если тот список меняется ... эта
# команда должна измениться тем же PR, иначе она снова начнёт врать про
# предел".
#
# That sentence IS the entire enforcement: a comment asking whoever edits one
# list to remember the other. This guard already exists because that exact
# failure mode — a comment asking for a synchronized edit, nothing checking
# that it happened — put unapplied DDL on prod once (module docstring above,
# PR #422). Extending it here rather than writing a second guard: the failure
# mode is identical, only the two texts being compared moved from (scp
# source: / psql apply) to (deploy.yml preflight list / runbook mirror
# command).
#
# Drift in EITHER direction is a real bug, not just untidiness:
#   - a file in the preflight list but missing from the runbook command makes
#     the runbook UNDER-report the safe floor: its answer looks older/safer
#     than reality, an operator picks a rollback target the runbook's own
#     advice called safe, and the preflight refuses it anyway — the runbook
#     lied, even though the preflight itself still caught the real problem.
#   - a file in the runbook command but missing from the preflight list means
#     the runbook enforces a STRICTER floor than the pipeline actually does —
#     the opposite direction, equally a lie about what the code does, and the
#     more dangerous one to leave undetected if it ever flips into the
#     preflight being the one that is actually too permissive.
#
# WHY THIS DOES NOT NEED A WORKFLOW PARSER: both lists share one shape — one
# path per line, backslash-continued — a bash `for FILE in \ ... ; do` block
# and a `git log -1 ... -- \ ...` block respectively. Extracting them is a
# couple of line-anchored regexes, not a grammar. What gets checked is SET
# EQUALITY of two path lists — nothing about whether either list is itself
# semantically correct (that would require classifying which DDL files are
# genuinely UNCONDITIONAL vs GUARDED — real work, deliberately left alone
# here, same kind of boundary this file's own KNOWN LIMITATIONS paragraph
# draws elsewhere).
#
# GATED ON PRESENCE, NOT ASSUMED: `extract_preflight_files` /
# `extract_runbook_mirror_files` return (None, None) when their anchor
# pattern is absent. `for FILE in \` is this one step's specific shape, not a
# generic pattern that could accidentally match one of this repo's many
# OTHER for-loops or git-log invocations (verified: exactly one occurrence of
# each anchor, in deploy.yml / deployment.md, as of this guard's
# introduction — `grep -n` both). Both absent -> the feature does not exist
# in this checkout at all -> silently skipped. This is what keeps every OTHER
# fixture in this guard's own test suite green: none of them model this
# step, so this whole invariant is a no-op for them, by construction rather
# than by exemption. Exactly one of the two present -> that gap IS the drift
# (one side gained or lost the step, the other did not follow) -> reported
# below at the same severity as a set mismatch.
#
# ANCHOR MUST BE UNIQUE (PR #615 round 5, LOW): "verified: exactly one
# occurrence" above was a one-time manual check at introduction time, not
# something later edits are held to. Both extract functions now COUNT anchor
# matches instead of taking the first one silently: a second `for FILE in \`
# (or `git log -1 ... -- \`) block added anywhere ABOVE the real one would
# otherwise make extraction compare against the wrong block without any
# indication that it did — the same "silently not the thing you meant" class
# every other invariant in this section exists to refuse. Two-or-more is
# reported as its own structural error, same severity as a set mismatch,
# never silently resolved to "the first match wins".
FOR_FILE_LOOP_RE = re.compile(r"for\s+FILE\s+in\s+\\\s*$")
FOR_LOOP_END_RE = re.compile(r"^\s*;\s*do\s*$")
RUNBOOK_GITLOG_RE = re.compile(r"git log -1 .* -- \\\s*$")
RUNBOOK_FENCE_RE = re.compile(r"^\s*```")


def _extract_backslash_list(lines, start_index, end_re):
    """Collect one-path-per-line entries after `lines[start_index]` until a
    line matching `end_re`, stripping a trailing continuation backslash and
    skipping blank lines. Returns None if `end_re` is never reached — a
    malformed or edited-away block, treated the same as "not found" by the
    caller. That is the conservative direction: this check should never
    invent a comparison out of a block it could not cleanly close.
    """
    files = []
    j = start_index + 1
    while j < len(lines):
        raw = lines[j]
        if end_re.match(raw):
            return files
        token = raw.strip()
        if token.endswith("\\"):
            token = token[:-1].strip()
        if token:
            files.append(token)
        j += 1
    return None


def extract_preflight_files(deploy_yml_content):
    """The `for FILE in \\ ... ; do` path list in deploy.yml's hard-required-
    files preflight step.

    Returns (files, error) — `files` is None if that step is not present in
    this checkout; `error` is a human-readable string (files then also None)
    if the anchor matches MORE than once, since picking "the first match"
    silently would compare against a for-loop that may not be the real
    preflight step (PR #615 round 5, LOW).
    """
    lines = deploy_yml_content.splitlines()
    matches = [i for i, ln in enumerate(lines) if FOR_FILE_LOOP_RE.search(ln)]
    if not matches:
        return None, None
    if len(matches) > 1:
        return None, (
            "deploy.yml has {} lines matching the rollback preflight's `for "
            "FILE in \\` anchor — expected at most one. Extraction would "
            "silently use the FIRST match, which may not be the real "
            "'Verify rollback target commit has all hard-required files' "
            "step. Rename or remove the extra for-loop so the anchor is "
            "unambiguous again.".format(len(matches))
        )
    return _extract_backslash_list(lines, matches[0], FOR_LOOP_END_RE), None


def extract_runbook_mirror_files(runbook_content):
    """The `git log -1 ... -- \\ ...` path list in the runbook's rollback-
    depth-limit command.

    Returns (files, error) — `files` is None if that command is not present
    (including the case where the runbook file itself does not exist,
    `runbook_content is None`); `error` is a human-readable string (files
    then also None) if the anchor matches MORE than once, same reasoning as
    `extract_preflight_files` above (PR #615 round 5, LOW).
    """
    if runbook_content is None:
        return None, None
    lines = runbook_content.splitlines()
    matches = [i for i, ln in enumerate(lines) if RUNBOOK_GITLOG_RE.search(ln)]
    if not matches:
        return None, None
    if len(matches) > 1:
        return None, (
            "docs/runbooks/deployment.md has {} lines matching the "
            "rollback-depth-limit `git log -1 ... -- \\` anchor — expected "
            "at most one. Extraction would silently use the FIRST match, "
            "which may not be the real rollback-depth-limit command. Rename "
            "or remove the extra command so the anchor is unambiguous "
            "again.".format(len(matches))
        )
    return _extract_backslash_list(lines, matches[0], RUNBOOK_FENCE_RE), None


def check_hard_required_mirror(preflight_result, runbook_result):
    """Returns (only_in_preflight, only_in_runbook, structural_error).

    `preflight_result` / `runbook_result` are the (files, error) pairs
    returned by `extract_preflight_files` / `extract_runbook_mirror_files` —
    computed once in `main()` and passed in here (and reused by
    `check_preflight_covers_unconditional_scp` below) rather than
    re-extracted, so an ambiguous-anchor error is reported exactly once.

    `structural_error` is a human-readable string when either side's anchor
    was ambiguous, or when exactly one side has the step and the other does
    not (a mirror missing one half cannot be set-compared); otherwise None,
    and the two lists — possibly both empty — are compared by set
    difference.
    """
    preflight_files, preflight_error = preflight_result
    runbook_files, runbook_error = runbook_result

    if preflight_error or runbook_error:
        return [], [], "\n".join(e for e in (preflight_error, runbook_error) if e)

    if preflight_files is None and runbook_files is None:
        return [], [], None

    if preflight_files is None:
        return (
            [],
            [],
            "docs/runbooks/deployment.md has the rollback-depth-limit `git log -1 "
            "-- <paths>` command, but .github/workflows/deploy.yml's `build` job "
            "has no matching 'Verify rollback target commit has all hard-required "
            "files' step (its `for FILE in \\ ... ; do` block was not found). "
            "Restore that step, or remove the now-stale command from the runbook "
            "if the preflight check was deliberately dropped.",
        )

    if runbook_files is None:
        return (
            [],
            [],
            "deploy.yml's `build` job has the 'Verify rollback target commit has "
            "all hard-required files' preflight step, but docs/runbooks/"
            "deployment.md has no matching `git log -1 -- <paths>` command (or "
            "the file does not exist). Add that command back to deployment.md §9 "
            "— it is what lets an operator compute today's rollback-depth floor "
            "without first triggering the preflight failure.",
        )

    only_in_preflight = sorted(set(preflight_files) - set(runbook_files))
    only_in_runbook = sorted(set(runbook_files) - set(preflight_files))
    return only_in_preflight, only_in_runbook, None


# ---------------------------------------------------------------------------
# PREFLIGHT-COVERS-SOURCE INVARIANT (task-infra-rollback-deploys-not-rebuilds,
# PR #615 round 5, security review round 4 finding SR-M-5, 2026-08-30)
# ---------------------------------------------------------------------------
# `check_hard_required_mirror` above proves the preflight list and the
# runbook command agree with EACH OTHER. It cannot prove either one is
# actually correct — its own module-docstring-adjacent comment already says
# so ("not that either one is itself the semantically correct list"). SR-M-5
# found the gap this leaves open: `scripts/devops/pg-backup.sh` and
# `scripts/devops/check-backup-freshness.sh` sat in copy-compose's fixed,
# UNCONDITIONAL `source:` list (no `if:` on that step — it runs on every
# deploy, automatic or rollback) while being absent from BOTH the preflight
# list and the runbook mirror. Two lists that agree with each other while
# both being wrong the same way produce a drift of zero — the mirror check
# is a no-op for exactly this class of bug, by construction, not by
# oversight.
#
# The fix compares the preflight list against the one thing that is not a
# hand-maintained copy: the actual `source:` values of every scp-action step
# in deploy.yml that carries NO `if:` key anywhere in its own body. Four such
# steps exist today — the "big" first one (14 files: two compose files, eight
# early DDL files, the two security-check scripts, and the two backup
# scripts) plus four later single-file steps, one per newest DDL file added
# after that big step existed (2026-08-19 through 2026-08-22, see the `build`
# job's own "Rollback path" comment for why those four are separate steps at
# all) — 18 files total, matching SR-M-5's count exactly.
#
# SUPERSET, not set equality (see `check_preflight_covers_unconditional_scp`
# docstring below for why): every file an unconditional scp step copies MUST
# be in the preflight list, but the preflight list may legitimately name a
# file no scp step ever copies (some other unconditionally-present
# mechanism this guard does not need to enumerate to check this direction).
#
# WHY `if:` PRESENCE ALONE, NOT ITS VALUE: distinguishing "guarded, but this
# particular condition always evaluates true" from "genuinely unconditional"
# needs GitHub Actions expression semantics — exactly the kind of
# interpretive work the HARD-REQUIRED FILE LIST MIRROR INVARIANT section
# above already declines ("classifying which DDL files are genuinely
# UNCONDITIONAL vs GUARDED — real work, deliberately left alone here").
# Presence of `if:` is a SYNTACTIC fact, checked exactly that way here too —
# every scp-action step in this repo's deploy.yml today is either truly
# unconditional (no `if:` at all) or guarded by an `if:` that reads a prior
# step's own output (a DDL-file-existence check), so this simplification
# misclassifies nothing that exists in this file.
IF_KEY_RE = re.compile(r"^\s*if:\s*\S")
SCP_ACTION_USES_RE = re.compile(r"^\s*uses:\s*appleboy/scp-action@")


# The step that pins a rollback run's checkout to the commit being redeployed.
# Matched by what it DOES (`git checkout "$TARGET"`), not by its name, so a
# renamed step does not silently widen the scope below.
ROLLBACK_PIN_RE = re.compile(r"^\s*git checkout \"\$TARGET\"\s*$")


def rollback_pinned_job_ids(steps):
    """Job ids containing a step that pins the checkout to the rollback target."""
    return {
        step.job_id
        for step in steps
        if any(ROLLBACK_PIN_RE.match(line) for line in step.lines)
    }


def unconditional_scp_source_files(steps):
    """Every path named in the `source:` of an scp-action step that has NO
    `if:` key anywhere in its own body — i.e. a step this pipeline always
    runs, on both the automatic-deploy and rollback paths.

    Only splits a literal, comma-separated `source:` value — the shape every
    UNCONDITIONAL scp step in this repo uses today (single file or a fixed
    comma list). A `${{ steps.X.outputs.Y }}` expression source is used only
    by the GUARDED steps (already excluded by the `if:` check above), so
    resolving it via `STEPS_EXPR_RE` the way `build_zones` does for the
    copy-wiring check above would add real complexity for a case that does
    not occur.
    """
    pinned_jobs = rollback_pinned_job_ids(steps)
    files = set()
    for step in steps:
        if not any(SCP_ACTION_USES_RE.match(line) for line in step.lines):
            continue
        if any(IF_KEY_RE.match(line) for line in step.lines):
            continue
        # SCOPE: only scp steps in a job whose checkout is PINNED to the rollback
        # target. The whole hazard is "the rollback target predates this file, so
        # the scp finds nothing" — which can only happen where the checkout is
        # the rollback commit. A job that checks out the workflow's own ref
        # (the `deploy` job, which scp's scripts/devops/deploy-stack-on-vps.sh)
        # always has its files by construction, so requiring them in the
        # rollback preflight would be false: it would make every rollback to a
        # commit older than that file fail the preflight for no reason, which is
        # a worse outcome than the one this check exists to prevent. If no pinned
        # job can be identified the scope stays ALL jobs — over-reporting fails
        # loud, under-reporting goes blind.
        if pinned_jobs and step.job_id not in pinned_jobs:
            continue
        for value in source_values(step):
            for token in value.split(","):
                token = token.strip().strip("'\"")
                if token:
                    files.add(token)
    return files


def check_preflight_covers_unconditional_scp(preflight_result, steps):
    """Paths an UNCONDITIONAL scp-action step copies to the VPS that the
    rollback preflight's own `for FILE in \\` list does not require.

    Empty (a no-op, same as the mirror invariant above) when the preflight
    step is absent from this checkout, or when its anchor was ambiguous —
    that error is already reported by `check_hard_required_mirror`, and
    this function does not have a meaningful preflight list to check
    coverage against in either case.

    SUPERSET check, not set equality: the preflight list is allowed to name
    MORE than this function returns (a file made unconditionally present by
    some other mechanism); it must never require LESS, or a rollback target
    that passes the preflight can still fail deep inside `copy-compose` —
    after `write-env` has already reached the VPS — which is the exact
    SR-H-3 failure mode this preflight step exists to prevent, reopened
    through the one file class the mirror-vs-mirror check cannot see.
    """
    preflight_files, preflight_error = preflight_result
    if preflight_files is None or preflight_error:
        return []
    return sorted(unconditional_scp_source_files(steps) - set(preflight_files))


# ---------------------------------------------------------------------------
# APPLY-ORDER INVARIANTS (task-infra db-least-privilege-roles, PR #1027 fix
# round, 2026-10-18)
# ---------------------------------------------------------------------------
# The privilege grants file names every relation explicitly, so it only covers
# what already exists when it runs; the privileges check validates the state it
# runs in. Two consequences, each of which once held only by position:
#
#   1. GRANTS-AFTER-CREATORS: no file applied AFTER the grants may create a
#      table, view, materialized view or sequence. A relation created later
#      ends the deploy ungranted. This was broken in the first wiring (the
#      multipart-salary `prepare` file creates `salary_month_initializations`
#      and sat after the grants); it was invisible on production because the
#      table already existed there, and only a FRESH database would have shown
#      it. The justification written next to the grants asserted the opposite
#      and nothing checked it.
#   2. CHECK-LAST: the privileges check must be the final file psql applies, so
#      the state it validates is the end state of the deploy. A first run
#      before the container swap is fine (it fails the deploy while the old API
#      is still serving) as long as a run ALSO closes the sequence.
#
# BOTH are derived from deploy.yml itself, the way a human derives them: walk
# the apply step in text order (execution order inside one script), resolving
# `psql ... < "$VAR"` the same way the wiring check does, then read each file
# applied after the grants and look for a relation-creating statement. There is
# deliberately no hand-maintained list of creator files — that would be the
# same fragility one level up. The only literals are the two ANCHOR files the
# invariants are about.
#
# Gated on presence: with no grants file in the apply sequence (fixtures, or a
# repo that has not adopted the roles work) invariant 1 is skipped; likewise
# invariant 2 without the check file.
#
# KNOWN LIMITS, stated: text order is execution order only inside the single
# job that applies the grants (steps of one job run sequentially; across jobs it
# need not), so the sequence is taken from that job alone. Only files applied
# through psql are seen; DDL issued any other way (an inline `psql -c`) is not.
GRANTS_FILE = "2026-10-18_db_grants.sql"
PRIVILEGES_CHECK_FILE = "2026-10-18_db_privileges_check.sql"

RELATION_CREATING_RE = re.compile(
    r"\bCREATE\s+(?:OR\s+REPLACE\s+)?"
    r"(?:(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP(?:ORARY)?|UNLOGGED|RECURSIVE|FOREIGN)\s+)*"
    r"(?:TABLE|VIEW|MATERIALIZED\s+VIEW|SEQUENCE)\b"
    # A serial / identity column creates an owned sequence, which the check's
    # relkind 'S' pass covers as well.
    r"|\b(?:BIG|SMALL)?SERIAL\b|\bAS\s+IDENTITY\b",
    re.IGNORECASE,
)
SQL_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)
SQL_LINE_COMMENT_RE = re.compile(r"--[^\n]*")


def ordered_applied_files(steps, job_id):
    """File names psql applies in the given job, in execution (text) order.

    A file applied several times appears several times. Assignments are
    resolved in sequence (not collected up front), so a re-used variable name
    resolves to the file it held at that point. The resolution itself lives in
    applied_commands() below (one implementation, review PR #1155 CR-M-2).
    """
    return [name for j, name, _cmd in applied_commands(steps) if j == job_id]


def creates_relation(ddl_dir, filename):
    """True when the file, comments removed, contains a relation-creating statement."""
    path = os.path.join(ddl_dir, filename)
    if not os.path.isfile(path):
        return False
    with open(path, "r") as f:
        sql = f.read()
    sql = SQL_LINE_COMMENT_RE.sub("", SQL_BLOCK_COMMENT_RE.sub("", sql))
    return RELATION_CREATING_RE.search(sql) is not None


def check_apply_order(steps, ddl_dir):
    """Return a list of (invariant, filename, message) violations."""
    violations = []
    for job_id in sorted({s.job_id for s in steps}):
        sequence = ordered_applied_files(steps, job_id)
        if GRANTS_FILE in sequence:
            last_grants = len(sequence) - 1 - sequence[::-1].index(GRANTS_FILE)
            seen = set()
            for position, name in enumerate(sequence[last_grants + 1 :], start=last_grants + 2):
                if name in seen or name == GRANTS_FILE:
                    continue
                # A file whose FIRST application is above the grants has already
                # created its relations by then; a later re-run (deploy.yml
                # re-applies the drop_cascade_origin marker as a post-cutover
                # second pass) cannot create a new one. Judge by first application.
                if sequence.index(name) <= last_grants:
                    continue
                seen.add(name)
                if creates_relation(ddl_dir, name):
                    violations.append(
                        (
                            "GRANTS-AFTER-CREATORS",
                            name,
                            "creates a table, view, materialized view or sequence but is applied "
                            "AFTER {} (apply #{} of {} in its job, grants at #{}), so on a fresh "
                            "database that relation ends the deploy ungranted".format(
                                GRANTS_FILE, position, len(sequence), last_grants + 1
                            ),
                        )
                    )
        if PRIVILEGES_CHECK_FILE in sequence and sequence[-1] != PRIVILEGES_CHECK_FILE:
            violations.append(
                (
                    "CHECK-LAST",
                    sequence[-1],
                    "is applied AFTER the last run of {} (the check is at #{} of {}), so the "
                    "check validates a state that is not the end state of the deploy".format(
                        PRIVILEGES_CHECK_FILE,
                        len(sequence) - sequence[::-1].index(PRIVILEGES_CHECK_FILE),
                        len(sequence),
                    ),
                )
            )
    return violations


# ---------------------------------------------------------------------------
# SINGLE-TRANSACTION INVARIANT (backlog 337, task-devops-wiring-A-staged-ddl,
# 2026-10-25)
# ---------------------------------------------------------------------------
# Some manual files are only correct when psql applies them as ONE transaction:
# the job-sources manifest delta ends in a RAISE (an operator-made row swallowed
# an insert), and without `--single-transaction` its earlier steps commit while
# the later ones never run — a half-applied migration behind a loud failure.
# Until this check, the only thing that said so was the drift spec, which proves
# the file's DOCUMENTED apply line carries the flag; the real psql call lives in
# scripts/devops/deploy-stack-on-vps.sh, and nothing went red if it omitted it.
#
# Which files need it is read from the files themselves, not from a list here:
# a file whose comments carry an apply line of the form
#     --   psql -v ON_ERROR_STOP=1 --single-transaction < <this file>
# (or `-1`) declares the requirement, and every psql command in the deploy that
# applies that file must then carry `--single-transaction` or `-1` on the same
# logical (backslash-joined) command. A new file with such a header is covered
# the moment it lands in manual/, with no edit to this guard. Files that must NOT
# run in one transaction (CONCURRENTLY, a new enum value used in the same file)
# say so in prose ("MUST NOT be applied with `psql -1`"), which this pattern does
# not match: it requires the line to START with the psql invocation.
REQUIRES_SINGLE_TX_RE = re.compile(
    r"^--\s+psql\b[^\n]*?(?:--single-transaction|(?<!\S)-1(?!\S))", re.MULTILINE
)
SINGLE_TX_FLAG_RE = re.compile(r"(?<!\S)(?:--single-transaction|-1)(?!\S)")

# Files KNOWN to need one transaction, pinned by name (security review PR #1155,
# SR-M-1). Header discovery alone fails open: reformat a header so the pattern
# stops matching and the file silently leaves the check, the count drops and the
# guard stays green. A pinned file that is in manual/ but no longer declares the
# apply line is a failure of its own. Discovery stays for every other file.
PINNED_SINGLE_TX_FILES = {
    "2026-10-24_job_run_single_flight.sql",
    "2026-10-24_job_sources_manifest_delta.sql",
    "2026-10-24_job_source_hosts.sql",
    "2026-10-24_job_sources_host_keys.sql",
}


def requires_single_transaction(ddl_dir, filename):
    """True when the file declares a `psql ... --single-transaction` apply line."""
    path = os.path.join(ddl_dir, filename)
    if not os.path.isfile(path):
        return False
    with open(path, "r") as f:
        return REQUIRES_SINGLE_TX_RE.search(f.read()) is not None


def applied_commands(steps):
    """(job_id, file name, logical command) for every psql command that applies
    a /opt/crm/....sql file, resolving `< "$VAR"` per job in text order and,
    within one command, in the order the files appear. ordered_applied_files
    (the apply-order invariants) is a projection of this list."""
    out = []
    var_files_by_job = {}
    for step in steps:
        var_files = var_files_by_job.setdefault(step.job_id, {})
        for cmd in join_logical_commands(step.lines):
            cmd_lines = cmd.split("\n")
            if len(cmd_lines) == 1:
                m = VAR_ASSIGN_RE.match(cmd_lines[0])
                if m:
                    var_files[m.group(1)] = m.group(2) if m.group(2) is not None else m.group(3)
                    continue
            if not any(
                PSQL_INVOCATION_RE.search(ln) and not ECHO_LINE_RE.match(ln) for ln in cmd_lines
            ):
                continue
            found = []
            for varname, path in var_files.items():
                ref = re.search(r"\$\{?" + re.escape(varname) + r"\}?(?![A-Za-z0-9_])", cmd)
                if ref:
                    found.append((ref.start(), path))
            for m in re.finditer(r"/opt/crm/\S+\.sql", cmd):
                found.append((m.start(), m.group(0).rstrip("\"'),;")))
            for _pos, path in sorted(found):
                out.append((step.job_id, os.path.basename(path), cmd))
    return out


def find_single_transaction_gaps(steps, ddl_dir, files):
    """[(file, evidence line)] for each apply of a file that declares it needs
    one transaction, whose psql command carries neither `--single-transaction`
    nor `-1`. Returns the required set too, so the summary can print how many
    files the check actually covered (a 0 there means "nothing to check", not
    "checked and fine")."""
    declared = {f for f in files if requires_single_transaction(ddl_dir, f)}
    # SR-M-3 (security review PR #1155): the pin is by NAME, not by presence in
    # `files`. A pinned file moved out of manual/ or parked in KNOWN_NOT_WIRED
    # while the deploy still applies it would otherwise drop out of `required`
    # and its flag go unchecked, with the count merely shrinking.
    applied_names = {name for _job_id, name, _cmd in applied_commands(steps)}
    required = sorted(declared | (PINNED_SINGLE_TX_FILES & (set(files) | applied_names)))
    gaps = []
    for name in sorted(PINNED_SINGLE_TX_FILES & applied_names - set(files)):
        gaps.append(
            (
                name,
                "pinned in PINNED_SINGLE_TX_FILES and still applied by the deploy, but "
                "it is not a wired file in manual/ (moved, deleted or in KNOWN_NOT_WIRED)",
            )
        )
    for name in sorted((PINNED_SINGLE_TX_FILES & set(files)) - declared):
        gaps.append(
            (
                name,
                "pinned in PINNED_SINGLE_TX_FILES, but its header no longer carries a "
                "`--   psql ... --single-transaction < <this file>` apply line",
            )
        )
    for _job_id, name, cmd in applied_commands(steps):
        if name not in required or SINGLE_TX_FLAG_RE.search(cmd):
            continue
        cmd_lines = cmd.split("\n")
        evidence = next(
            (ln.strip() for ln in cmd_lines if PSQL_INVOCATION_RE.search(ln)),
            cmd_lines[0].strip(),
        )
        gaps.append((name, evidence))
    return required, gaps


# ---------------------------------------------------------------------------
# HARD-REQUIRED LIST CONTINUATION (task-devops-wiring-A-staged-ddl, 2026-10-25)
# ---------------------------------------------------------------------------
# Both hard-required lists are ONE shell command spread over backslash-continued
# lines. _extract_backslash_list skips blank lines, which is right for set
# comparison and wrong for the shell: a blank line (or a path with no trailing
# `\`) ends the command there. Found on main: a blank line after
# 2026-10-10_salary_creation_intent.sql in BOTH lists, so the preflight's
# `for FILE in` was a bash syntax error (every rollback dispatch failed at that
# step) and the runbook's `git log -1` silently dropped every later path (the
# floor it printed was too old). The mirror check stayed green because both
# copies carried the same break. This check reads the lists the way bash does.
def find_broken_continuations(content, anchor_re, end_re, last_may_end, label):
    """Lines inside the anchored list that break the backslash continuation.
    `last_may_end` allows the final line before `end_re` to end the command
    (the runbook's `git log` list); the preflight's last path must still end in
    `\\` because `; do` follows on its own line."""
    if content is None:
        return []
    lines = content.splitlines()
    starts = [i for i, ln in enumerate(lines) if anchor_re.search(ln)]
    if len(starts) != 1:
        return []  # absent or ambiguous: reported by the mirror check
    body = []
    j = starts[0] + 1
    while j < len(lines) and not end_re.match(lines[j]):
        body.append((j + 1, lines[j]))
        j += 1
    if j >= len(lines):
        return []  # never closed: _extract_backslash_list already treats as absent
    broken = []
    for idx, (lineno, raw) in enumerate(body):
        if last_may_end and idx == len(body) - 1:
            continue
        if not raw.rstrip().endswith("\\"):
            broken.append((label, lineno, raw.strip() or "(blank line)"))
    return broken


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

    flag_gaps = find_psql_without_on_error_stop(steps)

    runbook_content = None
    if os.path.isfile(RUNBOOK_MD):
        with open(RUNBOOK_MD, "r") as f:
            runbook_content = f.read()

    # Extracted ONCE, reused by both invariants below — an ambiguous-anchor
    # error (PR #615 round 5, LOW) is then reported exactly once too, and
    # the coverage check reuses the same preflight list the mirror check
    # already validated the shape of.
    preflight_result = extract_preflight_files(deploy_yml_content)
    runbook_result = extract_runbook_mirror_files(runbook_content)

    only_in_preflight, only_in_runbook, mirror_error = check_hard_required_mirror(
        preflight_result, runbook_result
    )
    mirror_drift = len(only_in_preflight) + len(only_in_runbook) + (1 if mirror_error else 0)

    missing_from_preflight = check_preflight_covers_unconditional_scp(preflight_result, steps)

    order_violations = check_apply_order(steps, DDL_MANUAL_DIR)

    single_tx_required, single_tx_gaps = find_single_transaction_gaps(
        steps, DDL_MANUAL_DIR, all_files - KNOWN_NOT_WIRED
    )

    continuation_breaks = find_broken_continuations(
        deploy_yml_content, FOR_FILE_LOOP_RE, FOR_LOOP_END_RE, False, "deploy.yml preflight"
    ) + find_broken_continuations(
        runbook_content, RUNBOOK_GITLOG_RE, RUNBOOK_FENCE_RE, True, "runbook mirror"
    )

    print("Prod DDL Wiring Guard")
    print("  Total manual DDL files:  {}".format(len(all_files)))
    print("  Copied AND applied:      {}".format(len(fully_wired)))
    print("  Known not-wired (debt):  {}".format(len(KNOWN_NOT_WIRED)))
    print("  Ghost allow-list entries:{}".format(len(ghost_allowlist)))
    print("  BROKEN WIRING:           {}".format(len(broken)))
    print("  Manual-private files:    {}".format(len(private_files)))
    print("  Manual-private LEAKED:   {}".format(len(private_leaks)))
    print("  psql missing ON_ERROR_STOP: {}".format(len(flag_gaps)))
    print("  Hard-required list drift (preflight vs runbook): {}".format(mirror_drift))
    print("  Preflight missing unconditional scp files: {}".format(len(missing_from_preflight)))
    print("  Apply-order violations (grants / privileges check): {}".format(len(order_violations)))
    print("  Files requiring a --single-transaction apply: {}".format(len(single_tx_required)))
    print("  Applies missing --single-transaction: {}".format(len(single_tx_gaps)))
    print("  Broken line continuations in hard-required lists: {}".format(len(continuation_breaks)))

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

    if flag_gaps:
        print()
        print("FAIL: the following psql invocations in .github/workflows/deploy.yml do not")
        print("pass `-v ON_ERROR_STOP=1`. Without it, a SQL error mid-script does not stop")
        print("psql — it keeps going, exits 0, and the step (and CI) reports success on a")
        print("migration that only partially applied. Measured twice independently on scratch")
        print("Postgres 16.14 against this repo's real migration text (task-ddl-flag-audit,")
        print("backlog item 141): without the flag — two ERROR: lines, exit code 0, the")
        print("intended constraint absent from pg_constraint; with it — exit code 3, stop on")
        print("the first error.")
        for job_id, evidence in flag_gaps:
            print("  job #{}: {}".format(job_id, evidence))
        print()
        print("Fix: add `-v ON_ERROR_STOP=1` right after `psql -U \"$PGUSER\" -d \"$PGDB\"` —")
        print("the pattern every other psql invocation in this file already uses. If a psql")
        print("call in this workflow genuinely must not stop on error, say so in a comment")
        print("directly above it and add a reasoned, named exception here — never a silent")
        print("omission.")

    if mirror_error:
        print()
        print("FAIL: the rollback hard-required file list is mirrored in only one place.")
        print(mirror_error)

    if only_in_preflight or only_in_runbook:
        print()
        print("FAIL: deploy.yml's rollback preflight file list and docs/runbooks/")
        print("deployment.md's rollback-depth-limit mirror command have drifted apart.")
        print("(This checks only that the two manually-maintained copies agree with each")
        print("other — not that either one is itself the semantically correct list.)")
        if only_in_preflight:
            print()
            print("  IN deploy.yml's PREFLIGHT LIST, MISSING FROM THE RUNBOOK MIRROR:")
            print("  -> add these to docs/runbooks/deployment.md §9's `git log -1 -- <paths>`")
            print("     command:")
            for f in only_in_preflight:
                print("    {}".format(f))
        if only_in_runbook:
            print()
            print("  IN THE RUNBOOK MIRROR, MISSING FROM deploy.yml's PREFLIGHT LIST:")
            print("  -> add these to deploy.yml's 'Verify rollback target commit has all")
            print("     hard-required files' step's `for FILE in \\ ... ; do` list:")
            for f in only_in_runbook:
                print("    {}".format(f))
        print()
        print("This is the same class of drift check-prod-ddl-wiring.py already guards")
        print("against for the scp/psql pair above (PR #422): a comment asking two texts to")
        print("stay in sync, with nothing checking that they did.")

    if missing_from_preflight:
        print()
        print("FAIL: deploy.yml copies the following files to the VPS on EVERY deploy — an")
        print("scp-action step with no `if:` at all, in the copy-compose job — but the")
        print("rollback preflight's `for FILE in \\ ... ; do` list does not require them.")
        print("(security review PR #615 round 4, SR-M-5: the mirror check above proves the")
        print("preflight list agrees with its runbook copy, never that either one is the")
        print("actually-correct list — this is the class of bug that leaves open: both")
        print("copies silently missing the SAME file, so their drift is zero.)")
        print()
        print("-> add these to BOTH deploy.yml's 'Verify rollback target commit has all")
        print("   hard-required files' step's `for FILE in \\ ... ; do` list AND")
        print("   docs/runbooks/deployment.md §9's `git log -1 -- <paths>` command:")
        for f in missing_from_preflight:
            print("    {}".format(f))
        print()
        print("Left unfixed, a rollback target older than one of these files' introducing")
        print("commit passes the preflight (which does not know to check them) and then")
        print("fails deep inside copy-compose's scp step — after write-env has already")
        print("reached the VPS. That is the SR-H-3 failure mode this preflight step exists")
        print("to prevent, reopened through the one file class the mirror check cannot see.")

    if order_violations:
        print()
        print("FAIL: deploy.yml's DDL apply order breaks an invariant of the database")
        print("privilege work. Order is taken from the apply step itself (text order inside")
        print("one job script), not from a list.")
        for invariant, filename, message in order_violations:
            print()
            print("  [{}] {}".format(invariant, filename))
            print("    {}".format(message))
        print()
        print("Fix: GRANTS-AFTER-CREATORS - move the offending file's apply block ABOVE the")
        print("`{}` block (or split the relation-creating part out of it).".format(GRANTS_FILE))
        print("CHECK-LAST - make the final database step the `{}` run;".format(PRIVILEGES_CHECK_FILE))
        print("an earlier run before the container swap may stay (it fails the deploy while")
        print("the old API is still serving), but a run must also close the sequence.")

    if single_tx_gaps:
        print()
        print("FAIL: these manual DDL files declare in their header that they must be applied")
        print("with `psql ... --single-transaction`, but a psql command in the deploy applies")
        print("them without `--single-transaction` or `-1`. Without it every statement commits")
        print("on its own, so a RAISE late in the file leaves the earlier steps applied: a")
        print("half-applied migration behind a loud failure (backlog 337).")
        for name, evidence in single_tx_gaps:
            print("  {}: {}".format(name, evidence))
        print()
        print("Fix: add `--single-transaction` after `-v ON_ERROR_STOP=1` on that psql call")
        print("(scripts/devops/deploy-stack-on-vps.sh holds the apply steps).")

    if continuation_breaks:
        print()
        print("FAIL: a hard-required file list is one backslash-continued shell command, and")
        print("these lines end it early. In deploy.yml's rollback preflight that is a bash")
        print("syntax error (every rollback fails at that step); in the runbook's `git log -1`")
        print("command every later path is silently dropped, so the floor it prints is wrong.")
        for label, lineno, text in continuation_breaks:
            print("  {} line {}: {}".format(label, lineno, text))
        print()
        print("Fix: remove the blank line, or end the line with ` \\`.")

    if (
        broken
        or single_tx_gaps
        or continuation_breaks
        or order_violations
        or private_leaks
        or flag_gaps
        or mirror_error
        or only_in_preflight
        or only_in_runbook
        or missing_from_preflight
    ):
        return 1

    print()
    print("OK: every manual DDL file is either copied AND applied by deploy.yml, or")
    print("explicitly acknowledged as intentionally not wired, no manual-private file is")
    print("referenced by any workflow, every psql invocation in deploy.yml passes")
    print("-v ON_ERROR_STOP=1, the rollback hard-required file list (when present) agrees")
    print("between deploy.yml and its runbook mirror, and that list covers every file an")
    print("unconditional scp-action step actually copies; every file that declares a")
    print("--single-transaction apply is applied that way, and both hard-required lists")
    print("are unbroken backslash-continued commands.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
