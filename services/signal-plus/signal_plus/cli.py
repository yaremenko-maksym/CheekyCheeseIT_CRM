"""Orchestration: modes, chunked sleep, retries+backoff, update integration.

Requirement 6: "Сон до цели кусками ~5 минут, не одним sleep; после каждого
куска пересчёт «сейчас»." Requirement 7: "Режимы: --groups, --now, --once,
демон по умолчанию." Requirement 5: "Ретраи с backoff; полный провал — ERROR
в лог + алерт." Requirement 9 (rewritten 2026-09-03): late until
``config.handover_time`` (default 08:00), then a handover email + give up
on the day entirely.
"""
from __future__ import annotations

import argparse
import logging
import os
import random
import subprocess
import sys
import tempfile
import time as time_module
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path

from signal_plus import alert, signal as signal_cli, slot, state, updater
from signal_plus.config import Config
from signal_plus.state import State

logger = logging.getLogger("signal_plus")

MESSAGE = "+"

DEFAULT_SLEEP_CHUNK_SECONDS = 300.0  # requirement 6: ~5 minutes
DEFAULT_RETRY_ATTEMPTS = 5
DEFAULT_RETRY_BASE_DELAY_SECONDS = 10.0
DAEMON_RECHECK_INTERVAL_SECONDS = 3600.0


def configure_logging() -> None:
    if logging.getLogger().handlers:
        return
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def _default_now() -> datetime:
    return datetime.now(timezone.utc)


def _default_tmp_dir(config: Config) -> Path:
    if config.signal_data_dir is not None:
        return Path(config.signal_data_dir) / "tmp"
    return Path(tempfile.gettempdir()) / "signal-plus"


def _first_line_for_state(text: str) -> str:
    """SR-M-6 (PR #650 security review round 2, id 5107124812): truncation
    belongs HERE, not inside signal_plus.signal._sanitize_cli_text (which
    now masks every line but keeps them all — callers like `--groups` and
    updater.is_outdated_client_error() need the full, if masked, text).
    ``state.last_error`` is the one thing that persists (state.json, and
    downstream of it the handover email body and the healthcheck's
    UNHEALTHY message) — a multi-line `receive` envelope dump has no
    business living there long-term, so only THIS call site truncates.
    """
    if not text:
        return text
    return text.splitlines()[0]


def _issue_alert_env(failed_leg: str) -> dict[str, str]:
    """Best-effort env for post-merge-alert.sh (see signal_plus/alert.py's
    module docstring — full wiring is step 4/DevOps). ALERT_REPO/GH_TOKEN are
    picked up from this service's own environment if step 4 sets them there;
    the rest are clearly-marked placeholders a scheduled roll-call has no
    real analog for.

    ``failed_leg`` (SR-H-1, security review 5105061153): a short FIXED label
    naming which leg failed — the same convention post-merge-alert.sh's other
    callers use (``FAILED_LEGS: 'build/push/SSH-deploy'`` in
    deploy-signal-plus.yml, ``'quality, e2e'`` etc. for ci.yml). Callers must
    NEVER pass the dynamic error text itself (``state.last_error`` or
    similar): this issue can fall back to the PUBLIC repo when the private
    telemetry PAT is unavailable/expired (see post-merge-alert.sh's own
    "ГРАНИЦА КАНАЛА" comment — body is metadata-only, never log/error
    content), and signal-cli's own errors can carry the account number even
    after the log/state/email masking in signal_plus/signal.py.
    """
    env = {
        "RESULT": "failure",
        "COMMIT_SHA": "0" * 40,
        "RUN_URL": "n/a (scheduled signal-plus roll-call, not a CI run)",
        "FAILED_LEGS": failed_leg,
        "LABEL": "signal-plus-broken",
    }
    for name in ("ALERT_REPO", "GH_TOKEN"):
        value = os.environ.get(name)
        if value:
            env[name] = value
    return env


def _sleep_until(target: datetime, *, now_fn, sleep_fn, chunk_seconds: float = DEFAULT_SLEEP_CHUNK_SECONDS) -> datetime:
    """Sleep in ``chunk_seconds`` pieces until ``now_fn() >= target``,
    recomputing "now" after every chunk (requirement 6) instead of one long
    sleep for the whole wait."""
    now = now_fn()
    while now < target:
        remaining = (target - now).total_seconds()
        sleep_fn(min(chunk_seconds, remaining))
        now = now_fn()
    return now


def _attempt_send_once(config: Config, message: str, *, run) -> signal_cli.SignalResult:
    """Requirement 4: receive before every send (keeps the linked device fresh)."""
    receive_result = signal_cli.receive(config, run=run)
    if not receive_result.ok:
        logger.warning("signal-cli receive failed: %s", receive_result.output.strip())
    return signal_cli.send_group_message(config, message, run=run)


def send_with_retries_and_update(
    config: Config,
    message: str,
    state_obj: State,
    *,
    today,
    run=subprocess.run,
    sleep_fn=time_module.sleep,
    http_get=None,
    tmp_dir: Path,
    attempts: int = DEFAULT_RETRY_ATTEMPTS,
    base_delay: float = DEFAULT_RETRY_BASE_DELAY_SECONDS,
) -> tuple[bool, State]:
    """One full attempt cycle: receive+send with retries/backoff (requirement
    5), auto-updating at most once if signal-cli reports the exact
    outdated-client message (requirement 8) and retrying the send once more
    afterwards. Returns ``(ok, updated_state)`` — the caller persists
    ``state`` (this function already persists it immediately after any
    update attempt, so the once-per-day guard survives a crash mid-cycle).
    """
    http_get = http_get or updater._default_http_get

    for attempt in range(1, attempts + 1):
        result = _attempt_send_once(config, message, run=run)
        if result.ok:
            return True, state_obj

        last_error = _first_line_for_state(result.output.strip()) or f"send exited {result.returncode}"
        state_obj = replace(state_obj, last_error=last_error)
        logger.warning("send attempt %d/%d failed: %s", attempt, attempts, last_error)

        if updater.is_outdated_client_error(result.output) and not updater.already_attempted_today(
            state_obj, today
        ):
            logger.info("signal-cli reports an outdated client; attempting one auto-update for today")
            try:
                outcome = updater.run_auto_update(
                    config, state_obj, today=today, http_get=http_get, run=run, tmp_dir=tmp_dir
                )
            except Exception as exc:
                # CR-H-2 (code review 5105099737): "тот же класс дыры" as
                # the signal-cli subprocess call this same finding covers --
                # run_auto_update()'s own internal try/except only wraps
                # fetch_latest_release()'s UpdaterError; a network failure
                # reaching for the archive itself (download_to), a disk
                # failure (install_release), or a hung `gpg --verify`
                # (verify_signature's own `run` call) all propagate straight
                # out of it uncaught. This is the ONE place in the update
                # flow that must never let the daemon die -- everything
                # past this line already knows how to handle
                # UpdateOutcome(success=False), so an unexpected exception
                # here is folded into that exact same shape rather than
                # handled as a separate case.
                logger.exception("auto-update attempt raised unexpectedly")
                outcome = updater.UpdateOutcome(
                    attempted=True, success=False, reason=f"unexpected error: {exc}"
                )
            state_obj = replace(state_obj, last_update_attempt_date=today)
            if outcome.success:
                state_obj = replace(state_obj, installed_version=outcome.new_version)
            # Persist immediately: the once-per-day guard must survive a
            # crash between the update attempt and the end of this cycle.
            state.save(config.state_file, state_obj)

            if outcome.success:
                logger.info("signal-cli auto-updated: %s -> %s", outcome.old_version, outcome.new_version)
                alert.notify_stale_pin(config, outcome.old_version, outcome.new_version, run=run)
                retry_result = _attempt_send_once(config, message, run=run)
                if retry_result.ok:
                    return True, state_obj
                last_error = _first_line_for_state(retry_result.output.strip()) or f"send exited {retry_result.returncode}"
                state_obj = replace(state_obj, last_error=last_error)
                logger.warning("send still failed after auto-update: %s", last_error)
            else:
                state_obj = replace(state_obj, last_error=f"auto-update failed: {outcome.reason}")
                logger.error("auto-update attempt failed: %s", outcome.reason)

        if attempt < attempts:
            sleep_fn(base_delay * (2 ** (attempt - 1)))

    return False, state_obj


@dataclass(frozen=True)
class CycleOutcome:
    sent: bool
    reason: str


def run_cycle(
    config: Config,
    *,
    now_fn=_default_now,
    sleep_fn=time_module.sleep,
    rng: random.Random | None = None,
    run=subprocess.run,
    http_get=None,
    http_post=None,
    tmp_dir: Path | None = None,
    wait_for_slot: bool = True,
    alert_script_path: Path = alert.DEFAULT_POST_MERGE_ALERT_SCRIPT,
) -> CycleOutcome:
    """Requirement 7's ``--once``/daemon-cycle behaviour: wait for the slot
    (unless ``wait_for_slot=False``, requirement 7's ``--now``), send with
    idempotency (requirement 3), lateness handling up to the
    ``config.handover_time`` cutoff (requirement 9, rewritten 2026-09-03),
    retries with auto-update (requirements 5, 8).
    """
    tmp_dir = Path(tmp_dir) if tmp_dir else _default_tmp_dir(config)
    http_post = http_post or alert._default_http_post
    st = state.load(config.state_file)
    today = now_fn().astimezone(slot.TIMEZONE).date()

    if st.last_success_date == today:
        logger.info("already sent today (%s); nothing to do", today)
        return CycleOutcome(sent=False, reason="already-sent")
    if st.handover_date == today:
        logger.info("already gave up for today (%s) at the handover cutoff; nothing to do", today)
        return CycleOutcome(sent=False, reason="already-given-up")
    if wait_for_slot and slot.is_skipped_weekday(today, skip_weekdays=config.skip_weekdays):
        # task-signal-plus-sunday-skip.md requirement 1: "по воскресеньям
        # перекличка не проводится" -- gated on wait_for_slot so that --now
        # (requirement/AC4: an explicit manual action) is never affected,
        # same way --now already bypasses the slot wait below.
        logger.info(
            "%s (Europe/Kyiv) — roll-call is not held on this weekday, skipping",
            today.strftime("%A"),
        )
        return CycleOutcome(sent=False, reason="weekday-skipped")

    if wait_for_slot:
        target = slot.pick_slot(today, rng=rng or random.Random())
        _sleep_until(target, now_fn=now_fn, sleep_fn=sleep_fn)

    while True:
        now = now_fn()

        if slot.is_past_cutoff(now, cutoff=config.handover_time):
            reason = st.last_error or "today's + was not sent in time (no prior error recorded)"
            alert.raise_handover_alert(
                config,
                f"ERROR: today's + was not sent by the {config.handover_time.strftime('%H:%M')} Kyiv handover cutoff",
                reason,
                # SR-H-1: FAILED_LEGS is a fixed label, never `reason` --
                # `reason` (state.last_error) is exactly what the log/email
                # channels show and can still carry signal-cli-shaped text.
                issue_extra_env=_issue_alert_env("handover-cutoff-reached"),
                script_path=alert_script_path,
                run=run,
                http_post=http_post,
            )
            state.save(config.state_file, replace(st, handover_date=today))
            return CycleOutcome(sent=False, reason="cutoff")

        if slot.is_late(now):
            logger.warning("late: sending after the 07:45 window end")

        ok, st = send_with_retries_and_update(
            config,
            MESSAGE,
            st,
            today=today,
            run=run,
            sleep_fn=sleep_fn,
            http_get=http_get,
            tmp_dir=tmp_dir,
        )
        if ok:
            state.save(config.state_file, replace(st, last_success_date=today))
            return CycleOutcome(sent=True, reason="late" if slot.is_late(now_fn()) else "on-time")

        reason = "all retry attempts failed"
        alert.raise_alert(
            config,
            f"ERROR: {reason}",
            issue_extra_env=_issue_alert_env("send-retries-exhausted"),
            script_path=alert_script_path,
            run=run,
        )
        sleep_fn(DEFAULT_SLEEP_CHUNK_SECONDS)


def run_daemon(config: Config, **kwargs) -> None:
    """Requirement 7's default mode. Each :func:`run_cycle` call already
    blocks for the whole day's outcome (sent or given up at cutoff); once it
    returns there is nothing more to do until a new Kyiv calendar day
    begins. Re-checking periodically rather than computing exact
    milliseconds-to-midnight is safe because run_cycle's own idempotency
    (``last_success_date``/``handover_date`` == today) makes an early
    re-check a no-op.
    """
    sleep_fn = kwargs.get("sleep_fn", time_module.sleep)
    while True:
        run_cycle(config, **kwargs)
        sleep_fn(DAEMON_RECHECK_INTERVAL_SECONDS)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="signal-plus",
        description="Daily morning '+' roll-call to a Signal group via signal-cli.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--groups", action="store_true", help="List Signal groups with their ids, then exit."
    )
    mode.add_argument(
        "--now",
        action="store_true",
        help="Send immediately, skipping the random-slot wait. Idempotency is still respected.",
    )
    mode.add_argument(
        "--once",
        action="store_true",
        help="Run a single cycle (wait for the slot, send, exit) instead of running as a daemon.",
    )
    return parser


def main_with_config(config: Config, argv: list[str] | None = None, *, run=subprocess.run) -> int:
    configure_logging()
    args = build_arg_parser().parse_args(argv)

    if args.groups:
        result = signal_cli.list_groups(config, run=run)
        print(result.stdout)
        if not result.ok:
            print(result.stderr, file=sys.stderr)
        return 0 if result.ok else 1

    if args.now:
        outcome = run_cycle(config, run=run, wait_for_slot=False)
        return 0 if outcome.sent else 1

    if args.once:
        outcome = run_cycle(config, run=run, wait_for_slot=True)
        return 0 if outcome.sent else 1

    run_daemon(config, run=run)
    return 0


def main(argv: list[str] | None = None) -> int:
    """Real, env-reading entrypoint (the ``signal-plus`` console script and
    ``python -m signal_plus`` both call this).

    CR-M-2 (PR #650 code review, id 5105099737): argv is parsed FIRST, before
    ``Config.from_env()`` runs -- ``--help``/``-h`` must work without a
    configured ``.env`` (argparse's own help handling calls ``sys.exit(0)``
    synchronously inside ``parse_args()``, before this function does
    anything else). The result is discarded and ``main_with_config`` parses
    argv again internally; redundant for every other mode, but keeps this
    fix to a single added line rather than changing ``main_with_config``'s
    signature (and the many tests that call it directly with a pre-built
    ``Config`` and raw ``argv``).
    """
    build_arg_parser().parse_args(argv)
    config = Config.from_env()
    return main_with_config(config, argv)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
