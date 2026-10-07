-- Meeting Recorder integration foundation.
-- Idempotent and additive: safe to re-run after a successful apply.

BEGIN;

CREATE TABLE IF NOT EXISTS meeting_recorder_connections (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                       text NOT NULL,
  enabled                    boolean NOT NULL DEFAULT true,
  signing_secret_ciphertext  text,
  expected_source            text,
  signing_secret_updated_at  timestamptz,
  last_verified_at           timestamptz,
  last_event_at              timestamptz,
  created_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meeting_recorder_webhook_receipts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id  uuid NOT NULL REFERENCES meeting_recorder_connections(id) ON DELETE CASCADE,
  webhook_id     text NOT NULL,
  event_type     text NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_recorder_webhook_receipts_connection_webhook
  ON meeting_recorder_webhook_receipts (connection_id, webhook_id);

CREATE INDEX IF NOT EXISTS idx_meeting_recorder_webhook_receipts_received_at
  ON meeting_recorder_webhook_receipts (received_at);

CREATE TABLE IF NOT EXISTS interview_recordings (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id           uuid REFERENCES interviews(id) ON DELETE SET NULL,
  connection_id          uuid NOT NULL REFERENCES meeting_recorder_connections(id) ON DELETE RESTRICT,
  external_recording_id  text NOT NULL,
  revision               bigint NOT NULL,
  source                 text NOT NULL,
  title                  text NOT NULL,
  started_at             timestamptz NOT NULL,
  ended_at               timestamptz,
  duration_ms            double precision,
  provider               text,
  meeting_id             text,
  meeting_url            text,
  stage_at_link          interview_stage,
  matched_by             text NOT NULL DEFAULT 'unmatched',
  readiness              jsonb NOT NULL,
  snapshot               jsonb NOT NULL,
  linked_by_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  linked_at              timestamptz,
  last_event_at          timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_interview_recordings_revision_positive CHECK (revision > 0),
  CONSTRAINT ck_interview_recordings_matched_by
    CHECK (matched_by IN ('meeting-id', 'meeting-url', 'manual', 'unmatched'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_interview_recordings_connection_external
  ON interview_recordings (connection_id, external_recording_id);

CREATE INDEX IF NOT EXISTS idx_interview_recordings_interview
  ON interview_recordings (interview_id);

CREATE INDEX IF NOT EXISTS idx_interview_recordings_connection
  ON interview_recordings (connection_id);

CREATE INDEX IF NOT EXISTS idx_interview_recordings_meeting_id
  ON interview_recordings (meeting_id);

CREATE INDEX IF NOT EXISTS idx_interview_recordings_started_at
  ON interview_recordings (started_at);

CREATE INDEX IF NOT EXISTS idx_interview_recordings_unmatched_created_at
  ON interview_recordings (created_at DESC)
  WHERE interview_id IS NULL;

CREATE TABLE IF NOT EXISTS meeting_recorder_audit_log (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action                  text NOT NULL,
  actor_user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  connection_id           uuid REFERENCES meeting_recorder_connections(id) ON DELETE SET NULL,
  interview_recording_id  uuid REFERENCES interview_recordings(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_meeting_recorder_audit_log_action CHECK (
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
      'media-purged'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_meeting_recorder_audit_log_created_at
  ON meeting_recorder_audit_log (created_at);

CREATE INDEX IF NOT EXISTS idx_meeting_recorder_audit_log_connection
  ON meeting_recorder_audit_log (connection_id);

CREATE INDEX IF NOT EXISTS idx_meeting_recorder_audit_log_recording
  ON meeting_recorder_audit_log (interview_recording_id);

COMMIT;
