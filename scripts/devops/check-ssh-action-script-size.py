#!/usr/bin/env python3
"""
ssh-action Inline Script Size Guard — task-infra-deploy-arglist-too-long, 2026-10-19.

Incident this guards against: on 2026-10-19 the deploy of b2054f8a1 failed before
its main step had started, with a runner error and no SQL anywhere in sight —

    An error occurred trying to start process '/usr/bin/bash' with working
    directory '...'. Argument list too long

appleboy/ssh-action is a composite action: it forwards the `script:` input to its
own `entrypoint.sh` step as the single environment string `INPUT_SCRIPT=<the whole
script>` (see the action's action.yml: `INPUT_SCRIPT: ${{ inputs.script }}`). On
Linux, execve refuses with E2BIG when ANY single argv OR envp string exceeds
MAX_ARG_STRLEN = 32 * PAGE_SIZE = 32 * 4096 = 131072 bytes — the limit is
per-string, and environment strings are counted exactly like arguments. deploy.yml's
"Pull, up, migrate, health-check via SSH" step had grown, one honest DDL apply block
at a time, to 133905 bytes across 2358 lines. PR #1027 added the last three blocks
and crossed the line.

Nothing warned. The script was correct, every guard was green, prettier was clean,
the YAML parsed — and `main` simply could not deploy any more, for any commit,
until the step was restructured. That is the defining property of this failure
class and the reason this guard exists: the cost is paid entirely in production,
all at once, by whoever merges the few hundred bytes that happen to tip it over.

The fix was NOT to shrink the script. The comments in a deploy script are what stop
the next person re-breaking an invariant that cost an incident to learn; trading
them for a few hundred bytes buys one merge and fails on the next. The script moved
to scripts/devops/deploy-stack-on-vps.sh and is now passed by `script_path:`, which
drone-ssh reads with os.ReadFile — so it is never an environment string and has no
size ceiling at all. This guard then keeps the REMAINING inline scripts (and any new
one) from walking into the same wall: it refuses at MAX_INLINE_BYTES, deliberately
well below the OS limit, so there is room to notice and restructure rather than a
cliff edge.

Same "wire it or explicitly acknowledge it, never silently drift" family as
scripts/devops/check-prod-ddl-wiring.py, check-e2e-shard-coverage.py and
check-ssh-action-capture-stdout-version.py — and, like the last of those, it is
repo-wide rather than scoped to the one step that broke.

WHAT IS IN SCOPE: whatever the step ships to the remote AS A COMMAND STRING. That
is `script:` — and ALSO the FILE behind `script_path:`.

That second half is not symmetry for its own sake; it is the bug this guard shipped
with. The first version scoped itself to the inline `script:` only, on the belief
that `script_path:` escaped the limit. It does not. drone-ssh `os.ReadFile`s the
referenced file into the SAME `scripts` slice `INPUT_SCRIPT` feeds, then sends
`strings.Join(p.Config.Script, "\n")` to `ssh.Stream` as one command string
(plugin.go) — so the body still crosses as a single SSH exec argument and the
REMOTE `/bin/bash` refuses it. The deploy of 3928ba00e failed exactly that way
while this guard reported `Violations found: 0`, because the step's inline script
was 0 bytes. A guard that is green through the failure it was written for is worse
than no guard: it is a green light.

So: `script_path:` is measured by the size of the file it names. What is genuinely
out of scope is a step whose script is a short DISPATCH to a file already on the
far side (`script: bash /opt/crm/.../x.sh`), because then the only thing crossing
as a command is a path of tens of bytes and the content travelled by scp, where no
argument limit applies. That is the escape hatch this guard pushes people toward,
and it is the ONLY one.

Deliberately NOT a full YAML parse (no PyYAML dependency — same pragmatic,
indentation-tracking approach as the sibling guards, see check-prod-ddl-wiring.py's
header for why): this repo's workflow YAML is consistently 2-space-indented with no
tabs. The extractor was cross-checked against PyYAML on the real deploy.yml and
agreed to the byte (133905) on the pre-fix payload.

Tests: scripts/devops/tests/test-check-ssh-action-script-size.sh — positive AND
negative cases, including the oversized inline script that caused the incident, a
comment claiming the script "is small now", a `script:` belonging to a LATER
non-ssh-action step (which must not be charged to an earlier ssh-action step), and
the `script_path:` case which must stay green however large the referenced file is.

Run: python3 scripts/devops/check-ssh-action-script-size.py
"""

import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
WORKFLOWS_DIR = os.path.join(REPO_ROOT, ".github", "workflows")

# Linux MAX_ARG_STRLEN — the hard ceiling on any single argv/envp string:
# 32 * PAGE_SIZE, and PAGE_SIZE is 4096 on every x86_64/arm64 GitHub runner.
# Reaching it does not degrade anything; the process cannot be spawned at all.
MAX_ARG_STRLEN = 32 * 4096  # 131072

# `INPUT_SCRIPT=` — the env string is the NAME, `=`, and the value, so the name
# eats into the same budget. Small, but counted, because the whole point of a
# guard is to not hand-wave at the boundary.
ENV_NAME_OVERHEAD = len("INPUT_SCRIPT=")

# Where we actually refuse. Far below the ceiling on purpose: a guard that fires
# at 130000 would be true and useless — it would land on the same unlucky PR, just
# with a better error message. At 100000 there is ~31KB of warning, which is room
# to move a script to `script_path:` as a considered change rather than a hotfix
# against a dead deploy pipeline.
MAX_INLINE_BYTES = 100000

USES_RE = re.compile(r"^([ \t]*)uses:\s*appleboy/ssh-action@v?([0-9][0-9.]*)\s*(?:#.*)?$")
# `script_path:` — the value is NOT `\S+`: `${{ github.workspace }}` has spaces
# inside the expression.
SCRIPT_PATH_RE = re.compile(r"^(\s*)script_path:\s*(.+?)\s*$")
WORKSPACE_PREFIX = "${{ github.workspace }}/"
# `script:` with a block scalar (`|`, `|-`, `>+`, …) or a plain inline value.
SCRIPT_BLOCK_RE = re.compile(r"^(\s*)script:\s*([|>])([+-]?)\s*(?:#.*)?$")
SCRIPT_INLINE_RE = re.compile(r"^(\s*)script:[ \t]+(\S.*)$")
# An explicit block indentation indicator (`|2`) would make the dedent below
# wrong. We have never used one; if one ever appears we fail loud rather than
# quietly under-measure, which is the failure mode this file is about.
SCRIPT_INDICATOR_RE = re.compile(r"^(\s*)script:\s*[|>][+-]?[0-9]")


def list_workflow_files(workflows_dir):
    if not os.path.isdir(workflows_dir):
        return []
    return [
        os.path.join(workflows_dir, name)
        for name in sorted(os.listdir(workflows_dir))
        if name.endswith((".yml", ".yaml"))
    ]


def indent_of(line):
    return len(line) - len(line.lstrip(" "))


def measure_block(lines, first_body_idx, key_indent):
    """Bytes of a block scalar's value as the runner would pass it.

    Body lines are those indented deeper than the `script:` key itself; blank
    lines belong to the block regardless of their width. The value is the bodies
    dedented by the block's own common indent, rejoined with "\\n". Folded
    scalars (`>`) replace newlines with single spaces — same byte count, so one
    measurement serves both.
    """
    body = []
    i = first_body_idx
    while i < len(lines):
        line = lines[i]
        if line.strip() == "":
            body.append("")
            i += 1
            continue
        if indent_of(line) <= key_indent:
            break
        body.append(line)
        i += 1

    # Trailing blank lines are not part of the value.
    while body and body[-1] == "":
        body.pop()
    if not body:
        return 0, 0

    block_indent = min(indent_of(line) for line in body if line.strip())
    dedented = [line[block_indent:] if line.strip() else "" for line in body]
    # Clip chomping (the default, and `|-`/`|+` differ by at most one byte —
    # irrelevant at this scale, and erring upward is the safe direction here).
    value = "\n".join(dedented) + "\n"
    return len(value.encode("utf-8")), len(dedented)


def measure_script_path(path, line_no, ref):
    """Bytes of the FILE a `script_path:` names — that file is read and shipped
    as the command string, so its size is the thing under the limit."""
    if not ref.startswith(WORKSPACE_PREFIX):
        raise SystemExit(
            "ERROR: {}:{} has `script_path: {}`, which this guard cannot resolve.\n"
            "Only `{}<repo-relative path>` is understood. An unmeasured script_path is\n"
            "how this guard went green through the very failure it exists to catch, so\n"
            "this is a hard failure rather than a skip.".format(
                os.path.relpath(path, REPO_ROOT), line_no, ref, WORKSPACE_PREFIX
            )
        )
    rel = ref[len(WORKSPACE_PREFIX) :]
    target = os.path.join(REPO_ROOT, rel)
    if not os.path.isfile(target):
        raise SystemExit(
            "ERROR: {}:{} points `script_path:` at {}, which does not exist.\n"
            "That is a broken deploy, not a guard problem.".format(
                os.path.relpath(path, REPO_ROOT), line_no, rel
            )
        )
    with open(target, "rb") as f:
        data = f.read()
    return len(data), data.count(b"\n")


def find_command_payloads(path):
    """[(line_no, step_line_no, bytes, lines, kind)] — one per ssh-action step,
    measuring what that step ships to the remote as a command string: an inline
    `script:`, or the FILE named by `script_path:`."""
    with open(path, "r") as f:
        lines = f.read().split("\n")

    found = []
    for i, line in enumerate(lines):
        m = USES_RE.match(line)
        if not m:
            continue
        # The step's `- ` marker sits two columns left of its own keys; any
        # non-blank, non-comment line at or below that column means we have left
        # this step (same step-boundary logic as
        # check-ssh-action-capture-stdout-version.py).
        step_marker_indent = max(len(m.group(1)) - 2, 0)

        for j in range(i + 1, len(lines)):
            nxt = lines[j]
            stripped = nxt.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if indent_of(nxt) <= step_marker_indent:
                break  # next step / dedent out of `steps:`

            if SCRIPT_INDICATOR_RE.match(nxt):
                raise SystemExit(
                    "ERROR: {}:{} uses a block scalar indentation indicator on `script:`.\n"
                    "This guard measures by dedenting to the block's common indent and cannot\n"
                    "do that safely with an explicit indicator. Either drop the indicator or\n"
                    "teach measure_block() about it — do NOT leave it unmeasured.".format(
                        os.path.relpath(path, REPO_ROOT), j + 1
                    )
                )

            mp = SCRIPT_PATH_RE.match(nxt)
            if mp:
                n_bytes, n_lines = measure_script_path(path, j + 1, mp.group(2))
                found.append((j + 1, i + 1, n_bytes, n_lines, "script_path"))
                break

            mb = SCRIPT_BLOCK_RE.match(nxt)
            if mb:
                n_bytes, n_lines = measure_block(lines, j + 1, indent_of(nxt))
                found.append((j + 1, i + 1, n_bytes, n_lines, "script"))
                break

            mi = SCRIPT_INLINE_RE.match(nxt)
            if mi:
                found.append((j + 1, i + 1, len(mi.group(2).encode("utf-8")), 1, "script"))
                break

    return found


def main():
    workflow_files = list_workflow_files(WORKFLOWS_DIR)
    if not workflow_files:
        print("ERROR: no workflow files found under {}".format(WORKFLOWS_DIR))
        return 1

    measured = []
    for path in workflow_files:
        rel = os.path.relpath(path, REPO_ROOT)
        for line_no, step_line, n_bytes, n_lines, kind in find_command_payloads(path):
            measured.append((rel, line_no, step_line, n_bytes, n_lines, kind))

    violations = [m for m in measured if m[3] + ENV_NAME_OVERHEAD > MAX_INLINE_BYTES]
    largest = max((m[3] for m in measured), default=0)

    print("ssh-action Remote Command Size Guard")
    print("  Workflow files scanned:        {}".format(len(workflow_files)))
    print("  ssh-action command payloads:   {}".format(len(measured)))
    print("  Budget per payload:            {} bytes (OS limit MAX_ARG_STRLEN = {})".format(MAX_INLINE_BYTES, MAX_ARG_STRLEN))
    print("  Largest payload:               {} bytes".format(largest))
    print("  Violations found:              {}".format(len(violations)))

    if measured:
        print()
        print("  Inventory (bytes shipped as the remote command string, largest first):")
        for rel, line_no, _step, n_bytes, n_lines, kind in sorted(measured, key=lambda m: -m[3]):
            print("    {:7d}B / {:5d} lines  {}:{} ({}:)".format(n_bytes, n_lines, rel, line_no, kind))

    if violations:
        print()
        print("FAIL: the following appleboy/ssh-action steps ship a command string at or near")
        print("MAX_ARG_STRLEN ({} bytes). Both `script:` and `script_path:` end up in the".format(MAX_ARG_STRLEN))
        print("same place: drone-ssh joins them into ONE string and hands it to ssh.Stream, and")
        print("the runner passes `script:` through the env var INPUT_SCRIPT on the way. Linux")
        print("execve fails with E2BIG when any single argv/envp string exceeds that limit, so")
        print("the script does not run slowly or partially — it cannot start at all, on the")
        print("runner or on the VPS:")
        print("  \"An error occurred trying to start process '/usr/bin/bash' ...")
        print("   Argument list too long\"           (runner, inline script:)")
        print("  \"/bin/bash: Argument list too long\"  (VPS, script_path: — PR #1035)")
        for rel, line_no, step_line, n_bytes, n_lines, kind in violations:
            print(
                "  {}:{} — {} bytes / {} lines via {}: (step at line {}), over budget by {} bytes".format(
                    rel, line_no, n_bytes, n_lines, kind, step_line,
                    n_bytes + ENV_NAME_OVERHEAD - MAX_INLINE_BYTES,
                )
            )
        print()
        print("Fix: `script_path:` is NOT the fix — it is measured here for exactly that")
        print("reason. Ship the body as a FILE and keep the command short:")
        print("  1. put it in scripts/devops/<name>.sh;")
        print("  2. scp it to the VPS (appleboy/scp-action, target '/opt/crm' — the source")
        print("     tree is preserved under the target);")
        print("  3. make the ssh step's whole script `bash /opt/crm/scripts/devops/<name>.sh`.")
        print("Then the command is a path of tens of bytes and the content never crosses as an")
        print("argument. Remember the script needs a checkout before the scp, and that any")
        print("variable it uses must be in BOTH the step's `env:` block and its `envs:` list.")
        print("Worked example: deploy.yml's 'Pull, up, migrate, health-check via SSH' step +")
        print("scripts/devops/deploy-stack-on-vps.sh.")
        print()
        print("Do NOT fix this by deleting comments to get under the limit. That buys one")
        print("merge, and the reasoning in a deploy script is worth more than the bytes.")
        return 1

    print()
    print("OK: every ssh-action command payload is within budget — none can hit MAX_ARG_STRLEN")
    print("on the runner or on the remote.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
