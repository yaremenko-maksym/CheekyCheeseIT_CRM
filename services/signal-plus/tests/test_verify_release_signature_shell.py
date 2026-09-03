"""Pytest wrapper around ``test_verify_release_signature.sh``.

SR-M-7 (PR #650 security review round 2, id 5107124812): that shell script
is the regression guard for SR-H-2 (round 1) -- a revoked-key signature
must be rejected even though gpg exits 0 and still emits VALIDSIG with the
correct fingerprint. Nothing executed it: not pytest's own collection
(`testpaths = ["tests"]` only picks up ``test_*.py``), not the Dockerfile's
``test`` stage (``python -m pytest`` only), not
``scripts/devops/tests/run-guard-tests.sh`` (only sweeps
``scripts/devops/tests/test-*.sh``), not any CI workflow. A guard planted on
a HIGH finding was dead on arrival -- this repo already has two prior,
unrelated instances of exactly this failure mode (PR #625's 42
never-executed ``cross-agent-hooks-smoke.sh`` cases; the mutation-nightly
gate reading 20 red nights as "survivors" instead of "the check is down").

Wrapping the script as a pytest case makes it ride along everywhere pytest
already runs -- including the Dockerfile's own ``test`` stage, which gates
every image build, and (once CR-M-6's pull_request trigger lands) the PR
gate itself.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).parent / "test_verify_release_signature.sh"


def test_verify_release_signature_shell_suite():
    # AC6's empty-PATH fixture (conftest.py, autouse) exists so a test
    # cannot stumble onto a REAL signal-cli/gpg by accident -- it is not
    # meant to stop this ONE test from finding the plain POSIX tools
    # (bash/mktemp/cat/chmod/grep) the shell script needs just to run its
    # own logic. That logic shadows `gpg` with its OWN fake shim FIRST on
    # this constructed PATH (see the script's "fake gpg shim" section), so
    # no real gpg/network becomes reachable just because PATH is non-empty
    # here -- AC6's actual guarantee (no real signal-cli/network call) is
    # unaffected.
    env = {**os.environ, "PATH": "/usr/bin:/bin"}
    result = subprocess.run(
        ["/bin/bash", str(SCRIPT)],
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
    )
    assert result.returncode == 0, (
        f"test_verify_release_signature.sh failed (exit {result.returncode}):\n"
        f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
    )
    # The money case from SR-H-2 must actually have RUN, not just "the
    # script happened to exit 0" (e.g. because every case silently no-opted).
    assert "revoked key's signature is rejected" in result.stdout
    assert "5 passed, 0 failed" in result.stdout
