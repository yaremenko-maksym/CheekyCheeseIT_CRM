#!/usr/bin/env bash
# test-check-e2e-shard-coverage.sh — proves scripts/devops/check-e2e-shard-coverage.py
# goes RED when an E2E spec is not actually gated by a CI shard.
#
# The negative cases are the two ways a spec can LOOK covered without being run:
# named in a ci.yml comment, and named under some other key than the shard
# matrix's `files:`. Both are what "make the guard green without doing the work"
# looks like in this file — the shard matrix is a long YAML list and a spec name
# sitting anywhere near it reads as covered to a human skimming the diff.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="check-e2e-shard-coverage.py"
SPEC="fixture-guard-teeth.spec.ts"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# $1 = case name, $2 = ci.yml content, $3.. = spec paths relative to apps/e2e/
make_case() {
  local name="$1" ci_yml="$2"
  shift 2
  local root="$WS/$name"
  guard_test_fake_repo "$root" "$GUARD"
  local spec
  for spec in "$@"; do
    mkdir -p "$root/apps/e2e/$(dirname "$spec")"
    printf "import { test } from '@playwright/test'\n" >"$root/apps/e2e/$spec"
  done
  printf '%s' "$ci_yml" >"$root/.github/workflows/ci.yml"
  printf '%s' "$root"
}

run_guard() { python3 "$1/scripts/devops/$GUARD"; }

read -r -d '' SHARDED_YML <<YML || true
name: CI
on: [push]
jobs:
  e2e:
    strategy:
      matrix:
        shard:
          - name: misc
            files: tests/crm tests/$SPEC
YML

read -r -d '' DIR_PREFIX_YML <<YML || true
name: CI
on: [push]
jobs:
  e2e:
    strategy:
      matrix:
        shard:
          - name: crm
            files: tests/crm
YML

read -r -d '' NO_MENTION_YML <<YML || true
name: CI
on: [push]
jobs:
  e2e:
    strategy:
      matrix:
        shard:
          - name: misc
            files: tests/some-other.spec.ts
YML

# Cheat #1: the spec is named in a comment right above the shard list.
read -r -d '' COMMENT_ONLY_YML <<YML || true
name: CI
on: [push]
jobs:
  e2e:
    strategy:
      matrix:
        shard:
          # tests/$SPEC runs as part of the misc shard below
          - name: misc
            files: tests/some-other.spec.ts
YML

# Cheat #2: the spec is named in ci.yml, but under a key that has nothing to do
# with which specs a shard executes (a path filter / a step name).
read -r -d '' FOREIGN_KEY_YML <<YML || true
name: CI
on: [push]
jobs:
  changes:
    steps:
      - uses: dorny/paths-filter@v3
        with:
          filters: |
            e2e:
              - 'apps/e2e/tests/$SPEC'
  e2e:
    strategy:
      matrix:
        shard:
          - name: misc
            files: tests/some-other.spec.ts
    steps:
      - name: Run tests/$SPEC and friends
        run: pnpm --filter @crm/e2e test
YML

# Reverse-direction check (task-infra-ci-docs-filter-and-dead-shard, 2026-09):
# a shard's files: line names an exact spec that is NOT on disk — same shape
# as tests/rbac-junior-on-other.spec.ts, deleted by commit d0735fe2 (#162)
# while its `team-users` entry lived on. Only "tests/real.spec.ts" is created
# on disk by the test cases below; "tests/$SPEC" is the ghost.
read -r -d '' GHOST_SHARD_YML <<YML || true
name: CI
on: [push]
jobs:
  e2e:
    strategy:
      matrix:
        shard:
          - name: misc
            files: tests/real.spec.ts tests/$SPEC
YML

# A directory-prefix token (not a *.spec.ts file) that matches zero files on
# disk. Must NOT be treated as a ghost: resolve_sharded_specs() only ever adds
# specs that already exist in all_specs for a prefix token, so an empty prefix
# is a silent no-op, not a dangling reference — the existence check only
# applies to exact *.spec.ts tokens.
read -r -d '' EMPTY_DIR_PREFIX_YML <<YML || true
name: CI
on: [push]
jobs:
  e2e:
    strategy:
      matrix:
        shard:
          - name: crm
            files: tests/nonexistent-subdir
YML

echo "== test-check-e2e-shard-coverage.sh =="
echo

# ── positive ───────────────────────────────────────────────────────────────────
assert_green "spec listed in a shard's files: is covered" \
  --contains "OK: All spec files" \
  -- run_guard "$(make_case sharded "$SHARDED_YML" "tests/$SPEC")"

assert_green "spec covered by a directory-prefix shard token (tests/crm)" \
  --contains "OK: All spec files" \
  -- run_guard "$(make_case dir-prefix "$DIR_PREFIX_YML" "tests/crm/$SPEC")"

assert_green "a KNOWN_UNSHARDED spec stays green with no ci.yml mention" \
  --contains "OK: All spec files" \
  -- run_guard "$(make_case allowlisted "$NO_MENTION_YML" "tests/legend.spec.ts" "tests/some-other.spec.ts")"

# ── negative ───────────────────────────────────────────────────────────────────
assert_red "spec in no shard and no debt list -> red" \
  --contains "NOT in any CI shard" \
  --contains "$SPEC" \
  -- run_guard "$(make_case unsharded "$NO_MENTION_YML" "tests/$SPEC")"

assert_red "CHEAT: spec named only in a ci.yml comment -> red" \
  --contains "NOT in any CI shard" \
  -- run_guard "$(make_case comment-only "$COMMENT_ONLY_YML" "tests/$SPEC")"

assert_red "CHEAT: spec named under a foreign key (paths-filter / step name) -> red" \
  --contains "NOT in any CI shard" \
  -- run_guard "$(make_case foreign-key "$FOREIGN_KEY_YML" "tests/$SPEC")"

# ── reverse-direction: shard files: entry pointing at nothing ───────────────────
assert_red "shard files: names a spec that does not exist on disk -> red (reverse-direction check)" \
  --contains "GHOST shard entries" \
  --contains "does not exist on disk" \
  --contains "$SPEC" \
  -- run_guard "$(make_case ghost-shard "$GHOST_SHARD_YML" "tests/real.spec.ts")"

assert_green "directory-prefix token matching zero files is not treated as a ghost" \
  --contains "OK: All spec files" \
  -- run_guard "$(make_case empty-dir-prefix "$EMPTY_DIR_PREFIX_YML" "tests/legend.spec.ts")"

# PENDING_SHARD_FILES escape hatch: a shard files: entry naming a not-yet-
# created spec stays green ONLY if explicitly acknowledged — same idiom as
# KNOWN_UNSHARDED, not a silent pass. Patches the COPIED guard (never the real
# one under scripts/devops/) so this stays a fixture-only mutation.
PENDING_ROOT="$(make_case pending "$GHOST_SHARD_YML" "tests/real.spec.ts")"
python3 - "$PENDING_ROOT/scripts/devops/$GUARD" "tests/$SPEC" <<'PY'
import sys

path, entry = sys.argv[1], sys.argv[2]
with open(path) as f:
    content = f.read()
needle = "PENDING_SHARD_FILES: set[str] = set()"
if needle not in content:
    raise SystemExit(
        "harness assumption broken: literal '{}' not found in {} "
        "(guard script changed shape — update this test)".format(needle, path)
    )
content = content.replace(needle, 'PENDING_SHARD_FILES: set[str] = {"' + entry + '"}')
with open(path, "w") as f:
    f.write(content)
PY

assert_green "shard files: names a not-yet-created spec that IS in PENDING_SHARD_FILES -> stays green (wired-ahead-of-merge escape hatch)" \
  --contains "OK: All spec files" \
  --contains "Pending shard files: 1" \
  -- run_guard "$PENDING_ROOT"

guard_test_summary "test-check-e2e-shard-coverage.sh"
