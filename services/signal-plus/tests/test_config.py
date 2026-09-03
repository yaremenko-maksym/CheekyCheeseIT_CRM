"""Tests for signal_plus.config — env-driven configuration."""
from __future__ import annotations

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


def test_masked_account_hides_middle_digits():
    cfg = Config.from_env(dict(REQUIRED_ENV, SIGNAL_ACCOUNT="+380501234567"))
    masked = cfg.masked_account()
    assert masked != cfg.signal_account
    assert masked.startswith("+")
    assert masked.endswith("7")
    assert "501234" not in masked


def test_masked_account_short_value_collapses_to_stars():
    cfg = Config.from_env(dict(REQUIRED_ENV, SIGNAL_ACCOUNT="+38"))
    assert cfg.masked_account() == "***"


def test_optional_fields_default_none():
    cfg = Config.from_env(dict(REQUIRED_ENV))
    assert cfg.signal_data_dir is None
    assert cfg.signal_cli_gpg_fingerprint is None
    assert cfg.signal_alert_recipient is None


def test_signal_data_dir_parsed_as_path():
    env = dict(REQUIRED_ENV, SIGNAL_DATA_DIR="/data/signal-cli")
    cfg = Config.from_env(env)
    assert cfg.signal_data_dir == Path("/data/signal-cli")


def test_signal_cli_gpg_fingerprint_optional_passthrough():
    env = dict(REQUIRED_ENV, SIGNAL_CLI_GPG_FINGERPRINT="FA10826A74907F9EC6BBB7FC2BA2CD21B5B09570")
    cfg = Config.from_env(env)
    assert cfg.signal_cli_gpg_fingerprint == "FA10826A74907F9EC6BBB7FC2BA2CD21B5B09570"


def test_signal_alert_recipient_optional_passthrough():
    env = dict(REQUIRED_ENV, SIGNAL_ALERT_RECIPIENT="+380509998877")
    cfg = Config.from_env(env)
    assert cfg.signal_alert_recipient == "+380509998877"


def test_from_env_defaults_to_os_environ(monkeypatch):
    for key, value in REQUIRED_ENV.items():
        monkeypatch.setenv(key, value)
    cfg = Config.from_env()
    assert cfg.signal_account == REQUIRED_ENV["SIGNAL_ACCOUNT"]
