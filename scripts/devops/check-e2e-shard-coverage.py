#!/usr/bin/env python3
"""
E2E Shard Coverage Guard — FM-5 fix.

Verifies that every apps/e2e/tests/**/*.spec.ts is either:
  (a) listed in a shard in .github/workflows/ci.yml, OR
  (b) explicitly listed in KNOWN_UNSHARDED below (with a debt marker).

Fails with a clear error listing uncovered files + instructions.

Also verifies the reverse direction (task-infra-ci-docs-filter-and-dead-shard,
2026-09): every EXACT *.spec.ts token named in a shard's `files:` line must
resolve to a real file, OR be explicitly listed in PENDING_SHARD_FILES below.
Before this, a spec could be deleted (tests/rbac-junior-on-other.spec.ts,
commit d0735fe2 / #162) while its shard entry lived on indefinitely — the
shard silently ran fewer tests than its `files:` line claimed, and nothing
here noticed. Directory-prefix tokens (e.g. `tests/crm`, `tests/landing/`)
need no such check: resolve_sharded_specs() only ever adds specs that already
exist in all_specs for those, so a dangling directory prefix just resolves to
zero files, not a ghost entry.

Tests: scripts/devops/tests/test-check-e2e-shard-coverage.sh — positive AND
negative cases, including the two ways a spec can LOOK covered without being run
(named in a ci.yml comment; named under a key that is not a shard's `files:`).

Run: python3 scripts/devops/check-e2e-shard-coverage.py
"""

import os
import sys
import re

# ---------------------------------------------------------------------------
# Root of the repo — resolve relative to this script location
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
E2E_TESTS_DIR = os.path.join(REPO_ROOT, "apps", "e2e", "tests")
CI_YML = os.path.join(REPO_ROOT, ".github", "workflows", "ci.yml")

# ---------------------------------------------------------------------------
# EXCLUDED_DIRS — structural exclusion (NOT debt): whole directories that are
# categorically, permanently outside the CI shard matrix BY DESIGN, as
# opposed to individual files temporarily awaiting migration (that's
# KNOWN_UNSHARDED, below).
#
# tests/landing/ — REMOVED 2026-07-26 (task-landing-e2e-in-ci.md Part 2). The
# `landing` Playwright PROJECT now has a real CI leg: the `landing` entry in
# ci.yml's `e2e` job matrix (`files: tests/landing/`, a directory prefix —
# same convention as `tests/crm` in the `misc` shard) provisions Postgres +
# API + `pnpm --filter @crm/e2e seed:landing` + `apps/landing build:prerender`
# + `vite preview`, then runs `playwright test --project=landing`. Every spec
# under this directory is genuinely covered now via the directory-prefix
# resolution below — a NEW spec here needs no per-file entry (same as before,
# just for a real reason instead of a permanent opt-out). Nothing currently
# needs this set; kept as an empty set (not deleted outright) so a future
# genuinely-structural exclusion has an obvious place to land instead of
# reinventing the directory-prefix convention from scratch.
# ---------------------------------------------------------------------------
EXCLUDED_DIRS: set[str] = set()

# ---------------------------------------------------------------------------
# KNOWN_UNSHARDED — explicit debt list.
# Each entry is a path relative to apps/e2e/ (same convention as ci.yml shards).
# To remove debt: add the file to a shard in ci.yml AND remove from this list.
# To add new debt: add entry here with a comment "# debt: <reason>"
# ---------------------------------------------------------------------------
KNOWN_UNSHARDED = {
    # --- cache/ suite ---
    "tests/cache/anti-stale.spec.ts",             # debt: cache tests not in any shard, migrate later
    "tests/cache/api-cache.spec.ts",              # debt: cache tests not in any shard, migrate later
    "tests/cache/logout-clear.spec.ts",           # debt: cache tests not in any shard, migrate later
    "tests/cache/media-cache.spec.ts",            # debt: cache tests not in any shard, migrate later
    "tests/cache/no-store.spec.ts",               # debt: cache tests not in any shard, migrate later
    "tests/cache/sw-smoke.spec.ts",               # debt: cache tests not in any shard, migrate later
    # --- landing/ suite: see EXCLUDED_DIRS above (structural, not debt) ---
    # --- accountant ---
    "tests/accountant-dashboard.spec.ts",         # debt: not gated, migrate to accountant shard later
    # --- admin ---
    "tests/admin-templates.spec.ts",              # debt: not gated, migrate to misc shard later
    # --- dashboard ---
    "tests/dashboard-russian-strings.spec.ts",    # debt: not gated, migrate to misc shard later
    # --- documents ---
    "tests/documents-pr1.spec.ts",                # debt: not gated, migrate to documents shard later
    "tests/documents-pr3.spec.ts",                # debt: not gated, migrate to documents shard later
    # --- drop suite ---
    "tests/drop-add-senior.spec.ts",              # debt: not gated, migrate to drop shard later
    "tests/drop-archive-cascade.spec.ts",         # debt: not gated, migrate to drop shard later
    "tests/drop-balances-panel.spec.ts",          # debt: not gated, migrate to drop shard later
    "tests/drop-create-ui-regressions.spec.ts",   # debt: not gated, migrate to drop shard later
    "tests/drop-create.spec.ts",                  # debt: not gated, migrate to drop shard later
    "tests/drop-findings-pr198.spec.ts",          # debt: not gated, migrate to drop shard later
    "tests/drop-income-ui.spec.ts",               # debt: not gated, migrate to drop shard later
    "tests/drop-junior-rbac.spec.ts",             # debt: not gated, migrate to drop shard later
    "tests/drop-rbac.spec.ts",                    # debt: not gated, migrate to drop shard later
    "tests/drop-rotate-senior.spec.ts",           # debt: not gated, migrate to drop shard later
    "tests/drop-route-guards.spec.ts",            # debt: not gated, migrate to drop shard later
    "tests/drop-routing-hub.spec.ts",             # debt: not gated, migrate to drop shard later
    "tests/drop-senior-readonly.spec.ts",         # debt: not gated, migrate to drop shard later
    # --- 12 files GATED 2026-08-18 (PR #573, backlog item 139) — moved out of
    # this debt list into the `drop-finance` (6) / `drop-lifecycle` (6) shards
    # in ci.yml: drop-confirm-payout-edges, drop-confirm-payout,
    # drop-confirm-payout-rbac, drop-junior-unlock, drop-distribution,
    # drop-distribution-edge, drop-archive-real, drop-archive-user-real,
    # drop-archive-impact-contract, drop-project-create, drop-duplicate-email,
    # drop-multi-hr.
    # --- money-path (FM-5 complete): all 3 specs now gated in drop-finance shard.
    # company-account throttle is env-relaxable via RelaxableThrottle (#275/#277).
    # THROTTLE_RELAXED=true + THROTTLER_LIMIT=2000 set in E2E job env (#276).
    # pending-settlement, drop-role-end-to-end, rbac-matrix-smoke → drop-finance shard.
    # drop-share-slider.spec.ts: gated in drop-finance shard (task-drop-share-slider-shard,
    # closes PR #376 MED-1 coverage gap).
    # --- finance extras ---
    "tests/finance-funding-source.spec.ts",       # debt: not gated, migrate to finance shard later
    "tests/finance-payout-simulate.spec.ts",      # debt: not gated, migrate to finance shard later
    "tests/finance-senior-payment-flow.spec.ts",  # debt: not gated, migrate to finance shard later
    "tests/finance-smoke-regressions.spec.ts",    # debt: not gated, migrate to finance shard later
    # --- hr ---
    "tests/hr-dashboard.spec.ts",                 # debt: not gated, migrate to team-users shard later
    # --- invoices ---
    "tests/invoice-aggregate.spec.ts",            # debt: not gated, migrate to invoices shard later
    "tests/invoice-public-verify.spec.ts",        # debt: not gated, migrate to invoices shard later
    "tests/invoice-real-contract-number.spec.ts", # debt: not gated, migrate to invoices shard later
    "tests/invoice-signing-real.spec.ts",         # debt: not gated, migrate to invoices shard later
    "tests/invoices-signing-flow.spec.ts",        # debt: not gated, migrate to invoices shard later
    # --- junior ---
    "tests/junior-hub.spec.ts",                   # debt: not gated, migrate to misc shard later
    # --- legend ---
    "tests/legend.spec.ts",                       # debt: not gated, migrate to misc shard later
    # --- onboarding ---
    "tests/onboarding-flow.spec.ts",              # debt: not gated, migrate to misc shard later
    "tests/onboarding-regression-pr110.spec.ts",  # debt: not gated, migrate to misc shard later
    # --- payout ---
    "tests/payout-admin-projectid-regression.spec.ts", # debt: not gated, migrate to finance shard later
    "tests/payout-auto-cascade-invoice.spec.ts",  # debt: not gated, migrate to finance shard later
    "tests/payout-manual-confirm-method.spec.ts", # debt: not gated, migrate to finance shard later
    # --- phase ---
    "tests/phase2-auto-distribution-regression.spec.ts", # debt: not gated, migrate to finance shard later
    "tests/phase8-payout-company.spec.ts",        # debt: not gated, migrate to finance shard later
    # --- polish ---
    "tests/polish-regressions.spec.ts",           # debt: not gated, migrate to misc shard later
    # --- project ---
    "tests/project-credentials.spec.ts",          # debt: not gated, migrate to projects shard later
    # --- rbac ---
    "tests/rbac-senior-junior.spec.ts",           # debt: not gated, migrate to team-users shard later
    # --- senior ---
    "tests/senior-archive-regression.spec.ts",    # debt: not gated, migrate to misc shard later
    "tests/senior-confirm-payout.spec.ts",        # debt: not gated, migrate to finance shard later
    "tests/senior-create-default.spec.ts",        # debt: not gated, migrate to team-users shard later
    "tests/senior-payout-no-dup.spec.ts",         # debt: not gated, migrate to finance shard later
    "tests/senior-project-distribution-regression.spec.ts", # debt: not gated, migrate to projects shard later
    "tests/senior-teamless.spec.ts",              # debt: not gated, migrate to team-users shard later
    # --- team share ---
    "tests/team-share-override.spec.ts",          # debt: not gated, migrate to team-users shard later
    # --- ui ---
    "tests/ui-invariants-pr56.spec.ts",           # debt: not gated, migrate to misc shard later

}

# ---------------------------------------------------------------------------
# PENDING_SHARD_FILES — explicit "wired ahead of merge" acknowledgment.
#
# A shard's `files:` line in ci.yml is sometimes intentionally updated to name
# a spec that does not exist on disk yet, because the spec itself lands in a
# separate, not-yet-merged PR (see e.g. the `auth-nav` / `drop-finance` shard
# comments in ci.yml, PRs #521 and #528: "listing it here now is a no-op today
# and self-activates the moment #NNN merges — no follow-up PR needed, no
# window where the spec lands on main unsharded"). That convention exists FOR
# A REASON: the alternative — land the spec unsharded first, shard it in a
# follow-up PR — reopens exactly the gap this whole guard exists to close (a
# spec running on main with zero CI coverage in the meantime).
#
# But an UNACKNOWLEDGED shard entry pointing at nothing is indistinguishable
# from the bug this file's existence check exists to catch (a spec that was
# DELETED and never unwired — tests/rbac-junior-on-other.spec.ts, commit
# d0735fe2 / #162, orphaned in the `team-users` shard for months). Filename
# alone cannot tell "not created yet" from "deleted, never removed" apart, and
# git history can't either in practice: the CI job that runs this script
# checks out with `fetch-depth: 2`, so a deletion from months ago is not even
# in the fetched history to look up.
#
# So: wiring a shard entry ahead of its spec's own PR requires ALSO adding the
# filename here — same "wire it or explicitly acknowledge it, never just
# silently drift" idiom as KNOWN_UNSHARDED above (and as
# check-prod-ddl-wiring.py / check-ssh-action-capture-stdout-version.py use
# for their own incident classes). Remove the entry once the spec lands — a
# stale one (already on disk, or no longer referenced by any shard) is a
# WARNING below, same non-fatal treatment as KNOWN_UNSHARDED's own ghost_debt.
#
# Empty today: every currently-listed shard entry resolves to a real file.
# ---------------------------------------------------------------------------
PENDING_SHARD_FILES: set[str] = set()


def parse_sharded_from_ci(ci_yml_path):
    """
    Parse matrix.shard[].files from ci.yml.
    Returns a set of tokens as written in the YAML (files or directory prefixes).
    """
    with open(ci_yml_path, "r") as f:
        content = f.read()
    files_pattern = re.compile(r"^\s+files:\s+(.+)$", re.MULTILINE)
    sharded = set()
    for m in files_pattern.finditer(content):
        tokens = m.group(1).strip().split()
        for token in tokens:
            sharded.add(token)
    return sharded


def collect_all_specs(tests_dir):
    """Walk apps/e2e/tests/ and return paths relative to apps/e2e/."""
    specs = set()
    e2e_root = os.path.dirname(tests_dir)
    for root, _dirs, files in os.walk(tests_dir):
        for f in files:
            if f.endswith(".spec.ts"):
                abs_path = os.path.join(root, f)
                rel_path = os.path.relpath(abs_path, e2e_root).replace("\\", "/")
                specs.add(rel_path)
    return specs


def resolve_sharded_specs(sharded_patterns, all_specs):
    """
    Expand shard patterns to concrete spec paths.
    Pattern is either an exact *.spec.ts file or a directory prefix (e.g. tests/crm).
    """
    resolved = set()
    for pattern in sharded_patterns:
        if pattern.endswith(".spec.ts"):
            resolved.add(pattern)
        else:
            prefix = pattern.rstrip("/") + "/"
            for spec in all_specs:
                if spec.startswith(prefix):
                    resolved.add(spec)
    return resolved


def main():
    if not os.path.isdir(E2E_TESTS_DIR):
        print("ERROR: E2E tests directory not found: {}".format(E2E_TESTS_DIR))
        return 1
    if not os.path.isfile(CI_YML):
        print("ERROR: ci.yml not found: {}".format(CI_YML))
        return 1

    all_specs = collect_all_specs(E2E_TESTS_DIR)
    sharded_patterns = parse_sharded_from_ci(CI_YML)
    sharded_specs = resolve_sharded_specs(sharded_patterns, all_specs)
    excluded_specs = {
        spec for spec in all_specs
        if any(spec.startswith(prefix) for prefix in EXCLUDED_DIRS)
    }

    accounted = sharded_specs | KNOWN_UNSHARDED | excluded_specs

    ghost_debt = sorted(KNOWN_UNSHARDED - all_specs)
    uncovered = sorted(all_specs - accounted)

    # Reverse-direction check: exact *.spec.ts tokens named in a shard's
    # `files:` line (NOT directory-prefix tokens like `tests/crm`) that do not
    # resolve to a real file — unless explicitly acknowledged as a pending,
    # wired-ahead-of-merge entry. resolve_sharded_specs() adds a literal
    # *.spec.ts token to `sharded_specs` unconditionally (it has no way to
    # know the file doesn't exist), so this is the only place that notices.
    sharded_literal_files = {p for p in sharded_patterns if p.endswith(".spec.ts")}
    still_pending = sharded_literal_files - all_specs
    ghost_shard_files = sorted(still_pending - PENDING_SHARD_FILES)
    stale_pending = sorted(PENDING_SHARD_FILES - still_pending)

    print("E2E Shard Coverage Guard")
    print("  Total spec files:    {}".format(len(all_specs)))
    print("  Sharded (gated):     {}".format(len(sharded_specs)))
    print("  Excluded (by design):{}".format(len(excluded_specs)))
    print("  Known unsharded:     {}".format(len(KNOWN_UNSHARDED)))
    print("  Ghost debt entries:  {}".format(len(ghost_debt)))
    print("  Pending shard files: {}".format(len(PENDING_SHARD_FILES)))
    print("  Stale pending:       {}".format(len(stale_pending)))
    print("  GHOST shard entries: {}".format(len(ghost_shard_files)))
    print("  UNCOVERED (new!):    {}".format(len(uncovered)))

    if ghost_debt:
        print()
        print("WARNING: KNOWN_UNSHARDED entries that no longer exist on disk:")
        for f in ghost_debt:
            print("  {}".format(f))
        print("  -> Remove these stale entries from KNOWN_UNSHARDED in this script.")

    if stale_pending:
        print()
        print("WARNING: PENDING_SHARD_FILES entries that are no longer pending")
        print("(the file now exists on disk, or no shard references it anymore):")
        for f in stale_pending:
            print("  {}".format(f))
        print("  -> Remove these stale entries from PENDING_SHARD_FILES in this script.")

    failed = False

    if ghost_shard_files:
        failed = True
        print()
        print("FAIL: The following shard `files:` entries in ci.yml name a spec that")
        print("does not exist on disk and is not in PENDING_SHARD_FILES:")
        for f in ghost_shard_files:
            print("  {}".format(f))
        print()
        print("Fix options:")
        print("  1. The spec was deleted/renamed and the shard entry is stale — remove")
        print("     it from the shard's `files:` line in .github/workflows/ci.yml.")
        print("  2. The spec is intentionally wired ahead of a not-yet-merged PR that")
        print("     creates it — add the filename to PENDING_SHARD_FILES in")
        print("     scripts/devops/check-e2e-shard-coverage.py with a comment naming")
        print("     the PR, and remove it again once that PR merges.")
        print()
        print("Rule: a shard `files:` entry must point at a real file, or be an")
        print("explicitly acknowledged pending one — never a silent dangling reference.")

    if uncovered:
        failed = True
        print()
        print("FAIL: The following spec files are NOT in any CI shard and NOT in KNOWN_UNSHARDED:")
        for f in uncovered:
            print("  {}".format(f))
        print()
        print("Fix options:")
        print("  1. Add the file to an existing shard in .github/workflows/ci.yml")
        print("  2. Add a new shard for it in the e2e matrix")
        print("  3. Add it to KNOWN_UNSHARDED in scripts/devops/check-e2e-shard-coverage.py")
        print("     with # debt: <reason>")
        print()
        print("Rule: every spec must be either gated in CI or explicitly acknowledged as debt.")

    if failed:
        return 1

    print()
    print("OK: All spec files are either sharded in CI or explicitly listed as debt,")
    print("and every shard `files:` entry points at a real (or pending-acknowledged) file.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
