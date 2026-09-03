"""Tests for signal_plus.cli — modes, chunked sleep, retries, update integration.

Requirement 6: "Сон до цели кусками ~5 минут, не одним sleep; после каждого
куска пересчёт «сейчас»." Requirement 7: "--groups / --now / --once / демон
по умолчанию." All time in these tests is driven by a FakeClock so nothing
here sleeps for real; ``subprocess.run`` and network are always fake (AC6,
plus the suite-wide conftest.py fixtures).
"""
from __future__ import annotations

import json
import subprocess
from dataclasses import replace
from datetime import date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from signal_plus import cli
from signal_plus.config import Config
from signal_plus.state import State, load as load_state, save as save_state

KYIV_TZ_OFFSET_SEPT = timedelta(hours=3)  # Europe/Kyiv is EEST (UTC+3) in September


class FakeClock:
    """A controllable clock: sleep_fn advances the same clock now_fn reads."""

    def __init__(self, start: datetime):
        self.current = start
        self.sleep_calls: list[float] = []

    def now_fn(self) -> datetime:
        return self.current

    def sleep_fn(self, seconds: float) -> None:
        self.sleep_calls.append(seconds)
        self.current = self.current + timedelta(seconds=seconds)


ZERO_RNG = SimpleNamespace(uniform=lambda a, b: 0.0)  # always picks window_start exactly, 07:00:00 Kyiv


def _kyiv(y, m, d, h, mi, s=0) -> datetime:
    from zoneinfo import ZoneInfo

    return datetime(y, m, d, h, mi, s, tzinfo=ZoneInfo("Europe/Kyiv"))


@pytest.fixture
def config(tmp_path) -> Config:
    return Config(
        signal_account="+380501234567",
        signal_group_id="group.abc123==",
        signal_cli_bin=tmp_path / "signal-cli",
        state_file=tmp_path / "state.json",
    )


class ScriptedRun:
    """Fake subprocess.run: pop scripted (returncode, stdout, stderr) per call,
    recording every argv it was called with."""

    def __init__(self, results):
        self.results = list(results)
        self.calls: list[list[str]] = []

    def __call__(self, argv, **kwargs):
        self.calls.append(list(argv))
        if not self.results:
            raise AssertionError(f"ScriptedRun ran out of scripted results at call {argv}")
        returncode, stdout, stderr = self.results.pop(0)
        return subprocess.CompletedProcess(argv, returncode, stdout, stderr)

    def command_calls(self, keyword: str) -> list[list[str]]:
        return [c for c in self.calls if keyword in c]


def _ok(stdout="ok"):
    return (0, stdout, "")


def _fail(stderr="boom"):
    return (1, "", stderr)


# ---------------------------------------------------------------------------
# --once mode: idempotency, receive-before-send, retries/backoff, lateness
# ---------------------------------------------------------------------------


def test_once_sends_exactly_once_when_not_yet_sent_today(config):
    clock = FakeClock(_kyiv(2026, 9, 3, 6, 0))  # well before the window
    run = ScriptedRun([_ok(), _ok()])  # receive, send

    outcome = cli.run_cycle(config, now_fn=clock.now_fn, sleep_fn=clock.sleep_fn, rng=ZERO_RNG, run=run)

    assert outcome.sent is True
    send_calls = run.command_calls("send")
    assert len(send_calls) == 1
    assert "+" in send_calls[0]
    st = load_state(config.state_file)
    assert st.last_success_date == date(2026, 9, 3)


def test_receive_is_called_before_send_on_every_attempt(config):
    clock = FakeClock(_kyiv(2026, 9, 3, 6, 0))
    run = ScriptedRun([_ok(), _ok()])
    cli.run_cycle(config, now_fn=clock.now_fn, sleep_fn=clock.sleep_fn, rng=ZERO_RNG, run=run)
    assert run.calls[0][-1] == "receive"
    assert run.calls[1][-5] == "send"  # [..., "send", "-g", group_id, "-m", message]


def test_second_run_same_day_is_idempotent_zero_sends(config):
    clock = FakeClock(_kyiv(2026, 9, 3, 6, 0))
    run1 = ScriptedRun([_ok(), _ok()])
    cli.run_cycle(config, now_fn=clock.now_fn, sleep_fn=clock.sleep_fn, rng=ZERO_RNG, run=run1)

    # Simulate a container restart at 07:20 -- state on disk already shows
    # today's send as done.
    clock2 = FakeClock(_kyiv(2026, 9, 3, 7, 20))
    run2 = ScriptedRun([])  # no scripted results at all: any call is an error
    outcome = cli.run_cycle(config, now_fn=clock2.now_fn, sleep_fn=clock2.sleep_fn, rng=ZERO_RNG, run=run2)

    assert outcome.sent is False
    assert outcome.reason == "already-sent"
    assert run2.calls == []


def test_restart_before_any_send_still_sends_once(config):
    # First process picks a slot, crashes before sending (simulated by just
    # not running it at all -- no state was ever written).
    clock = FakeClock(_kyiv(2026, 9, 3, 7, 20))  # restart mid-window
    run = ScriptedRun([_ok(), _ok()])
    outcome = cli.run_cycle(config, now_fn=clock.now_fn, sleep_fn=clock.sleep_fn, rng=ZERO_RNG, run=run)
    assert outcome.sent is True
    assert load_state(config.state_file).last_success_date == date(2026, 9, 3)


def test_sleep_happens_in_chunks_not_one_long_sleep(config):
    # Slot is 07:00:00 (ZERO_RNG); starting at 06:00 means ~1h to wait.
    clock = FakeClock(_kyiv(2026, 9, 3, 6, 0))
    run = ScriptedRun([_ok(), _ok()])
    cli.run_cycle(config, now_fn=clock.now_fn, sleep_fn=clock.sleep_fn, rng=ZERO_RNG, run=run)
    assert len(clock.sleep_calls) > 1, "a full hour must not be a single sleep call"
    assert all(s <= 300 for s in clock.sleep_calls), "each chunk must be capped at ~5 minutes"


def test_late_send_after_0745_logs_warning(config, caplog):
    import logging

    clock = FakeClock(_kyiv(2026, 9, 3, 7, 50))  # already past window_end (07:45)
    run = ScriptedRun([_ok(), _ok()])
    with caplog.at_level(logging.WARNING, logger="signal_plus"):
        outcome = cli.run_cycle(config, now_fn=clock.now_fn, sleep_fn=clock.sleep_fn, rng=ZERO_RNG, run=run)
    assert outcome.sent is True
    assert any("late" in r.message.lower() for r in caplog.records if r.levelno == logging.WARNING)


def _with_email(config: Config) -> Config:
    return replace(config, resend_api_key="re_test_key", alert_email_to="owner@example.com")


def test_before_0800_no_email_yet_attempts_continue(config, tmp_path):
    # Task file test list: "07:59 без отправки -> письма нет, попытки идут."
    # 07:59 is past window_end (07:45, so send is attempted with a WARNING)
    # but before the 08:00 handover cutoff -- the daemon must still be
    # trying, not giving up.
    clock = FakeClock(_kyiv(2026, 9, 3, 7, 59))
    email_calls = []

    def fail_http_post(url, *, headers, body):
        email_calls.append(url)
        return 200, b"{}"

    run = ScriptedRun([_ok(), _ok()])  # receive, send -- succeeds
    outcome = cli.run_cycle(
        _with_email(config),
        now_fn=clock.now_fn,
        sleep_fn=clock.sleep_fn,
        rng=ZERO_RNG,
        run=run,
        http_post=fail_http_post,
        alert_script_path=tmp_path / "post-merge-alert.sh",
    )
    assert outcome.sent is True
    assert email_calls == []


def test_at_0800_cutoff_sends_email_exactly_once_and_refuses_plus(config, caplog, tmp_path):
    import logging

    clock = FakeClock(_kyiv(2026, 9, 3, 8, 0))  # exactly the default handover cutoff
    script = tmp_path / "post-merge-alert.sh"
    run = ScriptedRun([_ok()])  # only the issue-alert script call is expected
    email_calls = []

    def fake_run(argv, **kwargs):
        run.calls.append(list(argv))
        return subprocess.CompletedProcess(argv, 0, "", "")

    def fake_http_post(url, *, headers, body):
        email_calls.append((url, headers, body))
        return 200, b"{}"

    with caplog.at_level(logging.ERROR, logger="signal_plus"):
        outcome = cli.run_cycle(
            _with_email(config),
            now_fn=clock.now_fn,
            sleep_fn=clock.sleep_fn,
            rng=ZERO_RNG,
            run=fake_run,
            http_post=fake_http_post,
            alert_script_path=script,
        )

    assert outcome.sent is False
    assert outcome.reason == "cutoff"
    assert any(r.levelno == logging.ERROR for r in caplog.records)
    assert len(email_calls) == 1
    st = load_state(config.state_file)
    assert st.handover_date == date(2026, 9, 3)
    assert st.last_success_date is None
    # No `send` (the "+" group message) was ever attempted past cutoff.
    assert not any("send" in c and "+" in c for c in run.calls)


def test_restart_after_handover_sends_neither_email_nor_plus_again(config, tmp_path):
    # Task file test list: "далее ни «+», ни второго письма при рестарте" --
    # a restart at 08:20 after handover_date is already set for today.
    save_state(config.state_file, State(handover_date=date(2026, 9, 3)))
    clock = FakeClock(_kyiv(2026, 9, 3, 8, 20))
    run = ScriptedRun([])

    def fail_http_post(url, *, headers, body):
        raise AssertionError("must not send a second handover email on restart")

    outcome = cli.run_cycle(
        _with_email(config),
        now_fn=clock.now_fn,
        sleep_fn=clock.sleep_fn,
        rng=ZERO_RNG,
        run=run,
        http_post=fail_http_post,
        alert_script_path=tmp_path / "post-merge-alert.sh",
    )
    assert outcome.sent is False
    assert outcome.reason == "already-given-up"
    assert run.calls == []


def test_0800_but_plus_already_sent_at_0730_sends_no_email(config, tmp_path):
    # Task file test list: "08:00, но «+» ушёл в 07:30 -> письма нет."
    save_state(config.state_file, State(last_success_date=date(2026, 9, 3)))
    clock = FakeClock(_kyiv(2026, 9, 3, 8, 0))
    run = ScriptedRun([])

    def fail_http_post(url, *, headers, body):
        raise AssertionError("must not send a handover email when today's + already succeeded")

    outcome = cli.run_cycle(
        _with_email(config),
        now_fn=clock.now_fn,
        sleep_fn=clock.sleep_fn,
        rng=ZERO_RNG,
        run=run,
        http_post=fail_http_post,
        alert_script_path=tmp_path / "post-merge-alert.sh",
    )
    assert outcome.sent is False
    assert outcome.reason == "already-sent"
    assert run.calls == []


def test_resend_error_at_cutoff_still_fires_the_other_alert_layers(config, caplog, tmp_path):
    # Task file test list: "Resend вернул ошибку -> ERROR, остальные слои
    # алерта (п. 10) всё равно срабатывают."
    import logging

    clock = FakeClock(_kyiv(2026, 9, 3, 8, 0))
    script = tmp_path / "post-merge-alert.sh"
    issue_calls = []

    def fake_run(argv, **kwargs):
        if str(script) in argv:
            issue_calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, "", "")

    def raising_http_post(url, *, headers, body):
        raise OSError("Resend unreachable")

    with caplog.at_level(logging.ERROR, logger="signal_plus"):
        outcome = cli.run_cycle(
            _with_email(config),
            now_fn=clock.now_fn,
            sleep_fn=clock.sleep_fn,
            rng=ZERO_RNG,
            run=fake_run,
            http_post=raising_http_post,
            alert_script_path=script,
        )

    assert outcome.reason == "cutoff"
    assert len(issue_calls) == 1  # layer 3 still fired despite the email layer failing
    assert any(r.levelno == logging.ERROR for r in caplog.records)


def test_handover_email_reason_carries_the_last_recorded_error(config, tmp_path):
    # Task file: email text is "... Причина: <последняя ошибка> ...". Rather
    # than simulating enough elapsed retry-exhaustion cycles to actually
    # reach 08:00 (each cycle costs 450s of simulated backoff+chunk sleep --
    # ~8 of them to cross an hour from a 07:00 start), pre-populate state
    # with a realistic last_error and put the clock at the cutoff directly:
    # this isolates and verifies the wiring (does the cutoff branch read
    # state.last_error and thread it into the email) rather than re-testing
    # that retries eventually reach 08:00, which other tests already cover.
    save_state(config.state_file, State(last_error="connection refused: host unreachable"))
    clock = FakeClock(_kyiv(2026, 9, 3, 8, 0))
    email_calls = []

    def fake_http_post(url, *, headers, body):
        email_calls.append(body)
        return 200, b"{}"

    def fake_run(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 0, "", "")

    outcome = cli.run_cycle(
        _with_email(config),
        now_fn=clock.now_fn,
        sleep_fn=clock.sleep_fn,
        rng=ZERO_RNG,
        run=fake_run,
        http_post=fake_http_post,
        alert_script_path=tmp_path / "post-merge-alert.sh",
    )
    assert outcome.sent is False and outcome.reason == "cutoff"
    assert len(email_calls) == 1
    payload = json.loads(email_calls[0])
    assert "connection refused: host unreachable" in payload["text"]


def test_issue_alert_failed_legs_is_a_constant_never_the_raw_last_error(config, tmp_path):
    # SR-H-1 (security review 5105061153) fix instruction: "в _issue_alert_env
    # не передавать reason в FAILED_LEGS вообще -- константа, как в workflow"
    # -- post-merge-alert.sh's other callers (ci/deploy/backup/mutation) all
    # pass a short FIXED string here (e.g. 'build/push/SSH-deploy'), never a
    # dynamic error message; this issue only fails open to the PUBLIC repo
    # (see that script's own "ГРАНИЦА КАНАЛА" comment), so FAILED_LEGS must
    # never carry log/error content, masked or not.
    save_state(config.state_file, State(last_error=f"boom near {config.signal_account}"))
    clock = FakeClock(_kyiv(2026, 9, 3, 8, 0))
    script = tmp_path / "post-merge-alert.sh"
    captured_envs = []

    def fake_run(argv, **kwargs):
        if str(script) in argv:
            captured_envs.append(kwargs.get("env") or {})
        return subprocess.CompletedProcess(argv, 0, "", "")

    cli.run_cycle(
        _with_email(config),
        now_fn=clock.now_fn,
        sleep_fn=clock.sleep_fn,
        rng=ZERO_RNG,
        run=fake_run,
        http_post=lambda *a, **k: (200, b"{}"),
        alert_script_path=script,
    )

    assert len(captured_envs) == 1
    failed_legs = captured_envs[0].get("FAILED_LEGS")
    assert failed_legs is not None
    assert config.signal_account not in failed_legs
    assert "boom" not in failed_legs  # never echoes the dynamic reason text at all


def test_issue_alert_failed_legs_is_a_constant_on_retry_exhaustion_too(config, tmp_path):
    # Pinning test, not a red/green leak fix like the sibling test above --
    # this call site was never actually reachable by dynamic text (`reason`
    # here has always been the hardcoded literal "all retry attempts
    # failed", independent of what the retries' own stderr said). It stays
    # green before AND after the _issue_alert_env refactor; it exists to
    # catch a FUTURE regression if this call site is ever changed to thread
    # a dynamic reason through, the way the cutoff call site used to.
    clock = FakeClock(_kyiv(2026, 9, 3, 7, 0))
    script = tmp_path / "post-merge-alert.sh"
    captured_envs = []

    results = []
    for _ in range(cli.DEFAULT_RETRY_ATTEMPTS):
        results += [_ok(), _fail(f"refused by {config.signal_account}")]

    def fake_run(argv, **kwargs):
        if str(script) in argv:
            captured_envs.append(kwargs.get("env") or {})
            return subprocess.CompletedProcess(argv, 0, "", "")
        returncode, stdout, stderr = results.pop(0)
        return subprocess.CompletedProcess(argv, returncode, stdout, stderr)

    # Stop run_cycle's outer while-loop after the first post-exhaustion
    # alert instead of letting it retry forever in simulated time.
    class _StopAfterAlert(Exception):
        pass

    def sleep_fn(seconds: float) -> None:
        if seconds == cli.DEFAULT_SLEEP_CHUNK_SECONDS and captured_envs:
            raise _StopAfterAlert()
        clock.sleep_fn(seconds)

    with pytest.raises(_StopAfterAlert):
        cli.run_cycle(
            config,
            now_fn=clock.now_fn,
            sleep_fn=sleep_fn,
            rng=ZERO_RNG,
            run=fake_run,
            alert_script_path=script,
        )

    assert len(captured_envs) == 1
    failed_legs = captured_envs[0].get("FAILED_LEGS")
    assert failed_legs is not None
    assert config.signal_account not in failed_legs
    assert "refused by" not in failed_legs


def test_after_cutoff_second_run_same_day_noops(config, tmp_path):
    save_state(config.state_file, State(handover_date=date(2026, 9, 3)))
    clock = FakeClock(_kyiv(2026, 9, 3, 8, 30))
    run = ScriptedRun([])
    outcome = cli.run_cycle(
        config, now_fn=clock.now_fn, sleep_fn=clock.sleep_fn, rng=ZERO_RNG, run=run,
        alert_script_path=tmp_path / "post-merge-alert.sh",
    )
    assert outcome.sent is False
    assert outcome.reason == "already-given-up"
    assert run.calls == []


def test_retries_backoff_grows_and_alerts_after_exhaustion(config, tmp_path):
    # receive, send(fail) x N, then cutoff never reached (started early) --
    # this test asserts the RETRY loop's own backoff grows within one attempt
    # cycle, independent of the daily cutoff.
    clock = FakeClock(_kyiv(2026, 9, 3, 7, 0))
    results = []
    for _ in range(cli.DEFAULT_RETRY_ATTEMPTS):
        results.append(_ok())  # receive
        results.append(_fail("connection refused"))  # send
    results.append(_ok())  # the post-exhaustion issue-alert script call
    run = ScriptedRun(results)

    ok, _new_state = cli.send_with_retries_and_update(
        config,
        "+",
        State(),
        today=date(2026, 9, 3),
        run=run,
        sleep_fn=clock.sleep_fn,
        http_get=lambda url: b"{}",
        tmp_dir=tmp_path / "downloads",
    )
    assert ok is False
    backoff_sleeps = clock.sleep_calls
    assert len(backoff_sleeps) == cli.DEFAULT_RETRY_ATTEMPTS - 1
    assert backoff_sleeps == sorted(backoff_sleeps), "backoff must grow, not shrink or stay flat"
    assert backoff_sleeps[-1] > backoff_sleeps[0]


def test_full_retry_exhaustion_before_cutoff_alerts_and_keeps_looping(config, tmp_path):
    # Attempt 1 exhausts retries and fails; the outer cycle loop then waits a
    # chunk and tries again, and attempt 2 succeeds.
    clock = FakeClock(_kyiv(2026, 9, 3, 7, 0))
    results = []
    for _ in range(cli.DEFAULT_RETRY_ATTEMPTS):
        results += [_ok(), _fail("still down")]
    results.append(_ok())  # issue-alert script call after exhaustion
    results += [_ok(), _ok()]  # second attempt: receive, send -- succeeds
    run = ScriptedRun(results)

    outcome = cli.run_cycle(
        config,
        now_fn=clock.now_fn,
        sleep_fn=clock.sleep_fn,
        rng=ZERO_RNG,
        run=run,
        alert_script_path=tmp_path / "post-merge-alert.sh",
    )
    assert outcome.sent is True


# ---------------------------------------------------------------------------
# Auto-update integration inside the retry loop
# ---------------------------------------------------------------------------


def _release_payload():
    # URL matches the real GitHub Releases API browser_download_url shape
    # (SR-M-1, security review 5105061153, validates this exact prefix).
    return json.dumps(
        {
            "tag_name": "v0.14.7",
            "assets": [
                {
                    "name": "signal-cli-0.14.7-Linux-native.tar.gz",
                    "browser_download_url": "https://github.com/AsamK/signal-cli/releases/download/v0.14.7/signal-cli-0.14.7-Linux-native.tar.gz",
                },
                {
                    "name": "signal-cli-0.14.7-Linux-native.tar.gz.asc",
                    "browser_download_url": "https://github.com/AsamK/signal-cli/releases/download/v0.14.7/signal-cli-0.14.7-Linux-native.tar.gz.asc",
                },
            ],
        }
    ).encode()


def _make_native_archive_bytes() -> bytes:
    import io
    import tarfile

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        info = tarfile.TarInfo(name="signal-cli")
        content = b"new-binary"
        info.size = len(content)
        info.mode = 0o755
        tar.addfile(info, io.BytesIO(content))
    return buf.getvalue()


def test_outdated_client_error_triggers_update_then_resends(config, tmp_path):
    from signal_plus.updater import OUTDATED_CLIENT_MESSAGE, DEFAULT_SIGNAL_CLI_GPG_FINGERPRINT

    config = replace(config, signal_data_dir=tmp_path / "data", signal_cli_gpg_fingerprint=DEFAULT_SIGNAL_CLI_GPG_FINGERPRINT)
    archive_bytes = _make_native_archive_bytes()

    def fake_http_get(url):
        if "releases/latest" in url:
            return _release_payload()
        if url.endswith(".asc"):
            return b"sig"
        return archive_bytes

    gpg_ok = (
        0,
        f"[GNUPG:] VALIDSIG {DEFAULT_SIGNAL_CLI_GPG_FINGERPRINT} 2026-08-01 0 0 4 0 1 10 00 "
        f"{DEFAULT_SIGNAL_CLI_GPG_FINGERPRINT}\n"
        # GOODSIG required (SR-H-2, security review 5105061153) -- real gpg
        # only emits it for a signature whose key is neither revoked nor
        # expired; see signal_plus/updater.py's verify_signature and
        # tests/test_updater.py's _gpg_status_output for the full rationale.
        f"[GNUPG:] GOODSIG {DEFAULT_SIGNAL_CLI_GPG_FINGERPRINT[-16:]} AsamK <asamk@gmx.de>\n",
        "",
    )
    run = ScriptedRun(
        [
            _ok(),  # receive
            (1, "", f"Error loading state file for user x: {OUTDATED_CLIENT_MESSAGE} (IOException)"),  # send fails, outdated
            gpg_ok,  # gpg --verify
            _ok(),  # receive again (post-update)
            _ok(),  # send again -- succeeds
        ]
    )
    sleep_calls: list[float] = []

    ok, new_state = cli.send_with_retries_and_update(
        config,
        "+",
        State(),
        today=date(2026, 9, 3),
        run=run,
        sleep_fn=sleep_calls.append,
        http_get=fake_http_get,
        tmp_dir=tmp_path / "downloads",
    )

    assert ok is True
    assert new_state.installed_version == "0.14.7"
    assert new_state.last_update_attempt_date == date(2026, 9, 3)
    # The resend after a successful update must be immediate -- not a fall-
    # through into the normal per-attempt backoff sleep. If it fell through,
    # attempt 2's receive+send would still happen to succeed against this
    # script (making `ok is True` pass either way) but only after paying a
    # backoff sleep it should never have needed.
    assert sleep_calls == []


def test_auto_update_raising_unexpectedly_does_not_crash_the_retry_loop(config, tmp_path):
    # CR-H-2 (code review 5105099737): "тот же корень и в
    # run_auto_update()/install_release() -- не отдельная находка, тот же
    # класс дыры: в цепочке нет ни одной границы try/except вокруг
    # подпроцесс/сеть/диск-операций." Here: http_get raises a raw OSError
    # (network down) reaching for the archive itself, a path run_auto_update
    # does not wrap in its own try/except (only fetch_latest_release's
    # UpdaterError is caught internally) -- must not crash
    # send_with_retries_and_update, must count as a failed attempt and let
    # the retry loop continue.
    from signal_plus.updater import OUTDATED_CLIENT_MESSAGE, DEFAULT_SIGNAL_CLI_GPG_FINGERPRINT

    config = replace(
        config, signal_data_dir=tmp_path / "data", signal_cli_gpg_fingerprint=DEFAULT_SIGNAL_CLI_GPG_FINGERPRINT
    )

    def raising_http_get(url):
        if "releases/latest" in url:
            return _release_payload()
        raise OSError("network is unreachable")

    results = [
        _ok(),  # receive
        (1, "", f"Error loading state file for user x: {OUTDATED_CLIENT_MESSAGE} (IOException)"),  # send fails, outdated
    ]
    for _ in range(cli.DEFAULT_RETRY_ATTEMPTS - 1):
        results += [_ok(), _fail("still outdated")]
    run = ScriptedRun(results)

    ok, new_state = cli.send_with_retries_and_update(
        config,
        "+",
        State(),
        today=date(2026, 9, 3),
        run=run,
        sleep_fn=lambda s: None,
        http_get=raising_http_get,
        tmp_dir=tmp_path / "downloads",
    )

    assert ok is False
    # The attempt still counts (requirement 8's once-per-day guard must see
    # it even though it raised) and the daemon is still alive to report it,
    # not a propagated OSError.
    assert new_state.last_update_attempt_date == date(2026, 9, 3)
    assert new_state.last_error is not None


def test_non_outdated_error_never_triggers_update(config, tmp_path):
    def fail_http_get(url):
        raise AssertionError("must never call the network for a non-outdated error")

    run = ScriptedRun(
        [
            _ok(),  # receive
            _fail("connection refused"),  # send -- NOT the outdated message
        ]
        * cli.DEFAULT_RETRY_ATTEMPTS
        + [_ok()]  # issue-alert script call after exhaustion
    )

    ok, new_state = cli.send_with_retries_and_update(
        config,
        "+",
        State(),
        today=date(2026, 9, 3),
        run=run,
        sleep_fn=lambda s: None,
        http_get=fail_http_get,
        tmp_dir=tmp_path / "downloads",
    )
    assert ok is False
    assert new_state.last_update_attempt_date is None


def test_update_not_attempted_twice_same_day(config, tmp_path):
    from signal_plus.updater import OUTDATED_CLIENT_MESSAGE

    state_already_tried = State(last_update_attempt_date=date(2026, 9, 3))

    def fail_http_get(url):
        raise AssertionError("must not fetch a release when already attempted today")

    results = []
    for _ in range(cli.DEFAULT_RETRY_ATTEMPTS):
        results += [_ok(), (1, "", OUTDATED_CLIENT_MESSAGE)]
    results.append(_ok())  # issue-alert after exhaustion
    run = ScriptedRun(results)

    ok, new_state = cli.send_with_retries_and_update(
        config,
        "+",
        state_already_tried,
        today=date(2026, 9, 3),
        run=run,
        sleep_fn=lambda s: None,
        http_get=fail_http_get,
        tmp_dir=tmp_path / "downloads",
    )
    assert ok is False
    # last_update_attempt_date is unchanged -- no second attempt was made.
    assert new_state.last_update_attempt_date == date(2026, 9, 3)


# ---------------------------------------------------------------------------
# Modes: --groups / --now
# ---------------------------------------------------------------------------


def test_groups_mode_lists_groups(config, capsys):
    run = ScriptedRun([(0, "group.abc123==  My Group\n", "")])
    code = cli.main_with_config(config, ["--groups"], run=run)
    assert code == 0
    captured = capsys.readouterr()
    assert "My Group" in captured.out
    assert run.calls == [[str(config.signal_cli_bin), "-a", config.signal_account, "listGroups"]]


def test_now_mode_sends_immediately_without_waiting_for_slot(config):
    clock = FakeClock(_kyiv(2026, 9, 3, 3, 0))  # far outside the window
    run = ScriptedRun([_ok(), _ok()])
    outcome = cli.run_cycle(
        config, now_fn=clock.now_fn, sleep_fn=clock.sleep_fn, rng=ZERO_RNG, run=run, wait_for_slot=False
    )
    assert outcome.sent is True
    assert clock.sleep_calls == []  # no waiting at all


def test_now_mode_respects_idempotency(config):
    save_state(config.state_file, State(last_success_date=date(2026, 9, 3)))
    clock = FakeClock(_kyiv(2026, 9, 3, 9, 0))
    run = ScriptedRun([])
    outcome = cli.run_cycle(
        config, now_fn=clock.now_fn, sleep_fn=clock.sleep_fn, rng=ZERO_RNG, run=run, wait_for_slot=False
    )
    assert outcome.sent is False
    assert run.calls == []


# ---------------------------------------------------------------------------
# Daemon mode (default, no flags) -- requirement 7's fourth mode
# ---------------------------------------------------------------------------


class _StopDaemon(Exception):
    """Raised by a scripted sleep_fn to break run_daemon's infinite loop under test."""


def test_daemon_mode_runs_a_cycle_then_sleeps_and_loops(config):
    clock = FakeClock(_kyiv(2026, 9, 3, 6, 0))
    run = ScriptedRun([_ok(), _ok()])
    recheck_sleeps: list[float] = []
    total_calls = {"n": 0}

    def sleep_fn(seconds: float) -> None:
        total_calls["n"] += 1
        if total_calls["n"] > 500:
            # Safety net: if a mutation removed the daemon-level sleep_fn
            # call entirely, run_daemon's `while True` would otherwise spin
            # forever here rather than failing visibly.
            raise _StopDaemon("run_daemon never reached its recheck sleep")
        if seconds == cli.DAEMON_RECHECK_INTERVAL_SECONDS:
            recheck_sleeps.append(seconds)
            raise _StopDaemon()  # stop after the first daemon-level recheck sleep
        clock.sleep_fn(seconds)

    with pytest.raises(_StopDaemon):
        cli.run_daemon(config, now_fn=clock.now_fn, sleep_fn=sleep_fn, rng=ZERO_RNG, run=run)

    assert recheck_sleeps == [cli.DAEMON_RECHECK_INTERVAL_SECONDS]
    st = load_state(config.state_file)
    assert st.last_success_date == date(2026, 9, 3), "run_cycle must have actually run before the recheck sleep"


def test_no_flags_dispatches_to_daemon(config, monkeypatch):
    called = {}

    def fake_run_daemon(cfg, **kwargs):
        called["config"] = cfg
        called["run"] = kwargs.get("run")

    monkeypatch.setattr(cli, "run_daemon", fake_run_daemon)
    run = ScriptedRun([])
    code = cli.main_with_config(config, [], run=run)
    assert code == 0
    assert called["config"] is config
    assert called["run"] is run


# ---------------------------------------------------------------------------
# CR-M-2 (PR #650 code review, id 5105099737) -- cli.main() (the real,
# env-reading entrypoint used by both the `signal-plus` console script and
# `python -m signal_plus`) called Config.from_env() BEFORE parsing argv, so
# `signal-plus --help` crashed with ConfigError instead of printing usage --
# reproduced by the reviewer running the installed script with an empty env.
# ---------------------------------------------------------------------------


def test_main_help_works_without_any_env_configured(monkeypatch):
    for name in ("SIGNAL_ACCOUNT", "SIGNAL_GROUP_ID", "SIGNAL_CLI_BIN", "STATE_FILE"):
        monkeypatch.delenv(name, raising=False)

    with pytest.raises(SystemExit) as exc_info:
        cli.main(["--help"])
    assert exc_info.value.code == 0


def test_main_still_requires_config_for_a_real_mode(monkeypatch):
    # Regression guard: the fix must not turn OFF config validation for
    # modes that actually need it -- only --help (and -h) should short-
    # circuit before Config.from_env() runs.
    for name in ("SIGNAL_ACCOUNT", "SIGNAL_GROUP_ID", "SIGNAL_CLI_BIN", "STATE_FILE"):
        monkeypatch.delenv(name, raising=False)

    from signal_plus.config import ConfigError

    with pytest.raises(ConfigError):
        cli.main(["--groups"])
