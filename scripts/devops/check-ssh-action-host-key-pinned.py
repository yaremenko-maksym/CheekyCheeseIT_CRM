#!/usr/bin/env python3
"""
appleboy ssh/scp Host-Key Pinning Guard — task-hostkey-rollout, 2026-10-20.

What this guards. Every `appleboy/ssh-action` / `appleboy/scp-action` step connects
to the production VPS. Without the `fingerprint:` input, easyssh-proxy (the Go SSH
library under both) falls back to `ssh.InsecureIgnoreHostKey()` — the connection
works, the deploy is green, and the VPS identity is never checked. A step that
simply forgets the input looks exactly like a step that has it. The pilot
("Write .env.production via SSH" in deploy.yml) pinned the host key and was proven
by a green production deploy; this guard keeps the rollout from decaying one new
step at a time.

Three states per (action, version), enumerated in the two tables below:

  PINNING_SUPPORTED  the version's action.yml declares `fingerprint` AND the binary
                     it runs enforces it (checked at the pinned tag, not at latest
                     docs). A step on such a version MUST carry a literal fingerprint.
  PINNING_EXEMPT     the version cannot pin. Listed WITH a reason, so an exemption
                     is something a person can enumerate and challenge. Such a step
                     must NOT carry `fingerprint:` — an input the action does not
                     declare is silently ignored, which would make the diff look
                     pinned while verifying nothing (strictly worse than an honest
                     unpinned step, because nobody believes the latter is protected).
  (unclassified)     any other appleboy action or version. FAILS: someone bumped a
                     pin or added an action and must decide which table it belongs in
                     by reading that version's action.yml — never by assumption.

The fingerprint must be a LITERAL (`SHA256:<43 base64 chars>`), not `${{ vars.* }}` /
`${{ secrets.* }}`: an empty or renamed variable makes these actions fall back to
InsecureIgnoreHostKey silently, so a green step would prove nothing. A literal cannot
be empty. The value is public (a host-key hash); rotating it is a PR, as a trust
anchor should be. All steps must carry the SAME literal (one VPS) — a typo in one
step is caught here instead of failing that step's deploy.

Deliberately NOT a full YAML parse (no PyYAML dependency, same pragmatic approach as
check-ssh-action-capture-stdout-version.py): step boundaries are tracked by
indentation, sufficient because this repo's workflow YAML is 2-space-indented with no
tabs. `fingerprint:` is only recognised as a direct child of the step's `with:` block,
so the word appearing inside a `script: |` body, or in a comment, does not count.
Limitation: `with:` must come after `uses:` in the step (it always does here); if it
did not, the guard fails loudly rather than passing.

Tests: scripts/devops/tests/test-check-ssh-action-host-key-pinned.sh — both
directions, by running.

Run: python3 scripts/devops/check-ssh-action-host-key-pinned.py
"""

import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
WORKFLOWS_DIR = os.path.join(REPO_ROOT, ".github", "workflows")

# ---------------------------------------------------------------------------
# Version tables. Evidence = what was read to decide (the pinned tag's files).
# To add a version: read its action.yml AND the binary/library it runs, then add
# it to exactly one table. Do not copy a neighbouring version's row on trust.
# ---------------------------------------------------------------------------
PINNING_SUPPORTED = {
    ("appleboy/ssh-action", "v1.2.0"):
        "action.yml declares `fingerprint` -> INPUT_FINGERPRINT; runs drone-ssh 1.8.0 "
        "(entrypoint.sh) -> easyssh-proxy v1.5.0; proven by the pilot's green deploy",
    ("appleboy/ssh-action", "v1.2.3"):
        "action.yml declares `fingerprint` -> INPUT_FINGERPRINT; runs drone-ssh 1.8.1 "
        "(entrypoint.sh) -> easyssh-proxy v1.5.0 (same enforcement as v1.2.0)",
    ("appleboy/scp-action", "v0.1.7"):
        "action.yml declares `fingerprint`; Dockerfile = ghcr.io/appleboy/drone-scp:1.6.14 "
        "(reads INPUT_FINGERPRINT) -> easyssh-proxy v1.5.0",
}

# (action, version) -> reason it cannot pin. Empty today: every version in use
# supports pinning. Entries here are the ONLY way for an appleboy step to be unpinned.
PINNING_EXEMPT = {}

FINGERPRINT_LITERAL_RE = re.compile(r"^SHA256:[A-Za-z0-9+/]{43}$")
USES_RE = re.compile(
    r"""^(?P<indent>[ ]*)(?P<dash>-[ ]+)?uses:\s*['"]?(?P<action>appleboy/[A-Za-z0-9_.-]+)@(?P<version>[^\s'"#]+)['"]?\s*(?:#.*)?$"""
)
WITH_RE = re.compile(r"^with:\s*(?:#.*)?$")
FINGERPRINT_RE = re.compile(r"^fingerprint:\s*(?P<value>.*?)\s*(?:#.*)?$")


def list_workflow_files(workflows_dir):
    if not os.path.isdir(workflows_dir):
        return []
    return [
        os.path.join(workflows_dir, n)
        for n in sorted(os.listdir(workflows_dir))
        if n.endswith((".yml", ".yaml"))
    ]


def scan_file(path):
    """Return a list of step records: dict(line, action, version, fingerprint).
    `fingerprint` is None when the step's `with:` has no direct `fingerprint:` key."""
    with open(path, "r") as f:
        lines = f.read().splitlines()

    steps = []
    for i, line in enumerate(lines):
        m = USES_RE.match(line)
        if not m:
            continue
        key_indent = len(m.group("indent")) + (len(m.group("dash")) if m.group("dash") else 0)
        step_marker_indent = max(key_indent - 2, 0)

        fingerprint = None
        with_child_indent = None
        in_with = False
        for j in range(i + 1, len(lines)):
            nxt = lines[j]
            stripped = nxt.strip()
            if not stripped or stripped.startswith("#"):
                continue
            nxt_indent = len(nxt) - len(nxt.lstrip(" "))
            if nxt_indent <= step_marker_indent:
                break
            if nxt_indent == key_indent and WITH_RE.match(stripped):
                in_with = True
                with_child_indent = None
                continue
            if nxt_indent == key_indent:
                in_with = False
                continue
            if in_with:
                if with_child_indent is None:
                    with_child_indent = nxt_indent
                if nxt_indent == with_child_indent:
                    fm = FINGERPRINT_RE.match(stripped)
                    if fm:
                        fingerprint = fm.group("value")
        steps.append(
            {
                "line": i + 1,
                "action": m.group("action"),
                "version": m.group("version"),
                "fingerprint": fingerprint,
            }
        )
    return steps


def evaluate(all_steps):
    """all_steps: list of (relpath, record). Returns (violations, pinned, exempt, literals)."""
    violations, pinned, exempt = [], 0, 0
    literals = set()
    for rel, s in all_steps:
        key = (s["action"], s["version"])
        where = "{}:{} — {}@{}".format(rel, s["line"], s["action"], s["version"])
        if key in PINNING_SUPPORTED:
            fp = s["fingerprint"]
            if fp is None or fp == "":
                violations.append(where + " — supports pinning but has no `fingerprint:` (unverified host key)")
            elif not FINGERPRINT_LITERAL_RE.match(fp):
                violations.append(
                    where + " — fingerprint is not a literal `SHA256:<43 base64 chars>` (got {!r}); "
                    "an expression can be empty and silently disable verification".format(fp)
                )
            else:
                pinned += 1
                literals.add(fp)
        elif key in PINNING_EXEMPT:
            exempt += 1
            if s["fingerprint"] is not None:
                violations.append(
                    where + " — listed as unable to pin ({}) but carries `fingerprint:`; "
                    "the action ignores it silently, so it only LOOKS verified".format(PINNING_EXEMPT[key])
                )
        else:
            violations.append(
                where + " — unclassified appleboy action/version: read this tag's action.yml and "
                "the binary it runs, then add it to PINNING_SUPPORTED or PINNING_EXEMPT"
            )
    if len(literals) > 1:
        violations.append(
            "pinned steps disagree on the fingerprint ({}); one VPS must mean one literal".format(
                ", ".join(sorted(literals))
            )
        )
    return violations, pinned, exempt, literals


def main():
    workflow_files = list_workflow_files(WORKFLOWS_DIR)
    if not workflow_files:
        print("ERROR: no workflow files found under {}".format(WORKFLOWS_DIR))
        return 1

    all_steps = []
    for path in workflow_files:
        rel = os.path.relpath(path, REPO_ROOT)
        for s in scan_file(path):
            all_steps.append((rel, s))

    violations, pinned, exempt, _ = evaluate(all_steps)

    print("appleboy ssh/scp Host-Key Pinning Guard")
    print("  Workflow files scanned:       {}".format(len(workflow_files)))
    print("  appleboy steps found:         {}".format(len(all_steps)))
    print("  Pinned (literal fingerprint): {}".format(pinned))
    print("  Exempt (cannot pin, listed):  {}".format(exempt))
    print("  Violations found:             {}".format(len(violations)))
    if PINNING_EXEMPT:
        print("  Exemptions:")
        for (action, version), reason in sorted(PINNING_EXEMPT.items()):
            print("    {}@{} — {}".format(action, version, reason))

    if violations:
        print()
        print("FAIL: host-key pinning is incomplete or misleading:")
        for v in violations:
            print("  " + v)
        print()
        print("Fix: add `fingerprint: SHA256:...` (the literal used by the pilot step in")
        print("deploy.yml — never vars.*/secrets.*) to the step, or, if the version truly")
        print("cannot pin, list it in PINNING_EXEMPT with a reason and leave the input off.")
        return 1

    print()
    print("OK: every appleboy ssh/scp step that can pin the VPS host key does, with one literal.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
