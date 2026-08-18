#!/usr/bin/env bash
# test-check-db-push-guard-wiring.sh — proves
# scripts/devops/check-db-push-guard-wiring.py goes RED when apps/api/package.json's
# db:push/db:migrate drift away from "guard, then &&, then drizzle-kit push"
# (task-ci-db-rename-and-dbpush-guard MED-2, security review PR #579).
#
# Each red case reproduces one concrete way this could silently regress: the
# guard prefix deleted, '&&' downgraded to ';' (which does not stop drizzle-kit
# on a guard failure), the two steps reordered, or only one of the two scripts
# fixed while the other drifts. Green cases prove the check does not false-
# positive on a correct wiring, an equivalent invocation form, or extra '&&'
# steps, and that db:studio is genuinely out of scope.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="check-db-push-guard-wiring.py"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# $1 = case name, $2 = package.json content (already valid JSON text)
make_case() {
  local name="$1" pkg_json="$2"
  local root="$WS/$name"
  guard_test_fake_repo "$root" "$GUARD"
  mkdir -p "$root/apps/api"
  printf '%s' "$pkg_json" >"$root/apps/api/package.json"
  printf '%s' "$root"
}

run_guard() { python3 "$1/scripts/devops/$GUARD"; }

CORRECT_JSON='{
  "scripts": {
    "db:migrate": "tsx src/database/seed-db-guard.ts && drizzle-kit push",
    "db:push": "tsx src/database/seed-db-guard.ts && drizzle-kit push",
    "db:studio": "drizzle-kit studio"
  }
}'

MISSING_GUARD_JSON='{
  "scripts": {
    "db:migrate": "drizzle-kit push",
    "db:push": "drizzle-kit push",
    "db:studio": "drizzle-kit studio"
  }
}'

SEMICOLON_JSON='{
  "scripts": {
    "db:migrate": "tsx src/database/seed-db-guard.ts && drizzle-kit push",
    "db:push": "tsx src/database/seed-db-guard.ts; drizzle-kit push",
    "db:studio": "drizzle-kit studio"
  }
}'

REORDERED_JSON='{
  "scripts": {
    "db:migrate": "tsx src/database/seed-db-guard.ts && drizzle-kit push",
    "db:push": "drizzle-kit push && tsx src/database/seed-db-guard.ts",
    "db:studio": "drizzle-kit studio"
  }
}'

ASYMMETRIC_JSON='{
  "scripts": {
    "db:migrate": "drizzle-kit push",
    "db:push": "tsx src/database/seed-db-guard.ts && drizzle-kit push",
    "db:studio": "drizzle-kit studio"
  }
}'

MISSING_SCRIPT_KEY_JSON='{
  "scripts": {
    "db:push": "tsx src/database/seed-db-guard.ts && drizzle-kit push",
    "db:studio": "drizzle-kit studio"
  }
}'

PNPM_EXEC_JSON='{
  "scripts": {
    "db:migrate": "pnpm exec tsx src/database/seed-db-guard.ts && drizzle-kit push",
    "db:push": "pnpm exec tsx src/database/seed-db-guard.ts && drizzle-kit push",
    "db:studio": "drizzle-kit studio"
  }
}'

EXTRA_STEPS_JSON='{
  "scripts": {
    "db:migrate": "echo start && tsx src/database/seed-db-guard.ts && drizzle-kit push && echo done",
    "db:push": "tsx src/database/seed-db-guard.ts && drizzle-kit push",
    "db:studio": "drizzle-kit studio"
  }
}'

STUDIO_UNGUARDED_JSON='{
  "scripts": {
    "db:migrate": "tsx src/database/seed-db-guard.ts && drizzle-kit push",
    "db:push": "tsx src/database/seed-db-guard.ts && drizzle-kit push",
    "db:studio": "drizzle-kit studio --port 4983"
  }
}'

echo "== test-check-db-push-guard-wiring.sh =="
echo

assert_red "guard prefix deleted entirely from both scripts -> blocked" \
  --contains "no guard step at all" \
  -- run_guard "$(make_case missing-guard "$MISSING_GUARD_JSON")"

assert_red "'&&' downgraded to ';' on db:push -> blocked (';' does not stop drizzle-kit on failure)" \
  --contains "joins its steps with ';'" \
  -- run_guard "$(make_case semicolon "$SEMICOLON_JSON")"

assert_red "guard and drizzle-kit reordered on db:push -> blocked" \
  --contains "invokes the guard AFTER" \
  -- run_guard "$(make_case reordered "$REORDERED_JSON")"

assert_red "db:migrate drifts unguarded while db:push stays correct -> blocked (asymmetric drift caught)" \
  --contains "'db:migrate' is a single command with no guard step at all" \
  -- run_guard "$(make_case asymmetric "$ASYMMETRIC_JSON")"

assert_red "db:migrate key missing from scripts entirely -> blocked" \
  --contains "'db:migrate' is missing from apps/api/package.json scripts entirely" \
  -- run_guard "$(make_case missing-key "$MISSING_SCRIPT_KEY_JSON")"

assert_green "correct wiring (guard && drizzle-kit push) on both scripts -> allowed" \
  --contains "OK: db:push and db:migrate both invoke the guard" \
  -- run_guard "$(make_case correct "$CORRECT_JSON")"

assert_green "equivalent invocation form (pnpm exec tsx ...) -> allowed" \
  --contains "OK: db:push and db:migrate both invoke the guard" \
  -- run_guard "$(make_case pnpm-exec "$PNPM_EXEC_JSON")"

assert_green "extra '&&' steps around the mandatory two -> allowed" \
  --contains "OK: db:push and db:migrate both invoke the guard" \
  -- run_guard "$(make_case extra-steps "$EXTRA_STEPS_JSON")"

assert_green "db:studio unguarded -> still allowed (out of scope by design)" \
  --contains "OK: db:push and db:migrate both invoke the guard" \
  -- run_guard "$(make_case studio-unguarded "$STUDIO_UNGUARDED_JSON")"

guard_test_summary "test-check-db-push-guard-wiring.sh"
