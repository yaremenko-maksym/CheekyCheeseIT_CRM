"""Sender-key self-heal for signal-cli 0.14.7's group-send StackOverflowError.

signal-cli 0.14.7 (native image) recurses unboundedly when sending to a v2
group whose ``sender_key`` state is corrupt (upstream AsamK/signal-cli#2101,
#2113): every send attempt fails with ``java.lang.StackOverflowError`` and
retrying never helps. The fix proven on 2026-10-03 and 2026-11-02 is to delete
that ONE group's ``sender_key`` + ``sender_key_shared`` rows from the
account's ``account.db``; Signal re-distributes a fresh sender key on the next
send by itself. Membership, master key, identities and sessions stay untouched.

Pure stdlib. Fails closed (``healed=False``) on anything it cannot verify, and
never raises. Logs and ``HealOutcome.reason`` carry only fixed labels, counts,
exception class names and the masked account: never a phone number, group id,
distribution id or key material.
"""
from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

from signal_plus.config import Config

logger = logging.getLogger("signal_plus")

STACK_OVERFLOW_SIGNATURE = "StackOverflowError"
GROUP_ID_BYTES = 32
BACKUPS_KEPT = 3
SQLITE_TIMEOUT_SECONDS = 10.0
_ACCOUNT_PATH = re.compile(r"[0-9]+")


@dataclass(frozen=True)
class HealOutcome:
    healed: bool
    reason: str
    rows_deleted: int = 0


def is_stack_overflow_error(output: str) -> bool:
    return STACK_OVERFLOW_SIGNATURE in (output or "")


def _decode_group_id(raw: str) -> bytes | None:
    """signal-cli prints group ids as standard base64; accept url-safe and
    unpadded too. Anything that is not exactly 32 bytes is rejected."""
    text = (raw or "").strip().replace("-", "+").replace("_", "/")
    text += "=" * (-len(text) % 4)
    try:
        decoded = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        return None
    return decoded if len(decoded) == GROUP_ID_BYTES else None


def _locate_account_db(data_dir: Path, account: str) -> Path | None:
    raw = json.loads((data_dir / "data" / "accounts.json").read_text(encoding="utf-8"))
    entries = raw.get("accounts") if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        return None
    matches = [e for e in entries if isinstance(e, dict) and e.get("number") == account]
    if len(matches) != 1:
        return None
    path = matches[0].get("path")
    # signal-cli's per-account dir id is digits only; anything else could
    # point outside data/ -- never guess.
    if not isinstance(path, str) or not _ACCOUNT_PATH.fullmatch(path):
        return None
    return data_dir / "data" / f"{path}.d" / "account.db"


def _backup(conn: sqlite3.Connection, db: Path) -> None:
    """Consistent snapshot (sqlite backup API, WAL included) into a file that
    is created 0600 from the first byte: it holds key material, so it must
    never exist with a wider mode, not even briefly."""
    backup = db.with_name(f"{db.name}.bak-{time.strftime('%Y%m%d-%H%M%S')}")
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
    dest = sqlite3.connect(backup)
    try:
        conn.backup(dest)
    finally:
        dest.close()
    for stale in sorted(db.parent.glob(f"{db.name}.bak-*"))[:-BACKUPS_KEPT]:
        stale.unlink()


def _heal(config: Config) -> HealOutcome:
    if config.signal_data_dir is None:
        return HealOutcome(False, "SIGNAL_DATA_DIR not configured")
    group_id = _decode_group_id(config.signal_group_id)
    if group_id is None:
        return HealOutcome(False, "SIGNAL_GROUP_ID is not a 32-byte base64 group id")
    data_dir = Path(config.signal_data_dir)
    if not (data_dir / "data" / "accounts.json").is_file():
        return HealOutcome(False, "accounts.json not found")
    db = _locate_account_db(data_dir, config.signal_account)
    if db is None:
        return HealOutcome(False, "account not found (exactly once) in accounts.json")
    if not db.is_file():
        return HealOutcome(False, "account.db not found")

    # mode=rw: never create a database that is not there.
    conn = sqlite3.connect(f"{db.resolve().as_uri()}?mode=rw", uri=True, timeout=SQLITE_TIMEOUT_SECONDS)
    try:
        busy = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]
        if busy:
            return HealOutcome(False, "WAL checkpoint busy (database in use)")
        rows = conn.execute("SELECT distribution_id FROM group_v2 WHERE group_id = ?", (group_id,)).fetchall()
        if len(rows) != 1 or not isinstance(rows[0][0], bytes):
            return HealOutcome(False, f"expected exactly 1 matching group, found {len(rows)}")
        distribution_id = rows[0][0]

        _backup(conn, db)

        with conn:  # one transaction: both deletes or neither
            sk = conn.execute("DELETE FROM sender_key WHERE distribution_id = ?", (distribution_id,)).rowcount
            shared = conn.execute(
                "DELETE FROM sender_key_shared WHERE distribution_id = ?", (distribution_id,)
            ).rowcount
    finally:
        conn.close()

    logger.info(
        "[%s] sender-key self-heal: deleted %d sender_key + %d sender_key_shared rows (backup kept)",
        config.masked_account(),
        sk,
        shared,
    )
    return HealOutcome(True, "healed", sk + shared)


def heal_group_sender_key(config: Config) -> HealOutcome:
    """Delete the roll-call group's sender-key rows from this account's
    account.db, after a WAL checkpoint and a backup next to the DB. Never raises."""
    try:
        outcome = _heal(config)
    except Exception as exc:  # sqlite3.Error, OSError, bad JSON, ...: class name only, never the message
        outcome = HealOutcome(False, f"{type(exc).__name__} during self-heal")
    if not outcome.healed:
        logger.error("[%s] sender-key self-heal not performed: %s", config.masked_account(), outcome.reason)
    return outcome
