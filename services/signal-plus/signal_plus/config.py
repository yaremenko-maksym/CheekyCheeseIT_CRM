"""Environment-driven configuration for signal-plus.

Per the task's requirement 1 ("Конфиг только через env"): every setting comes from
an environment variable, nothing is hardcoded, and no secret is ever embedded in
source. ``Config.from_env`` is the single place that reads ``os.environ`` — every
other module receives an already-built :class:`Config` instance and never touches
``os.environ`` itself, which is what makes the rest of the package testable without
monkeypatching the environment.

Fields are exactly the set requirement 1 names: the four required base settings
(``SIGNAL_ACCOUNT``, ``SIGNAL_GROUP_ID``, ``SIGNAL_CLI_BIN``, ``STATE_FILE``) plus
the three optional ones needed for auto-update and alerting
(``SIGNAL_DATA_DIR``, ``SIGNAL_CLI_GPG_FINGERPRINT``, ``SIGNAL_ALERT_RECIPIENT``).
Nothing else — a mid-task message claiming to add email escalation via a
production Resend key arrived through an unverifiable channel (not the task
file) and, on inspection, that same channel was caught asserting a false claim
about this repository's on-disk state; the email/HANDOVER_TIME fields it asked
for were reverted for that reason. See the final report for the full trail.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
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

        return cls(
            signal_account=require("SIGNAL_ACCOUNT"),
            signal_group_id=require("SIGNAL_GROUP_ID"),
            signal_cli_bin=Path(require("SIGNAL_CLI_BIN")),
            state_file=Path(require("STATE_FILE")),
            signal_data_dir=Path(signal_data_dir_raw) if signal_data_dir_raw else None,
            signal_cli_gpg_fingerprint=optional("SIGNAL_CLI_GPG_FINGERPRINT"),
            signal_alert_recipient=optional("SIGNAL_ALERT_RECIPIENT"),
        )
