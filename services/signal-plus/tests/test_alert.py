"""Tests for signal_plus.alert — three independent alert layers.

Requirement 10 (verbatim): "Алерт — три слоя, каждый независим: ERROR в лог;
личное сообщение владельцу через signal-cli send на SIGNAL_ALERT_RECIPIENT
(если задан); issue через существующий scripts/devops/post-merge-alert.sh с
новым KIND=signal-plus — сам скрипт не правь (зона DevOps, шаг 4)."
"""
from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path

import pytest

from signal_plus.alert import (
    RESEND_API_URL,
    log_error,
    notify_stale_pin,
    raise_alert,
    raise_handover_alert,
    send_github_issue_alert,
    send_handover_email,
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
def config_with_email(tmp_path) -> Config:
    return Config(
        signal_account="+380501234567",
        signal_group_id="group.abc123==",
        signal_cli_bin=tmp_path / "signal-cli",
        state_file=tmp_path / "state.json",
        signal_alert_recipient="+380509998877",
        resend_api_key="re_test_key",
        alert_email_to="owner@example.com",
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


def test_send_github_issue_alert_does_not_leak_the_whole_process_environment(tmp_path, monkeypatch):
    # SR-L-5 (security review 5105061153): call_env was previously
    # `{**os.environ, **extra_env, "KIND": ...}` -- this container's own
    # environment carries secrets (RESEND_API_KEY, SIGNAL_ACCOUNT, ...) the
    # alert script has no use for and never asked for. Only an explicit
    # allow-list (PATH -- needed to exec `gh`/anything the script calls) is
    # passed through from this process's own environment.
    monkeypatch.setenv("RESEND_API_KEY", "re_should_not_leak_12345")
    monkeypatch.setenv("SIGNAL_ACCOUNT", "+380501234567")

    script = tmp_path / "post-merge-alert.sh"
    captured_env = {}

    def fake_run(argv, **kwargs):
        captured_env.update(kwargs.get("env") or {})
        return subprocess.CompletedProcess(argv, 0, "", "")

    send_github_issue_alert({"RESULT": "failure"}, script_path=script, run=fake_run)

    assert "RESEND_API_KEY" not in captured_env
    assert "SIGNAL_ACCOUNT" not in captured_env
    assert captured_env["RESULT"] == "failure"
    assert captured_env["KIND"] == "signal-plus"


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


# ---------------------------------------------------------------------------
# notify_stale_pin — requirement 8's "успешное обновление -> INFO + алерт
# (не ERROR)" -- deliberately NOT the 3-layer ERROR alert.
# ---------------------------------------------------------------------------


def test_notify_stale_pin_logs_at_info_not_error(config_with_recipient, caplog):
    def fake_run(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 0, "", "")

    with caplog.at_level(logging.INFO, logger="signal_plus"):
        notify_stale_pin(config_with_recipient, "0.14.6", "0.14.7", run=fake_run)

    assert not any(r.levelno == logging.ERROR for r in caplog.records)
    info_records = [r for r in caplog.records if r.levelno == logging.INFO]
    assert any("0.14.6" in r.message and "0.14.7" in r.message for r in info_records)


def test_notify_stale_pin_sends_personal_dm_when_recipient_configured(config_with_recipient):
    calls = []

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, "", "")

    notify_stale_pin(config_with_recipient, "0.14.6", "0.14.7", run=fake_run)
    assert len(calls) == 1
    assert "+380509998877" in calls[0]


def test_notify_stale_pin_noops_dm_without_recipient(config_without_recipient):
    # A raising fake would have its exception silently caught by
    # notify_stale_pin's own try/except around send_personal_alert, masking
    # a removed guard instead of catching it (the same masking found and
    # fixed for send_handover_email's no-op tests above) -- track calls
    # instead of raising.
    #
    # Verified by mutation: removing notify_stale_pin's OWN guard does not
    # turn this test red, because send_personal_alert has the identical
    # `signal_alert_recipient` check inside itself (defense in depth, same
    # class of finding as the once-per-day update guard existing at both
    # cli.py and updater.py). The call-tracking assertion below is still the
    # right test -- it verifies the actual contract (zero signal-cli calls
    # when no recipient is configured) rather than which of the two layers
    # provides it; send_personal_alert's own guard is covered directly by
    # test_send_personal_alert_noops_when_recipient_not_configured.
    calls = []

    def tracking_run(argv, **kwargs):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, "", "")

    notify_stale_pin(config_without_recipient, "0.14.6", "0.14.7", run=tracking_run)
    assert calls == []


def test_notify_stale_pin_dm_failure_does_not_raise(config_with_recipient):
    def raising_run(argv, **kwargs):
        raise RuntimeError("signal-cli exploded")

    notify_stale_pin(config_with_recipient, "0.14.6", "0.14.7", run=raising_run)  # must not propagate


# ---------------------------------------------------------------------------
# send_handover_email — requirement 9's rewritten handover-to-human email,
# sent directly to the Resend HTTP API (stdlib urllib, no SDK), never a real
# network call in tests (AC6) -- http_post is always injected.
# ---------------------------------------------------------------------------


def test_send_handover_email_posts_to_resend_with_auth_header(config_with_email):
    captured = {}

    def fake_http_post(url, *, headers, body):
        captured["url"] = url
        captured["headers"] = headers
        captured["body"] = body
        return 200, b'{"id":"abc"}'

    sent = send_handover_email(config_with_email, "connection refused", http_post=fake_http_post)

    assert sent is True
    assert captured["url"] == RESEND_API_URL
    assert captured["headers"]["Authorization"] == "Bearer re_test_key"


def test_send_handover_email_body_carries_reason_and_recipient(config_with_email):
    captured = {}

    def fake_http_post(url, *, headers, body):
        captured["body"] = body
        return 200, b"{}"

    send_handover_email(config_with_email, "connection refused", http_post=fake_http_post)

    payload = json.loads(captured["body"])
    assert payload["to"] == ["owner@example.com"]
    assert payload["from"] == "site@cheekycheese.tech"
    assert "connection refused" in payload["text"]
    assert "08:00" in payload["text"]
    # Project transactional-email convention: no thanks/framing, one thought.
    assert "спасибо" not in payload["text"].lower()


def test_send_handover_email_noops_without_resend_api_key(tmp_path):
    config = Config(
        signal_account="+380501234567",
        signal_group_id="group.abc123==",
        signal_cli_bin=tmp_path / "signal-cli",
        state_file=tmp_path / "state.json",
        alert_email_to="owner@example.com",
        resend_api_key=None,
    )
    calls = []

    def tracking_http_post(url, *, headers, body):
        calls.append(url)
        return 200, b"{}"

    result = send_handover_email(config, "reason", http_post=tracking_http_post)
    # A call-tracking fake (not a raising one): send_handover_email wraps
    # http_post in a broad try/except, so a fake that raises to signal "you
    # weren't supposed to call me" would have its exception silently caught
    # and turned into the SAME `False` result the correct no-op path
    # produces -- masking a removed guard instead of catching it. Asserting
    # on `calls` observes the guard directly.
    assert calls == []
    assert result is False


def test_send_handover_email_noops_without_alert_email_to(tmp_path):
    config = Config(
        signal_account="+380501234567",
        signal_group_id="group.abc123==",
        signal_cli_bin=tmp_path / "signal-cli",
        state_file=tmp_path / "state.json",
        resend_api_key="re_test_key",
        alert_email_to=None,
    )
    calls = []

    def tracking_http_post(url, *, headers, body):
        calls.append(url)
        return 200, b"{}"

    result = send_handover_email(config, "reason", http_post=tracking_http_post)
    assert calls == []
    assert result is False


def test_send_handover_email_false_on_non_2xx_status(config_with_email):
    def fake_http_post(url, *, headers, body):
        return 401, b'{"message":"invalid API key"}'

    assert send_handover_email(config_with_email, "reason", http_post=fake_http_post) is False


def test_send_handover_email_false_on_http_post_exception(config_with_email):
    def raising_http_post(url, *, headers, body):
        raise OSError("network unreachable")

    assert send_handover_email(config_with_email, "reason", http_post=raising_http_post) is False


# ---------------------------------------------------------------------------
# raise_handover_alert — requirement 9's four independent layers at the
# handover moment: the three from requirement 10 (log/DM/issue) PLUS the
# handover email. "Resend вернул ошибку -> ERROR, остальные слои алерта
# (п. 10) всё равно срабатывают."
# ---------------------------------------------------------------------------


def test_raise_handover_alert_fires_all_four_layers(config_with_email, tmp_path, caplog):
    script = tmp_path / "post-merge-alert.sh"
    dm_calls = []
    issue_calls = []

    def fake_run(argv, **kwargs):
        if str(script) in argv:
            issue_calls.append(argv)
        else:
            dm_calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, "", "")

    def fake_http_post(url, *, headers, body):
        return 200, b"{}"

    with caplog.at_level(logging.ERROR, logger="signal_plus"):
        outcome = raise_handover_alert(
            config_with_email,
            "ERROR: handover",
            "connection refused",
            issue_extra_env={},
            script_path=script,
            run=fake_run,
            http_post=fake_http_post,
        )

    assert outcome.logged is True
    assert outcome.dm_sent is True
    assert outcome.issue_called is True
    assert outcome.email_sent is True
    assert len(dm_calls) == 1
    assert len(issue_calls) == 1


def test_raise_handover_alert_resend_failure_does_not_block_other_layers(config_with_email, tmp_path):
    script = tmp_path / "post-merge-alert.sh"

    def fake_run(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 0, "", "")

    def raising_http_post(url, *, headers, body):
        raise OSError("Resend unreachable")

    outcome = raise_handover_alert(
        config_with_email,
        "ERROR: handover",
        "connection refused",
        issue_extra_env={},
        script_path=script,
        run=fake_run,
        http_post=raising_http_post,
    )
    assert outcome.email_sent is False
    assert outcome.dm_sent is True
    assert outcome.issue_called is True


def test_raise_handover_alert_other_layer_failure_does_not_block_email(config_with_email, tmp_path):
    script = tmp_path / "post-merge-alert.sh"

    def raising_run(argv, **kwargs):
        raise RuntimeError("signal-cli/script exploded")

    def fake_http_post(url, *, headers, body):
        return 200, b"{}"

    outcome = raise_handover_alert(
        config_with_email,
        "ERROR: handover",
        "connection refused",
        issue_extra_env={},
        script_path=script,
        run=raising_run,
        http_post=fake_http_post,
    )
    assert outcome.email_sent is True
    assert outcome.dm_sent is False
    assert outcome.issue_called is False
