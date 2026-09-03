"""Outdated-client detection, signed download, GPG verify, atomic swap.

Requirement 8 (verbatim, task-signal-plus-service.md): "Автообновление при
устаревшем клиенте ... Признак «клиент устарел» — только конкретный: сними
его из исходников signal-cli ... Любая другая ошибка обновление не
запускает." and "Фингерпринт мейнтейнера возьми из документации проекта
signal-cli (README/wiki), процитируй источник."

OUTDATED-CLIENT MESSAGE — cited from source, not memory
--------------------------------------------------------
Source: ``AsamK/signal-cli``, tag ``v0.14.7``, commit
``b01b6b370dc063599a1a2b9fde0f5ff4e2d78fe8``,
``lib/src/main/java/org/asamk/signal/manager/SignalAccountFiles.java``
lines 164-168 (inside ``initManagerFromAccount``, which every command
including ``send`` runs through when it loads the account/manager before
doing anything else)::

    try {
        manager.checkAccountState();
    } catch (DeprecatedVersionException e) {
        manager.close();
        throw new IOException("signal-cli version is too old for the Signal-Server, please update.");
    }

``App.loadManager()`` (``src/main/java/org/asamk/signal/App.java``, the
generic ``catch (Throwable e)`` branch) may wrap this further as
``"Error loading state file for user <account>: <message> (<ExceptionClass>)"``,
but the literal string above always survives inside that wrapper — hence a
substring check rather than an exact-equality check.

GPG FINGERPRINT -- cited from three independent sources, not a doc page
---------------------------------------------------------------------------
The task initially asked for this from signal-cli's README/wiki; neither
documents it (verified: ``grep -rniE "gpg|pgp|fingerprint"`` across both the
README and every page of the ``AsamK/signal-cli.wiki`` repo returns zero
matches as of 2026-09-03). The task file was then revised to require an
independent source instead -- not the artifact being verified -- so the
fingerprint below is cross-checked against three separate sources, all
agreeing:

  - ``gpg --list-packets`` on the real ``signal-cli-0.14.7-Linux-native.tar.gz.asc``
    release asset (downloaded via ``gh release download v0.14.7 --repo
    AsamK/signal-cli``) reports
    ``hashed subpkt 33 len 21 (issuer fpr v4 FA10826A74907F9EC6BBB7FC2BA2CD21B5B09570)``.
  - The same fingerprint signs the GPG-signed git tag ``v0.14.7`` itself
    (``git cat-file tag v0.14.7``), tagged by ``AsamK <asamk@gmx.de>``.
  - Independent of the release artifact: GitHub publishes a user's
    registered GPG public key(s) at ``https://github.com/<username>.gpg``
    (the same mechanism as ``.keys`` for SSH). Fetching
    ``https://github.com/AsamK.gpg`` fresh and importing it into a scratch
    keyring (``gpg --import`` then ``gpg --list-keys --with-fingerprint``)
    shows the primary key's fingerprint as
    ``FA10826A74907F9EC6BBB7FC2BA2CD21B5B09570`` for user ID
    ``AsamK <asamk@gmx.de>`` -- identical to the two sources above, and
    obtained through a channel that never touches the file being verified.

All three point to the same key, so it is set here as the default
fingerprint -- but it is still only ever used as the *default* for
``SIGNAL_CLI_GPG_FINGERPRINT``; the env var (requirement 1) is what actually
governs verification, so a maintainer key rotation only needs a config
change, not a code change.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tarfile
import urllib.request
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from signal_plus.config import Config
from signal_plus.state import State

OUTDATED_CLIENT_MESSAGE = (
    "signal-cli version is too old for the Signal-Server, please update."
)

# See module docstring "GPG FINGERPRINT" section for how this was obtained.
DEFAULT_SIGNAL_CLI_GPG_FINGERPRINT = "FA10826A74907F9EC6BBB7FC2BA2CD21B5B09570"

GITHUB_RELEASES_API = "https://api.github.com/repos/AsamK/signal-cli/releases/latest"
_NATIVE_ASSET_SUFFIX = "-Linux-native.tar.gz"

# Where step 2's Dockerfile is expected to place the image-pinned fallback
# binary (requirement 8, last bullet: "образ несёт запиненную версию как
# запасную копию"). Documented in README.md so both sides agree on the path.
DEFAULT_IMAGE_PINNED_BIN_DIR = Path("/opt/signal-cli-pinned")


class UpdaterError(RuntimeError):
    """Raised for update-flow failures that are not simply 'signature rejected'."""


def is_outdated_client_error(output: str) -> bool:
    """True only for the exact signal-cli "too old" message (see module docstring).

    Any other failure (network error, bad credentials, rate limiting, ...)
    returns False — requirement 8 is explicit that only this one message may
    ever trigger an update attempt.
    """
    return OUTDATED_CLIENT_MESSAGE in output


@dataclass(frozen=True)
class ReleaseAsset:
    version: str
    archive_name: str
    archive_url: str
    signature_url: str


def _default_http_get(url: str) -> bytes:  # pragma: no cover - real network, never used in tests
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read()


def fetch_latest_release(*, http_get=_default_http_get) -> ReleaseAsset:
    """Fetch and parse the latest GitHub release, picking the Linux-native asset."""
    raw = http_get(GITHUB_RELEASES_API)
    try:
        data = json.loads(raw)
        assets = {a["name"]: a["browser_download_url"] for a in data["assets"]}
        archive_name = next(name for name in assets if name.endswith(_NATIVE_ASSET_SUFFIX))
        signature_name = archive_name + ".asc"
        signature_url = assets[signature_name]
    except (KeyError, StopIteration, json.JSONDecodeError) as exc:
        raise UpdaterError(f"unexpected GitHub releases API response: {exc}") from exc
    return ReleaseAsset(
        version=str(data["tag_name"]).lstrip("v"),
        archive_name=archive_name,
        archive_url=assets[archive_name],
        signature_url=signature_url,
    )


def download_to(url: str, dest: Path, *, http_get=_default_http_get) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(http_get(url))
    return dest


# SR-H-2 (PR #650 security review, id 5105061153): status-fd tags that mean
# "this signature exists but must not be trusted" -- gpg still exits 0 and
# still emits VALIDSIG (with the signer's real fingerprint) for every one of
# these, replacing GOODSIG with one of these instead. A fingerprint pin alone
# defends against a DIFFERENT key signing the release; it does nothing
# against the SAME key being revoked or expired, which is the one mechanism
# a maintainer has to disown a compromised key. Reproduced by the reviewer
# with a real generated-then-revoked test key (`REVKEYSIG`/`KEYREVOKED`);
# `EXPKEYSIG`/`KEYEXPIRED` (key expired) and `EXPSIG` (signature itself
# expired) are the same class of gpg output, not separately reproduced but
# documented identically by GnuPG (`doc/DETAILS`, "mutually exclusive
# primary signature status" lines).
_UNTRUSTED_SIGNATURE_TAGS = frozenset(
    {"REVKEYSIG", "EXPKEYSIG", "KEYREVOKED", "KEYEXPIRED", "EXPSIG", "BADSIG", "ERRSIG"}
)


def verify_signature(
    archive_path: Path,
    signature_path: Path,
    *,
    fingerprint: str,
    run=subprocess.run,
) -> bool:
    """``gpg --verify`` the release archive; require ALL of:

    - exit code 0;
    - ``GOODSIG`` present (gpg's own "this is a fully trustworthy signature"
      marker — absent whenever the signing key is revoked, expired, or the
      signature itself is bad/expired, even though ``VALIDSIG`` and exit 0
      still happen in those cases);
    - none of :data:`_UNTRUSTED_SIGNATURE_TAGS` present, as explicit
      defense-in-depth on top of the GOODSIG check above;
    - a ``VALIDSIG`` line whose fingerprint matches ``fingerprint`` exactly
      (no trust-on-first-use: a valid signature from some *other* key in the
      keyring is still rejected).
    """
    completed = run(
        ["gpg", "--status-fd", "1", "--verify", str(signature_path), str(archive_path)],
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        return False

    lines = completed.stdout.splitlines()
    tags = {line.split()[1] for line in lines if line.startswith("[GNUPG:] ") and len(line.split()) > 1}
    if tags & _UNTRUSTED_SIGNATURE_TAGS:
        return False
    if "GOODSIG" not in tags:
        return False

    target = fingerprint.strip().upper().replace(" ", "")
    for line in lines:
        if line.startswith("[GNUPG:] VALIDSIG "):
            parts = line.split()
            if len(parts) < 3:
                continue
            signer_fingerprint = parts[2].strip().upper()
            return signer_fingerprint == target
    return False


def install_release(archive_path: Path, data_dir: Path, version: str) -> Path:
    """Extract the release archive and atomically swap the ``current`` symlink.

    The Linux-native archive is a single executable file named ``signal-cli``
    at the archive root (verified with ``tar -tvzf`` against the actual
    v0.14.7 release asset — no wrapping directory, unlike the JVM tarball).
    """
    version_dir = Path(data_dir) / "bin" / version
    version_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, "r:gz") as tar:
        tar.extractall(path=version_dir, filter="data")

    binary = version_dir / "signal-cli"
    if not binary.exists():
        raise UpdaterError(
            f"extracted release {version} does not contain a signal-cli executable "
            f"under {version_dir}"
        )
    binary.chmod(binary.stat().st_mode | 0o111)

    bin_dir = Path(data_dir) / "bin"
    current_link = bin_dir / "current"
    tmp_link = bin_dir / ".current.tmp"
    if tmp_link.is_symlink() or tmp_link.exists():
        tmp_link.unlink()
    tmp_link.symlink_to(binary)
    os.replace(tmp_link, current_link)  # atomic rename-over, same directory
    return current_link


def already_attempted_today(state: State, today: date) -> bool:
    """Requirement 8: "Не больше одной попытки обновления в сутки"."""
    return state.last_update_attempt_date == today


def ensure_seed_binary(data_dir: Path, image_bin_dir: Path = DEFAULT_IMAGE_PINNED_BIN_DIR) -> None:
    """Seed ``data_dir/bin/current`` from the image's pinned copy on first start.

    No-op if ``current`` already exists (the volume already has a real
    install, from a previous run or an auto-update). Raises if neither the
    volume nor the image has a usable binary — the service should not start
    silently with nothing to run.
    """
    data_dir = Path(data_dir)
    current_link = data_dir / "bin" / "current"
    if current_link.exists() or current_link.is_symlink():
        return
    image_binary = Path(image_bin_dir) / "signal-cli"
    if not image_binary.exists():
        raise UpdaterError(
            f"no {current_link} on the volume and no seed binary at {image_binary}"
        )
    bin_dir = data_dir / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    seed_copy = bin_dir / "signal-cli-seed"
    shutil.copy2(image_binary, seed_copy)
    seed_copy.chmod(seed_copy.stat().st_mode | 0o111)
    current_link.symlink_to(seed_copy)


@dataclass(frozen=True)
class UpdateOutcome:
    attempted: bool
    success: bool
    reason: str
    old_version: str | None = None
    new_version: str | None = None


def run_auto_update(
    config: Config,
    state: State,
    *,
    today: date,
    http_get=_default_http_get,
    run=subprocess.run,
    tmp_dir: Path,
) -> UpdateOutcome:
    """Orchestrate one update attempt. Does not touch ``state`` on disk —
    callers persist ``last_update_attempt_date``/``installed_version``
    themselves (requirement 8's "не больше одной попытки в сутки" must count
    a *failed* attempt too, which only the caller can decide how to record).
    """
    if already_attempted_today(state, today):
        return UpdateOutcome(attempted=False, success=False, reason="already attempted today")
    if config.signal_data_dir is None or not config.signal_cli_gpg_fingerprint:
        return UpdateOutcome(
            attempted=False,
            success=False,
            reason="SIGNAL_DATA_DIR and/or SIGNAL_CLI_GPG_FINGERPRINT not configured",
        )

    tmp_dir = Path(tmp_dir)
    try:
        release = fetch_latest_release(http_get=http_get)
    except UpdaterError as exc:
        return UpdateOutcome(attempted=True, success=False, reason=f"could not fetch release info: {exc}")

    archive_path = tmp_dir / release.archive_name
    signature_path = tmp_dir / (release.archive_name + ".asc")
    try:
        download_to(release.archive_url, archive_path, http_get=http_get)
        download_to(release.signature_url, signature_path, http_get=http_get)

        if not verify_signature(
            archive_path, signature_path, fingerprint=config.signal_cli_gpg_fingerprint, run=run
        ):
            return UpdateOutcome(
                attempted=True,
                success=False,
                reason=f"GPG signature verification failed for {release.version}",
            )

        old_version = state.installed_version
        install_release(archive_path, config.signal_data_dir, release.version)
        return UpdateOutcome(
            attempted=True,
            success=True,
            reason="updated",
            old_version=old_version,
            new_version=release.version,
        )
    finally:
        # Never leave downloaded archives/signatures behind, whether the
        # update succeeded, failed verification, or errored partway through.
        archive_path.unlink(missing_ok=True)
        signature_path.unlink(missing_ok=True)
