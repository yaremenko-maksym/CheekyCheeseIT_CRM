"""Window/slot selection and lateness classification — the daemon's clock logic.

Requirement 2: "Слот — случайный момент в 07:00–07:45 Europe/Kyiv через zoneinfo,
никаких naive datetime. Корректно переживает перевод часов." Every datetime this
module hands out is built with :mod:`zoneinfo`, so DST transitions are handled by
the IANA tz database rules rather than a hand-rolled fixed offset.

Requirement 9 (rewritten in full in the task file, 2026-09-03, owner decision
quoted verbatim): "окно упущено → слать с WARNING late только до 08:00
Europe/Kyiv; в 08:00 без успешной отправки — письмо владельцу и останов
попыток на сегодня." ``WINDOW_START``/``WINDOW_END`` stay fixed constants
(requirement 1's env-var list has no window setting). The handover cutoff is
now env-driven (``HANDOVER_TIME``, default 08:00) — :data:`DEFAULT_CUTOFF`
here is only a fallback default for direct unit tests of this module;
:func:`signal_plus.cli.run_cycle` always passes the real value from
``config.handover_time`` explicitly.
"""
from __future__ import annotations

import random
from datetime import date, datetime, time
from zoneinfo import ZoneInfo

TIMEZONE = ZoneInfo("Europe/Kyiv")
WINDOW_START = time(7, 0)
WINDOW_END = time(7, 45)
DEFAULT_CUTOFF = time(8, 0)

# task-signal-plus-sunday-skip.md requirement 1: "по воскресеньям перекличка
# не проводится" -- ISO weekday numbering (Monday=1 ... Sunday=7). Overridable
# via config.Config.skip_weekdays (SIGNAL_SKIP_WEEKDAYS env var); this is only
# the built-in default.
SKIP_ISO_WEEKDAYS: frozenset[int] = frozenset({7})


def pick_slot(
    target_date: date,
    *,
    window_start: time = WINDOW_START,
    window_end: time = WINDOW_END,
    tz: ZoneInfo = TIMEZONE,
    rng: random.Random | None = None,
) -> datetime:
    """Pick a uniformly-random, tz-aware moment in ``[window_start, window_end)``.

    The random offset is computed in plain seconds-of-day and combined with
    ``target_date`` via :func:`datetime.combine` with ``tzinfo=tz`` — the
    combination step is what ``zoneinfo`` resolves against the real DST rules
    for that specific date, rather than us pre-computing a UTC offset by hand.
    """
    if rng is None:
        rng = random.Random()
    start_seconds = window_start.hour * 3600 + window_start.minute * 60 + window_start.second
    end_seconds = window_end.hour * 3600 + window_end.minute * 60 + window_end.second
    if end_seconds <= start_seconds:
        raise ValueError(
            f"window_end ({window_end}) must be strictly after window_start ({window_start})"
        )
    offset_seconds = rng.uniform(0, end_seconds - start_seconds)
    total_seconds = start_seconds + offset_seconds
    hour, remainder = divmod(int(total_seconds), 3600)
    minute, second = divmod(remainder, 60)
    naive_time = time(hour, minute, second)
    return datetime.combine(target_date, naive_time, tzinfo=tz)


def is_late(now: datetime, *, window_end: time = WINDOW_END, tz: ZoneInfo = TIMEZONE) -> bool:
    """True once ``now`` (converted to ``tz``) is at/after ``window_end``.

    Used to decide whether a send that is about to happen should be logged
    with ``WARNING late`` (requirement 9).
    """
    local_time = now.astimezone(tz).timetz().replace(tzinfo=None)
    return local_time >= window_end


def is_past_cutoff(
    now: datetime, *, cutoff: time = DEFAULT_CUTOFF, tz: ZoneInfo = TIMEZONE
) -> bool:
    """True once ``now`` (converted to ``tz``) is at/after ``cutoff``.

    Requirement 9: at/after the configured handover time (``HANDOVER_TIME``,
    default 08:00) the daemon gives up on today entirely — no more send
    attempts, a handover email, and the rest of the alert (requirement 10).
    """
    local_time = now.astimezone(tz).timetz().replace(tzinfo=None)
    return local_time >= cutoff


def is_skipped_weekday(day: date, *, skip_weekdays: frozenset[int] = SKIP_ISO_WEEKDAYS) -> bool:
    """True if ``day``'s ISO weekday (Monday=1 ... Sunday=7) is one the
    roll-call is not held on (task-signal-plus-sunday-skip.md requirement 1).

    ``day`` must already be the Kyiv-local calendar date — unlike
    :func:`is_late`/:func:`is_past_cutoff` this function does no tz
    conversion itself, because every caller (``cli.run_cycle``,
    ``docker-healthcheck.py``) already computes ``today`` via
    ``now.astimezone(TIMEZONE).date()`` for other reasons (idempotency
    checks) before it would need this check too.
    """
    return day.isoweekday() in skip_weekdays
