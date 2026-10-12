-- Phase 2 media control-plane schema; additive, applied separately from deployed Phase 1.
-- One artifact per logical transfer; multiple upload attempts per artifact.
BEGIN;

ALTER TABLE meeting_recorder_connections
  ADD COLUMN IF NOT EXISTS media_token_hash text,
  ADD COLUMN IF NOT EXISTS media_token_updated_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_recorder_connections_media_token_hash
  ON meeting_recorder_connections(media_token_hash)
  WHERE media_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS recording_media_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES meeting_recorder_connections(id) ON DELETE RESTRICT,
  client_transfer_id text NOT NULL,
  external_recording_id text NOT NULL,
  role text NOT NULL,
  filename text NOT NULL,
  request_fingerprint text NOT NULL,
  mime_type text NOT NULL,
  bytes bigint NOT NULL,
  storage_key text NOT NULL,
  status text NOT NULL DEFAULT 'uploading',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT ck_recording_media_artifact_bytes CHECK (bytes > 0),
  CONSTRAINT ck_recording_media_artifact_status
    CHECK (status IN ('uploading', 'completing', 'ready', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_recording_media_artifact_connection_transfer
  ON recording_media_artifacts(connection_id, client_transfer_id);
CREATE INDEX IF NOT EXISTS idx_recording_media_artifact_recording
  ON recording_media_artifacts(connection_id, external_recording_id);

CREATE TABLE IF NOT EXISTS recording_media_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES recording_media_artifacts(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  storage_upload_id text NOT NULL,
  part_size integer NOT NULL,
  status text NOT NULL DEFAULT 'uploading',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_recording_media_upload_part_size CHECK (part_size BETWEEN 5242880 AND 268435456),
  CONSTRAINT ck_recording_media_upload_status
    CHECK (status IN ('uploading', 'completing', 'ready', 'expired', 'aborted'))
);

CREATE INDEX IF NOT EXISTS idx_recording_media_uploads_artifact_created
  ON recording_media_uploads(artifact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recording_media_uploads_expiry
  ON recording_media_uploads(status, expires_at);

COMMIT;
