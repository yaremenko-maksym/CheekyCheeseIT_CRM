#!/usr/bin/env python3
"""
E2E Shard Coverage Guard — FM-5 fix.

Verifies that every apps/e2e/tests/**/*.spec.ts is either:
  (a) listed in a shard in .github/workflows/ci.yml, OR
  (b) explicitly listed in KNOWN_UNSHARDED below (with a debt marker).

Fails with a clear error listing uncovered files + instructions.
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
    # --- landing/ suite (task-landing-redesign.md AC6) ---
    "tests/landing/responsive.spec.ts",           # debt: opt-in `landing` Playwright project (same
                                                   # pattern as cache/ above) — needs an externally
                                                   # started apps/landing dev server + vacancies-seeded
                                                   # scratch DB that ci.yml's default shard does not
                                                   # provision. Run locally: `playwright test --project=landing`.
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
    "tests/drop-archive-impact-contract.spec.ts", # debt: not gated, migrate to drop shard later
    "tests/drop-archive-real.spec.ts",            # debt: not gated, migrate to drop shard later
    "tests/drop-archive-user-real.spec.ts",       # debt: not gated, migrate to drop shard later
    "tests/drop-backend-rbac-api.spec.ts",        # debt: not gated, migrate to drop shard later
    "tests/drop-balances-panel.spec.ts",          # debt: not gated, migrate to drop shard later
    "tests/drop-confirm-payout-edges.spec.ts",    # debt: not gated, migrate to drop shard later
    "tests/drop-confirm-payout-rbac.spec.ts",     # debt: not gated, migrate to drop shard later
    "tests/drop-confirm-payout.spec.ts",          # debt: not gated, migrate to drop shard later
    "tests/drop-create-ui-regressions.spec.ts",   # debt: not gated, migrate to drop shard later
    "tests/drop-create.spec.ts",                  # debt: not gated, migrate to drop shard later
    "tests/drop-distribution-edge.spec.ts",       # debt: not gated, migrate to drop shard later
    "tests/drop-distribution.spec.ts",            # debt: not gated, migrate to drop shard later
    "tests/drop-duplicate-email.spec.ts",         # debt: not gated, migrate to drop shard later
    "tests/drop-findings-pr198.spec.ts",          # debt: not gated, migrate to drop shard later
    "tests/drop-income-ui.spec.ts",               # debt: not gated, migrate to drop shard later
    "tests/drop-junior-rbac.spec.ts",             # debt: not gated, migrate to drop shard later
    "tests/drop-junior-unlock.spec.ts",           # debt: not gated, migrate to drop shard later
    "tests/drop-multi-hr.spec.ts",                # debt: not gated, migrate to drop shard later
    "tests/drop-project-create.spec.ts",          # debt: not gated, migrate to drop shard later
    "tests/drop-rbac.spec.ts",                    # debt: not gated, migrate to drop shard later
    "tests/drop-rotate-senior.spec.ts",           # debt: not gated, migrate to drop shard later
    "tests/drop-route-guards.spec.ts",            # debt: not gated, migrate to drop shard later
    "tests/drop-routing-hub.spec.ts",             # debt: not gated, migrate to drop shard later
    "tests/drop-senior-readonly.spec.ts",         # debt: not gated, migrate to drop shard later
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

    accounted = sharded_specs | KNOWN_UNSHARDED

    ghost_debt = sorted(KNOWN_UNSHARDED - all_specs)
    uncovered = sorted(all_specs - accounted)

    print("E2E Shard Coverage Guard")
    print("  Total spec files:    {}".format(len(all_specs)))
    print("  Sharded (gated):     {}".format(len(sharded_specs)))
    print("  Known unsharded:     {}".format(len(KNOWN_UNSHARDED)))
    print("  Ghost debt entries:  {}".format(len(ghost_debt)))
    print("  UNCOVERED (new!):    {}".format(len(uncovered)))

    if ghost_debt:
        print()
        print("WARNING: KNOWN_UNSHARDED entries that no longer exist on disk:")
        for f in ghost_debt:
            print("  {}".format(f))
        print("  -> Remove these stale entries from KNOWN_UNSHARDED in this script.")

    if uncovered:
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
        return 1

    print()
    print("OK: All spec files are either sharded in CI or explicitly listed as debt.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
