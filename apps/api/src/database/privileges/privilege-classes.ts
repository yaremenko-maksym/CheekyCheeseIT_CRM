/**
 * The privilege-class manifest — the single declarative source for BOTH the grants
 * applied to production and the catalog check that asserts them.
 *
 * Specification: `docs/architecture/2026-10-17-db-least-privilege-roles.md` §2
 * (Accepted 2026-10-17, PR #1018). Read that before changing anything here.
 *
 * WHAT THIS FILE DECIDES
 * ----------------------
 * Every relation in schema `public` is in exactly ONE class, and the class decides what
 * `crm_app` (the API) and `crm_collector` (the collection worker) may do to it. Nothing
 * else decides it: `drizzle/manual/2026-10-18_db_grants.sql` and
 * `drizzle/manual/2026-10-18_db_privileges_check.sql` are GENERATED from this file
 * (`pnpm --filter @crm/api db:privileges:generate`), so a grant and its assertion cannot
 * drift apart — only the database can drift from both, which is exactly what the check
 * is for.
 *
 * ADDING A TABLE
 * --------------
 * Put it in a class here. `privilege-classes.spec.ts` fails on an unclassified table
 * without needing a database, and the generated catalog check fails CI and the deploy
 * against a real one. The question to answer, per ADR §4 measure 3: "does any scheduled
 * job delete from or update this table?" — if yes it is class A (or A-log-prunable),
 * never class B.
 *
 * WHY `A-log-prunable` IS ITS OWN CLASS
 * -------------------------------------
 * The ADR gives the six existing audit logs `SELECT, INSERT` and adds "`DELETE` only on
 * `document_access_log` (its retention cron)". Expressed as a per-table exception that
 * would be a second mechanism the check has to understand; expressed as a class it stays
 * one uniform class -> privilege map, which is what keeps the generated check a flat
 * comparison. Same privileges as the ADR prescribes, one fewer special case.
 *
 * WHY VIEWS GET A CLASS OF THEIR OWN (an addition to the ADR, reported to the owner)
 * ---------------------------------------------------------------------------------
 * The ADR speaks of tables; `public` also holds three views, and `GRANT … ON ALL TABLES`
 * covers views too (PostgreSQL uses "table" loosely there). Leaving them out would be the
 * silent hole this design exists to close, and it would not be a harmless one: privileges
 * on the base tables of an auto-updatable view are checked against the VIEW OWNER
 * (`crm_user`), so `UPDATE` on a view is a path around a revoke on its base table. None of
 * the three views reads an audit log today (checked: `non_deleted_transactions` ->
 * `transactions`, `visible_projects` / `confirmed_projects` -> `projects`, all class A) and
 * no production code writes through a view (checked 2026-10-18: no
 * `.insert|.update|.delete(nonDeletedTransactions|visibleProjects|confirmedProjects)`
 * outside specs), so `SELECT` only costs nothing and closes the path by construction.
 */

/** The three roles this model grants to. `crm_user` stays the owner / migration role. */
export const ROLES = {
  /** The API's role. The only credential the API process holds. */
  app: 'crm_app',
  /** The collection worker's role (r5 Task 1.3). */
  collector: 'crm_collector',
  /** NOLOGIN owner of the R-B retention functions (ADR §3). Task 1.3b adds the functions. */
  retentionOwner: 'crm_retention_owner',
} as const

/**
 * `CONNECTION LIMIT` per login role.
 *
 * `crm_app`: `DatabaseService` opens one `pg` `Pool` with no `max`, i.e. pg's default of
 * 10. A deploy recreates the container rather than swapping it, but a recreate can
 * briefly overlap, so 10 x 2 = 20, plus 10 of headroom for an operator session and for a
 * pool that has not finished draining. A limit that is too low is an outage, so the
 * headroom is deliberate.
 *
 * `crm_collector`: one worker process, not yet shipped (ADR §4 step 8).
 */
export const CONNECTION_LIMITS = {
  [ROLES.app]: 30,
  [ROLES.collector]: 10,
} as const

/** Table-level privileges PostgreSQL can grant. */
export type TablePrivilege =
  'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE' | 'REFERENCES' | 'TRIGGER'

/** Every privilege the check asserts, present or absent, for both roles on every relation. */
export const ALL_TABLE_PRIVILEGES: readonly TablePrivilege[] = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const

export type PrivilegeClass = 'A' | 'A-log' | 'A-log-prunable' | 'B' | 'C' | 'D' | 'E' | 'V'

/** The class the three views sit in. Named so the spec can assert no table joins them. */
export const VIEW_CLASS = 'V' satisfies PrivilegeClass

/**
 * What each class grants, per role. This is the policy; `PRIVILEGE_CLASSES` below is the
 * assignment. `TRUNCATE`, `REFERENCES` and `TRIGGER` appear in no row and may not — ADR
 * §2: "Never granted to `crm_app` or `crm_collector`, on any class", and
 * `privilege-classes.spec.ts` asserts it rather than trusting this comment.
 *
 * `collectorColumns` makes class D column-level: a table-level `SELECT` for the collector
 * would silently cover every column, including credentials, so class D's table-level
 * `collector` list is empty by construction and the columns are granted one by one.
 */
export const CLASS_PRIVILEGES: Record<
  PrivilegeClass,
  { app: readonly TablePrivilege[]; collector: readonly TablePrivilege[]; why: string }
> = {
  A: {
    app: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    collector: [],
    why: 'Ordinary product table. The default for everything the API reads and writes.',
  },
  'A-log': {
    app: ['SELECT', 'INSERT'],
    collector: [],
    why: 'Existing audit log, not yet append-only (ADR §2). Add rows, never rewrite them.',
  },
  'A-log-prunable': {
    app: ['SELECT', 'INSERT', 'DELETE'],
    collector: [],
    why: 'Audit log the API itself prunes — DocumentAccessLogRetentionCronService.',
  },
  B: {
    app: ['SELECT', 'INSERT'],
    collector: [],
    why: 'Append-only. UPDATE/DELETE/TRUNCATE revoked; Task 1.3b adds the ENABLE ALWAYS triggers.',
  },
  C: {
    app: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    collector: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    why: 'Job-sourcing table the collection worker writes. Empty until ADR §4 step 8.',
  },
  D: {
    app: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    collector: [],
    why: 'Collector evaluation input: column-level SELECT only, via collectorColumns. Empty until step 8.',
  },
  E: {
    app: [],
    collector: [],
    why: 'Migration-internal (the ledger of ADR §6, deploy bookkeeping). The API gets nothing.',
  },
  V: {
    app: ['SELECT'],
    collector: [],
    why: 'View. SELECT only — an auto-updatable view writes its base tables as the view owner.',
  },
}

/**
 * The assignment. Derived once from the catalog of a database built by `db:push`
 * (2026-10-18, 66 tables + 3 views) and kept honest by `privilege-classes.spec.ts`,
 * which compares it against the Drizzle schema on every unit run.
 *
 * Classes C, D and E are deliberately EMPTY, and each for a stated reason:
 *   - C and D: the ADR puts the collector's class C / D grants in §4 step 8, "when the
 *     worker ships as its own process". r5 Task 1.3 does not enumerate the tables, and
 *     guessing them would either under-grant (harmless, fails closed with `42501`) or
 *     over-grant a role nothing holds yet. The role is created now so the catalog check
 *     covers it from the first deploy; it has no password, so it cannot log in at all.
 *   - E: the migration ledger does not exist yet (ADR §6). `drizzle.__drizzle_migrations`
 *     lives in schema `drizzle`, not `public`, so it is outside this model.
 * The generated SQL and the check handle all three classes regardless, and
 * `db-privileges.integration.spec.ts` proves each class on a synthetic table, so the
 * machinery is not shipping unexercised.
 */
export const PRIVILEGE_CLASSES: Record<PrivilegeClass, readonly string[]> = {
  A: [
    'approvals',
    'company_account',
    'consumed_tx_hashes',
    'contract_templates',
    'csp_reports',
    'documents',
    'employee_contracts',
    'interview_recordings',
    'interviews',
    'invoice_signatures',
    'job_account_meter_reservations',
    'job_account_meters',
    'job_collection_cycles',
    'job_collection_runs',
    'job_dirty_work',
    'job_exclusion_filters',
    'job_opportunities',
    'job_opportunity_matches',
    'job_opportunity_sources',
    'job_opportunity_team_triage',
    'job_posting_signals',
    'job_postings',
    'job_queue_assignments',
    'job_queue_dismissals',
    'job_queue_generation_entries',
    'job_queue_generations',
    'job_source_record_revisions',
    'job_source_records',
    'job_sources',
    'job_suggestions',
    'job_team_triage_subscriptions',
    'job_text_blobs',
    'legend_entries',
    'legends',
    'meeting_recorder_connections',
    'meeting_recorder_webhook_receipts',
    'notification_emails',
    'notification_preferences',
    'notifications',
    'payout_requests',
    'pending_obligations',
    'project_credentials',
    'project_finance_settings',
    'project_members',
    'projects',
    'salary_month_initializations',
    'senior_resumes',
    'signed_contracts',
    'team_members',
    'teams',
    'telemetry_errors',
    'telemetry_events',
    'tos_acceptances',
    'tos_versions',
    'transactions',
    'user_email_invites',
    'user_emails',
    'users',
    'vacancies',
    'vacancy_applications',
  ],
  // The five audit logs the API only ever inserts into. Re-checked 2026-10-18 by the
  // search the ADR §2 prescribes: no `.update(…)` / `.delete(…)` and no raw
  // UPDATE/DELETE/TRUNCATE against any of them in `apps/api/src` outside specs.
  'A-log': [
    'meeting_recorder_audit_log',
    'project_audit_log',
    'team_audit_log',
    'transaction_audit_log',
    'user_audit_log',
  ],
  // The sixth: `DocumentAccessLogRetentionCronService` deletes from it daily, as the API.
  'A-log-prunable': ['document_access_log'],
  B: ['job_queue_actions'],
  C: [],
  D: [],
  E: [],
  V: ['confirmed_projects', 'non_deleted_transactions', 'visible_projects'],
}

/**
 * Class D column-level `SELECT` for the collector. A class D table listed here gets NO
 * table-level `SELECT` — the whole point is that credentials, tokens and finance columns
 * stay unreadable. Empty until ADR §4 step 8 names the collector's inputs.
 */
export const collectorColumns: Record<string, readonly string[]> = {}

/**
 * The append-only triggers each class B table must carry, with the `pg_trigger.tgenabled`
 * state the catalog check requires (`A` = `ENABLE ALWAYS`).
 *
 * `job_queue_actions` declares an EMPTY set on purpose: the triggers are Task 1.3b, and
 * the check asserts the database matches this declaration EXACTLY. So today it pins the
 * gap — a trigger appearing without a reviewed declaration fails the check — and 1.3b
 * flips it by adding the two trigger names here in the same PR as the DDL. This is the
 * "GAP PIN" device of PR #1017, moved into the mechanism that will carry the guarantee.
 */
export const appendOnlyTriggers: Record<string, readonly { name: string; enabled: 'A' }[]> = {
  job_queue_actions: [],
}

/**
 * The functions `crm_retention_owner` is allowed to own — the two `SECURITY DEFINER`
 * functions of ADR §3 option R-B, added by Task 1.3b together with the trigger that keys
 * its exception on them.
 *
 * Empty today, and the catalog check asserts the role owns NOTHING beyond this list. So a
 * definer function appearing in the database without a reviewed declaration fails the
 * deploy — which is the only mechanical protection there is against the one object class
 * the ADR calls "a hole through every boundary here".
 */
export const retentionOwnerFunctions: readonly string[] = []

/** The class of a relation, or `undefined` if nobody classified it. */
export function relationClass(relation: string): PrivilegeClass | undefined {
  for (const [cls, relations] of Object.entries(PRIVILEGE_CLASSES)) {
    if (relations.includes(relation)) return cls as PrivilegeClass
  }
  return undefined
}
