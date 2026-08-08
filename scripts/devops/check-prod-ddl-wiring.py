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

Now BOTH of these must hold, and comment-only lines are stripped before any
matching, so prose can never satisfy either:

  COPY  — the filename appears in the `source:` value of an appleboy/scp-action
          step. If that `source:` is an expression (`${{ steps.X.outputs.Y }}` —
          used by the guarded, conditional copies), the referenced step X's own
          body is searched instead, since that is where the file list is built.
  APPLY — the filename appears on a non-comment line, together with the
          server-side path root (/opt/crm), inside a step that actually runs
          `psql`. That is the `FOO_FILE="/opt/crm/apps/api/drizzle/manual/..."`
          assignment that gets fed to psql — writing it is doing the work.

Failure modes are reported separately (never copied / copied but never applied /
applied but never copied), because "the scp list was updated but the apply step
was forgotten" is a real and differently-diagnosed bug from "nothing at all".

KNOWN LIMITATION, stated rather than implied: this proves the two steps EXIST
and name the file. It does not prove the apply step runs on every deploy (it may
sit behind an `if:`), nor that the SQL itself is correct or idempotent. It is a
wiring check. The proof that a migration actually applied is deploy.yml's own
fail-loud apply step and the prod schema afterwards.

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
}


def read_deploy_yml():
    with open(DEPLOY_YML, "r") as f:
        return f.read()


def collect_all_ddl_files(ddl_dir):
    """Return the set of *.sql filenames (not full paths) directly under ddl_dir."""
    if not os.path.isdir(ddl_dir):
        return set()
    return {f for f in os.listdir(ddl_dir) if f.endswith(".sql")}


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
SOURCE_RE = re.compile(r"^\s*source:\s*(.+?)\s*$")
STEPS_EXPR_RE = re.compile(r"\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.[A-Za-z0-9_-]+\s*\}\}")


class Step(object):
    def __init__(self, indent):
        self.indent = indent
        self.lines = []  # comment-only lines already stripped
        self.step_id = None
        self.source_values = []

    @property
    def text(self):
        return "\n".join(self.lines)


def parse_steps(content):
    """Split deploy.yml into step blocks, dropping comment-only lines.

    Comment stripping is the load-bearing part: the cheat this guard exists to
    refuse ("the filename is mentioned, therefore it must be wired") lives
    entirely in comments and step names.
    """
    steps = []
    current = None
    for raw in content.splitlines():
        if COMMENT_LINE_RE.match(raw):
            continue
        m = STEP_START_RE.match(raw)
        if m:
            current = Step(len(m.group(1)))
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
        current.lines.append(raw)
        m_id = ID_RE.match(raw)
        if m_id:
            current.step_id = m_id.group(1)
        m_src = SOURCE_RE.match(raw)
        if m_src:
            current.source_values.append(m_src.group(1))
    return steps


def mentions(text, filename):
    """Filename occurrence with a right-hand boundary.

    Stops `foo.sql` from being 'found' inside `foo.sql.bak` / `foo.sql_old`.
    """
    return re.search(re.escape(filename) + r"(?![\w.-])", text) is not None


def build_zones(steps):
    """Return (copy_texts, apply_texts): the two zones a file must appear in."""
    by_id = {s.step_id: s for s in steps if s.step_id}

    copy_texts = []
    apply_texts = []
    for step in steps:
        if "appleboy/scp-action" in step.text:
            for value in step.source_values:
                copy_texts.append(value)
                # `source: '${{ steps.X.outputs.source_list }}'` — the real file
                # list lives in step X, which is where to look instead.
                for ref in STEPS_EXPR_RE.findall(value):
                    producer = by_id.get(ref)
                    if producer is not None:
                        copy_texts.append(producer.text)

        if "psql" in step.text:
            # Only lines that name the server-side path count — that is the
            # variable actually fed to psql, not prose about it.
            for line in step.lines:
                if "/opt/crm" in line:
                    apply_texts.append(line)

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

    print("Prod DDL Wiring Guard")
    print("  Total manual DDL files:  {}".format(len(all_files)))
    print("  Copied AND applied:      {}".format(len(fully_wired)))
    print("  Known not-wired (debt):  {}".format(len(KNOWN_NOT_WIRED)))
    print("  Ghost allow-list entries:{}".format(len(ghost_allowlist)))
    print("  BROKEN WIRING:           {}".format(len(broken)))

    if ghost_allowlist:
        print()
        print("WARNING: KNOWN_NOT_WIRED entries that no longer exist on disk:")
        for f in ghost_allowlist:
            print("  {}".format(f))
        print("  -> Remove these stale entries from KNOWN_NOT_WIRED in this script.")

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
        return 1

    print()
    print("OK: every manual DDL file is either copied AND applied by deploy.yml, or")
    print("explicitly acknowledged as intentionally not wired.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
