-- Migration 0028: Normalize seed admin UUIDs to RFC 4122 v4 compliant values.
--
-- Root cause: seed admin rows used nil-UUID-shaped IDs
--   '00000000-0000-0000-0000-000000000001' (Maksym)
--   '00000000-0000-0000-0000-000000000002' (Kostya)
-- These fail Zod v4 z.string().uuid() validation (version nibble must be 4,
-- variant bits must be 10xx) which broke GET /api/onboarding/status (HTTP 400).
--
-- Approach decision: INSERT + UPDATE refs + DELETE (NOT UPDATE primary key).
-- Rationale: ALL foreign keys referencing users have update_rule = NO ACTION
-- (confirmed by information_schema query on 2026-06-04). A direct UPDATE of
-- users.id would violate FK constraints and rollback. The INSERT/DELETE pattern
-- requires explicitly updating every FK column — this migration covers ALL of
-- them as determined from information_schema.referential_constraints.
--
-- Security fix (vs previous attempt): DISABLE TRIGGER ALL has been removed.
-- It caused silent orphaned references because FK enforcement was bypassed
-- during DELETE. Instead we:
--   (a) Only DROP the email unique constraint (not triggers) for the INSERT window.
--   (b) Update EVERY FK column before DELETE to guarantee no orphans.
--   (c) Add an explicit orphan-guard DO block that raises EXCEPTION if any
--       nil-UUID references remain — the transaction rolls back instead of
--       committing with broken referential integrity.
--
-- Complete FK coverage (all tables referencing users, from information_schema):
--   contract_templates.created_by_user_id  (NO ACTION / NO ACTION)
--   documents.uploaded_by                  (NO ACTION / NO ACTION)
--   documents.deleted_by                   (NO ACTION / SET NULL)    <-- pref: keep NULL semantics
--   documents.owner_id                     (NO ACTION / CASCADE)     <-- was orphaned (13 rows)
--   interviews.senior_id                   (NO ACTION / CASCADE)
--   interviews.hr_id                       (NO ACTION / SET NULL)
--   invoice_signatures.signer_id           (NO ACTION / NO ACTION)
--   notifications.user_id                  (NO ACTION / CASCADE)
--   payout_requests.senior_id              (NO ACTION / CASCADE)
--   pending_obligations.creditor_user_id   (NO ACTION / CASCADE)
--   pending_obligations.debtor_user_id     (NO ACTION / SET NULL)
--   project_audit_log.actor_id             (NO ACTION / SET NULL)
--   project_finance_settings.updated_by    (NO ACTION / SET NULL)
--   project_members.user_id                (NO ACTION / CASCADE)
--   projects.senior_id                     (NO ACTION / CASCADE)     <-- was orphaned (4 rows)
--   projects.drop_id                       (NO ACTION / RESTRICT)    <-- RESTRICT: must update before DELETE
--   signed_contracts.user_id               (NO ACTION / NO ACTION)
--   team_audit_log.actor_id                (NO ACTION / SET NULL)
--   team_members.user_id                   (NO ACTION / CASCADE)
--   tos_acceptances.user_id                (NO ACTION / NO ACTION)
--   tos_versions.created_by_user_id        (NO ACTION / NO ACTION)
--   transactions.created_by                (NO ACTION / CASCADE)
--   transactions.recipient_id              (NO ACTION / SET NULL)
--   transactions.receiver_id               (NO ACTION / SET NULL)
--   transactions.sender_id                 (NO ACTION / SET NULL)
--   transactions.validated_by              (NO ACTION / SET NULL)
--   user_audit_log.actor_id                (NO ACTION / SET NULL)
--   user_audit_log.target_id               (NO ACTION / CASCADE)
--
-- New deterministic v4 UUIDs:
--   Maksym: a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21
--   Kostya: b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32
--
-- Idempotency: INSERT uses WHERE NOT EXISTS; UPDATE WHERE = old_id (no-op when
-- already migrated); DELETE WHERE IN nil-UUIDs (no-op when already gone).

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- Step 0: Drop ONLY the email unique constraint (not triggers!) to allow the
-- transient window where both old and new UUID rows share the same email.
-- We restore it at the end. Triggers stay ENABLED throughout — FK checks
-- remain active and will catch any missed references at DELETE time.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_unique;

-- ────────────────────────────────────────────────────────────────────────────
-- Step 1: Insert new v4 UUID rows for both admins (idempotent via WHERE NOT
-- EXISTS on the new id — safe to re-run after a partial failure).
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
-- Step 2: Update ALL FK references from old nil-UUIDs to new v4 UUIDs.
-- Order: tables with RESTRICT delete_rule first (projects.drop_id), then
-- the rest. Both admins updated in each table block.
-- ────────────────────────────────────────────────────────────────────────────

-- projects.drop_id (delete_rule = RESTRICT — must update before DELETE or
-- Postgres will refuse to delete the old admin row)
UPDATE projects SET drop_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE drop_id = '00000000-0000-0000-0000-000000000001';
UPDATE projects SET drop_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE drop_id = '00000000-0000-0000-0000-000000000002';

-- projects.senior_id (delete_rule = CASCADE — orphaned 4 rows in live DB)
UPDATE projects SET senior_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE senior_id = '00000000-0000-0000-0000-000000000001';
UPDATE projects SET senior_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE senior_id = '00000000-0000-0000-0000-000000000002';

-- documents.owner_id (delete_rule = CASCADE — orphaned 13 rows in live DB)
UPDATE documents SET owner_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE owner_id = '00000000-0000-0000-0000-000000000001';
UPDATE documents SET owner_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE owner_id = '00000000-0000-0000-0000-000000000002';

-- documents.uploaded_by (delete_rule = NO ACTION)
UPDATE documents SET uploaded_by = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE uploaded_by = '00000000-0000-0000-0000-000000000001';
UPDATE documents SET uploaded_by = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE uploaded_by = '00000000-0000-0000-0000-000000000002';

-- documents.deleted_by (delete_rule = SET NULL — update non-null refs only)
UPDATE documents SET deleted_by = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE deleted_by = '00000000-0000-0000-0000-000000000001';
UPDATE documents SET deleted_by = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE deleted_by = '00000000-0000-0000-0000-000000000002';

-- interviews.senior_id (delete_rule = CASCADE)
UPDATE interviews SET senior_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE senior_id = '00000000-0000-0000-0000-000000000001';
UPDATE interviews SET senior_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE senior_id = '00000000-0000-0000-0000-000000000002';

-- interviews.hr_id (delete_rule = SET NULL)
UPDATE interviews SET hr_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE hr_id = '00000000-0000-0000-0000-000000000001';
UPDATE interviews SET hr_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE hr_id = '00000000-0000-0000-0000-000000000002';

-- team_members.user_id (delete_rule = CASCADE)
UPDATE team_members SET user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE user_id = '00000000-0000-0000-0000-000000000001';
UPDATE team_members SET user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE user_id = '00000000-0000-0000-0000-000000000002';

-- project_members.user_id (delete_rule = CASCADE)
UPDATE project_members SET user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE user_id = '00000000-0000-0000-0000-000000000001';
UPDATE project_members SET user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE user_id = '00000000-0000-0000-0000-000000000002';

-- project_finance_settings.updated_by (delete_rule = SET NULL)
UPDATE project_finance_settings SET updated_by = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE updated_by = '00000000-0000-0000-0000-000000000001';
UPDATE project_finance_settings SET updated_by = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE updated_by = '00000000-0000-0000-0000-000000000002';

-- pending_obligations.creditor_user_id (delete_rule = CASCADE)
UPDATE pending_obligations SET creditor_user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE creditor_user_id = '00000000-0000-0000-0000-000000000001';
UPDATE pending_obligations SET creditor_user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE creditor_user_id = '00000000-0000-0000-0000-000000000002';

-- pending_obligations.debtor_user_id (delete_rule = SET NULL)
UPDATE pending_obligations SET debtor_user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE debtor_user_id = '00000000-0000-0000-0000-000000000001';
UPDATE pending_obligations SET debtor_user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE debtor_user_id = '00000000-0000-0000-0000-000000000002';

-- transactions.created_by (delete_rule = CASCADE)
UPDATE transactions SET created_by = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE created_by = '00000000-0000-0000-0000-000000000001';
UPDATE transactions SET created_by = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE created_by = '00000000-0000-0000-0000-000000000002';

-- transactions.recipient_id (delete_rule = SET NULL)
UPDATE transactions SET recipient_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE recipient_id = '00000000-0000-0000-0000-000000000001';
UPDATE transactions SET recipient_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE recipient_id = '00000000-0000-0000-0000-000000000002';

-- transactions.receiver_id (delete_rule = SET NULL)
UPDATE transactions SET receiver_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE receiver_id = '00000000-0000-0000-0000-000000000001';
UPDATE transactions SET receiver_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE receiver_id = '00000000-0000-0000-0000-000000000002';

-- transactions.sender_id (delete_rule = SET NULL)
UPDATE transactions SET sender_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE sender_id = '00000000-0000-0000-0000-000000000001';
UPDATE transactions SET sender_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE sender_id = '00000000-0000-0000-0000-000000000002';

-- transactions.validated_by (delete_rule = SET NULL)
UPDATE transactions SET validated_by = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE validated_by = '00000000-0000-0000-0000-000000000001';
UPDATE transactions SET validated_by = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE validated_by = '00000000-0000-0000-0000-000000000002';

-- payout_requests.senior_id (delete_rule = CASCADE)
UPDATE payout_requests SET senior_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE senior_id = '00000000-0000-0000-0000-000000000001';
UPDATE payout_requests SET senior_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE senior_id = '00000000-0000-0000-0000-000000000002';

-- contract_templates.created_by_user_id (delete_rule = NO ACTION)
UPDATE contract_templates SET created_by_user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE created_by_user_id = '00000000-0000-0000-0000-000000000001';
UPDATE contract_templates SET created_by_user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE created_by_user_id = '00000000-0000-0000-0000-000000000002';

-- tos_versions.created_by_user_id (delete_rule = NO ACTION)
UPDATE tos_versions SET created_by_user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE created_by_user_id = '00000000-0000-0000-0000-000000000001';
UPDATE tos_versions SET created_by_user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE created_by_user_id = '00000000-0000-0000-0000-000000000002';

-- signed_contracts.user_id (delete_rule = NO ACTION)
UPDATE signed_contracts SET user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE user_id = '00000000-0000-0000-0000-000000000001';
UPDATE signed_contracts SET user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE user_id = '00000000-0000-0000-0000-000000000002';

-- tos_acceptances.user_id (delete_rule = NO ACTION)
UPDATE tos_acceptances SET user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE user_id = '00000000-0000-0000-0000-000000000001';
UPDATE tos_acceptances SET user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE user_id = '00000000-0000-0000-0000-000000000002';

-- invoice_signatures.signer_id (delete_rule = NO ACTION)
UPDATE invoice_signatures SET signer_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE signer_id = '00000000-0000-0000-0000-000000000001';
UPDATE invoice_signatures SET signer_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE signer_id = '00000000-0000-0000-0000-000000000002';

-- notifications.user_id (delete_rule = CASCADE)
UPDATE notifications SET user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE user_id = '00000000-0000-0000-0000-000000000001';
UPDATE notifications SET user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE user_id = '00000000-0000-0000-0000-000000000002';

-- user_audit_log.actor_id (delete_rule = SET NULL)
UPDATE user_audit_log SET actor_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE actor_id = '00000000-0000-0000-0000-000000000001';
UPDATE user_audit_log SET actor_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE actor_id = '00000000-0000-0000-0000-000000000002';

-- user_audit_log.target_id (delete_rule = CASCADE)
UPDATE user_audit_log SET target_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE target_id = '00000000-0000-0000-0000-000000000001';
UPDATE user_audit_log SET target_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE target_id = '00000000-0000-0000-0000-000000000002';

-- team_audit_log.actor_id (delete_rule = SET NULL)
UPDATE team_audit_log SET actor_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE actor_id = '00000000-0000-0000-0000-000000000001';
UPDATE team_audit_log SET actor_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE actor_id = '00000000-0000-0000-0000-000000000002';

-- project_audit_log.actor_id (delete_rule = SET NULL)
UPDATE project_audit_log SET actor_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE actor_id = '00000000-0000-0000-0000-000000000001';
UPDATE project_audit_log SET actor_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE actor_id = '00000000-0000-0000-0000-000000000002';

-- ────────────────────────────────────────────────────────────────────────────
-- Step 3: Orphan-guard — fail loudly if any nil-UUID references remain.
-- This runs INSIDE the transaction: if triggered, the whole txn rolls back.
-- All 28 FK columns are checked across 17 tables.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  SELECT (
    (SELECT COUNT(*) FROM documents WHERE owner_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM documents WHERE uploaded_by::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM documents WHERE deleted_by::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM projects WHERE senior_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM projects WHERE drop_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM interviews WHERE senior_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM interviews WHERE hr_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM team_members WHERE user_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM project_members WHERE user_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM project_finance_settings WHERE updated_by::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM pending_obligations WHERE creditor_user_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM pending_obligations WHERE debtor_user_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM transactions WHERE created_by::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM transactions WHERE recipient_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM transactions WHERE receiver_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM transactions WHERE sender_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM transactions WHERE validated_by::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM payout_requests WHERE senior_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM contract_templates WHERE created_by_user_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM tos_versions WHERE created_by_user_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM signed_contracts WHERE user_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM tos_acceptances WHERE user_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM invoice_signatures WHERE signer_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM notifications WHERE user_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM user_audit_log WHERE actor_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM user_audit_log WHERE target_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM team_audit_log WHERE actor_id::text LIKE '00000000-%') +
    (SELECT COUNT(*) FROM project_audit_log WHERE actor_id::text LIKE '00000000-%')
  ) INTO orphan_count;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'Migration 0028 orphan-guard: % FK references still point to nil-UUID admin rows. '
      'The migration is INCOMPLETE — transaction rolled back. '
      'Check all FK columns in the DO block above.',
      orphan_count;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Step 4: Delete old nil-UUID admin rows.
-- FK triggers are ACTIVE — if we missed any FK, Postgres raises error here
-- (NO ACTION and RESTRICT rules fire on DELETE).
-- ────────────────────────────────────────────────────────────────────────────

DELETE FROM users
WHERE id IN (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002'
);

-- ────────────────────────────────────────────────────────────────────────────
-- Step 5: Restore email unique constraint (triggers were never disabled).
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email);

COMMIT;
