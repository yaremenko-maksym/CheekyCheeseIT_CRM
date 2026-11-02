"""Tests for the sender-key self-heal branch of cli.send_with_retries_and_update.

task-signal-plus-senderkey-self-heal: a group send failing with
java.lang.StackOverflowError is not retried with the generic 5x backoff. Once
per day the service heals the group's sender-key rows (signal_plus.senderkey),
persists ``last_heal_date`` BEFORE the single retry, and alerts loudly at once
if healing is disabled, failed, already tried today, or did not help.
"""
from __future__ import annotations

import base64
import logging
import sqlite3
from dataclasses import replace
from datetime import date

import pytest

from signal_plus import cli, senderkey
from signal_plus.config import Config
from signal_plus.state import State, load as load_state, save as save_state
from tests.senderkey_db import (
    ACCOUNT,
    OTHER_DIST_ID,
    ROLLCALL_DIST_ID,
    ROLLCALL_GROUP_B64,
    ROLLCALL_GROUP_ID,
    account_db_path,
    build_signal_data,
    count_rows,
)
from tests.test_cli import FakeClock, ScriptedRun, _fail, _kyiv, _ok

TODAY = date(2026, 11, 2)
RECIPIENT = "+380671112233"
OVERFLOW = (1, "", "Unhandled exception: java.lang.StackOverflowError: null\n")


@pytest.fixture
def config(tmp_path) -> Config:
    return Config(
        signal_account=ACCOUNT,
        signal_group_id=ROLLCALL_GROUP_B64,
        signal_cli_bin=tmp_path / "signal-cli",
        state_file=tmp_path / "state.json",
        signal_data_dir=tmp_path / "signal-cli-data",
        signal_alert_recipient=RECIPIENT,
    )


@pytest.fixture
def db(config):
    return build_signal_data(config.signal_data_dir)


def _send(config, run, state_obj=None, sleep_calls=None, tmp_path=None):
    sleeps = [] if sleep_calls is None else sleep_calls
    return cli.send_with_retries_and_update(
        config,
        "+",
        state_obj or State(),
        today=TODAY,
        run=run,
        sleep_fn=sleeps.append,
        http_get=_no_network,
        tmp_dir=config.state_file.parent / "downloads",
    )


def _no_network(url):
    raise AssertionError("no release fetch expected on a StackOverflowError")


def _group_sends(run):
    return [c for c in run.calls if "-g" in c]


def _dm_messages(run):
    return [c[c.index("-m") + 1] for c in run.calls if RECIPIENT in c]


def _forbid_heal(monkeypatch):
    def _boom(config):
        raise AssertionError("heal_group_sender_key must not be called here")

    monkeypatch.setattr(senderkey, "heal_group_sender_key", _boom)


# ---------------------------------------------------------------------------
# Heal helps
# ---------------------------------------------------------------------------


def test_overflow_heals_then_single_retry_succeeds(config, db):
    run = ScriptedRun([_ok(), OVERFLOW, _ok(), _ok(), _ok()])  # recv, send, recv, send, info DM
    sleeps: list[float] = []

    ok, st = _send(config, run, sleep_calls=sleeps)

    assert ok is True
    assert st.last_heal_date == TODAY
    assert load_state(config.state_file).last_heal_date == TODAY
    assert count_rows(db, "sender_key", ROLLCALL_DIST_ID) == 0
    assert count_rows(db, "sender_key", OTHER_DIST_ID) == 1
    assert len(_group_sends(run)) == 2
    assert sleeps == []
    assert run.results == []
    [info] = _dm_messages(run)
    assert info.startswith("INFO:")
    assert "sender-key self-heal performed" in info
    assert "31 rows" in info


def test_last_heal_date_is_persisted_before_the_post_heal_retry(config, db):
    seen_at_retry: list = []

    class RecordingRun(ScriptedRun):
        def __call__(self, argv, **kwargs):
            if "-g" in argv and len(_group_sends(self)) == 1:  # the retry send
                seen_at_retry.append(load_state(config.state_file).last_heal_date)
            return super().__call__(argv, **kwargs)

    run = RecordingRun([_ok(), OVERFLOW, _ok(), _ok(), _ok()])

    _send(config, run)

    assert seen_at_retry == [TODAY]


def test_run_cycle_counts_a_healed_send_as_sent(config, db):
    clock = FakeClock(_kyiv(2026, 11, 2, 7, 10))
    run = ScriptedRun([_ok(), OVERFLOW, _ok(), _ok(), _ok()])

    outcome = cli.run_cycle(config, now_fn=clock.now_fn, sleep_fn=clock.sleep_fn, run=run, wait_for_slot=False)

    assert outcome.sent is True
    st = load_state(config.state_file)
    assert st.last_success_date == TODAY
    assert st.last_heal_date == TODAY


# ---------------------------------------------------------------------------
# Heal does not help / cannot run -> loud alert at once, no backoff
# ---------------------------------------------------------------------------


def test_still_overflowing_after_heal_alerts_loudly_and_stops(config, db):
    run = ScriptedRun([_ok(), OVERFLOW, _ok(), OVERFLOW, _ok()])  # ..., loud DM
    sleeps: list[float] = []

    ok, st = _send(config, run, sleep_calls=sleeps)

    assert ok is False
    assert sleeps == []  # no remaining backoff attempts
    assert len(_group_sends(run)) == 2
    assert run.results == []
    [loud] = _dm_messages(run)
    assert loud.startswith("ERROR:")
    assert "StackOverflowError in group send; self-heal done" in loud
    assert st.last_heal_date == TODAY


def test_second_overflow_same_day_does_not_heal_again(config, db, monkeypatch):
    _forbid_heal(monkeypatch)
    run = ScriptedRun([_ok(), OVERFLOW, _ok()])
    sleeps: list[float] = []

    ok, st = _send(config, run, state_obj=State(last_heal_date=TODAY), sleep_calls=sleeps)

    assert ok is False
    assert sleeps == []
    assert len(_group_sends(run)) == 1
    [loud] = _dm_messages(run)
    assert "self-heal already tried today" in loud
    assert count_rows(db, "sender_key", ROLLCALL_DIST_ID) == 1


def test_heal_from_a_previous_day_does_not_block_todays_heal(config, db):
    run = ScriptedRun([_ok(), OVERFLOW, _ok(), _ok(), _ok()])

    ok, st = _send(config, run, state_obj=State(last_heal_date=date(2026, 11, 1)))

    assert ok is True
    assert st.last_heal_date == TODAY


def test_failed_heal_alerts_loudly_without_retrying(config, tmp_path):
    # No accounts.json / account.db under signal_data_dir -> heal fails closed.
    run = ScriptedRun([_ok(), OVERFLOW, _ok()])
    sleeps: list[float] = []

    ok, st = _send(config, run, sleep_calls=sleeps)

    assert ok is False
    assert sleeps == []
    assert len(_group_sends(run)) == 1
    [loud] = _dm_messages(run)
    assert "StackOverflowError in group send; self-heal failed" in loud
    # A failed heal still uses up today's attempt (persisted).
    assert load_state(config.state_file).last_heal_date == TODAY


def test_heal_raising_unexpectedly_is_folded_into_a_failed_heal(config, monkeypatch):
    def _raise(config):
        raise RuntimeError("boom")

    monkeypatch.setattr(senderkey, "heal_group_sender_key", _raise)
    run = ScriptedRun([_ok(), OVERFLOW, _ok()])

    ok, st = _send(config, run)

    assert ok is False
    assert "self-heal failed" in _dm_messages(run)[0]
    assert st.last_heal_date == TODAY


def test_flag_off_alerts_only_and_never_opens_the_database(config, db, monkeypatch):
    cfg = replace(config, sender_key_self_heal=False)

    def _no_connect(*a, **k):
        raise AssertionError("account.db must not be opened with SIGNAL_SENDER_KEY_SELF_HEAL=0")

    monkeypatch.setattr(sqlite3, "connect", _no_connect)
    run = ScriptedRun([_ok(), OVERFLOW, _ok()])
    sleeps: list[float] = []

    ok, st = _send(cfg, run, sleep_calls=sleeps)
    monkeypatch.undo()

    assert ok is False
    assert sleeps == []
    assert st.last_heal_date is None
    [loud] = _dm_messages(run)
    assert "StackOverflowError in group send; self-heal disabled" in loud
    assert count_rows(db, "sender_key", ROLLCALL_DIST_ID) == 1
    assert list(db.parent.glob("account.db.bak-*")) == []


def test_loud_alert_and_logs_carry_no_number_group_or_distribution_id(config, db, caplog):
    caplog.set_level(logging.DEBUG, logger="signal_plus")
    run = ScriptedRun([_ok(), OVERFLOW, _ok(), OVERFLOW, _ok()])

    _send(config, run)

    text = "\n".join(_dm_messages(run)) + "\n" + caplog.text
    assert "StackOverflowError in group send" in text
    for secret in (
        ACCOUNT,
        ACCOUNT.lstrip("+"),
        RECIPIENT,
        ROLLCALL_GROUP_B64,
        ROLLCALL_GROUP_B64.rstrip("="),
        ROLLCALL_GROUP_ID.hex(),
        ROLLCALL_DIST_ID.hex(),
        base64.b64encode(ROLLCALL_DIST_ID).decode(),
    ):
        assert secret not in text, secret


# ---------------------------------------------------------------------------
# Non-overflow errors and other send paths are unchanged
# ---------------------------------------------------------------------------


def test_non_overflow_errors_keep_the_full_backoff_and_never_heal(config, db, monkeypatch):
    _forbid_heal(monkeypatch)
    results = []
    for _ in range(cli.DEFAULT_RETRY_ATTEMPTS):
        results += [_ok(), _fail("connection refused")]
    run = ScriptedRun(results)
    sleeps: list[float] = []

    ok, st = _send(config, run, sleep_calls=sleeps)

    assert ok is False
    assert sleeps == [10.0, 20.0, 40.0, 80.0]
    assert len(_group_sends(run)) == cli.DEFAULT_RETRY_ATTEMPTS
    assert st.last_heal_date is None


def test_test_send_never_heals_on_overflow(config, db, monkeypatch):
    _forbid_heal(monkeypatch)
    listing = '[{"id": "dGVzdA==", "name": "тест"}]'
    run = ScriptedRun([(0, listing, ""), _ok(), OVERFLOW])

    assert cli.run_test_send(config, run=run) is False
    assert count_rows(db, "sender_key", ROLLCALL_DIST_ID) == 1
    assert not config.state_file.exists()


def test_failed_dm_alert_with_overflow_text_never_heals(config, db, monkeypatch):
    from signal_plus import alert

    _forbid_heal(monkeypatch)
    run = ScriptedRun([OVERFLOW])

    assert alert.send_personal_alert(config, "ERROR: x", run=run) is False
    assert count_rows(db, "sender_key", ROLLCALL_DIST_ID) == 1


def test_existing_state_fields_survive_a_heal(config, db):
    save_state(config.state_file, State(installed_version="0.14.7"))
    run = ScriptedRun([_ok(), OVERFLOW, _ok(), _ok(), _ok()])

    _, st = _send(config, run, state_obj=load_state(config.state_file))

    assert load_state(config.state_file).installed_version == "0.14.7"
    assert st.installed_version == "0.14.7"
