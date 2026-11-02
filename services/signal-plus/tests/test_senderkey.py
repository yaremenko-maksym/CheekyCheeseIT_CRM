"""Tests for signal_plus.senderkey — the sender-key self-heal against a REAL
temp sqlite account.db (STRICT schema, BLOB ids; see tests/senderkey_db.py).

task-signal-plus-senderkey-self-heal: signal-cli 0.14.7 recurses unboundedly
(java.lang.StackOverflowError) sending to a v2 group whose sender_key state is
corrupt; deleting that ONE group's sender_key + sender_key_shared rows makes
Signal re-distribute a fresh key. Everything else in account.db must survive.
"""
from __future__ import annotations

import base64
import json
import logging
import sqlite3
import stat

import pytest

from signal_plus import senderkey
from signal_plus.config import Config
from tests.senderkey_db import (
    ACCOUNT,
    OTHER_DIST_ID,
    OTHER_GROUP_ID,
    ROLLCALL_DIST_ID,
    ROLLCALL_GROUP_B64,
    ROLLCALL_GROUP_ID,
    account_db_path,
    build_signal_data,
    count_rows,
)


def _config(tmp_path, *, group_id: str = ROLLCALL_GROUP_B64, account: str = ACCOUNT) -> Config:
    return Config(
        signal_account=account,
        signal_group_id=group_id,
        signal_cli_bin=tmp_path / "signal-cli",
        state_file=tmp_path / "state.json",
        signal_data_dir=tmp_path / "signal-cli-data",
    )


@pytest.fixture
def data_dir(tmp_path):
    return tmp_path / "signal-cli-data"


# ---------------------------------------------------------------------------
# is_stack_overflow_error
# ---------------------------------------------------------------------------


def test_detects_the_observed_stack_overflow_signature():
    assert senderkey.is_stack_overflow_error(
        "\nUnhandled exception: java.lang.StackOverflowError: null"
    )


@pytest.mark.parametrize("text", ["", "connection refused", "StackOverflow", "OutOfMemoryError"])
def test_other_errors_are_not_stack_overflow(text):
    assert not senderkey.is_stack_overflow_error(text)


# ---------------------------------------------------------------------------
# heal_group_sender_key — happy path
# ---------------------------------------------------------------------------


def test_heal_deletes_only_the_matched_groups_sender_key_rows(tmp_path, data_dir):
    db = build_signal_data(data_dir, rollcall_shared_rows=30)

    outcome = senderkey.heal_group_sender_key(_config(tmp_path))

    assert outcome.healed is True
    assert outcome.rows_deleted == 31  # 1 sender_key + 30 sender_key_shared
    assert count_rows(db, "sender_key", ROLLCALL_DIST_ID) == 0
    assert count_rows(db, "sender_key_shared", ROLLCALL_DIST_ID) == 0
    # The other group's rows, the groups themselves and sessions survive.
    assert count_rows(db, "sender_key", OTHER_DIST_ID) == 1
    assert count_rows(db, "sender_key_shared", OTHER_DIST_ID) == 2
    assert count_rows(db, "group_v2") == 2
    assert count_rows(db, "session") == 1


def test_heal_writes_a_backup_with_the_pre_delete_content(tmp_path, data_dir):
    db = build_signal_data(data_dir, rollcall_shared_rows=30)

    senderkey.heal_group_sender_key(_config(tmp_path))

    backups = sorted(db.parent.glob("account.db.bak-*"))
    assert len(backups) == 1
    assert count_rows(backups[0], "sender_key", ROLLCALL_DIST_ID) == 1
    assert count_rows(backups[0], "sender_key_shared", ROLLCALL_DIST_ID) == 30
    assert stat.S_IMODE(backups[0].stat().st_mode) == 0o600


def test_heal_keeps_only_the_newest_three_backups(tmp_path, data_dir):
    db = build_signal_data(data_dir)
    for stamp in ("20260101-070000", "20260102-070000", "20260103-070000", "20260104-070000"):
        (db.parent / f"account.db.bak-{stamp}").write_bytes(b"old")
    unrelated = db.parent / "other.db.bak-20200101-000000"  # not this DB's backup name
    unrelated.touch()

    senderkey.heal_group_sender_key(_config(tmp_path))

    names = sorted(p.name for p in db.parent.glob("account.db.bak-*"))
    assert len(names) == 3
    assert "account.db.bak-20260104-070000" in names
    assert "account.db.bak-20260103-070000" in names
    assert "account.db.bak-20260101-070000" not in names
    assert "account.db.bak-20260102-070000" not in names
    assert unrelated.exists()


@pytest.mark.parametrize(
    "encoded",
    [
        base64.b64encode(ROLLCALL_GROUP_ID).decode(),
        base64.b64encode(ROLLCALL_GROUP_ID).decode().rstrip("="),
        base64.urlsafe_b64encode(ROLLCALL_GROUP_ID).decode(),
        base64.urlsafe_b64encode(ROLLCALL_GROUP_ID).decode().rstrip("="),
    ],
)
def test_group_id_matches_std_urlsafe_and_unpadded_base64(tmp_path, data_dir, encoded):
    std = base64.b64encode(ROLLCALL_GROUP_ID).decode()
    assert "+" in std and "/" in std  # so the url-safe variants really differ
    db = build_signal_data(data_dir)

    outcome = senderkey.heal_group_sender_key(_config(tmp_path, group_id=encoded))

    assert outcome.healed is True
    assert count_rows(db, "sender_key", ROLLCALL_DIST_ID) == 0


def test_heal_with_no_sender_key_rows_still_succeeds_with_zero(tmp_path, data_dir):
    db = build_signal_data(data_dir, rollcall_shared_rows=0)
    conn = sqlite3.connect(db)
    conn.execute("DELETE FROM sender_key WHERE distribution_id = ?", (ROLLCALL_DIST_ID,))
    conn.commit()
    conn.close()

    outcome = senderkey.heal_group_sender_key(_config(tmp_path))

    assert outcome.healed is True
    assert outcome.rows_deleted == 0


# ---------------------------------------------------------------------------
# heal_group_sender_key — fail closed, never raise
# ---------------------------------------------------------------------------


def _assert_untouched(db):
    assert count_rows(db, "sender_key", ROLLCALL_DIST_ID) == 1
    assert count_rows(db, "sender_key_shared", ROLLCALL_DIST_ID) == 30
    assert list(db.parent.glob("account.db.bak-*")) == []


def test_fails_closed_when_no_group_matches(tmp_path, data_dir):
    db = build_signal_data(data_dir)
    other = base64.b64encode(bytes([7]) * 32).decode()

    outcome = senderkey.heal_group_sender_key(_config(tmp_path, group_id=other))

    assert outcome.healed is False
    assert outcome.rows_deleted == 0
    _assert_untouched(db)


def test_fails_closed_when_two_groups_match(tmp_path, data_dir):
    # STRICT/UNIQUE make a true duplicate impossible in signal-cli's schema;
    # simulate a drifted schema without the UNIQUE constraint.
    db = build_signal_data(data_dir)
    conn = sqlite3.connect(db)
    conn.executescript(
        "ALTER TABLE group_v2 RENAME TO group_v2_old;"
        "CREATE TABLE group_v2 (_id INTEGER PRIMARY KEY, group_id BLOB NOT NULL,"
        " distribution_id BLOB NOT NULL) STRICT;"
        "INSERT INTO group_v2 (group_id, distribution_id) SELECT group_id, distribution_id FROM group_v2_old;"
    )
    conn.execute(
        "INSERT INTO group_v2 (group_id, distribution_id) VALUES (?, ?)", (ROLLCALL_GROUP_ID, OTHER_DIST_ID)
    )
    conn.commit()
    conn.close()

    outcome = senderkey.heal_group_sender_key(_config(tmp_path))

    assert outcome.healed is False
    _assert_untouched(db)
    assert count_rows(db, "sender_key", OTHER_DIST_ID) == 1


@pytest.mark.parametrize("bad", ["group.abc123==", "not base64 !!", base64.b64encode(b"short").decode()])
def test_fails_closed_on_a_group_id_that_is_not_32_bytes_of_base64(tmp_path, data_dir, bad):
    db = build_signal_data(data_dir)

    outcome = senderkey.heal_group_sender_key(_config(tmp_path, group_id=bad))

    assert outcome.healed is False
    _assert_untouched(db)


def test_fails_closed_when_the_account_is_not_in_accounts_json(tmp_path, data_dir):
    db = build_signal_data(data_dir)

    outcome = senderkey.heal_group_sender_key(_config(tmp_path, account="+380507777777"))

    assert outcome.healed is False
    _assert_untouched(db)


def test_fails_closed_when_accounts_json_is_missing(tmp_path, data_dir):
    outcome = senderkey.heal_group_sender_key(_config(tmp_path))
    assert outcome.healed is False
    assert not data_dir.exists()


@pytest.mark.parametrize(
    "payload", ["{not json", json.dumps({"accounts": "nope"}), json.dumps([1, 2]), json.dumps({"accounts": [{"number": ACCOUNT, "path": "../x"}]})]
)
def test_fails_closed_on_malformed_accounts_json(tmp_path, data_dir, payload):
    build_signal_data(data_dir)
    (data_dir / "data" / "accounts.json").write_text(payload, encoding="utf-8")

    outcome = senderkey.heal_group_sender_key(_config(tmp_path))

    assert outcome.healed is False


def test_fails_closed_when_the_account_db_file_is_missing(tmp_path, data_dir):
    db = build_signal_data(data_dir)
    db.unlink()
    for side in db.parent.glob("account.db-*"):
        side.unlink()

    outcome = senderkey.heal_group_sender_key(_config(tmp_path))

    assert outcome.healed is False
    # sqlite3.connect would CREATE an empty file -- it must never be opened.
    assert not db.exists()


def test_fails_closed_without_signal_data_dir(tmp_path):
    cfg = Config(
        signal_account=ACCOUNT,
        signal_group_id=ROLLCALL_GROUP_B64,
        signal_cli_bin=tmp_path / "signal-cli",
        state_file=tmp_path / "state.json",
    )
    assert senderkey.heal_group_sender_key(cfg).healed is False


def test_never_raises_on_a_corrupt_database_file(tmp_path, data_dir):
    db = build_signal_data(data_dir)
    for side in db.parent.glob("account.db-*"):
        side.unlink()
    db.write_bytes(b"this is not a sqlite database at all" * 100)

    outcome = senderkey.heal_group_sender_key(_config(tmp_path))

    assert outcome.healed is False
    assert "DatabaseError" in outcome.reason


def test_never_raises_when_the_backup_cannot_be_written(tmp_path, data_dir, monkeypatch):
    db = build_signal_data(data_dir)

    def _boom(*a, **k):
        raise PermissionError("read-only volume")

    monkeypatch.setattr(senderkey.shutil, "copy2", _boom)

    outcome = senderkey.heal_group_sender_key(_config(tmp_path))

    assert outcome.healed is False
    # No backup -> no delete.
    assert count_rows(db, "sender_key", ROLLCALL_DIST_ID) == 1


# ---------------------------------------------------------------------------
# No secrets in the outcome or the logs
# ---------------------------------------------------------------------------


def test_reason_and_logs_never_carry_number_group_or_distribution_id(tmp_path, data_dir, caplog):
    build_signal_data(data_dir)
    caplog.set_level(logging.DEBUG, logger="signal_plus")

    outcomes = [
        senderkey.heal_group_sender_key(_config(tmp_path)),
        senderkey.heal_group_sender_key(_config(tmp_path, account="+380507777777")),
        senderkey.heal_group_sender_key(_config(tmp_path, group_id=base64.b64encode(OTHER_GROUP_ID[::-1]).decode())),
    ]

    text = caplog.text + "\n".join(o.reason for o in outcomes)
    forbidden = [
        ACCOUNT,
        ACCOUNT.lstrip("+"),
        "+380507777777",
        ROLLCALL_GROUP_B64,
        ROLLCALL_GROUP_B64.rstrip("="),
        ROLLCALL_GROUP_ID.hex(),
        ROLLCALL_DIST_ID.hex(),
        base64.b64encode(ROLLCALL_DIST_ID).decode(),
    ]
    for secret in forbidden:
        assert secret not in text, secret
