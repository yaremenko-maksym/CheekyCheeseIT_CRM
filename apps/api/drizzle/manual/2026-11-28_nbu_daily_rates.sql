-- Historical NBU rates persisted (manager-role plan PR 8, design §4.6 currency) — prod forward DDL.
--
-- WHAT THIS FILE DOES
--   Creates nbu_daily_rates: the official NBU USD/UAH and EUR/UAH rate of one PAST calendar day,
--   one row per day (rate_date is the day the rate applies to). NbuCurrencyService writes a row the
--   first time it fetches a past day as an exact hit (never a previous-day, cached or hardcoded
--   fallback, never today) and reads it instead of calling NBU afterwards. A row is never updated:
--   the insert is ON CONFLICT DO NOTHING, since a past day's official rate never changes.
--
--   Holds no personal data. Until this file runs, the service logs the store failure and prices
--   every past day at the live rate with stale=true, so the table can lag the code safely.
--
-- The Drizzle declaration is `nbuDailyRates` (schema/nbu-daily-rates.ts); dev and CI get it by
-- db:push. nbu-daily-rates-ddl.integration.spec.ts applies this file twice into a scratch schema
-- and compares columns, constraints and the primary key with db:push.
--
-- PRIVILEGE CLASS
--   class A (PRIVILEGE_CLASSES): the API inserts and reads it. Its grants are in
--   2026-10-18_db_grants.sql, which runs after this file.
--
-- ORDER: before 2026-10-18_db_grants.sql (its grant names the table unconditionally) and before
--   the container swap. Depends on nothing else.
--
-- APPLY WITH `psql -v ON_ERROR_STOP=1 --single-transaction -f <this file>`: `SET LOCAL
-- lock_timeout` only binds inside a transaction, and the closing check is all-or-nothing only if a
-- failure rolls back everything above it.
--
-- COST: CREATE TABLE on a new, empty table; no lock on any existing relation.
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS; the closing block refuses to finish unless every named
--   constraint is present and validated.
--
-- ROLLBACK: none needed; the code degrades without the table. To remove it by hand (loses only
--   cached rates, which the service re-fetches from NBU):
--   DROP TABLE IF EXISTS nbu_daily_rates;
-- =============================================================================

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS nbu_daily_rates (
  "rate_date" date NOT NULL,
  "usd_uah" numeric(14, 4) NOT NULL,
  "eur_uah" numeric(14, 4) NOT NULL,
  "source_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "nbu_daily_rates_pkey" PRIMARY KEY ("rate_date"),
  CONSTRAINT "ck_nbu_daily_rates_positive" CHECK ("usd_uah" > 0 AND "eur_uah" > 0)
);

DO $$
DECLARE
  problems text[] := ARRAY[]::text[];
  expected text[] := ARRAY['nbu_daily_rates_pkey', 'ck_nbu_daily_rates_positive'];
  c text;
BEGIN
  IF to_regclass('nbu_daily_rates') IS NULL THEN
    problems := problems || 'table nbu_daily_rates is missing'::text;
  ELSE
    FOREACH c IN ARRAY expected LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'nbu_daily_rates'::regclass AND conname = c AND convalidated
      ) THEN
        problems := problems || format('constraint %s is missing or not validated', c);
      END IF;
    END LOOP;
  END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'nbu_daily_rates DDL is not in the intended state: %', array_to_string(problems, '; ');
  END IF;
END $$;
