"""Thin subprocess wrapper around the signal-cli binary: receive / send / groups.

Requirement 4: "Перед отправкой — signal-cli receive (иначе связанное устройство
протухает)." Requirement 7's ``--groups`` mode lists groups with id.

CLI shape verified against AsamK/signal-cli source (tag ``v0.14.7``, commit
``b01b6b370dc063599a1a2b9fde0f5ff4e2d78fe8``, repo ``AsamK/signal-cli``):
  - command names — ``src/main/java/org/asamk/signal/commands/SendCommand.java``
    line 42 (``return "send";``), ``ReceiveCommand.java`` line 39
    (``return "receive";``), ``ListGroupsCommand.java`` line 31
    (``return "listGroups";``).
  - send flags — ``SendCommand.java`` line 49
    (``addArgument("-g", "--group-id", "--group")``) and line 57
    (``addArgument("-m", "--message")``).

Every call goes through an injectable ``run`` parameter (default
``subprocess.run``, always overridden in tests — AC6), and always passes an
explicit argv list, never ``shell=True``.
"""
from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass

from signal_plus.config import Config, mask_secret

DEFAULT_TIMEOUT_SECONDS = 60.0

# E.164-shaped phone number: '+' followed by 7-15 digits (ITU E.164's max is
# 15 digits after the leading '+'). Used by _sanitize_cli_text below to
# scrub numbers OTHER than the configured account too (e.g. a message
# sender's number surfaced in a `receive` error), not just the one exact
# substitution.
_PHONE_PATTERN = re.compile(r"\+\d{7,15}")


def _sanitize_cli_text(raw: str, *, account: str) -> str:
    """SR-H-1 (PR #650 security review, id 5105061153): signal-cli v0.14.7
    embeds the configured account verbatim in several of its own error
    messages (``AsamK/signal-cli`` tag ``v0.14.7``,
    ``src/main/java/org/asamk/signal/App.java`` lines 343/346/348/352 —
    ``"User " + account + " is not registered."``,
    ``"Error while checking account " + account + ": " + ...``,
    ``"Error loading state file for user " + account + ": " + ...``).

    This is the SINGLE choke point every consumer of :class:`SignalResult`
    goes through — ``cli.py``'s logs and ``state.last_error``, and
    (downstream of those) ``alert.py``'s handover email and GitHub-issue
    ``FAILED_LEGS`` — so sanitizing here, once, is what keeps the guarantee
    from silently regressing when a new caller reads ``result.output``
    instead of re-doing this substitution at each of those call sites.

    Masks the configured account via the same :func:`mask_secret` used
    elsewhere (not just delete it — requirement 1 says "маскировать", so a
    human reading a log can still recognise *which* account), then scrubs
    any remaining E.164-shaped number as a second pass, in case some other
    phone number is present — applied to EVERY line, not just the first.

    SR-M-6 (PR #650 security review round 2, id 5107124812) — correction of
    round 1's own instruction: this function used to also TRUNCATE to the
    first line here. Reproduced by the reviewer: `--groups` prints ONE
    group instead of all of them (signal_plus.cli.main_with_config prints
    this function's return value verbatim), and
    updater.is_outdated_client_error() goes blind to the trigger message
    whenever a signal-cli log line comes before it in stderr — a real
    behaviour, not a hypothetical, since stderr is signal-cli's ordinary log
    channel. Masking still needs to see every line (a number could appear
    anywhere), but DROPPING lines was never actually needed for masking —
    it was a truncation policy for LONG-LIVED storage (state.last_error and
    what derives from it), misapplied here to every caller including the
    ones that need the full text. That truncation now happens where it
    belongs — see signal_plus/cli.py's own first-line helper, used only at
    the point text is about to land in state.last_error.
    """
    if not raw:
        return raw

    def _mask_line(line: str) -> str:
        if account:
            line = line.replace(account, mask_secret(account))
        return _PHONE_PATTERN.sub("<phone-redacted>", line)

    # SR-L-8 (PR #650 security review round 3, id 5108694371): `str.splitlines()`
    # drops a trailing newline entirely (`"a\n".splitlines() == ["a"]`, not
    # `["a", ""]`), so `"\n".join(...)` over its result can never put one
    # back -- this silently ate the LAST character of any signal-cli output
    # ending in a newline (nearly all of it; that's how process output
    # normally looks). _mask_line only ever changes line CONTENT, never the
    # number of lines or where the newlines are, so re-appending exactly one
    # trailing "\n" when `raw` had one is a faithful round-trip, not a guess.
    sanitized = "\n".join(_mask_line(line) for line in raw.splitlines())
    if raw.endswith("\n"):
        sanitized += "\n"
    return sanitized


@dataclass(frozen=True)
class SignalResult:
    ok: bool
    returncode: int
    stdout: str
    stderr: str

    @property
    def output(self) -> str:
        """Combined stdout+stderr, used for substring-matching error messages
        (e.g. the outdated-client detector in :mod:`signal_plus.updater`)."""
        return f"{self.stdout}\n{self.stderr}"


def _run_signal_cli(
    config: Config,
    args: list[str],
    *,
    run=subprocess.run,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> SignalResult:
    """Invoke signal-cli via ``run`` and always return a :class:`SignalResult`
    -- never raise.

    CR-H-2 (PR #650 code review, id 5105099737): a hung `receive` during a
    network stall (`subprocess.TimeoutExpired`) or a missing/unreadable
    binary (`OSError`/`FileNotFoundError`) previously propagated straight
    out of this module, past `cli.py`'s entire retry loop and all four
    alert layers, and crashed the process -- `restart: always` would then
    pick a brand-new random slot and retry the WHOLE window, rather than
    this one attempt. This is the single choke point every caller
    (`receive`/`send_group_message`/`send_direct_message`/`list_groups`)
    goes through, so catching here treats a subprocess-level failure
    exactly like a nonzero-exit failure everywhere downstream (retry
    counting, `state.last_error`, alerting) — no separate handling needed
    at any call site.
    """
    # SR-H-4 (PR #650 security review round 3, id 5108694371): SR-M-8's
    # TMPDIR/SQLITE_TMPDIR env vars (round 2) do NOT control java.io.tmpdir
    # for this native-image binary -- reproduced against the real v0.14.7
    # binary in the exact hardening profile this PR ships: it still failed
    # ("Can't load library: /tmp/libsignal.../libsignal_jni_amd64.so")
    # trying to extract libsignal_jni under noexec /tmp regardless of what
    # those env vars were set to. Only an explicit -Djava.io.tmpdir=<dir>
    # JVM system property argument fixed it (proven: the failure changes to
    # "User ... is not registered", i.e. the library loaded and the process
    # reached the network). native-image accepts `-D` flags before the
    # subcommand, so this must be the FIRST argument after the binary path,
    # for every call site -- there is no invocation that does not need its
    # native libraries to load. TMPDIR/SQLITE_TMPDIR stay set too (they
    # still help e.g. sqlite-jdbc, see the Dockerfile), but this flag is
    # the one thing that actually controls java.io.tmpdir.
    argv = [
        str(config.signal_cli_bin),
        f"-Djava.io.tmpdir={config.signal_tmpdir}",
        "-a",
        config.signal_account,
        *args,
    ]
    try:
        completed = run(argv, capture_output=True, text=True, timeout=timeout)
    except (subprocess.SubprocessError, OSError) as exc:
        return SignalResult(
            ok=False,
            returncode=-1,
            stdout="",
            stderr=_sanitize_cli_text(str(exc), account=config.signal_account),
        )
    return SignalResult(
        ok=completed.returncode == 0,
        returncode=completed.returncode,
        stdout=_sanitize_cli_text(completed.stdout or "", account=config.signal_account),
        stderr=_sanitize_cli_text(completed.stderr or "", account=config.signal_account),
    )


def receive(
    config: Config, *, run=subprocess.run, timeout: float = DEFAULT_TIMEOUT_SECONDS
) -> SignalResult:
    """``signal-cli -a <account> receive`` — requirement 4, before every send."""
    return _run_signal_cli(config, ["receive"], run=run, timeout=timeout)


def send_group_message(
    config: Config,
    message: str,
    *,
    run=subprocess.run,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> SignalResult:
    """``signal-cli -a <account> send -g <group_id> -m <message>``."""
    return _run_signal_cli(
        config, ["send", "-g", config.signal_group_id, "-m", message], run=run, timeout=timeout
    )


def send_direct_message(
    config: Config,
    recipient: str,
    message: str,
    *,
    run=subprocess.run,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> SignalResult:
    """``signal-cli -a <account> send <recipient> -m <message>``.

    Used for the personal alert DM to ``SIGNAL_ALERT_RECIPIENT`` (requirement 10,
    alert layer 2).
    """
    return _run_signal_cli(config, ["send", recipient, "-m", message], run=run, timeout=timeout)


def list_groups(
    config: Config, *, run=subprocess.run, timeout: float = DEFAULT_TIMEOUT_SECONDS
) -> SignalResult:
    """``signal-cli -a <account> listGroups`` — requirement 7's ``--groups`` mode."""
    return _run_signal_cli(config, ["listGroups"], run=run, timeout=timeout)


def list_groups_json(
    config: Config, *, run=subprocess.run, timeout: float = DEFAULT_TIMEOUT_SECONDS
) -> SignalResult:
    """``signal-cli --output json -a <account> listGroups`` — machine-readable
    group listing for the test-send group lookup (multi-account, 2026-09-28).

    The human ``list_groups`` output above is what the owner reads by eye
    (``--groups`` / README step 3); it has no stable, documented line format to
    parse. The global ``--output json`` mode does: verified against
    ``AsamK/signal-cli`` tag ``v0.14.7``,
    ``src/main/java/org/asamk/signal/commands/ListGroupsCommand.java`` — its
    ``JsonGroup`` record's first two fields are ``String id`` (base64 group id)
    and ``String name`` (group title), and the man page states listGroups "in
    json mode ... is outputted as a list of objects". ``--output`` is a global
    option and must precede the subcommand, so it is passed ahead of
    ``listGroups`` here (``-a`` is likewise global; order among globals is
    irrelevant to signal-cli).
    """
    return _run_signal_cli(config, ["--output", "json", "listGroups"], run=run, timeout=timeout)


def find_group_id_by_name(groups_json: str, target_name: str) -> str | None:
    """Return the ``id`` of the group whose ``name`` equals ``target_name``
    (case-insensitive, surrounding whitespace ignored) in the JSON produced by
    :func:`list_groups_json`, or ``None`` if there is no such group or the
    input is not the expected JSON array.

    Fails closed (``None``) rather than raising: the caller
    (:func:`signal_plus.cli.run_test_send`) turns a ``None`` into a logged
    error + a failed test result, which is exactly the "could not find your
    «тест» group" outcome the owner needs to see when a freshly-linked account
    has no such group yet. Matching by name (not id) is the whole point of the
    2026-09-28 owner decision: the owner just creates a group called «тест» on
    the new account and never copies a group id.
    """
    try:
        groups = json.loads(groups_json)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(groups, list):
        return None
    wanted = target_name.strip().casefold()
    for group in groups:
        if not isinstance(group, dict):
            continue
        name = group.get("name")
        if isinstance(name, str) and name.strip().casefold() == wanted:
            group_id = group.get("id")
            return group_id if isinstance(group_id, str) else None
    return None
