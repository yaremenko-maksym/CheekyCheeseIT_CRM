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

blank_canary_table() {
  local g="$1/scripts/devops/$GUARD"
  python3 - "$g" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace("\nCANARY_FILES = {\n", "\nCANARY_FILES = {}\n_UNUSED_CANARY_TABLE = {\n", 1)
open(p, "w").write(s)
PY
  grep -q '^CANARY_FILES = {}$' "$g" || { echo "FATAL: could not blank CANARY_FILES in the guard copy"; exit 2; }
}

# $1 = case name, $2 = workflow content, $3 = optional exempt entry injected into the
# COPY of the guard's (empty) PINNING_EXEMPT table, so the exemption path can be run.
make_case() {
  local name="$1" workflow="$2" exempt="${3:-}" action="${4:-}"
  local root="$WS/$name"
  guard_test_fake_repo "$root" "$GUARD"
  printf '%s' "$workflow" >"$root/.github/workflows/deploy.yml"
  # Blank the canary table in the COPY by default, so existing cases are unaffected by the real
  # canary entry (its file does not exist in a fake repo -> a dangling-entry violation otherwise).
  # `CANARY_FILES = {` sits alone on its line; the remainder becomes an unused dict.
  blank_canary_table "$root"
  if [ -n "$action" ]; then
    mkdir -p "$root/.github/actions/deploy-helper"
    printf '%s' "$action" >"$root/.github/actions/deploy-helper/action.yml"
  fi
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

# ── SR-M-3: weakenings of the literal check / of the with:-vs-env: scoping ─────────
# Each fingerprint below is NOT a valid literal. They exist to kill three mutants of the guard:
#   (a) the {43} length in the literal regex loosened      -> too-short / too-long cases
#   (b) the regex replaced by startswith("SHA256:")        -> the "SHA256:" + expression case
#   (c) children of env: counted as children of with:      -> the env:-only fingerprint cases
step_with_fp() { # <fingerprint text>
  printf '%s      - name: a\n        uses: appleboy/ssh-action@v1.2.0\n        with:\n          host: ${{ secrets.VPS_HOST }}\n          fingerprint: %s\n          script: ls\n' "$HEAD" "$1"
}
SHORT_FP_YML="$(step_with_fp 'SHA256:aUhFBjtfQIpwUlMUA9Z5oKWXn8cIEdedrqt2eHNnGz')"        # 42 chars
LONG_FP_YML="$(step_with_fp 'SHA256:aUhFBjtfQIpwUlMUA9Z5oKWXn8cIEdedrqt2eHNnGzoo')"       # 44 chars
BAD_CHARS_FP_YML="$(step_with_fp 'SHA256:aUhFBjtfQIpwUlMUA9Z5oKWXn8cIEdedrqt2eHNn!zo')"   # 43 chars, one illegal
PREFIX_ONLY_FP_YML="$(step_with_fp 'SHA256:${{ vars.VPS_HOST_FINGERPRINT }}')"
BARE_PREFIX_FP_YML="$(step_with_fp 'SHA256:')"
# fingerprint only under env: (before and after with:) — NOT an action input.
ENV_BEFORE_WITH_YML="${HEAD}      - name: a
        uses: appleboy/ssh-action@v1.2.0
        env:
          fingerprint: $FP
        with:
          host: \${{ secrets.VPS_HOST }}
          script: ls
"
ENV_AFTER_WITH_YML="${HEAD}      - name: a
        uses: appleboy/ssh-action@v1.2.0
        with:
          host: \${{ secrets.VPS_HOST }}
          script: ls
        env:
          fingerprint: $FP
"

# ── SR-M-1: forms of discovery that must FAIL CLOSED, never be dropped ─────────────
MATRIX_VERSION_YML="${HEAD}      - name: a
        uses: appleboy/ssh-action@\${{ matrix.v }}
        with:
          fingerprint: $FP
          script: ls
"
UPPER_OWNER_UNPINNED_YML="${HEAD}      - name: a
        uses: Appleboy/ssh-action@v1.2.0
        with:
          host: \${{ secrets.VPS_HOST }}
          script: ls
"
UPPER_OWNER_PINNED_YML="${HEAD}      - name: a
        uses: APPLEBOY/SSH-ACTION@v1.2.0
        with:
          fingerprint: $FP
          script: ls
"
SUBPATH_YML="${HEAD}      - name: a
        uses: appleboy/ssh-action/sub@v1.2.0
        with:
          fingerprint: $FP
          script: ls
"
FLOW_STYLE_YML="${HEAD}      - {name: a, uses: 'appleboy/ssh-action@v1.2.0', with: {host: x, script: ls}}
"
NEXT_LINE_YML="${HEAD}      - name: a
        uses:
          appleboy/ssh-action@v1.2.0
        with:
          host: \${{ secrets.VPS_HOST }}
          script: ls
"
DOCKER_URI_YML="${HEAD}      - name: a
        uses: docker://appleboy/drone-ssh:1.8.1
        with:
          host: \${{ secrets.VPS_HOST }}
"
# A comment about appleboy is prose, not a step: it must not fail an otherwise clean repo.
COMMENT_ONLY_MENTION_YML="${HEAD}      # appleboy/ssh-action is pinned below (see deploy.yml)
      - name: a
        uses: appleboy/ssh-action@v1.2.0 # appleboy v1.2.0, the proven one
        with:
          fingerprint: $FP
          script: ls
"
NO_STEPS_YML="${HEAD}      - name: unrelated
        run: echo hello
"
ACTION_UNPINNED_YML="name: helper
runs:
  using: composite
  steps:
    - name: ssh in
      uses: appleboy/ssh-action@v1.2.0
      with:
        host: \${{ secrets.VPS_HOST }}
        script: ls
"
ACTION_PINNED_YML="name: helper
runs:
  using: composite
  steps:
    - name: ssh in
      uses: appleboy/ssh-action@v1.2.0
      with:
        fingerprint: $FP
        script: ls
"

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

# ── SR-M-3: literal-check and with:/env: weakenings ────────────────────────────────
assert_red "42-char fingerprint (one short) -> red [kills: {43} loosened]" \
  --contains "not a literal" \
  -- run_guard "$(make_case short-fp "$SHORT_FP_YML")"

assert_red "44-char fingerprint (one long) -> red [kills: {43} loosened]" \
  --contains "not a literal" \
  -- run_guard "$(make_case long-fp "$LONG_FP_YML")"

assert_red "43 chars but one illegal character -> red [kills: charset loosened]" \
  --contains "not a literal" \
  -- run_guard "$(make_case bad-chars-fp "$BAD_CHARS_FP_YML")"

assert_red "'SHA256:' + an expression -> red [kills: regex replaced by startswith('SHA256:')]" \
  --contains "not a literal" \
  -- run_guard "$(make_case prefix-only-fp "$PREFIX_ONLY_FP_YML")"

assert_red "bare 'SHA256:' -> red [kills: regex replaced by startswith('SHA256:')]" \
  --contains "not a literal" \
  -- run_guard "$(make_case bare-prefix-fp "$BARE_PREFIX_FP_YML")"

assert_red "fingerprint only under env: (listed BEFORE with:) -> red [kills: env children counted as with:]" \
  --contains "supports pinning but has no" \
  -- run_guard "$(make_case env-before-with "$ENV_BEFORE_WITH_YML")"

assert_red "fingerprint only under env: (listed AFTER with:) -> red [kills: env children counted as with:]" \
  --contains "supports pinning but has no" \
  -- run_guard "$(make_case env-after-with "$ENV_AFTER_WITH_YML")"

# ── SR-M-1: discovery fails closed ─────────────────────────────────────────────────
assert_red "version as an expression with spaces (\${{ matrix.v }}) is classified, not dropped -> red" \
  --contains "unclassified appleboy action/version" \
  -- run_guard "$(make_case matrix-version "$MATRIX_VERSION_YML")"

assert_red "'Appleboy/' owner case is parsed and held to the rule (unpinned) -> red" \
  --contains "supports pinning but has no" \
  -- run_guard "$(make_case upper-owner-unpinned "$UPPER_OWNER_UNPINNED_YML")"

assert_green "'APPLEBOY/SSH-ACTION' with the literal is normalised and counted as pinned" \
  --contains "Pinned (literal fingerprint): 1" --contains "Violations found:             0" \
  -- run_guard "$(make_case upper-owner-pinned "$UPPER_OWNER_PINNED_YML")"

assert_red "subpath after the repo name is parsed, not dropped -> red" \
  --contains "unclassified appleboy action/version" \
  -- run_guard "$(make_case subpath "$SUBPATH_YML")"

assert_red "flow-style step cannot be read -> red, not silently skipped" \
  --contains "not a \`uses: appleboy" --contains "Unreadable appleboy mentions: 1" \
  -- run_guard "$(make_case flow-style "$FLOW_STYLE_YML")"

assert_red "uses: with the value on the next line cannot be read -> red" \
  --contains "Unreadable appleboy mentions: 1" \
  -- run_guard "$(make_case next-line "$NEXT_LINE_YML")"

assert_red "docker://appleboy/... cannot be read -> red" \
  --contains "Unreadable appleboy mentions: 1" \
  -- run_guard "$(make_case docker-uri "$DOCKER_URI_YML")"

assert_green "precision: a COMMENT that mentions appleboy is prose, stays green" \
  --contains "Unreadable appleboy mentions: 0" --contains "Violations found:             0" \
  -- run_guard "$(make_case comment-only "$COMMENT_ONLY_MENTION_YML")"

assert_red "unpinned step inside .github/actions/** (composite action) is scanned -> red" \
  --contains "deploy-helper/action.yml" --contains "supports pinning but has no" \
  -- run_guard "$(make_case action-unpinned "$ALL_PINNED_YML" "" "$ACTION_UNPINNED_YML")"

assert_green "pinned step inside .github/actions/** is counted (3 workflow + 1 action = 4)" \
  --contains "Pinned (literal fingerprint): 4" --contains "Violations found:             0" \
  -- run_guard "$(make_case action-pinned "$ALL_PINNED_YML" "" "$ACTION_PINNED_YML")"

# ── SR-M-2: a scan that finds nothing is a failure ─────────────────────────────────
assert_red "zero appleboy steps found -> red (a broken scan must not read as a clean repo)" \
  --contains "found 0 appleboy steps" \
  -- run_guard "$(make_case no-steps "$NO_STEPS_YML")"

# ── Canary exemption: enumerated, exact, and not wider than its file ───────────────
# These cases keep the guard's REAL CANARY_FILES table (make_canary_case does not blank it) and
# use the REAL canary workflow as the fixture, mutated one way per case.
WRONG="SHA256:AuHfbJTFqiPWuLmua9z5OkwxN8CieDEDRQT2EhnNgZO"   # = CANARY_WRONG_LITERAL
CANARY_REL=".github/workflows/host-key-pin-canary.yml"
REAL_CANARY="$SELF_DIR/../../../$CANARY_REL"
[ -f "$REAL_CANARY" ] || { echo "FATAL: real canary workflow missing at $REAL_CANARY"; exit 2; }

# $1 = case name, $2 = deploy.yml content, $3 = canary file to install ("" = none)
make_canary_case() {
  local name="$1" deploy="$2" canary="${3:-}"
  local root="$WS/$name"
  guard_test_fake_repo "$root" "$GUARD"
  printf '%s' "$deploy" >"$root/.github/workflows/deploy.yml"
  if [ -n "$canary" ]; then cp "$canary" "$root/$CANARY_REL"; fi
  printf '%s' "$root"
}

# $1 = output path, $2 = mode: more | fewer | third | nofp
mutate_canary() {
  python3 - "$REAL_CANARY" "$1" "$2" "$FP" "$FP2" "$WRONG" <<'PY'
import sys
src, out, mode, fp, fp2, wrong = sys.argv[1:7]
lines = open(src).read().split("\n")
def first(pred):
    return next(i for i, l in enumerate(lines) if pred(l))
if mode == "more":      # one extra wrong step: turn the first correct pin into the wrong one
    i = first(lambda l: l.strip() == "fingerprint: " + fp); lines[i] = lines[i].replace(fp, wrong)
elif mode == "fewer":   # one wrong step fewer
    i = first(lambda l: l.strip() == "fingerprint: " + wrong); lines[i] = lines[i].replace(wrong, fp)
elif mode == "third":   # a third distinct literal next to the real and the wrong one
    i = first(lambda l: l.strip() == "fingerprint: " + fp); lines[i] = lines[i].replace(fp, fp2)
elif mode == "nofp":    # a canary step with no fingerprint at all
    i = first(lambda l: l.strip() == "fingerprint: " + wrong); del lines[i]
open(out, "w").write("\n".join(lines))
PY
}

for mode in more fewer third nofp; do mutate_canary "$WS/canary-$mode.yml" "$mode"; done

WRONG_IN_DEPLOY_YML="${HEAD}      - name: a
        uses: appleboy/ssh-action@v1.2.0
        with:
          fingerprint: $WRONG
          script: ls
"

assert_green "real canary file: exempt, exactly 3 wrong steps, listed in the output" \
  --contains "3 wrong step(s) declared, 3 found" --contains "Violations found:             0" \
  -- run_guard "$(make_canary_case canary-real "$ALL_PINNED_YML" "$REAL_CANARY")"

assert_red "wrong literal in deploy.yml (not the listed file) -> red, exemption does not widen" \
  --contains "outside a CANARY_FILES entry" \
  -- run_guard "$(make_canary_case wrong-in-deploy "$WRONG_IN_DEPLOY_YML" "$REAL_CANARY")"

assert_red "canary with ONE MORE wrong step than declared -> red" \
  --contains "declares exactly 3 step(s) with the wrong fingerprint but has 4" \
  -- run_guard "$(make_canary_case canary-more "$ALL_PINNED_YML" "$WS/canary-more.yml")"

assert_red "canary with ONE FEWER wrong step than declared -> red" \
  --contains "declares exactly 3 step(s) with the wrong fingerprint but has 2" \
  -- run_guard "$(make_canary_case canary-fewer "$ALL_PINNED_YML" "$WS/canary-fewer.yml")"

assert_red "a THIRD distinct literal inside the canary -> red (one real literal still required)" \
  --contains "disagree on the fingerprint" \
  -- run_guard "$(make_canary_case canary-third "$ALL_PINNED_YML" "$WS/canary-third.yml")"

assert_red "a canary step with no fingerprint -> red (the exemption is not a pin waiver)" \
  --contains "supports pinning but has no" \
  -- run_guard "$(make_canary_case canary-nofp "$ALL_PINNED_YML" "$WS/canary-nofp.yml")"

assert_red "table entry whose file is missing (dangling exemption) -> red" \
  --contains "does not exist" \
  -- run_guard "$(make_canary_case canary-dangling "$ALL_PINNED_YML" "")"

guard_test_summary "test-check-ssh-action-host-key-pinned.sh"
