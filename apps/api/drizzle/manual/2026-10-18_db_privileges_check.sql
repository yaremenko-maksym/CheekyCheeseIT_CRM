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
  WITH expected(relation, cls) AS (VALUES
    ('approvals', 'A'),
    ('company_account', 'A'),
    ('consumed_tx_hashes', 'A'),
    ('contract_templates', 'A'),
    ('csp_reports', 'A'),
    ('documents', 'A'),
    ('employee_contracts', 'A'),
    ('interview_recordings', 'A'),
    ('interviews', 'A'),
    ('invoice_signatures', 'A'),
    ('job_account_meter_reservations', 'A'),
    ('job_account_meters', 'A'),
    ('job_collection_cycles', 'A'),
    ('job_collection_runs', 'A'),
    ('job_dirty_work', 'A'),
    ('job_exclusion_filters', 'A'),
    ('job_opportunities', 'A'),
    ('job_opportunity_matches', 'A'),
    ('job_opportunity_sources', 'A'),
    ('job_opportunity_team_triage', 'A'),
    ('job_posting_signals', 'A'),
    ('job_postings', 'A'),
    ('job_queue_assignments', 'A'),
    ('job_queue_dismissals', 'A'),
    ('job_queue_generation_entries', 'A'),
    ('job_queue_generations', 'A'),
    ('job_source_record_revisions', 'A'),
    ('job_source_records', 'A'),
    ('job_sources', 'A'),
    ('job_suggestions', 'A'),
    ('job_team_triage_subscriptions', 'A'),
    ('job_text_blobs', 'A'),
    ('legend_entries', 'A'),
    ('legends', 'A'),
    ('meeting_recorder_connections', 'A'),
    ('meeting_recorder_webhook_receipts', 'A'),
    ('notification_emails', 'A'),
    ('notification_preferences', 'A'),
    ('notifications', 'A'),
    ('payout_requests', 'A'),
    ('pending_obligations', 'A'),
    ('project_credentials', 'A'),
    ('project_finance_settings', 'A'),
    ('project_members', 'A'),
    ('projects', 'A'),
    ('salary_month_initializations', 'A'),
    ('senior_resumes', 'A'),
    ('signed_contracts', 'A'),
    ('team_members', 'A'),
    ('teams', 'A'),
    ('telemetry_errors', 'A'),
    ('telemetry_events', 'A'),
    ('tos_acceptances', 'A'),
    ('tos_versions', 'A'),
    ('transactions', 'A'),
    ('user_email_invites', 'A'),
    ('user_emails', 'A'),
    ('users', 'A'),
    ('vacancies', 'A'),
    ('vacancy_applications', 'A'),
    ('meeting_recorder_audit_log', 'A-log'),
    ('project_audit_log', 'A-log'),
    ('team_audit_log', 'A-log'),
    ('transaction_audit_log', 'A-log'),
    ('user_audit_log', 'A-log'),
    ('document_access_log', 'A-log-prunable'),
    ('job_queue_actions', 'B'),
    ('confirmed_projects', 'V'),
    ('non_deleted_transactions', 'V'),
    ('visible_projects', 'V')
  )
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    SELECT format('%s is in public but in no privilege class — choose one in privilege-classes.ts', c.relname) AS detail
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm')
       AND c.relname NOT IN (SELECT relation FROM expected)
    UNION ALL
    SELECT format('%s is classified %s but does not exist in public', e.relation, e.cls)
      FROM expected e
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = e.relation AND c.relkind IN ('r', 'p', 'v', 'm')
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
  WITH expected(relation, cls) AS (VALUES
    ('approvals', 'A'),
    ('company_account', 'A'),
    ('consumed_tx_hashes', 'A'),
    ('contract_templates', 'A'),
    ('csp_reports', 'A'),
    ('documents', 'A'),
    ('employee_contracts', 'A'),
    ('interview_recordings', 'A'),
    ('interviews', 'A'),
    ('invoice_signatures', 'A'),
    ('job_account_meter_reservations', 'A'),
    ('job_account_meters', 'A'),
    ('job_collection_cycles', 'A'),
    ('job_collection_runs', 'A'),
    ('job_dirty_work', 'A'),
    ('job_exclusion_filters', 'A'),
    ('job_opportunities', 'A'),
    ('job_opportunity_matches', 'A'),
    ('job_opportunity_sources', 'A'),
    ('job_opportunity_team_triage', 'A'),
    ('job_posting_signals', 'A'),
    ('job_postings', 'A'),
    ('job_queue_assignments', 'A'),
    ('job_queue_dismissals', 'A'),
    ('job_queue_generation_entries', 'A'),
    ('job_queue_generations', 'A'),
    ('job_source_record_revisions', 'A'),
    ('job_source_records', 'A'),
    ('job_sources', 'A'),
    ('job_suggestions', 'A'),
    ('job_team_triage_subscriptions', 'A'),
    ('job_text_blobs', 'A'),
    ('legend_entries', 'A'),
    ('legends', 'A'),
    ('meeting_recorder_connections', 'A'),
    ('meeting_recorder_webhook_receipts', 'A'),
    ('notification_emails', 'A'),
    ('notification_preferences', 'A'),
    ('notifications', 'A'),
    ('payout_requests', 'A'),
    ('pending_obligations', 'A'),
    ('project_credentials', 'A'),
    ('project_finance_settings', 'A'),
    ('project_members', 'A'),
    ('projects', 'A'),
    ('salary_month_initializations', 'A'),
    ('senior_resumes', 'A'),
    ('signed_contracts', 'A'),
    ('team_members', 'A'),
    ('teams', 'A'),
    ('telemetry_errors', 'A'),
    ('telemetry_events', 'A'),
    ('tos_acceptances', 'A'),
    ('tos_versions', 'A'),
    ('transactions', 'A'),
    ('user_email_invites', 'A'),
    ('user_emails', 'A'),
    ('users', 'A'),
    ('vacancies', 'A'),
    ('vacancy_applications', 'A'),
    ('meeting_recorder_audit_log', 'A-log'),
    ('project_audit_log', 'A-log'),
    ('team_audit_log', 'A-log'),
    ('transaction_audit_log', 'A-log'),
    ('user_audit_log', 'A-log'),
    ('document_access_log', 'A-log-prunable'),
    ('job_queue_actions', 'B'),
    ('confirmed_projects', 'V'),
    ('non_deleted_transactions', 'V'),
    ('visible_projects', 'V')
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
    ('B', 'crm_retention_owner', 'SELECT', false),
    ('B', 'crm_retention_owner', 'INSERT', false),
    ('B', 'crm_retention_owner', 'UPDATE', false),
    ('B', 'crm_retention_owner', 'DELETE', false),
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

-- part 3 (column privileges): the collector’s column-level SELECT set equals the manifest exactly
DO $check$
DECLARE
  offenders text;
BEGIN
  WITH expected(relation, cls) AS (VALUES
    ('approvals', 'A'),
    ('company_account', 'A'),
    ('consumed_tx_hashes', 'A'),
    ('contract_templates', 'A'),
    ('csp_reports', 'A'),
    ('documents', 'A'),
    ('employee_contracts', 'A'),
    ('interview_recordings', 'A'),
    ('interviews', 'A'),
    ('invoice_signatures', 'A'),
    ('job_account_meter_reservations', 'A'),
    ('job_account_meters', 'A'),
    ('job_collection_cycles', 'A'),
    ('job_collection_runs', 'A'),
    ('job_dirty_work', 'A'),
    ('job_exclusion_filters', 'A'),
    ('job_opportunities', 'A'),
    ('job_opportunity_matches', 'A'),
    ('job_opportunity_sources', 'A'),
    ('job_opportunity_team_triage', 'A'),
    ('job_posting_signals', 'A'),
    ('job_postings', 'A'),
    ('job_queue_assignments', 'A'),
    ('job_queue_dismissals', 'A'),
    ('job_queue_generation_entries', 'A'),
    ('job_queue_generations', 'A'),
    ('job_source_record_revisions', 'A'),
    ('job_source_records', 'A'),
    ('job_sources', 'A'),
    ('job_suggestions', 'A'),
    ('job_team_triage_subscriptions', 'A'),
    ('job_text_blobs', 'A'),
    ('legend_entries', 'A'),
    ('legends', 'A'),
    ('meeting_recorder_connections', 'A'),
    ('meeting_recorder_webhook_receipts', 'A'),
    ('notification_emails', 'A'),
    ('notification_preferences', 'A'),
    ('notifications', 'A'),
    ('payout_requests', 'A'),
    ('pending_obligations', 'A'),
    ('project_credentials', 'A'),
    ('project_finance_settings', 'A'),
    ('project_members', 'A'),
    ('projects', 'A'),
    ('salary_month_initializations', 'A'),
    ('senior_resumes', 'A'),
    ('signed_contracts', 'A'),
    ('team_members', 'A'),
    ('teams', 'A'),
    ('telemetry_errors', 'A'),
    ('telemetry_events', 'A'),
    ('tos_acceptances', 'A'),
    ('tos_versions', 'A'),
    ('transactions', 'A'),
    ('user_email_invites', 'A'),
    ('user_emails', 'A'),
    ('users', 'A'),
    ('vacancies', 'A'),
    ('vacancy_applications', 'A'),
    ('meeting_recorder_audit_log', 'A-log'),
    ('project_audit_log', 'A-log'),
    ('team_audit_log', 'A-log'),
    ('transaction_audit_log', 'A-log'),
    ('user_audit_log', 'A-log'),
    ('document_access_log', 'A-log-prunable'),
    ('job_queue_actions', 'B'),
    ('confirmed_projects', 'V'),
    ('non_deleted_transactions', 'V'),
    ('visible_projects', 'V')
  ),
  declared(relation, column_name) AS (SELECT NULL::text, NULL::text WHERE false),
  -- information_schema.column_privileges expands a TABLE-level grant into one row per
  -- column, so the expected set is "every column of a relation whose class grants
  -- table-level SELECT to the collector" plus the declared column-level grants. Comparing
  -- against the declared list alone would read a table-level grant as drift on every
  -- class C table, and comparing only the other way would miss a stray column grant.
  expected_pairs(relation, column_name) AS (
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN expected e ON e.relation = c.table_name
      JOIN (VALUES ('A', false), ('A-log', false), ('A-log-prunable', false), ('B', false), ('C', true), ('D', false), ('E', false), ('V', false)) AS cp(cls, table_select) ON cp.cls = e.cls
     WHERE c.table_schema = 'public' AND cp.table_select
    UNION
    SELECT relation, column_name FROM declared
  )
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    SELECT format('%s has column SELECT on %s.%s, which the manifest does not declare',
                  'crm_collector', cp.table_name, cp.column_name) AS detail
      FROM information_schema.column_privileges cp
     WHERE cp.table_schema = 'public'
       AND cp.grantee = 'crm_collector'
       AND cp.privilege_type = 'SELECT'
       AND NOT EXISTS (SELECT 1 FROM expected_pairs e
                        WHERE e.relation = cp.table_name AND e.column_name = cp.column_name)
    UNION ALL
    SELECT format('%s lacks the declared column SELECT on %s.%s',
                  'crm_collector', e.relation, e.column_name)
      FROM expected_pairs e
     WHERE NOT EXISTS (SELECT 1 FROM information_schema.column_privileges cp
                        WHERE cp.table_schema = 'public' AND cp.grantee = 'crm_collector'
                          AND cp.privilege_type = 'SELECT'
                          AND cp.table_name = e.relation AND cp.column_name = e.column_name)
    UNION ALL
    -- Any privilege other than SELECT, at column level, for any of the three roles.
    SELECT format('%s holds column %s on %s.%s — only SELECT is ever granted at column level',
                  cp.grantee, cp.privilege_type, cp.table_name, cp.column_name)
      FROM information_schema.column_privileges cp
      JOIN expected e ON e.relation = cp.table_name
     WHERE cp.table_schema = 'public'
       AND cp.grantee IN ('crm_app', 'crm_collector', 'crm_retention_owner')
       AND cp.privilege_type <> 'SELECT'
       AND NOT has_table_privilege(cp.grantee, format('public.%I', cp.table_name), cp.privilege_type)
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
  WITH expected(relation, cls) AS (VALUES
    ('approvals', 'A'),
    ('company_account', 'A'),
    ('consumed_tx_hashes', 'A'),
    ('contract_templates', 'A'),
    ('csp_reports', 'A'),
    ('documents', 'A'),
    ('employee_contracts', 'A'),
    ('interview_recordings', 'A'),
    ('interviews', 'A'),
    ('invoice_signatures', 'A'),
    ('job_account_meter_reservations', 'A'),
    ('job_account_meters', 'A'),
    ('job_collection_cycles', 'A'),
    ('job_collection_runs', 'A'),
    ('job_dirty_work', 'A'),
    ('job_exclusion_filters', 'A'),
    ('job_opportunities', 'A'),
    ('job_opportunity_matches', 'A'),
    ('job_opportunity_sources', 'A'),
    ('job_opportunity_team_triage', 'A'),
    ('job_posting_signals', 'A'),
    ('job_postings', 'A'),
    ('job_queue_assignments', 'A'),
    ('job_queue_dismissals', 'A'),
    ('job_queue_generation_entries', 'A'),
    ('job_queue_generations', 'A'),
    ('job_source_record_revisions', 'A'),
    ('job_source_records', 'A'),
    ('job_sources', 'A'),
    ('job_suggestions', 'A'),
    ('job_team_triage_subscriptions', 'A'),
    ('job_text_blobs', 'A'),
    ('legend_entries', 'A'),
    ('legends', 'A'),
    ('meeting_recorder_connections', 'A'),
    ('meeting_recorder_webhook_receipts', 'A'),
    ('notification_emails', 'A'),
    ('notification_preferences', 'A'),
    ('notifications', 'A'),
    ('payout_requests', 'A'),
    ('pending_obligations', 'A'),
    ('project_credentials', 'A'),
    ('project_finance_settings', 'A'),
    ('project_members', 'A'),
    ('projects', 'A'),
    ('salary_month_initializations', 'A'),
    ('senior_resumes', 'A'),
    ('signed_contracts', 'A'),
    ('team_members', 'A'),
    ('teams', 'A'),
    ('telemetry_errors', 'A'),
    ('telemetry_events', 'A'),
    ('tos_acceptances', 'A'),
    ('tos_versions', 'A'),
    ('transactions', 'A'),
    ('user_email_invites', 'A'),
    ('user_emails', 'A'),
    ('users', 'A'),
    ('vacancies', 'A'),
    ('vacancy_applications', 'A'),
    ('meeting_recorder_audit_log', 'A-log'),
    ('project_audit_log', 'A-log'),
    ('team_audit_log', 'A-log'),
    ('transaction_audit_log', 'A-log'),
    ('user_audit_log', 'A-log'),
    ('document_access_log', 'A-log-prunable'),
    ('job_queue_actions', 'B'),
    ('confirmed_projects', 'V'),
    ('non_deleted_transactions', 'V'),
    ('visible_projects', 'V')
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

-- part 5 (default privileges): pg_default_acl holds exactly the three entries of ADR §2, attached to the migration role, and nothing else
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
    ('r', true, 'crm_app', 'SELECT'),
    ('r', true, 'crm_app', 'INSERT'),
    ('r', true, 'crm_app', 'UPDATE'),
    ('r', true, 'crm_app', 'DELETE'),
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
  declared_functions(proname) AS (SELECT NULL::text WHERE false)
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

-- part 8 (role membership): the three roles are members of no role; membership OF them matches the branch the migration role is in
DO $check$
DECLARE
  offenders text;
BEGIN
  WITH wanted(role_name) AS (VALUES ('crm_app'), ('crm_collector'), ('crm_retention_owner')),
  migration_role AS (SELECT (SELECT c.relowner::regrole::text
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      GROUP BY 1 ORDER BY count(*) DESC LIMIT 1) AS role_name),
  branch AS (
    SELECT COALESCE((SELECT rolsuper FROM pg_roles r, migration_role m
                      WHERE r.rolname = m.role_name), false) AS owner_is_superuser
  )
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO offenders FROM (
    -- The direction that matters: membership is what would let these roles SET ROLE to an
    -- owner and get ownership back.
    SELECT format('%s is a member of %s — it must be a member of no role',
                  m.member::regrole::text, m.roleid::regrole::text) AS detail
      FROM pg_auth_members m
      JOIN wanted w ON w.role_name = m.member::regrole::text
    UNION ALL
    -- The other direction. On PostgreSQL 16 a non-superuser with CREATEROLE is
    -- automatically made a member of every role it creates, with ADMIN and without
    -- INHERIT or SET (reproduced on 16.15, 2026-10-18) — so "zero rows" is right only
    -- when the migration role is a superuser, and demanding it in the other branch would
    -- fail every deploy. The row is harmless; what is not harmless is INHERIT or SET,
    -- and that is what this asserts on every deploy, because createrole_self_grant in
    -- the roles file constrains only the moment the grant is made: holding ADMIN, the
    -- migration role can re-grant itself WITH SET at any time.
    SELECT format('%s has member %s (admin=%s inherit=%s set=%s), which this branch does not allow',
                  m.roleid::regrole::text, m.member::regrole::text,
                  m.admin_option, m.inherit_option, m.set_option)
      FROM pg_auth_members m
      JOIN wanted w ON w.role_name = m.roleid::regrole::text
      CROSS JOIN branch b
      CROSS JOIN migration_role mr
     WHERE b.owner_is_superuser
        OR m.member::regrole::text <> mr.role_name
        OR NOT m.admin_option
        OR m.inherit_option
        OR m.set_option
    UNION ALL
    -- And exactly ONE such row, not merely one of the right shape. Two grants of the same
    -- shape from different grantors are both legal and both invisible to the predicate
    -- above, since it never looks at the grantor; a second membership grant is still a
    -- second route to this role.
    SELECT format('%s has %s membership rows, expected %s in this branch',
                  w.role_name, count(m.member),
                  CASE WHEN b.owner_is_superuser THEN 0 ELSE 1 END)
      FROM wanted w
      CROSS JOIN branch b
      LEFT JOIN pg_auth_members m ON m.roleid::regrole::text = w.role_name
     GROUP BY w.role_name, b.owner_is_superuser
    HAVING count(m.member) <> CASE WHEN b.owner_is_superuser THEN 0 ELSE 1 END
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
  WITH declared(table_name, trigger_name, enabled) AS (SELECT NULL::text, NULL::text, NULL::"char" WHERE false),
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
    70, 'crm_app', 'crm_collector', 'crm_retention_owner';
END
$ok$;

COMMIT;
