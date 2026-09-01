#!/usr/bin/env bash
# test-pre-bash-coder-push-gate.sh — proves the pre-push hook
# .claude/hooks/pre-bash-coder-push-gate.sh actually refuses a push whose last
# commit does not say what was verified, BY EXECUTION against fake git repos.
#
# WHY THIS FILE DID NOT EXIST UNTIL 2026-09-01. The meta-guard
# scripts/devops/check-guard-tests-exist.sh takes its inventory from
# `scripts/devops/check-*` — a naming convention in ONE directory. Every gate
# under .claude/hooks/ is named `pre-bash-*` / `pre-edit-write-*` and lives
# somewhere else, so no hook has ever been inside the meta-guard's field of
# view. Four hooks had tests anyway, by their authors' initiative — see the
# header of test-pre-bash-mutation-gate.sh, which says so out loud ("the hook
# is not itself a `check-*` script, so … does not require this file to exist —
# it is added anyway"). Three did not, and this was one of them. The meta-guard
# learns about hooks in the same change that adds this file.
#
# WHAT THE MISSING TEST COST. The gate matched `^(feature|fix|infra|test)/` and
# `feat/` was not on the list. Fifteen merged PRs shipped on `feat/` with the
# gate silent, and so did merged code on `docs/`, `ci/` and `perf/`. Nothing
# went red, because "did nothing" is exactly what this gate looks like when it
# works. A test is the only thing that can tell those two apart.
#
# CONTRACT ASSERTED, not just the exit code: a refusal must carry
# {"decision": "block"} on stdout. A bash syntax error also exits 2 — the
# cross-agent hooks shipped a draft that died at parse time and "passed" all
# eight of its block cases while doing nothing (see
# .claude/hooks/tests/cross-agent-hooks-smoke.sh, gate 0). Exit code alone
# proves nothing here.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

HOOK="$REPO_ROOT/.claude/hooks/pre-bash-coder-push-gate.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

echo "== test-pre-bash-coder-push-gate.sh =="
echo

# ── gate 0: syntax, before anything else ───────────────────────────────────────
# Same reasoning as the cross-agent smoke: a hook that cannot parse exits 2,
# which is indistinguishable from a refusal by code alone.
if ! bash -n "$HOOK" 2>/dev/null; then
  echo "FATAL: syntax error in $HOOK"
  bash -n "$HOOK"
  exit 1
fi

# ── fixtures ───────────────────────────────────────────────────────────────────
# $1 = dir name, $2 = branch, $3 = last commit message.
# Builds a repo whose HEAD commit message is exactly $3, on branch $2.
make_repo() {
  local root="$WS/$1" branch="$2" msg="$3"
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
    if [ "$branch" != "main" ]; then
      git checkout -q -b "$branch"
    fi
    echo work >>README.md
    git add README.md
    git commit -q -m "$msg"
  ) >/dev/null 2>&1
  printf '%s' "$root"
}

# A repo whose HEAD is a real merge commit (two parents) with a message that
# says nothing about AC — the documented allow that must keep working.
make_merge_repo() {
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
    git commit -q -m init
    git checkout -q -b side
    echo side >side.txt
    git add side.txt
    git commit -q -m "side work"
    git checkout -q -b feat/merge-target main
    echo trunk >trunk.txt
    git add trunk.txt
    git commit -q -m "trunk work"
    git merge -q --no-ff side -m "Merge branch 'side' into feat/merge-target"
  ) >/dev/null 2>&1
  printf '%s' "$root"
}

# A repo checked out to a detached HEAD — `git branch --show-current` is empty.
make_detached_repo() {
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
    git commit -q -m "no marker here"
    git checkout -q --detach HEAD
  ) >/dev/null 2>&1
  printf '%s' "$root"
}

# Feeds the hook the PreToolUse:Bash stdin shape from inside $1.
# `cd` is scoped to this function's subshell (assert_* captures via `$(...)`).
run_hook() {
  local root="$1" cmd="${2:-git push -u origin HEAD}"
  local json
  json=$(python3 -c 'import json,sys; print(json.dumps({"tool_name":"Bash","tool_input":{"command":sys.argv[1]}}))' "$cmd")
  (cd "$root" && printf '%s' "$json" | bash "$HOOK")
}

NO_MARKER="feat: work with nothing said about what was verified"

# ── fast no-ops ────────────────────────────────────────────────────────────────
NOOP="$(make_repo noop feat/noop "$NO_MARKER")"

assert_green "a non-'git push' command is a silent no-op" \
  --not-contains "pre:bash:coder-push-gate" \
  -- run_hook "$NOOP" "ls -la"

assert_green "text that merely mentions pushing is a no-op" \
  --not-contains "pre:bash:coder-push-gate" \
  -- run_hook "$NOOP" "echo git pushes are gated"

assert_green "'git push --help' is a no-op" \
  --not-contains "pre:bash:coder-push-gate" \
  -- run_hook "$NOOP" "git push --help"

NOT_A_REPO="$WS/not-a-repo"
mkdir -p "$NOT_A_REPO"
assert_green "outside a git work tree the gate does not fire" \
  --not-contains "pre:bash:coder-push-gate" \
  -- run_hook "$NOT_A_REPO"

# ── THE CORE: every gated prefix must BLOCK without the marker ─────────────────
# One case per prefix that carries code in this repo's history. `feat/` is the
# one that was silently ungated until 2026-09-01 (15 merged PRs); `docs/`,
# `ci/` and `perf/` are the ones that turned out to carry apps/ code too
# (#613 / #469, #433, #474).

assert_red "feature/ without the marker -> BLOCK" \
  --contains '"decision": "block"' \
  --contains "feature/legacy-prefix" \
  -- run_hook "$(make_repo b-feature feature/legacy-prefix "$NO_MARKER")"

assert_red "fix/ without the marker -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$(make_repo b-fix fix/legacy-prefix "$NO_MARKER")"

assert_red "infra/ without the marker -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$(make_repo b-infra infra/legacy-prefix "$NO_MARKER")"

assert_red "test/ without the marker -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$(make_repo b-test test/legacy-prefix "$NO_MARKER")"

assert_red "THE FINDING: feat/ without the marker -> BLOCK (was silent; 15 merged PRs)" \
  --contains '"decision": "block"' \
  --contains "feat/notifications-spec" \
  -- run_hook "$(make_repo b-feat feat/notifications-spec "$NO_MARKER")"

assert_red "docs/ without the marker -> BLOCK (#613 shipped 24 apps/ files on a docs/ branch)" \
  --contains '"decision": "block"' \
  -- run_hook "$(make_repo b-docs docs/backlog-cascade-session "$NO_MARKER")"

assert_red "chore/ without the marker -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$(make_repo b-chore chore/tasks-hygiene "$NO_MARKER")"

assert_red "perf/ without the marker -> BLOCK (#474 carried an apps/ file)" \
  --contains '"decision": "block"' \
  -- run_hook "$(make_repo b-perf perf/split-vendor-misc "$NO_MARKER")"

assert_red "ci/ without the marker -> BLOCK (#433 carried 8 apps/ files)" \
  --contains '"decision": "block"' \
  -- run_hook "$(make_repo b-ci ci/landing-e2e-job "$NO_MARKER")"

assert_red "the harness's own worktree-agent-<hash> branch -> BLOCK (merged once as a PR head)" \
  --contains '"decision": "block"' \
  -- run_hook "$(make_repo b-wt worktree-agent-af418f7487e736dfb "$NO_MARKER")"

assert_red "a bare branch name with no prefix at all -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$(make_repo b-bare guards-r3-a8624486 "$NO_MARKER")"

# Exemptions are anchored, not substring matches: a branch that merely STARTS
# with the letters of an exempt name is still gated.
assert_red "'architecture/...' is not 'architect/...' -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$(make_repo b-architecture architecture/notes "$NO_MARKER")"

assert_red "'main-cleanup' is not 'main' -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$(make_repo b-mainish main-cleanup "$NO_MARKER")"

# The marker is a LINE, not a mention. A commit that merely talks about the
# marker has not made the statement.
assert_red "'ac_verified:' mentioned mid-sentence is not the marker -> BLOCK" \
  --contains '"decision": "block"' \
  -- run_hook "$(make_repo b-prose feat/prose "не забудь потом ac_verified: 1,2")"

# ── the marker, and the documented escapes, must PASS ─────────────────────────

assert_green "feat/ WITH the marker -> pass" \
  --not-contains "BLOCK" \
  -- run_hook "$(make_repo p-feat feat/notifications-spec "feat(web): notifications list

ac_verified: 1,2,3")"

assert_green "feature/ WITH the marker -> pass (legacy prefix still works)" \
  --not-contains "BLOCK" \
  -- run_hook "$(make_repo p-feature feature/legacy "feat: x

ac_verified: 1")"

assert_green "'ac_verified: n/a (<why>)' is a statement and passes" \
  --not-contains "BLOCK" \
  -- run_hook "$(make_repo p-na assets/pr-515-shots "chore: screenshots

ac_verified: n/a (screenshots only, no AC)")"

assert_green "a 'wip:' subject passes (milestone chunking, coder.md §7)" \
  --not-contains "BLOCK" \
  -- run_hook "$(make_repo p-wip feat/chunked "wip: halfway through the form")"

assert_green "a 'wip(scope):' subject passes" \
  --not-contains "BLOCK" \
  -- run_hook "$(make_repo p-wip-scope feat/chunked "wip(web): halfway")"

assert_green "a merge commit passes without the marker" \
  --not-contains "BLOCK" \
  -- run_hook "$(make_merge_repo p-merge)"

assert_green "detached HEAD: no branch to classify -> pass" \
  --not-contains "BLOCK" \
  -- run_hook "$(make_detached_repo p-detached)"

# ── the exemptions, asserted as exemptions ────────────────────────────────────
# These pass WITHOUT the marker on purpose. Each is a hole with a written cost
# in the hook's header; the cases exist so that removing an exemption is a
# visible test change rather than a quiet behaviour change.

assert_green "main is exempt (trunk, never an agent work branch)" \
  --not-contains "BLOCK" \
  -- run_hook "$(make_repo x-main main "$NO_MARKER")"

assert_green "architect/ is exempt (ADR deliverable, no task-file AC list)" \
  --not-contains "BLOCK" \
  -- run_hook "$(make_repo x-architect architect/paid-edit-cascade "$NO_MARKER")"

assert_green "legal/ is exempt (same clause, same origin)" \
  --not-contains "BLOCK" \
  -- run_hook "$(make_repo x-legal legal/contract-draft "$NO_MARKER")"

guard_test_summary "test-pre-bash-coder-push-gate.sh"
