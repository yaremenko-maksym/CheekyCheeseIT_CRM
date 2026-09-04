"""Shared fixtures — AC6 enforcement: no real signal-cli exec, no real network.

AC6 (task-signal-plus-service.md): "Ни одного реального вызова signal-cli и ни
одного сетевого вызова в тестах — проверяется тем, что PATH в тестах пуст и
сокеты запрещены (фикстура)."

Both fixtures are ``autouse=True`` so every test in this suite is covered even
if an individual test forgets to inject a fake ``run``/``opener`` — defense in
depth on top of the per-call dependency injection each module already uses.
"""
from __future__ import annotations

import socket

import pytest


class NetworkDisabledInTestsError(RuntimeError):
    """Raised if test code (or the code under test) opens a real socket."""


@pytest.fixture(autouse=True)
def block_real_sockets(monkeypatch):
    def _forbidden_socket(*args, **kwargs):
        raise NetworkDisabledInTestsError(
            "socket.socket() was called during a test run — AC6 forbids any "
            "real network access from the test suite. Inject a fake instead."
        )

    monkeypatch.setattr(socket, "socket", _forbidden_socket)


@pytest.fixture(autouse=True)
def empty_path(monkeypatch):
    # Belt-and-suspenders: if a test forgets to inject a fake `run` callable
    # and code falls through to the real subprocess.run, an empty PATH means
    # the OS cannot find a real `signal-cli`/`gpg`/`curl` binary to execute —
    # the call fails loudly (FileNotFoundError) instead of silently succeeding
    # against whatever happens to be installed on the machine running the tests.
    monkeypatch.setenv("PATH", "")
