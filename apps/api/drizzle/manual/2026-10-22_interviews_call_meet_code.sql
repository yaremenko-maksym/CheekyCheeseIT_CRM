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
-- 4. `interviews.match_key_changed_at`: when `call_url` / `scheduled_at` last changed.
--    Both are user-editable, so the matcher only considers interviews whose key was
--    set BEFORE the recording started — a key planted after the call began cannot
--    capture it.
-- 5. `meeting_recorder_audit_log.action` accepts `interview-call-changed`, and the
--    log gains `interview_id`: every call URL / schedule change is audited.
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

-- Existing rows get the deploy time: fail-closed (a recording that started before
-- the deploy is never auto-matched to them), and they carry no scheduled_at anyway.
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS match_key_changed_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE meeting_recorder_audit_log
  ADD COLUMN IF NOT EXISTS interview_id uuid REFERENCES interviews(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_meeting_recorder_audit_log_interview
  ON meeting_recorder_audit_log (interview_id);

-- Action-specific detail. For 'interview-call-changed' it holds the auto-match key
-- before and after the write, because call_url is overwritten in place and the log
-- would otherwise record that the key changed but not from what (SR-M-2 / SPEC-L-1).
ALTER TABLE meeting_recorder_audit_log ADD COLUMN IF NOT EXISTS metadata jsonb;

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
