/**
 * Projects, project finance settings, members, credentials and the visibility views.
 */
import { and, eq, isNull, relations } from 'drizzle-orm'
import {
  index,
  integer,
  numeric,
  pgTable,
  pgView,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { currencyEnum, projectPaymentTypeEnum, projectStatusEnum } from './enums'
import { legends } from './notifications'
import { transactions } from './transactions'
import { users } from './users'

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const projects = pgTable('projects', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  companyName: varchar('company_name', { length: 255 }).notNull(),
  domain: varchar('domain', { length: 100 }).notNull(),
  startDate: timestamp('start_date', { withTimezone: true }).notNull(),
  // seniorId can be SENIOR or ADMIN (admin-owned projects)
  seniorId: uuid('senior_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Drop-only: when set, the project's income flows through this DROP user
  // and the finance distribution (Phase 2) includes the drop's share.
  // `null` = legacy senior-project — no change to finance behavior.
  // ON DELETE RESTRICT to keep drop-projects from silently losing their
  // drop reference if a DROP user row were ever hard-deleted (we soft-delete
  // via archivedAt). Drop role - phase 1.
  dropId: uuid('drop_id').references(() => users.id, { onDelete: 'restrict' }),
  rate: integer('rate').notNull(),
  currency: currencyEnum().notNull().default('USDT'),
  // FK to documents (category = LOGO). When set, render priority is:
  //   logo_document_id (presigned S3) → logo_external_url → placeholder.
  // ON DELETE SET NULL — hard-delete of LOGO doc reverts to placeholder.
  // FK declared in migration 0014; column metadata-only here to avoid the
  // circular reference with `documents`.
  logoDocumentId: uuid('logo_document_id'),
  // External logo URL (e.g. `https://company.com/logo.svg`). XOR with
  // `logoDocumentId` — enforced by CHECK constraint in migration 0014.
  logoExternalUrl: text('logo_external_url'),
  techStack: varchar('tech_stack', { length: 500 }),
  teamSize: varchar('team_size', { length: 100 }),
  benefits: varchar('benefits', { length: 500 }),
  // task-drop-share-override-and-receiver (D1). Migrated from free-text
  // varchar(100) to the project_payment_type enum. NOT NULL DEFAULT 'FOP' —
  // the manual production DDL normalizes existing free-text values before the
  // type conversion (all → 'FOP', GamingTec → 'USDT').
  paymentType: projectPaymentTypeEnum('payment_type').notNull().default('FOP'),
  salaryReview: varchar('salary_review', { length: 255 }),
  corpTech: varchar('corp_tech', { length: 255 }),
  notesGeneral: varchar('notes_general', { length: 1000 }),
  // Per-project override for SENIOR's share percent (0-100). NULL = use
  // users.seniorSharePercent (global default for the senior). Editable only
  // by ADMIN and ACCOUNTANT (enforced in projects.service.ts). Mirrors the
  // existing project_finance_settings.seniorSharePercentOverride so the
  // existing transactions.service.ts finance flow keeps reading the same
  // effective value.
  seniorSharePercentOverride: integer('senior_share_percent_override'),
  // task-pending-share (position 5, design spec §4.3). A proposed NEW value
  // for the column immediately above, while the project's SENIOR has not yet
  // confirmed it (`approvals`, subjectType 'PROJECT_SENIOR_SHARE', subjectId
  // = this project's id). CAN legitimately be NULL while a proposal is live
  // — "propose clearing the override back to the team/user default" is a
  // real, valid proposal, so this column's own null-ness never by itself
  // means "nothing pending" (only `ApprovalsService.getStatus()` does — see
  // that service's subject-agnostic status contract). `update()` writes
  // ONLY this column when a change is requested; `approveSeniorShareChange`
  // swaps it into `seniorSharePercentOverride` (and mirrors into
  // `project_finance_settings`) in one transaction; `rejectSeniorShareChange`
  // clears it, leaving the active column untouched.
  // Stryker disable next-line StringLiteral: the SQL column name is a
  // DB-level fact, unobservable from a mocked unit double — same reasoning
  // as `users.pendingSeniorSharePercent` above. Any query that selects the
  // whole `projects` row against a REAL database would fail loudly if this
  // diverged from the migration, which `admin-as-senior.rbac.integration.
  // spec.ts` and `senior-drop-mask.rbac.integration.spec.ts` do on every run.
  pendingSeniorSharePercentOverride: integer('pending_senior_share_percent_override'),
  // task-drop-share-override-and-receiver (Part A). Per-project override for the
  // DROP's share percent (0-100). NULL = use users.dropSharePercent (→ 5).
  // Editable only by ADMIN/ACCOUNTANT. Resolved by resolveDropShare and
  // snapshotted onto DROP_INCOME / obligation rows. Mirror column below in
  // project_finance_settings for symmetry with the senior override.
  dropSharePercentOverride: integer('drop_share_percent_override'),
  // task-project-draft-status. CONFIRMATION lifecycle — deliberately a
  // SEPARATE axis from `archivedAt` below, never merged into it.
  // `archivedAt` answers "is this project still being worked" (a project
  // that finished normally); `status` answers "has responsibility for this
  // project's money been accepted by the people it touches" (a project that
  // never started, or was refused). Collapsing "not confirmed" and "finished"
  // into one field is exactly the bug this column exists to prevent: a
  // rejected proposal and a completed engagement are different facts, and a
  // migration that could not tell them apart would either resurrect refused
  // proposals as "active" or bury finished projects as "still pending".
  // DEFAULT 'ACTIVE' (not 'DRAFT'): every project that already exists before
  // this column ships was, by definition, never subject to this gate — the
  // column default backfills every existing row to 'ACTIVE' in the same DDL
  // statement that adds it (see drizzle/manual/2026-09-02_project_status.sql).
  // New projects are created with an EXPLICIT `status: 'DRAFT'` — BOTH doors
  // into `insert(projects)` set it: `ProjectsService.create` (the ADMIN/HR
  // form) and `ProjectsService.createFromInterview` (the BIZ-07 auto-create-
  // on-HIRED path). security-review round 2 (SR-H-6): this comment used to
  // name only `create()` — the SECOND door shipped its projects straight to
  // `ACTIVE` on the column DEFAULT below, with zero `approvals` rows,
  // unconfirmable by construction. The default only protects a write path
  // that forgets to set it explicitly; it is not how a real draft is minted.
  // Stryker disable next-line StringLiteral: the DEFAULT clause is a DB-level
  // fact, unobservable from a mocked unit double. VERIFIED against real
  // Postgres by `visible-projects-view.integration.spec.ts`'s own
  // information_schema assertion ("the column DEFAULT is ACTIVE").
  status: projectStatusEnum('status').notNull().default('ACTIVE'),
  // Soft delete (archived projects hidden from main UI, restorable). Orthogonal
  // to `status` above — a project can be archived regardless of how its
  // confirmation resolved (an ADMIN can archive a stale DRAFT or REJECTED row
  // exactly like an ACTIVE one; nothing here special-cases that).
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// visible_projects — the ONLY project rows most of the codebase may ever
// read. task-project-draft-status, same "eliminate, don't detect" shape as
// `non_deleted_transactions` above (see that view's own comment for the full
// review history this pattern comes from): `SELECT * FROM visible_projects`
// cannot return a DRAFT, a REJECTED, or an archived project — there is no
// WHERE clause a caller could omit, because the filter is the view's FROM
// target, not a condition applied after the fact.
//
// `apps/api/eslint.config.mjs` bans importing the raw `projects` table (plus
// the `with: { projects: ... }` relational traversal and the
// `db.query.projects` property-access forms) from the modules that have zero
// legitimate need for a row this view would hide — see that file's own
// comment for the full list of exceptions and why each one is named instead
// of the ban simply not applying there: unlike `transactions`, the `projects`
// table is written (archival cascades) and looked up by id (RBAC checks,
// historical-name denormalisation) from several modules that own no part of
// the confirmation flow, so a blanket ban would break real, unrelated code.
// A DB-level VIEW predicate, unobservable from a mocked unit double (the
// mutation gate cannot run integration specs —
// mutation-gate-integration-specs.md). VERIFIED, not assumed: mutating
// 'ACTIVE' to 'DRAFT' on the LIVE view in crm_qa and re-running
// `visible-projects-view.integration.spec.ts` fails immediately ("expected
// [...] to deeply equal [...]") — that spec is the proof.
export const VISIBLE_PROJECTS_PREDICATE = and(
  // Stryker disable next-line StringLiteral: see the file-level note above.
  eq(projects.status, 'ACTIVE'),
  isNull(projects.archivedAt),
)

// Stryker disable next-line StringLiteral: the VIEW NAME is a DB-level fact, unobservable from a mocked unit double (a mock keyed by `visibleProjects`'s JS object identity does not care what name that object carries). VERIFIED against real Postgres: `visible-projects-view.integration.spec.ts`'s own beforeAll asserts `information_schema.views` carries a row named exactly 'visible_projects', and every query in that file would fail with "relation does not exist" if this name diverged from the migration's `CREATE VIEW visible_projects`.
export const visibleProjects = pgView('visible_projects').as((qb) =>
  qb.select().from(projects).where(VISIBLE_PROJECTS_PREDICATE),
)

// ---------------------------------------------------------------------------
// confirmed_projects — DISPLAY-ONLY read surface, deliberately narrower than
// `visible_projects`'s own filter: `status = 'ACTIVE'` ALONE, WITHOUT the
// `archived_at IS NULL` half. security-review round 2 (SPEC-M-1,
// task-project-draft-status): `AdminSummaryService`'s «Активные транзакции»
// widget joins each transaction to its project's NAME for display. A
// transaction's `projectId` can only ever point at a project that was
// `ACTIVE` at the moment the transaction was created — `assertProjectActive`
// (see `transactions.service.ts`) refuses transaction creation on a
// DRAFT/REJECTED project, and nothing in this file ever writes `status` back
// OFF `'ACTIVE'` once it gets there (`applyApprovalAggregate` only ever
// transitions a still-DRAFT row forward, never back — see
// `projects.service.ts`). So swapping this join to `visible_projects` (round
// 1's fix) could not have been hiding a DRAFT/REJECTED leak; the ONLY thing
// its extra `archived_at IS NULL` filter could hide here is an ARCHIVED
// project's name — and archiving means "this engagement finished", not
// "erase it from history" (the exact distinction this column's own comment
// above draws between the two axes). A transaction on an archived project is
// a legitimate historical record; this view lets its name keep showing
// without reopening the DRAFT/REJECTED leak `visible_projects` exists to
// close (`archived_at` plays no part in that leak at all).
// Stryker disable next-line StringLiteral: mutating 'ACTIVE' here can only be
// observed through the real VIEW this predicate feeds (`confirmedProjects`
// below) — a mocked unit double never runs Postgres's `WHERE` clause, so no
// unit test can distinguish this from an empty string. VERIFIED against real
// Postgres, same as `VISIBLE_PROJECTS_PREDICATE` above (see that constant's
// own suppression comment): `admin-summary.integration.spec.ts`'s "shows the
// project name for a transaction on an ARCHIVED project, but NOT on a DRAFT
// one" test fails immediately if this predicate stops filtering on status —
// the DRAFT-project transaction's `projectName` would stop being `null`.
export const CONFIRMED_PROJECTS_PREDICATE = eq(projects.status, 'ACTIVE')

// Stryker disable next-line StringLiteral: the VIEW NAME is a DB-level fact, unobservable from a mocked unit double — same reasoning as `visibleProjects` above. VERIFIED against real Postgres by `admin-summary.integration.spec.ts`'s archived-project projectName assertion (fails if this name diverges from the migration's `CREATE VIEW confirmed_projects`).
export const confirmedProjects = pgView('confirmed_projects').as((qb) =>
  qb.select().from(projects).where(CONFIRMED_PROJECTS_PREDICATE),
)

// Per-project finance overrides (ADMIN/ACCOUNTANT only)
export const projectFinanceSettings = pgTable('project_finance_settings', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id')
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: 'cascade' }),
  // Override senior share percent for this project; null = use users.seniorSharePercent
  seniorSharePercentOverride: integer('senior_share_percent_override'),
  // task-drop-share-override-and-receiver (Part A). Legacy mirror of
  // projects.dropSharePercentOverride (kept for symmetry with the senior
  // override); null = use users.dropSharePercent (→ 5). The service writes the
  // canonical value to projects.dropSharePercentOverride.
  dropSharePercentOverride: integer('drop_share_percent_override'),
  // Override junior monthly salary for this project; null = use users.monthlySalary
  juniorSalaryOverride: numeric('junior_salary_override', { precision: 10, scale: 2 }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const projectMembers = pgTable('project_members', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  leftAt: timestamp('left_at', { withTimezone: true }),
})

// ---------------------------------------------------------------------------
// Project Credentials — work-account passwords stored per project.
//
// SECURITY: the password is stored ONLY as an AES-256-GCM ciphertext token
// (`v1:<iv>:<tag>:<data>`, see CredentialsCryptoService). Plaintext is never
// persisted. List/read endpoints never select this column.
// ---------------------------------------------------------------------------

export const projectCredentials = pgTable(
  'project_credentials',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Display label, e.g. «GitHub», «Jira». */
    label: text('label').notNull(),
    login: text('login'),
    /** AES-256-GCM token: v1:<iv b64>:<tag b64>:<ciphertext b64>. Never plaintext. */
    passwordCiphertext: text('password_ciphertext').notNull(),
    url: text('url'),
    notes: text('notes'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('project_credentials_project_idx').on(t.projectId)],
)

export const projectsRelations = relations(projects, ({ one, many }) => ({
  senior: one(users, {
    fields: [projects.seniorId],
    references: [users.id],
    relationName: 'projectSenior',
  }),
  drop: one(users, {
    fields: [projects.dropId],
    references: [users.id],
    relationName: 'projectDrop',
  }),
  members: many(projectMembers),
  transactions: many(transactions),
  financeSettings: one(projectFinanceSettings),
  // Legend persona for this project — used to enrich JUNIOR-facing DTO
  // (task-junior-ux-1-backend: JUNIOR sees persona name+role, not real identity).
  legend: one(legends, {
    fields: [projects.id],
    references: [legends.projectId],
  }),
}))

export const projectFinanceSettingsRelations = relations(projectFinanceSettings, ({ one }) => ({
  project: one(projects, { fields: [projectFinanceSettings.projectId], references: [projects.id] }),
  updatedByUser: one(users, { fields: [projectFinanceSettings.updatedBy], references: [users.id] }),
}))

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, { fields: [projectMembers.projectId], references: [projects.id] }),
  user: one(users, { fields: [projectMembers.userId], references: [users.id] }),
}))

export const projectCredentialsRelations = relations(projectCredentials, ({ one }) => ({
  project: one(projects, {
    fields: [projectCredentials.projectId],
    references: [projects.id],
  }),
  creator: one(users, {
    fields: [projectCredentials.createdBy],
    references: [users.id],
  }),
}))

export type Project = typeof projects.$inferSelect

export type NewProject = typeof projects.$inferInsert

export type ProjectMember = typeof projectMembers.$inferSelect

export type NewProjectMember = typeof projectMembers.$inferInsert

export type ProjectFinanceSettings = typeof projectFinanceSettings.$inferSelect

export type NewProjectFinanceSettings = typeof projectFinanceSettings.$inferInsert
