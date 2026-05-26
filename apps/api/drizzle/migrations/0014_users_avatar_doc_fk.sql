-- 0014_users_avatar_doc_fk.sql
--
-- Avatar storage migration (PHASE 6 integration):
--   1. Rename `users.avatar` → `users.avatar_url` (semantic clarity — Google
--      fallback URL, not the custom upload).
--   2. Add `users.avatar_document_id` FK → documents(id) for S3-backed avatars.
--      ON DELETE SET NULL so hard-deleting an AVATAR document naturally
--      reverts the user to the Google fallback.
--   3. Drop legacy `users.avatar_override` (column was holding either https
--      URL or data:image base64; both flows are replaced by documents).
--
-- Render priority on the front-end becomes:
--     avatar_document_id  →  avatar_url  →  initials
--
-- Fresh-DB strategy (no backfill of base64 overrides): per pm-brief.md
-- (`docker-compose down -v` allowed), so we drop avatar_override without
-- migrating its contents. Seed re-creates the same accounts with the new
-- columns populated.

ALTER TABLE users RENAME COLUMN avatar TO avatar_url;
ALTER TABLE users ADD COLUMN avatar_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE users DROP COLUMN avatar_override;

CREATE INDEX idx_users_avatar_doc ON users(avatar_document_id) WHERE avatar_document_id IS NOT NULL;
