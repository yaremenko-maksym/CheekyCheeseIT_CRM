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
    MAX_DOWNLOAD_BYTES,
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


_REAL_RELEASE_DOWNLOAD_PREFIX = "https://github.com/AsamK/signal-cli/releases/download/v0.14.7/"


def _releases_api_payload(**overrides):
    # URLs match the REAL shape of GitHub Releases API's browser_download_url
    # field (verified against the real API response, 2026-09-03: always
    # `github.com/<owner>/<repo>/releases/download/<tag>/<asset>`, never the
    # release-assets.githubusercontent.com CDN host the actual bytes redirect
    # to) -- SR-M-1 (security review 5105061153) validates this exact prefix,
    # so fixtures need to actually look like it for the happy-path tests to
    # mean anything.
    payload = {
        "tag_name": "v0.14.7",
        "assets": [
            {
                "name": "signal-cli-0.14.7-Linux-native.tar.gz",
                "browser_download_url": _REAL_RELEASE_DOWNLOAD_PREFIX + "signal-cli-0.14.7-Linux-native.tar.gz",
            },
            {
                "name": "signal-cli-0.14.7-Linux-native.tar.gz.asc",
                "browser_download_url": _REAL_RELEASE_DOWNLOAD_PREFIX + "signal-cli-0.14.7-Linux-native.tar.gz.asc",
            },
            {
                "name": "signal-cli-0.14.7.tar.gz",
                "browser_download_url": _REAL_RELEASE_DOWNLOAD_PREFIX + "signal-cli-0.14.7.tar.gz",
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
# SR-M-1 (PR #650 security review, id 5105061153) -- the updater trusts
# fields from the GitHub Releases API response (tag_name, asset name,
# browser_download_url) as if they were pre-validated, when they are
# attacker-influenceable input over the network. Reproduced by the reviewer
# with a hostile JSON response: a `tag_name` of `../../../../ESCAPED`
# installed OUTSIDE SIGNAL_DATA_DIR and pointed bin/current there, and a
# `browser_download_url` of `https://evil.example/a` was fetched as-is with
# a VALID GPG signature still passing (the signature is over the archive
# BYTES, not over where they came from).
# ---------------------------------------------------------------------------


def test_fetch_latest_release_rejects_path_traversal_in_tag_name():
    payload = _releases_api_payload(**{"tag_name": "v../../../../ESCAPED"})

    def fake_http_get(url):
        return json.dumps(payload).encode()

    with pytest.raises(UpdaterError):
        fetch_latest_release(http_get=fake_http_get)


def test_fetch_latest_release_rejects_path_traversal_in_asset_name():
    payload = _releases_api_payload()
    # Still matches the Linux-native suffix selection, so it WOULD be picked
    # as archive_name if nothing validated it further.
    payload["assets"][0]["name"] = "../../../etc/evil-Linux-native.tar.gz"

    def fake_http_get(url):
        return json.dumps(payload).encode()

    with pytest.raises(UpdaterError):
        fetch_latest_release(http_get=fake_http_get)


@pytest.mark.parametrize(
    "hostile_url",
    [
        "https://evil.example/a.tar.gz",
        "http://github.com/AsamK/signal-cli/releases/download/v0.14.7/a.tar.gz",  # http, not https
        "https://github.com.evil.example/AsamK/signal-cli/releases/download/v0.14.7/a.tar.gz",  # lookalike host
        "https://github.com/SomeoneElse/other-repo/releases/download/v1/a.tar.gz",  # wrong repo
    ],
)
def test_fetch_latest_release_rejects_download_url_off_the_allowed_prefix(hostile_url):
    payload = _releases_api_payload()
    payload["assets"][0]["browser_download_url"] = hostile_url

    def fake_http_get(url):
        return json.dumps(payload).encode()

    with pytest.raises(UpdaterError):
        fetch_latest_release(http_get=fake_http_get)


def test_fetch_latest_release_accepts_the_real_download_url_shape():
    # Regression guard for the fixes above: the ACTUAL shape GitHub's API
    # returns (verified against the live API, 2026-09-03) must still pass.
    def fake_http_get(url):
        return json.dumps(_releases_api_payload()).encode()

    release = fetch_latest_release(http_get=fake_http_get)
    assert release.archive_url.startswith("https://github.com/AsamK/signal-cli/releases/download/")


# ---------------------------------------------------------------------------
# SR-H-3 (PR #650 security review round 2, id 5107124812, OWASP A08) --
# tag_name, asset name, and download URL are three separate fields from the
# same untrusted Releases API response, and nothing tied them together.
# Reproduced by the reviewer end-to-end with a REAL archive and a VALID
# signature: tag_name announces "v9.9.9" while the asset name/URLs point at
# the real, validly-signed v0.9.0 release -- _is_strictly_newer compares the
# ANNOUNCED "9.9.9" against the installed version (passes, it looks newer)
# while the bytes that actually land are the real, old, vulnerable 0.9.0
# binary. Worse than a one-time downgrade: state.installed_version becomes
# "9.9.9" afterwards, so every REAL future release forever compares as "not
# newer" and requirement 8 stops firing at all, silently.
# ---------------------------------------------------------------------------


def test_fetch_latest_release_rejects_asset_name_not_matching_the_tag():
    # The reviewer's exact reproduction shape: tag_name lies about the
    # version, the asset name/URLs still name the real (old) release.
    payload = _releases_api_payload(**{"tag_name": "v9.9.9"})
    for asset in payload["assets"]:
        asset["name"] = asset["name"].replace("0.14.7", "0.9.0")
        asset["browser_download_url"] = asset["browser_download_url"].replace("0.14.7", "0.9.0")

    def fake_http_get(url):
        return json.dumps(payload).encode()

    with pytest.raises(UpdaterError):
        fetch_latest_release(http_get=fake_http_get)


def test_fetch_latest_release_rejects_url_path_naming_a_different_tag():
    # Asset NAME matches the announced tag's version, but the download URL's
    # own /releases/download/<tag>/ path segment names a different tag --
    # still a mismatch between "what we were told" and "where it comes
    # from", even though SR-M-1's host/prefix allow-list alone would not
    # catch it (both hosts are github.com/AsamK/signal-cli/releases/download).
    payload = _releases_api_payload()
    for asset in payload["assets"]:
        asset["browser_download_url"] = asset["browser_download_url"].replace("v0.14.7", "v0.9.0")

    def fake_http_get(url):
        return json.dumps(payload).encode()

    with pytest.raises(UpdaterError):
        fetch_latest_release(http_get=fake_http_get)


def test_fetch_latest_release_rejects_tag_name_dot_traversal_via_asset_binding():
    # SR-H-3's own follow-on note: tag_name="." passes _validate_safe_token
    # (the regex accepts it, ".." in "." is False) and would install straight
    # into bin/ itself -- the asset-name binding rejects it as a side effect,
    # since no real asset is ever named "signal-cli-.-Linux-native.tar.gz".
    payload = _releases_api_payload(**{"tag_name": "."})

    def fake_http_get(url):
        return json.dumps(payload).encode()

    with pytest.raises(UpdaterError):
        fetch_latest_release(http_get=fake_http_get)


def test_fetch_latest_release_accepts_when_all_three_fields_agree():
    # Regression guard: the binding check must not reject the ordinary,
    # internally-consistent case _releases_api_payload() already models.
    def fake_http_get(url):
        return json.dumps(_releases_api_payload()).encode()

    release = fetch_latest_release(http_get=fake_http_get)
    assert release.version == "0.14.7"
    assert release.archive_name == "signal-cli-0.14.7-Linux-native.tar.gz"


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


def test_download_to_rejects_a_response_over_the_size_limit(tmp_path):
    # SR-M-1: "_default_http_get делает response.read() целиком в память без
    # ограничения размера ... ответ на несколько сотен МБ = OOM-kill +
    # перезапуск". download_to is the choke point every caller (archive AND
    # signature download) goes through, regardless of which http_get is
    # wired in -- reject an oversized response before it is ever written to
    # disk (or, for the real implementation, capped further upstream too --
    # see _default_http_get's own MAX_DOWNLOAD_BYTES-capped read).
    dest = tmp_path / "file.bin"
    oversized = b"x" * (MAX_DOWNLOAD_BYTES + 1)

    def fake_http_get(url):
        return oversized

    with pytest.raises(UpdaterError):
        download_to("https://example.invalid/file.bin", dest, http_get=fake_http_get)
    assert not dest.exists()


# ---------------------------------------------------------------------------
# verify_signature — no trust-on-first-use: must match returncode AND fingerprint
# ---------------------------------------------------------------------------


def _gpg_status_output(fingerprint: str) -> str:
    # GOODSIG included (SR-H-2, security review 5105061153): real gpg emits
    # GOODSIG for a signature made by a key that is neither revoked nor
    # expired -- GOODSIG/REVKEYSIG/EXPKEYSIG/BADSIG are mutually exclusive
    # "primary signature status" lines. Omitting it here would make this
    # fixture describe an impossible gpg output (VALIDSIG with no primary
    # status at all), and would silently defeat the GOODSIG requirement the
    # fix below adds.
    return (
        "[GNUPG:] NEWSIG\n"
        f"[GNUPG:] VALIDSIG {fingerprint} 2026-08-01 1785571747 0 4 0 1 10 00 {fingerprint}\n"
        f"[GNUPG:] GOODSIG {fingerprint[-16:]} Test Maintainer <test@example.invalid>\n"
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
# SR-H-2 (PR #650 security review, id 5105061153) -- gpg returns exit=0 and
# still emits VALIDSIG with the SIGNER'S OWN fingerprint even when that
# key has since been revoked or has expired; it swaps GOODSIG for
# REVKEYSIG/EXPKEYSIG and adds KEYREVOKED/KEYEXPIRED instead. Reproduced by
# the reviewer with a real generated+revoked test key, not a guess:
#
#   $ gpg --batch --status-fd 1 --verify a.tar.gz.asc a.tar.gz
#   gpg exit=0
#   [GNUPG:] REVKEYSIG ...
#   [GNUPG:] VALIDSIG <the correct fingerprint> ...
#   [GNUPG:] KEYREVOKED
#
# The fingerprint pin alone (SR-M-1's neighbour, "no trust-on-first-use")
# defends against a DIFFERENT key signing the release; it does nothing
# against the SAME key being revoked, which is the one mechanism a
# maintainer has to disown a compromised key.
# ---------------------------------------------------------------------------


def test_verify_signature_false_when_key_is_revoked_even_with_matching_fingerprint(tmp_path):
    archive = tmp_path / "a.tar.gz"
    sig = tmp_path / "a.tar.gz.asc"
    archive.write_bytes(b"x")
    sig.write_bytes(b"sig")

    def fake_run(argv, **kwargs):
        return subprocess.CompletedProcess(
            argv,
            0,
            (
                f"[GNUPG:] REVKEYSIG {FINGERPRINT[-16:]} Fake Maintainer <fake@example.invalid>\n"
                f"[GNUPG:] VALIDSIG {FINGERPRINT} 2026-08-01 1785571747 0 4 0 1 10 00 {FINGERPRINT}\n"
                "[GNUPG:] KEYREVOKED\n"
            ),
            "",
        )

    assert verify_signature(archive, sig, fingerprint=FINGERPRINT, run=fake_run) is False


def test_verify_signature_false_when_key_has_expired(tmp_path):
    archive = tmp_path / "a.tar.gz"
    sig = tmp_path / "a.tar.gz.asc"
    archive.write_bytes(b"x")
    sig.write_bytes(b"sig")

    def fake_run(argv, **kwargs):
        return subprocess.CompletedProcess(
            argv,
            0,
            (
                f"[GNUPG:] EXPKEYSIG {FINGERPRINT[-16:]} Test Maintainer <test@example.invalid>\n"
                f"[GNUPG:] VALIDSIG {FINGERPRINT} 2026-08-01 1785571747 0 4 0 1 10 00 {FINGERPRINT}\n"
                "[GNUPG:] KEYEXPIRED 1785571747\n"
            ),
            "",
        )

    assert verify_signature(archive, sig, fingerprint=FINGERPRINT, run=fake_run) is False


def test_verify_signature_false_when_signature_itself_has_expired(tmp_path):
    archive = tmp_path / "a.tar.gz"
    sig = tmp_path / "a.tar.gz.asc"
    archive.write_bytes(b"x")
    sig.write_bytes(b"sig")

    def fake_run(argv, **kwargs):
        return subprocess.CompletedProcess(
            argv,
            0,
            (
                f"[GNUPG:] EXPSIG {FINGERPRINT[-16:]} Test Maintainer <test@example.invalid>\n"
                f"[GNUPG:] VALIDSIG {FINGERPRINT} 2026-08-01 1785571747 0 4 0 1 10 00 {FINGERPRINT}\n"
            ),
            "",
        )

    assert verify_signature(archive, sig, fingerprint=FINGERPRINT, run=fake_run) is False


def test_verify_signature_false_when_validsig_present_but_goodsig_absent(tmp_path):
    # Neither a revocation/expiry marker NOR GOODSIG is present -- must not
    # be treated as trusted just because nothing explicitly bad was seen.
    archive = tmp_path / "a.tar.gz"
    sig = tmp_path / "a.tar.gz.asc"
    archive.write_bytes(b"x")
    sig.write_bytes(b"sig")

    def fake_run(argv, **kwargs):
        return subprocess.CompletedProcess(
            argv,
            0,
            f"[GNUPG:] VALIDSIG {FINGERPRINT} 2026-08-01 1785571747 0 4 0 1 10 00 {FINGERPRINT}\n",
            "",
        )

    assert verify_signature(archive, sig, fingerprint=FINGERPRINT, run=fake_run) is False


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


def _fake_run_gpg_and_version(expected_version: str):
    """Routes `gpg --verify` to a passing status and any `<binary> --version`
    call (SR-H-3's post-install check) to a matching version string --
    shared by tests where the update is expected to actually succeed.
    """

    def fake_run(argv, **kwargs):
        if argv[0] == "gpg":
            return subprocess.CompletedProcess(argv, 0, _gpg_status_output(FINGERPRINT), "")
        if "--version" in argv:
            return subprocess.CompletedProcess(argv, 0, f"signal-cli {expected_version}\n", "")
        raise AssertionError(f"unexpected run() call: {argv}")

    return fake_run


def test_run_auto_update_happy_path(config, tmp_path):
    archive_bytes = tmp_path.joinpath("scratch.tar.gz")
    _make_native_archive(archive_bytes, content=b"new-version-binary")
    http_get = _fake_http_get_factory(archive_bytes.read_bytes(), _gpg_status_output(FINGERPRINT))
    fake_run = _fake_run_gpg_and_version("0.14.7")

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


def test_run_auto_update_refuses_to_downgrade(config, tmp_path):
    # SR-M-1: "проверено: installed_version='0.14.7', «latest» заявляет
    # '0.9.0' -> success=True, new_version='0.9.0'. Откат на старый ...
    # signal-cli подписью не ловится -- она валидна." The GPG pin defends
    # the CONTENT; nothing defended the DIRECTION until this fix. The
    # attacker-controlled field here is `tag_name`, not the asset filename
    # (which stays a real, validly-signed v0.14.7 asset) -- exactly the
    # reviewer's reproduction shape: a legitimate old release masquerading
    # as "latest" via a manipulated/rolled-back API response.
    archive_bytes = tmp_path.joinpath("scratch.tar.gz")
    _make_native_archive(archive_bytes, content=b"old-version-binary")
    # Internally CONSISTENT v0.9.0 payload (tag/asset-name/URL all agree) --
    # isolates the downgrade check from SR-H-3's separate tag<->asset
    # binding check, which would otherwise reject this fixture earlier for
    # a different reason (asset still named ...-0.14.7-... under a
    # "v0.9.0" tag) and make this test pass without ever exercising
    # _is_strictly_newer at all.
    payload = _releases_api_payload(**{"tag_name": "v0.9.0"})
    for asset in payload["assets"]:
        asset["name"] = asset["name"].replace("0.14.7", "0.9.0")
        asset["browser_download_url"] = asset["browser_download_url"].replace("0.14.7", "0.9.0")

    def fake_http_get(url):
        if "releases/latest" in url:
            return json.dumps(payload).encode()
        if url.endswith(".asc"):
            return b"signature-bytes"
        return archive_bytes.read_bytes()

    def fail_run(argv, **kwargs):
        raise AssertionError("downgrade must be refused before verify_signature/install ever run")

    state = State(installed_version="0.14.7")
    outcome = run_auto_update(
        config,
        state,
        today=date(2026, 9, 3),
        http_get=fake_http_get,
        run=fail_run,
        tmp_dir=tmp_path / "downloads",
    )

    assert outcome.attempted is True
    assert outcome.success is False
    assert not (config.signal_data_dir / "bin" / "current").exists()


def test_run_auto_update_allows_the_first_ever_update_with_no_installed_version(config, tmp_path):
    # No state.installed_version to compare against yet (image-pinned
    # fallback binary, never auto-updated before) -- must not block the
    # update just because there is nothing recorded to compare against.
    archive_bytes = tmp_path.joinpath("scratch.tar.gz")
    _make_native_archive(archive_bytes, content=b"first-update-binary")
    http_get = _fake_http_get_factory(archive_bytes.read_bytes(), _gpg_status_output(FINGERPRINT))
    fake_run = _fake_run_gpg_and_version("0.14.7")

    outcome = run_auto_update(
        config,
        State(),
        today=date(2026, 9, 3),
        http_get=http_get,
        run=fake_run,
        tmp_dir=tmp_path / "downloads",
    )
    assert outcome.success is True


# ---------------------------------------------------------------------------
# SR-H-3 part 2 (task-650-fix-round-1.md, fix-round 2): even when
# tag_name/asset-name/URL all agree (SR-H-3 part 1's binding check passes),
# the ARCHIVE CONTENTS could still not be what they claim -- the GPG
# signature only proves AsamK signed THESE bytes, not that they are
# truthfully labeled. After install, the binary that actually landed must
# report the announced version via --version, or the symlink swap is
# rolled back and the attempt fails.
# ---------------------------------------------------------------------------


def test_run_auto_update_rolls_back_when_installed_binary_reports_a_different_version(config, tmp_path):
    old_archive = tmp_path / "old.tar.gz"
    _make_native_archive(old_archive, content=b"trusted-old-binary")
    old_current = install_release(old_archive, config.signal_data_dir, "0.14.7")
    assert old_current.resolve().read_bytes() == b"trusted-old-binary"

    new_archive_bytes = tmp_path.joinpath("scratch.tar.gz")
    _make_native_archive(new_archive_bytes, content=b"mislabeled-binary")
    payload = _releases_api_payload(**{"tag_name": "v0.15.0"})
    for asset in payload["assets"]:
        asset["name"] = asset["name"].replace("0.14.7", "0.15.0")
        asset["browser_download_url"] = asset["browser_download_url"].replace("0.14.7", "0.15.0")

    def fake_http_get(url):
        if "releases/latest" in url:
            return json.dumps(payload).encode()
        if url.endswith(".asc"):
            return b"signature-bytes"
        return new_archive_bytes.read_bytes()

    def fake_run(argv, **kwargs):
        if argv[0] == "gpg":
            return subprocess.CompletedProcess(argv, 0, _gpg_status_output(FINGERPRINT), "")
        if "--version" in argv:
            # The binary that actually landed reports the OLD version, not
            # the announced 0.15.0 -- exactly what a mislabeled/stale
            # re-publish would look like.
            return subprocess.CompletedProcess(argv, 0, "signal-cli 0.9.0\n", "")
        raise AssertionError(f"unexpected run() call: {argv}")

    state = State(installed_version="0.14.7")
    outcome = run_auto_update(
        config,
        state,
        today=date(2026, 9, 3),
        http_get=fake_http_get,
        run=fake_run,
        tmp_dir=tmp_path / "downloads",
    )

    assert outcome.attempted is True
    assert outcome.success is False
    # Rolled back: `current` points at the TRUSTED old binary again, not
    # the mislabeled one that just failed verification.
    current = config.signal_data_dir / "bin" / "current"
    assert current.resolve().read_bytes() == b"trusted-old-binary"


def test_run_auto_update_removes_current_when_version_mismatch_on_first_ever_install(config, tmp_path):
    # No prior `bin/current` to roll back TO -- the mismatched symlink must
    # be removed entirely, not left pointing at a binary that just failed
    # its own version check.
    archive_bytes = tmp_path.joinpath("scratch.tar.gz")
    _make_native_archive(archive_bytes, content=b"mislabeled-first-binary")
    http_get = _fake_http_get_factory(archive_bytes.read_bytes(), _gpg_status_output(FINGERPRINT))

    def fake_run(argv, **kwargs):
        if argv[0] == "gpg":
            return subprocess.CompletedProcess(argv, 0, _gpg_status_output(FINGERPRINT), "")
        if "--version" in argv:
            return subprocess.CompletedProcess(argv, 0, "signal-cli 0.0.1\n", "")
        raise AssertionError(f"unexpected run() call: {argv}")

    outcome = run_auto_update(
        config,
        State(),
        today=date(2026, 9, 3),
        http_get=http_get,
        run=fake_run,
        tmp_dir=tmp_path / "downloads",
    )

    assert outcome.success is False
    current = config.signal_data_dir / "bin" / "current"
    assert not current.exists() and not current.is_symlink()


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
