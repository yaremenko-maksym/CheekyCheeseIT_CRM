-- 2026-10-18_db_grants.sql — privileges per table class (ADR §2, file 2 of §4)
--
-- GENERATED FILE. Do not edit by hand: regenerate with
--   pnpm --filter @crm/api db:privileges:generate
-- Source of truth: apps/api/src/database/privileges/privilege-classes.ts
-- Specification:   docs/architecture/2026-10-17-db-least-privilege-roles.md
--
-- Applied by deploy.yml as `psql -v ON_ERROR_STOP=1 < file`, which is statement-level
-- autocommit, so every statement below is idempotent and independently applicable.

--
-- The reset-then-grant shape is deliberate. Without the reset, a privilege granted by
-- hand on production would survive every deploy; with it, the deploy is the only thing
-- that decides privileges. The ADR's requirement that this be one transaction is what
-- makes the reset safe: privileges are catalog rows under MVCC, so no concurrent session
-- sees the window in which the roles hold nothing.
--
-- Measured on PostgreSQL 16.15 (2026-10-18): GRANT/REVOKE on a table takes NO lock on the
-- relation, so this transaction does not block API queries. `lock_timeout` is therefore
-- insurance against an unforeseen wait rather than an expected one: a deploy that cannot
-- get what it needs within 10 s fails loudly and leaves the previous, consistent state.

BEGIN;

SET LOCAL lock_timeout = '10s';

-- Fail closed if the roles file has not run: granting to a missing role would abort
-- mid-transaction anyway, but the raise names the cause and the fix.
DO $guard$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(r, ', ' ORDER BY r)
    INTO missing
    FROM (VALUES ('crm_app'), ('crm_collector'), ('crm_retention_owner')) AS v(r)
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v.r);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'db-grants: role(s) % do not exist — apply 2026-10-18_db_roles.sql first (it is the FIRST manual DDL file in the deploy order)', missing
      USING ERRCODE = '42704';
  END IF;
END
$guard$;

-- 1. Reset. Table-level first, so the column-level sweep below sees only true column
--    grants: revoking a privilege at table level does NOT revoke it at column level
--    (PostgreSQL REVOKE, "Notes"), which is why one statement cannot do both.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM crm_app, crm_collector, crm_retention_owner;

REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM crm_app, crm_collector, crm_retention_owner;

DO $columns$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT table_name, column_name, privilege_type, grantee
      FROM information_schema.column_privileges
     WHERE table_schema = 'public'
       AND grantee IN ('crm_app', 'crm_collector', 'crm_retention_owner')
  LOOP
    EXECUTE format('REVOKE %s (%I) ON TABLE public.%I FROM %I',
                   r.privilege_type, r.column_name, r.table_name, r.grantee);
  END LOOP;
END
$columns$;

-- 2. Grant back, one statement per class and role.
-- class A — Ordinary product table. The default for everything the API reads and writes.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.approvals,
  public.company_account,
  public.consumed_tx_hashes,
  public.contract_templates,
  public.csp_reports,
  public.documents,
  public.employee_contracts,
  public.interview_recordings,
  public.interviews,
  public.invoice_signatures,
  public.job_account_meter_reservations,
  public.job_account_meters,
  public.job_bridge_deliveries,
  public.job_collection_cycles,
  public.job_collection_runs,
  public.job_dirty_work,
  public.job_exclusion_filters,
  public.job_opportunities,
  public.job_opportunity_identity_tokens,
  public.job_opportunity_matches,
  public.job_opportunity_sources,
  public.job_opportunity_team_triage,
  public.job_posting_signals,
  public.job_postings,
  public.job_queue_assignments,
  public.job_queue_dismissals,
  public.job_queue_generation_entries,
  public.job_queue_generations,
  public.job_run_records,
  public.job_source_hosts,
  public.job_source_record_heads,
  public.job_source_record_inventory_misses,
  public.job_source_record_revisions,
  public.job_source_records,
  public.job_sources,
  public.job_suggestions,
  public.job_team_triage_subscriptions,
  public.job_text_blobs,
  public.legend_entries,
  public.legends,
  public.meeting_recorder_connections,
  public.meeting_recorder_webhook_receipts,
  public.notification_emails,
  public.notification_preferences,
  public.notifications,
  public.payout_requests,
  public.pending_obligations,
  public.project_credentials,
  public.project_finance_settings,
  public.project_members,
  public.projects,
  public.recording_media_artifacts,
  public.recording_media_uploads,
  public.salary_month_initializations,
  public.senior_resumes,
  public.signed_contracts,
  public.team_members,
  public.teams,
  public.telemetry_errors,
  public.telemetry_events,
  public.tos_acceptances,
  public.tos_versions,
  public.transactions,
  public.user_email_invites,
  public.user_emails,
  public.users,
  public.vacancies,
  public.vacancy_applications
  TO crm_app;
-- staged relations (drizzle/manual-staged/): granted only where they exist.
--   crm_collector: nothing.
--   crm_retention_owner: nothing.

-- class A-log — Existing audit log, not yet append-only (ADR §2). Add rows, never rewrite them.
GRANT SELECT, INSERT ON TABLE
  public.meeting_recorder_audit_log,
  public.project_audit_log,
  public.team_audit_log,
  public.transaction_audit_log,
  public.user_audit_log
  TO crm_app;
-- staged relations (drizzle/manual-staged/): granted only where they exist.
DO $staged$
BEGIN
  IF to_regclass('public.job_source_health_events') IS NOT NULL THEN
    GRANT SELECT, INSERT ON TABLE public.job_source_health_events TO crm_app;
  END IF;
END
$staged$;
--   crm_collector: nothing.
--   crm_retention_owner: nothing.

-- class A-log-prunable — Audit log the API itself prunes — DocumentAccessLogRetentionCronService.
GRANT SELECT, INSERT, DELETE ON TABLE
  public.document_access_log
  TO crm_app;
--   crm_collector: nothing.
--   crm_retention_owner: nothing.

-- class B — Append-only. UPDATE/DELETE/TRUNCATE revoked; Task 1.3b adds the ENABLE ALWAYS triggers.
GRANT SELECT, INSERT ON TABLE
  public.job_queue_actions
  TO crm_app;
--   crm_collector: nothing.
GRANT SELECT, DELETE ON TABLE
  public.job_queue_actions
  TO crm_retention_owner;

-- class C: no relations assigned. Job-sourcing table the collection worker writes. Empty until ADR §4 step 8.

-- class D: no relations assigned. Collector evaluation input: column-level SELECT only, via collectorColumns. Empty until step 8.

-- class E — Migration-internal (the ledger of ADR §6, deploy bookkeeping). The API gets nothing.
--   crm_app: nothing.
--   crm_collector: nothing.
--   crm_retention_owner: nothing.

-- class V — View. SELECT only — an auto-updatable view writes its base tables as the view owner.
GRANT SELECT ON TABLE
  public.confirmed_projects,
  public.non_deleted_transactions,
  public.visible_projects
  TO crm_app;
--   crm_collector: nothing.
--   crm_retention_owner: nothing.

-- 3. Class D column-level SELECT for crm_collector. A table-level grant would
--    silently cover every column, including credentials and finance columns, so class D
--    carries no table-level SELECT and the columns are named one by one.
--    No class D table is assigned yet (ADR §4 step 8).

-- 3b. The ONLY non-SELECT column-level grants the model admits (owner decisions 2 and 3,
--    2026-10-22). The redaction rewrites ONE column of the subject row and writes SIX
--    columns of its evidence row, and gets exactly those — never table-level UPDATE or
--    INSERT. Part 3 of the check admits exactly these tuples and still reports every other
--    column-level write.
--    The failing runs that justify them (r5 Task 1.4b-iii; PostgreSQL 16.15, scratch
--    database, 2026-10-22 and 2026-10-23), calling
--    SELECT crm_retention_redact_action_reason(<action id>, 'dsr-failrun', <actor id>):
--      with SELECT, DELETE only             -> SQLSTATE 42501 "permission denied for table
--                                              job_queue_actions" at the function's UPDATE
--      plus UPDATE (reason)                 -> SQLSTATE 42501, same message, now at the
--                                              function's INSERT of the evidence row; the
--                                              redaction rolled back with it
--      plus INSERT on the six columns below -> true: reason redacted, one REASON_REDACTED row
--      ...and each of the six removed singly -> SQLSTATE 42501 again, so all six are needed
--    Full record, including the two columns proven NOT needed: privilege-classes.ts,
--    RETENTION_OWNER_COLUMN_WRITE_GRANTS.
GRANT UPDATE (reason) ON TABLE public.job_queue_actions TO crm_retention_owner;
GRANT INSERT (kind, subject_action_id, actor_id, scope_kind, team_id, idempotency_key) ON TABLE public.job_queue_actions TO crm_retention_owner;

-- 4. Sequences. crm_app calls nextval and reads currval; never UPDATE, which is
--    setval — the ability to rewind a sequence and collide ids (ADR §2, "Sequences").
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO crm_app;

-- crm_collector: USAGE only on the sequences of its class C tables. No class C
--    table is assigned yet, so no sequence grant is issued — fail closed.

COMMIT;
