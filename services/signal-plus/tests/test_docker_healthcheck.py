"""Tests for docker-healthcheck.py — the Docker HEALTHCHECK script.

Loaded by file path via importlib: the filename has a hyphen, so it is not a
valid Python import target -- matches how it is actually invoked in
production, ``CMD ["python3", "/app/docker-healthcheck.py"]`` (Dockerfile), a
path, never an import.

task-signal-plus-sunday-skip.md AC6: "Healthcheck в пропускаемый день —
здоров". The script DOES look at "today" (see its own module docstring and
``check()`` below) -- it resolves either ``last_success_date`` or
``handover_date`` by the configured cutoff, and flags UNHEALTHY if neither
is set past that point. On a skipped weekday (Sunday by default)
``cli.run_cycle`` no-ops entirely, so NEITHER field is ever written -- before
this fix, the healthcheck would misreport UNHEALTHY every single Sunday
after the cutoff. The fix teaches it the same skip-weekday concept
``cli.run_cycle`` already has (``slot.is_skipped_weekday`` +
``config.skip_weekdays``).
"""
from __future__ import annotations

import importlib.util
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from signal_plus.state import State, save as save_state

_HEALTHCHECK_PATH = Path(__file__).resolve().parent.parent / "docker-healthcheck.py"
KYIV = ZoneInfo("Europe/Kyiv")

REQUIRED_ENV = {
    "SIGNAL_ACCOUNT": "+380501234567",
    "SIGNAL_GROUP_ID": "group.abc123==",
    "SIGNAL_CLI_BIN": "/opt/signal-cli/bin/signal-cli",
}


def _load_healthcheck_module():
    spec = importlib.util.spec_from_file_location("docker_healthcheck", _HEALTHCHECK_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


healthcheck = _load_healthcheck_module()


@pytest.fixture(autouse=True)
def required_env(monkeypatch, tmp_path):
    for key, value in REQUIRED_ENV.items():
        monkeypatch.setenv(key, value)
    state_file = tmp_path / "state.json"
    monkeypatch.setenv("STATE_FILE", str(state_file))
    return state_file


def _kyiv(y, m, d, h, mi) -> datetime:
    return datetime(y, m, d, h, mi, tzinfo=KYIV)


# ---------------------------------------------------------------------------
# Pre-existing behaviour (pinned, unrelated to the Sunday-skip fix) -- a
# normal (non-skipped) weekday must keep working exactly as before.
# ---------------------------------------------------------------------------


def test_healthy_when_already_sent_today(required_env):
    save_state(required_env, State(last_success_date=date(2026, 9, 3)))  # Thursday
    ok, detail = healthcheck.check(_kyiv(2026, 9, 3, 9, 0))
    assert ok is True


def test_healthy_when_already_given_up_today(required_env):
    save_state(required_env, State(handover_date=date(2026, 9, 3)))
    ok, detail = healthcheck.check(_kyiv(2026, 9, 3, 9, 0))
    assert ok is True


def test_healthy_before_cutoff_when_unresolved(required_env):
    ok, detail = healthcheck.check(_kyiv(2026, 9, 3, 7, 30))
    assert ok is True


def test_unhealthy_past_cutoff_unresolved_on_a_normal_weekday(required_env):
    # A normal (non-skipped) weekday must still flag UNHEALTHY if nothing
    # resolved by the cutoff -- the daemon's own invariant says this should
    # never happen, so this branch must stay a real signal, not be
    # accidentally silenced by the skip-weekday fix.
    ok, detail = healthcheck.check(_kyiv(2026, 9, 3, 8, 30))
    assert ok is False
    assert "past the" in detail


def test_bad_config_reports_unhealthy_with_reason(monkeypatch):
    monkeypatch.delenv("SIGNAL_ACCOUNT", raising=False)
    ok, detail = healthcheck.check(datetime.now(timezone.utc))
    assert ok is False
    assert "bad configuration" in detail


# ---------------------------------------------------------------------------
# AC6: skipped weekday -- healthy regardless of cutoff, because nothing is
# ever expected to resolve that day.
# ---------------------------------------------------------------------------


def test_healthy_on_skipped_sunday_before_cutoff(required_env):
    ok, detail = healthcheck.check(_kyiv(2026, 9, 6, 6, 0))  # Sunday, before 08:00
    assert ok is True


def test_healthy_on_skipped_sunday_past_cutoff(required_env):
    # The actual bug this AC fixes: past cutoff, neither state field is set
    # (cli.run_cycle never writes either on a skipped Sunday) -- must be
    # healthy, not UNHEALTHY.
    ok, detail = healthcheck.check(_kyiv(2026, 9, 6, 9, 0))  # Sunday, past 08:00
    assert ok is True


def test_healthy_on_configured_extra_skip_weekday_past_cutoff(required_env, monkeypatch):
    # AC5 wired through to the healthcheck too: SIGNAL_SKIP_WEEKDAYS=6,7.
    monkeypatch.setenv("SIGNAL_SKIP_WEEKDAYS", "6,7")
    ok, detail = healthcheck.check(_kyiv(2026, 9, 5, 9, 0))  # Saturday, past 08:00
    assert ok is True
