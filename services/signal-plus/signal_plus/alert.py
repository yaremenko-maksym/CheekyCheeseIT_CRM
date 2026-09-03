"""Three independent alert layers — requirement 10.

Verbatim: "Алерт — три слоя, каждый независим: ERROR в лог; личное сообщение
владельцу через signal-cli send на SIGNAL_ALERT_RECIPIENT (если задан); issue
через существующий scripts/devops/post-merge-alert.sh с новым KIND=signal-plus
— сам скрипт не правь (зона DevOps, шаг 4): просто вызови его как есть с
KIND=signal-plus и опиши в README, что в шаге 4 DevOps добавит этот вид."

"Каждый независим": :func:`raise_alert` wraps layers 2 and 3 individually so
one layer raising never prevents the others from running. Layer 1 (the log
call itself) cannot meaningfully fail in a way that should stop the others.

The GitHub-issue layer deliberately does NOT choose values for
``post-merge-alert.sh``'s required env (``ALERT_REPO``, ``GH_TOKEN``,
``RESULT``, ``COMMIT_SHA``, ``RUN_URL``) — a scheduled roll-call has no CI
run or commit to draw them from the way the script's other callers
(ci.yml/deploy-alert.yml/deploy.yml/mutation-nightly.yml) do. Per the task,
that wiring is step 4 (DevOps); this module only shapes the call
(``KIND=signal-plus`` always set, everything else passed through from the
caller) — see README.md's "Шаг 4" section.
"""
from __future__ import annotations

import logging
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

from signal_plus import signal as signal_cli
from signal_plus.config import Config

logger = logging.getLogger("signal_plus")

# Matches the documented server layout ("Docker Compose, /opt/crm" — see the
# task's "Проверенные факты" section). Only a default: step 4 (DevOps)
# decides how/whether this path is reachable from the signal-plus container
# (bind mount, copy, or something else) and can override it at the call site.
DEFAULT_POST_MERGE_ALERT_SCRIPT = Path("/opt/crm/scripts/devops/post-merge-alert.sh")


def log_error(message: str) -> None:
    """Layer 1: always logged, regardless of what the other two layers do."""
    logger.error(message)


def send_personal_alert(config: Config, message: str, *, run=subprocess.run) -> bool:
    """Layer 2: DM to ``SIGNAL_ALERT_RECIPIENT`` via ``signal-cli send``, if configured."""
    if not config.signal_alert_recipient:
        return False
    result = signal_cli.send_direct_message(config, config.signal_alert_recipient, message, run=run)
    if not result.ok:
        logger.error("failed to send personal alert DM: %s", result.output.strip())
    return result.ok


def send_github_issue_alert(
    extra_env: dict[str, str],
    *,
    script_path: Path = DEFAULT_POST_MERGE_ALERT_SCRIPT,
    run=subprocess.run,
) -> bool:
    """Layer 3: invoke ``post-merge-alert.sh`` with ``KIND=signal-plus``, as-is.

    ``extra_env`` supplies the script's other env vars (see module
    docstring); ``KIND`` from ``extra_env`` is always overridden to
    ``"signal-plus"`` so a caller cannot accidentally alert under a
    different KIND's issue thread.
    """
    call_env = {**os.environ, **extra_env, "KIND": "signal-plus"}
    try:
        completed = run([str(script_path)], env=call_env, capture_output=True, text=True, timeout=30)
    except OSError as exc:
        logger.error("could not invoke %s: %s", script_path, exc)
        return False
    if completed.returncode != 0:
        logger.error(
            "post-merge-alert.sh KIND=signal-plus exited %s: %s",
            completed.returncode,
            (completed.stderr or "").strip(),
        )
    return completed.returncode == 0


@dataclass(frozen=True)
class AlertOutcome:
    logged: bool
    dm_sent: bool
    issue_called: bool


def raise_alert(
    config: Config,
    message: str,
    *,
    issue_extra_env: dict[str, str] | None = None,
    script_path: Path = DEFAULT_POST_MERGE_ALERT_SCRIPT,
    run=subprocess.run,
) -> AlertOutcome:
    """Fire all three layers. Each is independent: an exception in one layer
    is caught and logged, never prevents the remaining layers from running.
    """
    log_error(message)

    dm_sent = False
    try:
        dm_sent = send_personal_alert(config, message, run=run)
    except Exception:
        logger.exception("personal alert DM layer raised unexpectedly")

    issue_called = False
    try:
        issue_called = send_github_issue_alert(issue_extra_env or {}, script_path=script_path, run=run)
    except Exception:
        logger.exception("GitHub issue alert layer raised unexpectedly")

    return AlertOutcome(logged=True, dm_sent=dm_sent, issue_called=issue_called)
