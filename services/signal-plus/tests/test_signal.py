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
