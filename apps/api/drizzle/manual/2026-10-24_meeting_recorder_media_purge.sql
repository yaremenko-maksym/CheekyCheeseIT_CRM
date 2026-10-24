-- Durable meeting-recorder purge tombstones and retryable media cleanup state.
BEGIN;

ALTER TABLE interview_recordings
  ADD COLUMN IF NOT EXISTS purged_at timestamptz;

ALTER TABLE recording_media_artifacts
  DROP CONSTRAINT IF EXISTS ck_recording_media_artifact_status;

ALTER TABLE recording_media_artifacts
  ADD CONSTRAINT ck_recording_media_artifact_status
    CHECK (status IN ('uploading', 'completing', 'ready', 'failed', 'purging', 'purged'));

CREATE INDEX IF NOT EXISTS idx_recording_media_artifact_purge
  ON recording_media_artifacts(status);

COMMIT;
