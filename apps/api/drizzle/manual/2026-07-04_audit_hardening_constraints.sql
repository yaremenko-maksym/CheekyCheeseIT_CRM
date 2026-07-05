-- =============================================================================
-- Audit-hardening constraints — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- PR #328–#336 (audit-fix pass, 2026-06-27/07-03) added DB-level safety nets
-- for idempotency races and business invariants directly in the Drizzle schema
-- builder (schema.ts). drizzle-kit push synced these to the dev database
-- automatically. The prod VPS database (app.cheekycheese.tech) has NOT received
-- these objects yet — the prod image does not ship drizzle-kit, so the DDL must
-- be applied manually before the corresponding code lands on prod.
--
-- Without these objects:
--   SEC-01  salary-cron TOCTOU race → duplicate SALARY rows (double credit)
--   BIZ-07  HIRED → duplicate project creation on concurrent transitions
--   BIZ-11  duplicate PENDING obligations / templates / ToS / contracts
--   BIZ-19  DIVIDEND_TO_ADMIN created twice on network retry
--
-- How to apply
-- ------------
-- From the VPS (or any host with Docker access to the prod stack):
--
--   # Copy script to VPS then:
--   docker exec -i <postgres_container> psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     < apps/api/drizzle/manual/2026-07-04_audit_hardening_constraints.sql
--
-- Or inline from the repo root (if docker-compose.prod.yml is on the VPS):
--
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     < apps/api/drizzle/manual/2026-07-04_audit_hardening_constraints.sql
--
-- The script is FULLY IDEMPOTENT — every statement uses IF NOT EXISTS.
-- Re-running it on a database that already has these objects is safe (no-op).
--
-- See also: docs/architecture/2026-07-04-audit-constraints-deploy-runbook.md
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK: run these SELECTs before applying.
-- If any returns rows, follow the data-cleanup instructions in the runbook
-- BEFORE running the DDL — otherwise the CREATE INDEX will fail on conflict.
-- ---------------------------------------------------------------------------

-- SEC-01 duplicates: multiple SALARY rows for the same (receiver, month)
-- SELECT receiver_id, salary_month, count(*)
--   FROM transactions
--  WHERE type = 'SALARY' AND salary_month IS NOT NULL
--  GROUP BY receiver_id, salary_month
-- HAVING count(*) > 1;

-- BIZ-11 (pending_obligations): multiple PENDING obligations per source tx
-- SELECT source_transaction_id, count(*)
--   FROM pending_obligations
--  WHERE status = 'PENDING'
--  GROUP BY source_transaction_id
-- HAVING count(*) > 1;

-- BIZ-11 (employee_contracts): multiple non-CANCELLED contracts per user
-- SELECT user_id, count(*)
--   FROM employee_contracts
--  WHERE status != 'CANCELLED'
--  GROUP BY user_id
-- HAVING count(*) > 1;

-- BIZ-11 (contract_templates): multiple active templates per target_role
-- SELECT target_role, count(*)
--   FROM contract_templates
--  WHERE is_active = true
--  GROUP BY target_role
-- HAVING count(*) > 1;

-- BIZ-11 (tos_versions): multiple active ToS versions
-- SELECT count(*)
--   FROM tos_versions
--  WHERE is_active = true
-- HAVING count(*) > 1;

-- BIZ-07 duplicates: same created_project_id on multiple interviews
-- SELECT created_project_id, count(*)
--   FROM interviews
--  WHERE created_project_id IS NOT NULL
--  GROUP BY created_project_id
-- HAVING count(*) > 1;

-- BIZ-19 duplicates: same idempotency_key on multiple DIVIDEND_TO_ADMIN rows
-- SELECT idempotency_key, count(*)
--   FROM transactions
--  WHERE type = 'DIVIDEND_TO_ADMIN' AND idempotency_key IS NOT NULL
--  GROUP BY idempotency_key
-- HAVING count(*) > 1;

-- =============================================================================
-- 1. SEC-01 — salary-cron idempotency (transactions)
-- =============================================================================
-- Partial unique index: at most one SALARY row per (receiver_id, salary_month).
-- Mirrors: uniqueIndex('uq_transactions_salary_receiver_month')
--            .on(t.receiverId, t.salaryMonth)
--            .where(sql`${t.type} = 'SALARY' AND ${t.salaryMonth} IS NOT NULL`)
-- Source: schema.ts ~line 571; PR #332.

CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_salary_receiver_month
  ON transactions (receiver_id, salary_month)
  WHERE type = 'SALARY' AND salary_month IS NOT NULL;

-- =============================================================================
-- 2. BIZ-11 — one PENDING obligation per source transaction (pending_obligations)
-- =============================================================================
-- Partial unique index: a source transaction can have at most one PENDING
-- obligation at any time. PAID/CANCELLED rows are excluded — a source tx can
-- have one PAID + one new PENDING at different lifecycle stages.
-- Mirrors: uniqueIndex('uq_pending_obligations_source_pending')
--            .on(t.sourceTransactionId)
--            .where(sql`${t.status} = 'PENDING'`)
-- Source: schema.ts ~line 663; PR #332.

CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_obligations_source_pending
  ON pending_obligations (source_transaction_id)
  WHERE status = 'PENDING';

-- =============================================================================
-- 3. BIZ-11 — one non-CANCELLED contract per user (employee_contracts)
-- =============================================================================
-- Partial unique index: each user may have at most one active (non-CANCELLED)
-- employee contract. CANCELLED rows are excluded so a re-issued contract after
-- termination is valid.
-- Mirrors: uniqueIndex('employee_contracts_one_per_user')
--            .on(t.userId)
--            .where(sql`${t.status} != 'CANCELLED'`)
-- Source: schema.ts ~line 960; PR #332.

CREATE UNIQUE INDEX IF NOT EXISTS employee_contracts_one_per_user
  ON employee_contracts (user_id)
  WHERE status != 'CANCELLED';

-- =============================================================================
-- 4. BIZ-11 — one active template per target_role (contract_templates)
-- =============================================================================
-- Partial unique index: at most one is_active=true row per target_role.
-- ContractTemplatesService.publish atomically deactivates the previous active
-- row before inserting; this index is the DB-level safety net for concurrent
-- publish calls.
-- Mirrors: uniqueIndex('uq_contract_templates_active_role')
--            .on(t.targetRole, t.isActive)
--            .where(sql`${t.isActive} = true`)
-- Source: schema.ts ~line 823; PR #332.

CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_templates_active_role
  ON contract_templates (target_role, is_active)
  WHERE is_active = true;

-- =============================================================================
-- 5. BIZ-11 — at most one globally active ToS version (tos_versions)
-- =============================================================================
-- Partial unique index: at most one is_active=true row across the entire table.
-- TosService.publish atomically deactivates the previous active row; this index
-- is the DB-level race safety net.
-- Mirrors: uniqueIndex('uq_tos_versions_active')
--            .on(t.isActive)
--            .where(sql`${t.isActive} = true`)
-- Source: schema.ts ~line 877; PR #332.

CREATE UNIQUE INDEX IF NOT EXISTS uq_tos_versions_active
  ON tos_versions (is_active)
  WHERE is_active = true;

-- =============================================================================
-- 6. BIZ-07 — HIRED → auto-project idempotency (interviews)
-- =============================================================================
-- ADD COLUMN first (idempotent), then the partial unique index.
-- created_project_id: set the first time an interview transitions to HIRED;
-- subsequent HIRED transitions detect it and skip duplicate project creation.
-- Mirrors: createdProjectId: uuid('created_project_id').references(() => projects.id, { onDelete: 'set null' })
--      and uniqueIndex('uq_interviews_created_project_id')
--            .on(t.createdProjectId)
--            .where(sql`${t.createdProjectId} IS NOT NULL`)
-- Source: schema.ts ~line 392 + 401; PR #335.

ALTER TABLE interviews
  ADD COLUMN IF NOT EXISTS created_project_id uuid
    REFERENCES projects (id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_interviews_created_project_id
  ON interviews (created_project_id)
  WHERE created_project_id IS NOT NULL;

-- =============================================================================
-- 7. BIZ-19 — DIVIDEND_TO_ADMIN idempotency key (transactions)
-- =============================================================================
-- ADD COLUMN first (idempotent), then the partial unique index.
-- idempotency_key: client-supplied UUID; the DB enforces that the same key
-- cannot produce two DIVIDEND_TO_ADMIN rows. NULL for all other types and
-- for older dividends without a key (backward-compat).
-- Mirrors: idempotencyKey: uuid('idempotency_key')
--      and uniqueIndex('uq_transactions_dividend_idempotency_key')
--            .on(t.idempotencyKey)
--            .where(sql`${t.type} = 'DIVIDEND_TO_ADMIN' AND ${t.idempotencyKey} IS NOT NULL`)
-- Source: schema.ts ~line 532 + 578; PR #335.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_dividend_idempotency_key
  ON transactions (idempotency_key)
  WHERE type = 'DIVIDEND_TO_ADMIN' AND idempotency_key IS NOT NULL;

-- =============================================================================
-- VERIFY: after applying, run this query — expect exactly 7 rows.
-- =============================================================================
-- SELECT indexname
--   FROM pg_indexes
--  WHERE indexname IN (
--    'uq_transactions_salary_receiver_month',
--    'uq_pending_obligations_source_pending',
--    'employee_contracts_one_per_user',
--    'uq_contract_templates_active_role',
--    'uq_tos_versions_active',
--    'uq_interviews_created_project_id',
--    'uq_transactions_dividend_idempotency_key'
-- );
-- Expected: 7 rows. Any fewer → re-check the output for errors above.
-- =============================================================================
