"""Tests for signal_plus.state — atomic JSON state on disk.

This is the mechanism requirement 3 (idempotency) hinges on: "дата последней
успешной отправки в state-файле (JSON, атомарная запись через временный файл +
os.replace)". If this module silently resets on a corrupt/partial file, a crash
mid-write could make the daemon believe today's "+" was never sent and send a
second one — so corruption must fail loudly, never silently reset to "nothing
sent yet".
"""
from __future__ import annotations

import datetime as dt
import json
from unittest.mock import patch

import pytest

from signal_plus.state import State, StateError, load, save


def test_load_missing_file_returns_blank_state(tmp_path):
    st = load(tmp_path / "state.json")
    assert st == State()
    assert st.last_success_date is None
    assert st.handover_date is None
    assert st.last_update_attempt_date is None
    assert st.installed_version is None
    assert st.last_error is None


def test_save_then_load_round_trips_all_fields(tmp_path):
    path = tmp_path / "state.json"
    original = State(
        last_success_date=dt.date(2026, 9, 3),
        handover_date=dt.date(2026, 9, 2),
        last_update_attempt_date=dt.date(2026, 9, 1),
        installed_version="v0.14.7",
        last_error="connection refused",
    )
    save(path, original)
    loaded = load(path)
    assert loaded == original


def test_save_creates_parent_directory(tmp_path):
    path = tmp_path / "nested" / "dir" / "state.json"
    save(path, State(last_success_date=dt.date(2026, 9, 3)))
    assert path.exists()
    assert load(path).last_success_date == dt.date(2026, 9, 3)


def test_save_writes_via_temp_file_and_os_replace(tmp_path):
    """Removing the temp-file+os.replace step must make this test fail.

    A naive ``path.write_text(...)`` would pass every other test in this file
    but leaves a truncated, half-written JSON file on disk if the process is
    killed mid-write — which is exactly the corruption AC3 exists to prevent.
    Asserting ``os.replace`` is actually invoked pins the *mechanism*, not
    just the observable round-trip.
    """
    path = tmp_path / "state.json"
    with patch("signal_plus.state.os.replace") as mock_replace:
        # os.replace is mocked out, so the real rename never happens — the
        # final file must NOT exist under its target name yet.
        save(path, State(last_success_date=dt.date(2026, 9, 3)))
    mock_replace.assert_called_once()
    src, dst = mock_replace.call_args[0]
    assert str(dst) == str(path)
    assert src != dst
    assert not path.exists()


def test_load_raises_on_corrupt_json_instead_of_resetting(tmp_path):
    path = tmp_path / "state.json"
    path.write_text("{not valid json", encoding="utf-8")
    with pytest.raises(StateError):
        load(path)


def test_load_raises_on_valid_json_wrong_shape(tmp_path):
    path = tmp_path / "state.json"
    path.write_text(json.dumps([1, 2, 3]), encoding="utf-8")
    with pytest.raises(StateError):
        load(path)


def test_state_dates_serialize_as_iso_strings_on_disk(tmp_path):
    path = tmp_path / "state.json"
    save(path, State(last_success_date=dt.date(2026, 9, 3)))
    raw = json.loads(path.read_text(encoding="utf-8"))
    assert raw["last_success_date"] == "2026-09-03"


def test_none_fields_round_trip_as_none(tmp_path):
    path = tmp_path / "state.json"
    save(path, State())
    raw = json.loads(path.read_text(encoding="utf-8"))
    assert raw["last_success_date"] is None
    assert load(path) == State()


# task-signal-plus-senderkey-self-heal: `last_heal_date` (once-per-day guard
# for the sender-key self-heal), same shape as `last_update_attempt_date`.


def test_last_heal_date_round_trips_as_iso_date(tmp_path):
    path = tmp_path / "state.json"
    save(path, State(last_heal_date=dt.date(2026, 11, 2)))
    raw = json.loads(path.read_text(encoding="utf-8"))
    assert raw["last_heal_date"] == "2026-11-02"
    assert load(path).last_heal_date == dt.date(2026, 11, 2)


def test_old_state_file_without_last_heal_date_still_loads(tmp_path):
    path = tmp_path / "state.json"
    path.write_text(
        json.dumps(
            {
                "last_success_date": "2026-11-01",
                "handover_date": None,
                "last_update_attempt_date": None,
                "installed_version": None,
                "last_error": None,
            }
        ),
        encoding="utf-8",
    )
    st = load(path)
    assert st.last_heal_date is None
    assert st.last_success_date == dt.date(2026, 11, 1)


def test_last_heal_date_that_is_not_an_iso_date_fails_loudly(tmp_path):
    path = tmp_path / "state.json"
    path.write_text(json.dumps({"last_heal_date": "yesterday"}), encoding="utf-8")
    with pytest.raises(StateError):
        load(path)
