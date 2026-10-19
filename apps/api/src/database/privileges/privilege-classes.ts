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
 * THE CONTRACT WITH TASK 1.3b (the append-only triggers and the R-B functions)
 * ---------------------------------------------------------------------------
 * 1.3b ships on its own branch and depends on THIS task by name: its two `SECURITY
 * DEFINER` functions are owned by `crm_retention_owner`, which `2026-10-18_db_roles.sql`
 * creates. Three declarations here are the seam between the two tasks, and the catalog
 * check FAILS THE DEPLOY if 1.3b changes the database without changing them — deliberately,
 * because an undeclared trigger or definer function is the one thing nothing else would
 * notice:
 *   - `appendOnlyTriggers` — the trigger names and their `ENABLE ALWAYS` state;
 *   - `retentionOwnerFunctions` — the function names that role may own;
 *   - `RETENTION_OWNER_TABLE_PRIVILEGES` — the privileges those functions need.
 * All three are empty today, which pins the current state rather than asserting nothing.
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
  // Not the migration ledger (that does not exist yet) but the three tables historical
  // manual DDL files left in `public` — see MANUAL_DDL_RELATIONS below for why they are
  // here, why they are class E, and why they are OPTIONAL.
  E: [
    '_drop_share_pending_parity_backup_20260727',
    '_settle_phantom_backup_20260715',
    'drop_cascade_origin_marker_state',
    'salary_month_shift_backup',
  ],
  V: ['confirmed_projects', 'non_deleted_transactions', 'visible_projects'],
}

/**
 * Relations that live in `public` WITHOUT being declared by the Drizzle schema, because a
 * manual DDL file created them — or, in one case, because an operator created it by hand
 * and no file here creates it at all (`file: null`). Each is OPTIONAL: it exists only in a
 * database where that file ran, or only on the machine where the hand was laid, so the
 * catalog check requires it to be classified when present and does not require it to be
 * present.
 *
 * NO ENTRY HERE CLAIMS ANYTHING ABOUT PRODUCTION, and the spec forbids it. One did — it
 * said "Confirmed present in production" of the one relation production turned out NOT to
 * have — and the claim was not merely wrong: it was unverifiable from here, and unused,
 * since every entry is OPTIONAL and presence changes nothing the check does. A measurement
 * against production belongs in a spec comment next to the date it was taken.
 *
 * HOW THESE WERE FOUND, WHICH IS THE POINT OF THE DESIGN
 * -----------------------------------------------------
 * Not by reading the DDL files. The catalog check failed on
 * `_drop_share_pending_parity_backup_20260727` during the first full integration run on
 * 2026-10-18, because another spec applies that data-fix file and the table appeared in
 * `public` mid-run. A spec comment beside it calls it "a real prod table" — an inference
 * since measured and found WRONG: production does not carry that table (read-only
 * comparison, 2026-10-18). The mechanism was right anyway and for the stated reason: the
 * list is derived from the
 * catalog, so a table no schema file declares cannot hide. The other two came from reading
 * every `CREATE TABLE` in `drizzle/manual/*.sql` afterwards and diffing against the Drizzle
 * schema.
 *
 * The fourth came from neither route, and that is the point: `salary_month_shift_backup`
 * was found by comparing production's real relation list against this manifest (read-only,
 * 2026-10-18). No file creates it, so reading the repository could not find it; no scratch
 * database has it, so no test run could either. Part 1 would have found it on the first
 * production deploy — by failing that deploy.
 *
 * WHY CLASS E
 * -----------
 * Each is a DDL-time artefact — a row-level backup taken before a finance data-fix, or
 * state for one. Checked 2026-10-18: no production code path reads or writes any of them
 * (the only references in `apps/api/src` are inside
 * `drop-share-pending-parity-backfill.integration.spec.ts`, which runs as the migration
 * role). The API must not reach them, and class E is exactly "the API gets nothing" — so a
 * backup of the transactions table stops being writable by the internet-facing process.
 * `salary_month_shift_backup` is judged on that same basis and nothing else: a row backup
 * of salary data is the same hazard class as a row backup of `transactions`.
 */
export const MANUAL_DDL_RELATIONS: Record<string, { file: string | null; why: string }> = {
  _drop_share_pending_parity_backup_20260727: {
    file: 'drizzle/manual/2026-07-27_drop_share_pending_parity_backfill.sql',
    why: 'Row backup taken before the drop-share parity backfill.',
  },
  _settle_phantom_backup_20260715: {
    file: 'drizzle/manual/2026-07-15_settle_phantom_cleanup.sql (and …_auto.sql)',
    why: 'Row backup (LIKE transactions INCLUDING ALL) taken before the phantom-settle cleanup.',
  },
  drop_cascade_origin_marker_state: {
    file: 'drizzle/manual/2026-07-27_drop_cascade_origin_marker.sql',
    why: 'Bookkeeping for the drop-cascade origin marker backfill.',
  },
  salary_month_shift_backup: {
    // The only entry with no file: nothing in this repository creates this relation, and
    // the spec checks that rather than taking the word for it.
    file: null,
    why: 'Row backup of salary data, taken by hand (4 columns, owner crm_user); no file here creates it.',
  },
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
 * Filled by Task 1.3b, which is where the gap this used to pin was closed: the two names
 * below are the triggers `drizzle/manual/2026-10-18_job_queue_append_only_triggers.sql`
 * installs on `job_queue_actions`, read off that DDL rather than from memory —
 * `BEFORE UPDATE OR DELETE ... FOR EACH ROW` and `BEFORE TRUNCATE ... FOR EACH STATEMENT`,
 * both followed by `ALTER TABLE ... ENABLE ALWAYS TRIGGER`, hence `enabled: 'A'`.
 *
 * WHY ONLY `job_queue_actions`, WHEN 1.3b CREATES SEVEN TRIGGERS ON THREE TABLES
 * -----------------------------------------------------------------------------
 * The same DDL also guards `job_queue_generation_entries` (3 triggers) and
 * `job_queue_generations` (2), and neither table is class B — the API legitimately updates
 * and deletes both, so their triggers are shape guards rather than the second lock on a
 * revoked privilege. They are deliberately NOT declared here, for two reasons that agree:
 *   - `privilege-classes.spec.ts` asserts every key of this map is a class B relation, so
 *     a key for a class A table is a unit-test failure, not an option; and
 *   - the catalog check's part 9 scopes what it reads to class B tables, so a declaration
 *     for a class A table would read as "declared trigger is missing" and fail the deploy
 *     while the database was in fact correct (measured on PostgreSQL 16.15, 2026-10-19).
 * Those five are pinned instead by `2026-10-18_job_queue_append_only_check.sql`, which runs
 * on every deploy beside this check. What that file asserts, per trigger, is: name, table,
 * `tgenabled`, the `tgtype` timing/event/row-vs-statement bitmask, the function the trigger
 * actually executes (`tgfoid`), the absence of a `WHEN` clause, the argument count, and the
 * md5 of the whole `pg_get_triggerdef` — plus that NO undeclared trigger exists on any of
 * the three tables, and the md5 of every trigger function's definition. Part 9 here asserts
 * name, `tgenabled` and the absence of undeclared triggers, on `job_queue_actions` only. So
 * 1.3b's check is a strict superset of part 9 on the table they share, and the guarantee on
 * the other two tables is stronger there than part 9 could give.
 *
 * THAT COMPARISON WAS FALSE WHEN FIRST WRITTEN, AND IS WHY THE LIST ABOVE IS SPELT OUT.
 * Until fix round 1 of PR #1026, 1.3b's check read only name and `tgenabled` — exactly what
 * part 9 reads — so "stronger" was wrong, and the sentence was load-bearing for accepting
 * this map's two-of-seven coverage. Five rewrites that keep a trigger's name and its
 * `ENABLE ALWAYS` state passed that check green (narrowed events, BEFORE flipped to AFTER,
 * row turned into statement, `WHEN (false)`, the function repointed at a no-op), and two of
 * them let `crm_retention_owner` delete a `job_queue_actions` row seconds old. The columns
 * named above are what closed that, each one replayed against the tampering it catches.
 * If this comparison is edited again, re-read both files rather than either comment.
 */
export const appendOnlyTriggers: Record<string, readonly { name: string; enabled: 'A' }[]> = {
  job_queue_actions: [
    { name: 'trg_job_queue_actions_append_only', enabled: 'A' },
    { name: 'trg_job_queue_actions_no_truncate', enabled: 'A' },
  ],
}

/**
 * Table privileges `crm_retention_owner` holds — on the classes named by
 * `RETENTION_OWNER_CLASSES` below, and on no other relation.
 *
 * `SELECT, DELETE`, and both are LOAD-BEARING FOR THE PURGE, measured rather than reasoned
 * (PostgreSQL 16.15, scratch database, 2026-10-19). The function is `SECURITY DEFINER`, so
 * the privileges checked inside it are this role's:
 *   - granted neither          -> `42501 permission denied for table job_queue_actions`
 *   - `DELETE` alone           -> `42501` — the `WHERE created_at <= …` reads a column
 *   - `SELECT` alone           -> `42501`
 *   - `SELECT, DELETE`         -> returns the purged count
 * `INSERT` is NOT here: the function never inserts. The integration suite of 1.3b grants
 * itself `INSERT` as well, because it drives the trigger's admitted shapes directly with
 * `SET ROLE` — a test's need, not the purge path's, and it stays in the test.
 *
 * WHY `crm_retention_redact_action_reason` GETS NOTHING, THOUGH IT IS THE OTHER R-B FUNCTION
 * ------------------------------------------------------------------------------------------
 * It needs `SELECT` plus `UPDATE (reason)` — column-level — and this model forbids exactly
 * that: the check's part 3 reports ANY column privilege other than `SELECT`, for any of the
 * three roles, as "only SELECT is ever granted at column level". The two ways out are both
 * worse than waiting:
 *   - table-level `UPDATE` on an append-only audit log is strictly more than the function
 *     needs — it would let the role rewrite any column, and while the trigger constrains
 *     the SHAPE of an admitted update, the grant would not; a privilege nothing can justify
 *     by a failing run does not belong in a least-privilege manifest;
 *   - relaxing part 3's column policy is a change to a stated security invariant, and it
 *     cannot be justified by a function that nothing calls.
 * Nothing calls either function today (checked 2026-10-19: the only references in
 * `apps/api` are the two DDL files and 1.3b's integration spec), so the redaction grant
 * arrives with the caller that needs it — the same way classes C and D wait for the
 * collector. Until then the function exists, is owned, and is pinned by both checks; its
 * first real invocation fails closed with `42501` rather than silently redacting.
 */
export const RETENTION_OWNER_TABLE_PRIVILEGES: readonly TablePrivilege[] = ['SELECT', 'DELETE']

/**
 * The classes on which `crm_retention_owner` holds `RETENTION_OWNER_TABLE_PRIVILEGES`.
 *
 * This scoping is the one shape change Task 1.3b had to make, and it is not cosmetic. The
 * constant above used to be read by the generator for EVERY class, which is harmless while
 * it is empty and wrong the moment it is not: `SELECT, DELETE` "on every relation in every
 * class" is `DELETE` on `users`, on `transactions` and on all six audit logs, granted to a
 * role whose two functions touch exactly one table. The privileges are a property of the
 * relations the R-B path reaches, so they are declared against a class — which is how the
 * other two roles have always been declared (`CLASS_PRIVILEGES`).
 *
 * Class B is `job_queue_actions`, the append-only log the purge prunes. A table added to
 * class B later would inherit this grant, which is correct in intent (class B means "an
 * append-only log under the R-B retention path") but is a real consequence: adding to
 * class B means deciding that the retention owner may prune it too.
 */
export const RETENTION_OWNER_CLASSES: readonly PrivilegeClass[] = ['B']

/**
 * The retention owner's table privileges on one class — `[]` off its classes.
 *
 * The generator asks per `(role, class)`, so this is the retention owner's answer to the
 * same question `privilegesFor(cls, role)` answers for the app and the collector.
 */
export function retentionOwnerPrivilegesFor(cls: PrivilegeClass): readonly TablePrivilege[] {
  return RETENTION_OWNER_CLASSES.includes(cls) ? RETENTION_OWNER_TABLE_PRIVILEGES : []
}

/**
 * The functions `crm_retention_owner` is allowed to own — the two `SECURITY DEFINER`
 * functions of ADR §3 option R-B, added by Task 1.3b together with the trigger that keys
 * its exception on them.
 *
 * The catalog check asserts the role owns NOTHING beyond this list, and that each name
 * here IS owned by it. So a definer function appearing in the database without a reviewed
 * declaration fails the deploy — which is the only mechanical protection there is against
 * the one object class the ADR calls "a hole through every boundary here".
 *
 * These two names are the `ALTER FUNCTION ... OWNER TO crm_retention_owner` targets of
 * `drizzle/manual/2026-10-18_job_queue_append_only_triggers.sql`, and nothing else in that
 * file changes a function's owner (the seven trigger functions stay with whoever applied
 * the DDL — the migration role — which is why they are absent here). Names only, without
 * arguments, because part 7 joins on `pg_proc.proname`: an overload added under either
 * name would therefore pass part 7 and be caught instead by 1.3b's own check, which pins
 * `pg_get_function_identity_arguments` alongside the body's md5.
 */
export const retentionOwnerFunctions: readonly string[] = [
  'crm_retention_purge_job_queue_actions',
  'crm_retention_redact_action_reason',
]

/** The class of a relation, or `undefined` if nobody classified it. */
export function relationClass(relation: string): PrivilegeClass | undefined {
  for (const [cls, relations] of Object.entries(PRIVILEGE_CLASSES)) {
    if (relations.includes(relation)) return cls as PrivilegeClass
  }
  return undefined
}
