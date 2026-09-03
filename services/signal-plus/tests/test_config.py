"""Tests for signal_plus.config — env-driven configuration."""
from __future__ import annotations

from datetime import time
from pathlib import Path

import pytest

from signal_plus.config import Config, ConfigError

REQUIRED_ENV = {
    "SIGNAL_ACCOUNT": "+380501234567",
    "SIGNAL_GROUP_ID": "group.abc123==",
    "SIGNAL_CLI_BIN": "/opt/signal-cli/bin/signal-cli",
    "STATE_FILE": "/data/state.json",
}


def test_from_env_reads_required_fields():
    cfg = Config.from_env(dict(REQUIRED_ENV))
    assert cfg.signal_account == "+380501234567"
    assert cfg.signal_group_id == "group.abc123=="
    assert cfg.signal_cli_bin == Path("/opt/signal-cli/bin/signal-cli")
    assert cfg.state_file == Path("/data/state.json")


@pytest.mark.parametrize(
    "missing", ["SIGNAL_ACCOUNT", "SIGNAL_GROUP_ID", "SIGNAL_CLI_BIN", "STATE_FILE"]
)
def test_from_env_raises_on_missing_required(missing):
    env = dict(REQUIRED_ENV)
    del env[missing]
    with pytest.raises(ConfigError):
        Config.from_env(env)


@pytest.mark.parametrize(
    "missing", ["SIGNAL_ACCOUNT", "SIGNAL_GROUP_ID", "SIGNAL_CLI_BIN", "STATE_FILE"]
)
def test_from_env_raises_on_blank_required(missing):
    env = dict(REQUIRED_ENV)
    env[missing] = "   "
    with pytest.raises(ConfigError):
        Config.from_env(env)


def test_handover_time_defaults_to_0800():
    cfg = Config.from_env(dict(REQUIRED_ENV))
    assert cfg.handover_time == time(8, 0)


def test_handover_time_overridable():
    env = dict(REQUIRED_ENV, HANDOVER_TIME="08:30")
    cfg = Config.from_env(env)
    assert cfg.handover_time == time(8, 30)


def test_handover_time_rejects_bad_format():
    env = dict(REQUIRED_ENV, HANDOVER_TIME="not-a-time")
    with pytest.raises(ConfigError):
        Config.from_env(env)


def test_alert_email_from_default():
    cfg = Config.from_env(dict(REQUIRED_ENV))
    assert cfg.alert_email_from == "site@cheekycheese.tech"


def test_alert_email_from_overridable():
    env = dict(REQUIRED_ENV, ALERT_EMAIL_FROM="ops@example.com")
    cfg = Config.from_env(env)
    assert cfg.alert_email_from == "ops@example.com"


def test_masked_account_hides_middle_digits():
    cfg = Config.from_env(dict(REQUIRED_ENV, SIGNAL_ACCOUNT="+380501234567"))
    masked = cfg.masked_account()
    assert masked != cfg.signal_account
    assert masked.startswith("+")
    assert masked.endswith("7")
    assert "501234" not in masked


def test_optional_fields_default_none():
    cfg = Config.from_env(dict(REQUIRED_ENV))
    assert cfg.signal_data_dir is None
    assert cfg.signal_cli_gpg_fingerprint is None
    assert cfg.signal_alert_recipient is None
    assert cfg.resend_api_key is None
    assert cfg.alert_email_to is None


def test_signal_data_dir_parsed_as_path():
    env = dict(REQUIRED_ENV, SIGNAL_DATA_DIR="/data/signal-cli")
    cfg = Config.from_env(env)
    assert cfg.signal_data_dir == Path("/data/signal-cli")
