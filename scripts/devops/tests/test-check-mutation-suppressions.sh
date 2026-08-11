#!/usr/bin/env bash
# test-check-mutation-suppressions.sh — proves
# scripts/devops/check-mutation-suppressions.mjs goes RED for every way of
# switching a mutant off without saying why (task-mutation-gate, 2026-08-11).
#
# The guard takes a scan root as its one argument, so every case here is a
# throwaway directory holding one fabricated source file. The guard itself is
# the real, unmodified one CI runs.
#
# The sharpest negative is `placeholder-reason`: the suppression carries a reason
# that reads like a reason — `Ignored using a comment` — and is StrykerJS's OWN
# filler for "no reason was given" (@stryker-mutator/instrumenter,
# directive-bookkeeper.js `DEFAULT_REASON`). It is 22 alphanumerics long, so a
# "reason must be at least N characters" check passes it. That is not a
# hypothetical: the mutation gate's first report-side check had exactly that
# shape and let a reasonless suppression through green, which is why both the
# gate and this guard now reject the string by value. A guard that can be
# satisfied by the tool's own placeholder is decorative.
#
# `file-scoped` is the second one that matters: `// Stryker disable all` with a
# perfectly good reason still switches mutation off for the entire rest of the
# file, including code nobody has written yet. It must be red even though its
# reason is impeccable.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/check-mutation-suppressions.mjs"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# $1 = case name, $2 = the suppression comment line (may be empty).
# Writes <ws>/<name>/src/thing.ts and echoes the root to scan.
new_case() {
  local name="$1" directive="$2"
  local root="$WS/$name"
  mkdir -p "$root/src"
  {
    printf 'export function pick(a: number, b: number): number {\n'
    [ -n "$directive" ] && printf '  %s\n' "$directive"
    printf '  return a > b ? a : b\n'
    printf '}\n'
  } >"$root/src/thing.ts"
  printf '%s' "$root"
}

CLEAN="$(new_case clean '')"
GOOD="$(new_case good '// Stryker disable next-line ConditionalExpression: both branches render identically, no assertion can tell them apart')"
RESTORE="$(new_case restore '// Stryker restore all')"
NO_REASON="$(new_case no-reason '// Stryker disable next-line ConditionalExpression')"
EMPTY_REASON="$(new_case empty-reason '// Stryker disable next-line ConditionalExpression:')"
PLACEHOLDER="$(new_case placeholder-reason '// Stryker disable next-line ConditionalExpression: Ignored using a comment')"
SHORT_REASON="$(new_case short-reason '// Stryker disable next-line ConditionalExpression: eq')"
FILE_SCOPED="$(new_case file-scoped '// Stryker disable all: this whole file is unusual and I would rather not explain it per line')"

echo "== test-check-mutation-suppressions.sh =="
echo

assert_green "no suppressions at all — nothing to complain about" \
  --contains "0 suppression(s)" \
  -- node "$GUARD" "$CLEAN"

assert_green "line-scoped suppression with a written reason is accepted" \
  --contains "1 suppression(s)" \
  --contains "states a reason" \
  -- node "$GUARD" "$GOOD"

assert_green "\`Stryker restore\` needs no reason — it turns mutation back ON" \
  -- node "$GUARD" "$RESTORE"

assert_red "suppression with NO reason" \
  --contains "suppression with no reason" \
  -- node "$GUARD" "$NO_REASON"

assert_red "suppression with a bare colon and nothing after it" \
  --contains "suppression with no reason" \
  -- node "$GUARD" "$EMPTY_REASON"

assert_red "reason is Stryker's own 'no reason given' placeholder (22 chars — passes any length check)" \
  --contains "placeholder" \
  -- node "$GUARD" "$PLACEHOLDER"

assert_red "reason too short to mean anything" \
  --contains "too short" \
  -- node "$GUARD" "$SHORT_REASON"

assert_red "file-scoped disable, however well argued, switches the gate off for everything below it" \
  --contains "file-scoped" \
  -- node "$GUARD" "$FILE_SCOPED"

guard_test_summary "test-check-mutation-suppressions.sh"
