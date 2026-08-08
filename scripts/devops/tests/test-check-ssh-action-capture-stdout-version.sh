#!/usr/bin/env bash
# test-check-ssh-action-capture-stdout-version.sh — proves
# scripts/devops/check-ssh-action-capture-stdout-version.py goes RED when a step
# asks appleboy/ssh-action for `capture_stdout` on a version that does not have it.
#
# This guard exists because that exact combination produces NO error at all — the
# step succeeds, `outputs.stdout` is just permanently empty. So the only way to
# know the guard works is to feed it the broken pin and watch it go red; there is
# no runtime symptom to fall back on.
#
# The negative cases include the version-in-a-comment cheat (a "bumped to v1.2.3"
# note above a `uses:` line still pinned at v1.2.0), and the precision cases check
# the guard does NOT fire on a low pin that never asks for capture_stdout — a
# false positive there would push someone to bump a version on a live deploy path
# for no reason, which is its own risk.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="check-ssh-action-capture-stdout-version.py"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# $1 = case name, $2 = workflow content
make_case() {
  local name="$1" workflow="$2"
  local root="$WS/$name"
  guard_test_fake_repo "$root" "$GUARD"
  printf '%s' "$workflow" >"$root/.github/workflows/deploy.yml"
  printf '%s' "$root"
}

run_guard() { python3 "$1/scripts/devops/$GUARD"; }

read -r -d '' SUPPORTED_YML <<'YML' || true
name: Deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Check backup freshness on VPS (SSH)
        id: backup-check
        uses: appleboy/ssh-action@v1.2.3
        with:
          host: ${{ secrets.VPS_HOST }}
          capture_stdout: true
          script: bash /opt/crm/scripts/devops/check-backup-freshness.sh
YML

read -r -d '' BROKEN_PIN_YML <<'YML' || true
name: Deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Check backup freshness on VPS (SSH)
        id: backup-check
        uses: appleboy/ssh-action@v1.2.0
        with:
          host: ${{ secrets.VPS_HOST }}
          capture_stdout: true
          script: bash /opt/crm/scripts/devops/check-backup-freshness.sh
YML

# The cheat: prose claims the pin is fine; the pin is not.
read -r -d '' COMMENT_CLAIMS_BUMP_YML <<'YML' || true
name: Deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      # VERSION PIN: bumped to v1.2.1+ because capture_stdout/outputs.stdout
      # only exist from appleboy/ssh-action@v1.2.1 onward. Verified against
      # the v1.2.3 action.yml.
      - name: Check backup freshness on VPS (SSH)
        uses: appleboy/ssh-action@v1.2.0
        with:
          capture_stdout: true
          script: bash /opt/crm/scripts/devops/check-backup-freshness.sh
YML

# No capture_stdout anywhere: an old pin here is deliberate and must stay green
# (bumping every ssh-action step "just in case" is unforced risk on a deploy path).
read -r -d '' OLD_PIN_NO_CAPTURE_YML <<'YML' || true
name: Deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Restart containers
        uses: appleboy/ssh-action@v1.2.0
        with:
          host: ${{ secrets.VPS_HOST }}
          script: docker compose up -d
YML

# Precision: capture_stdout belongs to the SECOND step. The first step's old pin
# must not inherit it across the step boundary.
read -r -d '' TWO_STEPS_YML <<'YML' || true
name: Deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Restart containers
        uses: appleboy/ssh-action@v1.2.0
        with:
          script: docker compose up -d
      - name: Check backup freshness on VPS (SSH)
        uses: appleboy/ssh-action@v1.2.3
        with:
          capture_stdout: true
          script: bash /opt/crm/scripts/devops/check-backup-freshness.sh
YML

read -r -d '' ANCIENT_PIN_YML <<'YML' || true
name: Deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Fetch DDL summary via SSH
        uses: appleboy/ssh-action@v1.1.0
        with:
          capture_stdout: true
          script: cat /opt/crm/summary.txt
YML

echo "== test-check-ssh-action-capture-stdout-version.sh =="
echo

# ── positive ───────────────────────────────────────────────────────────────────
assert_green "capture_stdout on a supported pin (v1.2.3) passes" \
  --contains "Violations found:        0" \
  -- run_guard "$(make_case supported "$SUPPORTED_YML")"

assert_green "old pin WITHOUT capture_stdout is out of scope, stays green" \
  --contains "Violations found:        0" \
  -- run_guard "$(make_case old-pin-no-capture "$OLD_PIN_NO_CAPTURE_YML")"

assert_green "capture_stdout in a LATER step does not incriminate the earlier old pin" \
  --contains "Violations found:        0" \
  -- run_guard "$(make_case two-steps "$TWO_STEPS_YML")"

# ── negative ───────────────────────────────────────────────────────────────────
assert_red "capture_stdout on v1.2.0 (feature does not exist there) -> red" \
  --contains "pinned @v1.2.0" \
  -- run_guard "$(make_case broken-pin "$BROKEN_PIN_YML")"

assert_red "CHEAT: comment claims the pin was bumped, uses: still v1.2.0 -> red" \
  --contains "pinned @v1.2.0" \
  -- run_guard "$(make_case comment-claims-bump "$COMMENT_CLAIMS_BUMP_YML")"

assert_red "capture_stdout on an ancient pin (v1.1.0) -> red" \
  --contains "pinned @v1.1.0" \
  -- run_guard "$(make_case ancient-pin "$ANCIENT_PIN_YML")"

guard_test_summary "test-check-ssh-action-capture-stdout-version.sh"
