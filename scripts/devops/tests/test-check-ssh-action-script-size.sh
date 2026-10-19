#!/usr/bin/env bash
# test-check-ssh-action-script-size.sh — proves
# scripts/devops/check-ssh-action-script-size.py goes RED when an appleboy/ssh-action
# step's inline `script:` approaches Linux MAX_ARG_STRLEN.
#
# This guard exists because the real failure has no gradient and no early symptom.
# On 2026-10-19 deploy.yml's main SSH step crossed 131072 bytes and the deploy of
# b2054f8a1 died with "Argument list too long" before the step started — every guard
# green, prettier clean, YAML valid, and `main` undeployable for every commit until
# the step was restructured. So the only way to know this guard works is to hand it
# an oversized script and watch it refuse.
#
# The negative cases include the comment cheat (prose claiming the script "was moved
# to script_path" above a block that was not), and the precision cases check the two
# false positives that would do real damage: a `script:` belonging to some OTHER
# action must never be charged to an ssh-action step, and a step that already uses
# `script_path:` must stay green no matter how large the referenced file is — that
# being the escape hatch the guard's own error message tells people to take.
#
# One case asserts an EXACT byte count. The incident was first mis-measured by
# hand-counting source lines (reported 131538/+466 when the real figure was
# 133905/+2833), and a size guard whose arithmetic nobody checks is decoration —
# so the number itself is under test, not just the verdict.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="check-ssh-action-script-size.py"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# $1 = case name, $2 = workflow content, $3 = bytes of script file to generate
#      ("absent" to omit the file entirely)
make_path_case() {
  local name="$1" workflow="$2" bytes="$3"
  local root="$WS/$name"
  guard_test_fake_repo "$root" "$GUARD"
  mkdir -p "$root/scripts/devops"
  printf '%s' "$workflow" >"$root/.github/workflows/deploy.yml"
  if [ "$bytes" != "absent" ]; then
    awk -v n="$bytes" 'BEGIN { for (i = 0; i < n; i++) printf "x" }' \
      >"$root/scripts/devops/deploy-stack-on-vps.sh"
  fi
  printf '%s' "$root"
}

# $1 = case name, $2 = workflow content
make_case() {
  local name="$1" workflow="$2"
  local root="$WS/$name"
  guard_test_fake_repo "$root" "$GUARD"
  printf '%s' "$workflow" >"$root/.github/workflows/deploy.yml"
  printf '%s' "$root"
}

# $1 = case name, $2 = `uses:` value, $3 = extra `with:` lines (may be empty),
# $4 = how many body lines of inline script to generate.
# Builds a workflow whose step carries a deliberately huge inline `script:`.
make_big_case() {
  local name="$1" uses="$2" extra="$3" count="$4"
  local root="$WS/$name"
  guard_test_fake_repo "$root" "$GUARD"
  local wf="$root/.github/workflows/deploy.yml"
  {
    echo "name: Deploy"
    echo "on: [push]"
    echo "jobs:"
    echo "  deploy:"
    echo "    runs-on: ubuntu-latest"
    echo "    steps:"
    echo "      - name: Pull, up, migrate, health-check via SSH"
    echo "        uses: $uses"
    echo "        with:"
    echo "          host: \${{ secrets.VPS_HOST }}"
    [ -n "$extra" ] && printf '%s\n' "$extra"
    echo "          script: |"
    echo "            set -euo pipefail"
    # ~50 bytes per line once dedented, so 2600 lines lands well past 100000.
    awk -v n="$count" 'BEGIN { for (i = 0; i < n; i++) printf "            echo \"==> applying DDL block %05d of the deploy\"\n", i }'
  } >"$wf"
  printf '%s' "$root"
}

run_guard() { python3 "$1/scripts/devops/$GUARD"; }

read -r -d '' SMALL_YML <<'YML' || true
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
          script: |
            echo aaa
            echo aaa
            echo aaa
YML

# The post-fix shape of the real step: no inline script at all.
read -r -d '' SCRIPT_PATH_YML <<'YML' || true
name: Deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout (for the deploy script passed via script_path)
        uses: actions/checkout@v4
      - name: Pull, up, migrate, health-check via SSH
        uses: appleboy/ssh-action@v1.2.0
        with:
          host: ${{ secrets.VPS_HOST }}
          envs: IMAGE_TAG,GH_ACTOR,GHCR_TOKEN,CRM_CSP_MODE
          script_path: ${{ github.workspace }}/scripts/devops/deploy-stack-on-vps.sh
YML

# The post-both-incidents real shape: body delivered by scp, command is a path.
read -r -d '' DISPATCH_YML <<'YML' || true
name: Deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Copy the deploy script to the VPS via SCP
        uses: appleboy/scp-action@v0.1.7
        with:
          source: 'scripts/devops/deploy-stack-on-vps.sh'
          target: '/opt/crm'
      - name: Pull, up, migrate, health-check via SSH
        uses: appleboy/ssh-action@v1.2.0
        with:
          host: ${{ secrets.VPS_HOST }}
          envs: IMAGE_TAG,GH_ACTOR,GHCR_TOKEN,CRM_CSP_MODE
          script: bash /opt/crm/scripts/devops/deploy-stack-on-vps.sh
YML

# Precision: a small ssh-action step FOLLOWED by a different action carrying a big
# `script:`. The second step's payload must not be attributed to the first.
read -r -d '' NEIGHBOUR_YML <<'YML' || true
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
      - name: Some other action that also happens to take a script
        uses: not-appleboy/other-action@v3
        with:
          script: |
            # a very long body that belongs to a DIFFERENT action and is therefore
            # irrelevant to MAX_ARG_STRLEN on INPUT_SCRIPT
            echo "padding padding padding padding padding padding padding padding"
            echo "padding padding padding padding padding padding padding padding"
YML

# An explicit block indentation indicator would silently break the dedent-based
# measurement. The guard must refuse rather than under-measure.
read -r -d '' INDICATOR_YML <<'YML' || true
name: Deploy
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Restart containers
        uses: appleboy/ssh-action@v1.2.0
        with:
          script: |2
            echo aaa
YML

echo "== test-check-ssh-action-script-size.sh =="
echo

# ── positive ───────────────────────────────────────────────────────────────────
assert_green "a small inline script passes" \
  --contains "Violations found:              0" \
  -- run_guard "$(make_case small "$SMALL_YML")"

# Exact arithmetic: three 8-byte lines, each newline-terminated = 27 bytes.
assert_green "the reported byte count is exact (3 x \"echo aaa\\n\" = 27 bytes)" \
  --contains "27B /     3 lines" \
  -- run_guard "$(make_case exact-bytes "$SMALL_YML")"

# ── script_path is MEASURED, not exempt ────────────────────────────────────────
# The first version of this guard treated script_path: as out of scope, because
# it looked like an escape from INPUT_SCRIPT. It is not: drone-ssh os.ReadFiles
# the file into the same command string it sends to ssh.Stream, so the body still
# crosses as one SSH exec argument and the REMOTE /bin/bash refuses it. The deploy
# of 3928ba00e failed that way while this guard printed "Violations found: 0".
# These two cases are the ones that would have caught it.
assert_red "a big file behind script_path: -> red (it still ships as a command string)" \
  --contains "via script_path:" \
  --contains "over budget by" \
  -- run_guard "$(make_path_case sp-big "$SCRIPT_PATH_YML" 120000)"

assert_green "a small file behind script_path: -> green, and measured (not skipped)" \
  --contains "ssh-action command payloads:   1" \
  --contains "(script_path:)" \
  -- run_guard "$(make_path_case sp-small "$SCRIPT_PATH_YML" 500)"

assert_red "script_path: pointing at a missing file -> red, not silently unmeasured" \
  --contains "does not exist" \
  -- run_guard "$(make_path_case sp-missing "$SCRIPT_PATH_YML" absent)"

# The shape that actually works: the body travels by scp, the command is a path.
assert_green "a short dispatch to a file already on the VPS is the escape hatch -> green" \
  --contains "Violations found:              0" \
  -- run_guard "$(make_case dispatch "$DISPATCH_YML")"

assert_green "a big script: on a NON-ssh-action step is out of scope" \
  --contains "Violations found:              0" \
  -- run_guard "$(make_case neighbour "$NEIGHBOUR_YML")"

assert_green "a big script: on a non-ssh-action step is not charged to an earlier ssh-action step" \
  --contains "Violations found:              0" \
  -- run_guard "$(make_big_case big-other-action 'not-appleboy/other-action@v3' '' 2600)"

# ── negative ───────────────────────────────────────────────────────────────────
assert_red "the incident: an inline script past the budget -> red" \
  --contains "over budget by" \
  --contains "Argument list too long" \
  --contains "script_path" \
  -- run_guard "$(make_big_case oversized 'appleboy/ssh-action@v1.2.0' '' 2600)"

assert_red "CHEAT: a comment claims the script moved to script_path, the block is still inline -> red" \
  --contains "over budget by" \
  -- run_guard "$(make_big_case comment-claims-moved 'appleboy/ssh-action@v1.2.0' \
    '          # Moved to script_path (scripts/devops/deploy-stack-on-vps.sh) so this
          # step is no longer bounded by MAX_ARG_STRLEN. Verified under 100000 bytes.' 2600)"

assert_red "a block indentation indicator the dedent cannot honour -> red, not under-measured" \
  --contains "indentation indicator" \
  -- run_guard "$(make_case indicator "$INDICATOR_YML")"

guard_test_summary "test-check-ssh-action-script-size.sh"
