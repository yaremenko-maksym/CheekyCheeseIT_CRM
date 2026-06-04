-- Migration 0029: Corrective fix for orphaned FK references left by the
-- original (pre-fix) 0028_admin_uuid_normalize migration.
--
-- Background: The original 0028 used DISABLE TRIGGER ALL which bypassed FK
-- enforcement. When DELETE FROM users removed the old nil-UUID admin rows,
-- Postgres did not cascade-update or cascade-delete child rows that still
-- pointed to the deleted IDs. This left orphaned references in at least:
--   - documents.owner_id   (13 rows pointing to ...000000000001)
--   - projects.senior_id   (4 rows pointing to ...000000000001)
--
-- This migration is IDEMPOTENT — all WHERE clauses filter on the nil-UUID
-- values (which no longer exist as users after 0028). Re-running on a
-- database where 0028 ran correctly (no orphans) is a no-op.
--
-- Target environment: existing installs where 0028 already ran with the
-- broken DISABLE TRIGGER ALL variant. Fresh installs that apply the fixed
-- 0028 will have zero orphans; this migration will execute 0 UPDATE rows.
--
-- Confirmed orphan distribution (live crm_db, 2026-06-04):
--   documents.owner_id = '00000000-...-000001'  → 13 rows → fix → a8f4d3b1-...
--   projects.senior_id = '00000000-...-000001'  → 4 rows  → fix → a8f4d3b1-...
--   All other FK columns verified 0 orphans (postgres MCP query).
--
-- We still include UPDATE statements for both admin UUIDs (...001 and ...002)
-- across all known FK columns from the FK query — covers any prod environment
-- that may differ from the audited crm_db snapshot.

BEGIN;

-- documents.owner_id — was orphaned (13 rows on ...001 in live DB)
UPDATE documents SET owner_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE owner_id = '00000000-0000-0000-0000-000000000001';
UPDATE documents SET owner_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE owner_id = '00000000-0000-0000-0000-000000000002';

-- documents.uploaded_by
UPDATE documents SET uploaded_by = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE uploaded_by = '00000000-0000-0000-0000-000000000001';
UPDATE documents SET uploaded_by = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE uploaded_by = '00000000-0000-0000-0000-000000000002';

-- documents.deleted_by
UPDATE documents SET deleted_by = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE deleted_by = '00000000-0000-0000-0000-000000000001';
UPDATE documents SET deleted_by = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE deleted_by = '00000000-0000-0000-0000-000000000002';

-- projects.senior_id — was orphaned (4 rows on ...001 in live DB)
UPDATE projects SET senior_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE senior_id = '00000000-0000-0000-0000-000000000001';
UPDATE projects SET senior_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE senior_id = '00000000-0000-0000-0000-000000000002';

-- projects.drop_id (delete_rule = RESTRICT — must not leave dangling)
UPDATE projects SET drop_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE drop_id = '00000000-0000-0000-0000-000000000001';
UPDATE projects SET drop_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE drop_id = '00000000-0000-0000-0000-000000000002';

-- interviews.senior_id
UPDATE interviews SET senior_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE senior_id = '00000000-0000-0000-0000-000000000001';
UPDATE interviews SET senior_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE senior_id = '00000000-0000-0000-0000-000000000002';

-- interviews.hr_id
UPDATE interviews SET hr_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE hr_id = '00000000-0000-0000-0000-000000000001';
UPDATE interviews SET hr_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE hr_id = '00000000-0000-0000-0000-000000000002';

-- team_members.user_id
UPDATE team_members SET user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE user_id = '00000000-0000-0000-0000-000000000001';
UPDATE team_members SET user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE user_id = '00000000-0000-0000-0000-000000000002';

-- project_members.user_id
UPDATE project_members SET user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE user_id = '00000000-0000-0000-0000-000000000001';
UPDATE project_members SET user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE user_id = '00000000-0000-0000-0000-000000000002';

-- project_finance_settings.updated_by
UPDATE project_finance_settings SET updated_by = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE updated_by = '00000000-0000-0000-0000-000000000001';
UPDATE project_finance_settings SET updated_by = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE updated_by = '00000000-0000-0000-0000-000000000002';

-- pending_obligations.creditor_user_id
UPDATE pending_obligations SET creditor_user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE creditor_user_id = '00000000-0000-0000-0000-000000000001';
UPDATE pending_obligations SET creditor_user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE creditor_user_id = '00000000-0000-0000-0000-000000000002';

-- pending_obligations.debtor_user_id
UPDATE pending_obligations SET debtor_user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE debtor_user_id = '00000000-0000-0000-0000-000000000001';
UPDATE pending_obligations SET debtor_user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE debtor_user_id = '00000000-0000-0000-0000-000000000002';

-- transactions.created_by
UPDATE transactions SET created_by = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE created_by = '00000000-0000-0000-0000-000000000001';
UPDATE transactions SET created_by = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE created_by = '00000000-0000-0000-0000-000000000002';

-- transactions.recipient_id
UPDATE transactions SET recipient_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE recipient_id = '00000000-0000-0000-0000-000000000001';
UPDATE transactions SET recipient_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE recipient_id = '00000000-0000-0000-0000-000000000002';

-- transactions.receiver_id
UPDATE transactions SET receiver_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE receiver_id = '00000000-0000-0000-0000-000000000001';
UPDATE transactions SET receiver_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE receiver_id = '00000000-0000-0000-0000-000000000002';

-- transactions.sender_id
UPDATE transactions SET sender_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE sender_id = '00000000-0000-0000-0000-000000000001';
UPDATE transactions SET sender_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE sender_id = '00000000-0000-0000-0000-000000000002';

-- transactions.validated_by
UPDATE transactions SET validated_by = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE validated_by = '00000000-0000-0000-0000-000000000001';
UPDATE transactions SET validated_by = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE validated_by = '00000000-0000-0000-0000-000000000002';

-- payout_requests.senior_id
UPDATE payout_requests SET senior_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE senior_id = '00000000-0000-0000-0000-000000000001';
UPDATE payout_requests SET senior_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE senior_id = '00000000-0000-0000-0000-000000000002';

-- contract_templates.created_by_user_id
UPDATE contract_templates SET created_by_user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE created_by_user_id = '00000000-0000-0000-0000-000000000001';
UPDATE contract_templates SET created_by_user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE created_by_user_id = '00000000-0000-0000-0000-000000000002';

-- tos_versions.created_by_user_id
UPDATE tos_versions SET created_by_user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE created_by_user_id = '00000000-0000-0000-0000-000000000001';
UPDATE tos_versions SET created_by_user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE created_by_user_id = '00000000-0000-0000-0000-000000000002';

-- signed_contracts.user_id
UPDATE signed_contracts SET user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE user_id = '00000000-0000-0000-0000-000000000001';
UPDATE signed_contracts SET user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE user_id = '00000000-0000-0000-0000-000000000002';

-- tos_acceptances.user_id
UPDATE tos_acceptances SET user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE user_id = '00000000-0000-0000-0000-000000000001';
UPDATE tos_acceptances SET user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE user_id = '00000000-0000-0000-0000-000000000002';

-- invoice_signatures.signer_id
UPDATE invoice_signatures SET signer_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE signer_id = '00000000-0000-0000-0000-000000000001';
UPDATE invoice_signatures SET signer_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE signer_id = '00000000-0000-0000-0000-000000000002';

-- notifications.user_id
UPDATE notifications SET user_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE user_id = '00000000-0000-0000-0000-000000000001';
UPDATE notifications SET user_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE user_id = '00000000-0000-0000-0000-000000000002';

-- user_audit_log.actor_id
UPDATE user_audit_log SET actor_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE actor_id = '00000000-0000-0000-0000-000000000001';
UPDATE user_audit_log SET actor_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE actor_id = '00000000-0000-0000-0000-000000000002';

-- user_audit_log.target_id
UPDATE user_audit_log SET target_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE target_id = '00000000-0000-0000-0000-000000000001';
UPDATE user_audit_log SET target_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE target_id = '00000000-0000-0000-0000-000000000002';

-- team_audit_log.actor_id
UPDATE team_audit_log SET actor_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE actor_id = '00000000-0000-0000-0000-000000000001';
UPDATE team_audit_log SET actor_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE actor_id = '00000000-0000-0000-0000-000000000002';

-- project_audit_log.actor_id
UPDATE project_audit_log SET actor_id = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
  WHERE actor_id = '00000000-0000-0000-0000-000000000001';
UPDATE project_audit_log SET actor_id = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'
  WHERE actor_id = '00000000-0000-0000-0000-000000000002';

COMMIT;
