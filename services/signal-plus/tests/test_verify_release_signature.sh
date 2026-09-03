#!/usr/bin/env bash
#
# test_verify_release_signature.sh — tests ../verify-release-signature.sh,
# the Dockerfile's SR-H-2 fix (security review 5105061153, PR #650): gpg
# still exits 0 and still emits VALIDSIG with the signer's REAL fingerprint
# even when the signing key has been revoked or has expired.
#
# The GOOD/REVOKED status-fd fixtures below are not hand-synthesized: they
# are the VERBATIM output captured from a real generated key, signed, then
# revoked via `gpg --gen-revoke` (reproduced while writing this fix; see the
# fix's commit for the exact commands). A fake `gpg` shim on PATH replays
# them so this test needs neither network nor a live gpg key each run.
#
# Run: bash services/signal-plus/tests/test_verify_release_signature.sh
set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SELF_DIR/../verify-release-signature.sh"
FPR="356D3284BCE316CCDA33047262E1A20EEB4E588F"
OTHER_FPR="0000000000000000000000000000000000000000"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

# --- fixtures: verbatim gpg --status-fd 1 output, captured from a real key ---

GOOD_STATUS="[GNUPG:] NEWSIG
[GNUPG:] KEY_CONSIDERED $FPR 0
[GNUPG:] SIG_ID Z5ddaNx2ZjikGFOp1xQkVupCFG0 2026-09-03 1788462489
[GNUPG:] GOODSIG 62E1A20EEB4E588F Fake Maintainer <fake@example.invalid>
[GNUPG:] VALIDSIG $FPR 2026-09-03 1788462489 0 4 0 22 10 00 $FPR
[GNUPG:] TRUST_ULTIMATE 0 pgp"

REVOKED_STATUS="[GNUPG:] NEWSIG
[GNUPG:] KEY_CONSIDERED $FPR 0
[GNUPG:] SIG_ID Z5ddaNx2ZjikGFOp1xQkVupCFG0 2026-09-03 1788462489
[GNUPG:] REVKEYSIG 62E1A20EEB4E588F Fake Maintainer <fake@example.invalid>
[GNUPG:] VALIDSIG $FPR 2026-09-03 1788462489 0 4 0 22 10 00 $FPR
[GNUPG:] KEYREVOKED
[GNUPG:] KEY_CONSIDERED $FPR 0
[GNUPG:] TRUST_ULTIMATE 0 pgp"

# No GOODSIG and no bad tag either -- an incomplete/unexpected gpg output
# shape that must not be treated as trusted just because nothing explicitly
# bad was seen (synthesized: this specific shape has no real-world gpg
# reproduction on hand, unlike the two fixtures above).
NO_GOODSIG_STATUS="[GNUPG:] NEWSIG
[GNUPG:] VALIDSIG $FPR 2026-09-03 1788462489 0 4 0 22 10 00 $FPR"

# --- fake gpg shim: replays a chosen fixture on stdout, ignores real args ---

FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/gpg" <<'SHIM'
#!/usr/bin/env bash
# Replays $FAKE_GPG_STATUS on stdout and exits $FAKE_GPG_EXIT -- a stand-in
# for `gpg --batch --status-fd 1 --verify <sig> <archive>` driven entirely
# by env vars the test sets before each case, never real args.
printf '%s\n' "${FAKE_GPG_STATUS:-}"
exit "${FAKE_GPG_EXIT:-0}"
SHIM
chmod +x "$FAKE_BIN/gpg"

SIG="$WORK/archive.bin.asc"
ARCHIVE="$WORK/archive.bin"
touch "$SIG" "$ARCHIVE"

run_case() {
  # run_case <status> <exit-code-from-gpg> <expected-verify-signature-exit> <fingerprint-arg> <description>
  local status="$1" gpg_exit="$2" expected_exit="$3" fpr_arg="$4" desc="$5"
  local out
  out="$(FAKE_GPG_STATUS="$status" FAKE_GPG_EXIT="$gpg_exit" PATH="$FAKE_BIN:$PATH" \
    bash "$SCRIPT" "$SIG" "$ARCHIVE" "$fpr_arg" 2>&1)"
  local actual_exit=$?
  if [ "$actual_exit" -eq "$expected_exit" ]; then
    PASS=$((PASS + 1))
    printf 'PASS  %s\n' "$desc"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %s (expected exit %d, got %d)\n' "$desc" "$expected_exit" "$actual_exit"
    printf '  output: %s\n' "$out"
  fi
}

run_case "$GOOD_STATUS" 0 0 "$FPR" \
  "[green] a genuinely good, non-revoked signature is accepted"

# THE money case: SR-H-2 itself. Real gpg output from a revoked key --
# exit=0, VALIDSIG with the CORRECT fingerprint, GOODSIG absent, REVKEYSIG +
# KEYREVOKED present. Must be REJECTED despite the matching fingerprint.
run_case "$REVOKED_STATUS" 0 1 "$FPR" \
  "[RED  ] a revoked key's signature is rejected even though the fingerprint matches -> red"

run_case "$GOOD_STATUS" 0 1 "$OTHER_FPR" \
  "[RED  ] a good signature from the WRONG key (fingerprint mismatch) is rejected -> red"

run_case "" 1 1 "$FPR" \
  "[RED  ] gpg exiting non-zero is rejected -> red"

run_case "$NO_GOODSIG_STATUS" 0 1 "$FPR" \
  "[RED  ] VALIDSIG present but GOODSIG absent (no bad tag either) is rejected -> red"

echo
echo "== test_verify_release_signature.sh: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
