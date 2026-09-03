"""Tests for signal_plus.signal — subprocess wrapper around signal-cli.

CLI shape verified against AsamK/signal-cli source (tag v0.14.7, commit
b01b6b370dc063599a1a2b9fde0f5ff4e2d78fe8) — see signal_plus/signal.py's
module docstring for the exact file/line citations. Every test here injects a
fake ``run`` callable; none of them touch a real binary (AC6, reinforced
suite-wide by tests/conftest.py's empty-PATH + blocked-socket fixtures).
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from signal_plus.config import Config
from signal_plus.updater import OUTDATED_CLIENT_MESSAGE  # module-level: see
# test_outdated_client_message_survives_sanitization -- importing this at
# call-time instead of collection-time makes `updater`'s `import
# urllib.request` (-> ssl) the FIRST import of `ssl` in this file's own test
# process, which lands AFTER conftest.py's autouse `block_real_sockets`
# fixture has already monkeypatched `socket.socket` -- `ssl.py`'s own
# `class SSLSocket(socket):` then subclasses the monkeypatched function
# instead of the real class and crashes with an unrelated TypeError. Only
# reproduces when this file runs in isolation (in the full suite,
# test_alert.py's module-level `signal_plus.alert` import already pulls in
# `ssl` during collection, before any fixture runs) -- not a bug in the code
# under test, so it is worked around here rather than "fixed" anywhere real.
from signal_plus.signal import (
    SignalResult,
    list_groups,
    receive,
    send_direct_message,
    send_group_message,
)


@pytest.fixture
def config() -> Config:
    return Config(
        signal_account="+380501234567",
        signal_group_id="group.abc123==",
        signal_cli_bin=Path("/opt/signal-cli/bin/signal-cli"),
        state_file=Path("/data/state.json"),
    )


class RecordingRun:
    """Fake ``subprocess.run`` that records the argv it was called with."""

    def __init__(self, returncode=0, stdout="ok", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.calls: list[list[str]] = []

    def __call__(self, argv, **kwargs):
        self.calls.append(list(argv))
        assert kwargs.get("capture_output") is True
        assert kwargs.get("text") is True
        return subprocess.CompletedProcess(argv, self.returncode, self.stdout, self.stderr)


def test_receive_invokes_correct_argv(config):
    fake = RecordingRun()
    receive(config, run=fake)
    assert fake.calls == [["/opt/signal-cli/bin/signal-cli", "-a", "+380501234567", "receive"]]


def test_send_group_message_invokes_correct_argv(config):
    fake = RecordingRun()
    send_group_message(config, "+", run=fake)
    assert fake.calls == [
        [
            "/opt/signal-cli/bin/signal-cli",
            "-a",
            "+380501234567",
            "send",
            "-g",
            "group.abc123==",
            "-m",
            "+",
        ]
    ]


def test_send_direct_message_invokes_correct_argv(config):
    fake = RecordingRun()
    send_direct_message(config, "+380509998877", "ERROR: something broke", run=fake)
    assert fake.calls == [
        [
            "/opt/signal-cli/bin/signal-cli",
            "-a",
            "+380501234567",
            "send",
            "+380509998877",
            "-m",
            "ERROR: something broke",
        ]
    ]


def test_list_groups_invokes_correct_argv(config):
    fake = RecordingRun()
    list_groups(config, run=fake)
    assert fake.calls == [["/opt/signal-cli/bin/signal-cli", "-a", "+380501234567", "listGroups"]]


def test_result_ok_true_on_zero_returncode(config):
    result = receive(config, run=RecordingRun(returncode=0))
    assert isinstance(result, SignalResult)
    assert result.ok is True


def test_result_ok_false_on_nonzero_returncode(config):
    result = receive(config, run=RecordingRun(returncode=1))
    assert result.ok is False
    assert result.returncode == 1


def test_result_output_combines_stdout_and_stderr(config):
    result = receive(config, run=RecordingRun(stdout="out-line", stderr="err-line"))
    assert "out-line" in result.output
    assert "err-line" in result.output


def test_timeout_is_passed_through_to_run(config):
    captured = {}

    def fake_run(argv, **kwargs):
        captured.update(kwargs)
        return subprocess.CompletedProcess(argv, 0, "", "")

    receive(config, run=fake_run, timeout=5)
    assert captured["timeout"] == 5


# ---------------------------------------------------------------------------
# SR-H-1 (PR #650 security review, id 5105061153) -- signal-cli v0.14.7
# embeds the configured account verbatim in several of its own error
# messages (App.java: "User <account> is not registered.", "Error while
# checking account <account>: ...", "Error loading state file for user
# <account>: ..."). This is the single choke point every consumer of
# SignalResult goes through (cli.py's logs/state, alert.py's email/DM/issue)
# -- see signal_plus/signal.py's _sanitize_cli_text for the fix.
# ---------------------------------------------------------------------------


def test_receive_output_never_contains_the_raw_account_number(config):
    fake = RecordingRun(
        returncode=1,
        stdout="",
        stderr=f"Error loading state file for user {config.signal_account}: boom (IOException)",
    )
    result = receive(config, run=fake)
    assert config.signal_account not in result.stdout
    assert config.signal_account not in result.stderr
    assert config.signal_account not in result.output


def test_send_output_never_contains_the_raw_account_number(config):
    fake = RecordingRun(
        returncode=1,
        stdout="",
        stderr=f"User {config.signal_account} is not registered.",
    )
    result = send_group_message(config, "+", run=fake)
    assert config.signal_account not in result.output


def test_sanitized_output_still_keeps_a_recognisable_masked_form(config):
    # Not just deleted -- masked, per requirement 1 ("маскировать", not
    # "убрать"): a human reading the log can still tell which account this
    # was, via the same first/last-char mask config.mask_secret() uses
    # elsewhere.
    fake = RecordingRun(
        returncode=1, stdout="", stderr=f"User {config.signal_account} is not registered."
    )
    result = receive(config, run=fake)
    assert "***" in result.output


def test_other_peoples_e164_numbers_are_also_scrubbed_from_output(config):
    # SR-H-1 fix instruction: "вычистка E.164-шаблона" -- not just OUR
    # configured account, e.g. a message sender surfaced by `receive`.
    other_number = "+15551234999"
    fake = RecordingRun(returncode=0, stdout=f"Envelope from: {other_number}", stderr="")
    result = receive(config, run=fake)
    assert other_number not in result.output


def test_multiline_output_is_not_leaked_past_the_first_line(config):
    # `receive` can dump multiple incoming envelopes (message bodies +
    # sender numbers) across several lines -- none of that has any business
    # leaving this module, only the first line (where signal-cli's own
    # single-line error messages live) does.
    fake = RecordingRun(
        returncode=0,
        stdout="first line is safe\nsecond line: +15551234999 leaked body text",
        stderr="",
    )
    result = receive(config, run=fake)
    assert "leaked body text" not in result.output
    assert "+15551234999" not in result.output


def test_outdated_client_message_survives_sanitization(config):
    # The sanitizer must not collide with the ONE other place that reads
    # raw signal-cli output for meaning (updater.is_outdated_client_error) --
    # regression guard for the fix, not a duplicate of test_updater.py's
    # own coverage of that function.
    fake = RecordingRun(
        returncode=1,
        stdout="",
        stderr=f"Error loading state file for user {config.signal_account}: {OUTDATED_CLIENT_MESSAGE} (IOException)",
    )
    result = receive(config, run=fake)
    assert OUTDATED_CLIENT_MESSAGE in result.output
    assert config.signal_account not in result.output
