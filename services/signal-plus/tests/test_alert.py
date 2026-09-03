"""Tests for signal_plus.alert — three independent alert layers.

Requirement 10 (verbatim): "Алерт — три слоя, каждый независим: ERROR в лог;
личное сообщение владельцу через signal-cli send на SIGNAL_ALERT_RECIPIENT
(если задан); issue через существующий scripts/devops/post-merge-alert.sh с
новым KIND=signal-plus — сам скрипт не правь (зона DevOps, шаг 4)."
"""
from __future__ import annotations

import logging
import subprocess
from pathlib import Path

import pytest

from signal_plus.alert import (
    log_error,
    raise_alert,
    send_github_issue_alert,
    send_personal_alert,
)
from signal_plus.config import Config


@pytest.fixture
def config_with_recipient(tmp_path) -> Config:
    return Config(
        signal_account="+380501234567",
        signal_group_id="group.abc123==",
        signal_cli_bin=tmp_path / "signal-cli",
        state_file=tmp_path / "state.json",
        signal_alert_recipient="+380509998877",
    )


@pytest.fixture
def config_without_recipient(tmp_path) -> Config:
    return Config(
        signal_account="+380501234567",
        signal_group_id="group.abc123==",
        signal_cli_bin=tmp_path / "signal-cli",
        state_file=tmp_path / "state.json",
        signal_alert_recipient=None,
    )


# ---------------------------------------------------------------------------
# Layer 1: ERROR log
# ---------------------------------------------------------------------------


def test_log_error_logs_at_error_level(caplog):
    with caplog.at_level(logging.ERROR, logger="signal_plus"):
        log_error("today's + was never sent")
    assert any(
        record.levelno == logging.ERROR and "today's + was never sent" in record.message
        for record in caplog.records
    )


# ---------------------------------------------------------------------------
# Layer 2: personal DM via signal-cli send
# ---------------------------------------------------------------------------


def test_send_personal_alert_calls_signal_send_when_recipient_configured(config_with_recipient):
    calls = []

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, "", "")

    sent = send_personal_alert(config_with_recipient, "ERROR: no + today", run=fake_run)
    assert sent is True
    assert len(calls) == 1
    assert calls[0][-2:] == ["-m", "ERROR: no + today"]
    assert "+380509998877" in calls[0]


def test_send_personal_alert_noops_when_recipient_not_configured(config_without_recipient):
    def fail_run(argv, **kwargs):
        raise AssertionError("must not call signal-cli when no recipient is configured")

    sent = send_personal_alert(config_without_recipient, "ERROR: no + today", run=fail_run)
    assert sent is False


def test_send_personal_alert_returns_false_on_signal_cli_failure(config_with_recipient):
    def failing_run(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 1, "", "network unreachable")

    sent = send_personal_alert(config_with_recipient, "ERROR: no + today", run=failing_run)
    assert sent is False


# ---------------------------------------------------------------------------
# Layer 3: GitHub issue via post-merge-alert.sh (call-shape only; the script
# itself is DevOps's zone and is neither modified nor executed for real here)
# ---------------------------------------------------------------------------


def test_send_github_issue_alert_sets_kind_signal_plus(tmp_path):
    script = tmp_path / "post-merge-alert.sh"
    script.write_text("#!/bin/sh\nexit 0\n")
    captured_env = {}

    def fake_run(argv, **kwargs):
        captured_env.update(kwargs.get("env") or {})
        assert argv == [str(script)]
        return subprocess.CompletedProcess(argv, 0, "", "")

    ok = send_github_issue_alert(
        {"ALERT_REPO": "owner/repo", "RESULT": "failure", "COMMIT_SHA": "0" * 40, "RUN_URL": "n/a"},
        script_path=script,
        run=fake_run,
    )
    assert ok is True
    assert captured_env["KIND"] == "signal-plus"
    assert captured_env["ALERT_REPO"] == "owner/repo"


def test_send_github_issue_alert_kind_cannot_be_overridden_by_extra_env(tmp_path):
    script = tmp_path / "post-merge-alert.sh"
    captured_env = {}

    def fake_run(argv, **kwargs):
        captured_env.update(kwargs.get("env") or {})
        return subprocess.CompletedProcess(argv, 0, "", "")

    send_github_issue_alert({"KIND": "ci"}, script_path=script, run=fake_run)
    assert captured_env["KIND"] == "signal-plus"


def test_send_github_issue_alert_false_on_nonzero_exit(tmp_path):
    script = tmp_path / "post-merge-alert.sh"

    def fake_run(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 2, "", "::error:: unknown KIND")

    assert send_github_issue_alert({}, script_path=script, run=fake_run) is False


def test_send_github_issue_alert_false_when_script_missing(tmp_path):
    missing_script = tmp_path / "does-not-exist.sh"

    def raising_run(argv, **kwargs):
        raise FileNotFoundError(argv[0])

    assert send_github_issue_alert({}, script_path=missing_script, run=raising_run) is False


# ---------------------------------------------------------------------------
# raise_alert — all three layers fire independently
# ---------------------------------------------------------------------------


def test_raise_alert_fires_all_three_layers(config_with_recipient, tmp_path, caplog):
    script = tmp_path / "post-merge-alert.sh"
    dm_calls = []
    issue_calls = []

    def fake_run(argv, **kwargs):
        if str(script) in argv:
            issue_calls.append(argv)
        else:
            dm_calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, "", "")

    with caplog.at_level(logging.ERROR, logger="signal_plus"):
        outcome = raise_alert(
            config_with_recipient,
            "ERROR: no + today",
            issue_extra_env={"ALERT_REPO": "owner/repo"},
            script_path=script,
            run=fake_run,
        )

    assert outcome.logged is True
    assert outcome.dm_sent is True
    assert outcome.issue_called is True
    assert len(dm_calls) == 1
    assert len(issue_calls) == 1
    assert any("ERROR: no + today" in r.message for r in caplog.records)


def test_raise_alert_dm_failure_does_not_block_issue_layer(config_with_recipient, tmp_path):
    script = tmp_path / "post-merge-alert.sh"
    issue_calls = []

    def selective_run(argv, **kwargs):
        if str(script) in argv:
            issue_calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, "", "")
        raise RuntimeError("signal-cli send blew up")

    outcome = raise_alert(
        config_with_recipient,
        "ERROR: no + today",
        issue_extra_env={},
        script_path=script,
        run=selective_run,
    )
    assert outcome.dm_sent is False
    assert outcome.issue_called is True
    assert len(issue_calls) == 1


def test_raise_alert_issue_failure_does_not_block_dm_layer(config_with_recipient, tmp_path):
    script = tmp_path / "post-merge-alert.sh"
    dm_calls = []

    def selective_run(argv, **kwargs):
        if str(script) in argv:
            raise RuntimeError("post-merge-alert.sh blew up")
        dm_calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, "", "")

    outcome = raise_alert(
        config_with_recipient,
        "ERROR: no + today",
        issue_extra_env={},
        script_path=script,
        run=selective_run,
    )
    assert outcome.dm_sent is True
    assert outcome.issue_called is False
    assert len(dm_calls) == 1


def test_raise_alert_without_recipient_still_logs_and_calls_issue(config_without_recipient, tmp_path):
    script = tmp_path / "post-merge-alert.sh"

    def fake_run(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 0, "", "")

    outcome = raise_alert(
        config_without_recipient, "ERROR: no + today", issue_extra_env={}, script_path=script, run=fake_run
    )
    assert outcome.logged is True
    assert outcome.dm_sent is False
    assert outcome.issue_called is True
