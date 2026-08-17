#!/usr/bin/env bash
# test-run-landing-e2e-local-db-guard.sh — proves db_name_from_url() in
# scripts/devops/run-landing-e2e-local.sh (the ONLY check standing between
# that script's db:push + db:seed and the owner's live crm_db) blocks every
# real-world form of "this is crm_db" and passes every legitimate name.
#
# Why this test exists, not just a manual PR-comment verification (review
# round 4, PR #547): round 1 found a HIGH-severity hole in this exact
# function — it matched the literal substring "localhost:5432", and
# "127.0.0.1:5432/crm_db" (an entirely ordinary way to write "this machine")
# walked straight past it into a real db:push against a live database. Rounds
# 2 and 3 closed that hole (name-based matching) and two more (percent-
# encoding, a trailing space) the same way — each time proven by a one-off
# manual run, never pinned. A manual run proves the code is correct AT THAT
# MOMENT; it does not survive the next edit. Without a test, the next person
# to touch this function has no way to know these 14 forms were ever a
# concern, and a regression here silently reopens write access to crm_db —
# this is our own rule (an unenforced limitation lives until the first person
# who does not read the paragraph explaining it — the exact defect item 67 in
# this same PR chased down in check-prod-ddl-wiring.py) applied to our own
# code, not just the guards we found gaps in.
#
# The function is EXTRACTED from the real script below (sed, not hand-
# copied) — same reasoning as every check-*.py/.sh test in this directory:
# a copy drifts from the original silently and the test starts proving
# nothing about the code that actually runs.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

SCRIPT_UNDER_TEST="$GUARD_DIR/run-landing-e2e-local.sh"

FN_SRC="$(sed -n '/^db_name_from_url() {/,/^}/p' "$SCRIPT_UNDER_TEST")"
if [ -z "$FN_SRC" ]; then
  echo "test-run-landing-e2e-local-db-guard: could not extract db_name_from_url() from $SCRIPT_UNDER_TEST" >&2
  echo "— has the function been renamed or reshaped? This test's sed range (from the literal" >&2
  echo "'db_name_from_url() {' line to the next line starting with '}') needs updating to match." >&2
  exit 1
fi
eval "$FN_SRC"

# Mirrors the real call site in run-landing-e2e-local.sh verbatim, INCLUDING
# its exit code:
#   DB_NAME="$(db_name_from_url "$DATABASE_URL")"
#   if [ "$DB_NAME" = "crm_db" ] && [ "${ALLOW_DEFAULT_DB:-}" != "1" ]; then
#     ... exit 64
#   fi
# Prints the resolved name (so --contains can pin it in verbose output) and
# exits NON-ZERO when the real script would BLOCK this URL (assert_red — same
# "guard went red" convention every other test in this directory uses for a
# script's own exit code), 0 when it would ALLOW it (assert_green).
would_block() {
  local url="$1"
  local name
  name="$(db_name_from_url "$url")"
  echo "resolved db name: '$name'"
  if [ "$name" = "crm_db" ]; then
    return 64
  fi
  return 0
}

echo "== test-run-landing-e2e-local-db-guard.sh =="
echo

# ── dangerous forms — every one must resolve to crm_db and BLOCK ───────────────
assert_red "baseline: localhost:5432/crm_db (the literal .env.example default) -> blocked" \
  --contains "resolved db name: 'crm_db'" \
  -- would_block "postgresql://crm_user:password@localhost:5432/crm_db"

assert_red "round-1 HIGH-1 hole: 127.0.0.1:5432/crm_db -> blocked" \
  --contains "resolved db name: 'crm_db'" \
  -- would_block "postgresql://crm_user:password@127.0.0.1:5432/crm_db"

assert_red "::1:5432/crm_db (unbracketed IPv6 loopback) -> blocked" \
  --contains "resolved db name: 'crm_db'" \
  -- would_block "postgresql://crm_user:password@::1:5432/crm_db"

assert_red "[::1]:5432/crm_db (bracketed IPv6 loopback) -> blocked" \
  --contains "resolved db name: 'crm_db'" \
  -- would_block "postgresql://crm_user:password@[::1]:5432/crm_db"

assert_red "postgres:5432/crm_db (docker-compose service/container name as host) -> blocked" \
  --contains "resolved db name: 'crm_db'" \
  -- would_block "postgresql://crm_user:password@postgres:5432/crm_db"

assert_red "localhost/crm_db (no port — driver default 5432) -> blocked" \
  --contains "resolved db name: 'crm_db'" \
  -- would_block "postgresql://crm_user:password@localhost/crm_db"

assert_red "localhost:5432/crm_db?sslmode=disable (query string after the name) -> blocked" \
  --contains "resolved db name: 'crm_db'" \
  -- would_block "postgresql://crm_user:password@localhost:5432/crm_db?sslmode=disable"

assert_red "localhost:5432/crm_db?options=... (a different query key) -> blocked" \
  --contains "resolved db name: 'crm_db'" \
  -- would_block "postgresql://crm_user:password@localhost:5432/crm_db?options=-csearch_path%3Dpublic"

assert_red "round-3: crm%5Fdb (percent-encoded — decodes to crm_db for libpq) -> blocked" \
  --contains "resolved db name: 'crm_db'" \
  -- would_block "postgresql://crm_user:password@localhost:5432/crm%5Fdb"

assert_red "round-3: a dangling trailing space after crm_db -> blocked" \
  --contains "resolved db name: 'crm_db'" \
  -- would_block "postgresql://crm_user:password@127.0.0.1:5432/crm_db "

# ── legitimate forms — every one must NOT resolve to crm_db and pass ───────────
assert_green "crm_qa (a real, differently-named database) -> allowed" \
  --contains "resolved db name: 'crm_qa'" \
  -- would_block "postgresql://crm_user:password@localhost:5432/crm_qa"

assert_green "crm_qa via 127.0.0.1 -> allowed (host form never mattered once it isn't crm_db)" \
  --contains "resolved db name: 'crm_qa'" \
  -- would_block "postgresql://crm_user:password@127.0.0.1:5432/crm_qa"

assert_green "crm_qa with a trailing space + query string -> allowed" \
  --contains "resolved db name: 'crm_qa'" \
  -- would_block "postgresql://crm_user:password@localhost:5432/crm_qa?sslmode=disable "

assert_green "crm_db_scratch (a scratch DB whose name merely starts with crm_db) -> allowed" \
  --contains "resolved db name: 'crm_db_scratch'" \
  -- would_block "postgresql://crm_user:password@localhost:5599/crm_db_scratch"

assert_green "CRM_DB (uppercase — a DIFFERENT Postgres identifier, not the live crm_db) -> allowed" \
  --contains "resolved db name: 'CRM_DB'" \
  -- would_block "postgresql://crm_user:password@localhost:5432/CRM_DB"

assert_green "no database name at all (libpq defaults dbname to the connecting user) -> allowed" \
  --not-contains "resolved db name: 'crm_db'" \
  -- would_block "postgresql://crm_user:password@localhost:5432"

assert_green "bare trailing slash, no database name -> allowed" \
  --contains "resolved db name: ''" \
  -- would_block "postgresql://crm_user:password@localhost:5432/"

guard_test_summary "test-run-landing-e2e-local-db-guard.sh"
