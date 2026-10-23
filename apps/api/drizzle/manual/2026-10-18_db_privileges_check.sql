-- 2026-10-18_db_privileges_check.sql — the catalog check of ADR §2 — nine parts, read-only
--
-- GENERATED FILE. Do not edit by hand: regenerate with
--   pnpm --filter @crm/api db:privileges:generate
-- Source of truth: apps/api/src/database/privileges/privilege-classes.ts
-- Specification:   docs/architecture/2026-10-17-db-least-privilege-roles.md
--
-- Applied by deploy.yml as `psql -v ON_ERROR_STOP=1 < file`, which is statement-level
-- autocommit, so every statement below is idempotent and independently applicable.

--
-- Read-only: it asserts, it never repairs. A failure means the database and the reviewed
-- declaration disagree, and the fix is a PR, not a hand-made GRANT (ADR §4, "Rollback").
--
-- WHICH ROLE THIS IS DESIGNED FOR, AND WHY IT IS NOT A CHOICE MADE HERE
-- The deploy applies every DDL file as the migration role, and on production that role is
-- `crm_user`, a SUPERUSER and the only non-system role in the cluster (read from production
-- 2026-10-18). That matters for part 8, because PostgreSQL 16's automatic creator-membership
-- applies ONLY to a non-superuser with CREATEROLE. Measured both ways on 16.15, same cluster,
-- same statements:
--   creator is a superuser (production)        -> 0 membership rows for the created role
--   creator is non-superuser with CREATEROLE   -> 1 row, admin=t inherit=f set=f
-- So a check that hard-coded the row the ADR describes would pass in a non-superuser scratch
-- database and FAIL on the first production deploy; one that hard-coded "zero rows" would
-- fail any branch-2 deploy.
--
-- Part 8 therefore asserts neither count. It asserts the SHAPE of whatever rows exist,
-- unconditionally, plus "at most one of them" — which is satisfied by both measurements
-- above and by nothing else. An earlier revision derived the expected COUNT from the
-- migration role's current `rolsuper`, and that was wrong for a reason worth stating,
-- because it would have fired on a step the ADR itself prescribes: creator-membership is a
-- fact about WHO CREATED the role, while `rolsuper` is a fact about who the role is NOW,
-- and ADR §4's hardening step `ALTER ROLE crm_user NOSUPERUSER CREATEROLE` changes the
-- second without touching the first. On production — roles created by a superuser, so zero
-- membership rows — that step would have moved the check into the "expect exactly 1" branch
-- and failed every deploy after it, with a message whose only remedy reads
-- `GRANT crm_app TO crm_user`: the exact opposite of hardening. Production runs
-- PostgreSQL 16.14; nothing used in this file is newer than 16.0.
--
-- "The migration role" below is DERIVED, never named: it is the owner of the relations in
-- `public`. That is what makes the ADR's default-privilege trap observable — default
-- privileges apply only to objects created by the role they are attached to, so if DDL
-- ever starts running as a different role, part 5 fails instead of new tables silently
-- losing their grants.

BEGIN;

-- part 1 (manifest coverage): every relation in public is classified exactly once, and the manifest names no relation that does not exist
DO $check$
DECLARE
  offenders text;
BEGIN
  WITH declared_relations(relation, cls, optional) AS (VALUES
    ('approvals', 'A', false),
    ('company_account', 'A', false),
    ('consumed_tx_hashes', 'A', false),
    ('contract_templates', 'A', false),
    ('csp_reports', 'A', false),
    ('documents', 'A', false),
    ('employee_contracts', 'A', false),
    ('interview_recordings', 'A', false),
    ('interviews', 'A', false),
    ('invoice_signatures', 'A', false),
    ('job_account_meter_reservations', 'A', false),
    ('job_account_meters', 'A', false),
    ('job_collection_cycles', 'A', false),
    ('job_collection_runs', 'A', false),
    ('job_dirty_work', 'A', false),
    ('job_exclusion_filters', 'A', false),
    ('job_opportunities', 'A', false),
    ('job_opportunity_matches', 'A', false),
    ('job_opportunity_sources', 'A', false),
    ('job_opportunity_team_triage', 'A', false),
    ('job_posting_signals', 'A', false),
    ('job_postings', 'A', false),
    ('job_queue_assignments', 'A', false),
    ('job_queue_dismissals', 'A', false),
    ('job_queue_generation_entries', 'A', false),
    ('job_queue_generations', 'A', false),
    ('job_source_record_revisions', 'A', false),
    ('job_source_records', 'A', false),
    ('job_sources', 'A', false),
    ('job_suggestions', 'A', false),
    ('job_team_triage_subscriptions', 'A', false),
    ('job_text_blobs', 'A', false),
    ('legend_entries', 'A', false),
    ('legends', 'A', false),
    ('meeting_recorder_connections', 'A', false),
    ('meeting_recorder_webhook_receipts', 'A', false),
    ('notification_emails', 'A', false),
    ('notification_preferences', 'A', false),
    ('notifications', 'A', false),
    ('payout_requests', 'A', false),
    ('pending_obligations', 'A', false),
    ('project_credentials', 'A', false),
    ('project_finance_settings', 'A', false),
    ('project_members', 'A', false),
    ('projects', 'A', false),
    ('recording_media_artifacts', 'A', false),
    ('recording_media_uploads', 'A', false),
    ('salary_month_initializations', 'A', false),
    ('senior_resumes', 'A', false),
    ('signed_contracts', 'A', false),
    ('team_members', 'A', false),
    ('teams', 'A', false),
    ('telemetry_errors', 'A', false),
    ('telemetry_events', 'A', false),
    ('tos_acceptances', 'A', false),
    ('tos_versions', 'A', false),
    ('transactions', 'A', false),
    ('user_email_invites', 'A', false),
    ('user_emails', 'A', false),
    ('users', 'A', false),
    ('vacancies', 'A', false),
    ('vacancy_applications', 'A', false),
    ('meeting_recorder_audit_log', 'A-log', false),
    ('project_audit_log', 'A-log', false),
    ('team_audit_log', 'A-log', false),
    ('transaction_audit_log', 'A-log', false),
    ('user_audit_log', 'A-log', false),
    ('document_access_log', 'A-log-prunable', false),
    ('job_queue_actions', 'B', false),
    ('_drop_share_pending_parity_backup_20260727', 'E', true),
    ('_settle_phantom_backup_20260715', 'E', true),
    ('drop_cascade_origin_marker_state', 'E', true),
    ('salary_month_shift_backup', 'E', true),
    ('confirmed_projects', 'V', false),
    ('non_deleted_transactions', 'V', false),
    ('visible_projects', 'V', false)
  ),
  expected(relation, cls) AS (
    SELECT d.relation, d.cls
      FROM declared_relations d
      JOIN pg_class c ON c.relname = d.relation
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind IN ('r', 'p', 'v', 'm')
  )
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    SELECT format('%s is in public but in no privilege class — choose one in privilege-classes.ts', c.relname) AS detail
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm')
       AND c.relname NOT IN (SELECT relation FROM declared_relations)
    UNION ALL
    -- The other direction, minus the optional ones: a manual-DDL artefact (see
    -- MANUAL_DDL_RELATIONS) exists only where its data-fix file ran, so requiring it to be
    -- present would fail the check on every database that never needed the fix.
    SELECT format('%s is classified %s but does not exist in public', d.relation, d.cls)
      FROM declared_relations d
     WHERE NOT d.optional
       AND NOT EXISTS (
         SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = d.relation AND c.relkind IN ('r', 'p', 'v', 'm')
       )
  ) q;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'db-privileges check FAILED — part 1 (manifest coverage): %', offenders
      USING ERRCODE = '42501';
  END IF;
END
$check$;

-- part 2 (table privileges): has_table_privilege equals the class for every relation, role and privilege — no more, no less
DO $check$
DECLARE
  offenders text;
BEGIN
  WITH declared_relations(relation, cls, optional) AS (VALUES
    ('approvals', 'A', false),
    ('company_account', 'A', false),
    ('consumed_tx_hashes', 'A', false),
    ('contract_templates', 'A', false),
    ('csp_reports', 'A', false),
    ('documents', 'A', false),
    ('employee_contracts', 'A', false),
    ('interview_recordings', 'A', false),
    ('interviews', 'A', false),
    ('invoice_signatures', 'A', false),
    ('job_account_meter_reservations', 'A', false),
    ('job_account_meters', 'A', false),
    ('job_collection_cycles', 'A', false),
    ('job_collection_runs', 'A', false),
    ('job_dirty_work', 'A', false),
    ('job_exclusion_filters', 'A', false),
    ('job_opportunities', 'A', false),
    ('job_opportunity_matches', 'A', false),
    ('job_opportunity_sources', 'A', false),
    ('job_opportunity_team_triage', 'A', false),
    ('job_posting_signals', 'A', false),
    ('job_postings', 'A', false),
    ('job_queue_assignments', 'A', false),
    ('job_queue_dismissals', 'A', false),
    ('job_queue_generation_entries', 'A', false),
    ('job_queue_generations', 'A', false),
    ('job_source_record_revisions', 'A', false),
    ('job_source_records', 'A', false),
    ('job_sources', 'A', false),
    ('job_suggestions', 'A', false),
    ('job_team_triage_subscriptions', 'A', false),
    ('job_text_blobs', 'A', false),
    ('legend_entries', 'A', false),
    ('legends', 'A', false),
    ('meeting_recorder_connections', 'A', false),
    ('meeting_recorder_webhook_receipts', 'A', false),
    ('notification_emails', 'A', false),
    ('notification_preferences', 'A', false),
    ('notifications', 'A', false),
    ('payout_requests', 'A', false),
    ('pending_obligations', 'A', false),
    ('project_credentials', 'A', false),
    ('project_finance_settings', 'A', false),
    ('project_members', 'A', false),
    ('projects', 'A', false),
    ('recording_media_artifacts', 'A', false),
    ('recording_media_uploads', 'A', false),
    ('salary_month_initializations', 'A', false),
    ('senior_resumes', 'A', false),
    ('signed_contracts', 'A', false),
    ('team_members', 'A', false),
    ('teams', 'A', false),
    ('telemetry_errors', 'A', false),
    ('telemetry_events', 'A', false),
    ('tos_acceptances', 'A', false),
    ('tos_versions', 'A', false),
    ('transactions', 'A', false),
    ('user_email_invites', 'A', false),
    ('user_emails', 'A', false),
    ('users', 'A', false),
    ('vacancies', 'A', false),
    ('vacancy_applications', 'A', false),
    ('meeting_recorder_audit_log', 'A-log', false),
    ('project_audit_log', 'A-log', false),
    ('team_audit_log', 'A-log', false),
    ('transaction_audit_log', 'A-log', false),
    ('user_audit_log', 'A-log', false),
    ('document_access_log', 'A-log-prunable', false),
    ('job_queue_actions', 'B', false),
    ('_drop_share_pending_parity_backup_20260727', 'E', true),
    ('_settle_phantom_backup_20260715', 'E', true),
    ('drop_cascade_origin_marker_state', 'E', true),
    ('salary_month_shift_backup', 'E', true),
    ('confirmed_projects', 'V', false),
    ('non_deleted_transactions', 'V', false),
    ('visible_projects', 'V', false)
  ),
  expected(relation, cls) AS (
    SELECT d.relation, d.cls
      FROM declared_relations d
      JOIN pg_class c ON c.relname = d.relation
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind IN ('r', 'p', 'v', 'm')
  ),
  class_privileges(cls, role_name, privilege, expected) AS (VALUES
    ('A', 'crm_app', 'SELECT', true),
    ('A', 'crm_app', 'INSERT', true),
    ('A', 'crm_app', 'UPDATE', true),
    ('A', 'crm_app', 'DELETE', true),
    ('A', 'crm_app', 'TRUNCATE', false),
    ('A', 'crm_app', 'REFERENCES', false),
    ('A', 'crm_app', 'TRIGGER', false),
    ('A', 'crm_collector', 'SELECT', false),
    ('A', 'crm_collector', 'INSERT', false),
    ('A', 'crm_collector', 'UPDATE', false),
    ('A', 'crm_collector', 'DELETE', false),
    ('A', 'crm_collector', 'TRUNCATE', false),
    ('A', 'crm_collector', 'REFERENCES', false),
    ('A', 'crm_collector', 'TRIGGER', false),
    ('A', 'crm_retention_owner', 'SELECT', false),
    ('A', 'crm_retention_owner', 'INSERT', false),
    ('A', 'crm_retention_owner', 'UPDATE', false),
    ('A', 'crm_retention_owner', 'DELETE', false),
    ('A', 'crm_retention_owner', 'TRUNCATE', false),
    ('A', 'crm_retention_owner', 'REFERENCES', false),
    ('A', 'crm_retention_owner', 'TRIGGER', false),
    ('A-log', 'crm_app', 'SELECT', true),
    ('A-log', 'crm_app', 'INSERT', true),
    ('A-log', 'crm_app', 'UPDATE', false),
    ('A-log', 'crm_app', 'DELETE', false),
    ('A-log', 'crm_app', 'TRUNCATE', false),
    ('A-log', 'crm_app', 'REFERENCES', false),
    ('A-log', 'crm_app', 'TRIGGER', false),
    ('A-log', 'crm_collector', 'SELECT', false),
    ('A-log', 'crm_collector', 'INSERT', false),
    ('A-log', 'crm_collector', 'UPDATE', false),
    ('A-log', 'crm_collector', 'DELETE', false),
    ('A-log', 'crm_collector', 'TRUNCATE', false),
    ('A-log', 'crm_collector', 'REFERENCES', false),
    ('A-log', 'crm_collector', 'TRIGGER', false),
    ('A-log', 'crm_retention_owner', 'SELECT', false),
    ('A-log', 'crm_retention_owner', 'INSERT', false),
    ('A-log', 'crm_retention_owner', 'UPDATE', false),
    ('A-log', 'crm_retention_owner', 'DELETE', false),
    ('A-log', 'crm_retention_owner', 'TRUNCATE', false),
    ('A-log', 'crm_retention_owner', 'REFERENCES', false),
    ('A-log', 'crm_retention_owner', 'TRIGGER', false),
    ('A-log-prunable', 'crm_app', 'SELECT', true),
    ('A-log-prunable', 'crm_app', 'INSERT', true),
    ('A-log-prunable', 'crm_app', 'UPDATE', false),
    ('A-log-prunable', 'crm_app', 'DELETE', true),
    ('A-log-prunable', 'crm_app', 'TRUNCATE', false),
    ('A-log-prunable', 'crm_app', 'REFERENCES', false),
    ('A-log-prunable', 'crm_app', 'TRIGGER', false),
    ('A-log-prunable', 'crm_collector', 'SELECT', false),
    ('A-log-prunable', 'crm_collector', 'INSERT', false),
    ('A-log-prunable', 'crm_collector', 'UPDATE', false),
    ('A-log-prunable', 'crm_collector', 'DELETE', false),
    ('A-log-prunable', 'crm_collector', 'TRUNCATE', false),
    ('A-log-prunable', 'crm_collector', 'REFERENCES', false),
    ('A-log-prunable', 'crm_collector', 'TRIGGER', false),
    ('A-log-prunable', 'crm_retention_owner', 'SELECT', false),
    ('A-log-prunable', 'crm_retention_owner', 'INSERT', false),
    ('A-log-prunable', 'crm_retention_owner', 'UPDATE', false),
    ('A-log-prunable', 'crm_retention_owner', 'DELETE', false),
    ('A-log-prunable', 'crm_retention_owner', 'TRUNCATE', false),
    ('A-log-prunable', 'crm_retention_owner', 'REFERENCES', false),
    ('A-log-prunable', 'crm_retention_owner', 'TRIGGER', false),
    ('B', 'crm_app', 'SELECT', true),
    ('B', 'crm_app', 'INSERT', true),
    ('B', 'crm_app', 'UPDATE', false),
    ('B', 'crm_app', 'DELETE', false),
    ('B', 'crm_app', 'TRUNCATE', false),
    ('B', 'crm_app', 'REFERENCES', false),
    ('B', 'crm_app', 'TRIGGER', false),
    ('B', 'crm_collector', 'SELECT', false),
    ('B', 'crm_collector', 'INSERT', false),
    ('B', 'crm_collector', 'UPDATE', false),
    ('B', 'crm_collector', 'DELETE', false),
    ('B', 'crm_collector', 'TRUNCATE', false),
    ('B', 'crm_collector', 'REFERENCES', false),
    ('B', 'crm_collector', 'TRIGGER', false),
    ('B', 'crm_retention_owner', 'SELECT', true),
    ('B', 'crm_retention_owner', 'INSERT', false),
    ('B', 'crm_retention_owner', 'UPDATE', false),
    ('B', 'crm_retention_owner', 'DELETE', true),
    ('B', 'crm_retention_owner', 'TRUNCATE', false),
    ('B', 'crm_retention_owner', 'REFERENCES', false),
    ('B', 'crm_retention_owner', 'TRIGGER', false),
    ('C', 'crm_app', 'SELECT', true),
    ('C', 'crm_app', 'INSERT', true),
    ('C', 'crm_app', 'UPDATE', true),
    ('C', 'crm_app', 'DELETE', true),
    ('C', 'crm_app', 'TRUNCATE', false),
    ('C', 'crm_app', 'REFERENCES', false),
    ('C', 'crm_app', 'TRIGGER', false),
    ('C', 'crm_collector', 'SELECT', true),
    ('C', 'crm_collector', 'INSERT', true),
    ('C', 'crm_collector', 'UPDATE', true),
    ('C', 'crm_collector', 'DELETE', true),
    ('C', 'crm_collector', 'TRUNCATE', false),
    ('C', 'crm_collector', 'REFERENCES', false),
    ('C', 'crm_collector', 'TRIGGER', false),
    ('C', 'crm_retention_owner', 'SELECT', false),
    ('C', 'crm_retention_owner', 'INSERT', false),
    ('C', 'crm_retention_owner', 'UPDATE', false),
    ('C', 'crm_retention_owner', 'DELETE', false),
    ('C', 'crm_retention_owner', 'TRUNCATE', false),
    ('C', 'crm_retention_owner', 'REFERENCES', false),
    ('C', 'crm_retention_owner', 'TRIGGER', false),
    ('D', 'crm_app', 'SELECT', true),
    ('D', 'crm_app', 'INSERT', true),
    ('D', 'crm_app', 'UPDATE', true),
    ('D', 'crm_app', 'DELETE', true),
    ('D', 'crm_app', 'TRUNCATE', false),
    ('D', 'crm_app', 'REFERENCES', false),
    ('D', 'crm_app', 'TRIGGER', false),
    ('D', 'crm_collector', 'SELECT', false),
    ('D', 'crm_collector', 'INSERT', false),
    ('D', 'crm_collector', 'UPDATE', false),
    ('D', 'crm_collector', 'DELETE', false),
    ('D', 'crm_collector', 'TRUNCATE', false),
    ('D', 'crm_collector', 'REFERENCES', false),
    ('D', 'crm_collector', 'TRIGGER', false),
    ('D', 'crm_retention_owner', 'SELECT', false),
    ('D', 'crm_retention_owner', 'INSERT', false),
    ('D', 'crm_retention_owner', 'UPDATE', false),
    ('D', 'crm_retention_owner', 'DELETE', false),
    ('D', 'crm_retention_owner', 'TRUNCATE', false),
    ('D', 'crm_retention_owner', 'REFERENCES', false),
    ('D', 'crm_retention_owner', 'TRIGGER', false),
    ('E', 'crm_app', 'SELECT', false),
    ('E', 'crm_app', 'INSERT', false),
    ('E', 'crm_app', 'UPDATE', false),
    ('E', 'crm_app', 'DELETE', false),
    ('E', 'crm_app', 'TRUNCATE', false),
    ('E', 'crm_app', 'REFERENCES', false),
    ('E', 'crm_app', 'TRIGGER', false),
    ('E', 'crm_collector', 'SELECT', false),
    ('E', 'crm_collector', 'INSERT', false),
    ('E', 'crm_collector', 'UPDATE', false),
    ('E', 'crm_collector', 'DELETE', false),
    ('E', 'crm_collector', 'TRUNCATE', false),
    ('E', 'crm_collector', 'REFERENCES', false),
    ('E', 'crm_collector', 'TRIGGER', false),
    ('E', 'crm_retention_owner', 'SELECT', false),
    ('E', 'crm_retention_owner', 'INSERT', false),
    ('E', 'crm_retention_owner', 'UPDATE', false),
    ('E', 'crm_retention_owner', 'DELETE', false),
    ('E', 'crm_retention_owner', 'TRUNCATE', false),
    ('E', 'crm_retention_owner', 'REFERENCES', false),
    ('E', 'crm_retention_owner', 'TRIGGER', false),
    ('V', 'crm_app', 'SELECT', true),
    ('V', 'crm_app', 'INSERT', false),
    ('V', 'crm_app', 'UPDATE', false),
    ('V', 'crm_app', 'DELETE', false),
    ('V', 'crm_app', 'TRUNCATE', false),
    ('V', 'crm_app', 'REFERENCES', false),
    ('V', 'crm_app', 'TRIGGER', false),
    ('V', 'crm_collector', 'SELECT', false),
    ('V', 'crm_collector', 'INSERT', false),
    ('V', 'crm_collector', 'UPDATE', false),
    ('V', 'crm_collector', 'DELETE', false),
    ('V', 'crm_collector', 'TRUNCATE', false),
    ('V', 'crm_collector', 'REFERENCES', false),
    ('V', 'crm_collector', 'TRIGGER', false),
    ('V', 'crm_retention_owner', 'SELECT', false),
    ('V', 'crm_retention_owner', 'INSERT', false),
    ('V', 'crm_retention_owner', 'UPDATE', false),
    ('V', 'crm_retention_owner', 'DELETE', false),
    ('V', 'crm_retention_owner', 'TRUNCATE', false),
    ('V', 'crm_retention_owner', 'REFERENCES', false),
    ('V', 'crm_retention_owner', 'TRIGGER', false)
  )
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    SELECT format('%s (class %s): %s %s %s but should %s it',
                  e.relation, e.cls, p.role_name,
                  CASE WHEN p.expected THEN 'lacks' ELSE 'holds' END,
                  p.privilege,
                  CASE WHEN p.expected THEN 'hold' ELSE 'not hold' END) AS detail
      FROM expected e
      JOIN class_privileges p ON p.cls = e.cls
     WHERE has_table_privilege(p.role_name, format('public.%I', e.relation), p.privilege) <> p.expected
    UNION ALL
    -- WITH GRANT OPTION is never granted on any class (ADR §2): a role that may re-grant
    -- its own privileges can widen the boundary without any DDL.
    SELECT format('%s: %s holds %s WITH GRANT OPTION', e.relation, p.role_name, p.privilege)
      FROM expected e
      JOIN class_privileges p ON p.cls = e.cls
     WHERE has_table_privilege(p.role_name, format('public.%I', e.relation),
                               p.privilege || ' WITH GRANT OPTION')
  ) q;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'db-privileges check FAILED — part 2 (table privileges): %', offenders
      USING ERRCODE = '42501';
  END IF;
END
$check$;

-- part 3 (column privileges): the column-level SELECT set of EVERY one of the three roles equals the manifest exactly, and the declared non-SELECT column grants are present and are the only ones
DO $check$
DECLARE
  offenders text;
BEGIN
  WITH declared_relations(relation, cls, optional) AS (VALUES
    ('approvals', 'A', false),
    ('company_account', 'A', false),
    ('consumed_tx_hashes', 'A', false),
    ('contract_templates', 'A', false),
    ('csp_reports', 'A', false),
    ('documents', 'A', false),
    ('employee_contracts', 'A', false),
    ('interview_recordings', 'A', false),
    ('interviews', 'A', false),
    ('invoice_signatures', 'A', false),
    ('job_account_meter_reservations', 'A', false),
    ('job_account_meters', 'A', false),
    ('job_collection_cycles', 'A', false),
    ('job_collection_runs', 'A', false),
    ('job_dirty_work', 'A', false),
    ('job_exclusion_filters', 'A', false),
    ('job_opportunities', 'A', false),
    ('job_opportunity_matches', 'A', false),
    ('job_opportunity_sources', 'A', false),
    ('job_opportunity_team_triage', 'A', false),
    ('job_posting_signals', 'A', false),
    ('job_postings', 'A', false),
    ('job_queue_assignments', 'A', false),
    ('job_queue_dismissals', 'A', false),
    ('job_queue_generation_entries', 'A', false),
    ('job_queue_generations', 'A', false),
    ('job_source_record_revisions', 'A', false),
    ('job_source_records', 'A', false),
    ('job_sources', 'A', false),
    ('job_suggestions', 'A', false),
    ('job_team_triage_subscriptions', 'A', false),
    ('job_text_blobs', 'A', false),
    ('legend_entries', 'A', false),
    ('legends', 'A', false),
    ('meeting_recorder_connections', 'A', false),
    ('meeting_recorder_webhook_receipts', 'A', false),
    ('notification_emails', 'A', false),
    ('notification_preferences', 'A', false),
    ('notifications', 'A', false),
    ('payout_requests', 'A', false),
    ('pending_obligations', 'A', false),
    ('project_credentials', 'A', false),
    ('project_finance_settings', 'A', false),
    ('project_members', 'A', false),
    ('projects', 'A', false),
    ('recording_media_artifacts', 'A', false),
    ('recording_media_uploads', 'A', false),
    ('salary_month_initializations', 'A', false),
    ('senior_resumes', 'A', false),
    ('signed_contracts', 'A', false),
    ('team_members', 'A', false),
    ('teams', 'A', false),
    ('telemetry_errors', 'A', false),
    ('telemetry_events', 'A', false),
    ('tos_acceptances', 'A', false),
    ('tos_versions', 'A', false),
    ('transactions', 'A', false),
    ('user_email_invites', 'A', false),
    ('user_emails', 'A', false),
    ('users', 'A', false),
    ('vacancies', 'A', false),
    ('vacancy_applications', 'A', false),
    ('meeting_recorder_audit_log', 'A-log', false),
    ('project_audit_log', 'A-log', false),
    ('team_audit_log', 'A-log', false),
    ('transaction_audit_log', 'A-log', false),
    ('user_audit_log', 'A-log', false),
    ('document_access_log', 'A-log-prunable', false),
    ('job_queue_actions', 'B', false),
    ('_drop_share_pending_parity_backup_20260727', 'E', true),
    ('_settle_phantom_backup_20260715', 'E', true),
    ('drop_cascade_origin_marker_state', 'E', true),
    ('salary_month_shift_backup', 'E', true),
    ('confirmed_projects', 'V', false),
    ('non_deleted_transactions', 'V', false),
    ('visible_projects', 'V', false)
  ),
  expected(relation, cls) AS (
    SELECT d.relation, d.cls
      FROM declared_relations d
      JOIN pg_class c ON c.relname = d.relation
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind IN ('r', 'p', 'v', 'm')
  ),
  -- Declared column-level grants. Only the collector has any (class D is its mechanism),
  -- but the set is keyed BY ROLE, because the role is what the comparison below joins on
  -- and a one-role set is what let a column grant to either other role pass unseen: a
  -- `GRANT SELECT (id, email) ON users TO crm_retention_owner` was invisible to this
  -- part, and the next deploy's reset (its column sweep covers all three roles) then
  -- removed it with nothing reported anywhere.
  declared(role_name, relation, column_name) AS (SELECT NULL::text, NULL::text, NULL::text WHERE false),
  -- The declared non-SELECT column grants (owner decisions 2 and 3, 2026-10-22):
  -- UPDATE (reason) for the redaction's own write, and INSERT on six columns for its
  -- evidence row. All four fields of a row must match for a column privilege to be
  -- admitted below.
  declared_column_writes(role_name, relation, column_name, privilege_type) AS (VALUES
    ('crm_retention_owner', 'job_queue_actions', 'reason', 'UPDATE'),
    ('crm_retention_owner', 'job_queue_actions', 'kind', 'INSERT'),
    ('crm_retention_owner', 'job_queue_actions', 'subject_action_id', 'INSERT'),
    ('crm_retention_owner', 'job_queue_actions', 'actor_id', 'INSERT'),
    ('crm_retention_owner', 'job_queue_actions', 'scope_kind', 'INSERT'),
    ('crm_retention_owner', 'job_queue_actions', 'team_id', 'INSERT'),
    ('crm_retention_owner', 'job_queue_actions', 'idempotency_key', 'INSERT')),
  -- Which (role, class) pairs carry a table-level SELECT. information_schema.column_privileges
  -- expands a TABLE-level grant into one row per column, so the expected set is "every
  -- column of a relation whose class grants table-level SELECT to THAT role" plus the
  -- declared column-level grants. Comparing against the declared list alone would read a
  -- table-level grant as drift on every class A table; comparing only the other way would
  -- miss a stray column grant.
  role_table_select(role_name, cls) AS (VALUES
    ('crm_app', 'A'),
    ('crm_app', 'A-log'),
    ('crm_app', 'A-log-prunable'),
    ('crm_app', 'B'),
    ('crm_retention_owner', 'B'),
    ('crm_app', 'C'),
    ('crm_collector', 'C'),
    ('crm_app', 'D'),
    ('crm_app', 'V')),
  expected_pairs(role_name, relation, column_name) AS (
    SELECT rts.role_name, c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN expected e ON e.relation = c.table_name
      JOIN role_table_select rts ON rts.cls = e.cls
     WHERE c.table_schema = 'public'
    UNION
    SELECT role_name, relation, column_name FROM declared
  )
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    SELECT format('%s has column SELECT on %s.%s, which the manifest does not declare',
                  cp.grantee, cp.table_name, cp.column_name) AS detail
      FROM information_schema.column_privileges cp
     WHERE cp.table_schema = 'public'
       AND cp.grantee IN ('crm_app', 'crm_collector', 'crm_retention_owner')
       AND cp.privilege_type = 'SELECT'
       AND NOT EXISTS (SELECT 1 FROM expected_pairs e
                        WHERE e.role_name = cp.grantee
                          AND e.relation = cp.table_name AND e.column_name = cp.column_name)
    UNION ALL
    SELECT format('%s lacks the declared column SELECT on %s.%s',
                  e.role_name, e.relation, e.column_name)
      FROM expected_pairs e
     WHERE NOT EXISTS (SELECT 1 FROM information_schema.column_privileges cp
                        WHERE cp.table_schema = 'public' AND cp.grantee = e.role_name
                          AND cp.privilege_type = 'SELECT'
                          AND cp.table_name = e.relation AND cp.column_name = e.column_name)
    UNION ALL
    -- Any privilege other than SELECT, at column level, for any of the three roles —
    -- except a row of declared_column_writes. All four fields must match for the
    -- exemption to apply: the same privilege on another column, or on a declared column
    -- for another role, is reported.
    --
    -- The has_table_privilege test is what distinguishes a TRUE column grant from the
    -- per-column expansion of a table-level grant. Measured on 16.15 (2026-10-23): with
    -- INSERT held only on six named columns, has_table_privilege(..., 'INSERT') is false
    -- and all six rows surface here — which is why the exemption has to name them.
    SELECT format('%s holds column %s on %s.%s — only SELECT is ever granted at column level',
                  cp.grantee, cp.privilege_type, cp.table_name, cp.column_name)
      FROM information_schema.column_privileges cp
      JOIN expected e ON e.relation = cp.table_name
     WHERE cp.table_schema = 'public'
       AND cp.grantee IN ('crm_app', 'crm_collector', 'crm_retention_owner')
       AND cp.privilege_type <> 'SELECT'
       AND NOT has_table_privilege(cp.grantee, format('public.%I', cp.table_name), cp.privilege_type)
       AND NOT EXISTS (SELECT 1 FROM declared_column_writes d
                        WHERE d.role_name = cp.grantee
                          AND d.relation = cp.table_name
                          AND d.column_name = cp.column_name
                          AND d.privilege_type = cp.privilege_type)
    UNION ALL
    -- ...and every declared tuple must actually be there, wherever its relation exists.
    -- Without this half, a deploy that lost a grant would pass the check and leave the
    -- redaction raising 42501 — the INERT state these exceptions exist to end — unreported.
    SELECT format('%s lacks the declared column %s on %s.%s',
                  d.role_name, d.privilege_type, d.relation, d.column_name)
      FROM declared_column_writes d
     WHERE EXISTS (SELECT 1 FROM expected e WHERE e.relation = d.relation)
       AND NOT EXISTS (SELECT 1 FROM information_schema.column_privileges cp
                        WHERE cp.table_schema = 'public'
                          AND cp.grantee = d.role_name
                          AND cp.table_name = d.relation
                          AND cp.column_name = d.column_name
                          AND cp.privilege_type = d.privilege_type)
  ) q;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'db-privileges check FAILED — part 3 (column privileges): %', offenders
      USING ERRCODE = '42501';
  END IF;
END
$check$;

-- part 4 (sequence privileges): crm_app holds USAGE and SELECT and never UPDATE; the collector holds USAGE only on its class C sequences
DO $check$
DECLARE
  offenders text;
BEGIN
  WITH declared_relations(relation, cls, optional) AS (VALUES
    ('approvals', 'A', false),
    ('company_account', 'A', false),
    ('consumed_tx_hashes', 'A', false),
    ('contract_templates', 'A', false),
    ('csp_reports', 'A', false),
    ('documents', 'A', false),
    ('employee_contracts', 'A', false),
    ('interview_recordings', 'A', false),
    ('interviews', 'A', false),
    ('invoice_signatures', 'A', false),
    ('job_account_meter_reservations', 'A', false),
    ('job_account_meters', 'A', false),
    ('job_collection_cycles', 'A', false),
    ('job_collection_runs', 'A', false),
    ('job_dirty_work', 'A', false),
    ('job_exclusion_filters', 'A', false),
    ('job_opportunities', 'A', false),
    ('job_opportunity_matches', 'A', false),
    ('job_opportunity_sources', 'A', false),
    ('job_opportunity_team_triage', 'A', false),
    ('job_posting_signals', 'A', false),
    ('job_postings', 'A', false),
    ('job_queue_assignments', 'A', false),
    ('job_queue_dismissals', 'A', false),
    ('job_queue_generation_entries', 'A', false),
    ('job_queue_generations', 'A', false),
    ('job_source_record_revisions', 'A', false),
    ('job_source_records', 'A', false),
    ('job_sources', 'A', false),
    ('job_suggestions', 'A', false),
    ('job_team_triage_subscriptions', 'A', false),
    ('job_text_blobs', 'A', false),
    ('legend_entries', 'A', false),
    ('legends', 'A', false),
    ('meeting_recorder_connections', 'A', false),
    ('meeting_recorder_webhook_receipts', 'A', false),
    ('notification_emails', 'A', false),
    ('notification_preferences', 'A', false),
    ('notifications', 'A', false),
    ('payout_requests', 'A', false),
    ('pending_obligations', 'A', false),
    ('project_credentials', 'A', false),
    ('project_finance_settings', 'A', false),
    ('project_members', 'A', false),
    ('projects', 'A', false),
    ('recording_media_artifacts', 'A', false),
    ('recording_media_uploads', 'A', false),
    ('salary_month_initializations', 'A', false),
    ('senior_resumes', 'A', false),
    ('signed_contracts', 'A', false),
    ('team_members', 'A', false),
    ('teams', 'A', false),
    ('telemetry_errors', 'A', false),
    ('telemetry_events', 'A', false),
    ('tos_acceptances', 'A', false),
    ('tos_versions', 'A', false),
    ('transactions', 'A', false),
    ('user_email_invites', 'A', false),
    ('user_emails', 'A', false),
    ('users', 'A', false),
    ('vacancies', 'A', false),
    ('vacancy_applications', 'A', false),
    ('meeting_recorder_audit_log', 'A-log', false),
    ('project_audit_log', 'A-log', false),
    ('team_audit_log', 'A-log', false),
    ('transaction_audit_log', 'A-log', false),
    ('user_audit_log', 'A-log', false),
    ('document_access_log', 'A-log-prunable', false),
    ('job_queue_actions', 'B', false),
    ('_drop_share_pending_parity_backup_20260727', 'E', true),
    ('_settle_phantom_backup_20260715', 'E', true),
    ('drop_cascade_origin_marker_state', 'E', true),
    ('salary_month_shift_backup', 'E', true),
    ('confirmed_projects', 'V', false),
    ('non_deleted_transactions', 'V', false),
    ('visible_projects', 'V', false)
  ),
  expected(relation, cls) AS (
    SELECT d.relation, d.cls
      FROM declared_relations d
      JOIN pg_class c ON c.relname = d.relation
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind IN ('r', 'p', 'v', 'm')
  ),
  sequences(seq, owning_table) AS (
    SELECT s.relname, t.relname
      FROM pg_class s
      JOIN pg_namespace n ON n.oid = s.relnamespace AND n.nspname = 'public'
      LEFT JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass
                           AND d.deptype IN ('a', 'i')
      LEFT JOIN pg_class t ON t.oid = d.refobjid
     WHERE s.relkind = 'S'
  ),
  wanted(role_name, privilege, expected_expr) AS (VALUES
    ('crm_app', 'USAGE', 'app'),
    ('crm_app', 'SELECT', 'app'),
    ('crm_app', 'UPDATE', 'never'),
    ('crm_collector', 'USAGE', 'class_c'),
    ('crm_collector', 'SELECT', 'never'),
    ('crm_collector', 'UPDATE', 'never'),
    ('crm_retention_owner', 'USAGE', 'never'),
    ('crm_retention_owner', 'SELECT', 'never'),
    ('crm_retention_owner', 'UPDATE', 'never')
  )
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    SELECT format('sequence %s: %s %s %s', s.seq, w.role_name,
                  CASE WHEN expect THEN 'lacks' ELSE 'holds' END, w.privilege) AS detail
      FROM sequences s
      CROSS JOIN wanted w
      CROSS JOIN LATERAL (
        SELECT CASE w.expected_expr
                 WHEN 'app' THEN true
                 WHEN 'never' THEN false
                 ELSE EXISTS (SELECT 1 FROM expected e
                               WHERE e.relation = s.owning_table AND e.cls = 'C')
               END AS expect
      ) x
     WHERE has_sequence_privilege(w.role_name, format('public.%I', s.seq), w.privilege) <> x.expect
  ) q;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'db-privileges check FAILED — part 4 (sequence privileges): %', offenders
      USING ERRCODE = '42501';
  END IF;
END
$check$;

-- part 5 (default privileges): pg_default_acl holds exactly the two entries the roles file sets — sequences and the function revoke, nothing on TABLES — attached to the migration role
DO $check$
DECLARE
  offenders text;
BEGIN
  WITH migration_role AS (SELECT (SELECT c.relowner::regrole::text
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      GROUP BY 1 ORDER BY count(*) DESC LIMIT 1) AS role_name),
  actual(objtype, in_public, grantee, privilege_type, grantable, defacl_role) AS (
    SELECT d.defaclobjtype, d.defaclnamespace = 'public'::regnamespace,
           a.grantee::regrole::text, a.privilege_type, a.is_grantable,
           d.defaclrole::regrole::text
      FROM pg_default_acl d, aclexplode(d.defaclacl) a
  ),
  expected(objtype, in_public, grantee, privilege_type) AS (VALUES
    -- NO 'r' (tables and views) ROW, and the absence is the assertion: a default privilege
    -- on TABLES also applies to VIEWS, and an auto-updatable view writes its base tables
    -- as the VIEW OWNER — so one would reopen every class whose point is a revoke. If one
    -- is ever added back by hand, the first branch below names it and fails the deploy.
    ('S', true, 'crm_app', 'USAGE'),
    ('S', true, 'crm_app', 'SELECT'),
    -- The functions entry carries no PUBLIC row: that absence IS the revoke, and the
    -- owner's own EXECUTE is what remains.
    ('f', false, (SELECT role_name FROM migration_role), 'EXECUTE')
  )
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    SELECT format('unexpected default privilege: %s may %s on new %s objects%s',
                  a.grantee, a.privilege_type, a.objtype,
                  CASE WHEN a.grantable THEN ' WITH GRANT OPTION' ELSE '' END) AS detail
      FROM actual a
     WHERE NOT EXISTS (SELECT 1 FROM expected e
                        WHERE e.objtype = a.objtype AND e.in_public = a.in_public
                          AND e.grantee = a.grantee AND e.privilege_type = a.privilege_type)
        OR a.grantable
    UNION ALL
    SELECT format('missing default privilege: %s should get %s on new %s objects',
                  e.grantee, e.privilege_type, e.objtype)
      FROM expected e
     WHERE NOT EXISTS (SELECT 1 FROM actual a
                        WHERE a.objtype = e.objtype AND a.in_public = e.in_public
                          AND a.grantee = e.grantee AND a.privilege_type = e.privilege_type)
    UNION ALL
    -- The trap of ADR §2: default privileges apply only to objects created by the role
    -- they are attached to. If DDL ever runs as another role, new tables silently get no
    -- grants — unless this row fails first.
    SELECT format('default privileges are attached to %s but %s owns the tables in public',
                  a.defacl_role, m.role_name)
      FROM actual a, migration_role m
     WHERE a.defacl_role <> m.role_name
  ) q;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'db-privileges check FAILED — part 5 (default privileges): %', offenders
      USING ERRCODE = '42501';
  END IF;
END
$check$;

-- part 6 (database, schema and function privileges): CONNECT on this database only, TEMPORARY and CREATE nowhere, and PUBLIC holds EXECUTE on no function in public
DO $check$
DECLARE
  offenders text;
BEGIN
  WITH roles(role_name, connects) AS (VALUES
    ('crm_app', true),
    ('crm_collector', true),
    ('crm_retention_owner', false)
  ),
  other_databases AS (
    SELECT datname FROM pg_database
     WHERE datname IN ('postgres', 'template1') AND datallowconn
  )
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    SELECT format('%s: CONNECT on %s is %s, expected %s', r.role_name, current_database(),
                  has_database_privilege(r.role_name, current_database(), 'CONNECT'), r.connects) AS detail
      FROM roles r
     WHERE has_database_privilege(r.role_name, current_database(), 'CONNECT') <> r.connects
    UNION ALL
    SELECT format('%s holds TEMPORARY on %s', r.role_name, current_database())
      FROM roles r
     WHERE has_database_privilege(r.role_name, current_database(), 'TEMPORARY')
    UNION ALL
    SELECT format('%s holds CREATE on database %s', r.role_name, current_database())
      FROM roles r
     WHERE has_database_privilege(r.role_name, current_database(), 'CREATE')
    UNION ALL
    -- The other databases of the cluster: without this, crm_app could still connect to
    -- `postgres` and create temporary tables there (ADR §2, "Database and schema").
    SELECT format('%s holds %s on database %s', r.role_name, p.privilege, d.datname)
      FROM roles r, other_databases d,
           (VALUES ('CONNECT'), ('TEMPORARY')) AS p(privilege)
     WHERE has_database_privilege(r.role_name, d.datname, p.privilege)
    UNION ALL
    SELECT format('PUBLIC holds %s on database %s', p.privilege, d.datname)
      FROM other_databases d, (VALUES ('CONNECT'), ('TEMPORARY')) AS p(privilege)
     WHERE EXISTS (
       SELECT 1 FROM pg_database db, aclexplode(COALESCE(db.datacl, acldefault('d', db.datdba))) a
        WHERE db.datname = d.datname AND a.grantee = 0 AND a.privilege_type = p.privilege
     )
    UNION ALL
    SELECT format('PUBLIC holds %s on database %s', p.privilege, current_database())
      FROM (VALUES ('CONNECT'), ('TEMPORARY'), ('CREATE')) AS p(privilege)
     WHERE EXISTS (
       SELECT 1 FROM pg_database db, aclexplode(COALESCE(db.datacl, acldefault('d', db.datdba))) a
        WHERE db.datname = current_database() AND a.grantee = 0 AND a.privilege_type = p.privilege
     )
    UNION ALL
    SELECT format('%s lacks USAGE on schema public', r.role_name)
      FROM roles r
     WHERE NOT has_schema_privilege(r.role_name, 'public', 'USAGE')
    UNION ALL
    SELECT format('%s holds CREATE on schema public', r.role_name)
      FROM roles r
     WHERE has_schema_privilege(r.role_name, 'public', 'CREATE')
    UNION ALL
    SELECT 'PUBLIC holds CREATE on schema public'
     WHERE EXISTS (
       SELECT 1 FROM pg_namespace n, aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
        WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE'
     )
    UNION ALL
    -- A NULL proacl means the DEFAULT acl, which grants EXECUTE to PUBLIC — so the
    -- COALESCE is the whole point: without it a brand-new function reads as locked down.
    SELECT format('PUBLIC holds EXECUTE on function public.%s', p.proname)
      FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.pronamespace = 'public'::regnamespace
       AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) q;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'db-privileges check FAILED — part 6 (database, schema and function privileges): %', offenders
      USING ERRCODE = '42501';
  END IF;
END
$check$;

-- part 7 (role attributes and ownership): the three roles are unprivileged, own nothing beyond what is declared, and have the declared connection limits
DO $check$
DECLARE
  offenders text;
BEGIN
  WITH wanted(role_name, can_login, conn_limit) AS (VALUES
    ('crm_app', true, 30),
    ('crm_collector', true, 10),
    ('crm_retention_owner', false, 0)
  ),
  declared_functions(proname) AS (SELECT 'crm_retention_purge_job_queue_actions'
    UNION ALL
    SELECT 'crm_retention_redact_action_reason')
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    SELECT format('role %s does not exist', w.role_name) AS detail
      FROM wanted w
     WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = w.role_name)
    UNION ALL
    SELECT format('role %s has attribute %s', r.rolname, a.attribute)
      FROM pg_roles r
      JOIN wanted w ON w.role_name = r.rolname
      CROSS JOIN LATERAL (VALUES
        ('SUPERUSER', r.rolsuper), ('CREATEROLE', r.rolcreaterole),
        ('CREATEDB', r.rolcreatedb), ('BYPASSRLS', r.rolbypassrls),
        ('REPLICATION', r.rolreplication)
      ) AS a(attribute, held)
     WHERE a.held
    UNION ALL
    SELECT format('role %s: rolcanlogin is %s, expected %s', r.rolname, r.rolcanlogin, w.can_login)
      FROM pg_roles r JOIN wanted w ON w.role_name = r.rolname
     WHERE r.rolcanlogin <> w.can_login
    UNION ALL
    SELECT format('role %s: CONNECTION LIMIT is %s, expected %s', r.rolname, r.rolconnlimit, w.conn_limit)
      FROM pg_roles r JOIN wanted w ON w.role_name = r.rolname
     WHERE r.rolconnlimit <> w.conn_limit
    UNION ALL
    SELECT format('role %s owns relation %s', c.relowner::regrole::text, c.relname)
      FROM pg_class c JOIN wanted w ON w.role_name = c.relowner::regrole::text
    UNION ALL
    SELECT format('role %s owns schema %s', n.nspowner::regrole::text, n.nspname)
      FROM pg_namespace n JOIN wanted w ON w.role_name = n.nspowner::regrole::text
    UNION ALL
    -- The retention owner will own exactly the declared functions (Task 1.3b). Until then
    -- the declared list is empty, so this pins "owns nothing" and the PR that adds a
    -- function must add its name to the manifest in the same diff.
    SELECT format('role %s owns function %s, which the manifest does not declare',
                  p.proowner::regrole::text, p.proname)
      FROM pg_proc p JOIN wanted w ON w.role_name = p.proowner::regrole::text
     WHERE p.proname NOT IN (SELECT proname FROM declared_functions)
    UNION ALL
    SELECT format('declared function %s is not owned by %s', f.proname, 'crm_retention_owner')
      FROM declared_functions f
     WHERE NOT EXISTS (SELECT 1 FROM pg_proc p
                        WHERE p.proname = f.proname
                          AND p.proowner::regrole::text = 'crm_retention_owner')
  ) q;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'db-privileges check FAILED — part 7 (role attributes and ownership): %', offenders
      USING ERRCODE = '42501';
  END IF;
END
$check$;

-- part 8 (role membership): the three roles are members of no role; the only membership OF them is one creator-membership row of the exact shape PostgreSQL 16 produces
DO $check$
DECLARE
  offenders text;
BEGIN
  WITH wanted(role_name) AS (VALUES ('crm_app'), ('crm_collector'), ('crm_retention_owner')),
  migration_role AS (SELECT (SELECT c.relowner::regrole::text
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      GROUP BY 1 ORDER BY count(*) DESC LIMIT 1) AS role_name)
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    -- The direction that matters: membership is what would let these roles SET ROLE to an
    -- owner and get ownership back.
    SELECT format('%s is a member of %s — it must be a member of no role',
                  m.member::regrole::text, m.roleid::regrole::text) AS detail
      FROM pg_auth_members m
      JOIN wanted w ON w.role_name = m.member::regrole::text
    UNION ALL
    -- The other direction, asserted by SHAPE and never by count. On PostgreSQL 16 a
    -- non-superuser with CREATEROLE is automatically made a member of every role it
    -- creates, with ADMIN and without INHERIT or SET (reproduced on 16.15, 2026-10-18),
    -- while a superuser creator produces no row at all. Both are legitimate, both are
    -- allowed here, and ZERO rows is therefore not an error — which is what keeps this
    -- part quiet through ADR §4's `ALTER ROLE crm_user NOSUPERUSER CREATEROLE` on a
    -- cluster whose roles a superuser created (see the header).
    --
    -- The row is harmless; what is not harmless is INHERIT or SET, or a member that is
    -- not the migration role. That is what this asserts on every deploy, because
    -- createrole_self_grant in the roles file constrains only the moment the grant is
    -- made: holding ADMIN, the migration role can re-grant itself WITH SET at any time.
    SELECT format('%s has member %s (admin=%s inherit=%s set=%s), which is not the creator-membership shape',
                  m.roleid::regrole::text, m.member::regrole::text,
                  m.admin_option, m.inherit_option, m.set_option)
      FROM pg_auth_members m
      JOIN wanted w ON w.role_name = m.roleid::regrole::text
      CROSS JOIN migration_role mr
     WHERE m.member::regrole::text <> mr.role_name
        OR NOT m.admin_option
        OR m.inherit_option
        OR m.set_option
    UNION ALL
    -- At most ONE such row, by arithmetic rather than by shape. What that catches is a
    -- SECOND MEMBER: measured on 16.15 (2026-10-18), a second grant of the same role to
    -- the SAME member from a different grantor is MERGED into the existing row rather
    -- than added, so "two rows" always means two members, and the row the predicate above
    -- would name is not necessarily the one that is extra. Kept for two reasons that do
    -- not depend on that measurement holding: it is arithmetic over the whole set, so it
    -- survives any narrowing of the predicate above, and it is what would catch a future
    -- PostgreSQL that records per-grantor rows for one member. Zero rows is NOT an error
    -- here — the superuser branch produces none (see the header).
    SELECT format('%s has %s membership rows, expected at most 1 (the creator-membership row)',
                  w.role_name, count(m.member))
      FROM wanted w
      LEFT JOIN pg_auth_members m ON m.roleid::regrole::text = w.role_name
     GROUP BY w.role_name
    HAVING count(m.member) > 1
  ) q;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'db-privileges check FAILED — part 8 (role membership): %', offenders
      USING ERRCODE = '42501';
  END IF;
END
$check$;

-- part 9 (append-only triggers): every class B table carries exactly its declared triggers, in the declared enabled state
DO $check$
DECLARE
  offenders text;
BEGIN
  WITH declared(table_name, trigger_name, enabled) AS (VALUES
    ('job_queue_actions', 'trg_job_queue_actions_append_only', 'A'),
    ('job_queue_actions', 'trg_job_queue_actions_no_truncate', 'A'),
    ('job_queue_actions', 'trg_job_queue_actions_created_at_now', 'A')),
  class_b(table_name) AS (SELECT 'job_queue_actions'),
  actual(table_name, trigger_name, enabled) AS (
    SELECT c.relname, t.tgname, t.tgenabled
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN class_b b ON b.table_name = c.relname
     WHERE NOT t.tgisinternal
  )
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    SELECT format('%s.%s exists but is not declared in privilege-classes.ts',
                  a.table_name, a.trigger_name) AS detail
      FROM actual a
     WHERE NOT EXISTS (SELECT 1 FROM declared d
                        WHERE d.table_name = a.table_name AND d.trigger_name = a.trigger_name)
    UNION ALL
    SELECT format('declared trigger %s.%s is missing', d.table_name, d.trigger_name)
      FROM declared d
     WHERE NOT EXISTS (SELECT 1 FROM actual a
                        WHERE a.table_name = d.table_name AND a.trigger_name = d.trigger_name)
    UNION ALL
    SELECT format('trigger %s.%s is in state %s, expected %s (A = ENABLE ALWAYS)',
                  a.table_name, a.trigger_name, a.enabled, d.enabled)
      FROM actual a
      JOIN declared d ON d.table_name = a.table_name AND d.trigger_name = a.trigger_name
     WHERE a.enabled <> d.enabled
  ) q;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'db-privileges check FAILED — part 9 (append-only triggers): %', offenders
      USING ERRCODE = '42501';
  END IF;
END
$check$;

DO $ok$
BEGIN
  RAISE NOTICE 'db-privileges check passed: % relations classified, roles %, %, %',
    76, 'crm_app', 'crm_collector', 'crm_retention_owner';
END
$ok$;

COMMIT;
