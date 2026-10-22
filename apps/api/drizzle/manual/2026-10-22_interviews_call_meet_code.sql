-- =============================================================================
-- interviews.call_meet_code + interviews.scheduled_at — meeting-recorder auto-match
-- hardening (retro review of PR #865: SR-865-H-1, CR-865-H-1), prod forward DDL
-- =============================================================================
--
-- What it changes
-- ---------------
-- 1. `interviews.scheduled_at` (nullable timestamptz): when the interview call is
--    scheduled to start. Auto-match links a recording only when its `started_at` is
--    within ±30 min of it (owner decision D-1, 2026-10-22). NULL → never auto-matched.
-- 2. `interviews.call_meet_code` (STORED generated column): the normalized Google Meet
--    code of `call_url`. The expression is byte-identical to
--    `INTERVIEW_CALL_MEET_CODE_SQL` in `src/database/schema/interviews.ts`; it is
--    immutable, so Postgres computes it for every writer. Anything that is not an
--    `https://meet.google.com/...` URL yields NULL (never auto-matched).
-- 3. A partial index on (call_meet_code, scheduled_at) so the matcher is a single
--    indexed lookup instead of loading every interview with a call URL.
-- 4. `meeting_recorder_audit_log.action` accepts `interview-call-changed` (a call URL
--    or schedule change on an interview that already has a linked recording).
--
-- Idempotent: safe to re-run after a successful apply. `ADD COLUMN IF NOT EXISTS`
-- skips existing columns. The CHECK keeps its NAME and widens its predicate, which
-- neither `drizzle-kit push` nor a name-guarded ADD would move — so it is dropped and
-- re-added explicitly every run (a metadata-only table; the lock is momentary).
--
-- Locking: adding a STORED generated column rewrites `interviews` under ACCESS
-- EXCLUSIVE. The table is small (one row per kanban card), so the rewrite is short.

BEGIN;

ALTER TABLE interviews ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;

ALTER TABLE interviews ADD COLUMN IF NOT EXISTS call_meet_code text
  GENERATED ALWAYS AS (lower(substring(call_url from '(?i)^https://meet\.google\.com(?::443)?/(?:[^?#]*/)?([^/?#]+)/*(?:[?#].*)?$'))) STORED;

CREATE INDEX IF NOT EXISTS idx_interviews_call_meet_code_scheduled_at
  ON interviews (call_meet_code, scheduled_at)
  WHERE call_meet_code IS NOT NULL;

ALTER TABLE meeting_recorder_audit_log
  DROP CONSTRAINT IF EXISTS ck_meeting_recorder_audit_log_action;

ALTER TABLE meeting_recorder_audit_log
  ADD CONSTRAINT ck_meeting_recorder_audit_log_action CHECK (
    action IN (
      'connection-created',
      'connection-renamed',
      'connection-enabled',
      'connection-disabled',
      'secret-replaced',
      'token-issued',
      'pairing-reset',
      'recording-linked',
      'recording-unlinked',
      'recording-purged',
      'media-purged',
      'interview-call-changed'
    )
  );

COMMIT;
