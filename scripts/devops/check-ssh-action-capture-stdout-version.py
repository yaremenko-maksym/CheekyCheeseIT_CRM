#!/usr/bin/env python3
"""
ssh-action capture_stdout Version Guard — fix/backup-freshness-wiring, 2026-08-04.

Incident this guards against: deploy.yml's "Check backup freshness on VPS (SSH)"
step was written against appleboy/ssh-action's CURRENT docs (`capture_stdout: true`
+ `steps.<id>.outputs.stdout`), but the step's `uses:` pin was left at v1.2.0 — a
version whose `action.yml` has neither the `capture_stdout` input nor ANY `outputs:`
section at all (verified directly against the v1.2.0 tag; the feature was added in
v1.2.1). The result: SSH_OUTCOME=success + SSH_STDOUT="" on every single run, not a
flake — a permanent no-op that made scripts/devops/interpret-backup-freshness.sh
crash under `set -e` before it could ever write a verdict, which in turn made the
alert step (back then gated on `verdict != 'inconclusive'`, which an empty string
satisfies) open a false "backups are broken" alert on every green, fully-healthy
deploy. A second, independently-introduced instance of the exact same mistake
(deploy.yml's "Fetch drop-share-pending-parity DDL summary via SSH" step, PR #443)
was found by this guard's own first real run against origin/main — see that step's
own comment for details.

This is exactly the class of bug the project's own zero-tolerance-for-drift
philosophy exists to catch: a feature written correctly against current docs,
paired with a version pin nothing ever re-checked against that feature's actual
introduction — see scripts/devops/check-prod-ddl-wiring.py and
scripts/devops/check-e2e-shard-coverage.py for the same "wire it or explicitly
acknowledge it, never just silently drift" pattern applied to other incident
classes in this repo.

Verifies that every `appleboy/ssh-action@vX.Y.Z` step in .github/workflows/*.yml
that sets `capture_stdout: true` is pinned to at least MIN_VERSION (see below).
Steps that do NOT set `capture_stdout: true` are untouched by this guard — bumping
them is unforced regression risk on a real rollout path for zero benefit (see the
"VERSION PIN" comment on the backup-freshness step in deploy.yml).

Deliberately NOT a full YAML parse (no PyYAML dependency, matching the existing
guards' own pragmatic regex-based approach — see check-prod-ddl-wiring.py's header
for why): tracks step boundaries via indentation only, which is sufficient because
this repo's workflow YAML is consistently 2-space-indented with no tabs.

Fails with a clear error listing violations + instructions.

Tests: scripts/devops/tests/test-check-ssh-action-capture-stdout-version.sh —
positive AND negative cases, including a comment claiming the pin was bumped
above a `uses:` line that was not, and the precision cases proving an old pin
that never asks for capture_stdout is NOT flagged (a false positive there would
push someone to bump a version on a live deploy path for no benefit).

Run: python3 scripts/devops/check-ssh-action-capture-stdout-version.py
"""

import os
import re
import sys

# ---------------------------------------------------------------------------
# Root of the repo — resolve relative to this script location
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
WORKFLOWS_DIR = os.path.join(REPO_ROOT, ".github", "workflows")

# `capture_stdout` / `outputs.stdout` were introduced in appleboy/ssh-action v1.2.1
# (verified directly against the v1.2.0/v1.2.1/v1.2.2/v1.2.3 `action.yml` tags: v1.2.0
# has no `capture_stdout` input and no `outputs:` section at all; v1.2.1 onward has
# both). Any step that sets `capture_stdout: true` below this version is silently
# broken — `outputs.stdout` will always be empty, never an error, so nothing turns
# red on its own.
MIN_VERSION = (1, 2, 1)

USES_RE = re.compile(r"^([ \t]*)uses:\s*appleboy/ssh-action@v([0-9]+(?:\.[0-9]+){0,2})\s*(?:#.*)?$")
CAPTURE_STDOUT_RE = re.compile(r"^\s*capture_stdout:\s*true\s*(?:#.*)?$")


def parse_version(v):
    parts = [int(p) for p in v.split(".")]
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


def format_version(v):
    return ".".join(str(p) for p in v)


def list_workflow_files(workflows_dir):
    if not os.path.isdir(workflows_dir):
        return []
    out = []
    for name in sorted(os.listdir(workflows_dir)):
        if name.endswith((".yml", ".yaml")):
            out.append(os.path.join(workflows_dir, name))
    return out


def find_violations(path):
    """Return a list of (line_no, version_str) for capture_stdout steps pinned
    below MIN_VERSION in the given workflow file."""
    with open(path, "r") as f:
        lines = f.read().splitlines()

    violations = []
    for i, line in enumerate(lines):
        m = USES_RE.match(line)
        if not m:
            continue
        indent = len(m.group(1))
        version_str = m.group(2)
        version = parse_version(version_str)
        # The `- name: ...`/`- uses: ...` step marker for THIS `uses:` key sits two
        # columns to the left (the "- " prefix) — sibling keys within the same step
        # (id/if/with/capture_stdout under with/etc.) are indented deeper than that
        # marker. A non-blank, non-comment line at or below that marker's indent
        # means we have left this step's body (either the next step's "- " marker,
        # or a dedent back out of the steps: list entirely).
        step_marker_indent = max(indent - 2, 0)

        uses_capture_stdout = False
        for j in range(i + 1, len(lines)):
            nxt = lines[j]
            stripped = nxt.strip()
            if not stripped or stripped.startswith("#"):
                continue
            nxt_indent = len(nxt) - len(nxt.lstrip(" "))
            if nxt_indent <= step_marker_indent:
                break
            if CAPTURE_STDOUT_RE.match(nxt):
                uses_capture_stdout = True
                break

        if uses_capture_stdout and version < MIN_VERSION:
            violations.append((i + 1, version_str))

    return violations


def main():
    workflow_files = list_workflow_files(WORKFLOWS_DIR)
    if not workflow_files:
        print("ERROR: no workflow files found under {}".format(WORKFLOWS_DIR))
        return 1

    all_violations = []
    for path in workflow_files:
        for line_no, version_str in find_violations(path):
            all_violations.append((os.path.relpath(path, REPO_ROOT), line_no, version_str))

    print("ssh-action capture_stdout Version Guard")
    print("  Workflow files scanned: {}".format(len(workflow_files)))
    print("  Minimum version when capture_stdout is used: v{}".format(format_version(MIN_VERSION)))
    print("  Violations found:        {}".format(len(all_violations)))

    if all_violations:
        print()
        print("FAIL: the following appleboy/ssh-action steps set `capture_stdout: true`")
        print("but are pinned below v{} — `capture_stdout`/`outputs.stdout` do not exist".format(format_version(MIN_VERSION)))
        print("on that version's action.yml, so `outputs.stdout` will silently always be")
        print("empty (SSH_OUTCOME=success + SSH_STDOUT=\"\" on every run — not a flake, a")
        print("permanent no-op):")
        for rel_path, line_no, version_str in all_violations:
            print("  {}:{} — pinned @v{}".format(rel_path, line_no, version_str))
        print()
        print("Fix: bump ONLY that step's `uses: appleboy/ssh-action@vX.Y.Z` pin to at")
        print("least v{} (v1.2.3 is the newest tag this repo has verified still carries".format(format_version(MIN_VERSION)))
        print("the feature — see .github/workflows/deploy.yml's 'VERSION PIN' comment on")
        print("the backup-freshness step for the full story and the reasoning for why")
        print("OTHER appleboy/ssh-action steps that do NOT use capture_stdout should stay")
        print("on their existing pin rather than being bumped along with it.")
        return 1

    print()
    print("OK: every appleboy/ssh-action step that relies on capture_stdout/outputs.stdout")
    print("is pinned to a version that actually supports it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
