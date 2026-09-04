#!/bin/sh
# docker-entrypoint.sh — two one-time-per-boot bootstrap steps, then exec the
# real command (PID 1 stays the actual signal-plus process; this script never
# lingers as a supervisor).
#
# Both steps below exist because they read as code the daemon SHOULD run on
# its own startup path (signal_plus/updater.py's own docstring: "образ несёт
# запиненную версию как запасную копию: при первом старте ... копируем из
# образа"), but neither signal_plus/cli.py's main()/main_with_config()/
# run_daemon() nor any other in-package entrypoint actually calls them —
# verified by grep, zero call sites outside updater.py's own tests. Step 2's
# task forbids editing signal_plus/*.py, so this is where the gap is closed
# instead; see the PR body's "Допущения" for why this is a deploy-time
# concern (container boot sequencing), not an application-code workaround,
# and a flag for the coder to consider wiring the same call inside cli.py
# too, for anyone who ever runs this package outside this image.
#
# 1. Seed $SIGNAL_DATA_DIR/bin/current from the image's pinned signal-cli
#    binary, IF the volume doesn't already have one (updater.ensure_seed_binary
#    — a no-op if `current` already exists, e.g. after an in-container
#    auto-update already replaced it). Uses the real, tested function via its
#    existing Python API — no reimplementation.
#
# 2. Import AsamK's signal-cli release-signing key into $GNUPGHOME (default
#    /data/gnupg, see the Dockerfile's ENV) so signal_plus.updater.verify_signature
#    (called at RUNTIME by the auto-update flow, not just at build time) has a
#    key to check future release signatures against. Idempotent — re-importing
#    an already-present key is a harmless no-op. The key file itself
#    (asamk.gpg) was fetched from https://github.com/AsamK.gpg and baked into
#    the image during the build's signal-cli-fetch stage (see Dockerfile) —
#    never re-fetched at runtime, so a runtime compromise of that URL cannot
#    silently swap the trust anchor this container verifies future updates
#    against.
#
# 3. Convenience symlink `bin/signal-cli` -> `bin/current`, PATH-resolvable
#    (Dockerfile puts /data/signal-cli/bin on PATH). The app itself never
#    needs this — signal_plus/signal.py always invokes the FULL path from
#    config.signal_cli_bin, which already points at .../bin/current. This
#    symlink exists purely so the OWNER's own interactive step 3 commands
#    (README.md "Деплой и линковка") can type plain `signal-cli link ...`
#    / `signal-cli listGroups` instead of the full volume path.
#
# 4. Create $TMPDIR/$SQLITE_TMPDIR/$SIGNAL_TMPDIR (default /data/tmp each,
#    see the Dockerfile's ENV) — SR-M-8 (security review round 2, id
#    5107124812), corrected by SR-H-4 (round 3, id 5108694371): the
#    native-image binary extracts+dlopen's native .so files at startup
#    (libsignal_jni for signal-cli itself, via the -Djava.io.tmpdir= argv
#    flag signal_plus/signal.py now always passes; sqlite-jdbc's own via
#    SQLITE_TMPDIR), and docker-compose.yml's tmpfs /tmp is noexec
#    (Docker's own default), which a dlopen from a noexec filesystem cannot
#    survive. Created here, unconditionally (unlike step 1, which only
#    runs when SIGNAL_DATA_DIR is configured) — the daemon needs a working
#    native-lib extraction directory regardless of whether auto-update
#    itself is set up. All three env vars default to the same path, so
#    this is usually one directory in practice, but each is created
#    explicitly rather than assuming they coincide.
set -eu

GNUPGHOME="${GNUPGHOME:-/data/gnupg}"
export GNUPGHOME
mkdir -p "$GNUPGHOME"
chmod 700 "$GNUPGHOME"
gpg --batch --quiet --import /opt/signal-cli-pinned/asamk.gpg >/dev/null 2>&1 || true

mkdir -p "${TMPDIR:-/data/tmp}" "${SQLITE_TMPDIR:-/data/tmp}" "${SIGNAL_TMPDIR:-/data/tmp}"

if [ -n "${SIGNAL_DATA_DIR:-}" ]; then
  # SR-M-2 (PR #650 security review, id 5105061153): SIGNAL_DATA_DIR was
  # previously interpolated straight into the Python SOURCE TEXT passed to
  # `python3 -c "..."` -- a value containing a single quote (e.g. from a
  # misconfigured/compromised SIGNAL_PLUS_ENV secret) closes the string
  # literal early and the rest of the value runs as arbitrary Python
  # (reproduced: `os.system(...)` executed via a crafted value, before
  # this fix). Passed as `sys.argv[1]` instead -- the value is data, never
  # source code, regardless of what characters it contains.
  python3 -c 'import sys; from signal_plus.updater import ensure_seed_binary; ensure_seed_binary(sys.argv[1])' "$SIGNAL_DATA_DIR"
  BIN_DIR="${SIGNAL_DATA_DIR}/bin"
  if [ -e "$BIN_DIR/current" ]; then
    ln -sf current "$BIN_DIR/signal-cli"
  fi
fi

exec "$@"
