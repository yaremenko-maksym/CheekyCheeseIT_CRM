"""Atomic JSON state file — the source of truth for idempotency.

Requirement 3: "дата последней успешной отправки в state-файле (JSON, атомарная
запись через временный файл + os.replace). Рестарт контейнера в 07:20 не даёт
второго +."

The write path (:func:`save`) writes to a temp file in the *same* directory as
the target and then calls :func:`os.replace`, which is atomic on POSIX (same
filesystem, single rename syscall) — a process killed mid-write leaves either
the old state file intact or the new one fully written, never a half-written
JSON blob. :func:`load` reads the state back; on a corrupt or wrong-shaped
file it raises :class:`StateError` rather than silently returning a blank
state, because a silent reset here would make the daemon believe today's "+"
was never sent and send a second one.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import tempfile
from dataclasses import asdict, dataclass, fields
from pathlib import Path


class StateError(ValueError):
    """Raised when the state file exists but cannot be trusted as-is."""


@dataclass(frozen=True)
class State:
    last_success_date: dt.date | None = None
    handover_date: dt.date | None = None
    last_update_attempt_date: dt.date | None = None
    installed_version: str | None = None
    last_error: str | None = None


_DATE_FIELDS = {"last_success_date", "handover_date", "last_update_attempt_date"}


def _to_json_dict(state: State) -> dict:
    raw = asdict(state)
    for name in _DATE_FIELDS:
        value = raw[name]
        raw[name] = value.isoformat() if value is not None else None
    return raw


def _from_json_dict(raw: dict) -> State:
    known = {f.name for f in fields(State)}
    if not isinstance(raw, dict) or not known.issuperset(raw.keys()):
        raise StateError(f"state file has unexpected shape: {raw!r}")
    kwargs = dict(raw)
    for name in _DATE_FIELDS:
        value = kwargs.get(name)
        if value is not None:
            try:
                kwargs[name] = dt.date.fromisoformat(value)
            except (TypeError, ValueError) as exc:
                raise StateError(f"state field {name!r} is not an ISO date: {value!r}") from exc
    return State(**kwargs)


def load(path: Path) -> State:
    """Read the state file, or return a blank :class:`State` if it is absent."""
    path = Path(path)
    if not path.exists():
        return State()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise StateError(f"state file {path} is not valid JSON") from exc
    return _from_json_dict(raw)


def save(path: Path, state: State) -> None:
    """Atomically write ``state`` to ``path`` (temp file + ``os.replace``)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(_to_json_dict(state), fh, indent=2, sort_keys=True)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, path)
    finally:
        # If os.replace succeeded the temp file no longer exists under
        # tmp_name; if we raised/mocked before that, clean it up so repeated
        # test runs / real restarts don't leak temp files next to the state.
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)
