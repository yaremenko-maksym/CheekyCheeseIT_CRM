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

# SR-M-11 (PR #650 security review round 4, id 5109138286): a fingerprint
# argument that is not the expected shape cannot possibly be the trusted
# pin -- validated up front, exit 1 (not the usage-error exit 2 above: this
# IS the right argument count, just not a fingerprint), per the finding's
# own instruction. Also closes off feeding this value into the field-match
# below with anything but the 40 plain hex characters it expects.
if [[ ! "$FINGERPRINT" =~ ^[0-9A-Fa-f]{40}$ ]]; then
  echo "fingerprint argument is not exactly 40 hex characters: ${FINGERPRINT}" >&2
  exit 1
fi

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
# SR-M-11: the fingerprint gpg actually vouches for, read from the FIELD of
# an actual VALIDSIG-tagged line -- never set from anywhere else.
VALIDSIG_FPR=""
while IFS= read -r line; do
  case "$line" in
    "[GNUPG:] "*)
      payload="${line#"[GNUPG:] "}"
      tag="${payload%% *}"
      case "$tag" in
        GOODSIG) GOOD_SIG_FOUND=1 ;;
        VALIDSIG)
          # Field 2 of the status line (the fingerprint), by position --
          # NOT a substring search over the whole file. SR-M-11 (round 4,
          # id 5109138286): SR-L-6's `grep -qF` fix (round 3) matched the
          # pin as a substring ANYWHERE in $STATUS_LOG, including inside
          # gpg's own NOTATION_DATA tag -- notation content is chosen by
          # the SIGNER and gpg reproduces it verbatim, so a signature from
          # an untrusted key carrying "[GNUPG:] VALIDSIG <pinned-fpr> " as
          # literal notation TEXT satisfied that grep even though the
          # line ACTUALLY tagged VALIDSIG named a different key entirely
          # (reproduced in tests/test_verify_release_signature.sh: exit 0
          # on the round-3 code, on a status log whose real VALIDSIG is
          # $OTHER_FPR). Only a real VALIDSIG line's own fingerprint FIELD
          # can ever set this.
          rest="${payload#"$tag" }"
          VALIDSIG_FPR="${rest%% *}"
          ;;
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

# SR-L-6 (round 3, id 5108694371) made this a fixed-string match instead of
# a BRE pattern; SR-M-11 (round 4, id 5109138286) made it a FIELD match
# instead of a substring-anywhere-in-the-file match -- see VALIDSIG_FPR's
# extraction above for why "-F" alone was not enough on its own.
if [ -z "$VALIDSIG_FPR" ] || [ "$VALIDSIG_FPR" != "$FINGERPRINT" ]; then
  echo "signature is valid but NOT from the expected key ${FINGERPRINT} (VALIDSIG field: ${VALIDSIG_FPR:-<none found>}):" >&2
  cat "$STATUS_LOG" >&2
  exit 1
fi

echo "signature verified (${FINGERPRINT})"
