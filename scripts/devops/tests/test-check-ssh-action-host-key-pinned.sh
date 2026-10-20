#!/usr/bin/env bash
# test-check-ssh-action-host-key-pinned.sh — proves
# scripts/devops/check-ssh-action-host-key-pinned.py goes RED when an appleboy ssh/scp
# step on a pin-capable version lacks a literal `fingerprint:`, and GREEN when every
# such step has one or its version is explicitly listed as an exemption.
#
# Why by running: a missing `fingerprint:` produces NO error anywhere — the step
# connects, the deploy is green, the host key is simply never checked. The guard is the
# only signal, so it must be seen going red on the broken input.
#
# Negative cases include the cheats: the word "fingerprint" in a comment or inside the
# `script:` body (not an input), a `${{ vars.* }}` expression (can be empty -> silent
# InsecureIgnoreHostKey), an exempt version that carries the input (ignored by the
# action, so it only looks verified), and an unclassified version (must be decided).
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="check-ssh-action-host-key-pinned.py"
FP="SHA256:aUhFBjtfQIpwUlMUA9Z5oKWXn8cIEdedrqt2eHNnGzo"
FP2="SHA256:lIxW01oTxlPOaVOsl3Fa7LkghgcHVRBaCc4QRdTLedg"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# $1 = case name, $2 = workflow content, $3 = optional exempt entry injected into the
# COPY of the guard's (empty) PINNING_EXEMPT table, so the exemption path can be run.
make_case() {
  local name="$1" workflow="$2" exempt="${3:-}"
  local root="$WS/$name"
  guard_test_fake_repo "$root" "$GUARD"
  printf '%s' "$workflow" >"$root/.github/workflows/deploy.yml"
  if [ -n "$exempt" ]; then
    sed -i.bak "s|^PINNING_EXEMPT = {}|PINNING_EXEMPT = {$exempt}|" "$root/scripts/devops/$GUARD"
    rm -f "$root/scripts/devops/$GUARD.bak"
  fi
  printf '%s' "$root"
}

run_guard() { python3 "$1/scripts/devops/$GUARD"; }

HEAD='name: Deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
'

ALL_PINNED_YML="${HEAD}      - name: a
        uses: appleboy/ssh-action@v1.2.0
        with:
          host: \${{ secrets.VPS_HOST }}
          fingerprint: $FP
          script: ls
      - name: b
        uses: appleboy/scp-action@v0.1.7
        with:
          host: \${{ secrets.VPS_HOST }}
          fingerprint: $FP
          source: x
      - name: c
        uses: appleboy/ssh-action@v1.2.3
        with:
          host: \${{ secrets.VPS_HOST }}
          fingerprint: $FP
          script: ls
"
UNPINNED_SSH_YML="${HEAD}      - name: a
        uses: appleboy/ssh-action@v1.2.0
        with:
          host: \${{ secrets.VPS_HOST }}
          script: ls
"
UNPINNED_SCP_YML="${HEAD}      - name: b
        uses: appleboy/scp-action@v0.1.7
        with:
          host: \${{ secrets.VPS_HOST }}
          source: x
"
# The pinned step comes SECOND; the first must not inherit its fingerprint across the boundary.
TWO_STEPS_YML="${HEAD}      - name: a
        uses: appleboy/ssh-action@v1.2.0
        with:
          host: \${{ secrets.VPS_HOST }}
          script: ls
      - name: b
        uses: appleboy/ssh-action@v1.2.3
        with:
          fingerprint: $FP
          script: ls
"
# Cheat: prose + the word inside the script body, but no input.
CHEAT_TEXT_YML="${HEAD}      # fingerprint: $FP  (pinned, honest)
      - name: a
        uses: appleboy/ssh-action@v1.2.0
        with:
          host: \${{ secrets.VPS_HOST }}
          script: |
            echo checking
            fingerprint: $FP
"
VARS_YML="${HEAD}      - name: a
        uses: appleboy/ssh-action@v1.2.0
        with:
          fingerprint: \${{ vars.VPS_HOST_FINGERPRINT }}
          script: ls
"
EMPTY_YML="${HEAD}      - name: a
        uses: appleboy/ssh-action@v1.2.0
        with:
          fingerprint:
          script: ls
"
UNCLASSIFIED_YML="${HEAD}      - name: a
        uses: appleboy/ssh-action@v9.9.9
        with:
          fingerprint: $FP
          script: ls
"
DISAGREE_YML="${HEAD}      - name: a
        uses: appleboy/ssh-action@v1.2.0
        with:
          fingerprint: $FP
          script: ls
      - name: b
        uses: appleboy/scp-action@v0.1.7
        with:
          fingerprint: $FP2
          source: x
"
EXEMPT_UNPINNED_YML="${HEAD}      - name: old
        uses: appleboy/ssh-action@v0.9.9
        with:
          host: \${{ secrets.VPS_HOST }}
          script: ls
"
EXEMPT_WITH_FP_YML="${HEAD}      - name: old
        uses: appleboy/ssh-action@v0.9.9
        with:
          fingerprint: $FP
          script: ls
"
EXEMPT_ENTRY='("appleboy/ssh-action", "v0.9.9"): "test fixture: version predates fingerprint"'

echo "== test-check-ssh-action-host-key-pinned.sh =="
echo

# ── positive ───────────────────────────────────────────────────────────────────
assert_green "all three pin-capable versions carrying the literal pass" \
  --contains "Pinned (literal fingerprint): 3" --contains "Violations found:             0" \
  -- run_guard "$(make_case all-pinned "$ALL_PINNED_YML")"

assert_green "a version listed in PINNING_EXEMPT passes without a fingerprint" \
  --contains "Exempt (cannot pin, listed):  1" --contains "Violations found:             0" \
  -- run_guard "$(make_case exempt-ok "$EXEMPT_UNPINNED_YML" "$EXEMPT_ENTRY")"

# ── negative ───────────────────────────────────────────────────────────────────
assert_red "ssh-action step without fingerprint -> red" \
  --contains "supports pinning but has no" \
  -- run_guard "$(make_case unpinned-ssh "$UNPINNED_SSH_YML")"

assert_red "scp-action step without fingerprint -> red" \
  --contains "appleboy/scp-action@v0.1.7" --contains "supports pinning but has no" \
  -- run_guard "$(make_case unpinned-scp "$UNPINNED_SCP_YML")"

assert_red "pinned LATER step does not rescue the unpinned earlier one -> red" \
  --contains "appleboy/ssh-action@v1.2.0" \
  -- run_guard "$(make_case two-steps "$TWO_STEPS_YML")"

assert_red "CHEAT: 'fingerprint:' only in a comment and a script body -> red" \
  --contains "supports pinning but has no" \
  -- run_guard "$(make_case cheat-text "$CHEAT_TEXT_YML")"

assert_red "fingerprint via \${{ vars.* }} (can be empty) -> red" \
  --contains "not a literal" \
  -- run_guard "$(make_case vars-expr "$VARS_YML")"

assert_red "empty fingerprint: -> red" \
  --contains "supports pinning but has no" \
  -- run_guard "$(make_case empty-fp "$EMPTY_YML")"

assert_red "unclassified action version -> red (must be decided from its action.yml)" \
  --contains "unclassified appleboy action/version" \
  -- run_guard "$(make_case unclassified "$UNCLASSIFIED_YML")"

assert_red "two different literals across steps -> red" \
  --contains "disagree on the fingerprint" \
  -- run_guard "$(make_case disagree "$DISAGREE_YML")"

assert_red "exempt version that carries fingerprint: (ignored by the action) -> red" \
  --contains "only LOOKS verified" \
  -- run_guard "$(make_case exempt-with-fp "$EXEMPT_WITH_FP_YML" "$EXEMPT_ENTRY")"

guard_test_summary "test-check-ssh-action-host-key-pinned.sh"
