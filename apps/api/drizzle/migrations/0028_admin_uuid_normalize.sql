-- Migration 0028: Normalize seed admin UUIDs to RFC 4122 v4 compliant values.
--
-- Root cause: seed admin rows used nil-UUID-shaped IDs
--   '00000000-0000-0000-0000-000000000001' (Maksym)
--   '00000000-0000-0000-0000-000000000002' (Kostya)
-- These fail Zod v4 z.string().uuid() validation (version nibble must be 4,
-- variant bits must be 10xx) which broke GET /api/onboarding/status (HTTP 400).
--
-- Strategy:
--   1. Temporarily drop the email unique constraint, insert new rows, restore it.
--      This handles the case where email is still tied to the old UUID row.
--   2. UPDATE all FK references from old IDs → new IDs.
--   3. DELETE old admin rows.
--
-- Idempotency: INSERT uses WHERE NOT EXISTS so re-running inserts nothing if
-- new UUIDs already exist.
--
-- New deterministic v4 UUIDs:
--   Maksym: a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21
--   Kostya: b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- Step 0: Temporarily disable the email unique constraint to allow duplicate
-- email during the window where both old and new UUID rows coexist.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE users DISABLE TRIGGER ALL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_unique;

-- ────────────────────────────────────────────────────────────────────────────
-- Step 1: Insert new v4 UUID rows (idempotent via WHERE NOT EXISTS on id).
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO users (
  id, email, display_name, avatar_url, role, google_id,
  telegram, phone, senior_share_percent, monthly_salary,
  created_at, updated_at, payment_method,
  wallet_usdt_erc20, wallet_usdt_label,
  bank_uah_recipient, bank_uah_iban, bank_uah_rnokpp, bank_uah_bank_name,
  archived_at, admin_note, tech_stack, salary_currency,
  avatar_document_id, drop_share_percent
)
SELECT
  'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21',
  email, display_name, avatar_url, role, google_id,
  telegram, phone, senior_share_percent, monthly_salary,
  created_at, updated_at, payment_method,
  wallet_usdt_erc20, wallet_usdt_label,
  bank_uah_recipient, bank_uah_iban, bank_uah_rnokpp, bank_uah_bank_name,
  archived_at, admin_note, tech_stack, salary_currency,
  avatar_document_id, drop_share_percent
FROM users
WHERE id = '00000000-0000-0000-0000-000000000001'
  AND NOT EXISTS (
    SELECT 1 FROM users WHERE id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  );

INSERT INTO users (
  id, email, display_name, avatar_url, role, google_id,
  telegram, phone, senior_share_percent, monthly_salary,
  created_at, updated_at, payment_method,
  wallet_usdt_erc20, wallet_usdt_label,
  bank_uah_recipient, bank_uah_iban, bank_uah_rnokpp, bank_uah_bank_name,
  archived_at, admin_note, tech_stack, salary_currency,
  avatar_document_id, drop_share_percent
)
SELECT
  'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32',
  email, display_name, avatar_url, role, google_id,
  telegram, phone, senior_share_percent, monthly_salary,
  created_at, updated_at, payment_method,
  wallet_usdt_erc20, wallet_usdt_label,
  bank_uah_recipient, bank_uah_iban, bank_uah_rnokpp, bank_uah_bank_name,
  archived_at, admin_note, tech_stack, salary_currency,
  avatar_document_id, drop_share_percent
FROM users
WHERE id = '00000000-0000-0000-0000-000000000002'
  AND NOT EXISTS (
    SELECT 1 FROM users WHERE id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  );

-- ────────────────────────────────────────────────────────────────────────────
-- Step 2: Update all FK references to point to new UUIDs.
-- ────────────────────────────────────────────────────────────────────────────

UPDATE contract_templates SET created_by_user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE created_by_user_id = '00000000-0000-0000-0000-000000000001';
UPDATE contract_templates SET created_by_user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE created_by_user_id = '00000000-0000-0000-0000-000000000002';

UPDATE tos_versions SET created_by_user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE created_by_user_id = '00000000-0000-0000-0000-000000000001';
UPDATE tos_versions SET created_by_user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE created_by_user_id = '00000000-0000-0000-0000-000000000002';

UPDATE signed_contracts SET user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE user_id = '00000000-0000-0000-0000-000000000001';
UPDATE signed_contracts SET user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE user_id = '00000000-0000-0000-0000-000000000002';

UPDATE tos_acceptances SET user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE user_id = '00000000-0000-0000-0000-000000000001';
UPDATE tos_acceptances SET user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE user_id = '00000000-0000-0000-0000-000000000002';

UPDATE invoice_signatures SET signer_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE signer_id = '00000000-0000-0000-0000-000000000001';
UPDATE invoice_signatures SET signer_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE signer_id = '00000000-0000-0000-0000-000000000002';

UPDATE documents SET uploaded_by = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE uploaded_by = '00000000-0000-0000-0000-000000000001';
UPDATE documents SET uploaded_by = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE uploaded_by = '00000000-0000-0000-0000-000000000002';

-- transactions: created_by (CASCADE), receiver_id / sender_id / validated_by (SET NULL)
UPDATE transactions SET created_by = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE created_by = '00000000-0000-0000-0000-000000000001';
UPDATE transactions SET created_by = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE created_by = '00000000-0000-0000-0000-000000000002';

UPDATE transactions SET receiver_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE receiver_id = '00000000-0000-0000-0000-000000000001';
UPDATE transactions SET receiver_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE receiver_id = '00000000-0000-0000-0000-000000000002';

UPDATE transactions SET sender_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE sender_id = '00000000-0000-0000-0000-000000000001';
UPDATE transactions SET sender_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE sender_id = '00000000-0000-0000-0000-000000000002';

UPDATE transactions SET validated_by = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE validated_by = '00000000-0000-0000-0000-000000000001';
UPDATE transactions SET validated_by = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE validated_by = '00000000-0000-0000-0000-000000000002';

UPDATE payout_requests SET senior_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE senior_id = '00000000-0000-0000-0000-000000000001';
UPDATE payout_requests SET senior_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE senior_id = '00000000-0000-0000-0000-000000000002';

UPDATE user_audit_log SET actor_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE actor_id = '00000000-0000-0000-0000-000000000001';
UPDATE user_audit_log SET actor_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE actor_id = '00000000-0000-0000-0000-000000000002';
UPDATE user_audit_log SET target_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE target_id = '00000000-0000-0000-0000-000000000001';
UPDATE user_audit_log SET target_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE target_id = '00000000-0000-0000-0000-000000000002';

UPDATE team_audit_log SET actor_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE actor_id = '00000000-0000-0000-0000-000000000001';
UPDATE team_audit_log SET actor_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE actor_id = '00000000-0000-0000-0000-000000000002';

UPDATE project_audit_log SET actor_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE actor_id = '00000000-0000-0000-0000-000000000001';
UPDATE project_audit_log SET actor_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE actor_id = '00000000-0000-0000-0000-000000000002';

UPDATE notifications SET user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE user_id = '00000000-0000-0000-0000-000000000001';
UPDATE notifications SET user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE user_id = '00000000-0000-0000-0000-000000000002';

-- ────────────────────────────────────────────────────────────────────────────
-- Step 3: Delete old nil-UUID admin rows.
-- ────────────────────────────────────────────────────────────────────────────

DELETE FROM users
WHERE id IN (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002'
);

-- ────────────────────────────────────────────────────────────────────────────
-- Step 4: Restore email unique constraint and triggers.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email);
ALTER TABLE users ENABLE TRIGGER ALL;

COMMIT;
