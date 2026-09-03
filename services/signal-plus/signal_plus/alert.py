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

import json
import logging
import os
import subprocess
import urllib.error
import urllib.request
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


# SR-L-5 (PR #650 security review, id 5105061153): the SUBPROCESS env for
# post-merge-alert.sh is an explicit allow-list, not the whole process
# environment -- this container's own env carries secrets
# (RESEND_API_KEY, SIGNAL_ACCOUNT, ...) the alert script never asked for
# and has no use for. Only what the script's own header doc actually needs
# to locate/execute itself and the `gh` binary it calls.
_SUBPROCESS_ENV_PASSTHROUGH = ("PATH", "HOME")


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
    call_env = {name: os.environ[name] for name in _SUBPROCESS_ENV_PASSTHROUGH if name in os.environ}
    call_env.update(extra_env)
    call_env["KIND"] = "signal-plus"
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


def notify_stale_pin(
    config: Config, old_version: str | None, new_version: str | None, *, run=subprocess.run
) -> None:
    """Requirement 8's last bullet: "Успешное обновление → INFO `old → new` +
    алерт «пин в образе отстал» (не ERROR)." Deliberately does NOT go through
    :func:`log_error`/:func:`raise_alert` — those are the ERROR-severity
    3-layer alert for actual failures, and the task is explicit this case is
    "не ERROR". Only the personal-DM layer is used (if configured): a
    routine successful auto-update does not warrant opening a tracked GitHub
    issue the way a real failure does, but the owner may still want a
    heads-up that the image needs rebuilding with the new pinned version.
    """
    message = f"INFO: signal-cli auto-updated {old_version} -> {new_version}; image's pinned binary is now stale"
    logger.info(message)
    if not config.signal_alert_recipient:
        return
    try:
        send_personal_alert(config, message, run=run)
    except Exception:
        logger.exception("stale-pin notification DM failed")


# ---------------------------------------------------------------------------
# Requirement 9 (rewritten in full in the task file, 2026-09-03, owner
# decision quoted verbatim): "если сервис не успевает до 8 утра, то нужно
# отправить на имейл ... письмо, что пайплайн зафейлился и нужно написать в
# групу самостоятельно." Sent directly against the Resend HTTP API (stdlib
# urllib, no SDK, per the task) -- reuses the same RESEND_API_KEY already in
# the web app's deploy secrets, no second key.
# ---------------------------------------------------------------------------

RESEND_API_URL = "https://api.resend.com/emails"


def _default_http_post(url: str, *, headers: dict[str, str], body: bytes) -> tuple[int, bytes]:  # pragma: no cover - real network, never used in tests
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def send_handover_email(config: Config, reason: str, *, http_post=_default_http_post) -> bool:
    """POST a handover email to Resend. No-op (returns ``False``) if either
    ``RESEND_API_KEY`` or ``ALERT_EMAIL_TO`` is unconfigured — this layer is
    optional the same way the personal-DM layer is.

    Body text follows the project's transactional-email convention (no
    thanks/framing, one thought), the wording quoted verbatim in the task
    file: "Утренний + не отправлен к 08:00. Напишите в группу вручную.
    Причина: <последняя ошибка>. Сервис на сегодня остановлен."
    """
    if not config.resend_api_key or not config.alert_email_to:
        return False

    handover_hhmm = config.handover_time.strftime("%H:%M")
    text = (
        f"Утренний + не отправлен к {handover_hhmm}. Напишите в группу вручную. "
        f"Причина: {reason}. Сервис на сегодня остановлен."
    )
    payload = json.dumps(
        {
            "from": config.alert_email_from,
            "to": [config.alert_email_to],
            "subject": f"signal-plus: \"+\" не отправлен к {handover_hhmm}",
            "text": text,
        }
    ).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {config.resend_api_key}",
        "Content-Type": "application/json",
    }

    try:
        status, body = http_post(RESEND_API_URL, headers=headers, body=payload)
    except Exception as exc:
        logger.error("Resend handover email failed: %s", exc)
        return False

    if not (200 <= status < 300):
        logger.error("Resend handover email failed: HTTP %s: %s", status, body)
        return False
    return True


@dataclass(frozen=True)
class HandoverAlertOutcome:
    logged: bool
    dm_sent: bool
    issue_called: bool
    email_sent: bool


def raise_handover_alert(
    config: Config,
    message: str,
    reason: str,
    *,
    issue_extra_env: dict[str, str] | None = None,
    script_path: Path = DEFAULT_POST_MERGE_ALERT_SCRIPT,
    run=subprocess.run,
    http_post=_default_http_post,
) -> HandoverAlertOutcome:
    """The handover moment fires requirement 10's three layers (via
    :func:`raise_alert`) PLUS the handover email — four independent layers.
    Task file: "Resend вернул ошибку → ERROR, остальные слои алерта (п. 10)
    всё равно срабатывают" — so the email layer's own try/except must never
    prevent (or be prevented by) the other three.
    """
    base_outcome = raise_alert(
        config, message, issue_extra_env=issue_extra_env, script_path=script_path, run=run
    )

    email_sent = False
    try:
        email_sent = send_handover_email(config, reason, http_post=http_post)
    except Exception:
        logger.exception("handover email layer raised unexpectedly")

    return HandoverAlertOutcome(
        logged=base_outcome.logged,
        dm_sent=base_outcome.dm_sent,
        issue_called=base_outcome.issue_called,
        email_sent=email_sent,
    )
