#!/usr/bin/env bash
#
# verify-release-signature.sh — gpg verification of a signal-cli release
# archive, used by the Dockerfile's signal-cli-fetch build stage.
#
# Extracted to its own script (SR-H-2, security review 5105061153, PR #650)
# so this exact check is testable outside a Docker build — the Dockerfile's
# previous inline shell duplicated signal_plus.updater.verify_signature's
# logic by hand and had silently drifted from it, missing the same
# revoked/expired-key gap that function had. Keeping ONE script the
# Dockerfile RUNs (instead of reimplementing shell logic inline) means the
# two checks cannot drift apart again — see that function's own docstring
# for the full "why" this mirrors, mutually.
#
# Usage: verify-release-signature.sh <sig-file> <archive-file> <fingerprint>
# Exit 0 = the signature is trustworthy. Exit 1 = rejected; reason on stderr.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: verify-release-signature.sh <sig-file> <archive-file> <fingerprint>" >&2
  exit 2
fi

SIG="$1"
ARCHIVE="$2"
FINGERPRINT="$3"

STATUS_LOG="$(mktemp)"
STDERR_LOG="$(mktemp)"
trap 'rm -f "$STATUS_LOG" "$STDERR_LOG"' EXIT

if ! gpg --batch --status-fd 1 --verify "$SIG" "$ARCHIVE" >"$STATUS_LOG" 2>"$STDERR_LOG"; then
  echo "signature verification FAILED (gpg exit != 0):" >&2
  cat "$STDERR_LOG" >&2
  exit 1
fi

# SR-H-2: gpg still exits 0 and still emits VALIDSIG (with the signer's REAL
# fingerprint) even when the signing key has been revoked or has expired —
# it swaps GOODSIG for one of these tags instead. Reproduced against a real
# generated-then-revoked test key (see services/signal-plus/tests/
# test_verify_release_signature.sh): exit=0, REVKEYSIG present, VALIDSIG
# present with the correct fingerprint, KEYREVOKED present, GOODSIG absent.
# The fingerprint pin two checks below defends against a DIFFERENT key
# signing the release; it does nothing against the SAME key being revoked,
# which is the one mechanism a maintainer has to disown a compromised key.
GOOD_SIG_FOUND=0
BAD_TAG_FOUND=""
while IFS= read -r line; do
  case "$line" in
    "[GNUPG:] "*)
      tag="${line#"[GNUPG:] "}"
      tag="${tag%% *}"
      case "$tag" in
        GOODSIG) GOOD_SIG_FOUND=1 ;;
        REVKEYSIG | EXPKEYSIG | KEYREVOKED | KEYEXPIRED | EXPSIG | BADSIG | ERRSIG)
          BAD_TAG_FOUND="$tag"
          ;;
      esac
      ;;
  esac
done <"$STATUS_LOG"

if [ -n "$BAD_TAG_FOUND" ]; then
  echo "signature rejected: gpg reported $BAD_TAG_FOUND (revoked/expired key or signature):" >&2
  cat "$STATUS_LOG" >&2
  exit 1
fi

if [ "$GOOD_SIG_FOUND" -ne 1 ]; then
  echo "signature rejected: no GOODSIG in gpg status output (untrusted/incomplete verification):" >&2
  cat "$STATUS_LOG" >&2
  exit 1
fi

if ! grep -q "^\[GNUPG:\] VALIDSIG ${FINGERPRINT} " "$STATUS_LOG"; then
  echo "signature is valid but NOT from the expected key ${FINGERPRINT}:" >&2
  cat "$STATUS_LOG" >&2
  exit 1
fi

echo "signature verified (${FINGERPRINT})"
