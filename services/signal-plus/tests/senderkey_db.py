"""Test helper: a temp signal-cli data dir with a REAL sqlite account.db.

The DDL below is the real signal-cli 0.14.7 schema of the three tables the
sender-key self-heal touches (probed read-only from the production account.db
2026-11-02; journal_mode=wal, group_id 32-byte BLOB, distribution_id 16-byte
BLOB). Other tables (identity, session, ...) are represented by one ``session``
stand-in so a test can prove the heal never touches anything else.

    CREATE TABLE group_v2 (_id INTEGER PRIMARY KEY, storage_id BLOB UNIQUE, storage_record BLOB, group_id BLOB UNIQUE NOT NULL, master_key BLOB NOT NULL, group_data BLOB, distribution_id BLOB UNIQUE NOT NULL, endorsement_expiration_time INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT FALSE, profile_sharing INTEGER NOT NULL DEFAULT FALSE, permission_denied INTEGER NOT NULL DEFAULT FALSE) STRICT;
    CREATE TABLE sender_key (_id INTEGER PRIMARY KEY, address TEXT NOT NULL, device_id INTEGER NOT NULL, distribution_id BLOB NOT NULL, record BLOB NOT NULL, created_timestamp INTEGER NOT NULL, UNIQUE(address, device_id, distribution_id)) STRICT;
    CREATE TABLE sender_key_shared (_id INTEGER PRIMARY KEY, address TEXT NOT NULL, device_id INTEGER NOT NULL, distribution_id BLOB NOT NULL, timestamp INTEGER NOT NULL, UNIQUE(address, device_id, distribution_id)) STRICT;
"""
from __future__ import annotations

import base64
import json
import os
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE group_v2 (_id INTEGER PRIMARY KEY, storage_id BLOB UNIQUE, storage_record BLOB, group_id BLOB UNIQUE NOT NULL, master_key BLOB NOT NULL, group_data BLOB, distribution_id BLOB UNIQUE NOT NULL, endorsement_expiration_time INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT FALSE, profile_sharing INTEGER NOT NULL DEFAULT FALSE, permission_denied INTEGER NOT NULL DEFAULT FALSE) STRICT;
CREATE TABLE sender_key (_id INTEGER PRIMARY KEY, address TEXT NOT NULL, device_id INTEGER NOT NULL, distribution_id BLOB NOT NULL, record BLOB NOT NULL, created_timestamp INTEGER NOT NULL, UNIQUE(address, device_id, distribution_id)) STRICT;
CREATE TABLE sender_key_shared (_id INTEGER PRIMARY KEY, address TEXT NOT NULL, device_id INTEGER NOT NULL, distribution_id BLOB NOT NULL, timestamp INTEGER NOT NULL, UNIQUE(address, device_id, distribution_id)) STRICT;
CREATE TABLE session (
  _id INTEGER PRIMARY KEY,
  address TEXT NOT NULL,
  record BLOB NOT NULL
) STRICT;
"""

ACCOUNT = "+380501234567"
ACCOUNT_PATH = "748291"  # signal-cli's own opaque per-account directory id

# Chosen so the std base64 form carries both '+' and '/' (url-safe: '-', '_').
ROLLCALL_GROUP_ID = bytes([0xFB, 0xEF, 0xBE] * 10 + [0xFF, 0xFE])
OTHER_GROUP_ID = bytes(range(100, 132))
ROLLCALL_DIST_ID = bytes.fromhex("aa" * 16)
OTHER_DIST_ID = bytes.fromhex("bb" * 16)

ROLLCALL_GROUP_B64 = base64.b64encode(ROLLCALL_GROUP_ID).decode()


def account_db_path(data_dir: Path, account_path: str = ACCOUNT_PATH) -> Path:
    return data_dir / "data" / f"{account_path}.d" / "account.db"


def build_signal_data(
    data_dir: Path,
    *,
    account: str = ACCOUNT,
    groups: list[tuple[bytes, bytes]] | None = None,
    rollcall_shared_rows: int = 30,
) -> Path:
    """Create ``<data_dir>/data/accounts.json`` + ``<path>.d/account.db``.

    ``groups`` is ``[(group_id, distribution_id), ...]`` (default: the
    roll-call group and one other group). Every group gets 1 ``sender_key``
    row; the roll-call group gets ``rollcall_shared_rows`` ``sender_key_shared``
    rows, the others 2 each. Returns the account.db path.
    """
    if groups is None:
        groups = [(ROLLCALL_GROUP_ID, ROLLCALL_DIST_ID), (OTHER_GROUP_ID, OTHER_DIST_ID)]
    (data_dir / "data").mkdir(parents=True, exist_ok=True)
    (data_dir / "data" / "accounts.json").write_text(
        json.dumps(
            {
                "accounts": [
                    {"path": ACCOUNT_PATH, "environment": "LIVE", "number": account, "uuid": "u-1"},
                    {"path": "111111", "environment": "LIVE", "number": "+380509999999", "uuid": "u-2"},
                ],
                "version": 2,
            }
        ),
        encoding="utf-8",
    )
    db = account_db_path(data_dir)
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        for i, (gid, dist) in enumerate(groups):
            conn.execute(
                "INSERT INTO group_v2 (group_id, master_key, distribution_id) VALUES (?, ?, ?)",
                (gid, bytes([i]) * 32, dist),
            )
            conn.execute(
                "INSERT INTO sender_key (address, device_id, distribution_id, record, created_timestamp)"
                " VALUES (?, 1, ?, ?, 1)",
                (f"self-{i}", dist, b"record"),
            )
            shared = rollcall_shared_rows if dist == ROLLCALL_DIST_ID else 2
            for n in range(shared):
                conn.execute(
                    "INSERT INTO sender_key_shared (address, device_id, distribution_id, timestamp)"
                    " VALUES (?, 1, ?, 1)",
                    (f"member-{i}-{n}", dist),
                )
        conn.execute("INSERT INTO session (address, record) VALUES ('peer', x'01')")
        conn.commit()
    finally:
        conn.close()
    os.chmod(db, 0o600)
    return db


def count_rows(db: Path, table: str, distribution_id: bytes | None = None) -> int:
    conn = sqlite3.connect(db)
    try:
        if distribution_id is None:
            return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        return conn.execute(
            f"SELECT COUNT(*) FROM {table} WHERE distribution_id = ?", (distribution_id,)
        ).fetchone()[0]
    finally:
        conn.close()
