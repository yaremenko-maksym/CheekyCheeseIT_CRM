#!/usr/bin/env bash
# deploy-stack-on-vps.sh — the body of deploy.yml's "Pull, up, migrate,
# health-check via SSH" step (job `deploy`, "Deploy Stack on VPS").
#
# ── WHY THIS IS A FILE AND NOT AN INLINE `script:` BLOCK ─────────────────────
#
# It used to be inline. On 2026-10-19 the deploy of b2054f8a1 failed before the
# step ever started, with a runner error and no SQL in sight:
#
#   An error occurred trying to start process '/usr/bin/bash' with working
#   directory '...'. Argument list too long
#
# appleboy/ssh-action is a composite action: it hands the `script:` input to its
# own `entrypoint.sh` step as the single environment string `INPUT_SCRIPT=<the
# whole script>` (see the action's action.yml — `INPUT_SCRIPT: ${{ inputs.script
# }}`). On Linux, execve refuses with E2BIG when ANY single argv OR envp string
# exceeds MAX_ARG_STRLEN = 32 * PAGE_SIZE = 32 * 4096 = 131072 bytes — that limit
# is per-string, and environment strings are counted exactly like arguments. The
# inlined script had grown to 133905 bytes across 2358 lines, so the runner could
# no longer spawn bash at all. PR #1027's three DDL apply blocks are what pushed
# it over; nothing was wrong with the script itself.
#
# THE FIX IS NOT TO SHRINK THE SCRIPT. Deleting comments to buy a few hundred
# bytes would work for one merge and fail on the next, and the comments in here
# are the reason the next person does not re-break an invariant that cost a prod
# incident to learn.
#
# ── THE FIRST FIX WAS WRONG, AND HOW ─────────────────────────────────────────
#
# PR #1035 moved the body here and passed it with `script_path:`. That was wired
# correctly — the next run's log shows `INPUT_SCRIPT:` empty and
# `INPUT_SCRIPT_FILE:` set — and it still failed, on the very next deploy
# (3928ba00e), one layer further out:
#
#   /bin/bash: Argument list too long
#
# Because drone-ssh `os.ReadFile`s the `script.file` into the SAME `scripts`
# slice that `INPUT_SCRIPT` feeds, and then ships
# `strings.Join(p.Config.Script, "\n")` to `ssh.Stream` as ONE command string
# (plugin.go). The SSH exec request carries that as a single argument, so the
# remote `/bin/bash` refused it exactly as the runner's bash had. #1035's own
# research established that execution would be "unchanged" — and being unchanged
# is precisely why it still failed. The mechanism was verified; the outcome was
# not. Nothing in CI exercises a real deploy, so for a change of this shape the
# only test is a deploy.
#
# ── WHAT ACTUALLY REMOVES THE CEILING ────────────────────────────────────────
#
# The content must travel as a FILE and the command must be short. deploy.yml's
# `deploy` job scp's this file to /opt/crm/scripts/devops/ and the SSH step runs
# `bash /opt/crm/scripts/devops/deploy-stack-on-vps.sh` — tens of bytes on the
# wire as a command, 137 KB on the wire as a file, where no argument limit
# applies. That is the same pattern the backup-freshness step at the end of that
# job had been using all along.
#
# The general rule, since this file cost two production-blocking deploys to
# learn: ANY route that hands this body to ssh-action as `script:` or
# `script_path:` ships it as a command string and WILL hit MAX_ARG_STRLEN —
# on the runner or on the VPS. Only scp-then-run does not.
#
# ── CONSEQUENCES YOU MUST KNOW BEFORE EDITING ────────────────────────────────
#
#   * This file runs ON THE VPS, over SSH, as `secrets.VPS_USER`. It is not a
#     runner script. `bash -n` and shellcheck apply to it; the runner's ambient
#     environment does not.
#   * drone-ssh prepends `export` lines for the variables named in the step's
#     `envs:` list (IMAGE_TAG, GH_ACTOR, GHCR_TOKEN, CRM_CSP_MODE). A variable
#     newly used here must be added to BOTH that step's `env:` block and its
#     `envs:` list in deploy.yml, or it arrives unset and `set -u` kills the
#     deploy. That coupling is the one thing this split made easier to overlook.
#   * deploy.yml's `deploy` job now checks the repository out before this step,
#     because `script_path` is read from the runner's workspace. That checkout
#     uses the default ref — the same commit the workflow file itself came from,
#     which is exactly the coupling the inline script had for free.
#   * Size is now guarded rather than remembered:
#     scripts/devops/check-ssh-action-script-size.py fails CI if any ssh-action
#     step's INLINE script approaches MAX_ARG_STRLEN again. A file referenced by
#     `script_path` is outside that guard's scope by construction — it is never
#     an environment string — which is the entire point of this file.
#
# Secrets: GHCR_TOKEN arrives via the environment and is never echoed. Do not
# add `set -x` to this file.
set -euo pipefail
cd /opt/crm

# security-review PR #443 (this infra-PR's task): fresh per-run scratch file that
# accumulates the RAISE NOTICE output of the drop-share-pending-parity marker +
# precount DDL steps below, so the "Fetch
# drop-share-pending-parity DDL summary" step further down in this job (a
# SEPARATE, small ssh-action step with capture_stdout: true) can surface it in the
# job's $GITHUB_STEP_SUMMARY instead of it being buried in this step's (very long)
# live log — these are real money numbers, see
# scripts/devops/drop-share-pending-parity-backfill-runbook.md. Truncated as early
# as possible in this script (before ANY step that could fail) so a partial/failed
# run still leaves a fresh, not-stale, file for the summary step (which runs with
# `if: always()`) to read — never a leftover from a PREVIOUS run's numbers
# misattributed to this one.
: > /opt/crm/.last-ddl-summary.txt

echo "==> Logging in to GHCR"
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GH_ACTOR" --password-stdin

echo "==> Pulling new images (IMAGE_TAG=${IMAGE_TAG})"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  pull api nginx

# task-infra-prod-backup-safety-net (2026-08-03): re-assert the execute bit on
# every deploy — belt-and-braces to scp-action's own mode-preservation (git
# already tracks this file as 100755, and scp-action's copy in the copy-compose
# job above should carry that through, but this makes it explicit and self-
# healing rather than relying on that assumption silently holding forever). Only
# a ::warning (not fatal): the owner's cron install (docs/runbooks/deployment.md
# §8) is what actually matters, and a missing file here is caught loudly anyway
# by the "Check backup freshness" step near the end of this job.
echo "==> Ensuring pg-backup.sh is executable"
if [ -f /opt/crm/scripts/devops/pg-backup.sh ]; then
  chmod +x /opt/crm/scripts/devops/pg-backup.sh
else
  echo "::warning::pg-backup.sh not found at /opt/crm/scripts/devops/pg-backup.sh — copy-compose job's scp step should have placed it there."
fi

# Start of the deploy window for the 42501 log scan at the end of Step 3 (below).
DEPLOY_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── Step 1: ensure postgres + redis are up (persistent — usually already running) ──
# api and nginx are started AFTER DDL is applied (see Step 3).
#
# Инцидент 2026-07-31: этот шаг положил прод. Когда compose решает
# ПЕРЕСОЗДАТЬ postgres/redis (менялись compose-файлы или
# .env.production — а они переписываются каждым деплоем), он гасит
# их и пересоздаёт сеть `crm_backend`. Но `api` этой командой не
# управляется (стартует позже, на Step 3) и остаётся подключённым к
# сети → `network crm_backend has active endpoints (crm-api-1)` →
# шаг падает, ОСТАВИВ postgres и redis лежать. `/api/health` при
# этом отвечает 200 (в базу не ходит), а всё остальное — 500.
# Следующий прогон падал уже иначе (`container ... is not connected
# to the network`), потому что состояние стека рассогласовано.
#
# Поэтому: пробуем как раньше (инкрементально, без простоя), а при
# неудаче — сбрасываем стек целиком и поднимаем заново.
#
# !!! `down` — БЕЗ `-v` / `--volumes`. Это не стилистика: том
# `postgres_data` (и `redis_data`) объявлен именованным
# в `docker-compose.prod.yml`, поэтому `down` сносит только
# контейнеры и сети, а данные переживают. Добавление `-v` сюда
# УНИЧТОЖИТ БОЕВУЮ БАЗУ. Никогда не добавлять.
echo "==> Ensuring postgres and redis are up"
if ! docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  up -d postgres redis; then
  echo "::warning::compose up failed — вероятно рассогласованная сеть crm_backend (см. инцидент 2026-07-31). Сбрасываю стек: контейнеры и сети пересоздаются, именованные тома НЕ трогаются."
  docker compose \
    -f docker-compose.prod.yml \
    -f docker-compose.ghcr.yml \
    --env-file .env.production \
    down --remove-orphans
  docker compose \
    -f docker-compose.prod.yml \
    -f docker-compose.ghcr.yml \
    --env-file .env.production \
    up -d postgres redis
fi

echo "==> Waiting for postgres to be healthy"
for i in $(seq 1 30); do
  if docker compose \
       -f docker-compose.prod.yml \
       -f docker-compose.ghcr.yml \
       --env-file .env.production \
       exec -T postgres \
       pg_isready -U crm_user -d crm_db 2>/dev/null; then
    echo "Postgres healthy after ${i}x checks"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: postgres did not become healthy in 60s"
    docker compose \
      -f docker-compose.prod.yml \
      -f docker-compose.ghcr.yml \
      --env-file .env.production \
      logs --tail=30 postgres
    exit 1
  fi
  sleep 2
done

# ── database roles (r5 Task 1.3c, ADR 2026-10-17-db-least-privilege-roles §4) ──
# MUST be the FIRST manual DDL applied: the grants file (applied after the schema
# DDL below) raises a named exception when these roles do not exist, and the append-only
# trigger file (r5 Task 1.3b) needs crm_retention_owner.
#
# NO PASSWORD IS PASSED HERE, deliberately. The file takes SCRAM verifiers from the
# GUCs crm_roles.{app,collector}_verifier and treats an unset one as a no-op, so
# with none set the roles are created without any credential (crm_app cannot log in)
# and nothing in this deploy uses them. Neither secret nor transport exists yet; do
# not invent one in this step.
#
# THE HANDOFF rollout step 5 (PR B) adds, end to end (runbook §5.1 is the long form):
#   1. RUNNER, in this job, before this ssh step: `actions/checkout@v4` with
#      `sparse-checkout: apps/api/src/database/privileges/scram-verifier.cli.mjs` and
#      `persist-credentials: false`; the secret CRM_APP_DB_PASSWORD (owner adds it,
#      ADR §4 step 1) enters ONLY that one step's `env:`; the step runs
#        V="$(printf %s "$CRM_APP_DB_PASSWORD" | node <cli>.mjs)"
#        echo "::add-mask::$V"; echo "CRM_APP_DB_VERIFIER=$V" >> "$GITHUB_ENV"
#      (stdin, never argv; the .mjs needs only node:crypto, and the runner's preinstalled
#      node suffices). Mask BEFORE writing to GITHUB_ENV.
#   2. RUNNER -> VPS: this step's `envs:` list gains the NAME CRM_APP_DB_VERIFIER, the
#      same passthrough GHCR_TOKEN uses. Only the verifier crosses; the password never
#      reaches the VPS and is never written to .env.production by this path.
#   3. VPS, here, replacing the bare apply below (fail loud if the variable is empty
#      once the rollout makes it mandatory):
#        PGOPTIONS="-c crm_roles.app_verifier=${CRM_APP_DB_VERIFIER}" \
#          docker compose -f docker-compose.prod.yml -f docker-compose.ghcr.yml \
#            --env-file .env.production exec -T -e PGOPTIONS postgres \
#            psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 < "$DB_ROLES_FILE"
#      `-e PGOPTIONS` is the NAME only (compose copies the value from this shell's
#      environment); `-e NAME=value` and `psql -v name=value` both put the value in
#      argv. The variables are the ones this script defines: PGUSER and PGDB (NOT
#      PGDATABASE). A prefix assignment scopes PGOPTIONS to that one command.
#   4. Server: PGOPTIONS reaches the backend as a startup `options` parameter, not as a
#      statement, so it is not in log_statement output nor in a failing statement's
#      logged text; the roles file also raises log_min_error_statement around the
#      ALTER ROLE.
# To verify at rollout, not assume: compose `exec -e NAME` pass-through on the VPS's
# compose version, and that `ps -ef` during the apply shows no `SCRAM-SHA-256`
# (ADR verification row for the SCRAM / \getenv path).
PGUSER=$(grep '^POSTGRES_USER=' /opt/crm/.env.production | cut -d= -f2)
PGDB=$(grep '^POSTGRES_DB='   /opt/crm/.env.production | cut -d= -f2)

# Source: apps/api/drizzle/manual/2026-10-18_db_roles.sql
DB_ROLES_FILE="/opt/crm/apps/api/drizzle/manual/2026-10-18_db_roles.sql"

if [ ! -f "$DB_ROLES_FILE" ]; then
  echo "ERROR: DDL file not found at $DB_ROLES_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying database roles (idempotent, no passwords) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$DB_ROLES_FILE"
echo "==> database roles applied successfully"

# ── Step 2: apply audit-hardening DDL (idempotent) ───────────────────────────────
# The SQL file was copied by the copy-compose job to:
#   /opt/crm/apps/api/drizzle/manual/2026-07-04_audit_hardening_constraints.sql
# [prod-verify] path matches scp-action tree layout (source dir preserved under target).
#
# Credentials come from .env.production (POSTGRES_USER / POSTGRES_DB written by
# write-env job). psql reads them as plain env vars via --env-file equivalent
# (passed through `docker compose exec -T` which inherits the compose env-file).
# We parse POSTGRES_USER and POSTGRES_DB directly from .env.production to be
# explicit and avoid relying on exec env inheritance.
#
# ON_ERROR_STOP=1 — any SQL error exits psql with non-zero status, which
# propagates through `exec -T`, causing the whole script to fail (set -e).
# The DDL is fully idempotent (IF NOT EXISTS) — safe on repeated deploys.
DDL_FILE="/opt/crm/apps/api/drizzle/manual/2026-07-04_audit_hardening_constraints.sql"
PGUSER=$(grep '^POSTGRES_USER=' /opt/crm/.env.production | cut -d= -f2)
PGDB=$(grep '^POSTGRES_DB='   /opt/crm/.env.production | cut -d= -f2)

# Guard: explicit error if scp-action flattened the tree instead of preserving it.
if [ ! -f "$DDL_FILE" ]; then
  echo "ERROR: DDL file not found at $DDL_FILE — scp-action may have flattened the tree."
  echo "Check copy-compose scp layout; expected /opt/crm/apps/api/drizzle/manual/<file>."
  ls -la /opt/crm/ /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying audit-hardening DDL (idempotent) — user=${PGUSER} db=${PGDB}"
# -f inside the container would require the file to be mounted there.
# Pipe the host-side file to psql stdin via `exec -T` (no TTY → stdin passthrough).
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$DDL_FILE"
echo "==> DDL applied successfully"

# ── Step 2b: drop unused users.usr_record column (idempotent) ────────────────────
# PR #345 removed the usrRecord field from all code; this drops the now-unused
# physical column. DROP COLUMN IF EXISTS → safe no-op once the column is gone.
# Source: apps/api/drizzle/manual/2026-07-11_drop_usr_record.sql
DROP_USR_RECORD_FILE="/opt/crm/apps/api/drizzle/manual/2026-07-11_drop_usr_record.sql"
if [ ! -f "$DROP_USR_RECORD_FILE" ]; then
  echo "ERROR: DDL file not found at $DROP_USR_RECORD_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/ /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Dropping unused users.usr_record column (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$DROP_USR_RECORD_FILE"
echo "==> usr_record column drop applied successfully"

# ── Step 2c: payment_type enum + drop-share override + USDT-income idempotency ───
# PR #367 (task-drop-share-override-and-receiver, ADR
# docs/architecture/2026-07-13-payment-type-income-routing.md):
#   1. apps/api/drizzle/manual/2026-07-13_payment_type_and_drop_pending_payout.sql
#      — transaction_type += DROP_PENDING_PAYOUT, projects.payment_type
#      varchar → project_payment_type enum, drop-share override + snapshot
#      columns. Contains a FAIL-LOUD C13 guard: it RAISEs and aborts the
#      deploy if a non-GamingTec project carries a payment_type value that
#      looks like USDT/GIG_CONTRACT rather than the blanket FOP default —
#      that is expected, intentional behavior (a human must classify the
#      value explicitly), NOT a flake to retry or suppress.
#   2. apps/api/drizzle/manual/2026-07-14_usdt_income_idempotency_index.sql
#      — security-review MED-1 backstop: partial unique index on
#      transactions(idempotency_key) scoped to type = 'ADMIN_INCOME'.
# Both scripts are idempotent (IF NOT EXISTS / guarded DO blocks) — safe to
# re-run on repeated deploys. Source files were copied by copy-compose to
# /opt/crm/apps/api/drizzle/manual/<file>.
PAYMENT_TYPE_FILE="/opt/crm/apps/api/drizzle/manual/2026-07-13_payment_type_and_drop_pending_payout.sql"
USDT_IDEMPOTENCY_FILE="/opt/crm/apps/api/drizzle/manual/2026-07-14_usdt_income_idempotency_index.sql"

if [ ! -f "$PAYMENT_TYPE_FILE" ]; then
  echo "ERROR: DDL file not found at $PAYMENT_TYPE_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/ /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi
if [ ! -f "$USDT_IDEMPOTENCY_FILE" ]; then
  echo "ERROR: DDL file not found at $USDT_IDEMPOTENCY_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/ /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying payment_type enum + drop-share override DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$PAYMENT_TYPE_FILE"
echo "==> payment_type enum + drop-share override DDL applied successfully"

echo "==> Applying USDT-income idempotency index DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$USDT_IDEMPOTENCY_FILE"
echo "==> USDT-income idempotency index DDL applied successfully"

echo "==> Verifying payment_type distribution and idempotency index"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  <<< "SELECT payment_type, COUNT(*) FROM projects GROUP BY payment_type;"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  <<< "SELECT indexname FROM pg_indexes WHERE tablename='transactions' AND indexname='uq_transactions_admin_income_idempotency_key';"

# ── Step 2d: transaction_audit_log table (idempotent) ────────────────────────────
# task-receipts-backend (PR #374): the generic PATCH /api/transactions/:id/receipt
# attach/replace endpoint records every receipt mutation (ATTACH | REPLACE) into a
# new audit table. Mirrors the existing *_audit_log tables (user/team/project) but
# target_id has NO FK (audit must outlive the transaction it describes) and carries
# a jsonb metadata column instead of changes.
# Source: apps/api/drizzle/manual/2026-07-14_transaction_audit_log.sql
# Idempotent: CREATE TABLE / INDEX IF NOT EXISTS — safe to re-run on repeated deploys.
TRANSACTION_AUDIT_LOG_FILE="/opt/crm/apps/api/drizzle/manual/2026-07-14_transaction_audit_log.sql"

if [ ! -f "$TRANSACTION_AUDIT_LOG_FILE" ]; then
  echo "ERROR: DDL file not found at $TRANSACTION_AUDIT_LOG_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/ /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying transaction_audit_log DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$TRANSACTION_AUDIT_LOG_FILE"
echo "==> transaction_audit_log DDL applied successfully"

# ── Step 2e: vacancies module tables + enums (idempotent) ────────────────────────
# task-vacancies-api (PR #390): public vacancies (landing) + admin CRUD (CRM).
# Two brand-new tables (vacancies, vacancy_applications) + 5 new enums — fully
# additive, no existing table/column touched. Ships in this infra-PR (merged
# BEFORE or alongside #390) so the SQL is guaranteed to run before any api image
# that references the new tables — and is idempotent, so it is also safe to
# re-run on every subsequent deploy once #390 is live.
# Source: apps/api/drizzle/manual/2026-07-22_vacancies.sql
VACANCIES_FILE="/opt/crm/apps/api/drizzle/manual/2026-07-22_vacancies.sql"

if [ ! -f "$VACANCIES_FILE" ]; then
  echo "ERROR: DDL file not found at $VACANCIES_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/ /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying vacancies module DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$VACANCIES_FILE"
echo "==> vacancies module DDL applied successfully"

# ── Step 2f: telemetry module tables + enums (idempotent, GUARDED) ───────────────
# task-infra-telemetry-digest (T3, this infra-PR): prod-error tracking +
# UX-event analytics (docs/superpowers/specs/2026-07-24-crm-telemetry-design.md).
# UNLIKE Step 2e above, this infra-PR merges BEFORE task-telemetry-api (T1, PR
# #412, feature/telemetry-api) and does NOT carry its own copy of the SQL file
# (DevOps zone-of-write excludes apps/api/** — that file is Coder's to add in
# #412). So this step SOFT-SKIPS via ::notice when the file isn't present yet,
# instead of the fail-loud "scp-action flattened the tree" check every other DDL
# step uses — a missing file here is the EXPECTED steady state until #412 merges,
# not an error. copy-compose's "Check for telemetry DDL file" step mirrors this
# same guard on the scp side. Once #412 merges, the file exists on every
# subsequent deploy and this step applies it exactly like the others (idempotent:
# guarded CREATE TYPE + CREATE TABLE/INDEX IF NOT EXISTS).
# Source: apps/api/drizzle/manual/2026-07-24_telemetry.sql
TELEMETRY_FILE="/opt/crm/apps/api/drizzle/manual/2026-07-24_telemetry.sql"

if [ ! -f "$TELEMETRY_FILE" ]; then
  echo "::notice::Telemetry DDL file not found at $TELEMETRY_FILE — task-telemetry-api (PR #412) has not merged to main yet. Skipping this step; it applies automatically on the next deploy once #412 is in main. See scripts/devops/telemetry-digest-runbook.md."
else
  echo "==> Applying telemetry module DDL (idempotent) — user=${PGUSER} db=${PGDB}"
  docker compose \
    -f docker-compose.prod.yml \
    -f docker-compose.ghcr.yml \
    --env-file .env.production \
    exec -T postgres \
    psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
    < "$TELEMETRY_FILE"
  echo "==> telemetry module DDL applied successfully"
fi

# ── Step 2g: vacancy i18n + JobPosting SEO enrichment columns (idempotent) ────────
# INCIDENT FIX (task-infra-vacancy-i18n-ddl, 2026-07-25): PR #422
# (task-vacancy-i18n-jobposting) shipped this file BEFORE this apply step (and the
# copy-compose source: entry) existed — the already-deployed API code queries these
# columns, so GET /api/public/vacancies started 500ing on prod the moment #422's
# image went live. See the copy-compose job's comment above and
# scripts/devops/check-prod-ddl-wiring.py (new CI guard preventing a repeat of this
# exact gap class: DDL file merged but never wired into this workflow).
# Idempotent: `ADD COLUMN IF NOT EXISTS` on all 7 columns — safe to re-run.
# Source: apps/api/drizzle/manual/2026-07-25_vacancy_i18n_seo.sql
VACANCY_I18N_FILE="/opt/crm/apps/api/drizzle/manual/2026-07-25_vacancy_i18n_seo.sql"

if [ ! -f "$VACANCY_I18N_FILE" ]; then
  echo "ERROR: DDL file not found at $VACANCY_I18N_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/ /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying vacancy i18n + JobPosting SEO DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$VACANCY_I18N_FILE"
echo "==> vacancy i18n + JobPosting SEO DDL applied successfully"

# ── Step 2h: company_account.requisites_markdown column (idempotent) ─────────────
# Found unwired in the SAME audit that uncovered the Step 2g incident above. This
# file predates this workflow's DDL-wiring convention entirely (its own header
# comment describes a pre-automation "owner applies manually on prod" workflow, from
# before auto-deploy existed — see docs/runbooks/deployment.md). Wiring it in now,
# defense-in-depth: `ADD COLUMN IF NOT EXISTS` is a safe no-op if the owner already
# applied it by hand at the time, and closes the gap either way if not.
# Source: apps/api/drizzle/manual/2026-06-29_company_account_requisites_markdown.sql
REQUISITES_MARKDOWN_FILE="/opt/crm/apps/api/drizzle/manual/2026-06-29_company_account_requisites_markdown.sql"

if [ ! -f "$REQUISITES_MARKDOWN_FILE" ]; then
  echo "ERROR: DDL file not found at $REQUISITES_MARKDOWN_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/ /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying company_account.requisites_markdown DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$REQUISITES_MARKDOWN_FILE"
echo "==> company_account.requisites_markdown DDL applied successfully"

# ── Step 2i: csp_reports aggregate table (idempotent, GUARDED) ───────────────────
# task-csp-reports-and-flip: same GUARDED pattern as telemetry's Step 2f above, for
# the same reason — this infra-PR (Part B, DevOps zone-of-write, apps/api/**
# excluded) is dispatched in parallel with Part A (Coder, feature/csp-report-
# endpoint), which is the branch that actually creates this DDL file and the
# `csp_reports` table apps/api/src/csp-reports/ writes to. Order-independent by
# design (see the task file's "КОНТРАКТ" section) — a missing file here is the
# expected steady state until Part A merges, not an error, so this soft-skips via
# ::notice like Step 2f rather than the fail-loud "scp-action flattened the tree"
# check every OTHER DDL step above uses.
# Source: apps/api/drizzle/manual/2026-07-26_csp_reports.sql (see the copy-compose
# job's "COORDINATION NOTE" comment for why this exact filename is a best-effort
# guess, not a guaranteed match, and how a mismatch gets caught/fixed).
CSP_REPORTS_FILE="/opt/crm/apps/api/drizzle/manual/2026-07-26_csp_reports.sql"

if [ ! -f "$CSP_REPORTS_FILE" ]; then
  echo "::notice::CSP reports DDL file not found at $CSP_REPORTS_FILE — task-csp-reports-and-flip Part A (feature/csp-report-endpoint) has not merged to main yet, or used a different filename. Skipping this step; it applies automatically on a future deploy once the real file is wired in (see scripts/devops/csp-report-only-rollout-runbook.md)."
else
  echo "==> Applying csp_reports DDL (idempotent) — user=${PGUSER} db=${PGDB}"
  docker compose \
    -f docker-compose.prod.yml \
    -f docker-compose.ghcr.yml \
    --env-file .env.production \
    exec -T postgres \
    psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
    < "$CSP_REPORTS_FILE"
  echo "==> csp_reports DDL applied successfully"
fi

# ── Step 2j: consumed_tx_hashes registry + tx_from_address (idempotent, GUARDED) ──
# task-onchain-payment-integrity (PR #438): closes HOLE-2 (a single on-chain USDT
# transfer could credit the company account TWICE — once via the payout-confirmation
# path, once via the deposit path — because each guarded hash re-use in its OWN
# table, blind to the other). Same GUARDED pattern as telemetry/CSP reports above —
# this DDL-wiring PR is dispatched separately from, and MUST merge to `main` BEFORE
# OR TOGETHER WITH, #438 (its DDL file's own header says so: without this wiring the
# new image starts writing to `consumed_tx_hashes`, which does not exist in prod →
# 500 on every payout/deposit — same incident class as the 2026-07-25 vacancy-i18n
# gap check-prod-ddl-wiring.py now guards against). A missing file here is the
# expected steady state until #438 merges, not an error.
# Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, backfill
# INSERT ... ON CONFLICT DO NOTHING — safe to re-run every deploy.
#
# MONEY-CRITICAL OUTPUT — do not let this go quiet: the DDL's own backfill step
# RAISEs a WARNING (not an ERROR — it never fails the deploy) if it finds on-chain
# hashes ALREADY consumed by BOTH money paths before this fix — i.e. a REAL transfer
# that already double-credited the company balance, owner money, not a code bug this
# step can fix by itself. psql sends WARNING/NOTICE to stderr, which a bare `< file`
# invocation still surfaces in this step's own log (stdout+stderr are the same
# terminal stream over this SSH session) — but "present somewhere in a very long
# deploy log" is not the same as "seen". Captured explicitly below and, if that
# WARNING fired, re-emitted as a GitHub Actions `::warning::` annotation — those
# surface in the Checks tab summary and the PR conversation, not just buried in step
# output, which is the whole point: this is the owner's money, not a normal deploy
# log line.
# Source: apps/api/drizzle/manual/2026-07-27_consumed_tx_hashes.sql
CONSUMED_TX_HASHES_FILE="/opt/crm/apps/api/drizzle/manual/2026-07-27_consumed_tx_hashes.sql"

if [ ! -f "$CONSUMED_TX_HASHES_FILE" ]; then
  echo "::notice::consumed_tx_hashes DDL file not found at $CONSUMED_TX_HASHES_FILE — task-onchain-payment-integrity (PR #438) has not merged to main yet. Skipping this step; it applies automatically on the next deploy once #438 is in main."
else
  echo "==> Applying consumed_tx_hashes + tx_from_address DDL (idempotent) — user=${PGUSER} db=${PGDB}"
  if ! CONSUMED_TX_HASHES_OUTPUT=$(docker compose \
         -f docker-compose.prod.yml \
         -f docker-compose.ghcr.yml \
         --env-file .env.production \
         exec -T postgres \
         psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
         < "$CONSUMED_TX_HASHES_FILE" 2>&1); then
    echo "$CONSUMED_TX_HASHES_OUTPUT"
    echo "ERROR: consumed_tx_hashes DDL failed to apply — see psql output above."
    exit 1
  fi
  echo "$CONSUMED_TX_HASHES_OUTPUT"

  # money-critical: re-surface the backfill's WARNING (pre-existing cross-path
  # double credit) as a GHA annotation so it cannot be missed in a long log.
  DUP_WARNING_LINE=$(printf '%s\n' "$CONSUMED_TX_HASHES_OUTPUT" | grep 'WARNING:.*consumed_tx_hashes backfill' || true)
  if [ -n "$DUP_WARNING_LINE" ]; then
    echo "::warning::${DUP_WARNING_LINE} — see apps/api/drizzle/manual/2026-07-27_consumed_tx_hashes.sql's AUDIT query to identify the affected payout(s)/deposit(s); this is a real, pre-existing double credit to the company balance, not caused by this deploy."
  fi
  echo "==> consumed_tx_hashes + tx_from_address DDL applied successfully"
fi

# ── Step 2k: drop_cascade_origin marker column, FIRST PASS (idempotent, GUARDED) ──
# security-review PR #443 (MED-B, round 2; semantics revised HIGH-1, round 4):
# this infra-PR merges BEFORE (or alongside) fix/drop-share-pending-parity (PR
# #443) — DevOps zone-of-write excludes apps/api/**, so this PR cannot carry a
# copy of the file itself, same reason as telemetry's Step 2f / csp_reports's
# Step 2i above. A missing file here is the expected steady state until #443
# merges, not an error — soft-skip via ::notice, not the fail-loud check every
# ALREADY-present DDL file above uses. (Numbered 2k, not 2j — #438's
# consumed_tx_hashes wiring above already claims 2j.)
#
# security-review PR #443/#447 (round 6) — self-referential cutover boundary, not
# a hardcoded calendar date. The marker file's STEP 1 records this database's own
# first-ever application timestamp in a singleton state table
# (`drop_cascade_origin_marker_state`, `ON CONFLICT DO NOTHING` — every later pass
# reads the same value back unchanged). STEP 2 adds the column and converges its
# nullability/default. STEP 3's backfill is bounded by
# `created_at < first_applied_at + INTERVAL '24 hours'` — anchored to THIS
# environment's own rollout, not to a calendar date, so it is correct no matter how
# long the rollout is delayed. The window is wide enough to cover BOTH deploy-time
# passes (this Step 2k before the cutover, Step 3.5 after the health checks) plus
# same-day retries, and narrow enough that a row created by a future insert path
# that forgets to stamp the column — days or weeks after this environment's
# rollout — is never touched and correctly stays NULL/blocked. Every PRE-EXISTING
# `DROP_PENDING_PAYOUT` row is, by construction, admin-declaration-originated (the
# drop-payout cascade only started producing DROP_PENDING_PAYOUT rows in THIS PR;
# before it, the cascade inserted PAYOUT_DROP directly), so `false` is the only
# correct backfill value for it. Without this, the `<> false` guard in
# `settleByCompany` (pending-settlement.service.ts) would wrongly BLOCK a
# legitimate COMPANY_ACCOUNT settle on money the company is genuinely holding — see
# the file's own header for the full walk-through.
#
# This FIRST pass — safe to leave wired PERMANENTLY once present, per the file's
# own header and the round-4/round-6 review discussion. Runs as an ORDINARY,
# unconditional step — see scripts/devops/drop-share-pending-parity-backfill-runbook.md
# for why (the one-time historical BACKFILL that used to need an explicit opt-in
# gate was de-wired 2026-08-01 — see that runbook's history section — leaving only
# this permanent marker + the read-only precount below).
#
# Deploy-window gap this FIRST pass alone does NOT close: it only catches rows
# that exist AT THE MOMENT it runs — before Step 3 restarts api/nginx, the OLD
# (previous-deploy) image is still serving and can still insert fresh unmarked
# rows. Step 3.5, further down this script (after Step 3's health checks), is the
# required SECOND application that sweeps those stragglers — see that step's own
# comment for the full reasoning and why it, like this FIRST pass, is safe and
# intended to stay wired PERMANENTLY (security-review PR #443, round 5/6): the
# marker file's STEP 1 anchor (`first_applied_at`, stamped once, ever, per
# database) never moves, so the `first_applied_at + 24 hours` cutoff in STEP 3
# stays fixed forever — it can never expand to catch a row a future, correctly-
# stamping code path inserts days or weeks after this environment's own rollout,
# no matter how many times either pass re-runs.
# Source: apps/api/drizzle/manual/2026-07-27_drop_cascade_origin_marker.sql
DROP_CASCADE_MARKER_FILE="/opt/crm/apps/api/drizzle/manual/2026-07-27_drop_cascade_origin_marker.sql"

if [ ! -f "$DROP_CASCADE_MARKER_FILE" ]; then
  echo "::notice::drop_cascade_origin marker DDL not found at $DROP_CASCADE_MARKER_FILE — PR #443 (fix/drop-share-pending-parity) has not merged to main yet. Skipping this and the precount step below; both apply automatically once #443 is in main. See scripts/devops/drop-share-pending-parity-backfill-runbook.md."
  echo "=== drop_cascade_origin marker — SKIPPED (file not present; PR #443 not merged yet) ===" >> /opt/crm/.last-ddl-summary.txt
else
  echo "==> Applying drop_cascade_origin marker DDL (idempotent) — user=${PGUSER} db=${PGDB}"
  {
    echo "=== drop_cascade_origin marker (2026-07-27_drop_cascade_origin_marker.sql) ==="
    docker compose \
      -f docker-compose.prod.yml \
      -f docker-compose.ghcr.yml \
      --env-file .env.production \
      exec -T postgres \
      psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
      < "$DROP_CASCADE_MARKER_FILE" 2>&1
  } | tee -a /opt/crm/.last-ddl-summary.txt
  echo "==> drop_cascade_origin marker DDL applied successfully"
fi

# ── Step 2l: drop-share pending-parity PRE-COUNT (read-only, GUARDED, PERMANENT) ──
# security-review PR #443 (MED-A, second review round): 100% read-only (no
# CREATE/INSERT/UPDATE of any kind), safe and intended to run on EVERY deploy once
# #443 is in main. This is how the owner sees the number: the first prod run of
# this precount after #443 merged (run 30691783655, 2026-08-01) printed 0 Path-B
# rows — nothing on prod was ever created via the pre-#443 bypass, so the one-time
# historical BACKFILL that used to sit further down this script (gated behind
# APPLY_DROP_SHARE_PENDING_PARITY_BACKFILL) had nothing to migrate and was de-wired
# the same day (task-infra-drop-share-backfill-dewire). This step stays wired
# PERMANENTLY, unconditionally, as a standing tripwire: if a future run ever prints
# a non-zero count here, that is the signal a path we don't know about produced a
# Path-B row again — see scripts/devops/drop-share-pending-parity-backfill-runbook.md.
# The RAISE NOTICE output is captured into /opt/crm/.last-ddl-summary.txt (reset at
# the top of this script) and surfaced in the job summary by a separate step later
# in this job — not buried in this (very long) live log.
# Source: apps/api/drizzle/manual/2026-07-27_drop_share_pending_parity_precount.sql
PRECOUNT_FILE="/opt/crm/apps/api/drizzle/manual/2026-07-27_drop_share_pending_parity_precount.sql"

if [ ! -f "$PRECOUNT_FILE" ]; then
  echo "::notice::drop-share pending-parity precount DDL not found at $PRECOUNT_FILE — PR #443 has not merged to main yet. Skipping. See scripts/devops/drop-share-pending-parity-backfill-runbook.md."
  echo "=== drop-share pending-parity PRE-COUNT — SKIPPED (file not present; PR #443 not merged yet) ===" >> /opt/crm/.last-ddl-summary.txt
else
  echo "==> Applying drop-share pending-parity PRE-COUNT (read-only) — user=${PGUSER} db=${PGDB}"
  {
    echo "=== drop-share pending-parity PRE-COUNT (2026-07-27_drop_share_pending_parity_precount.sql) ==="
    docker compose \
      -f docker-compose.prod.yml \
      -f docker-compose.ghcr.yml \
      --env-file .env.production \
      exec -T postgres \
      psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
      < "$PRECOUNT_FILE" 2>&1
  } | tee -a /opt/crm/.last-ddl-summary.txt
  echo "==> drop-share pending-parity PRE-COUNT complete"
fi

# ── Step 2m: vacancy salary range columns (idempotent, GUARDED) ──────────────────
# task-vacancy-salary-range (PR #459), owner decision 2026-08-01: the public salary
# range became mandatory for vacancies after Google Search Console flagged the
# missing baseSalary in JobPosting structured data.
# GUARDED for the same reason as Steps 2f/2i/2j above — this wiring is DevOps zone
# and lands separately from the Coder branch that creates the file, so a missing
# file is the expected steady state until #459 merges, not an error.
# Idempotent: ADD COLUMN IF NOT EXISTS, additive only. Columns are NULLABLE by
# design — the three vacancies already published on prod predate this feature, and
# mandatory-ness is enforced at create/publish time, never retroactively. The read
# path tolerates the columns being absent entirely (schema is `.nullish()`), so an
# image landing before this DDL degrades to "no baseSalary in the markup" rather
# than erroring.
# Source: apps/api/drizzle/manual/2026-08-01_vacancy_salary_range.sql
VACANCY_SALARY_FILE="/opt/crm/apps/api/drizzle/manual/2026-08-01_vacancy_salary_range.sql"

if [ ! -f "$VACANCY_SALARY_FILE" ]; then
  echo "::notice::Vacancy salary range DDL file not found at $VACANCY_SALARY_FILE — task-vacancy-salary-range (PR #459) has not merged to main yet. Skipping this step; it applies automatically on a future deploy once the file is present."
else
  echo "==> Applying vacancy salary range DDL (idempotent) — user=${PGUSER} db=${PGDB}"
  docker compose \
    -f docker-compose.prod.yml \
    -f docker-compose.ghcr.yml \
    --env-file .env.production \
    exec -T postgres \
    psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
    < "$VACANCY_SALARY_FILE"
  echo "==> vacancy salary range DDL applied successfully"
fi

# ── Step 2n: transaction soft-delete columns + CONCURRENTLY index (idempotent, GUARDED) ──
# task-soft-delete-and-money-audit (PR #456): adds deleted_at / deleted_by /
# deletion_reason to `transactions` — adminDeleteTransaction now stamps instead of
# running DELETE FROM transactions, restoreTransaction (ADMIN-only) clears them —
# plus a partial index supporting the new `WHERE deleted_at IS NULL` predicate
# every hot read (findAll's default list, every balance/summary aggregate) now
# carries.
# GUARDED for the same reason as Steps 2f/2i/2j/2m above — DevOps zone-of-write
# excludes apps/api/**, this wiring lands separately from the Coder branch, and a
# missing file here is the expected steady state until #456 merges, not an error.
# copy-compose job's matching "Check for transaction soft-delete DDL file" step
# mirrors this guard on the scp side.
#
# CONCURRENTLY note — verified EMPIRICALLY, not by reading the file (this is
# exactly the incident class scripts/devops/check-prod-ddl-wiring.py already
# guards a different failure mode of): `CREATE INDEX CONCURRENTLY` cannot run
# inside a transaction block. Every `psql` invocation in this workflow (this one
# included) is a bare `psql -v ON_ERROR_STOP=1 < file` — no `-1` /
# `--single-transaction` flag anywhere — which does NOT wrap the piped script in
# one transaction; each statement autocommits individually, so the file's own
# `CREATE INDEX CONCURRENTLY IF NOT EXISTS` is safe as-is. Confirmed by running
# this exact file through this exact invocation shape against a scratch Postgres
# 16 container: succeeds cleanly without `-1` (twice — re-applied to also confirm
# idempotency), and fails with `ERROR: CREATE INDEX CONCURRENTLY cannot run inside
# a transaction block` when `-1` is added as a negative control — proving this
# invocation shape is the reason it works, not incidental.
# Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX CONCURRENTLY IF NOT EXISTS —
# safe to re-run on repeated deploys.
# Source: apps/api/drizzle/manual/2026-08-01_transaction_soft_delete.sql
TRANSACTION_SOFT_DELETE_FILE="/opt/crm/apps/api/drizzle/manual/2026-08-01_transaction_soft_delete.sql"

if [ ! -f "$TRANSACTION_SOFT_DELETE_FILE" ]; then
  echo "::notice::Transaction soft-delete DDL file not found at $TRANSACTION_SOFT_DELETE_FILE — task-soft-delete-and-money-audit (PR #456) has not merged to main yet. Skipping this step; it applies automatically on a future deploy once the file is present."
else
  echo "==> Applying transaction soft-delete DDL (idempotent) — user=${PGUSER} db=${PGDB}"
  docker compose \
    -f docker-compose.prod.yml \
    -f docker-compose.ghcr.yml \
    --env-file .env.production \
    exec -T postgres \
    psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
    < "$TRANSACTION_SOFT_DELETE_FILE"
  echo "==> transaction soft-delete DDL applied successfully"
fi

# ── Step 2o: document_access_log table + resume retention nullability (idempotent, GUARDED) ──
# task-file-storage-hardening (PR #462): new document_access_log audit table —
# mirrors transaction_audit_log's shape (target_id has NO FK reference, the audit
# trail must outlive a hard-deleted/retention-purged document or resume it
# describes) — records who fetched a presigned download/preview link for a
# sensitive document. Also widens vacancy_applications.resume_s3_key /
# resume_size_bytes to nullable: the 180-day resume-only retention purge clears
# both columns to NULL while keeping the application row itself (hiring-history
# value survives; only the file is scrubbed).
# GUARDED for the same reason as the blocks above — missing file is the expected
# steady state until #462 merges, not an error. Order-independent vs Step 2n
# above and vs main — this file's DDL does not reference `transactions` or
# anything #456 adds, and #456's does not reference `vacancy_applications` or
# `document_access_log`, so either PR can merge/deploy before, after, or without
# the other with no gap.
# Idempotent: CREATE TABLE/INDEX IF NOT EXISTS + ALTER COLUMN DROP NOT NULL
# (a no-op if already nullable) — safe to re-run on repeated deploys.
# Source: apps/api/drizzle/manual/2026-08-01_file_storage_hardening.sql
FILE_STORAGE_HARDENING_FILE="/opt/crm/apps/api/drizzle/manual/2026-08-01_file_storage_hardening.sql"

if [ ! -f "$FILE_STORAGE_HARDENING_FILE" ]; then
  echo "::notice::File storage hardening DDL file not found at $FILE_STORAGE_HARDENING_FILE — task-file-storage-hardening (PR #462) has not merged to main yet. Skipping this step; it applies automatically on a future deploy once the file is present."
else
  echo "==> Applying file storage hardening DDL (idempotent) — user=${PGUSER} db=${PGDB}"
  docker compose \
    -f docker-compose.prod.yml \
    -f docker-compose.ghcr.yml \
    --env-file .env.production \
    exec -T postgres \
    psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
    < "$FILE_STORAGE_HARDENING_FILE"
  echo "==> file storage hardening DDL applied successfully"
fi

# ── Step 2p: non_deleted_transactions VIEW (idempotent, GUARDED, ORDER-DEPENDENT) ──
# task-soft-delete-and-money-audit (PR #456), security-review round 2 (verdict
# BLOCK on 4834458611/4840207923): the round-1 guard-function + regression-spec
# defense was defeated 7/7 by round 2. This view is the "eliminate, don't detect"
# fix — `SELECT * FROM non_deleted_transactions` structurally cannot return a
# soft-deleted row (the filter IS the view's FROM target, not a WHERE a caller
# could omit), and list/aggregate/join reads across three modules now go through
# it instead of the raw `transactions` table.
# GUARDED for the same reason as every block above — missing file is the expected
# steady state until #456 merges, not an error. copy-compose job's matching "Check
# for non_deleted_transactions view DDL file" step mirrors this guard on the scp
# side.
#
# ORDER MATTERS — UNLIKE Step 2o vs Step 2n above (those two are mutually
# independent). This view's `SELECT *` includes `deleted_at`, which only exists
# once Step 2n (transaction soft-delete columns) has already run against this
# database — that is why this step is placed AFTER Step 2n (and, for the same
# "no cross-file coupling to worry about", after Step 2o too — 2o does not touch
# `transactions` at all). Verified EMPIRICALLY, not by reading the file (same
# discipline as Step 2n's CONCURRENTLY note above): ran both files against a
# scratch Postgres 16 container using this workflow's exact apply invocation
# (bare `psql -v ON_ERROR_STOP=1 < file`, no `-1`/`--single-transaction`) —
# soft-delete-columns-then-view succeeds cleanly and idempotently on a second
# full re-run of both files; view-then-soft-delete-columns fails loudly with
# `ERROR: column "deleted_at" does not exist` (negative control), confirming the
# ordering requirement is real and this placement satisfies it, not a coincidence.
# Idempotent: `CREATE OR REPLACE VIEW` — safe to re-run any number of times, on
# every deploy, forever. `CREATE OR REPLACE VIEW` cannot change an existing view's
# output column list (Postgres restriction) — the file's own header comment notes
# this is intentional: a future `transactions` column addition auto-flows through
# (SELECT *, re-applied on next deploy); a removed/renamed column instead fails
# loudly here (ON_ERROR_STOP=1) rather than silently drifting.
# Source: apps/api/drizzle/manual/2026-08-03_non_deleted_transactions_view.sql
NON_DELETED_TX_VIEW_FILE="/opt/crm/apps/api/drizzle/manual/2026-08-03_non_deleted_transactions_view.sql"

if [ ! -f "$NON_DELETED_TX_VIEW_FILE" ]; then
  echo "::notice::non_deleted_transactions view DDL file not found at $NON_DELETED_TX_VIEW_FILE — task-soft-delete-and-money-audit (PR #456) has not merged to main yet. Skipping this step; it applies automatically on a future deploy once the file is present."
else
  echo "==> Applying non_deleted_transactions view DDL (idempotent) — user=${PGUSER} db=${PGDB}"
  docker compose \
    -f docker-compose.prod.yml \
    -f docker-compose.ghcr.yml \
    --env-file .env.production \
    exec -T postgres \
    psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
    < "$NON_DELETED_TX_VIEW_FILE"
  echo "==> non_deleted_transactions view DDL applied successfully"
fi

# ── Step 2q: salary paid-amount columns on transactions (idempotent, GUARDED) ─────
# task-salary-pay-amount (PR #485): original_amount / original_currency /
# exchange_rate preserve the pay-time obligation snapshot when a PENDING salary is
# paid in a different amount/currency than it was created in — `amount`/`currency`
# become the payment FACT, these three columns keep the obligation they settled
# (USD reporting / balances / the "projects unpaid this month" metric all depend on
# it). See the DDL file's own header for the full reasoning (no backfill by design:
# NULL on every pre-existing row means "never paid through the amount-aware flow").
# GUARDED for the same reason as the blocks above — DevOps zone-of-write excludes
# apps/api/**, this wiring lands separately from the Coder branch, and a missing
# file here is the expected steady state until #485 merges, not an error.
# copy-compose job's matching "Check for salary paid-amount DDL file" step mirrors
# this guard on the scp side.
# ORDER REQUIRED, unlike e.g. Step 2n vs Step 2o above (mutually independent): the
# api reads these three columns on EVERY transaction read (part of the row SELECT
# and the DTO) — a new image against an un-migrated DB errors on every transactions
# query. This step, like every DDL apply step above, runs BEFORE Step 3 starts /
# updates the api and nginx containers, so the columns are always present before
# the new image can serve a single request. The reverse order is safe: applying
# this file while the OLD image still runs is a no-op for it (it never references
# the new columns).
# Idempotent: ADD COLUMN IF NOT EXISTS ×3 — safe to re-run on every deploy, forever.
# Source: apps/api/drizzle/manual/2026-08-05_salary_paid_amount.sql
SALARY_PAID_AMOUNT_FILE="/opt/crm/apps/api/drizzle/manual/2026-08-05_salary_paid_amount.sql"

if [ ! -f "$SALARY_PAID_AMOUNT_FILE" ]; then
  echo "::notice::Salary paid-amount DDL file not found at $SALARY_PAID_AMOUNT_FILE — task-salary-pay-amount (PR #485) has not merged to main yet. Skipping this step; it applies automatically on a future deploy once the file is present."
else
  echo "==> Applying salary paid-amount DDL (idempotent) — user=${PGUSER} db=${PGDB}"
  docker compose \
    -f docker-compose.prod.yml \
    -f docker-compose.ghcr.yml \
    --env-file .env.production \
    exec -T postgres \
    psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
    < "$SALARY_PAID_AMOUNT_FILE"
  echo "==> salary paid-amount DDL applied successfully"
fi

# ── Step 2r: vacancy_domain enum expansion (idempotent, GUARDED, ORDER-CRITICAL) ──
# feature/domains-expansion (parallel branch, not yet merged to main at the time
# this infra-PR lands, no PR number assigned yet): widens the `vacancy_domain` enum
# from its current 4 values (AI/EDTECH/ECOMMERCE/OTHER) with roughly fifteen new
# domain values via `ALTER TYPE vacancy_domain ADD VALUE IF NOT EXISTS '...'`.
# GUARDED for the same reason as the blocks above — DevOps zone-of-write excludes
# apps/api/**, this wiring lands separately from the Coder branch, and a missing
# file here is the expected steady state until that branch merges, not an error.
# copy-compose job's matching "Check for vacancy domain expansion DDL file" step
# mirrors this guard on the scp side.
#
# ORDER CRITICAL, stricter than the usual "new columns" case above (e.g. Step 2q):
# the new api image starts WRITING domain values the current enum type does not
# know about the moment it serves traffic — if this DDL applies AFTER the new
# image is live, every vacancy create/update using a new domain value fails
# outright (`invalid input value for enum vacancy_domain`), not a degraded read.
# This step therefore runs BEFORE Step 3 starts/updates the api and nginx
# containers, same placement as every DDL step above. The reverse order is safe:
# applying this file while the OLD image still runs is a no-op for it (it never
# writes the new values).
#
# `ALTER TYPE ... ADD VALUE` cannot run inside a multi-statement transaction block
# together with other statements in the same transaction on older Postgres, and
# cannot be used in the same transaction it was added in either way — this
# workflow's plain `psql -v ON_ERROR_STOP=1 < file` invocation (no `-1` /
# `--single-transaction`, same as every apply step above) gives each statement its
# own implicit transaction, which is exactly the mode this needs. Verified
# EMPIRICALLY (same discipline as Step 2n's CONCURRENTLY note above), not by
# reading Postgres docs alone: ran a same-shaped 15-statement `ADD VALUE IF NOT
# EXISTS` file against a scratch Postgres 16 container with this exact invocation
# — first run applied all 15 values cleanly (exit 0); a second full re-run printed
# `NOTICE: enum label "..." already exists, skipping` for every statement and
# still exited 0 — confirming the file is safe to re-run on every deploy, forever.
# Source: apps/api/drizzle/manual/2026-08-05_vacancy_domain_expansion.sql
VACANCY_DOMAIN_EXPANSION_FILE="/opt/crm/apps/api/drizzle/manual/2026-08-05_vacancy_domain_expansion.sql"

if [ ! -f "$VACANCY_DOMAIN_EXPANSION_FILE" ]; then
  echo "::notice::vacancy_domain expansion DDL file not found at $VACANCY_DOMAIN_EXPANSION_FILE — feature/domains-expansion has not merged to main yet. Skipping this step; it applies automatically on a future deploy once the file is present."
else
  echo "==> Applying vacancy_domain expansion DDL (idempotent) — user=${PGUSER} db=${PGDB}"
  docker compose \
    -f docker-compose.prod.yml \
    -f docker-compose.ghcr.yml \
    --env-file .env.production \
    exec -T postgres \
    psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
    < "$VACANCY_DOMAIN_EXPANSION_FILE"
  echo "==> vacancy_domain expansion DDL applied successfully"
fi

# ── Step 2s: job sourcing module tables + enums (idempotent, GUARDED) ─────────────
# task-job-sourcing-slice1 (PR #493): four brand-new tables (job_sources,
# job_postings, job_suggestions, job_exclusion_filters) + 3 new enums — fully
# additive, no existing table/column touched, same shape as the telemetry/
# vacancies module DDL above (Step 2e/2f), not order-critical the way an enum-
# VALUE addition to an already-live enum is (Step 2r immediately above). GUARDED
# for the same reason as the blocks above — DevOps zone-of-write excludes
# apps/api/**, this wiring lands separately from the Coder branch, and a missing
# file here is the expected steady state until #493 merges, not an error.
# copy-compose job's matching "Check for job sourcing DDL file" step mirrors this
# guard on the scp side.
# Still placed BEFORE Step 3 (like every DDL step above): the new api image reads/
# writes these tables on every job-sourcing request the moment it serves traffic —
# a new image against an un-migrated DB would 500 on that surface. The reverse
# order is safe: applying this file while the OLD image still runs is a no-op for
# it (the tables are simply unused until #493's image ships).
# Idempotent: guarded CREATE TYPE (duplicate_object swallowed) + CREATE TABLE/INDEX
# IF NOT EXISTS + a seed INSERT ... ON CONFLICT DO NOTHING — safe to re-run on
# every deploy, forever.
# Source: apps/api/drizzle/manual/2026-08-07_job_sourcing.sql
JOB_SOURCING_FILE="/opt/crm/apps/api/drizzle/manual/2026-08-07_job_sourcing.sql"

if [ ! -f "$JOB_SOURCING_FILE" ]; then
  echo "::notice::Job sourcing DDL file not found at $JOB_SOURCING_FILE — task-job-sourcing-slice1 (PR #493) has not merged to main yet. Skipping this step; it applies automatically on a future deploy once the file is present."
else
  echo "==> Applying job sourcing module DDL (idempotent) — user=${PGUSER} db=${PGDB}"
  docker compose \
    -f docker-compose.prod.yml \
    -f docker-compose.ghcr.yml \
    --env-file .env.production \
    exec -T postgres \
    psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
    < "$JOB_SOURCING_FILE"
  echo "==> job sourcing module DDL applied successfully"
fi

# ── Step 2u: senior resume TEMPLATE module (idempotent, GUARDED) ──────────────────
# task-resume-template (PR #504): a resume is a Typst LAYOUT plus structured DATA,
# joined by a child-process render. This migration creates `senior_resumes` from
# scratch (two new enums — resume_extraction_status, resume_render_status — plus the
# table, its indexes, and the layout/template/pdf columns). PR #497 (an earlier,
# differently-shaped attempt at the same module) closed without merging and never
# wired anything into this file — there is nothing prior for this step to conflict
# or overlap with.
# Fully additive, no existing table/column touched, same shape as the telemetry/
# vacancies/job-sourcing module DDL above, not order-critical the way an enum-VALUE
# addition to an already-live enum is. GUARDED for the same reason as the blocks
# above — DevOps zone-of-write excludes apps/api/**, this wiring lands separately
# from the Coder branch, and a missing file here is the expected steady state until
# #504 merges, not an error. copy-compose job's matching "Check for senior resume
# template DDL file" step mirrors this guard on the scp side.
# Still placed BEFORE Step 3 (like every DDL step above): the new api image reads/
# writes senior_resumes on every resume request the moment it serves traffic — a new
# image against an un-migrated DB would 500 on that surface. The reverse order is
# safe: applying this file while the OLD image still runs is a no-op for it (the
# table/columns are simply unused until #504's image ships).
# Idempotent: guarded CREATE TYPE (duplicate_object swallowed) x2 + CREATE TABLE IF
# NOT EXISTS + ADD COLUMN IF NOT EXISTS x9 + CREATE INDEX IF NOT EXISTS x3 — safe to
# re-run on every deploy, forever (verified against the migration file itself, see
# this PR's description).
# Source: apps/api/drizzle/manual/2026-08-10_senior_resume_template.sql
SENIOR_RESUME_TEMPLATE_FILE="/opt/crm/apps/api/drizzle/manual/2026-08-10_senior_resume_template.sql"

if [ ! -f "$SENIOR_RESUME_TEMPLATE_FILE" ]; then
  echo "::notice::Senior resume template DDL file not found at $SENIOR_RESUME_TEMPLATE_FILE — task-resume-template (PR #504) has not merged to main yet. Skipping this step; it applies automatically on a future deploy once the file is present."
else
  echo "==> Applying senior resume template module DDL (idempotent) — user=${PGUSER} db=${PGDB}"
  docker compose \
    -f docker-compose.prod.yml \
    -f docker-compose.ghcr.yml \
    --env-file .env.production \
    exec -T postgres \
    psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
    < "$SENIOR_RESUME_TEMPLATE_FILE"
  echo "==> senior resume template module DDL applied successfully"
fi

# ── Step 2v: job source budgets columns + enums (idempotent, GUARDED) ─────────────
# task-vacancy-matching (PR #515, feature/vacancy-matching, draft): two new enums
# (job_source_budget_window, job_source_trigger_mode) + five columns on the existing
# job_sources table (budget_limit, budget_window, budget_used,
# budget_window_started_at, trigger_mode) plus a non-negative CHECK constraint on
# budget_used. Fully additive, no existing column altered — same shape as the
# job-sourcing/senior-resume module DDL above (Step 2s/2t/2u), not order-critical
# the way an enum-VALUE addition to an already-live enum is (Step 2r). GUARDED for
# the same reason as the blocks above — DevOps zone-of-write excludes apps/api/**,
# this wiring lands separately from the Coder branch, and a missing file here is the
# expected steady state until #515 merges, not an error. copy-compose job's matching
# "Check for job source budgets DDL file" step mirrors this guard on the scp side.
# Still placed BEFORE Step 3 (like every DDL step above): the new api image's job
# collector reads these columns BEFORE it goes to the network on every collection
# run the moment it serves traffic — a new image against an un-migrated DB would 500
# on that surface. The reverse order is safe: applying this file while the OLD image
# still runs is a no-op for it (the columns are simply unused until #515's image
# ships; every existing job_sources row keeps behaving exactly as it does today —
# budget_limit NULL = no published limit, trigger_mode 'SCHEDULED' = the daily cron).
# Idempotent: guarded CREATE TYPE (duplicate_object swallowed) x2 + ADD COLUMN IF NOT
# EXISTS x5 + guarded ADD CONSTRAINT (duplicate_object swallowed) — safe to re-run on
# every deploy, forever.
# Source: apps/api/drizzle/manual/2026-08-12_job_source_budgets.sql
JOB_SOURCE_BUDGETS_FILE="/opt/crm/apps/api/drizzle/manual/2026-08-12_job_source_budgets.sql"

if [ ! -f "$JOB_SOURCE_BUDGETS_FILE" ]; then
  echo "::notice::Job source budgets DDL file not found at $JOB_SOURCE_BUDGETS_FILE — task-vacancy-matching (PR #515) has not merged to main yet. Skipping this step; it applies automatically on a future deploy once the file is present."
else
  echo "==> Applying job source budgets DDL (idempotent) — user=${PGUSER} db=${PGDB}"
  docker compose \
    -f docker-compose.prod.yml \
    -f docker-compose.ghcr.yml \
    --env-file .env.production \
    exec -T postgres \
    psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
    < "$JOB_SOURCE_BUDGETS_FILE"
  echo "==> job source budgets DDL applied successfully"
fi

# ── Step 2w: admin-income drop-backfill COLUMN (idempotent, GUARDED) ──────────────
# task-admin-income-drop-backfill (PR #517): adds `source_income_transaction_id` (a
# nullable self-FK on `transactions`) — see the DDL file's own header for the full
# reasoning. Fully additive, no existing column touched — same shape as the
# job-sourcing/senior-resume/job-source-budgets module DDL above (Step 2s/2t/2u/2v),
# not order-critical the way an enum-VALUE addition to an already-live enum is
# (Step 2r). GUARDED for the same reason as the blocks above — DevOps zone-of-write
# excludes apps/api/**, this wiring lands separately from the Coder branch, and a
# missing file here is the expected steady state until #517 merges, not an error.
# copy-compose job's matching "Check for admin-income drop-backfill column DDL file"
# step mirrors this guard on the scp side.
#
# Placed BEFORE Step 3 (like every DDL step above): once the companion
# task-admin-income-payment-type-guard PR's code ships, the api reads this column on
# every transactions query — a new image against an un-migrated DB would error on
# that surface. The reverse order is safe: applying this file while the OLD image
# still runs is a no-op for it (the column is simply unused until that image ships).
#
# ORDER REQUIRED vs Step 2x immediately below (not merely "placement before Step
# 3"): the report file's `linked` CTE selects `source_income_transaction_id` from
# `transactions` — it errors with `column ... does not exist` if this step has not
# already created it. Step 2x is therefore placed directly after this one, never
# reordered ahead of it.
#
# Only 2 of PR #517's 3 files are wired (this one + Step 2x below) — the backfill
# itself (`2026-08-12_admin_income_drop_backfill_apply.sql`) is deliberately NOT
# wired; see scripts/devops/check-prod-ddl-wiring.py's KNOWN_NOT_WIRED entry for that
# file.
#
# Idempotent: ADD COLUMN IF NOT EXISTS — safe to re-run on every deploy, forever.
# Source: apps/api/drizzle/manual/2026-08-12_admin_income_drop_backfill_column.sql
ADMIN_INCOME_DROP_BACKFILL_COLUMN_FILE="/opt/crm/apps/api/drizzle/manual/2026-08-12_admin_income_drop_backfill_column.sql"

if [ ! -f "$ADMIN_INCOME_DROP_BACKFILL_COLUMN_FILE" ]; then
  echo "::notice::Admin-income drop-backfill column DDL file not found at $ADMIN_INCOME_DROP_BACKFILL_COLUMN_FILE — task-admin-income-drop-backfill (PR #517) has not merged to main yet. Skipping this step; it applies automatically on a future deploy once the file is present."
else
  echo "==> Applying admin-income drop-backfill column DDL (idempotent) — user=${PGUSER} db=${PGDB}"
  docker compose \
    -f docker-compose.prod.yml \
    -f docker-compose.ghcr.yml \
    --env-file .env.production \
    exec -T postgres \
    psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
    < "$ADMIN_INCOME_DROP_BACKFILL_COLUMN_FILE"
  echo "==> admin-income drop-backfill column DDL applied successfully"
fi

# ── Step 2x: admin-income drop-backfill REPORT (read-only, GUARDED, order-dependent on Step 2w) ──
# Step 2 of the 3-file sequence (see Step 2w above) — 100% read-only, no writes of
# any kind (proven by
# apps/api/src/finance/admin-income-drop-backfill.integration.spec.ts AC3: table row
# counts are identical before/after running it). Prints one RAISE NOTICE line per
# CANDIDATE/AMBIGUOUS income row plus a summary count — this step's own `psql`
# output streams straight into THIS SSH step's live log (this workflow's main
# deploy step does not set `capture_stdout`, unlike the dedicated drop-share-
# pending-parity summary step further down this job — no separate job-summary
# plumbing is needed for the owner to read it here).
#
# Runs on EVERY deploy once PR #517 merges, same as the column step above — it
# makes zero writes, so there is no reason to ever de-wire it; it is the owner's
# standing, always-current view of what the (still-unwired) backfill would do if
# applied.
#
# ORDER-DEPENDENT on Step 2w immediately above — see that step's own note: this
# file's `linked` CTE reads `source_income_transaction_id`, which Step 2w creates.
# Never reorder this step ahead of Step 2w.
#
# Idempotent (read-only, so trivially safe to re-run): makes no writes at all.
# Source: apps/api/drizzle/manual/2026-08-12_admin_income_drop_backfill_report.sql
ADMIN_INCOME_DROP_BACKFILL_REPORT_FILE="/opt/crm/apps/api/drizzle/manual/2026-08-12_admin_income_drop_backfill_report.sql"

if [ ! -f "$ADMIN_INCOME_DROP_BACKFILL_REPORT_FILE" ]; then
  echo "::notice::Admin-income drop-backfill report DDL file not found at $ADMIN_INCOME_DROP_BACKFILL_REPORT_FILE — task-admin-income-drop-backfill (PR #517) has not merged to main yet. Skipping this step; it applies automatically on a future deploy once the file is present."
else
  echo "==> Applying admin-income drop-backfill report DDL (read-only) — user=${PGUSER} db=${PGDB}"
  docker compose \
    -f docker-compose.prod.yml \
    -f docker-compose.ghcr.yml \
    --env-file .env.production \
    exec -T postgres \
    psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
    < "$ADMIN_INCOME_DROP_BACKFILL_REPORT_FILE"
  echo "==> admin-income drop-backfill report DDL applied successfully"
fi

# ── Step 2y: drop-obligation company-name snapshot COLUMN (idempotent, GUARDED) ───
# task-drop-sees-own-obligations (PR #523): adds `company_name_snapshot` (a
# nullable varchar on `transactions`) — freezes `projects.companyName` onto a
# DROP_PENDING_PAYOUT/PAYOUT_DROP obligation row at booking time so a later
# project rename cannot retroactively rewrite what a drop already read as the
# history of money booked under the OLD name. See the DDL file's own header for
# the full reasoning. Fully additive, no existing column touched — same shape as
# the job-sourcing/senior-resume/job-source-budgets/admin-income-backfill module
# DDL above (Step 2s-2w), not order-critical the way an enum-VALUE addition to an
# already-live enum is (Step 2r). GUARDED for the same reason as the blocks above
# — DevOps zone-of-write excludes apps/api/**, this wiring lands separately from
# the Coder branch, and a missing file here is the expected steady state until
# #523 merges, not an error. copy-compose job's matching "Check for drop-
# obligation company-name snapshot DDL file" step mirrors this guard on the scp
# side.
#
# Placed BEFORE Step 3 (like every DDL step above): once #523's code ships, every
# `bookCompanyObligations` call writes this column on the DROP/senior obligation
# rows it books — a new api image against an un-migrated DB would error on that
# write. The reverse order is safe: applying this file while the OLD image still
# runs is a no-op for it (the column is simply unused until that image ships).
#
# ORDER REQUIRED vs Step 2z immediately below (not merely "placement before Step
# 3"): `non_deleted_transactions` (Step 2p, above) is `CREATE OR REPLACE VIEW ...
# SELECT *` — Postgres does NOT retroactively add a newly-created base-table
# column to an EXISTING view, even a `SELECT *` one, until the view is explicitly
# re-applied. Step 2p already ran earlier in this script, before this column
# existed, so on the deploy where #523 first merges, its rebuild of the view was
# against the OLD column list. Step 2z immediately below re-applies that same view
# file a second time, now that the column exists, so every finance read that goes
# through the view (getAdminBalance / getSeniorBalance / getTotalEarned /
# getOwnSalaryStatus, and now getDropSelfIncomes) sees `company_name_snapshot`
# starting with THIS deploy, not the next one — this is exactly the
# `error: column "company_name_snapshot" does not exist` failure the migration's
# own author hit and documented while verifying this file on crm_qa (see the DDL
# file's header). Never reorder this step after Step 2z.
#
# Idempotent: ADD COLUMN IF NOT EXISTS — safe to re-run on every deploy, forever.
# Source: apps/api/drizzle/manual/2026-08-12_drop_obligation_company_name_snapshot.sql
DROP_OBLIGATION_COMPANY_NAME_SNAPSHOT_FILE="/opt/crm/apps/api/drizzle/manual/2026-08-12_drop_obligation_company_name_snapshot.sql"

if [ ! -f "$DROP_OBLIGATION_COMPANY_NAME_SNAPSHOT_FILE" ]; then
  echo "::notice::Drop-obligation company-name snapshot DDL file not found at $DROP_OBLIGATION_COMPANY_NAME_SNAPSHOT_FILE — task-drop-sees-own-obligations (PR #523) has not merged to main yet. Skipping this step; it applies automatically on a future deploy once the file is present."
else
  echo "==> Applying drop-obligation company-name snapshot DDL (idempotent) — user=${PGUSER} db=${PGDB}"
  docker compose \
    -f docker-compose.prod.yml \
    -f docker-compose.ghcr.yml \
    --env-file .env.production \
    exec -T postgres \
    psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
    < "$DROP_OBLIGATION_COMPANY_NAME_SNAPSHOT_FILE"
  echo "==> drop-obligation company-name snapshot DDL applied successfully"
fi

# ── Step 2z: non_deleted_transactions VIEW re-apply #2 (idempotent, GUARDED, order-dependent on Step 2y) ──
# Companion step required by Step 2y's own DDL file header (see
# apps/api/drizzle/manual/2026-08-12_drop_obligation_company_name_snapshot.sql).
# This is the SAME view file Step 2p already applies earlier in this script — that
# first application ran BEFORE Step 2y existed as a step, so on the deploy where
# #523 first merges, Step 2p's rebuild was against `transactions` WITHOUT
# `company_name_snapshot` yet (see Step 2y's own comment above for the failure this
# avoids). Re-applying the identical file here, immediately after Step 2y adds the
# column, is what actually closes that gap on THIS deploy rather than the next one
# — `CREATE OR REPLACE VIEW` is a full rebuild against the table's CURRENT column
# list, not an incremental diff, so running it twice in one deploy is redundant
# work, not a correctness risk.
#
# GUARDED on the SAME file-presence check as Step 2y (not the view file's own
# presence, which is unconditionally true already, per Step 2p above) — this
# second application only has a reason to exist once #523's column file is also
# present; skip it whenever Step 2y skips, for the same reason.
#
# ORDER-DEPENDENT on Step 2y immediately above — never reorder this step ahead of
# it. Idempotent otherwise: `CREATE OR REPLACE VIEW`, same as Step 2p.
# Source: apps/api/drizzle/manual/2026-08-03_non_deleted_transactions_view.sql
NON_DELETED_TX_VIEW_REAPPLY_FILE="/opt/crm/apps/api/drizzle/manual/2026-08-03_non_deleted_transactions_view.sql"

if [ ! -f "$DROP_OBLIGATION_COMPANY_NAME_SNAPSHOT_FILE" ]; then
  echo "::notice::Skipping non_deleted_transactions view re-apply — task-drop-sees-own-obligations (PR #523) has not merged to main yet, so there is no new column for it to pick up early. Step 2p above already keeps the view current for every other column."
elif [ ! -f "$NON_DELETED_TX_VIEW_REAPPLY_FILE" ]; then
  echo "::notice::non_deleted_transactions view DDL file not found at $NON_DELETED_TX_VIEW_REAPPLY_FILE — unexpected, since Step 2p above already found it. Skipping this step."
else
  echo "==> Re-applying non_deleted_transactions view DDL to pick up company_name_snapshot (idempotent) — user=${PGUSER} db=${PGDB}"
  docker compose \
    -f docker-compose.prod.yml \
    -f docker-compose.ghcr.yml \
    --env-file .env.production \
    exec -T postgres \
    psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
    < "$NON_DELETED_TX_VIEW_REAPPLY_FILE"
  echo "==> non_deleted_transactions view DDL re-applied successfully"
fi

# ── Step 2aa: sender/receiver invariant CHECK constraint on transactions (idempotent, GUARDED) ──
# backlog A-2 (PR #568, fix/sender-receiver-invariant): adds
# `ck_transactions_sender_ne_receiver CHECK (sender_id <> receiver_id)` — no
# invariant anywhere previously forbade a `transactions` row that pays a user
# to themselves. Owner confirmed zero existing `sender_id = receiver_id` rows
# on prod (checked twice, 2026-08-17) before this migration was written. See
# the DDL file's own header for the full reasoning, including why `<>` (not
# `IS DISTINCT FROM`, which would wrongly reject the common both-NULL row).
# Fully additive — one new CHECK constraint, no existing column touched — same
# shape as the job-sourcing/senior-resume/job-source-budgets/admin-income-
# backfill/drop-obligation-snapshot module DDL above (Step 2s-2y), not order-
# critical the way an enum-VALUE addition to an already-live enum is (Step 2r):
# the app-layer guard (`selfPayError`, added in the same PR) already rejects a
# self-pay write before it reaches the DB, so this constraint is defense-in-
# depth regardless of whether the old or new api image is running when it
# lands. GUARDED for the same reason as the blocks above — DevOps zone-of-write
# excludes apps/api/**, this wiring lands separately from the Coder branch, and
# a missing file here is the expected steady state until #568 merges, not an
# error. copy-compose job's matching "Check for sender/receiver invariant DDL
# file" step mirrors this guard on the scp side.
#
# The DDL file's own DO block already runs with the equivalent of
# ON_ERROR_STOP semantics baked into its validation query (it RAISE EXCEPTIONs
# loudly before attempting the ADD CONSTRAINT if any bad row exists) — but that
# only matters if psql ITSELF is told to stop on error. `-v ON_ERROR_STOP=1` is
# passed explicitly below, same as every apply step in this job: verified by
# hand on a scratch DB that without it, psql keeps going after the RAISE
# EXCEPTION, the second statement (ADD CONSTRAINT) then also fails with its own
# "violated by some row" error, and the whole script still exits 0 — a silent
# no-op that would report deploy success on prod while adding no constraint at
# all. WITH the flag, the same broken input stops at the first error (exit 3),
# never reaching the second statement. This file's idempotency (safe to re-run
# forever once the constraint exists) was verified the same way, by hand, on a
# clean scratch DB: run twice, second run is a no-op, constraint definition
# matches `CHECK ((sender_id <> receiver_id))` via `pg_get_constraintdef`.
# Source: apps/api/drizzle/manual/2026-08-18_sender_receiver_invariant.sql
SENDER_RECEIVER_INVARIANT_FILE="/opt/crm/apps/api/drizzle/manual/2026-08-18_sender_receiver_invariant.sql"

if [ ! -f "$SENDER_RECEIVER_INVARIANT_FILE" ]; then
  echo "::notice::Sender/receiver invariant DDL file not found at $SENDER_RECEIVER_INVARIANT_FILE — task-sender-receiver-invariant (PR #568) has not merged to main yet. Skipping this step; it applies automatically on a future deploy once the file is present."
else
  echo "==> Applying sender/receiver invariant DDL (idempotent) — user=${PGUSER} db=${PGDB}"
  docker compose \
    -f docker-compose.prod.yml \
    -f docker-compose.ghcr.yml \
    --env-file .env.production \
    exec -T postgres \
    psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
    < "$SENDER_RECEIVER_INVARIANT_FILE"
  echo "==> sender/receiver invariant DDL applied successfully"
fi

# ── Step 2ab: SENIOR_INCOME / DROP_INCOME idempotency-key partial unique indexes (idempotent) ──
# backlog 73/A-3 (fix/senior-drop-income-idempotency, security review PR #587):
# `createSeniorIncome`/`createDropIncome` had no idempotency key — a double-click
# / network retry could create a second SENIOR_INCOME/DROP_INCOME row, which an
# ACCOUNTANT could independently validate and bundle into one payout request,
# doubling incomeAmount/payableAmount and the company obligation booked off it.
# Mirrors the ADMIN_INCOME contract (Step 2c above, PR #367, security-review MED-1)
# 1:1: `uq_transactions_senior_income_idempotency_key` /
# `uq_transactions_drop_income_idempotency_key`, two partial unique indexes on
# transactions(idempotency_key) scoped to their own `type`.
#
# UNCONDITIONAL (like Step 2c, not the guarded blocks above): the migration file
# lands in the SAME PR as this wiring, so it is unconditionally present in the
# checkout by construction — no cross-PR merge-order race to guard against.
# Idempotent: ADD COLUMN IF NOT EXISTS (no-op — the shared idempotency_key column
# already exists) + CREATE UNIQUE INDEX IF NOT EXISTS, safe to re-run on repeated
# deploys, same shape as every other index-only DDL file in this job.
# Source: apps/api/drizzle/manual/2026-08-19_senior_drop_income_idempotency_index.sql
SENIOR_DROP_INCOME_IDEMPOTENCY_FILE="/opt/crm/apps/api/drizzle/manual/2026-08-19_senior_drop_income_idempotency_index.sql"

if [ ! -f "$SENIOR_DROP_INCOME_IDEMPOTENCY_FILE" ]; then
  echo "ERROR: DDL file not found at $SENIOR_DROP_INCOME_IDEMPOTENCY_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/ /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying senior/drop income idempotency index DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$SENIOR_DROP_INCOME_IDEMPOTENCY_FILE"
echo "==> senior/drop income idempotency index DDL applied successfully"

# ── Step 2ac: pending_obligations.payout_request_id durable payout link (idempotent) ──
# backlog 74/B-1 (fix/settle-payout-link): `settleByCompany` flips a cascade-
# booked obligation's source IOU row in place and deliberately resets ITS
# `transactions.payout_request_id` to NULL on the flip (task-settle-in-place ADR
# — avoids bleeding a settled row into `autoCreateForPayout`'s aggregation / the
# `findOne` SENIOR_INCOME-by-payoutRequestId enrichment). `pending_obligations`
# never stored `payout_request_id` at all, so the only surviving link after
# settle was the self-referential `closing_transaction_id` — a payout's detail
# read (`findPayoutRequest`) silently dropped a settled obligation from its
# transactions list. This migration adds a SEPARATE, never-reset
# `payout_request_id` column on `pending_obligations`, stamped once at booking
# time (`bookCompanyObligations`), plus a backfill for still-PENDING rows.
# Informational only — nothing branches on this column's value the way
# `drop_cascade_origin` does, so no fail-safe-default concern.
#
# UNCONDITIONAL (like Step 2ab/2c above): the migration file lands in the SAME
# PR as this wiring, so it is unconditionally present in the checkout by
# construction — no cross-PR merge-order race to guard against. Idempotent:
# ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS + a backfill UPDATE that
# only ever touches rows still matching `payout_request_id IS NULL`, safe to
# re-run on every deploy. `-v ON_ERROR_STOP=1` passed explicitly, same as every
# apply step in this job (backlog 141, PR #581's guard verifies this repo-wide).
# Source: apps/api/drizzle/manual/2026-08-21_pending_obligations_payout_request_id.sql
PENDING_OBLIGATIONS_PAYOUT_LINK_FILE="/opt/crm/apps/api/drizzle/manual/2026-08-21_pending_obligations_payout_request_id.sql"

if [ ! -f "$PENDING_OBLIGATIONS_PAYOUT_LINK_FILE" ]; then
  echo "ERROR: DDL file not found at $PENDING_OBLIGATIONS_PAYOUT_LINK_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/ /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying pending_obligations payout-link DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$PENDING_OBLIGATIONS_PAYOUT_LINK_FILE"
echo "==> pending_obligations payout-link DDL applied successfully"

# ── Step 2ad: settled-amount snapshot columns on transactions (idempotent) ──
# task-settled-amount-snapshot (Task 1 of the paid-transaction-edit-cascade
# decomposition — docs/architecture/2026-08-22-paid-transaction-edit-cascade.md,
# AC3): adds `transactions.settled_amount` (numeric 18,6, MONOTONIC
# accumulator of every actual payout this row has settled) /
# `settled_currency` (the currency of that accumulator — a DROP
# obligation can settle in a currency other than its own USDT) /
# `settled_share_percent` (a snapshot of whichever share-percent
# column was nulled at THIS flip). Written by `settleByCompany`
# (pending-settlement.service.ts) at the SAME flip that already
# nulls senior_share_percent/drop_share_percent. Fully additive —
# three new nullable columns, no existing column touched, no
# backfill — same shape as every module-DDL block above (Step
# 2s-2ac). No reader of these columns exists yet (the cascade that
# needs them is a LATER task in the same decomposition) — this
# step alone is safe to ship ahead of that code.
#
# UNCONDITIONAL (like Step 2ab/2ac above): the migration file lands
# in the SAME PR as this wiring, so it is unconditionally present
# in the checkout by construction — no cross-PR merge-order race to
# guard against. Idempotent: ADD COLUMN IF NOT EXISTS × 3, safe to
# re-run on every deploy, forever. `-v ON_ERROR_STOP=1` passed
# explicitly, same as every apply step in this job.
# Source: apps/api/drizzle/manual/2026-08-22_settled_amount_snapshot.sql
SETTLED_AMOUNT_SNAPSHOT_FILE="/opt/crm/apps/api/drizzle/manual/2026-08-22_settled_amount_snapshot.sql"

if [ ! -f "$SETTLED_AMOUNT_SNAPSHOT_FILE" ]; then
  echo "ERROR: DDL file not found at $SETTLED_AMOUNT_SNAPSHOT_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/ /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying settled-amount snapshot DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$SETTLED_AMOUNT_SNAPSHOT_FILE"
echo "==> settled-amount snapshot DDL applied successfully"

# ── Step 2ae: non_deleted_transactions VIEW re-apply #3 (idempotent, order-dependent on Step 2ad) ──
# Companion step required by Step 2ad's own DDL file header (see
# apps/api/drizzle/manual/2026-08-22_settled_amount_snapshot.sql) —
# same gotcha, same fix, as Step 2z's re-apply after Step 2y
# (2026-08-12_drop_obligation_company_name_snapshot.sql): this is
# the SAME view file Step 2p already applies earlier in this
# script, but that first application ran BEFORE Step 2ad's three
# new columns existed on `transactions`, so `CREATE OR REPLACE
# VIEW ... SELECT *` picked up the OLD column list. Re-applying the
# identical file here, immediately after Step 2ad adds the
# columns, is what closes that gap on THIS deploy rather than the
# next one.
#
# UNCONDITIONAL — Step 2ad above is itself unconditional (this
# migration lands in the same PR), so there is no "skip if the
# column file is absent" branch needed here, unlike Step 2z's
# cross-PR guard.
#
# ORDER-DEPENDENT on Step 2ad immediately above — never reorder
# this step ahead of it. Idempotent otherwise: `CREATE OR REPLACE
# VIEW`, same as Step 2p/2z.
# Source: apps/api/drizzle/manual/2026-08-03_non_deleted_transactions_view.sql
NON_DELETED_TX_VIEW_REAPPLY_3_FILE="/opt/crm/apps/api/drizzle/manual/2026-08-03_non_deleted_transactions_view.sql"

if [ ! -f "$NON_DELETED_TX_VIEW_REAPPLY_3_FILE" ]; then
  echo "::notice::non_deleted_transactions view DDL file not found at $NON_DELETED_TX_VIEW_REAPPLY_3_FILE — unexpected, since Step 2p above already found it. Skipping this step."
else
  echo "==> Re-applying non_deleted_transactions view DDL to pick up settled_amount/settled_currency/settled_share_percent (idempotent) — user=${PGUSER} db=${PGDB}"
  docker compose \
    -f docker-compose.prod.yml \
    -f docker-compose.ghcr.yml \
    --env-file .env.production \
    exec -T postgres \
    psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
    < "$NON_DELETED_TX_VIEW_REAPPLY_3_FILE"
  echo "==> non_deleted_transactions view DDL re-applied successfully"
fi

# ── Step 2af: invoice_signatures voided_at/amount_snapshot/currency_snapshot (idempotent) ──
# task-invoice-signature-integrity (backlog 183, PR #600): a PAID
# transaction's invoice PDF is a legal artifact bound to specific
# bytes and cannot be silently re-rendered when its amount is
# edited. Editing the amount now VOIDS the existing invoice
# (document soft-deleted, invoice_signatures rows stamped
# voided_at — never deleted, an audit trail) instead of
# re-rendering it; a fresh invoice is generated the next time the
# transaction reaches PAID. `voided_at` replaces the blanket
# UNIQUE(transaction_id, signer_role) constraint with a partial
# index scoped to voided_at IS NULL (one ACTIVE signature per
# role, unlimited history). `amount_snapshot`/`currency_snapshot`
# freeze what the counterparty actually signed, so the public
# /verify endpoint never surfaces a live, unconfirmed amount.
#
# UNCONDITIONAL (like Step 2ac/2ab/2c above): the migration file
# lands in the SAME PR as this wiring, so it is unconditionally
# present in the checkout by construction — no cross-PR
# merge-order race to guard against. Idempotent: ADD COLUMN IF
# NOT EXISTS + DROP CONSTRAINT IF EXISTS + CREATE UNIQUE INDEX IF
# NOT EXISTS, safe to re-run on every deploy. `-v ON_ERROR_STOP=1`
# passed explicitly, same as every apply step in this job.
# Source: apps/api/drizzle/manual/2026-08-22_invoice_signature_void_and_snapshot.sql
INVOICE_SIGNATURE_VOID_SNAPSHOT_FILE="/opt/crm/apps/api/drizzle/manual/2026-08-22_invoice_signature_void_and_snapshot.sql"

if [ ! -f "$INVOICE_SIGNATURE_VOID_SNAPSHOT_FILE" ]; then
  echo "ERROR: DDL file not found at $INVOICE_SIGNATURE_VOID_SNAPSHOT_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/ /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying invoice-signature void/snapshot DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$INVOICE_SIGNATURE_VOID_SNAPSHOT_FILE"
echo "==> invoice-signature void/snapshot DDL applied successfully"

# ── Step 2ag: approvals table + approval_status enum (idempotent) ──
# task-approvals-foundation: the foundation registry for
# "actions touching an employee's money or responsibility do not
# take effect until they agree in the CRM" (see
# docs/superpowers/specs/2026-09-01-notifications-and-confirmations-
# design.md position 3). One brand-new table + one new enum —
# fully additive, no existing table/column touched. Ships empty
# (no caller wires a real subject yet — a later position in the
# same plan), so this apply carries zero data risk on prod.
#
# UNCONDITIONAL (like Step 2af/2ac/2ab above): the migration file
# lands in the SAME branch as this wiring, so it is
# unconditionally present in the checkout by construction — no
# cross-PR merge-order race to guard against. Idempotent: guarded
# `CREATE TYPE` (duplicate_object swallowed) + `CREATE TABLE IF
# NOT EXISTS` + `CREATE INDEX/UNIQUE INDEX IF NOT EXISTS` + guarded
# `ADD CONSTRAINT` DO blocks (duplicate_object swallowed) — safe
# to re-run on every deploy, forever. `-v ON_ERROR_STOP=1` passed
# explicitly, same as every apply step in this job.
# Source: apps/api/drizzle/manual/2026-09-01_approvals.sql
APPROVALS_FOUNDATION_FILE="/opt/crm/apps/api/drizzle/manual/2026-09-01_approvals.sql"

if [ ! -f "$APPROVALS_FOUNDATION_FILE" ]; then
  echo "ERROR: DDL file not found at $APPROVALS_FOUNDATION_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/ /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying approvals foundation DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$APPROVALS_FOUNDATION_FILE"
echo "==> approvals foundation DDL applied successfully"

# ── Step 2ah: projects.status column + visible_projects view (idempotent) ──
# task-project-draft-status: position 4 of
# docs/superpowers/specs/2026-09-01-notifications-and-confirmations-
# design.md §4.2/§6 — a project starts DRAFT and only becomes ACTIVE
# once every invited approver confirms. Additive NOT NULL column
# with DEFAULT 'ACTIVE' — every pre-existing project backfills
# atomically as part of the ADD COLUMN statement (no separate
# per-row UPDATE, so there is no partial-success state to guard
# against), plus a CREATE OR REPLACE VIEW. Zero data risk.
#
# UNCONDITIONAL (like Step 2ag/2af/2ac above): the migration file
# lands in the SAME branch as this wiring, so it is
# unconditionally present in the checkout by construction — no
# cross-PR merge-order race to guard against. Idempotent: guarded
# `CREATE TYPE` (duplicate_object swallowed) + `ADD COLUMN IF NOT
# EXISTS` (native Postgres syntax) + `CREATE OR REPLACE VIEW` —
# safe to re-run on every deploy, forever. `-v ON_ERROR_STOP=1`
# passed explicitly, same as every apply step in this job — this
# migration's own VERIFY block (see the .sql file) additionally
# checks the post-migration row counts by hand; that check is not
# automated here because the same "no per-row failure mode"
# property that makes automation unnecessary is what this comment
# is documenting.
# Source: apps/api/drizzle/manual/2026-09-02_project_status.sql
PROJECT_STATUS_FILE="/opt/crm/apps/api/drizzle/manual/2026-09-02_project_status.sql"

if [ ! -f "$PROJECT_STATUS_FILE" ]; then
  echo "ERROR: DDL file not found at $PROJECT_STATUS_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/ /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying project status DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$PROJECT_STATUS_FILE"
echo "==> project status DDL applied successfully"

# Source: apps/api/drizzle/manual/2026-09-01_user_emails.sql
USER_EMAILS_FILE="/opt/crm/apps/api/drizzle/manual/2026-09-01_user_emails.sql"

if [ ! -f "$USER_EMAILS_FILE" ]; then
  echo "ERROR: DDL file not found at $USER_EMAILS_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying user_emails DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$USER_EMAILS_FILE"
echo "==> user_emails DDL applied successfully"

# ── task-user-emails-invite: user_email_invites table + user_emails.google_id column ──
# PR #623 position 2 continued (spec-reviewer SPEC-H-1): PERSONAL
# rows could never actually become a login method — this table +
# column are what let the invite-accept branch of
# GET /api/auth/google/callback set `can_login = true`. Pure
# additive (nullable column, brand-new table) — no backfill, no
# fail-loud verify block needed (see the file's own header).
# Source: apps/api/drizzle/manual/2026-09-02_user_email_invites.sql
USER_EMAIL_INVITES_FILE="/opt/crm/apps/api/drizzle/manual/2026-09-02_user_email_invites.sql"

if [ ! -f "$USER_EMAIL_INVITES_FILE" ]; then
  echo "ERROR: DDL file not found at $USER_EMAIL_INVITES_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying user_email_invites DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$USER_EMAIL_INVITES_FILE"
echo "==> user_email_invites DDL applied successfully"

# ── task-pending-share: pending senior share columns (idempotent) ──
# task-pending-share (position 5, design spec §4.3): two additive
# nullable columns — a proposed new SENIOR share % (project
# override OR the person's own base default) sits next to the
# active column while the affected senior has not yet confirmed
# it. Zero data risk: nothing currently running reads either
# column yet. Idempotent: `ADD COLUMN IF NOT EXISTS` (native
# Postgres syntax) — safe to re-run on every deploy, forever.
# `-v ON_ERROR_STOP=1` passed explicitly, same as every apply
# step in this job.
# Source: apps/api/drizzle/manual/2026-09-03_pending_senior_share.sql
PENDING_SENIOR_SHARE_FILE="/opt/crm/apps/api/drizzle/manual/2026-09-03_pending_senior_share.sql"

if [ ! -f "$PENDING_SENIOR_SHARE_FILE" ]; then
  echo "ERROR: DDL file not found at $PENDING_SENIOR_SHARE_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying pending senior share DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$PENDING_SENIOR_SHARE_FILE"
echo "==> pending senior share DDL applied successfully"

# ── task-648-fix-round-1 (SR-H-1): approval_status + CANCELLED ──
# One new enum value on the existing `approval_status` type — no
# column/table touched, nothing reads it until this same PR's
# code ships. Idempotent: `ALTER TYPE … ADD VALUE IF NOT EXISTS`
# — safe to re-run on every deploy, forever.
# Source: apps/api/drizzle/manual/2026-09-04_approval_status_cancelled.sql
APPROVAL_STATUS_CANCELLED_FILE="/opt/crm/apps/api/drizzle/manual/2026-09-04_approval_status_cancelled.sql"

if [ ! -f "$APPROVAL_STATUS_CANCELLED_FILE" ]; then
  echo "ERROR: DDL file not found at $APPROVAL_STATUS_CANCELLED_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying approval_status CANCELLED DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$APPROVAL_STATUS_CANCELLED_FILE"
echo "==> approval_status CANCELLED DDL applied successfully"

# ── task-notification-types-producers: notification subjects ──
# Five additive nullable columns + one PARTIAL unique index on
# `notifications`. No backfill, no rewrite: the three pre-existing
# notification types keep NULL in every new column, which is the
# correct historical fact. Idempotent: `ADD COLUMN IF NOT EXISTS`
# + `CREATE UNIQUE INDEX IF NOT EXISTS` — safe to re-run forever.
# Source: apps/api/drizzle/manual/2026-09-07_notification_subjects.sql
NOTIFICATION_SUBJECTS_FILE="/opt/crm/apps/api/drizzle/manual/2026-09-07_notification_subjects.sql"

if [ ! -f "$NOTIFICATION_SUBJECTS_FILE" ]; then
  echo "ERROR: DDL file not found at $NOTIFICATION_SUBJECTS_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying notification subject columns DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$NOTIFICATION_SUBJECTS_FILE"
echo "==> notification subject columns DDL applied successfully"

# ── task-notification-email-delivery: email outbox ──
# A NEW table plus its enum type and two indexes. Nothing is
# backfilled and no deployed code touches it until this PR's image
# ships. Idempotent: `CREATE TABLE IF NOT EXISTS` +
# `CREATE INDEX IF NOT EXISTS` + a DO-block guard on the enum
# (Postgres has no `CREATE TYPE IF NOT EXISTS`) — safe to re-run
# forever.
# Source: apps/api/drizzle/manual/2026-09-12_notification_emails.sql
NOTIFICATION_EMAILS_FILE="/opt/crm/apps/api/drizzle/manual/2026-09-12_notification_emails.sql"

if [ ! -f "$NOTIFICATION_EMAILS_FILE" ]; then
  echo "ERROR: DDL file not found at $NOTIFICATION_EMAILS_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying notification email outbox DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$NOTIFICATION_EMAILS_FILE"
echo "==> notification email outbox DDL applied successfully"

# ── task-notification-email-delivery: channel preferences ──
# A NEW table holding only the DEVIATION from the default (absence
# of a row means "email on"). Nothing backfilled. Idempotent:
# `CREATE TABLE IF NOT EXISTS` + `CREATE UNIQUE INDEX IF NOT
# EXISTS`.
# Source: apps/api/drizzle/manual/2026-09-12_notification_preferences.sql
NOTIFICATION_PREFERENCES_FILE="/opt/crm/apps/api/drizzle/manual/2026-09-12_notification_preferences.sql"

if [ ! -f "$NOTIFICATION_PREFERENCES_FILE" ]; then
  echo "ERROR: DDL file not found at $NOTIFICATION_PREFERENCES_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying notification preferences DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$NOTIFICATION_PREFERENCES_FILE"
echo "==> notification preferences DDL applied successfully"

# ── task-notifications-followups-api: STALE skip reason ──
# One new enum label on `notification_email_skip_reason`. No new
# column, no new table. Idempotent: `ALTER TYPE … ADD VALUE IF NOT
# EXISTS` — safe to re-run forever.
# Source: apps/api/drizzle/manual/2026-09-19_notification_email_skip_stale.sql
NOTIFICATION_EMAIL_SKIP_STALE_FILE="/opt/crm/apps/api/drizzle/manual/2026-09-19_notification_email_skip_stale.sql"

if [ ! -f "$NOTIFICATION_EMAIL_SKIP_STALE_FILE" ]; then
  echo "ERROR: DDL file not found at $NOTIFICATION_EMAIL_SKIP_STALE_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying notification email STALE skip reason DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$NOTIFICATION_EMAIL_SKIP_STALE_FILE"
echo "==> notification email STALE skip reason DDL applied successfully"

# ── task-i18n-stage2 (Task 3, §4.1): interface language per user ──
# ONE new column (`locale`) backed by a NEW two-value enum
# (`user_locale`) on `users`. Idempotent: the enum guard checks
# `pg_type` first, the column uses `ADD COLUMN IF NOT EXISTS`.
# Source: apps/api/drizzle/manual/2026-09-20_user_locale.sql
USER_LOCALE_FILE="/opt/crm/apps/api/drizzle/manual/2026-09-20_user_locale.sql"

if [ ! -f "$USER_LOCALE_FILE" ]; then
  echo "ERROR: DDL file not found at $USER_LOCALE_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying user locale DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$USER_LOCALE_FILE"
echo "==> user locale DDL applied successfully"

# ── server-text PR3: company-account counterparty label → COMPANY code ──
# Idempotent data migration; fails loud (RAISE EXCEPTION under
# ON_ERROR_STOP=1) if any row still carries the old prose marker.
# Source: apps/api/drizzle/manual/2026-10-03_company_account_label_code.sql
COMPANY_LABEL_CODE_FILE="/opt/crm/apps/api/drizzle/manual/2026-10-03_company_account_label_code.sql"

if [ ! -f "$COMPANY_LABEL_CODE_FILE" ]; then
  echo "ERROR: migration file not found at $COMPANY_LABEL_CODE_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying company-account label code migration (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$COMPANY_LABEL_CODE_FILE"
echo "==> company-account label code migration applied successfully"

# ── vacancy sourcing v1: schema DDL ──
# Source: apps/api/drizzle/manual/2026-10-05_vacancy_sourcing_schema.sql
VACANCY_SCHEMA_FILE="/opt/crm/apps/api/drizzle/manual/2026-10-05_vacancy_sourcing_schema.sql"

if [ ! -f "$VACANCY_SCHEMA_FILE" ]; then
  echo "ERROR: DDL file not found at $VACANCY_SCHEMA_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying vacancy sourcing schema DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$VACANCY_SCHEMA_FILE"
echo "==> vacancy sourcing schema DDL applied successfully"

# ── vacancy sourcing v1: sources seed ──
# Source: apps/api/drizzle/manual/2026-10-05_vacancy_sources_seed.sql
VACANCY_SEED_FILE="/opt/crm/apps/api/drizzle/manual/2026-10-05_vacancy_sources_seed.sql"

if [ ! -f "$VACANCY_SEED_FILE" ]; then
  echo "ERROR: DDL file not found at $VACANCY_SEED_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying vacancy sourcing sources seed (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$VACANCY_SEED_FILE"
echo "==> vacancy sourcing sources seed applied successfully"

# ── meeting recorder integration DDL ──
# Source: apps/api/drizzle/manual/2026-10-07_meeting_recorder_integration.sql
MEETING_RECORDER_INTEGRATION_FILE="/opt/crm/apps/api/drizzle/manual/2026-10-07_meeting_recorder_integration.sql"

if [ ! -f "$MEETING_RECORDER_INTEGRATION_FILE" ]; then
  echo "ERROR: DDL file not found at $MEETING_RECORDER_INTEGRATION_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying meeting recorder integration DDL — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$MEETING_RECORDER_INTEGRATION_FILE"
echo "==> meeting recorder integration DDL applied successfully"

# ── multipart salary: PREPARE while the previous API may still serve ──
# Applied here, BEFORE the privilege grants below, so the relation it creates
# (salary_month_initializations) is covered by them on a fresh database.
# Adds salary_origin + the durable cron marker and backfills existing
# salary months, but DELIBERATELY keeps uq_transactions_salary_receiver_month.
# The previous API still uses that unique index as its ON CONFLICT
# arbiter. The breaking index replacement happens only after Step 3
# has swapped in the new API image.
MULTIPART_SALARY_PREPARE_FILE="/opt/crm/apps/api/drizzle/manual/2026-10-04_multiple_salary_transactions_prepare.sql"

if [ ! -f "$MULTIPART_SALARY_PREPARE_FILE" ]; then
  echo "ERROR: migration file not found at $MULTIPART_SALARY_PREPARE_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Preparing multipart salary schema (backward-compatible) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$MULTIPART_SALARY_PREPARE_FILE"
echo "==> multipart salary prepare migration applied successfully"

# ── job opportunities store: part 1 (enum types, tables, job_sources extension, FKs) ──
# MUST run strictly before part 2 (the indexes reference these tables).
# Bare `psql -v ON_ERROR_STOP=1 < file` (no `-1`): statement-level autocommit.

# Source: apps/api/drizzle/manual/2026-10-17_job_opportunities_store.sql
JOB_OPPORTUNITIES_STORE_FILE="/opt/crm/apps/api/drizzle/manual/2026-10-17_job_opportunities_store.sql"

if [ ! -f "$JOB_OPPORTUNITIES_STORE_FILE" ]; then
  echo "ERROR: DDL file not found at $JOB_OPPORTUNITIES_STORE_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying job opportunities store DDL (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$JOB_OPPORTUNITIES_STORE_FILE"
echo "==> job opportunities store DDL applied successfully"

# ── database privilege grants (r5 Task 1.3c) ──
# INVARIANT: every file in this script that creates a table, view or sequence is applied
# BEFORE this one. The multipart-salary PREPARE file (the last relation-creating file
# that used to sit after this point: it creates salary_month_initializations) was moved
# up in front of the job opportunities store block for exactly that reason; the store
# DDL and its indexes file precede this block. Files applied later are the activate file (it
# runs after the container swap by design; creates no relations) and the drop_cascade_origin
# marker SECOND PASS, a re-run of a file whose first application, and so its
# CREATE TABLE IF NOT EXISTS, is far above this block. The grants
# file names tables explicitly and fails on a missing one, so a fresh database ends the
# deploy with every relation granted by construction, not because production already
# has the tables. It is also BEFORE the append-only triggers file (r5 Task 1.3b,
# PR #1026), which attaches after the indexes below. One transaction, idempotent,
# re-applied on every deploy.
#
# The privileges check (r5 Task 1.3c) runs twice: once just before the container swap
# (fail-fast, old API still serving) and again as the LAST database step, after the
# marker second pass, so that the end state is what gets validated.
# Source: apps/api/drizzle/manual/2026-10-18_db_grants.sql
DB_GRANTS_FILE="/opt/crm/apps/api/drizzle/manual/2026-10-18_db_grants.sql"

if [ ! -f "$DB_GRANTS_FILE" ]; then
  echo "ERROR: DDL file not found at $DB_GRANTS_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying database privilege grants (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$DB_GRANTS_FILE"
echo "==> database privilege grants applied successfully"

# ── job opportunities store: part 2 (indexes, CREATE INDEX CONCURRENTLY) ──
# CONCURRENTLY cannot run inside a transaction block; this invocation has no
# `-1`/`--single-transaction`, so each statement autocommits and it is safe.
# The file's BEGIN is a plpgsql DO block, not a transaction.

# Source: apps/api/drizzle/manual/2026-10-17_job_opportunities_store_indexes.sql
JOB_OPPORTUNITIES_STORE_INDEXES_FILE="/opt/crm/apps/api/drizzle/manual/2026-10-17_job_opportunities_store_indexes.sql"

if [ ! -f "$JOB_OPPORTUNITIES_STORE_INDEXES_FILE" ]; then
  echo "ERROR: DDL file not found at $JOB_OPPORTUNITIES_STORE_INDEXES_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying job opportunities store indexes (CONCURRENTLY, idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$JOB_OPPORTUNITIES_STORE_INDEXES_FILE"
echo "==> job opportunities store indexes applied successfully"

# ── job queue append-only triggers (r5 Task 1.3b, PR #1026) ──
# Attach to the job_queue_* tables created by the store DDL above, so they MUST
# run after it. They also MUST run after the roles file (db_roles, applied earlier
# in this script): the triggers file's first statement raises undefined_object if
# crm_retention_owner / crm_app are absent, and crm_retention_owner OWNS the two
# retention functions it installs. The triggers file creates no relations, so it
# is allowed after the grants (check-prod-ddl-wiring.py GRANTS-AFTER-CREATORS).
# The catalog check follows the triggers; the privileges check (db_privileges_check)
# follows the catalog check and stays the last database step.

# Source: apps/api/drizzle/manual/2026-10-18_job_queue_append_only_triggers.sql
JOB_QUEUE_TRIGGERS_FILE="/opt/crm/apps/api/drizzle/manual/2026-10-18_job_queue_append_only_triggers.sql"

if [ ! -f "$JOB_QUEUE_TRIGGERS_FILE" ]; then
  echo "ERROR: DDL file not found at $JOB_QUEUE_TRIGGERS_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Applying job queue append-only triggers (idempotent) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$JOB_QUEUE_TRIGGERS_FILE"
echo "==> job queue append-only triggers applied successfully"

# Source: apps/api/drizzle/manual/2026-10-18_job_queue_append_only_check.sql
JOB_QUEUE_CHECK_FILE="/opt/crm/apps/api/drizzle/manual/2026-10-18_job_queue_append_only_check.sql"

if [ ! -f "$JOB_QUEUE_CHECK_FILE" ]; then
  echo "ERROR: DDL file not found at $JOB_QUEUE_CHECK_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Running job queue append-only catalog check (read-only) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$JOB_QUEUE_CHECK_FILE"
echo "==> job queue append-only catalog check passed"

# ── database privileges catalog check (r5 Task 1.3c) — read-only, FAILS THE DEPLOY ON DRIFT ──
# Not DDL: it signals drift with RAISE EXCEPTION, which psql turns into a non-zero exit
# ONLY under ON_ERROR_STOP=1 (without it the deploy would pass on a failed check).
# FIRST RUN: after every DDL that precedes the container swap (including the append-only
# triggers and their catalog check, PR #1026) and before `up -d` swaps the API, so a
# drift fails the deploy while the old API is still serving. A second, final run closes the
# script, after the post-cutover marker second pass.

# Source: apps/api/drizzle/manual/2026-10-18_db_privileges_check.sql
DB_PRIVILEGES_CHECK_FILE="/opt/crm/apps/api/drizzle/manual/2026-10-18_db_privileges_check.sql"

if [ ! -f "$DB_PRIVILEGES_CHECK_FILE" ]; then
  echo "ERROR: DDL file not found at $DB_PRIVILEGES_CHECK_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Running database privileges catalog check (read-only) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$DB_PRIVILEGES_CHECK_FILE"
echo "==> database privileges catalog check passed"

# ── Step 2zz (preflight, task-infra-aop-observation, security review
# PR #555 AOP-3): cloudflare-origin-pull-ca.pem must exist on THIS
# host BEFORE the container swap below. nginx/conf.d/crm.conf,
# landing.conf and default-server.conf all reference this exact
# path via ssl_client_certificate (Authenticated Origin Pulls,
# observation phase — docs/runbooks/origin-mtls-and-firewall.md
# §2а). It is a RUNTIME-mounted file (docker-compose.prod.yml's
# `/etc/nginx/certs:/etc/nginx/certs:ro` bind), not baked into the
# image — see crm.conf's own comment for why nginx/Dockerfile's
# build-time `nginx -t` gate cannot and does not catch this file
# being absent on any PARTICULAR host. The earliest nginx itself
# would notice a missing file is on container boot, which is
# AFTER `up -d --remove-orphans` below has already torn down the
# currently-running (working) nginx container — this preflight
# exists specifically so that failure surfaces HERE, with the
# old container still serving traffic, instead of as a
# post-swap outage the smoke test discovers seconds later.
# This is the SAME class of risk the two pre-existing origin
# certs (app.cheekycheese.tech.crt/key, cheekycheese.tech.crt/key)
# already carry — not new — but THOSE were already present on
# the host before this pipeline existed, so there was never a
# first-deploy gap for them the way there is for a cert the
# owner had to add manually as a one-off prerequisite step.
# Security review round 2 (PR #555, AOP-7): existence alone is NOT
# enough — a plain `-f` check passes on an empty file or an HTML
# error page just as happily as on a real certificate. This is
# the EXACT failure mode runbook §2а step 1 already warns about
# ("curl может отдать страницу ошибки со статусом 200") and
# already guards against there with a mandatory `openssl x509`
# check — this preflight now runs the same class of check, not
# just a weaker one. On a bad file nginx itself fails with
# `PEM_read_bio_X509_AUX() failed`, which `-f` alone would never
# catch. `command -v openssl` guards against a DIFFERENT failure
# mode this content check must not introduce: if `openssl` were
# ever absent from this host, an unconditional call would fail
# the deploy for a reason that has nothing to do with the
# certificate being bad — degrade to a warning in that case
# (the existence check above still ran and still hard-gates).
# Verified on all three shapes (good cert, empty file, HTML
# page) against a real `openssl x509 -noout -subject` — see
# PR #555's description for the exact exit codes.
CLOUDFLARE_AOP_CA_FILE="/etc/nginx/certs/cloudflare-origin-pull-ca.pem"
if [ ! -f "$CLOUDFLARE_AOP_CA_FILE" ]; then
  echo "ERROR: $CLOUDFLARE_AOP_CA_FILE not found on this VPS host."
  echo "nginx/conf.d/crm.conf, landing.conf and default-server.conf all"
  echo "reference this path via ssl_client_certificate (Authenticated"
  echo "Origin Pulls, observation phase — see"
  echo "docs/runbooks/origin-mtls-and-firewall.md §2а). nginx will fail"
  echo "to start without it. Fix: place the Cloudflare origin-pull CA at"
  echo "this exact path on the host (runbook §2а step 1) then re-run this"
  echo "deploy. Refusing to proceed with the container swap — the"
  echo "currently-running api/nginx containers are left as-is by THIS"
  echo "step (this does not cover the rarer path where Step 1 above has"
  echo "already reset the whole stack via 'down --remove-orphans' after a"
  echo "postgres/redis network conflict — see that step's own 2026-07-31"
  echo "incident comment; if that branch fired, nginx was already stopped"
  echo "before this preflight ever ran)."
  exit 1
fi
if command -v openssl >/dev/null 2>&1; then
  if ! openssl x509 -in "$CLOUDFLARE_AOP_CA_FILE" -noout -subject >/dev/null 2>&1; then
    echo "ERROR: $CLOUDFLARE_AOP_CA_FILE exists but is not a valid X.509"
    echo "certificate (openssl x509 -noout -subject failed on it). This is"
    echo "the same failure shape runbook §2а step 1 warns about — a plain"
    echo "curl can silently save an HTML error page (HTTP 200) instead of"
    echo "the real PEM, and nginx fails to start on such a file with"
    echo "PEM_read_bio_X509_AUX() failed. Fix: re-download per §2а step 1"
    echo "and re-run BOTH commands there (the download AND the openssl"
    echo "verification) before re-running this deploy. Refusing to proceed"
    echo "with the container swap — same untouched-containers caveat as"
    echo "the existence check above."
    exit 1
  fi
else
  echo "::warning::openssl not found on this host — skipped the certificate-content validation (existence check above still passed)."
fi
echo "==> Preflight OK: $CLOUDFLARE_AOP_CA_FILE present on host and validated as a real certificate"

# ── Step 3: start / update api + nginx with new GHCR images ──────────────────────
# DDL is already applied — new api image will see the columns and indexes.
# --remove-orphans cleans up any containers from old service names.
echo "==> Starting / updating api and nginx (no-rebuild — GHCR images)"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  up -d --remove-orphans

# Multipart salary activation removes the unique index the PREVIOUS
# API image needs as its ON CONFLICT arbiter. Starting a container
# only proves it was launched, not that the new API can actually
# boot. Gate the breaking DDL on readiness of the NEW container so
# a crash-loop cannot leave the database incompatible with the last
# known-good API before the replacement is known to be runnable.
echo "==> Pre-activation health check — waiting for new API container"
for i in $(seq 1 20); do
  if docker compose \
       -f docker-compose.prod.yml \
       -f docker-compose.ghcr.yml \
       --env-file .env.production \
       exec -T api \
       wget -qO- http://127.0.0.1:3001/api/health 2>/dev/null; then
    echo ""
    echo "New API healthy before multipart salary activation after ${i}x checks"
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "ERROR: new API did not become healthy within 40s; refusing breaking salary activation"
    docker compose \
      -f docker-compose.prod.yml \
      -f docker-compose.ghcr.yml \
      --env-file .env.production \
      logs --tail=50 api
    exit 1
  fi
  sleep 2
done

# The new API no longer depends on the old receiver/month uniqueness:
# automatic idempotency is now the salary_month_initializations marker.
# Apply the breaking half only after the image swap AND the readiness
# gate above so the previous API can never observe a database without
# its ON CONFLICT arbiter merely because the replacement failed to boot.
MULTIPART_SALARY_ACTIVATE_FILE="/opt/crm/apps/api/drizzle/manual/2026-10-04_multiple_salary_transactions_activate.sql"
if [ ! -f "$MULTIPART_SALARY_ACTIVATE_FILE" ]; then
  echo "ERROR: migration file not found at $MULTIPART_SALARY_ACTIVATE_FILE — scp-action may have flattened the tree."
  ls -la /opt/crm/apps/api/drizzle/manual/ 2>/dev/null || true
  exit 1
fi

echo "==> Activating multipart salary uniqueness model — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$MULTIPART_SALARY_ACTIVATE_FILE"
echo "==> multipart salary activation applied successfully"

# Verify the API remains healthy after the schema contract changes.
echo "==> Post-activation health check — verifying API container"
for i in $(seq 1 20); do
  if docker compose \
       -f docker-compose.prod.yml \
       -f docker-compose.ghcr.yml \
       --env-file .env.production \
       exec -T api \
       wget -qO- http://127.0.0.1:3001/api/health 2>/dev/null; then
    echo ""
    echo "API healthy after multipart salary activation (${i}x checks)"
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "ERROR: API did not become healthy within 40s"
    docker compose \
      -f docker-compose.prod.yml \
      -f docker-compose.ghcr.yml \
      --env-file .env.production \
      logs --tail=50 api
    exit 1
  fi
  sleep 2
done

echo "==> Smoke test — external HTTP check (CRM API, non-fatal)"
if curl -sf --max-time 15 https://app.cheekycheese.tech/api/health; then
  echo "External health check PASSED"
else
  echo "WARNING: external check failed (Cloudflare/TLS may not be configured yet)"
  echo "Internal API is healthy — stack is running correctly"
fi

# ADR 2026-10-17-db-least-privilege-roles, measure 2: a `permission denied` /
# SQLSTATE 42501 in the NEW api container's logs fails the deploy, loudly. It
# must not pass unread: a missing grant looks exactly like a healthy API here
# (/api/health does not touch the database). FATAL on purpose, and so is a log
# read that fails: "could not look" must not read as "nothing there".
# The window opens at DEPLOY_STARTED_AT, so the old container's history is not
# this deploy's business (the standing watch, api-permission-denied-watch.yml,
# owns that). Only metadata is printed, never the matching lines: this log is
# public. Two-minute-old news by design: it sees what the API did while booting
# and during the health checks; the scheduled jobs are the standing watch's.
# PATTERN: keep identical to scripts/devops/check-api-permission-denied.sh
# (--print-pattern); tests/test-check-api-permission-denied.sh fails on drift.
PERMISSION_DENIED_RE='permission denied|must be (owner|superuser)|(sqlstate|code)[^0-9a-z]{0,6}42501'
echo "==> Scanning the new api container's logs for permission denied / 42501 (since ${DEPLOY_STARTED_AT})"
if ! API_LOGS_SINCE_DEPLOY="$(docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  logs --no-color --since "${DEPLOY_STARTED_AT}" api 2>&1)"; then
  echo "ERROR: could not read the api container's logs; refusing to pass the 42501 check unread"
  exit 1
fi
PERMISSION_DENIED_HITS="$(printf '%s\n' "$API_LOGS_SINCE_DEPLOY" | grep -aEi -e "$PERMISSION_DENIED_RE" | grep -c . || true)"
if [ "${PERMISSION_DENIED_HITS:-0}" -gt 0 ]; then
  echo "::error::permission denied / SQLSTATE 42501 appeared ${PERMISSION_DENIED_HITS} time(s) in the api logs during this deploy. The new image is already live; a grant is missing or a table is misclassified. Read the container logs on the VPS (docker compose logs api); this log deliberately does not repeat them."
  exit 1
fi
echo "No permission denied / 42501 in $(printf '%s\n' "$API_LOGS_SINCE_DEPLOY" | grep -c .) api log line(s) since ${DEPLOY_STARTED_AT}"

# task-infra-locale-edge (security-review round 1, HIGH-2 follow-up;
# hardened in round 2, LOW-3): unlike the CRM API check above (kept
# non-fatal, tolerates the DNS/TLS-not-configured-yet state a
# brand-new deployment can be in), this checks nginx's LANDING
# server block and is FATAL — nginx/Dockerfile's HIGH-2 fix (see
# scripts/devops/locale-routing-runbook.md §11) closes the
# config-injection vector that could make nginx fail to start, but
# this is the last line of defence against ANY OTHER future config
# mistake (not just build-arg injection) that produces the same
# failure mode: image builds fine, container crash-loops on boot,
# `docker compose up -d` still reports success, and without this
# check the deploy step would too — silently taking down the whole
# public site (landing AND, since nginx is shared, CRM) with a
# green pipeline.
#
# round 2 (LOW-3): the FIRST version of this check hit the public
# hostname (`https://cheekycheese.tech/`), meaning the VPS made an
# outbound request through Cloudflare and back to itself (a
# hairpin round-trip) — a transient CF blip or DNS hiccup unrelated
# to nginx's own health would fail the deploy. Fixed by hitting
# nginx's PUBLISHED PORT directly on loopback
# (`docker-compose.prod.yml` maps `80:80`/`443:443` to the host)
# with an explicit Host header, so the request still goes THROUGH
# nginx (exercises the real landing.conf server block, the
# locale-detect njs module, the merge-order guard — everything
# this PR added) but never leaves the VPS or depends on Cloudflare/
# DNS being reachable. Port 80 (not 443): no TLS handshake/cert
# complexity to add here, and the :80 server block runs the exact
# same locale-redirect logic as :443 (see nginx/conf.d/landing.conf
# — both blocks are kept in sync deliberately). Checks `/` (root)
# AND one locale-prefixed URL (`/uk/`) — the latter is safe to
# check regardless of feature/landing-i18n merge state: unmerged,
# the locale-edge guard (see runbook §4) makes `/uk/` fall back to
# a plain EN 200, not a 404 — still passes this check either way.
echo "==> Smoke test — landing origin through local nginx, Host header (FATAL)"
if curl -sf --max-time 15 -H 'Host: cheekycheese.tech' http://127.0.0.1/ > /dev/null \
   && curl -sf --max-time 15 -H 'Host: cheekycheese.tech' http://127.0.0.1/uk/ > /dev/null; then
  echo "Landing origin health check PASSED (/ and /uk/ both 200)"
else
  echo "ERROR: nginx is not returning 200 on / and/or /uk/ for the landing Host header."
  echo "This means nginx failed to start or is misconfigured — the deploy is NOT healthy"
  echo "even though earlier internal checks passed. See scripts/devops/locale-routing-runbook.md"
  echo "§11 for the config-injection class this guards against, and §6 for the general"
  echo "check-locale-routing.sh dry-run workflow to diagnose locally."
  exit 1
fi

# security review round 1 (PR #429, MED-3): scripts/devops/check-
# security-headers.sh was written to catch the HSTS/CSP/X-Frame-
# Options-loss class of regression (crm.conf's add_header-
# inheritance bug, and the Turnstile/R2 CSP-content gaps) but was
# never actually wired into anything — a repeat of exactly this
# bug class would ship silently through a green pipeline, same
# failure mode the landing check above already guards against for
# locale-routing. FATAL for the same reason: this is a "did nginx
# end up serving the config we think it did" class of check, not
# a soft warning. Hits 127.0.0.1 (not the public hostnames) for
# the SAME reason as the landing check immediately above (round 2,
# LOW-3 there) — avoids a Cloudflare/DNS hairpin dependency on
# what is fundamentally a "is nginx's OWN config correct" check.
# The script itself was scp'd to /opt/crm/scripts/devops/ in the
# copy-compose job above (see that step's comment) — it is not
# part of the VPS's normal file set otherwise.
#
# task-csp-reports-and-flip (Part B, security review round 2 LOW
# fix): explicit `[ -f ]` check BEFORE invoking the script —
# previously a scp failure/partial-tree (the exact "scp-action
# flattened the tree" class already guarded against for every DDL
# file above) would surface here as a bare `bash: ... No such
# file or directory` (exit 127), indistinguishable at a glance
# from the script itself failing its checks. Fails loud with the
# SAME diagnostic shape as the DDL guards for consistency.
#
# $CRM_CSP_MODE is already exported into this shell (see this
# step's `env:`/`envs:` above — same SSH env-passthrough
# mechanism as $IMAGE_TAG/$GH_ACTOR), sourced from this
# workflow's top-level `env:` block (single source of truth), so
# the guard below checks whichever CSP header name CRM is
# actually sending — matches the build-arg passed to the nginx
# image above. No explicit prefix needed on the invocation.
echo "==> Smoke test — security headers (HSTS/CSP), both domains via local nginx (FATAL)"
SECURITY_HEADERS_SCRIPT="/opt/crm/scripts/devops/check-security-headers.sh"
if [ ! -f "$SECURITY_HEADERS_SCRIPT" ]; then
  echo "ERROR: guard script not found at $SECURITY_HEADERS_SCRIPT — scp-action may have flattened the tree (see copy-compose job)."
  ls -la /opt/crm/scripts/devops/ 2>/dev/null || true
  exit 1
fi
if bash "$SECURITY_HEADERS_SCRIPT" http://127.0.0.1; then
  echo "Security headers check PASSED"
else
  echo "ERROR: nginx is not serving the expected security headers (HSTS/CSP/etc.) on one"
  echo "or both domains. This means a regression of the class fixed in PR #429 (nginx's"
  echo "add_header inheritance gotcha, or an incomplete/missing CSP directive) shipped —"
  echo "see scripts/devops/check-security-headers.sh's own header comment and"
  echo "scripts/devops/csp-report-only-rollout-runbook.md for how to diagnose locally."
  exit 1
fi

# security audit 2026-07-27 (MED-1/MED-5), gate added in the PR #439
# follow-up: same FATAL pattern as the security-headers check
# immediately above — this is the "did nginx end up serving the
# config we think it did" class of check, not a soft warning.
# Covers body-size limits, the default_server catch-all, the
# real-visitor regression guard (sends CF-Connecting-IP like
# Cloudflare would and asserts it is NOT rejected — POSTs to the
# real, public, GET-only /api/health, never touches the
# DB/S3/business logic), AND (security review, PR #439 follow-up,
# MED-3) a STATIC assertion that the origin gate's geo block is
# actually keyed on $realip_remote_addr, not $remote_addr — see
# that check's own header comment for why a plain HTTP probe
# cannot catch a reversion to the reverted-PR-#437 bug on its own.
#
# NGINX_EXEC_CMD gives that static check docker exec access to the
# running nginx container's compiled config (`nginx -T`) — same
# compose-file/env-file invocation already used for `exec -T
# postgres` a few steps above in this same script. Without it the
# check degrades to an explicit SKIP (see the script's own
# NGINX_EXEC_CMD handling), never a silent PASS.
export NGINX_EXEC_CMD="docker compose -f docker-compose.prod.yml -f docker-compose.ghcr.yml --env-file .env.production exec -T nginx"
echo "==> Smoke test — nginx perimeter (body limits, default_server, gate wiring), via local nginx (FATAL)"
NGINX_PERIMETER_SCRIPT="/opt/crm/scripts/devops/check-nginx-perimeter.sh"
if [ ! -f "$NGINX_PERIMETER_SCRIPT" ]; then
  echo "ERROR: guard script not found at $NGINX_PERIMETER_SCRIPT — scp-action may have flattened the tree (see copy-compose job)."
  ls -la /opt/crm/scripts/devops/ 2>/dev/null || true
  exit 1
fi
if bash "$NGINX_PERIMETER_SCRIPT" http://127.0.0.1; then
  echo "nginx perimeter check PASSED"
else
  echo "ERROR: nginx is not enforcing the expected request-body limits, the default_server"
  echo "catch-all is missing, real Cloudflare-forwarded visitors are being blocked, and/or"
  echo "the origin gate's geo block is no longer keyed on \$realip_remote_addr."
  echo "This means a regression of the class fixed in the 2026-07-27 security audit / PR #439"
  echo "(client_max_body_size silently reverted to nginx's 1 MB default, an unmatched Host"
  echo "falling through to a real vhost again, or a source-IP gate filtering on the"
  echo "client-supplied CF-Connecting-IP header instead of the real TCP peer) shipped — see"
  echo "scripts/devops/check-nginx-perimeter.sh's own header comment."
  exit 1
fi

# ── Step 3.5: drop_cascade_origin marker — SECOND PASS (idempotent, PERMANENT) ────
# security-review PR #443 (HIGH-1, round 4; confirmed safe-forever, round 5/6): Step
# 2k's application of this SAME file only catches rows that exist AT THE MOMENT it
# runs — which is BEFORE Step 3 restarts api/nginx. While the pull/restart/health-
# check sequence in Step 3 is in flight, the OLD api container (the PREVIOUS
# deploy's image, unaware of this column) is still the one answering real traffic
# and can still insert FRESH admin-declared DROP_PENDING_PAYOUT rows with
# drop_cascade_origin = NULL — the exact row shape Step 2k's UPDATE exists to
# sweep, just created a moment too late for that sweep to see them. Left uncaught
# until the NEXT deploy (which could be days later — the marker's own scheduled
# weekly rebuild is the only guaranteed upper bound), each such row would be
# wrongly BLOCKED from a legitimate COMPANY_ACCOUNT settle by the `<> false` guard
# in `settleByCompany` — the same "company owes a real person and can't pay them
# from the account that is actually holding the money" class of harm HIGH-1 exists
# to prevent, just re-opened by the deploy window itself for however long the next
# deploy takes to arrive.
#
# security-review PR #443/#447 (round 6) — image ROLLBACK is only PARTIALLY
# covered, not fully. The same gap re-opens on an image ROLLBACK to a pre-#443
# build (old image running again, unaware of the column) — but a rollback
# happening MORE than 24h after this environment's first marker application falls
# OUTSIDE STEP 3's `first_applied_at + 24h` window: rows the rolled-back image
# books stay NULL and must be stamped manually (see the runbook). This second pass
# closes the cutover-window race of THIS deploy, not an arbitrarily-late rollback.
#
# Fix: re-apply the SAME marker file — its STEP 1 (state-table anchor) and STEP 2
# (schema) are both no-ops by now (state already stamped, column/nullability/
# default already converged, by Step 2k above); its STEP 3 UPDATE is idempotent
# (`WHERE ... IS NULL` — a row it already fixed no longer matches) — AFTER Step 3's
# `docker compose up -d` AND after every FATAL health/smoke-check above have
# already passed. By this point the api container has been recreated from the NEW
# image and has answered a healthy `/api/health` — the OLD image is confirmed
# stopped and no further stragglers from THIS cutover can be created.
#
# Round 5/6: safe to leave BOTH passes wired PERMANENTLY (this environment's own
# `first_applied_at + 24h` has elapsed) — once elapsed, STEP 3 is a permanent
# 0-row no-op (`first_applied_at` is never re-stamped), so it can never mask a
# future regression that forgets to stamp the column.
#
# NOT gated behind any opt-in flag: this is a mechanical closing of a narrow,
# well-understood deploy-window race — it needs no owner judgment call the way
# the (now de-wired, see the precount step above) one-time historical backfill
# did. Runs UNCONDITIONALLY (same file-presence guard as Step 2k — soft-skip
# until #443 merges), same as Step 2k itself — no per-run business decision
# needed here.
if [ ! -f "$DROP_CASCADE_MARKER_FILE" ]; then
  echo "::notice::drop_cascade_origin marker DDL not found at $DROP_CASCADE_MARKER_FILE — PR #443 has not merged to main yet. Skipping the second pass (same reason as Step 2k above)."
  echo "=== drop_cascade_origin marker — SECOND PASS — SKIPPED (file not present; PR #443 not merged yet) ===" >> /opt/crm/.last-ddl-summary.txt
else
  echo "==> Applying drop_cascade_origin marker DDL SECOND PASS (idempotent, sweeps deploy-window stragglers; new guarded api image already live+healthy) — user=${PGUSER} db=${PGDB}"
  {
    echo "=== drop_cascade_origin marker — SECOND PASS, post-cutover sweep (2026-07-27_drop_cascade_origin_marker.sql) ==="
    docker compose \
      -f docker-compose.prod.yml \
      -f docker-compose.ghcr.yml \
      --env-file .env.production \
      exec -T postgres \
      psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
      < "$DROP_CASCADE_MARKER_FILE" 2>&1
  } | tee -a /opt/crm/.last-ddl-summary.txt
  echo "==> drop_cascade_origin marker SECOND PASS applied successfully"
fi

# ── database privileges catalog check, FINAL RUN (r5 Task 1.3c) — LAST database step ──
# Two files are applied after the first run: the multipart-salary activate file (it must
# follow the container swap) and the drop_cascade_origin marker SECOND PASS (a
# post-cutover sweep) just above. This run is placed after the second pass, so nothing is
# applied after the gate and the end state of the deploy is what gets validated.
# check-prod-ddl-wiring.py enforces this (CHECK-LAST): it fails if any file psql applies
# comes after the last run of the check.
DB_PRIVILEGES_CHECK_FILE="/opt/crm/apps/api/drizzle/manual/2026-10-18_db_privileges_check.sql"

echo "==> Running database privileges catalog check, final run (read-only) — user=${PGUSER} db=${PGDB}"
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  --env-file .env.production \
  exec -T postgres \
  psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  < "$DB_PRIVILEGES_CHECK_FILE"
echo "==> database privileges catalog check (final) passed"

# Step 4 (drop-share pending-parity BACKFILL, one-time historical-data mutation,
# gated behind APPLY_DROP_SHARE_PENDING_PARITY_BACKFILL) used to run here, after
# Step 3's health checks. Removed 2026-08-01
# (task-infra-drop-share-backfill-dewire): the first prod run of the PRE-COUNT
# above (Step 2l, run 30691783655) printed 0 Path-B rows — nothing on prod was
# ever created via the pre-#443 bypass, so there was nothing to migrate, and the
# guarded code has been live since that same deploy, so no new such rows can
# appear either. See
# scripts/devops/drop-share-pending-parity-backfill-runbook.md for the historical
# record of why this step existed and what it would have done.

# Disk hygiene (incident 2026-10-04: 696 accumulated images = 60 GB, disk 93%).
# Every deploy pulls a fresh api+nginx image tagged by git SHA and nothing ever
# removed the old ones — plain `docker image prune -f` only drops DANGLING
# (untagged) images, and SHA-tagged ones are never dangling.
#
# `-a --filter until=168h` removes every image NOT used by any container
# (running or stopped) whose CREATION time is older than 7 days. Consequences:
#   - active images (crm api/nginx/postgres/redis, signal-plus) are never touched —
#     Docker refuses to remove an image that a container references;
#   - volumes are untouched (`image prune` never deletes volumes);
#   - the last 7 days of SHA-tagged images stay for a fast rollback; older ones
#     are re-pullable from GHCR (rollback dispatch with `image_tag` re-pulls).
# Reached only when every FATAL check above passed (this is the last step of the
# script). `|| true`: a prune failure must not fail an already-successful deploy.
echo "==> Pruning unused images older than 7 days (keeps rollback window)"
docker image prune -af --filter "until=168h" || true
echo "==> Disk after prune"
df -h / | tail -n 1 || true
docker system df || true

echo "==> Deploy complete. IMAGE_TAG=${IMAGE_TAG}"
