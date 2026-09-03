# ============================================================
# signal-plus — daily morning "+" roll-call to a Signal group via signal-cli.
#
# Build context is THIS directory (services/signal-plus/), not the repo
# root — this is not a pnpm workspace member (see README.md), so it needs
# none of the monorepo's node/pnpm layers.
#
#   docker build --platform linux/amd64 -t signal-plus:local .
#
# Three stages:
#   1. signal-cli-fetch — download the pinned signal-cli Linux-native
#      release, verify its GPG signature, extract the binary. Verification
#      failure here fails the whole build (see "why fail-loud" below).
#   2. test              — install the package with dev extras, run the
#      real test suite (AC1-AC7, task-signal-plus-service.md). The runtime
#      stage COPIEs its source FROM this stage (not from the build context
#      directly), so a change that makes tests fail cannot silently produce
#      a runtime image that skipped them — BuildKit only executes a stage
#      that something downstream actually depends on.
#   3. runtime            — python:3.12-slim + the verified signal-cli
#      binary (pinned fallback copy) + qrencode (step 3's QR display) +
#      gnupg (the auto-updater's own `gpg --verify`, run at RUNTIME too,
#      not only here at build time) + the installed signal_plus package,
#      running as a non-root user.
# ============================================================

# ---- Stage 1: signal-cli-fetch --------------------------------------------
# Same base as the runtime stage (python:3.12-slim / Debian) so this
# lightly-used stage does not introduce a second, independently-drifting
# Debian release train to reason about — the binary itself needs no
# compilation, just download/verify/extract.
FROM python:3.12-slim AS signal-cli-fetch

# EXACT pin (never "latest"): the whole point of verifying a signature is
# to know exactly which bytes you trusted — a floating tag would make that
# meaningless. Bumping this means re-deriving the release's asset names
# below (they embed the version) and re-confirming the fingerprint hasn't
# rotated (module docstring in signal_plus/updater.py has the full citation
# trail for how FA10826A74907F9EC6BBB7FC2BA2CD21B5B09570 was obtained).
ARG SIGNAL_CLI_VERSION=0.14.7
ARG SIGNAL_CLI_GPG_FINGERPRINT=FA10826A74907F9EC6BBB7FC2BA2CD21B5B09570

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Independent source, not the artifact being verified — see
# signal_plus/updater.py's module docstring "GPG FINGERPRINT" section for
# the full three-source cross-check this project already did once by hand.
# Kept as a build artifact (COPYed into the runtime stage below) so the
# RUNNING container's auto-updater (signal_plus.updater.verify_signature,
# called again at runtime on every update attempt) verifies against the
# SAME key without ever re-fetching this URL itself — a runtime compromise
# of github.com/AsamK.gpg cannot silently swap the trust anchor an
# already-built, already-verified image checks future updates against.
RUN curl -fsSL -o asamk.gpg https://github.com/AsamK.gpg

RUN curl -fsSL -o signal-cli.tar.gz \
      "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}-Linux-native.tar.gz" \
    && curl -fsSL -o signal-cli.tar.gz.asc \
      "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}-Linux-native.tar.gz.asc"

# Fail-loud, not "should be fine": a signature that does not verify, or
# verifies but was made by some OTHER key, must stop the build cold — the
# same "no trust-on-first-use" requirement signal_plus.updater.verify_signature
# enforces at runtime (task requirement 8), mirrored here at build time for
# the pinned copy. `gpg --status-fd 1 --verify` followed by a `VALIDSIG
# <fingerprint>` line match is the exact mechanism that function uses too —
# duplicated here in shell (not imported — this stage has no signal_plus
# package yet) rather than invented independently, so both checks agree by
# construction on what "verified" means.
RUN set -eu; \
    gpg --batch --import asamk.gpg; \
    if gpg --batch --status-fd 1 --verify signal-cli.tar.gz.asc signal-cli.tar.gz \
        > gpg-status.log 2> gpg-stderr.log; then \
      if ! grep -q "^\[GNUPG:\] VALIDSIG ${SIGNAL_CLI_GPG_FINGERPRINT} " gpg-status.log; then \
        echo "signal-cli release signature is valid but NOT from the expected key ${SIGNAL_CLI_GPG_FINGERPRINT}:" >&2; \
        cat gpg-status.log >&2; \
        exit 1; \
      fi; \
    else \
      echo "signal-cli release signature verification FAILED:" >&2; \
      cat gpg-stderr.log >&2; \
      exit 1; \
    fi; \
    echo "signal-cli v${SIGNAL_CLI_VERSION} release signature verified (${SIGNAL_CLI_GPG_FINGERPRINT})"

# The Linux-native archive is a single executable file named `signal-cli` at
# the archive root (no wrapping directory) — confirmed against the real
# v0.14.7 release asset with `tar -tvzf` before writing this, and already
# documented the same way in signal_plus/updater.py's install_release().
#
# Deliberately NOT executed here (no `./signal-cli --version` in this build
# step): this is a GraalVM native-image binary built for real x86_64
# silicon, and a `--platform linux/amd64` build running under QEMU
# user-mode emulation (e.g. on an Apple Silicon dev machine) can fail an
# internal CPU-ISA-level check the binary does at startup against QEMU's
# own, more conservative default emulated CPU model (reproduced while
# developing this stage: "CPU ISA level is lower than required", gone once
# the emulated CPU model was widened) — an emulation artifact, not evidence
# the binary is broken. On GitHub Actions' `ubuntu-latest` runner (real
# amd64 hardware, what actually builds this image for GHCR) and on the
# target Hetzner VPS (also real amd64) this does not apply. The actual
# `signal-cli --version` check happens as a separate `docker run` against
# the finished image instead — see the PR body's local-verification section
# — precisely so this build step's own success/failure reflects the
# archive's integrity (extraction), not the host machine's CPU emulation.
RUN tar -xzf signal-cli.tar.gz && chmod 755 signal-cli && test -x signal-cli

# ---- Stage 2: test ----------------------------------------------------------
# Gate, not an artifact producer: the runtime stage copies SOURCE from here
# (see below), which is what forces BuildKit to actually run this stage on
# every build — an unreferenced stage would simply be skipped.
FROM python:3.12-slim AS test
WORKDIR /src
COPY pyproject.toml ./
COPY signal_plus ./signal_plus
COPY tests ./tests
RUN pip install --no-cache-dir '.[dev]'
# AC6 (task-signal-plus-service.md): the suite itself refuses real
# signal-cli/network access (tests/conftest.py empties PATH and forbids
# socket.socket) — nothing extra required here to keep this build hermetic.
RUN python -m pytest

# ---- Stage 3: runtime --------------------------------------------------------
FROM python:3.12-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates gnupg qrencode \
    && rm -rf /var/lib/apt/lists/*

# Fixed, explicit uid/gid rather than relying on whatever `useradd` picks —
# this repo does not use this image's uid anywhere else, but a stable
# number is one less thing to guess when debugging file ownership on the
# volume later. Real login shell not needed; -M skips creating a home dir
# under /home (nothing is stored there — see XDG_DATA_HOME below, which
# points signal-cli's own data at the mounted volume instead).
RUN groupadd -g 10001 signalplus \
    && useradd -M -u 10001 -g signalplus -s /usr/sbin/nologin signalplus

WORKDIR /app

# ---- signal-cli: the verified pinned binary + its trust anchor -----------
# Fallback copy signal_plus.updater.ensure_seed_binary() seeds the volume
# from on first boot (see docker-entrypoint.sh) — the running service NEVER
# executes this path directly (config.py's SIGNAL_CLI_BIN points at the
# volume's bin/current symlink instead); this is only ever a source to copy
# from. Path matches signal_plus.updater.DEFAULT_IMAGE_PINNED_BIN_DIR.
COPY --from=signal-cli-fetch /build/signal-cli /opt/signal-cli-pinned/signal-cli
# Public key only (not the whole scratch keyring) — docker-entrypoint.sh
# imports this into $GNUPGHOME on every boot so the auto-updater's runtime
# `gpg --verify` calls have a key to check against. See that script's
# header comment for why this is baked in once rather than re-fetched.
COPY --from=signal-cli-fetch /build/asamk.gpg /opt/signal-cli-pinned/asamk.gpg

# ---- signal_plus package (from the TESTED stage, not the raw context) ----
COPY --from=test /src/pyproject.toml ./
COPY --from=test /src/signal_plus ./signal_plus
# No third-party runtime dependencies (pyproject.toml's dependencies = []) —
# this only registers the package + the `signal-plus` console-script entry
# point (pyproject.toml [project.scripts]). Dev-only deps (pytest) from the
# `test` stage are NOT installed here.
RUN pip install --no-cache-dir .

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY docker-healthcheck.py /app/docker-healthcheck.py
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

# /data is where docker-compose.yml mounts the named `signal_data` volume.
# Docker copies a NEW (empty) named volume's initial content — including
# ownership — from whatever already exists at that path in the image, the
# first time it is mounted; without this, a fresh volume mounts in owned by
# root:root (0755), and the non-root `signalplus` user below cannot even
# `mkdir` under /data (reproduced while developing this stage: `mkdir
# /data/gnupg` failing with "Permission denied" against a brand-new named
# volume before this line existed). Empty on purpose — actual content is
# written at runtime by docker-entrypoint.sh / the app itself, never baked
# into the image.
RUN mkdir -p /data && chown signalplus:signalplus /data

# signal-cli itself (not this project's own code) resolves its account/
# session data directory as $XDG_DATA_HOME/signal-cli when no --config flag
# is given (confirmed against signal-cli's own man page: "default data
# directory is $XDG_DATA_HOME/signal-cli, default $HOME/.local/share") —
# signal_plus/signal.py never passes --config, so this env var is the only
# lever that puts the LINKED DEVICE IDENTITY on the persistent volume
# instead of the container's throwaway filesystem. Pointed at the SAME
# volume root SIGNAL_DATA_DIR uses (compose sets both to paths under
# /data) — signal-cli's own subdirectories (data/, avatars/, ...) and this
# project's bin/ subfolder never collide (verified: none of signal-cli's
# own paths are named "bin").
ENV XDG_DATA_HOME=/data
# See docker-entrypoint.sh — kept on the volume (not e.g. /root/.gnupg)
# specifically so it survives container recreation and stays writable even
# under docker-compose.yml's `read_only: true`.
ENV GNUPGHOME=/data/gnupg
ENV PYTHONUNBUFFERED=1
# Under docker-compose.yml's `read_only: true`, Python's default attempt to
# cache .pyc bytecode alongside the installed package in site-packages would
# just fail-and-fall-back silently on every start (harmless but pointless);
# this skips the attempt outright rather than relying on that fallback.
# Confirmed the container still boots fine WITHOUT this too (tested
# `--read-only --tmpfs /tmp --tmpfs /run` against the entrypoint before
# adding this line) — this is a hygiene cleanup, not a fix for a real failure.
ENV PYTHONDONTWRITEBYTECODE=1
# signal_plus/signal.py always invokes signal-cli via config.signal_cli_bin's
# FULL path — it never relies on PATH, so this is only for the OWNER's own
# interactive step 3 commands (README.md "Деплой и линковка": `docker
# compose -p signal-plus run --rm -it signal-plus signal-cli link -n
# ...`), so a bare `signal-cli` resolves without needing to know or type
# /data/signal-cli/bin/current. Note this is a `signal-cli` FILENAME, not
# `current` — docker-entrypoint.sh creates a `bin/signal-cli -> current`
# symlink on every boot specifically so PATH lookup (which matches by
# filename) can find it; the `current` symlink itself, which the app reads,
# is untouched. Hardcodes the SAME path .env.example's SIGNAL_DATA_DIR
# documents (/data/signal-cli) — if that env var is ever changed to
# something else, this convenience path goes stale (the app itself would be
# unaffected, since it always reads config.signal_cli_bin's full runtime
# path, never PATH).
ENV PATH="/data/signal-cli/bin:${PATH}"

USER signalplus

# No HEALTHCHECK-relevant port — see docker-healthcheck.py's own docstring
# for why this reuses the daemon's real state/slot/config contract instead
# of curl (there is nothing to curl: "Никаких портов наружу") or an
# invented heartbeat file (no such concept exists in signal_plus/*.py).
HEALTHCHECK --interval=5m --timeout=10s --start-period=30s --retries=3 \
  CMD ["python3", "/app/docker-healthcheck.py"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
# Daemon mode (signal_plus.cli.run_daemon) by default — the entrypoint's
# `exec "$@"` runs this unless docker-compose.yml/`docker compose run`
# overrides the command (e.g. the README's --groups / link flow in step 3).
CMD ["signal-plus"]
