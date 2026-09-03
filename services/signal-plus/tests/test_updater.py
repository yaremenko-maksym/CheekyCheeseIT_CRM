"""Tests for signal_plus.updater — outdated-client detection, download, GPG, swap.

Requirement 8 (verbatim): "Признак «клиент устарел» — только конкретный: сними
его из исходников signal-cli ... Любая другая ошибка обновление не запускает."
"""
from __future__ import annotations

import io
import json
import subprocess
import tarfile
from datetime import date
from pathlib import Path

import pytest

from signal_plus.config import Config
from signal_plus.state import State
from signal_plus.updater import (
    OUTDATED_CLIENT_MESSAGE,
    ReleaseAsset,
    UpdateOutcome,
    UpdaterError,
    already_attempted_today,
    download_to,
    ensure_seed_binary,
    fetch_latest_release,
    install_release,
    is_outdated_client_error,
    run_auto_update,
    verify_signature,
)

FINGERPRINT = "FA10826A74907F9EC6BBB7FC2BA2CD21B5B09570"


@pytest.fixture
def config(tmp_path) -> Config:
    return Config(
        signal_account="+380501234567",
        signal_group_id="group.abc123==",
        signal_cli_bin=tmp_path / "bin" / "current",
        state_file=tmp_path / "state.json",
        signal_data_dir=tmp_path / "data",
        signal_cli_gpg_fingerprint=FINGERPRINT,
    )


# ---------------------------------------------------------------------------
# is_outdated_client_error — the ONLY trigger for an update attempt
# ---------------------------------------------------------------------------


def test_is_outdated_client_error_true_on_exact_signal_cli_message():
    assert is_outdated_client_error(OUTDATED_CLIENT_MESSAGE) is True


def test_is_outdated_client_error_true_when_wrapped_by_app_loadmanager():
    # App.loadManager() wraps the IOException as:
    #   "Error loading state file for user <account>: <message> (IOException)"
    wrapped = (
        "Error loading state file for user +380501234567: "
        "signal-cli version is too old for the Signal-Server, please update. (IOException)"
    )
    assert is_outdated_client_error(wrapped) is True


@pytest.mark.parametrize(
    "other_output",
    [
        "",
        "Connection refused",
        "java.net.SocketTimeoutException: connect timed out",
        "User +380501234567 is not registered.",
        "Error while checking account +380501234567: invalid password (IOException)",
        "signal-cli version is too old",  # truncated — must NOT match
        "the Signal-Server said please update.",  # rearranged — must NOT match
    ],
)
def test_is_outdated_client_error_false_on_any_other_error(other_output):
    assert is_outdated_client_error(other_output) is False


# ---------------------------------------------------------------------------
# fetch_latest_release
# ---------------------------------------------------------------------------


def _releases_api_payload(**overrides):
    payload = {
        "tag_name": "v0.14.7",
        "assets": [
            {
                "name": "signal-cli-0.14.7-Linux-native.tar.gz",
                "browser_download_url": "https://example.invalid/signal-cli-0.14.7-Linux-native.tar.gz",
            },
            {
                "name": "signal-cli-0.14.7-Linux-native.tar.gz.asc",
                "browser_download_url": "https://example.invalid/signal-cli-0.14.7-Linux-native.tar.gz.asc",
            },
            {
                "name": "signal-cli-0.14.7.tar.gz",
                "browser_download_url": "https://example.invalid/signal-cli-0.14.7.tar.gz",
            },
        ],
    }
    payload.update(overrides)
    return payload


def test_fetch_latest_release_picks_linux_native_asset_and_its_signature():
    def fake_http_get(url):
        assert "releases/latest" in url
        return json.dumps(_releases_api_payload()).encode()

    release = fetch_latest_release(http_get=fake_http_get)
    assert release.version == "0.14.7"
    assert release.archive_name == "signal-cli-0.14.7-Linux-native.tar.gz"
    assert release.archive_url.endswith("Linux-native.tar.gz")
    assert release.signature_url.endswith("Linux-native.tar.gz.asc")


def test_fetch_latest_release_raises_when_native_asset_missing():
    payload = _releases_api_payload()
    payload["assets"] = [a for a in payload["assets"] if "Linux-native" not in a["name"]]

    def fake_http_get(url):
        return json.dumps(payload).encode()

    with pytest.raises(UpdaterError):
        fetch_latest_release(http_get=fake_http_get)


def test_fetch_latest_release_raises_when_signature_asset_missing():
    payload = _releases_api_payload()
    payload["assets"] = [a for a in payload["assets"] if not a["name"].endswith(".asc")]

    def fake_http_get(url):
        return json.dumps(payload).encode()

    with pytest.raises(UpdaterError):
        fetch_latest_release(http_get=fake_http_get)


# ---------------------------------------------------------------------------
# download_to
# ---------------------------------------------------------------------------


def test_download_to_writes_bytes_from_http_get(tmp_path):
    dest = tmp_path / "sub" / "file.bin"

    def fake_http_get(url):
        assert url == "https://example.invalid/file.bin"
        return b"binary-content"

    result = download_to("https://example.invalid/file.bin", dest, http_get=fake_http_get)
    assert result == dest
    assert dest.read_bytes() == b"binary-content"


# ---------------------------------------------------------------------------
# verify_signature — no trust-on-first-use: must match returncode AND fingerprint
# ---------------------------------------------------------------------------


def _gpg_status_output(fingerprint: str) -> str:
    return (
        "[GNUPG:] NEWSIG\n"
        f"[GNUPG:] VALIDSIG {fingerprint} 2026-08-01 1785571747 0 4 0 1 10 00 {fingerprint}\n"
        "[GNUPG:] TRUST_ULTIMATE 0 pgp\n"
    )


def test_verify_signature_true_when_returncode_zero_and_fingerprint_matches(tmp_path):
    archive = tmp_path / "a.tar.gz"
    sig = tmp_path / "a.tar.gz.asc"
    archive.write_bytes(b"x")
    sig.write_bytes(b"sig")

    def fake_run(argv, **kwargs):
        assert argv[0] == "gpg"
        assert str(sig) in argv
        assert str(archive) in argv
        return subprocess.CompletedProcess(argv, 0, _gpg_status_output(FINGERPRINT), "")

    assert verify_signature(archive, sig, fingerprint=FINGERPRINT, run=fake_run) is True


def test_verify_signature_false_when_fingerprint_does_not_match(tmp_path):
    archive = tmp_path / "a.tar.gz"
    sig = tmp_path / "a.tar.gz.asc"
    archive.write_bytes(b"x")
    sig.write_bytes(b"sig")
    other_fingerprint = "0000000000000000000000000000000000000000"

    def fake_run(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 0, _gpg_status_output(other_fingerprint), "")

    assert verify_signature(archive, sig, fingerprint=FINGERPRINT, run=fake_run) is False


def test_verify_signature_false_when_gpg_exits_nonzero(tmp_path):
    archive = tmp_path / "a.tar.gz"
    sig = tmp_path / "a.tar.gz.asc"
    archive.write_bytes(b"x")
    sig.write_bytes(b"sig")

    def fake_run(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 1, "", "gpg: Signature made ...\ngpg: BAD signature")

    assert verify_signature(archive, sig, fingerprint=FINGERPRINT, run=fake_run) is False


def test_verify_signature_false_when_no_validsig_line_present(tmp_path):
    archive = tmp_path / "a.tar.gz"
    sig = tmp_path / "a.tar.gz.asc"
    archive.write_bytes(b"x")
    sig.write_bytes(b"sig")

    def fake_run(argv, **kwargs):
        # returncode 0 but no VALIDSIG — must not be treated as trusted
        return subprocess.CompletedProcess(argv, 0, "[GNUPG:] NEWSIG\n", "")

    assert verify_signature(archive, sig, fingerprint=FINGERPRINT, run=fake_run) is False


def test_verify_signature_matches_case_insensitively(tmp_path):
    archive = tmp_path / "a.tar.gz"
    sig = tmp_path / "a.tar.gz.asc"
    archive.write_bytes(b"x")
    sig.write_bytes(b"sig")

    def fake_run(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 0, _gpg_status_output(FINGERPRINT.lower()), "")

    assert verify_signature(archive, sig, fingerprint=FINGERPRINT, run=fake_run) is True


# ---------------------------------------------------------------------------
# install_release — real local tar.gz, matching the actual Linux-native layout
# (single executable file `signal-cli` at the archive root — verified against
# the real v0.14.7 release asset with `tar -tvzf`, no wrapping directory).
# ---------------------------------------------------------------------------


def _make_native_archive(path: Path, content: bytes = b"#!/bin/sh\necho fake-signal-cli\n") -> Path:
    with tarfile.open(path, "w:gz") as tar:
        info = tarfile.TarInfo(name="signal-cli")
        info.size = len(content)
        info.mode = 0o755
        tar.addfile(info, io.BytesIO(content))
    return path


def test_install_release_extracts_and_points_current_symlink(tmp_path):
    archive = _make_native_archive(tmp_path / "signal-cli-0.14.7-Linux-native.tar.gz")
    data_dir = tmp_path / "data"

    current = install_release(archive, data_dir, "0.14.7")

    assert current == data_dir / "bin" / "current"
    assert current.is_symlink()
    resolved = current.resolve()
    assert resolved == (data_dir / "bin" / "0.14.7" / "signal-cli").resolve()
    assert resolved.read_bytes().startswith(b"#!/bin/sh")


def test_install_release_raises_when_archive_has_no_signal_cli_executable(tmp_path):
    bogus = tmp_path / "bogus.tar.gz"
    with tarfile.open(bogus, "w:gz") as tar:
        info = tarfile.TarInfo(name="not-the-right-file.txt")
        info.size = 3
        tar.addfile(info, io.BytesIO(b"hi\n"))
    with pytest.raises(UpdaterError):
        install_release(bogus, tmp_path / "data", "0.14.7")


def test_install_release_second_install_swaps_symlink_atomically(tmp_path):
    data_dir = tmp_path / "data"
    archive1 = _make_native_archive(tmp_path / "v1.tar.gz", content=b"version-one")
    archive2 = _make_native_archive(tmp_path / "v2.tar.gz", content=b"version-two")

    install_release(archive1, data_dir, "1.0.0")
    current = install_release(archive2, data_dir, "2.0.0")

    assert current.resolve().read_bytes() == b"version-two"


# ---------------------------------------------------------------------------
# already_attempted_today — AC5 "не больше одной попытки обновления в сутки"
# ---------------------------------------------------------------------------


def test_already_attempted_today_false_when_state_has_no_attempt():
    assert already_attempted_today(State(), date(2026, 9, 3)) is False


def test_already_attempted_today_false_when_attempt_was_a_different_day():
    st = State(last_update_attempt_date=date(2026, 9, 2))
    assert already_attempted_today(st, date(2026, 9, 3)) is False


def test_already_attempted_today_true_when_attempt_was_today():
    st = State(last_update_attempt_date=date(2026, 9, 3))
    assert already_attempted_today(st, date(2026, 9, 3)) is True


# ---------------------------------------------------------------------------
# ensure_seed_binary — image's pinned copy seeds the volume on first start
# ---------------------------------------------------------------------------


def test_ensure_seed_binary_copies_from_image_when_current_missing(tmp_path):
    data_dir = tmp_path / "data"
    image_dir = tmp_path / "image-pinned"
    image_dir.mkdir()
    (image_dir / "signal-cli").write_bytes(b"pinned-binary")

    ensure_seed_binary(data_dir, image_dir)

    current = data_dir / "bin" / "current"
    assert current.is_symlink()
    assert current.resolve().read_bytes() == b"pinned-binary"


def test_ensure_seed_binary_noop_when_current_already_exists(tmp_path):
    data_dir = tmp_path / "data"
    (data_dir / "bin").mkdir(parents=True)
    real = data_dir / "bin" / "0.14.7" / "signal-cli"
    real.parent.mkdir(parents=True)
    real.write_bytes(b"already-installed")
    (data_dir / "bin" / "current").symlink_to(real)

    image_dir = tmp_path / "image-pinned"  # deliberately does not exist
    ensure_seed_binary(data_dir, image_dir)  # must not raise, must not touch current

    assert (data_dir / "bin" / "current").resolve().read_bytes() == b"already-installed"


def test_ensure_seed_binary_raises_when_neither_current_nor_image_exists(tmp_path):
    with pytest.raises(UpdaterError):
        ensure_seed_binary(tmp_path / "data", tmp_path / "no-such-image-dir")


# ---------------------------------------------------------------------------
# run_auto_update — full orchestration
# ---------------------------------------------------------------------------


def _fake_http_get_factory(archive_bytes: bytes, sig_stdout: str):
    payload = json.dumps(_releases_api_payload()).encode()

    def fake_http_get(url):
        if "releases/latest" in url:
            return payload
        if url.endswith(".asc"):
            return b"signature-bytes"
        return archive_bytes

    return fake_http_get


def test_run_auto_update_happy_path(config, tmp_path):
    archive_bytes = tmp_path.joinpath("scratch.tar.gz")
    _make_native_archive(archive_bytes, content=b"new-version-binary")
    http_get = _fake_http_get_factory(archive_bytes.read_bytes(), _gpg_status_output(FINGERPRINT))

    def fake_run(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 0, _gpg_status_output(FINGERPRINT), "")

    state = State(installed_version="0.14.6")
    outcome = run_auto_update(
        config,
        state,
        today=date(2026, 9, 3),
        http_get=http_get,
        run=fake_run,
        tmp_dir=tmp_path / "downloads",
    )

    assert isinstance(outcome, UpdateOutcome)
    assert outcome.attempted is True
    assert outcome.success is True
    assert outcome.old_version == "0.14.6"
    assert outcome.new_version == "0.14.7"
    current = config.signal_data_dir / "bin" / "current"
    assert current.resolve().read_bytes() == b"new-version-binary"
    # Downloaded artifacts are cleaned up, not left lying around.
    assert not (tmp_path / "downloads").exists() or not list((tmp_path / "downloads").glob("*.tar.gz"))


def test_run_auto_update_skips_when_already_attempted_today(config, tmp_path):
    state = State(last_update_attempt_date=date(2026, 9, 3))

    def fail_http_get(url):
        raise AssertionError("must not call the network when already attempted today")

    outcome = run_auto_update(
        config,
        state,
        today=date(2026, 9, 3),
        http_get=fail_http_get,
        run=subprocess.run,
        tmp_dir=tmp_path / "downloads",
    )
    assert outcome.attempted is False
    assert outcome.success is False


def test_run_auto_update_fails_closed_on_bad_signature(config, tmp_path):
    archive_bytes = tmp_path.joinpath("scratch.tar.gz")
    _make_native_archive(archive_bytes, content=b"should-not-be-installed")
    http_get = _fake_http_get_factory(archive_bytes.read_bytes(), "")

    def fake_run_bad_sig(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 1, "", "gpg: BAD signature")

    state = State()
    outcome = run_auto_update(
        config,
        state,
        today=date(2026, 9, 3),
        http_get=http_get,
        run=fake_run_bad_sig,
        tmp_dir=tmp_path / "downloads",
    )
    assert outcome.attempted is True
    assert outcome.success is False
    assert "signature" in outcome.reason.lower()
    assert not (config.signal_data_dir / "bin" / "current").exists()
    # The rejected archive must be deleted, not left on disk.
    assert not list((tmp_path / "downloads").glob("*.tar.gz"))


def test_run_auto_update_returns_not_attempted_when_data_dir_or_fingerprint_missing(tmp_path):
    incomplete_config = Config(
        signal_account="+380501234567",
        signal_group_id="group.abc123==",
        signal_cli_bin=tmp_path / "bin" / "current",
        state_file=tmp_path / "state.json",
        # signal_data_dir and signal_cli_gpg_fingerprint left unset
    )

    def fail_http_get(url):
        raise AssertionError("must not call the network without data_dir/fingerprint configured")

    outcome = run_auto_update(
        incomplete_config,
        State(),
        today=date(2026, 9, 3),
        http_get=fail_http_get,
        run=subprocess.run,
        tmp_dir=tmp_path / "downloads",
    )
    assert outcome.attempted is False
    assert outcome.success is False
