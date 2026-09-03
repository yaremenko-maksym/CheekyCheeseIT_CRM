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
import re
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

# SR-M-1 (PR #650 security review, id 5105061153): the GitHub Releases API
# response is attacker-influenceable network input, not pre-validated data --
# `tag_name`/asset `name` become filesystem path components
# (install_release's `data_dir / "bin" / version`, download_to's
# `tmp_dir / archive_name`), and `browser_download_url` is fetched as-is
# with no host check. Reproduced: an unvalidated `tag_name` of
# `../../../../ESCAPED` installed OUTSIDE SIGNAL_DATA_DIR and pointed
# bin/current there; a `browser_download_url` of `https://evil.example/a`
# was downloaded and would have passed a VALID GPG signature check (the
# signature is over the archive BYTES, not over where they came from).
_SAFE_TOKEN_RE = re.compile(r"^[0-9A-Za-z._-]+$")

# Verified against the REAL GitHub Releases API response, 2026-09-03
# (`gh api repos/AsamK/signal-cli/releases/latest`): browser_download_url is
# ALWAYS this exact `github.com/<owner>/<repo>/releases/download/<tag>/`
# wrapper form -- never the release-assets.githubusercontent.com CDN host
# the actual bytes 302-redirect to (that redirect is GitHub's own server
# decision once urllib.request.urlopen follows it, not attacker-influenced
# API-response data, so it is not separately allow-listed here).
_ALLOWED_DOWNLOAD_URL_PREFIX = "https://github.com/AsamK/signal-cli/releases/download/"

# ~2.4x the real ~104 MB Linux-native asset (task's "Проверенные факты") --
# bounds both the in-memory buffer of a real network read (_default_http_get)
# and, redundantly, whatever download_to's caller passes as `http_get`
# (defense in depth: the cap must hold even if a future refactor swaps in an
# http_get that does not itself bound its read).
MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024


def _validate_safe_token(value: str, *, field: str) -> str:
    """Reject anything that is not a safe, single-segment filesystem token --
    no `/`, no `..`, no other path-meaningful character. Used for both
    `tag_name` (-> version) and the asset `name` (-> archive_name), both of
    which get joined onto a real filesystem path later.
    """
    if not _SAFE_TOKEN_RE.match(value) or ".." in value:
        raise UpdaterError(f"{field} {value!r} is not a safe filesystem token")
    return value


def _validate_download_url(url: str, *, field: str) -> str:
    """Reject any URL outside the exact GitHub Releases download prefix for
    this repo -- a fingerprint-valid signature says nothing about WHERE the
    bytes were fetched from, only that they match whatever the archive
    turned out to contain.
    """
    if not url.startswith(_ALLOWED_DOWNLOAD_URL_PREFIX):
        raise UpdaterError(f"{field} {url!r} is not an allowed signal-cli release download URL")
    return url


def _parse_version_tuple(version: str) -> tuple[int, ...] | None:
    """Best-effort dotted-numeric parse (`"0.14.7" -> (0, 14, 7)`) for the
    downgrade check in :func:`run_auto_update`. Returns ``None`` for
    anything not purely dotted integers -- by the time a version reaches
    here it has already passed :func:`_validate_safe_token`, so this is
    about making the COMPARISON meaningful, not a second security gate.
    """
    try:
        return tuple(int(part) for part in version.split("."))
    except ValueError:
        return None


def _is_strictly_newer(candidate: str, installed: str) -> bool:
    candidate_tuple = _parse_version_tuple(candidate)
    installed_tuple = _parse_version_tuple(installed)
    if candidate_tuple is None or installed_tuple is None:
        # Cannot compare meaningfully -- fail closed: refuse rather than
        # silently accept an unparseable "newer" claim.
        return False
    return candidate_tuple > installed_tuple


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
        # SR-M-1: bound the in-memory read at the source -- response.read()
        # with no argument would buffer an arbitrarily large response (a
        # compromised/misbehaving server serving "a few hundred MB" is an
        # OOM-kill-and-restart, not merely a slow download).
        data = response.read(MAX_DOWNLOAD_BYTES + 1)
        if len(data) > MAX_DOWNLOAD_BYTES:
            raise UpdaterError(f"response from {url} exceeded the {MAX_DOWNLOAD_BYTES}-byte limit")
        return data


def fetch_latest_release(*, http_get=_default_http_get) -> ReleaseAsset:
    """Fetch and parse the latest GitHub release, picking the Linux-native asset.

    SR-M-1: every field taken from the response is validated before being
    trusted as a filesystem path component (`version`, `archive_name`) or a
    URL to fetch (`archive_url`, `signature_url`) — this response is network
    input, not pre-validated data.

    SR-H-3 (PR #650 security review round 2, id 5107124812, OWASP A08):
    `tag_name`, the asset `name`, and the download URLs are three SEPARATE
    fields from that same untrusted response, and nothing tied them
    together before this — `tag_name` announcing "v9.9.9" while the asset
    name/URLs pointed at the real, validly-signed v0.9.0 release passed
    every check that existed (GPG signature valid, host allow-listed,
    "9.9.9" > any real installed version). The signature proves the BYTES
    are genuinely AsamK's; it says nothing about what version those bytes
    are being presented as. Requiring the asset name and both URLs to
    literally contain the announced tag closes that gap at the one place
    all three fields are read together, before any of them is trusted
    individually.
    """
    raw = http_get(GITHUB_RELEASES_API)
    try:
        data = json.loads(raw)
        assets = {a["name"]: a["browser_download_url"] for a in data["assets"]}
        archive_name = next(name for name in assets if name.endswith(_NATIVE_ASSET_SUFFIX))
        signature_name = archive_name + ".asc"
        signature_url = assets[signature_name]
        version = str(data["tag_name"]).lstrip("v")
        raw_tag = str(data["tag_name"])
    except (KeyError, StopIteration, json.JSONDecodeError) as exc:
        raise UpdaterError(f"unexpected GitHub releases API response: {exc}") from exc

    _validate_safe_token(version, field="tag_name")
    _validate_safe_token(archive_name, field="asset name")
    archive_url = _validate_download_url(assets[archive_name], field="archive_url")
    signature_url = _validate_download_url(signature_url, field="signature_url")

    # SR-H-3: bind tag_name <-> asset name <-> URL into one assertion.
    expected_archive = f"signal-cli-{version}-Linux-native.tar.gz"
    if archive_name != expected_archive:
        raise UpdaterError(
            f"asset name {archive_name!r} does not match tag {raw_tag!r} "
            f"(expected {expected_archive!r})"
        )
    expected_prefix = _ALLOWED_DOWNLOAD_URL_PREFIX + raw_tag + "/"
    if not archive_url.startswith(expected_prefix) or not signature_url.startswith(expected_prefix):
        raise UpdaterError(f"download URL does not belong to the announced tag {raw_tag!r}")

    return ReleaseAsset(
        version=version,
        archive_name=archive_name,
        archive_url=archive_url,
        signature_url=signature_url,
    )


def download_to(url: str, dest: Path, *, http_get=_default_http_get) -> Path:
    """Fetch ``url`` via ``http_get`` and write it to ``dest``.

    SR-M-1: re-checks the size limit here too (not just inside the real
    ``_default_http_get``) — defense in depth so the cap holds regardless of
    which ``http_get`` implementation a caller wires in, not only the
    default one.
    """
    data = http_get(url)
    if len(data) > MAX_DOWNLOAD_BYTES:
        raise UpdaterError(f"download from {url} is {len(data)} bytes, exceeding the {MAX_DOWNLOAD_BYTES}-byte limit")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
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

    # SR-M-1: "проверено: installed_version='0.14.7', «latest» заявляет
    # '0.9.0' -> success=True ... Откат на старый, законно подписанный,
    # уязвимый signal-cli подписью не ловится -- она валидна." The GPG pin
    # (below) defends the CONTENT of the download; it says nothing about the
    # DIRECTION of the version change. Skipped when nothing is recorded yet
    # (image-pinned fallback binary, never auto-updated before) -- there is
    # no baseline to compare against, and refusing here would break the
    # auto-update feature's entire first-trigger case.
    if state.installed_version is not None and not _is_strictly_newer(release.version, state.installed_version):
        return UpdateOutcome(
            attempted=True,
            success=False,
            reason=(
                f"latest release {release.version} is not newer than installed "
                f"{state.installed_version} -- refusing to downgrade"
            ),
        )

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
        current_link = Path(config.signal_data_dir) / "bin" / "current"
        # Capture what `current` pointed at BEFORE the swap -- the only
        # thing SR-H-3 part 2's rollback below can restore. A dangling/
        # missing prior symlink is treated the same as "nothing to roll
        # back to" (readlink would raise) -- an unlikely disk-tampering
        # edge case, not worth failing the whole update attempt over.
        previous_target: str | None = None
        if current_link.is_symlink():
            try:
                previous_target = os.readlink(current_link)
            except OSError:
                previous_target = None

        new_current = install_release(archive_path, config.signal_data_dir, release.version)

        # SR-H-3 part 2 (task-650-fix-round-1.md, fix-round 2): the GPG
        # signature just verified proves AsamK signed THESE BYTES -- it says
        # nothing about whether those bytes are truthfully the version they
        # were announced as (a compromised/stale release pipeline could
        # validly sign old content under a new tag/filename, which SR-H-3
        # part 1's tag<->asset<->URL binding cannot catch on metadata
        # alone). Run the binary that ACTUALLY landed and require its own
        # --version output to agree before trusting the swap.
        version_check = run(
            [str(new_current), "--version"], capture_output=True, text=True, timeout=30
        )
        actual_version = ((version_check.stdout or "") + (version_check.stderr or "")).strip()
        if release.version not in actual_version:
            if previous_target is not None:
                tmp_link = current_link.parent / ".current.tmp"
                if tmp_link.is_symlink() or tmp_link.exists():
                    tmp_link.unlink()
                tmp_link.symlink_to(previous_target)
                os.replace(tmp_link, current_link)
            else:
                current_link.unlink(missing_ok=True)
            return UpdateOutcome(
                attempted=True,
                success=False,
                reason=(
                    f"installed binary reports {actual_version!r}, expected "
                    f"{release.version!r} -- rolled back"
                ),
            )

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
