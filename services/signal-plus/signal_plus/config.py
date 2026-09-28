"""Environment-driven configuration for signal-plus.

Per the task's requirement 1 ("Конфиг только через env"): every setting comes from
an environment variable, nothing is hardcoded, and no secret is ever embedded in
source. ``Config.from_env`` is the single place that reads ``os.environ`` — every
other module receives an already-built :class:`Config` instance and never touches
``os.environ`` itself, which is what makes the rest of the package testable without
monkeypatching the environment.

Fields: the four required base settings (``SIGNAL_ACCOUNT``, ``SIGNAL_GROUP_ID``,
``SIGNAL_CLI_BIN``, ``STATE_FILE``); the auto-update settings (``SIGNAL_DATA_DIR``,
``SIGNAL_CLI_GPG_FINGERPRINT``); and the alerting settings (``SIGNAL_ALERT_RECIPIENT``,
``HANDOVER_TIME``, ``RESEND_API_KEY``, ``ALERT_EMAIL_FROM``, ``ALERT_EMAIL_TO`` —
requirement 9, rewritten in full in the task file 2026-09-03: the owner's decision
to send a handover email via Resend when the window is missed past
``HANDOVER_TIME``, quoted verbatim there).

A mid-task chat message had earlier proposed this same email addition; it was
reverted on suspicion because the channel it arrived through was separately
caught asserting a false claim about this repo's on-disk state. The
requirement was then written into the task file itself (the pre-existing,
designed, zone-of-write-governed channel for this), with the owner's decision
quoted verbatim, plus an independently-verifiable GPG source — see the final
report for the full trail and the independent verification performed before
re-implementing this.
"""
from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from datetime import time
from pathlib import Path

from signal_plus import slot


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


def _parse_skip_weekdays(raw: str | None, *, env_name: str = "SIGNAL_SKIP_WEEKDAYS") -> frozenset[int]:
    """task-signal-plus-sunday-skip.md requirement 3 / AC5: comma-separated
    ISO weekday numbers (Monday=1 ... Sunday=7), default
    :data:`slot.SKIP_ISO_WEEKDAYS` (Sunday only) when unset/blank. Rejects
    out-of-range numbers, non-numeric entries, and duplicates -- all with a
    message naming the variable, matching :func:`_parse_time`'s convention.
    """
    if not raw:
        return slot.SKIP_ISO_WEEKDAYS
    seen: list[int] = []
    for token in raw.split(","):
        token = token.strip()
        if not token:
            raise ConfigError(f"{env_name}={raw!r} contains an empty weekday entry")
        try:
            value = int(token)
        except ValueError as exc:
            raise ConfigError(
                f"{env_name}={raw!r} must be comma-separated ISO weekday numbers (1-7)"
            ) from exc
        if not 1 <= value <= 7:
            raise ConfigError(f"{env_name}={raw!r}: {value} is not a valid ISO weekday (1-7)")
        if value in seen:
            raise ConfigError(f"{env_name}={raw!r}: duplicate weekday {value}")
        seen.append(value)
    return frozenset(seen)


DEFAULT_HANDOVER_TIME = time(8, 0)
DEFAULT_ALERT_EMAIL_FROM = "site@cheekycheese.tech"
# SR-H-4 (PR #650 security review round 3, id 5108694371): matches the
# Dockerfile's ENV SIGNAL_TMPDIR default and docker-entrypoint.sh's mkdir --
# see signal_plus/signal.py's _run_signal_cli for what this value is
# actually used for (a -Djava.io.tmpdir=<value> argv flag, not an env var
# the binary reads on its own).
DEFAULT_SIGNAL_TMPDIR = Path("/data/tmp")


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
    signal_tmpdir: Path = DEFAULT_SIGNAL_TMPDIR
    skip_weekdays: frozenset[int] = slot.SKIP_ISO_WEEKDAYS

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
        signal_tmpdir_raw = optional("SIGNAL_TMPDIR")
        skip_weekdays_raw = optional("SIGNAL_SKIP_WEEKDAYS")

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
            signal_tmpdir=Path(signal_tmpdir_raw) if signal_tmpdir_raw else DEFAULT_SIGNAL_TMPDIR,
            skip_weekdays=_parse_skip_weekdays(skip_weekdays_raw),
        )


def _parse_accounts(raw: str, *, env_name: str = "SIGNAL_ACCOUNTS") -> list[str]:
    """Parse the comma-separated ``SIGNAL_ACCOUNTS`` list (multi-account mode,
    2026-09-28). Mirrors :func:`_parse_skip_weekdays`' validation style:
    rejects blank entries and duplicates, with a message naming the variable.

    A duplicate account is rejected rather than silently deduplicated because
    two identical numbers would resolve to the same per-account state file and
    make the daemon send that account's "+" twice — exactly what the
    idempotency state exists to prevent. Order is preserved (the list is the
    daily processing seed, and a stable order keeps logs readable).
    """
    accounts: list[str] = []
    for token in raw.split(","):
        token = token.strip()
        if not token:
            raise ConfigError(f"{env_name}={raw!r} contains an empty account entry")
        if token in accounts:
            raise ConfigError(f"{env_name}={raw!r}: duplicate account {mask_secret(token)}")
        accounts.append(token)
    return accounts


def _per_account_state_file(base: Path, account: str) -> Path:
    """Derive one account's state file from the shared ``STATE_FILE`` base.

    ``/data/signal-plus/state.json`` + ``+380...`` ->
    ``/data/signal-plus/state-<sha256(account)[:12]>.json``. A stable hash of
    the number, never the number itself: the account is a secret masked
    everywhere in logs (:func:`mask_secret`), so it must not leak into a
    filename on disk either. The 12-hex-char prefix is collision-safe for the
    handful of accounts one container serves.
    """
    slug = hashlib.sha256(account.encode("utf-8")).hexdigest()[:12]
    return base.parent / f"{base.stem}-{slug}{base.suffix}"


def resolve_configs(env: dict[str, str] | None = None) -> list[Config]:
    """Build the list of per-account :class:`Config`s the daemon serves.

    Multi-account mode (2026-09-28): every hardened module
    (:mod:`signal_plus.signal`/:mod:`~signal_plus.updater`/
    :mod:`~signal_plus.alert`/:mod:`~signal_plus.slot`/:mod:`~signal_plus.state`)
    is already per-``Config`` — it drives ``signal-cli -a
    <config.signal_account>`` and reads/writes ``config.state_file``. So
    "several accounts" is just "several ``Config``s", built here without
    changing the shape of ``Config`` or touching those modules.

    - ``SIGNAL_ACCOUNTS`` unset/blank -> ``[Config.from_env(env)]``: the
      pre-existing single-account behaviour, byte-for-byte unchanged (the whole
      existing deploy and test suite exercise exactly this path).
    - ``SIGNAL_ACCOUNTS`` set -> one ``Config`` per number, each built by
      reusing :meth:`Config.from_env` on a per-account view of the env with
      ``SIGNAL_ACCOUNT`` set to that number and ``STATE_FILE`` set to its
      derived path. Reusing ``from_env`` (rather than constructing ``Config``
      directly) means every shared setting — group, cli bin, handover,
      skip-weekdays, tmpdir, auto-update, alerting — is parsed and validated
      exactly once, the same way, for all accounts.
    """
    source = os.environ if env is None else env
    accounts_raw = source.get("SIGNAL_ACCOUNTS", "").strip()
    if not accounts_raw:
        return [Config.from_env(source)]

    accounts = _parse_accounts(accounts_raw)

    base_state_raw = source.get("STATE_FILE", "").strip()
    if not base_state_raw:
        raise ConfigError("STATE_FILE is required and must not be empty")
    base_state = Path(base_state_raw)

    configs: list[Config] = []
    for account in accounts:
        per_account_env = dict(source)
        per_account_env["SIGNAL_ACCOUNT"] = account
        per_account_env["STATE_FILE"] = str(_per_account_state_file(base_state, account))
        configs.append(Config.from_env(per_account_env))
    return configs


def config_for_account(account: str, env: dict[str, str] | None = None) -> Config:
    """Build one :class:`Config` for a specific ``account``, using the shared
    env for everything else — regardless of whether that account is listed in
    ``SIGNAL_ACCOUNTS``.

    Used by ``signal-plus --test <account>`` (2026-09-28): the test send is run
    against a **freshly-linked** account that is deliberately **not** in the
    live ``SIGNAL_ACCOUNTS`` list yet (the whole point is to verify it before
    adding it to the roll-call), so it cannot come from :func:`resolve_configs`.
    ``STATE_FILE`` is still required by :meth:`Config.from_env` but the test
    send is stateless and never reads or writes it.
    """
    source = os.environ if env is None else env
    per_account_env = dict(source)
    per_account_env["SIGNAL_ACCOUNT"] = account
    return Config.from_env(per_account_env)
