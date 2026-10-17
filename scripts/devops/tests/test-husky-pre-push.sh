#!/usr/bin/env bash
# test-husky-pre-push.sh — proves .husky/pre-push actually scopes / skips /
# forces-full / aborts-on-failure by EXECUTION against synthetic repos with a
# stubbed pnpm, not by reading the script and trusting the branches.
# (task-prepush-scope fix-round 2, CR-M-5, review 5113333031)
#
# WHY: this hook gates every `git push` in the repo (via husky's `sh -e`
# wrapper — see .husky/_/h) and had zero automated coverage before this file.
# Every verification of it, across two prior review rounds (PR #653, #657),
# was a human running `bash .husky/pre-push` by hand against the real
# 6600-test monorepo and pasting the output into a PR body. CR-M-3 (same
# review as this file) found exactly the gap that methodology hides: `bash
# .husky/pre-push` (no -e) can let a failing `pnpm typecheck` be silently
# outrun by the `&&`-chain after it and still exit 0, while the REAL
# production invocation (`sh -e`, from husky's own wrapper) would not — the
# reviewer could not reproduce a claimed "Exit status 1". This file replaces
# "someone ran it once against the real repo and it seemed to work" with a
# repeatable, offline case for every branch, including the one that matters
# most: a test failure must make the hook exit non-zero, and must stop the
# rest of the chain from running at all.
#
# FIXTURES: a real (tiny) git repo per case, with a fake `pnpm` on PATH that
# records every invocation to a log file and exits 0 unless the invocation's
# argv contains $FAKE_PNPM_FAIL_ON as a substring. No real pnpm/turbo/vitest
# ever runs — this tests the HOOK'S OWN branching and command construction,
# not turbo's package selection (that was verified empirically against the
# real monorepo in PR #653's body: --dry-run=json, the --filter="...[$base]"
# semantics, the @crm/e2e exclusion). Testing both here would be redundant;
# testing turbo's real filter semantics through a fake pnpm would be circular
# — a fake cannot prove what the real thing does.
#
# INVOCATION: every case below runs the hook via plain `bash "$HOOK"` — no
# `-e` flag, no husky wrapper. That is deliberately the WEAKER of the two real
# invocation paths (see CR-M-3 above): if the hook's own `set -e` makes THIS
# invocation correct, it is correct under husky's `sh -e` too, because that
# invocation only adds strictness this one already has to supply for itself.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

HOOK="$REPO_ROOT/.husky/pre-push"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

echo "== test-husky-pre-push.sh =="
echo

# ── gate 0: syntax, before anything else (same reasoning as every other hook
#    test here — a script that cannot parse exits non-zero for a reason that
#    has nothing to do with what this file is trying to prove) ─────────────
if ! bash -n "$HOOK" 2>/dev/null; then
  echo "FATAL: syntax error in $HOOK"
  bash -n "$HOOK"
  exit 1
fi

# ── fake pnpm ─────────────────────────────────────────────────────────────────
# Every pnpm invocation the hook makes — `pnpm typecheck`, `pnpm --filter X
# test`, `pnpm exec turbo run ...` — goes through this one binary, so faking
# `pnpm` alone is enough; `pnpm exec turbo` never reaches a real turbo.
#
# The shim also records which `node` it was launched under ("node-seen vX"): the
# hook now pins the runtime (ensure_node, 2026-10-17), and the only honest proof
# that it did is what a child process of the hook actually resolves.
PNPM_SHIM='args="$*"
echo "pnpm $args" >> "$FAKE_PNPM_LOG"
echo "node-seen $(node -v)" >> "$FAKE_PNPM_LOG"
if [ -n "${FAKE_PNPM_FAIL_ON:-}" ]; then
  case "$args" in
    *"$FAKE_PNPM_FAIL_ON"*) exit 1 ;;
  esac
fi
exit 0'
guard_test_shim "$WS" pnpm "$PNPM_SHIM"

# Fake `node`: prints $FAKE_NODE_VERSION (default: a version the hook accepts), so
# every case below is independent of whichever node the machine running this test
# happens to have -- the hook's runtime check must not make the existing cases
# depend on the host.
guard_test_shim "$WS" node 'echo "${FAKE_NODE_VERSION:-v22.23.1}"'

# An nvm-layout fixture: $1 = nvm root, remaining args = versions to install. Each
# install is a bin/node that reports its own version -- the hook probes them with
# `-v`, exactly as it would real installs.
make_nvm() {
  local root="$1" v
  shift
  for v in "$@"; do
    mkdir -p "$root/versions/node/$v/bin"
    printf '#!/bin/sh\necho %s\n' "$v" >"$root/versions/node/$v/bin/node"
    chmod +x "$root/versions/node/$v/bin/node"
  done
}

# ── fixtures ────────────────────────────────────────────────────────────────
# $1 = dir name, $2 = space-separated relative file paths to add on top of an
# initial commit that origin/main stays pinned to — this is what makes
# `git diff --name-only "$base"...HEAD` inside the hook see exactly $2.
make_repo() {
  local root="$WS/$1" files="$2"
  mkdir -p "$root"
  (
    cd "$root" || exit 1
    git init -q -b main
    git config user.email test@example.invalid
    git config user.name "guard test"
    git config commit.gpgsign false
    echo seed >README.md
    # The runtime contract the hook's ensure_node reads: .nvmrc major + the
    # package.json engines minimum. In the SEED commit (before origin/main is
    # pinned), so they never show up as part of any case's diff.
    echo 22 >.nvmrc
    printf '{\n  "engines": {\n    "node": ">=22.19 <23"\n  }\n}\n' >package.json
    git add README.md .nvmrc package.json
    git commit -q -m "init"
    git update-ref refs/remotes/origin/main HEAD
    local f
    for f in $files; do
      mkdir -p "$(dirname "$f")"
      echo "$f" >"$f"
      git add "$f"
    done
    if [ -n "$files" ]; then
      git commit -q -m "diff: $files"
    fi
  ) >/dev/null 2>&1
  printf '%s' "$root"
}

# Same as make_repo, but with NO refs/remotes/origin/main at all — the
# "could not resolve merge-base" fallback branch.
make_repo_no_origin() {
  local root="$WS/$1"
  mkdir -p "$root"
  (
    cd "$root" || exit 1
    git init -q -b main
    git config user.email test@example.invalid
    git config user.name "guard test"
    git config commit.gpgsign false
    echo seed >README.md
    echo 22 >.nvmrc
    printf '{\n  "engines": {\n    "node": ">=22.19 <23"\n  }\n}\n' >package.json
    git add README.md .nvmrc package.json
    git commit -q -m "init"
  ) >/dev/null 2>&1
  printf '%s' "$root"
}

# Runs the REAL hook against a fixture repo. Plain `bash "$HOOK"` (see file
# header — this is the invocation CR-M-3 needs to be correct on its own).
# Prints the hook's own stdout/stderr followed by the fake pnpm's call log, so
# a single assert_green/assert_red call can check both what the hook SAID and
# what it actually RAN. The function's own return value is the hook's exit
# code, not `cat`'s — that would silently launder every case to green.
run_hook() {
  local root="$1"
  local log="$root/pnpm.log"
  : >"$log"
  local rc
  (
    cd "$root" || exit 1
    # NVM_DIR points at an EMPTY fixture by default so the host's real
    # ~/.nvm can never rescue (or contaminate) a case; the node-pinning cases
    # below override FAKE_NVM_DIR with their own layout.
    PATH="$WS/bin:$PATH" FAKE_PNPM_LOG="$log" \
      FAKE_PNPM_FAIL_ON="${FAKE_PNPM_FAIL_ON:-}" PREPUSH_FULL="${PREPUSH_FULL:-}" \
      FAKE_NODE_VERSION="${FAKE_NODE_VERSION:-v22.23.1}" NVM_DIR="${FAKE_NVM_DIR:-$WS/no-nvm}" \
      bash "$HOOK"
  )
  rc=$?
  cat "$log"
  return "$rc"
}

# ── case 1: docs-only diff -> skip entirely, no pnpm call at all ───────────────
assert_green "docs-only diff -> skip (exit 0), no pnpm/turbo invocation at all" \
  --contains "no product code in diff" \
  --not-contains "pnpm " \
  -- run_hook "$(make_repo c1-docs "README.md docs/notes.md")"

# ── case 2: apps/api-only -> scoped turbo, both typecheck and test, e2e excluded
assert_green "apps/api-only diff -> scoped turbo run with --filter, e2e excluded from test" \
  --contains "turbo run typecheck --filter=" \
  --contains "turbo run test --filter=" \
  --contains "--filter=!@crm/e2e" \
  --not-contains "pnpm typecheck" \
  -- run_hook "$(make_repo c2-api "apps/api/src/foo.ts")"

# ── case 3: pnpm-lock.yaml-only -> CR-M-2's full-suite trigger, not scoped ─────
assert_green "pnpm-lock.yaml-only diff -> full suite (CR-M-2), turbo never invoked" \
  --contains "dependency/build-config file changed" \
  --contains "pnpm typecheck" \
  --contains "pnpm --filter @crm/shared test" \
  --contains "pnpm --filter @crm/landing test" \
  --not-contains "exec turbo run" \
  -- run_hook "$(make_repo c3-lock "pnpm-lock.yaml")"

# ── case 3b: a NESTED package.json (not root) still forces the full suite —
#    the CR-M-2 pattern is "(^|/)package.json$", not "^package.json$"; this is
#    the one detail in that regex most likely to regress silently ────────────
assert_green "apps/api/package.json (nested, not root) -> also forces full suite" \
  --contains "dependency/build-config file changed" \
  --not-contains "exec turbo run" \
  -- run_hook "$(make_repo c3b-nested-pkgjson "apps/api/package.json")"

# ── case 3c: pnpm-workspace.yaml -> also forces full suite (CR-M-4) ───────────
assert_green "pnpm-workspace.yaml-only diff -> full suite (CR-M-4)" \
  --contains "dependency/build-config file changed" \
  --not-contains "exec turbo run" \
  -- run_hook "$(make_repo c3c-workspace-yaml "pnpm-workspace.yaml")"

# ── case 4: apps/e2e-only -> matches product-code check (not skipped); the
#    test call's own command line still carries the e2e exclusion regardless
#    of what the diff touched, because that filter is unconditional in the
#    hook (turbo's OWN selection, verified for real in PR #653's body, is what
#    actually decides nothing runs for @crm/e2e's "test" task) ────────────────
assert_green "apps/e2e-only diff -> not skipped, test call still carries !@crm/e2e" \
  --not-contains "no product code in diff" \
  --contains "turbo run typecheck --filter=" \
  --contains "turbo run test --filter=" \
  --contains "--filter=!@crm/e2e" \
  -- run_hook "$(make_repo c4-e2e "apps/e2e/tests/foo.spec.ts")"

# ── case 5: PREPUSH_FULL=1 -> full suite regardless of diff, turbo never called
export PREPUSH_FULL=1
assert_green "PREPUSH_FULL=1 -> full unscoped suite regardless of diff" \
  --contains "PREPUSH_FULL=1" \
  --contains "pnpm typecheck" \
  --contains "pnpm --filter @crm/shared test" \
  --contains "pnpm --filter @crm/api test" \
  --contains "pnpm --filter @crm/web test" \
  --contains "pnpm --filter @crm/landing test" \
  --not-contains "exec turbo run" \
  -- run_hook "$(make_repo c5-full "apps/api/src/foo.ts")"
unset PREPUSH_FULL

# ── case 6: no origin/main ref -> merge-base unresolvable -> full-suite fallback
assert_green "no origin/main ref -> merge-base unresolvable, falls back to full suite" \
  --contains "could not resolve merge-base" \
  --contains "pnpm typecheck" \
  --contains "pnpm --filter @crm/landing test" \
  -- run_hook "$(make_repo_no_origin c6-noorigin)"

# ── case 7 (THE case CR-M-5 exists for): a test failure inside the scoped run
#    makes the hook exit non-zero, AND stops the rest of the chain ────────────
export FAKE_PNPM_FAIL_ON="@crm/api test"
assert_red "a failing test in a full-suite run makes the hook exit non-zero (CR-M-5)" \
  --contains "pnpm --filter @crm/api test" \
  --not-contains "@crm/web test" \
  --not-contains "@crm/landing test" \
  -- run_hook "$(make_repo c7-fail-mid "pnpm-lock.yaml")"
unset FAKE_PNPM_FAIL_ON

# ── case 8 (CR-M-3's exact regression): a failing `pnpm typecheck` must abort
#    BEFORE any `pnpm --filter ... test` call runs at all — this is the branch
#    that was silently wrong without an explicit `set -e`: without it, `bash
#    .husky/pre-push` would let `pnpm typecheck`'s failure be outrun by the
#    `&&`-chain right after it and still exit 0 if all four tests passed ──────
export PREPUSH_FULL=1
export FAKE_PNPM_FAIL_ON="typecheck"
assert_red "PREPUSH_FULL=1 + failing typecheck -> exits before ANY test call runs" \
  --not-contains "@crm/shared test" \
  --not-contains "@crm/api test" \
  --not-contains "@crm/web test" \
  --not-contains "@crm/landing test" \
  -- run_hook "$(make_repo c8-typecheck-fail "")"
unset PREPUSH_FULL FAKE_PNPM_FAIL_ON

# ── cases 9-14: the hook runs on the project's Node, or refuses (2026-10-17) ───
# Incident: the hook inherited the caller's `node` (Node 20 in the agent sandbox);
# @crm/shared + @crm/api uk-catalog specs fail on anything but Node 22 (see the
# ensure_node header in .husky/pre-push). Every red case below FAILS if ensure_node
# is reverted: the hook would then run pnpm under the wrong node and exit 0.

# case 9: wrong node, nothing to switch to, SCOPED path -> loud refusal, and the
# gate never starts (no pnpm call at all -- not even typecheck).
export FAKE_NODE_VERSION="v20.15.1"
assert_red "node v20 + no v22 install, scoped path -> refuses loudly, pnpm never runs" \
  --contains "REFUSING" \
  --contains "nvm use 22" \
  --not-contains "pnpm " \
  -- run_hook "$(make_repo c9-node20-scoped "apps/api/src/foo.ts")"

# case 9b: same, full-suite path (the OTHER call site of ensure_node).
assert_red "node v20 + no v22 install, full-suite path -> refuses loudly, pnpm never runs" \
  --contains "REFUSING" \
  --not-contains "pnpm typecheck" \
  -- run_hook "$(make_repo c9b-node20-full "pnpm-lock.yaml")"

# case 10: a docs-only push needs no node, so it must not be refused over one.
assert_green "node v20 + docs-only diff -> still skips cleanly (the check is lazy)" \
  --contains "no product code in diff" \
  --not-contains "REFUSING" \
  -- run_hook "$(make_repo c10-node20-docs "docs/notes.md")"

# case 11: wrong node on PATH, a right one in the nvm layout -> the hook switches,
# SAYS so, and the child process really runs under it. Picks the NEWEST satisfying
# install, skipping both the wrong major (v20) and the one below the engines
# minimum (v22.4.0 < 22.19).
NVM_OK="$WS/nvm-ok"
make_nvm "$NVM_OK" v20.15.1 v22.4.0 v22.19.0 v22.23.1
export FAKE_NVM_DIR="$NVM_OK"
assert_green "node v20 on PATH + v22 in nvm -> switches to the newest satisfying v22 and says so" \
  --contains "using $NVM_OK/versions/node/v22.23.1/bin" \
  --contains "node-seen v22.23.1" \
  --not-contains "node-seen v20" \
  --not-contains "REFUSING" \
  -- run_hook "$(make_repo c11-switch "apps/api/src/foo.ts")"

# case 12: the only v22 installs are below the engines minimum -> refuse, do not
# settle for "a v22".
NVM_OLD="$WS/nvm-old"
make_nvm "$NVM_OLD" v22.4.0 v22.18.9
export FAKE_NVM_DIR="$NVM_OLD"
assert_red "only v22 installs below the engines minimum (>=22.19) -> refuses" \
  --contains "REFUSING" \
  --not-contains "pnpm " \
  -- run_hook "$(make_repo c12-too-old "apps/api/src/foo.ts")"
unset FAKE_NVM_DIR

# case 13: engines is "<23" -- a NEWER major is as wrong as an older one.
export FAKE_NODE_VERSION="v24.13.0"
assert_red "node v24 (above engines <23), no v22 install -> refuses" \
  --contains "REFUSING" \
  --not-contains "pnpm " \
  -- run_hook "$(make_repo c13-node24 "apps/api/src/foo.ts")"

# case 14: a node that satisfies the contract is left completely alone.
export FAKE_NODE_VERSION="v22.19.0"
assert_green "node v22.19.0 (exactly the engines minimum) -> no switch, no refusal" \
  --not-contains "using " \
  --not-contains "REFUSING" \
  --contains "node-seen v22.19.0" \
  -- run_hook "$(make_repo c14-node-ok "apps/api/src/foo.ts")"
unset FAKE_NODE_VERSION

guard_test_summary "test-husky-pre-push.sh"
