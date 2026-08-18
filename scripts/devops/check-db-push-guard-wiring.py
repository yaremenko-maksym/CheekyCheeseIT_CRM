#!/usr/bin/env python3
"""
db:push / db:migrate Guard Wiring Check — task-ci-db-rename-and-dbpush-guard
MED-2 (security review, PR #579, 2026-08-18).

Incident this guards against: apps/api/package.json's `db:push` and
`db:migrate` scripts wrap the destructive `drizzle-kit push` with a mandatory
pre-flight guard — `tsx src/database/seed-db-guard.ts && drizzle-kit push` —
so a non-disposable-looking DATABASE_URL refuses BEFORE drizzle-kit ever
starts (see apps/api/src/database/seed-db-guard.ts; the incident this whole
guard exists for is documented there — drizzle-kit push destroyed a live
table, senior_resumes, 2026-08-12). That protection lives entirely in ONE
STRING in a JSON file: deleting the `tsx ... &&` prefix, or swapping `&&`
for `;` (which does NOT stop the second command from running when the first
fails — that is the whole point of `&&` over `;`), silently makes
`db:push`/`db:migrate` destructive again, and nothing before this guard was
checking that string's SHAPE. Same "wire it or explicitly acknowledge it,
never let it silently drift" class as check-prod-ddl-wiring.py and
check-ssh-action-capture-stdout-version.py — see those files' headers for
the same pattern applied to other incident classes in this repo.

Verifies, for each of `db:push` and `db:migrate` in apps/api/package.json's
`scripts`:
  1. The command joins its steps with `&&` (not `;`, not `||`, not a single
     bare command). `;` is not a fail-closed join — a mutant that swaps the
     operator produces no error of its own, it just runs drizzle-kit
     unconditionally, guard result or not.
  2. One of the `&&`-joined steps invokes the guard script by NAME
     (`src/database/seed-db-guard.ts` appears in that step) — any invocation
     form that names the file counts (`tsx ...`, `node --loader ...`,
     `pnpm exec tsx ...`); the property checked is "is this file invoked",
     not "invoked with exactly this one tool".
  3. A step invoking `drizzle-kit push` (the destructive command) exists, and
     it is STRICTLY AFTER the guard step (by `&&`-split array index) — so the
     guard's exit code actually gates it, and reordering the two silently
     defeats the point without either check going missing.

`db:studio` is deliberately OUT OF SCOPE — read-only, not a destructive
command; see the file this guard exists to protect
(apps/api/src/database/seed-db-guard.ts) for the same scoping decision, and
this PR's own body for why it stays untouched here (tracked separately).

Deliberately NOT a shell parser: `&&` is found by plain string split, same
pragmatic level as check-ssh-action-capture-stdout-version.py's line-based
approach — package.json script values in this repo are simple `a && b`
chains, not full pipelines, so a split is enough to prove the SHAPE this
guard cares about.

Tests: scripts/devops/tests/test-check-db-push-guard-wiring.sh.

Run: python3 scripts/devops/check-db-push-guard-wiring.py
"""

import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
PACKAGE_JSON = os.path.join(REPO_ROOT, "apps", "api", "package.json")

GUARD_MARKER = "src/database/seed-db-guard.ts"
DESTRUCTIVE_MARKER = "drizzle-kit push"
GUARDED_SCRIPTS = ("db:push", "db:migrate")


def check_script(name, command):
    """Returns a list of violation strings (empty = OK) for one npm script."""
    violations = []

    if "&&" not in command:
        if ";" in command:
            violations.append(
                "'{}' joins its steps with ';' instead of '&&' — ';' does NOT "
                "stop drizzle-kit from running when the guard refuses (exits "
                "non-zero). Current value: {!r}".format(name, command)
            )
        else:
            violations.append(
                "'{}' is a single command with no guard step at all. "
                "Current value: {!r}".format(name, command)
            )
        return violations

    steps = command.split("&&")
    guard_idx = next((i for i, s in enumerate(steps) if GUARD_MARKER in s), None)
    destructive_idx = next(
        (i for i, s in enumerate(steps) if DESTRUCTIVE_MARKER in s), None
    )

    if guard_idx is None:
        violations.append(
            "'{}' does not invoke the guard ({}) in any of its '&&'-joined "
            "steps. Current value: {!r}".format(name, GUARD_MARKER, command)
        )
    if destructive_idx is None:
        violations.append(
            "'{}' does not invoke '{}' at all — has the destructive command "
            "been renamed? Current value: {!r}".format(
                name, DESTRUCTIVE_MARKER, command
            )
        )
    if (
        guard_idx is not None
        and destructive_idx is not None
        and guard_idx >= destructive_idx
    ):
        violations.append(
            "'{}' invokes the guard AFTER (or in the same '&&' step as) "
            "'{}' — the schema change would already be in flight before the "
            "guard ever runs. Current value: {!r}".format(
                name, DESTRUCTIVE_MARKER, command
            )
        )
    return violations


def main():
    if not os.path.isfile(PACKAGE_JSON):
        print("ERROR: {} not found".format(PACKAGE_JSON))
        return 1

    with open(PACKAGE_JSON, "r") as f:
        data = json.load(f)

    scripts = data.get("scripts", {})
    all_violations = []
    checked = []
    for name in GUARDED_SCRIPTS:
        command = scripts.get(name)
        if command is None:
            all_violations.append(
                "'{}' is missing from apps/api/package.json scripts entirely "
                "— was it renamed?".format(name)
            )
            continue
        checked.append(name)
        all_violations.extend(check_script(name, command))

    print("db:push/db:migrate Guard Wiring Check")
    print("  package.json:    {}".format(os.path.relpath(PACKAGE_JSON, REPO_ROOT)))
    print("  scripts checked: {}".format(", ".join(checked) or "(none)"))
    print("  violations:      {}".format(len(all_violations)))

    if all_violations:
        print()
        print(
            "FAIL: db:push/db:migrate is no longer fail-closed against a live database:"
        )
        for v in all_violations:
            print("  - {}".format(v))
        print()
        print("Fix: both scripts must read exactly (or an equivalent '&&' chain):")
        print('  "tsx src/database/seed-db-guard.ts && drizzle-kit push"')
        print(
            "See apps/api/src/database/seed-db-guard.ts for what the guard protects"
        )
        print(
            "against (task-ci-db-rename-and-dbpush-guard, security review PR #579 MED-2)."
        )
        return 1

    print()
    print(
        "OK: db:push and db:migrate both invoke the guard, via '&&', strictly before drizzle-kit."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
