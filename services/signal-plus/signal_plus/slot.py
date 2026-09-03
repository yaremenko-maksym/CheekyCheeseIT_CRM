"""Window/slot selection and lateness classification — the daemon's clock logic.

Requirement 2: "Слот — случайный момент в 07:00–07:45 Europe/Kyiv через zoneinfo,
никаких naive datetime. Корректно переживает перевод часов." Every datetime this
module hands out is built with :mod:`zoneinfo`, so DST transitions are handled by
the IANA tz database rules rather than a hand-rolled fixed offset.

Requirement 9: "окно упущено (рестарт, сбой, обновление) → слать до 10:00
Europe/Kyiv с WARNING late; после 10:00 — сегодня не слать, ERROR + алерт."
``WINDOW_START``/``WINDOW_END``/``LATE_CUTOFF`` are fixed constants (not env
vars) — requirement 1's explicit env-var list has no cutoff-time setting.
"""
from __future__ import annotations

import random
from datetime import date, datetime, time
from zoneinfo import ZoneInfo

TIMEZONE = ZoneInfo("Europe/Kyiv")
WINDOW_START = time(7, 0)
WINDOW_END = time(7, 45)
LATE_CUTOFF = time(10, 0)


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
    now: datetime, *, cutoff: time = LATE_CUTOFF, tz: ZoneInfo = TIMEZONE
) -> bool:
    """True once ``now`` (converted to ``tz``) is at/after ``cutoff``.

    Requirement 9: at/after 10:00 the daemon gives up on today entirely —
    no more send attempts, ``ERROR`` + alert instead.
    """
    local_time = now.astimezone(tz).timetz().replace(tzinfo=None)
    return local_time >= cutoff
