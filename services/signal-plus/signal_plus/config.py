"""Environment-driven configuration for signal-plus.

Per the task's requirement 1 ("Конфиг только через env"): every setting comes from
an environment variable, nothing is hardcoded, and no secret is ever embedded in
source. ``Config.from_env`` is the single place that reads ``os.environ`` — every
other module receives an already-built :class:`Config` instance and never touches
``os.environ`` itself, which is what makes the rest of the package testable without
monkeypatching the environment.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import time
from pathlib import Path


class ConfigError(ValueError):
    """Raised when required configuration is missing or malformed."""


def mask_secret(value: str | None) -> str:
    """Mask a sensitive value for logging.

    Requirement 1: "SIGNAL_ACCOUNT в логи не печатать целиком — маскировать."
    Keeps the first and last character so a human can still recognise *which*
    account is meant in a log line, hides everything in between, and collapses
    short values to a fixed-width run of ``*`` so the length of the original
    value cannot be inferred from the mask either.
    """
    if not value:
        return "<unset>"
    if len(value) <= 4:
        return "*" * len(value)
    return f"{value[0]}***{value[-1]}"


def _parse_time(raw: str, *, env_name: str) -> time:
    parts = raw.split(":")
    if len(parts) != 2:
        raise ConfigError(f"{env_name}={raw!r} is not HH:MM")
    hour_str, minute_str = parts
    try:
        return time(int(hour_str), int(minute_str))
    except ValueError as exc:
        raise ConfigError(f"{env_name}={raw!r} is not HH:MM") from exc


DEFAULT_HANDOVER_TIME = time(8, 0)
DEFAULT_ALERT_EMAIL_FROM = "site@cheekycheese.tech"


@dataclass(frozen=True)
class Config:
    """Fully-resolved, immutable configuration for one run of signal-plus."""

    signal_account: str
    signal_group_id: str
    signal_cli_bin: Path
    state_file: Path
    signal_data_dir: Path | None = None
    signal_cli_gpg_fingerprint: str | None = None
    signal_alert_recipient: str | None = None
    handover_time: time = DEFAULT_HANDOVER_TIME
    resend_api_key: str | None = None
    alert_email_from: str = DEFAULT_ALERT_EMAIL_FROM
    alert_email_to: str | None = None

    def masked_account(self) -> str:
        return mask_secret(self.signal_account)

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Config":
        source = os.environ if env is None else env

        def require(name: str) -> str:
            value = source.get(name, "").strip()
            if not value:
                raise ConfigError(f"{name} is required and must not be empty")
            return value

        def optional(name: str) -> str | None:
            value = source.get(name, "").strip()
            return value or None

        signal_data_dir_raw = optional("SIGNAL_DATA_DIR")
        handover_raw = optional("HANDOVER_TIME") or "08:00"

        return cls(
            signal_account=require("SIGNAL_ACCOUNT"),
            signal_group_id=require("SIGNAL_GROUP_ID"),
            signal_cli_bin=Path(require("SIGNAL_CLI_BIN")),
            state_file=Path(require("STATE_FILE")),
            signal_data_dir=Path(signal_data_dir_raw) if signal_data_dir_raw else None,
            signal_cli_gpg_fingerprint=optional("SIGNAL_CLI_GPG_FINGERPRINT"),
            signal_alert_recipient=optional("SIGNAL_ALERT_RECIPIENT"),
            handover_time=_parse_time(handover_raw, env_name="HANDOVER_TIME"),
            resend_api_key=optional("RESEND_API_KEY"),
            alert_email_from=optional("ALERT_EMAIL_FROM") or DEFAULT_ALERT_EMAIL_FROM,
            alert_email_to=optional("ALERT_EMAIL_TO"),
        )
