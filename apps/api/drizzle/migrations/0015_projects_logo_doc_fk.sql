-- 0015_projects_logo_doc_fk.sql
--
-- Project logo storage migration (PHASE 6 integration):
--   1. Drop `projects.logo_url` (column was holding base64 data URLs from
--      the broken ReceiptField path — replaced by documents).
--   2. Add `projects.logo_document_id` FK → documents(id) for S3-backed logos.
--      ON DELETE SET NULL so hard-deleting a LOGO document falls back to a
--      placeholder.
--   3. Add `projects.logo_external_url` text — for cases like
--      "https://company.com/logo.svg" where the client already hosts the file.
--   4. Add XOR check: only one of (document, external_url) may be populated
--      at a time. Both NULL is allowed (no logo set — UI shows placeholder).
--
-- Render priority becomes:
--     logo_document_id (S3 via presigned)  →  logo_external_url  →  placeholder

ALTER TABLE projects DROP COLUMN logo_url;
ALTER TABLE projects ADD COLUMN logo_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN logo_external_url TEXT;
ALTER TABLE projects ADD CONSTRAINT chk_logo_xor CHECK (
  logo_document_id IS NULL OR logo_external_url IS NULL
);

CREATE INDEX idx_projects_logo_doc ON projects(logo_document_id) WHERE logo_document_id IS NOT NULL;
