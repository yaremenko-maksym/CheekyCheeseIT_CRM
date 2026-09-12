-- =============================================================================
-- Notification email outbox — prod DDL (position 7a)
-- =============================================================================
--
-- Context
-- -------
-- Position 7a of docs/superpowers/specs/2026-09-01-notifications-and-
-- confirmations-design.md §7: an employee must LEARN about events on their
-- profile, and §12 measures that mail is the channel that reaches them when
-- the CRM tab is closed. This table is the outbox: one row per notification
-- that is supposed to leave the building as an email.
--
-- Written in the SAME transaction as the notification itself
-- (NotificationsService.createInTx) — the event, its notification and its
-- queued email commit or roll back together. An email about an event that did
-- not happen is exactly as wrong as a notification about one.
--
-- The row carries NO SUBJECT AND NO BODY. Both are composed at send time from
-- the notification's type + `data` (notification-email-copy.ts). Same reason
-- §7.1 refused to store ready-made buttons in the notification row: editing a
-- wording would mean editing DATA, old rows would preserve last year's text,
-- and interface copy would spread into database strings where no copy gate can
-- see it. `copy-reviewer` reads all ten emails in one file.
--
-- Why no `SENDING` status: a crashed process must not leave rows stuck in it
-- forever. The sender CLAIMS a row by pushing `next_attempt_at` into the
-- future (a lease) and bumping `attempts`; the status stays QUEUED. An expired
-- lease returns the row to the queue by itself, with no reaper job. The price
-- is a possible duplicate send if the process dies between the provider call
-- and the SENT stamp — a second "you have a decision waiting" email is
-- harmless, a lost one is not.
--
-- Data risk: none. New table, nothing backfilled, nothing rewritten. No
-- currently deployed code reads or writes it until this same PR's image ships.
--
-- PII note: `sent_to_email` is the only column holding personal data (the
-- address a message actually went to, kept as the delivery trail). It is never
-- written to a log line. `last_error` holds a SANITIZED reason only
-- (`Resend API HTTP 429`, an error class name) — Resend's raw response body
-- quotes back the rejected recipient, which this codebase does not log
-- anywhere (see personal-email-invite-mailer.service.ts `safeErrorReason`).
--
-- How to apply
-- ------------
--   docker compose -f docker-compose.prod.yml exec -T postgres psql \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
--     < apps/api/drizzle/manual/2026-09-12_notification_emails.sql
--
-- Wired into .github/workflows/deploy.yml (rollback-preflight file list, SCP
-- copy step, psql apply step) in this SAME PR — mirrors
-- 2026-09-07_notification_subjects.sql exactly, for the same reason (CR-H-2,
-- code-review PR #624): without this table the code in this PR does not work,
-- and splitting the migration from its wiring across two PRs leaves a window
-- where prod 500s the moment the image ships.
-- `scripts/devops/check-prod-ddl-wiring.py` verifies both the COPY and the
-- APPLY step exist (not just a comment naming the file).
--
-- Idempotent: `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` +
-- a DO-block guard on the enum type (Postgres has no `CREATE TYPE IF NOT
-- EXISTS`) — safe to re-run on every deploy, forever.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Delivery state. QUEUED -> SENT, or QUEUED -> FAILED after the attempt
--    ceiling. No SENDING — see the header for why the claim is a lease.
-- -----------------------------------------------------------------------------
-- `to_regtype`, and not `SELECT 1 FROM pg_type WHERE typname = …`: the latter
-- matches the name in ANY schema, so it would skip the CREATE while the type
-- is still unreachable from the current `search_path` — and the CREATE TABLE
-- below would then fail with "type does not exist". `to_regtype` resolves the
-- name exactly the way the CREATE TABLE below will, which is the condition
-- that actually matters. Caught by executing the file twice in
-- `notification-email-migrations.integration.spec.ts`, not by reading it.
DO $$
BEGIN
  IF to_regtype('notification_email_status') IS NULL THEN
    CREATE TYPE notification_email_status AS ENUM ('QUEUED', 'SENT', 'FAILED');
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 2. The outbox itself.
--
--    ON DELETE CASCADE on both keys: the recipient deleting their notification
--    (DELETE /api/notifications/:id) leaves nothing to write an email ABOUT —
--    the text is composed from the notification at send time, so an orphaned
--    queue row could not be rendered even in principle.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_emails (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id   uuid NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status            notification_email_status NOT NULL DEFAULT 'QUEUED',
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz,
  sent_to_email     varchar(255),
  last_error        varchar(200),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 3. One email per notification. The notification row already de-duplicates
--    the EVENT (partial unique index on `dedupe_key`); this index de-duplicates
--    the QUEUEING, so a retried enqueue for the same row is a no-op rather than
--    a second message.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_emails_notification
  ON notification_emails (notification_id);

-- -----------------------------------------------------------------------------
-- 4. The sender's entire read: "QUEUED, due, oldest first". PARTIAL — sent and
--    given-up rows accumulate forever, and keeping them in the index would mean
--    paying for them on every 15-second pass.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_notification_emails_due
  ON notification_emails (next_attempt_at)
  WHERE status = 'QUEUED';

-- =============================================================================
-- VERIFY (after applying):
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'notification_emails';
--   SELECT indexname FROM pg_indexes
--     WHERE tablename = 'notification_emails';
--   SELECT enumlabel FROM pg_enum e
--     JOIN pg_type t ON t.oid = e.enumtypid
--     WHERE t.typname = 'notification_email_status';
--
-- Expected: eleven columns, three indexes (primary key + the two above), three
-- enum labels. No query returns any row CONTENT — no personal data is read or
-- printed by this migration or its verification.
-- =============================================================================
