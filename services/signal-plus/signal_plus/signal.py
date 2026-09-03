"""Thin subprocess wrapper around the signal-cli binary: receive / send / groups.

Requirement 4: "Перед отправкой — signal-cli receive (иначе связанное устройство
протухает)." Requirement 7's ``--groups`` mode lists groups with id.

CLI shape verified against AsamK/signal-cli source (tag ``v0.14.7``, commit
``b01b6b370dc063599a1a2b9fde0f5ff4e2d78fe8``, repo ``AsamK/signal-cli``):
  - command names — ``src/main/java/org/asamk/signal/commands/SendCommand.java``
    line 42 (``return "send";``), ``ReceiveCommand.java`` line 39
    (``return "receive";``), ``ListGroupsCommand.java`` line 31
    (``return "listGroups";``).
  - send flags — ``SendCommand.java`` line 49
    (``addArgument("-g", "--group-id", "--group")``) and line 57
    (``addArgument("-m", "--message")``).

Every call goes through an injectable ``run`` parameter (default
``subprocess.run``, always overridden in tests — AC6), and always passes an
explicit argv list, never ``shell=True``.
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass

from signal_plus.config import Config

DEFAULT_TIMEOUT_SECONDS = 60.0


@dataclass(frozen=True)
class SignalResult:
    ok: bool
    returncode: int
    stdout: str
    stderr: str

    @property
    def output(self) -> str:
        """Combined stdout+stderr, used for substring-matching error messages
        (e.g. the outdated-client detector in :mod:`signal_plus.updater`)."""
        return f"{self.stdout}\n{self.stderr}"


def _run_signal_cli(
    config: Config,
    args: list[str],
    *,
    run=subprocess.run,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> SignalResult:
    argv = [str(config.signal_cli_bin), "-a", config.signal_account, *args]
    completed = run(argv, capture_output=True, text=True, timeout=timeout)
    return SignalResult(
        ok=completed.returncode == 0,
        returncode=completed.returncode,
        stdout=completed.stdout or "",
        stderr=completed.stderr or "",
    )


def receive(
    config: Config, *, run=subprocess.run, timeout: float = DEFAULT_TIMEOUT_SECONDS
) -> SignalResult:
    """``signal-cli -a <account> receive`` — requirement 4, before every send."""
    return _run_signal_cli(config, ["receive"], run=run, timeout=timeout)


def send_group_message(
    config: Config,
    message: str,
    *,
    run=subprocess.run,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> SignalResult:
    """``signal-cli -a <account> send -g <group_id> -m <message>``."""
    return _run_signal_cli(
        config, ["send", "-g", config.signal_group_id, "-m", message], run=run, timeout=timeout
    )


def send_direct_message(
    config: Config,
    recipient: str,
    message: str,
    *,
    run=subprocess.run,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> SignalResult:
    """``signal-cli -a <account> send <recipient> -m <message>``.

    Used for the personal alert DM to ``SIGNAL_ALERT_RECIPIENT`` (requirement 10,
    alert layer 2).
    """
    return _run_signal_cli(config, ["send", recipient, "-m", message], run=run, timeout=timeout)


def list_groups(
    config: Config, *, run=subprocess.run, timeout: float = DEFAULT_TIMEOUT_SECONDS
) -> SignalResult:
    """``signal-cli -a <account> listGroups`` — requirement 7's ``--groups`` mode."""
    return _run_signal_cli(config, ["listGroups"], run=run, timeout=timeout)
