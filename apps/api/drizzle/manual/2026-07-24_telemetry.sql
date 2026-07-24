-- =============================================================================
-- Telemetry module — prod DDL (manual apply)
-- =============================================================================
--
-- Context
-- -------
-- task-telemetry-api (T1): prod-error tracking (auto-GitHub-issues, no owner
-- in the loop) + UX-event analytics (weekly digest). Two brand new tables +
-- 3 new enums — fully additive, no existing table/column touched.
--
-- The dev/CI database gets these changes via `pnpm --filter @crm/api db:push`
-- (drizzle-kit push, see `.github/workflows/ci.yml`). The prod image does NOT
-- ship drizzle-kit, so prod is migrated with THIS script.
--
-- How to apply
-- ------------
-- From the VPS (or any host with Docker access to the prod stack):
--
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-07-24_telemetry.sql
--
-- Add this file to .github/workflows/deploy.yml ("Pull, up, migrate,
-- health-check" step) and apply it BEFORE the new image serves traffic (like
-- the vacancies DDL tail). DevOps/PM own that wiring — this PR only ships the
-- script + this note (task-telemetry-api §Процесс: T3 devops wires the DDL
-- step + TELEMETRY_DIGEST_TOKEN/TELEMETRY_SESSION_SALT secrets).
--
-- Idempotent: guarded `CREATE TYPE` (duplicate_object exception swallowed) +
-- `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` — safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Enums (guarded CREATE for idempotency)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  CREATE TYPE telemetry_source AS ENUM ('WEB', 'API');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE telemetry_error_status AS ENUM ('NEW', 'NOTIFIED', 'RESOLVED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE telemetry_event_type AS ENUM (
    'route_enter', 'route_leave', 'feature_click', 'form_abandon', 'form_submit'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- 2. telemetry_errors — one row per distinct error (grouped by fingerprint)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telemetry_errors (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint          text NOT NULL UNIQUE,
  source               telemetry_source NOT NULL,
  message              text NOT NULL,
  stack                text,
  route                text,
  user_id              uuid REFERENCES users(id) ON DELETE SET NULL,
  user_role            text,
  meta                 jsonb NOT NULL DEFAULT '{}',
  count                integer NOT NULL DEFAULT 1,
  first_seen           timestamptz NOT NULL DEFAULT now(),
  last_seen            timestamptz NOT NULL DEFAULT now(),
  status               telemetry_error_status NOT NULL DEFAULT 'NEW',
  github_issue_number  integer
);

CREATE INDEX IF NOT EXISTS idx_telemetry_errors_status_last_seen
  ON telemetry_errors (status, last_seen);

-- -----------------------------------------------------------------------------
-- 3. telemetry_events — raw UX events (short retention, high volume)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telemetry_events (
  id            bigserial PRIMARY KEY,
  session_hash  text NOT NULL,
  user_role     text NOT NULL,
  event         telemetry_event_type NOT NULL,
  route         text NOT NULL,
  target        text,
  duration_ms   integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_events_event_created
  ON telemetry_events (event, created_at);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_route_created
  ON telemetry_events (route, created_at);

-- =============================================================================
-- VERIFY (after applying):
--   \d+ telemetry_errors
--   \d+ telemetry_events
--   SELECT unnest(enum_range(NULL::telemetry_error_status));
-- =============================================================================
--
-- Rollback (feature-level, no prod data expected yet):
--   DROP TABLE IF EXISTS telemetry_events;
--   DROP TABLE IF EXISTS telemetry_errors;
--   DROP TYPE IF EXISTS telemetry_event_type;
--   DROP TYPE IF EXISTS telemetry_error_status;
--   DROP TYPE IF EXISTS telemetry_source;
-- =============================================================================
