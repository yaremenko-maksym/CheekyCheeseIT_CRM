-- =============================================================================
-- Senior availability (vacancy-queue design §5.2) — prod forward DDL (STAGED)
-- =============================================================================
--
-- WHAT THIS FILE DOES
--   Creates `senior_availability`: one row per senior who has said whether they are free.
--     user_id         uuid PRIMARY KEY, REFERENCES users(id) ON DELETE CASCADE (a hard-deleted user
--                     takes their availability with them; users are archived in normal operation);
--     status          text, CHECK IN ('FREE', 'BUSY');
--     available_from  date, NULL unless FREE: CHECK (status = 'FREE') = (available_from IS NOT NULL);
--     updated_at      timestamptz NOT NULL DEFAULT now().
--   No row means "never set", and the HR queue card shows no availability for that senior.
--   This is the SENIOR's availability, not a vacancy's (`job_opportunities.availability`).
--
-- WHO WRITES IT. PUT /users/:id/availability: the senior for themself, or an ADMIN for any senior
-- (SeniorAvailabilityService). The queue card reads it (`seniorRows` in queue-read-sql.ts).
--
-- BACKFILL: none. Every senior starts with no row, which reads as "not set".
--
-- ORDER (owner step): apply this file BEFORE a build carrying this code serves the queue card. The
-- card's seniors query joins `senior_availability`, so with the table absent every card read fails
-- with 42P01 (the list is not affected), and GET/PUT /users/:id/availability fail the same way.
-- Nothing else reads the table: it is its own relation rather than a `users` column so that a
-- missing apply cannot break the many whole-row `users` reads (login included).
--
-- PRIVILEGE CLASS
--   Class A: crm_app upserts, so SELECT+INSERT+UPDATE+DELETE; the collector has no grant. The grant
--   lives in the generated manual/2026-10-18_db_grants.sql, guarded by to_regclass while this file is
--   staged (STAGED_RELATIONS in privilege-classes.ts).
--
-- WHY THIS FILE IS STAGED, NOT IN manual/
--   Production DDL ships staged. It is DARK: `manual-staged/` is never applied in prod. The DevOps
--   wiring PR moves this file to `manual/`, wires it into deploy.yml, removes the STAGED_RELATIONS
--   entry and regenerates the privilege files.
--
-- The Drizzle declaration is `seniorAvailability` (schema/senior-availability.ts).
-- senior-availability-ddl.integration.spec.ts applies this file twice into a scratch schema and
-- compares the objects with `db:push`.
--
-- APPLY WITH `psql -v ON_ERROR_STOP=1 --single-transaction -f <this file>`: `SET LOCAL
-- lock_timeout` only binds inside a transaction, and the closing check is all-or-nothing only if a
-- failure rolls back everything above it.
--
-- COST: CREATE TABLE plus an FK to `users`, which takes SHARE ROW EXCLUSIVE on `users` for the
-- moment of the CREATE (no rows to validate). No extra index: every read is by the primary key.
--
-- RE-RUNNABLE: CREATE TABLE IF NOT EXISTS; the closing block refuses to finish unless every named
-- constraint is present and validated.
--
-- ROLLBACK (by hand; first revert the code, since the card query and the availability endpoints name
-- the table). Loses every senior's stated availability:
--   DROP TABLE IF EXISTS "senior_availability";
-- =============================================================================

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS senior_availability (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "status" text NOT NULL,
  "available_from" date,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "senior_availability_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade,
  CONSTRAINT "ck_senior_availability_status" CHECK ("senior_availability"."status" IN ('FREE', 'BUSY')),
  CONSTRAINT "ck_senior_availability_from" CHECK (("senior_availability"."status" = 'FREE') = ("senior_availability"."available_from" IS NOT NULL))
);

-- The closing check: every named constraint present and validated, or the apply fails (and, applied
-- in one transaction, rolls back everything above). It does not compare definitions: the DDL spec
-- does that against `db:push`.
DO $$
DECLARE
  problems text[] := '{}';
  expected text[] := ARRAY[
    'senior_availability_pkey',
    'senior_availability_user_id_users_id_fk',
    'ck_senior_availability_status',
    'ck_senior_availability_from'
  ];
  c text;
BEGIN
  IF to_regclass('senior_availability') IS NULL THEN
    problems := problems || 'table senior_availability is missing'::text;
  ELSE
    FOREACH c IN ARRAY expected LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'senior_availability'::regclass AND conname = c AND convalidated
      ) THEN
        problems := problems || format('constraint %s is missing or not validated', c);
      END IF;
    END LOOP;
  END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'senior_availability DDL is not in the intended state: %', array_to_string(problems, '; ');
  END IF;
END $$;
