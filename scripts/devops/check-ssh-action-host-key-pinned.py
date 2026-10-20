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
  (unclassified)     any other appleboy action or version (including a version that
                     is an expression such as `${{ matrix.v }}`, which cannot be
                     checked statically). FAILS: someone bumped a pin or added an
                     action and must decide which table it belongs in by reading that
                     version's action.yml — never by assumption.

DISCOVERY FAILS CLOSED. A guard whose silence can mean "I could not parse that" is
indistinguishable from one that checked and found nothing. So:
  * every case-insensitive occurrence of `appleboy` in a non-comment line that did NOT
    become a parsed `uses:` step is itself a violation (flow-style steps, `uses:` with
    the value on the next line, `docker://appleboy/...`, ...). Pure comment lines are
    prose and are skipped; everything else must be understood or the guard fails;
  * the owner is matched case-insensitively (GitHub resolves `Appleboy/...` to the same
    action) and normalised to lower case, so it is held to the same rule;
  * a subpath after the repo name, and a version with spaces or expressions, are parsed
    (and then fail classification) instead of being dropped;
  * `.github/actions/**` (composite actions) is scanned as well as `.github/workflows/*`;
  * a run that finds NO steps at all fails (MIN_STEPS): zero is how a broken scan looks.

The fingerprint must be a LITERAL (`SHA256:<43 base64 chars>`), not `${{ vars.* }}` /
`${{ secrets.* }}`: an empty or renamed variable makes these actions fall back to
InsecureIgnoreHostKey silently, so a green step would prove nothing. A literal cannot
be empty. The value is public (a host-key hash); rotating it is a PR, as a trust
anchor should be. All steps must carry the SAME literal (one VPS) — a typo in one
step is caught here instead of failing that step's deploy.

Deliberately NOT a full YAML parse (no PyYAML dependency, same pragmatic approach as
check-ssh-action-capture-stdout-version.py): step boundaries are tracked by
indentation, sufficient because this repo's workflow YAML is 2-space-indented with no
tabs. `fingerprint:` is only recognised as a direct child of the step's `with:` block
(not `env:`), so the word appearing in a `script: |` body, a comment, or an `env:` map
does not count. Limitation: `with:` must come after `uses:` in the step (it always does
here); if it did not, the guard fails loudly rather than passing.

Tests: scripts/devops/tests/test-check-ssh-action-host-key-pinned.sh — both
directions, by running, including the discovery forms and the zero-steps run.

Run: python3 scripts/devops/check-ssh-action-host-key-pinned.py
"""

import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
WORKFLOWS_DIR = os.path.join(REPO_ROOT, ".github", "workflows")
ACTIONS_DIR = os.path.join(REPO_ROOT, ".github", "actions")

# A scan that finds fewer steps than this is a broken scan, not a clean repo.
MIN_STEPS = 1

# ---------------------------------------------------------------------------
# Version tables. Evidence = what was read to decide (the pinned tag's files).
# To add a version: read its action.yml AND the binary/library it runs, then add
# it to exactly one table. Do not copy a neighbouring version's row on trust.
# Keys are (lower-cased action, exact version text).
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
# Owner/repo match is case-insensitive; the action part may carry a subpath; the version is
# whatever follows `@` (spaces and `${{ }}` included) so that it is classified, not dropped.
USES_RE = re.compile(
    r"""^(?P<indent>[ ]*)(?P<dash>-[ ]+)?uses:\s*['"]?(?P<action>appleboy/[^@\s'"]+)@(?P<version>[^'"#]*?)['"]?\s*(?:#.*)?$""",
    re.IGNORECASE,
)
WITH_RE = re.compile(r"^with:\s*(?:#.*)?$")
FINGERPRINT_RE = re.compile(r"^fingerprint:\s*(?P<value>.*?)\s*(?:#.*)?$")
TRAILING_COMMENT_RE = re.compile(r"\s#.*$")


def list_yaml_files(root, recursive):
    if not os.path.isdir(root):
        return []
    out = []
    if recursive:
        for dirpath, _dirs, files in os.walk(root):
            for n in files:
                if n.endswith((".yml", ".yaml")):
                    out.append(os.path.join(dirpath, n))
    else:
        for n in os.listdir(root):
            if n.endswith((".yml", ".yaml")):
                out.append(os.path.join(root, n))
    return sorted(out)


def scan_file(path):
    """Return (steps, unparsed).
    steps:    list of dict(line, action, version, fingerprint); `fingerprint` is None when the
              step's `with:` has no direct `fingerprint:` key.
    unparsed: list of (line_no, text) — non-comment lines mentioning `appleboy` that did not
              become a step. These are violations: the guard must not stay silent about
              something it could not read."""
    with open(path, "r") as f:
        lines = f.read().splitlines()

    steps = []
    parsed_lines = set()
    for i, line in enumerate(lines):
        m = USES_RE.match(line)
        if not m:
            continue
        parsed_lines.add(i)
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
                in_with = False  # env:, if:, name:, ... — their children are NOT `with:` inputs
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
                "action": m.group("action").lower(),
                "version": m.group("version").strip(),
                "fingerprint": fingerprint,
            }
        )

    unparsed = []
    for i, line in enumerate(lines):
        if i in parsed_lines or line.strip().startswith("#"):
            continue
        if "appleboy" in TRAILING_COMMENT_RE.sub("", line).lower():
            unparsed.append((i + 1, line.strip()))
    return steps, unparsed


def evaluate(all_steps, all_unparsed):
    """all_steps: list of (relpath, record); all_unparsed: list of (relpath, line_no, text).
    Returns (violations, pinned, exempt, literals)."""
    violations, pinned, exempt = [], 0, 0
    literals = set()

    for rel, line_no, text in all_unparsed:
        violations.append(
            "{}:{} — mentions appleboy but is not a `uses: appleboy/<action>@<version>` step the "
            "guard can read (flow-style, value on the next line, docker://, ...): {!r}. Rewrite it "
            "as a plain `uses:` line so it can be checked; unreadable is a failure, not a pass".format(
                rel, line_no, text[:120]
            )
        )

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
    files = list_yaml_files(WORKFLOWS_DIR, recursive=False) + list_yaml_files(ACTIONS_DIR, recursive=True)
    if not files:
        print("ERROR: no workflow or action files found under {}".format(os.path.join(REPO_ROOT, ".github")))
        return 1

    all_steps, all_unparsed = [], []
    for path in files:
        rel = os.path.relpath(path, REPO_ROOT)
        steps, unparsed = scan_file(path)
        all_steps.extend((rel, s) for s in steps)
        all_unparsed.extend((rel, n, t) for n, t in unparsed)

    violations, pinned, exempt, _ = evaluate(all_steps, all_unparsed)
    if len(all_steps) < MIN_STEPS:
        violations.append(
            "found {} appleboy steps (minimum {}): a scan that finds nothing is a broken scan, "
            "not a clean repo".format(len(all_steps), MIN_STEPS)
        )

    print("appleboy ssh/scp Host-Key Pinning Guard")
    print("  Files scanned (workflows + actions): {}".format(len(files)))
    print("  appleboy steps found:         {}".format(len(all_steps)))
    print("  Pinned (literal fingerprint): {}".format(pinned))
    print("  Exempt (cannot pin, listed):  {}".format(exempt))
    print("  Unreadable appleboy mentions: {}".format(len(all_unparsed)))
    print("  Violations found:             {}".format(len(violations)))
    if PINNING_EXEMPT:
        print("  Exemptions:")
        for (action, version), reason in sorted(PINNING_EXEMPT.items()):
            print("    {}@{} — {}".format(action, version, reason))

    if violations:
        print()
        print("FAIL: host-key pinning is incomplete, misleading, or could not be checked:")
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
