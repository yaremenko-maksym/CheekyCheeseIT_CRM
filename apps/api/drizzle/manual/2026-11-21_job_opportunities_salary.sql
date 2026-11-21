-- Sources-17 (owner decision 2026-11-21): the structured salary of a canonical opportunity.
--
-- WHAT THIS FILE DOES
--   Adds five nullable columns to job_opportunities: salary_min, salary_max, salary_monthly_top
--   (numeric(12,2)), salary_currency and salary_period (text). They are the canonical salary
--   claim over an opportunity's members (job-sourcing/store/canonical-plan.ts), filled ONLY from a
--   source's structured salary fields, never parsed from free text. salary_monthly_top is the
--   range's top per month (max, else min), computed in the app, and comparable only within one
--   currency. Three CHECKs bound them, and one partial index serves the queue's same-currency
--   monthly-minimum filter:
--     ck_job_opportunities_salary_currency  ISO 4217 shape, upper case
--     ck_job_opportunities_salary_period    HOUR | MONTH | YEAR
--     ck_job_opportunities_salary_shape     all five null, or currency + period + monthly top set
--                                           with at least one bound, and min <= max when both are
--     idx_job_opportunities_salary          (salary_currency, salary_monthly_top)
--                                           WHERE salary_currency IS NOT NULL
--   No row is written: every existing opportunity starts with five nulls (no salary), and a
--   salary-bearing posting fills them on its next observation (a new content hash -> a new
--   revision -> the existing resolve and refresh path).
--
-- The Drizzle declaration is the five salary columns, the three CHECKs and the index in
-- schema/job-opportunities.ts; dev and CI get them through db:push.
--
-- ORDER
--   AFTER manual/2026-11-19_role_status_out_of_scope.sql (no dependency, file order only). BEFORE
--   the app that writes the columns starts: applied after it, every canonical write
--   (createOpportunity / refreshOpportunity) fails with 42703 (undefined column).
--
-- IDEMPOTENT
--   ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT and CREATE INDEX IF NOT
--   EXISTS, in one transaction (the deploy applies each file with
--   `psql -v ON_ERROR_STOP=1 --single-transaction`), so a second apply is a no-op that rebuilds
--   the same CHECKs. Adding nullable columns without a default is a catalog-only change; the CHECKs
--   validate every row under an ACCESS EXCLUSIVE lock, and every existing row is all-null.
--
-- ROLLBACK
--   ALTER TABLE job_opportunities DROP CONSTRAINT IF EXISTS ck_job_opportunities_salary_shape;
--   ALTER TABLE job_opportunities DROP CONSTRAINT IF EXISTS ck_job_opportunities_salary_period;
--   ALTER TABLE job_opportunities DROP CONSTRAINT IF EXISTS ck_job_opportunities_salary_currency;
--   DROP INDEX IF EXISTS idx_job_opportunities_salary;
--   ALTER TABLE job_opportunities DROP COLUMN IF EXISTS salary_monthly_top,
--     DROP COLUMN IF EXISTS salary_period, DROP COLUMN IF EXISTS salary_currency,
--     DROP COLUMN IF EXISTS salary_max, DROP COLUMN IF EXISTS salary_min;
--   Roll the app back FIRST: the current app writes these columns on every canonical write.

SET LOCAL lock_timeout = '10s';

ALTER TABLE job_opportunities
  ADD COLUMN IF NOT EXISTS salary_min numeric(12, 2),
  ADD COLUMN IF NOT EXISTS salary_max numeric(12, 2),
  ADD COLUMN IF NOT EXISTS salary_currency text,
  ADD COLUMN IF NOT EXISTS salary_period text,
  ADD COLUMN IF NOT EXISTS salary_monthly_top numeric(12, 2);

ALTER TABLE job_opportunities DROP CONSTRAINT IF EXISTS ck_job_opportunities_salary_currency;
ALTER TABLE job_opportunities ADD CONSTRAINT ck_job_opportunities_salary_currency
  CHECK (salary_currency IS NULL OR salary_currency ~ '^[A-Z]{3}$');

ALTER TABLE job_opportunities DROP CONSTRAINT IF EXISTS ck_job_opportunities_salary_period;
ALTER TABLE job_opportunities ADD CONSTRAINT ck_job_opportunities_salary_period
  CHECK (salary_period IS NULL OR salary_period IN ('HOUR', 'MONTH', 'YEAR'));

ALTER TABLE job_opportunities DROP CONSTRAINT IF EXISTS ck_job_opportunities_salary_shape;
ALTER TABLE job_opportunities ADD CONSTRAINT ck_job_opportunities_salary_shape
  CHECK (
    (salary_min IS NULL AND salary_max IS NULL AND salary_currency IS NULL
      AND salary_period IS NULL AND salary_monthly_top IS NULL)
    OR (salary_currency IS NOT NULL AND salary_period IS NOT NULL
      AND salary_monthly_top IS NOT NULL
      AND (salary_min IS NOT NULL OR salary_max IS NOT NULL)
      AND (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max))
  );

CREATE INDEX IF NOT EXISTS idx_job_opportunities_salary
  ON job_opportunities (salary_currency, salary_monthly_top)
  WHERE salary_currency IS NOT NULL;
