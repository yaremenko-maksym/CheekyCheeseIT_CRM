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
  (a) referenced somewhere in .github/workflows/deploy.yml (the fixed scp
      source: list, a guarded "if [ -f ... ]" check, an apply step — any
      mention of the exact filename counts, matching how every DDL file
      already wired in that workflow is referenced multiple times), OR
  (b) explicitly listed in KNOWN_NOT_WIRED below, with a reason.

Fails with a clear error listing unwired files + instructions. Mirrors the
existing scripts/devops/check-e2e-shard-coverage.py pattern (same allow-list
philosophy, same repo, same reviewer familiarity) rather than inventing a new
convention.

Run: python3 scripts/devops/check-prod-ddl-wiring.py
"""

import os
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
}


def read_deploy_yml():
    with open(DEPLOY_YML, "r") as f:
        return f.read()


def collect_all_ddl_files(ddl_dir):
    """Return the set of *.sql filenames (not full paths) directly under ddl_dir."""
    if not os.path.isdir(ddl_dir):
        return set()
    return {f for f in os.listdir(ddl_dir) if f.endswith(".sql")}


def main():
    if not os.path.isfile(DEPLOY_YML):
        print("ERROR: deploy.yml not found: {}".format(DEPLOY_YML))
        return 1

    all_files = collect_all_ddl_files(DDL_MANUAL_DIR)
    deploy_yml_content = read_deploy_yml()

    # A file counts as "wired" if its exact filename appears ANYWHERE in
    # deploy.yml — the fixed scp source: list, a guarded existence check, an
    # apply step's SOURCE comment, etc. Every DDL file already wired in this
    # workflow is referenced this way in multiple places (scp source, target
    # comment, apply-step variable) — a plain substring search is a robust,
    # low-maintenance heuristic that does not need to understand YAML/bash
    # structure, mirroring check-e2e-shard-coverage.py's own pragmatic
    # regex-based approach for a structurally similar problem.
    wired = {f for f in all_files if f in deploy_yml_content}
    not_wired = all_files - wired

    accounted = wired | KNOWN_NOT_WIRED
    uncovered = sorted(all_files - accounted)
    ghost_allowlist = sorted(KNOWN_NOT_WIRED - all_files)

    print("Prod DDL Wiring Guard")
    print("  Total manual DDL files:  {}".format(len(all_files)))
    print("  Wired in deploy.yml:     {}".format(len(wired)))
    print("  Known not-wired (debt):  {}".format(len(KNOWN_NOT_WIRED)))
    print("  Ghost allow-list entries:{}".format(len(ghost_allowlist)))
    print("  UNCOVERED (new!):        {}".format(len(uncovered)))

    if ghost_allowlist:
        print()
        print("WARNING: KNOWN_NOT_WIRED entries that no longer exist on disk:")
        for f in ghost_allowlist:
            print("  {}".format(f))
        print("  -> Remove these stale entries from KNOWN_NOT_WIRED in this script.")

    if uncovered:
        print()
        print("FAIL: The following apps/api/drizzle/manual/*.sql files are NOT referenced")
        print("anywhere in .github/workflows/deploy.yml and are NOT in KNOWN_NOT_WIRED:")
        for f in uncovered:
            print("  {}".format(f))
        print()
        print("This is exactly the gap that caused the 2026-07-25 prod incident (PR #422's")
        print("vacancy i18n DDL merged but was never applied — GET /api/public/vacancies 500'd).")
        print()
        print("Fix options:")
        print("  1. Wire the file into deploy.yml: add it to the copy-compose job's scp")
        print("     source: list AND add a fail-loud apply step in the deploy job (copy the")
        print("     pattern used for e.g. 2026-07-22_vacancies.sql — that is the DEFAULT for")
        print("     any new schema-changing DDL that should run on every deploy).")
        print("  2. If the file is genuinely NOT meant to run on every deploy (a one-time")
        print("     data-fix already applied and deliberately de-wired, or a manual/dry-run")
        print("     sibling of an auto-wired file), add it to KNOWN_NOT_WIRED in")
        print("     scripts/devops/check-prod-ddl-wiring.py with a comment explaining why.")
        print()
        print("Rule: every manual DDL file must either run on every deploy or be an explicit,")
        print("reasoned exception — never just forgotten.")
        return 1

    print()
    print("OK: All manual DDL files are either wired into deploy.yml or explicitly")
    print("acknowledged as intentionally not wired.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
