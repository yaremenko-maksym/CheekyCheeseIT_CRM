"""Tests for signal_plus.slot — window/slot selection and lateness.

Requirement 2: random moment in 07:00-07:45 Europe/Kyiv via ``zoneinfo``, never
naive datetime, correct across both DST transitions. The DST tests below are
deliberately chosen so that a broken implementation using a *fixed* UTC offset
(instead of real zoneinfo rules) fails at least one of them: Kyiv is UTC+2 in
winter (EET) and UTC+3 in summer (EEST), so a hardcoded "+2" fails the summer
case and a hardcoded "+3" fails the winter case.

Requirement 9: "окно упущено ... слать до 10:00 Europe/Kyiv с WARNING late;
после 10:00 — сегодня не слать, ERROR + алерт." ``LATE_CUTOFF`` is a fixed
constant (like ``WINDOW_START``/``WINDOW_END``), not an env-configurable
value — requirement 1's env-var list does not include a cutoff-time setting,
and a later chat message proposing to make it configurable (as
``HANDOVER_TIME``, defaulting to 08:00) arrived through an unverifiable
mid-task channel that was separately caught asserting a false claim about
this repo's on-disk state (see the final report). Reverted; 10:00 stays a
constant per the actual task file.
"""
from __future__ import annotations

import random
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from signal_plus.slot import (
    LATE_CUTOFF,
    TIMEZONE,
    WINDOW_END,
    WINDOW_START,
    is_late,
    is_past_cutoff,
    pick_slot,
)

KYIV = ZoneInfo("Europe/Kyiv")


def test_timezone_constant_is_kyiv():
    assert TIMEZONE.key == "Europe/Kyiv"


def test_default_window_matches_owner_spec():
    assert WINDOW_START == time(7, 0)
    assert WINDOW_END == time(7, 45)


def test_default_late_cutoff_matches_owner_spec():
    assert LATE_CUTOFF == time(10, 0)


@pytest.mark.parametrize(
    "target_date,expected_offset_hours",
    [
        (date(2026, 1, 15), 2),  # plain winter day — EET
        (date(2026, 7, 15), 3),  # plain summer day — EEST
        (date(2026, 3, 29), 3),  # EU spring-forward Sunday; 07:00 is after the 03:00 transition
        (date(2026, 10, 25), 2),  # EU fall-back Sunday; 07:00 is after the transition back to EET
    ],
)
def test_pick_slot_uses_correct_dst_offset(target_date, expected_offset_hours):
    rng = random.Random(1)
    picked = pick_slot(target_date, rng=rng)
    assert picked.utcoffset() == timedelta(hours=expected_offset_hours)


def test_pick_slot_falls_within_window_many_dates():
    rng = random.Random(42)
    for day_offset in range(60):
        d = date(2026, 1, 1) + timedelta(days=day_offset)
        picked = pick_slot(d, rng=rng)
        local = picked.astimezone(KYIV)
        assert local.date() == d
        local_time = local.time().replace(microsecond=0)
        assert WINDOW_START <= local_time < WINDOW_END


def test_pick_slot_is_timezone_aware_not_naive():
    picked = pick_slot(date(2026, 9, 3), rng=random.Random(7))
    assert picked.tzinfo is not None


def test_pick_slot_statistically_uniform_over_1000_runs():
    """1000 draws should spread roughly evenly across quartiles of the window.

    A buggy implementation that always returns window_start (or any other
    constant point) fails this trivially; a correct uniform draw lands each
    quartile close to 25% with generous statistical slack.
    """
    rng = random.Random(2026)
    window_seconds = (WINDOW_END.hour * 3600 + WINDOW_END.minute * 60) - (
        WINDOW_START.hour * 3600 + WINDOW_START.minute * 60
    )
    quartile_counts = [0, 0, 0, 0]
    n = 1000
    for _ in range(n):
        picked = pick_slot(date(2026, 9, 3), rng=rng)
        local = picked.astimezone(KYIV).time()
        offset_seconds = (
            local.hour * 3600 + local.minute * 60 + local.second
        ) - (WINDOW_START.hour * 3600 + WINDOW_START.minute * 60)
        quartile = min(3, int(offset_seconds / (window_seconds / 4)))
        quartile_counts[quartile] += 1
    for count in quartile_counts:
        share = count / n
        assert 0.15 < share < 0.35, quartile_counts


def test_pick_slot_rejects_empty_or_inverted_window():
    with pytest.raises(ValueError):
        pick_slot(date(2026, 9, 3), window_start=time(8, 0), window_end=time(7, 0))
    with pytest.raises(ValueError):
        pick_slot(date(2026, 9, 3), window_start=time(7, 0), window_end=time(7, 0))


def _at(d: date, t: time) -> datetime:
    return datetime.combine(d, t, tzinfo=KYIV)


def test_is_late_false_before_window_end():
    assert is_late(_at(date(2026, 9, 3), time(7, 30))) is False


def test_is_late_true_after_window_end():
    assert is_late(_at(date(2026, 9, 3), time(7, 50))) is True


def test_is_late_true_exactly_at_window_end():
    assert is_late(_at(date(2026, 9, 3), WINDOW_END)) is True


def test_is_past_cutoff_false_before_1000():
    now = _at(date(2026, 9, 3), time(9, 59))
    assert is_past_cutoff(now) is False


def test_is_past_cutoff_true_exactly_at_1000():
    now = _at(date(2026, 9, 3), time(10, 0))
    assert is_past_cutoff(now) is True


def test_is_past_cutoff_true_after_1000():
    now = _at(date(2026, 9, 3), time(10, 30))
    assert is_past_cutoff(now) is True


def test_is_past_cutoff_accepts_custom_cutoff_for_testing():
    now = _at(date(2026, 9, 3), time(8, 30))
    assert is_past_cutoff(now, cutoff=time(8, 0)) is True
    assert is_past_cutoff(now, cutoff=time(9, 0)) is False


def test_is_late_and_is_past_cutoff_accept_non_kyiv_aware_datetimes():
    # Callers may pass UTC-aware "now" (e.g. from datetime.now(timezone.utc));
    # both predicates must convert to Kyiv local time themselves.
    utc_now = datetime(2026, 9, 3, 4, 50, tzinfo=timezone.utc)  # 07:50 Kyiv (UTC+3 in Sept)
    assert is_late(utc_now) is True
    assert is_past_cutoff(utc_now) is False
