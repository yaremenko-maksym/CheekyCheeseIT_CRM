"""Tests for signal_plus.config — env-driven configuration."""
from __future__ import annotations

import hashlib
from datetime import time
from pathlib import Path

import pytest

from signal_plus.config import Config, ConfigError, config_for_account, resolve_configs

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
    assert cfg.resend_api_key is None
    assert cfg.alert_email_to is None


def test_handover_time_defaults_to_0800():
    # Requirement 9 (task file, rewritten 2026-09-03): "Время передачи — env
    # HANDOVER_TIME, default 08:00."
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
    # Requirement 9: default site@cheekycheese.tech (= CONTACT_FROM_EMAIL at
    # the API, domain already verified in Resend).
    cfg = Config.from_env(dict(REQUIRED_ENV))
    assert cfg.alert_email_from == "site@cheekycheese.tech"


def test_alert_email_from_overridable():
    env = dict(REQUIRED_ENV, ALERT_EMAIL_FROM="ops@example.com")
    cfg = Config.from_env(env)
    assert cfg.alert_email_from == "ops@example.com"


def test_resend_api_key_optional_passthrough():
    env = dict(REQUIRED_ENV, RESEND_API_KEY="re_test_123")
    cfg = Config.from_env(env)
    assert cfg.resend_api_key == "re_test_123"


def test_alert_email_to_optional_passthrough():
    env = dict(REQUIRED_ENV, ALERT_EMAIL_TO="owner@example.com")
    cfg = Config.from_env(env)
    assert cfg.alert_email_to == "owner@example.com"


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


# ---------------------------------------------------------------------------
# SIGNAL_SKIP_WEEKDAYS (task-signal-plus-sunday-skip.md requirement 3, AC5):
# optional, comma-separated ISO weekday numbers (Monday=1 ... Sunday=7),
# default {7} (Sunday only). Validation: 1-7, no duplicates; garbage ->
# ConfigError naming the variable.
# ---------------------------------------------------------------------------


def test_skip_weekdays_defaults_to_sunday_only_when_unset():
    cfg = Config.from_env(dict(REQUIRED_ENV))
    assert cfg.skip_weekdays == frozenset({7})


def test_skip_weekdays_defaults_to_sunday_only_when_blank():
    env = dict(REQUIRED_ENV, SIGNAL_SKIP_WEEKDAYS="")
    cfg = Config.from_env(env)
    assert cfg.skip_weekdays == frozenset({7})


def test_skip_weekdays_parses_comma_separated_list():
    env = dict(REQUIRED_ENV, SIGNAL_SKIP_WEEKDAYS="6,7")
    cfg = Config.from_env(env)
    assert cfg.skip_weekdays == frozenset({6, 7})


def test_skip_weekdays_tolerates_surrounding_whitespace():
    env = dict(REQUIRED_ENV, SIGNAL_SKIP_WEEKDAYS=" 6 , 7 ")
    cfg = Config.from_env(env)
    assert cfg.skip_weekdays == frozenset({6, 7})


def test_skip_weekdays_single_value():
    env = dict(REQUIRED_ENV, SIGNAL_SKIP_WEEKDAYS="7")
    cfg = Config.from_env(env)
    assert cfg.skip_weekdays == frozenset({7})


@pytest.mark.parametrize("bad_value", ["0", "8", "a", "7,7", "7,", ",7", "7, a"])
def test_skip_weekdays_rejects_invalid_values(bad_value):
    env = dict(REQUIRED_ENV, SIGNAL_SKIP_WEEKDAYS=bad_value)
    with pytest.raises(ConfigError) as exc_info:
        Config.from_env(env)
    assert "SIGNAL_SKIP_WEEKDAYS" in str(exc_info.value)


# ---------------------------------------------------------------------------
# resolve_configs (multi-account, 2026-09-28): SIGNAL_ACCOUNTS is a
# comma-separated list of E.164 numbers served by one container. Everything
# else (group, cli bin, alerting, handover, skip-weekdays, tmpdir, auto-update)
# is shared. Each account gets its own derived state file. Absent/blank
# SIGNAL_ACCOUNTS -> exactly the pre-existing single-account behaviour.
# ---------------------------------------------------------------------------

MULTI_ENV = {
    "SIGNAL_ACCOUNTS": "+380501112233,+380509998877",
    "SIGNAL_GROUP_ID": "group.abc123==",
    "SIGNAL_CLI_BIN": "/opt/signal-cli/bin/signal-cli",
    "STATE_FILE": "/data/signal-plus/state.json",
}


def _expected_state_file(base: str, number: str) -> Path:
    base_path = Path(base)
    slug = hashlib.sha256(number.encode("utf-8")).hexdigest()[:12]
    return base_path.parent / f"{base_path.stem}-{slug}{base_path.suffix}"


def test_resolve_configs_single_when_accounts_unset_matches_from_env():
    got = resolve_configs(dict(REQUIRED_ENV))
    assert len(got) == 1
    assert got[0] == Config.from_env(dict(REQUIRED_ENV))


def test_resolve_configs_single_when_accounts_blank():
    env = dict(REQUIRED_ENV, SIGNAL_ACCOUNTS="   ")
    got = resolve_configs(env)
    assert len(got) == 1
    assert got[0].signal_account == REQUIRED_ENV["SIGNAL_ACCOUNT"]


def test_resolve_configs_builds_one_config_per_account():
    got = resolve_configs(dict(MULTI_ENV))
    assert [c.signal_account for c in got] == ["+380501112233", "+380509998877"]


def test_resolve_configs_shares_group_across_all_accounts():
    got = resolve_configs(dict(MULTI_ENV))
    assert {c.signal_group_id for c in got} == {"group.abc123=="}


def test_resolve_configs_derives_distinct_state_file_per_account():
    got = resolve_configs(dict(MULTI_ENV))
    assert got[0].state_file == _expected_state_file(MULTI_ENV["STATE_FILE"], "+380501112233")
    assert got[1].state_file == _expected_state_file(MULTI_ENV["STATE_FILE"], "+380509998877")
    assert got[0].state_file != got[1].state_file


def test_resolve_configs_state_file_slug_never_contains_the_raw_number():
    got = resolve_configs(dict(MULTI_ENV))
    for cfg in got:
        assert cfg.signal_account not in str(cfg.state_file)


def test_resolve_configs_does_not_require_single_signal_account_in_multi_mode():
    env = dict(MULTI_ENV)  # no SIGNAL_ACCOUNT key at all
    got = resolve_configs(env)
    assert len(got) == 2


def test_resolve_configs_tolerates_surrounding_whitespace_between_accounts():
    env = dict(MULTI_ENV, SIGNAL_ACCOUNTS=" +380501112233 , +380509998877 ")
    got = resolve_configs(env)
    assert [c.signal_account for c in got] == ["+380501112233", "+380509998877"]


def test_resolve_configs_single_account_list_is_allowed():
    env = dict(MULTI_ENV, SIGNAL_ACCOUNTS="+380501112233")
    got = resolve_configs(env)
    assert len(got) == 1
    assert got[0].signal_account == "+380501112233"


def test_resolve_configs_propagates_shared_optional_settings():
    env = dict(
        MULTI_ENV,
        HANDOVER_TIME="08:30",
        SIGNAL_SKIP_WEEKDAYS="6,7",
        ALERT_EMAIL_TO="owner@example.com",
        SIGNAL_ALERT_RECIPIENT="+380500000000",
    )
    got = resolve_configs(env)
    assert all(c.handover_time == time(8, 30) for c in got)
    assert all(c.skip_weekdays == frozenset({6, 7}) for c in got)
    assert all(c.alert_email_to == "owner@example.com" for c in got)
    assert all(c.signal_alert_recipient == "+380500000000" for c in got)


def test_resolve_configs_rejects_blank_account_entry():
    env = dict(MULTI_ENV, SIGNAL_ACCOUNTS="+380501112233,,+380509998877")
    with pytest.raises(ConfigError) as exc_info:
        resolve_configs(env)
    assert "SIGNAL_ACCOUNTS" in str(exc_info.value)


def test_resolve_configs_rejects_duplicate_account():
    env = dict(MULTI_ENV, SIGNAL_ACCOUNTS="+380501112233,+380501112233")
    with pytest.raises(ConfigError) as exc_info:
        resolve_configs(env)
    assert "SIGNAL_ACCOUNTS" in str(exc_info.value)


def test_resolve_configs_requires_state_file_in_multi_mode():
    env = dict(MULTI_ENV)
    del env["STATE_FILE"]
    with pytest.raises(ConfigError):
        resolve_configs(env)


def test_resolve_configs_requires_group_in_multi_mode():
    env = dict(MULTI_ENV)
    del env["SIGNAL_GROUP_ID"]
    with pytest.raises(ConfigError):
        resolve_configs(env)


def test_resolve_configs_defaults_to_os_environ(monkeypatch):
    for key, value in MULTI_ENV.items():
        monkeypatch.setenv(key, value)
    got = resolve_configs()
    assert [c.signal_account for c in got] == ["+380501112233", "+380509998877"]


def test_config_for_account_uses_given_account_ignoring_accounts_list():
    # --test targets a freshly-linked account that is deliberately NOT in
    # SIGNAL_ACCOUNTS yet; config_for_account must still build a valid Config
    # for it from the shared env.
    env = dict(MULTI_ENV)  # SIGNAL_ACCOUNTS lists two OTHER numbers
    cfg = config_for_account("+380500000000", env)
    assert cfg.signal_account == "+380500000000"
    assert cfg.signal_group_id == "group.abc123=="


def test_config_for_account_works_without_signal_accounts_set():
    env = dict(REQUIRED_ENV)  # plain single-account env, no SIGNAL_ACCOUNTS
    cfg = config_for_account("+380500000000", env)
    assert cfg.signal_account == "+380500000000"
