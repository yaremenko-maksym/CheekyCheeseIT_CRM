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
PNPM_SHIM='args="$*"
echo "pnpm $args" >> "$FAKE_PNPM_LOG"
if [ -n "${FAKE_PNPM_FAIL_ON:-}" ]; then
  case "$args" in
    *"$FAKE_PNPM_FAIL_ON"*) exit 1 ;;
  esac
fi
exit 0'
guard_test_shim "$WS" pnpm "$PNPM_SHIM"

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
    git add README.md
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
    git add README.md
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
    PATH="$WS/bin:$PATH" FAKE_PNPM_LOG="$log" \
      FAKE_PNPM_FAIL_ON="${FAKE_PNPM_FAIL_ON:-}" PREPUSH_FULL="${PREPUSH_FULL:-}" \
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

guard_test_summary "test-husky-pre-push.sh"
