-- =============================================================================
-- Payment-type enum + per-project drop-share override + DROP_PENDING_PAYOUT
-- transaction type — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- task-drop-share-override-and-receiver (ADR
-- docs/architecture/2026-07-13-payment-type-income-routing.md). This branch:
--
--   1. Adds the `DROP_PENDING_PAYOUT` value to the `transaction_type` enum — the
--      company's IOU to a DROP after an ADMIN declares USDT project income.
--   2. Migrates `projects.payment_type` from free-text varchar(100) to a fixed
--      `project_payment_type` enum ('FOP' | 'GIG_CONTRACT' | 'USDT'),
--      NOT NULL DEFAULT 'FOP'. Owner rule: all existing projects → 'FOP',
--      the GamingTec project → 'USDT'. History is NOT touched.
--   3. Adds per-project drop-share override columns + DROP_INCOME snapshot
--      columns (mirrors the existing senior-share override/snapshot).
--
-- The dev database gets these changes via `pnpm --filter @crm/api db:push`
-- (drizzle-kit push). The prod image does NOT ship drizzle-kit, so prod is
-- migrated with THIS script.
--
-- ⚠️ BEFORE APPLYING ON PROD — MANDATORY C13 VERIFICATION
-- -------------------------------------------------------
-- `projects.payment_type` is currently free text. Inspect the real values so no
-- USDT/gig project is silently defaulted to 'FOP':
--
--   SELECT payment_type, COUNT(*) FROM projects GROUP BY payment_type;
--
-- Step 4 below is FAIL-LOUD: if any non-GamingTec project has a value that looks
-- like USDT / crypto / gig, the script RAISES and aborts so a human can classify
-- it explicitly (extend the mapping in step 5). Everything else → 'FOP' per the
-- owner rule; GamingTec → 'USDT'.
--
-- How to apply
-- ------------
-- From the VPS (or any host with Docker access to the prod stack):
--
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-07-13_payment_type_and_drop_pending_payout.sql
--
-- Add this file to .github/workflows/deploy.yml ("Pull, up, migrate,
-- health-check" step, Step 2b) and apply it BEFORE the new image serves traffic
-- (like the mega-audit DDL tail). DevOps owns that wiring — this PR only ships
-- the script + the note.
--
-- Idempotent: ADD VALUE IF NOT EXISTS, guarded CREATE TYPE, ADD COLUMN IF NOT
-- EXISTS, and a data-type guard around the enum conversion — safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. transaction_type += DROP_PENDING_PAYOUT
--    ALTER TYPE ... ADD VALUE cannot run inside a transaction block, so keep it
--    as the first standalone statement. IF NOT EXISTS makes it re-runnable.
-- -----------------------------------------------------------------------------
ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'DROP_PENDING_PAYOUT';

-- -----------------------------------------------------------------------------
-- 2. project_payment_type enum (guarded CREATE for idempotency)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  CREATE TYPE project_payment_type AS ENUM ('FOP', 'GIG_CONTRACT', 'USDT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- 3. drop-share override + DROP_INCOME snapshot columns (nullable, additive)
-- -----------------------------------------------------------------------------
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS drop_share_percent_override integer;
ALTER TABLE project_finance_settings
  ADD COLUMN IF NOT EXISTS drop_share_percent_override integer;
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS drop_share_percent integer;
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS drop_share_percent_source varchar(16);

-- -----------------------------------------------------------------------------
-- 4. C13 FAIL-LOUD guard — abort if a non-GamingTec project carries a value that
--    looks like it should become USDT / GIG_CONTRACT rather than the blanket
--    'FOP'. Do NOT silently convert those. (Skipped if payment_type is already
--    the enum — re-run safety.)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  is_text     boolean;
  suspicious  text[];
BEGIN
  SELECT data_type <> 'USER-DEFINED'
    INTO is_text
    FROM information_schema.columns
   WHERE table_name = 'projects' AND column_name = 'payment_type';

  IF is_text THEN
    SELECT array_agg(DISTINCT payment_type)
      INTO suspicious
      FROM projects
     WHERE payment_type IS NOT NULL
       AND name <> 'GamingTec'
       AND (
              payment_type ILIKE '%usdt%'
           OR payment_type ILIKE '%crypto%'
           OR payment_type ILIKE '%крипт%'
           OR payment_type ILIKE '%gig%'
           OR payment_type ILIKE '%гіг%'
           OR payment_type ILIKE '%гиг%'
           OR payment_type ILIKE '%contract%'
       );

    IF suspicious IS NOT NULL THEN
      RAISE EXCEPTION
        'C13 fail-loud: payment_type values that may need USDT/GIG_CONTRACT (not FOP): %. Classify them explicitly (extend step 5) before converting.',
        suspicious;
    END IF;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 5. Normalize free text → enum-shaped values (owner rule), then convert.
--    Guarded so re-running after conversion is a no-op.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  is_text boolean;
BEGIN
  SELECT data_type <> 'USER-DEFINED'
    INTO is_text
    FROM information_schema.columns
   WHERE table_name = 'projects' AND column_name = 'payment_type';

  IF is_text THEN
    -- GamingTec → USDT (owner decision).
    UPDATE projects SET payment_type = 'USDT' WHERE name = 'GamingTec';
    -- Everything else (including NULL / arbitrary free text that passed the
    -- fail-loud guard above) → FOP.
    UPDATE projects
       SET payment_type = 'FOP'
     WHERE payment_type IS NULL
        OR payment_type NOT IN ('FOP', 'GIG_CONTRACT', 'USDT');

    ALTER TABLE projects
      ALTER COLUMN payment_type TYPE project_payment_type
      USING payment_type::project_payment_type;
  END IF;
END $$;

ALTER TABLE projects ALTER COLUMN payment_type SET DEFAULT 'FOP';
-- Backfill any residual NULLs (should be none after step 5) then enforce.
UPDATE projects SET payment_type = 'FOP' WHERE payment_type IS NULL;
ALTER TABLE projects ALTER COLUMN payment_type SET NOT NULL;

-- =============================================================================
-- VERIFY (after applying):
--   SELECT payment_type, COUNT(*) FROM projects GROUP BY payment_type;   -- enum values only
--   SELECT unnest(enum_range(NULL::transaction_type)) AS t;              -- includes DROP_PENDING_PAYOUT
--   \d+ projects        -- payment_type = project_payment_type NOT NULL DEFAULT 'FOP'
-- =============================================================================
--
-- Rollback (feature-level):
--   ALTER TABLE projects ALTER COLUMN payment_type DROP NOT NULL;
--   ALTER TABLE projects ALTER COLUMN payment_type DROP DEFAULT;
--   ALTER TABLE projects ALTER COLUMN payment_type TYPE varchar(100)
--     USING payment_type::text;                       -- enum→varchar keeps values
--   ALTER TABLE projects            DROP COLUMN IF EXISTS drop_share_percent_override;
--   ALTER TABLE project_finance_settings DROP COLUMN IF EXISTS drop_share_percent_override;
--   ALTER TABLE transactions        DROP COLUMN IF EXISTS drop_share_percent;
--   ALTER TABLE transactions        DROP COLUMN IF EXISTS drop_share_percent_source;
--   DROP TYPE IF EXISTS project_payment_type;
--   -- Note: a PG enum value (DROP_PENDING_PAYOUT) cannot be removed — leave it
--   --       unused; it is harmless.
-- =============================================================================
