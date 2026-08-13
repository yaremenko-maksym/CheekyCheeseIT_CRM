import { isNull, relations, sql } from 'drizzle-orm'
import {
  bigserial,
  boolean,
  char,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  pgView,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import {
  DEFAULT_RESUME_LAYOUT,
  EMPTY_RESUME_CONTENT,
  type ResumeContent,
  type ResumeLayoutOptions,
  type VacancyTranslations,
} from '@crm/shared'

// PostgreSQL `inet` column type — stores IPv4 / IPv6 addresses with native
// validation + index support. Drizzle has no first-class `inet` builder, so
// we use customType which renders `INET` in the generated SQL and treats the
// JS value as a plain string (driver casts both ways automatically).
const inet = customType<{ data: string }>({
  dataType() {
    return 'inet'
  },
})

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const roleEnum = pgEnum('role', ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'])

/**
 * Discriminator on `teams.type` — distinguishes the legacy senior-team
 * (`'SENIOR'`, default) from the new drop-team (`'DROP'`). Drop role -
 * phase 1.
 */
export const teamTypeEnum = pgEnum('team_type', ['SENIOR', 'DROP'])

export const currencyEnum = pgEnum('currency', ['USDT', 'USD', 'EUR', 'UAH'])

export const interviewStageEnum = pgEnum('interview_stage', [
  'HR_SCREEN',
  'ENGLISH_CHECK',
  'TECH_INTERVIEW',
  'FINAL_INTERVIEW',
  'CLIENT_INTERVIEW',
  'OFFER_RECEIVED',
  'HIRED',
  'REJECTED',
  'ARCHIVED',
])

export const transactionTypeEnum = pgEnum('transaction_type', [
  'ADMIN_INCOME', // Admin income from own project — no validation needed
  'SENIOR_INCOME', // Senior income from project — requires validation flow
  'EXPENSE', // Company expense (category in receiverLabel)
  'SALARY', // Salary to employee (HR/ACCOUNTANT/JUNIOR)
  'ADMIN_TRANSFER', // Balance transfer between Maksym and Kostya
  'PAYOUT', // Senior pays CheekyCheeseIT (from payout_request)
  'PAYOUT_ADMIN', // Auto-created: 50/50 split to each admin after payout
  // Drop role - phase 2. New types for the drop-project distribution flow.
  // Migration 0021 adds these enum values; existing senior-only flows do not
  // emit them.
  'DROP_INCOME', // Drop income from drop-project — requires validation flow
  'PAYOUT_DROP', // Auto-created drop share after payPayoutRequest on a drop-project
  // Drop role - phase 3 (manual payout confirmation, spec §8.4). Migration 0022
  // adds this enum value. Distinct from PAYOUT_ADMIN (which is the automated
  // 50/50 partner split from `payPayoutRequest`) so the manual confirmation
  // safety net stays separable in reports / filters / balance computation.
  // ACCOUNTANT/ADMIN confirms a PAYOUT actually landed on a chosen admin and
  // a PAYOUT_CONFIRMED row is inserted alongside the now-PAID PAYOUT row.
  'PAYOUT_CONFIRMED',
  // Drop role - phase 4-A. New balance infrastructure types — emitted by the
  // future Phase 4-B payment channels and consumed by BalanceService for
  // computed-on-demand balances. Migration 0023 adds these enum values; legacy
  // flows do not emit them and getSummary continues to ignore them.
  //
  // TOV_INCOME            — corporate (ТОВ) account receives money.
  // SENIOR_PENDING_PAYOUT — TOВ owes a senior; logged separately in
  //                          pending_obligations and DOES NOT move the senior
  //                          balance until closed by a SENIOR_PAID row.
  // SENIOR_PAID           — closes a pending obligation; credits the senior's
  //                          real balance; links via closing_transaction_id.
  // ADMIN_INCOME_CASH     — admin received cash on personal balance.
  // ADMIN_INCOME_CRYPTO   — admin received USDT on personal crypto wallet.
  // SENIOR_INCOME_CRYPTO  — senior received USDT on personal crypto wallet.
  // DIVIDEND_TO_ADMIN     — distribution from TOВ to an admin's balance.
  // DIVIDEND_TAX          — 6.5% tax on dividends; debits TOВ balance only.
  'TOV_INCOME',
  'SENIOR_PENDING_PAYOUT',
  'SENIOR_PAID',
  'ADMIN_INCOME_CASH',
  'ADMIN_INCOME_CRYPTO',
  'SENIOR_INCOME_CRYPTO',
  'DIVIDEND_TO_ADMIN',
  'DIVIDEND_TAX',
  // task-company-account-backend. SENIOR/DROP-submitted USDT deposit onto the
  // shared company wallet, Etherscan-verified. PENDING until confirmations reach
  // the threshold AND the on-chain recipient matches the company wallet, then
  // PAID (credits the company-account balance).
  'COMPANY_DEPOSIT',
  // task-drop-share-override-and-receiver (D4). The company owes the DROP their
  // share after an ADMIN declares USDT income on a USDT-payment project. Mirror
  // of SENIOR_PENDING_PAYOUT: a visible IOU row (status=PENDING_PAYMENT,
  // receiverId=drop, senderLabel='COMPANY') paired with a pending_obligations
  // row (creditor=drop, debtorType='COMPANY'), settled by ACCOUNTANT/ADMIN via
  // settleByCompany → PAYOUT_DROP. Must stay LAST for a clean additive
  // ALTER TYPE ... ADD VALUE.
  'DROP_PENDING_PAYOUT',
])

// task-drop-share-override-and-receiver (D1). Project payment type — migrated
// from a free-text varchar(100) to a fixed enum. Drives the income declaration
// gate (FOP/GIG → senior/drop declare; USDT → admin-only). Existing prod rows
// are normalized to 'FOP' (GamingTec → 'USDT') by the manual production DDL.
export const projectPaymentTypeEnum = pgEnum('project_payment_type', [
  'FOP',
  'GIG_CONTRACT',
  'USDT',
])

// Phase 4-A: pending senior obligations live in their own table so the
// lifecycle is explicit (PENDING → PAID / CANCELLED) and balance queries
// don't have to recompute the closure from transaction pairs every time.
//
// task-drop-company-debt-and-invoices: new obligations use 'COMPANY'.
// 'DROP' remains for legacy historical rows that pre-date the refactor.
export const pendingObligationDebtorTypeEnum = pgEnum('pending_obligation_debtor_type', [
  'DROP', // legacy — historical pre-refactor cash flow rows
  'TOV', // legacy — historical bank-channel rows
  'ADMIN', // an admin owes the senior personally (reserved)
  'COMPANY', // the company owes the senior (new — both crypto + cash flows)
])

export const pendingObligationStatusEnum = pgEnum('pending_obligation_status', [
  'PENDING', // awaiting close — does NOT credit the creditor's balance yet
  'PAID', // closed by a SENIOR_PAID transaction; closingTransactionId set
  'CANCELLED', // abandoned (e.g. wrote off, dispute) — closingTransactionId may be null
])

export const transactionStatusEnum = pgEnum('transaction_status', [
  'PENDING', // Awaiting action (senior_income awaits validation; salary awaits payment)
  'VALIDATED', // Accountant/admin confirmed senior_income; senior can now create payout
  'PENDING_PAYMENT', // Senior created payout request, awaiting payment
  'REJECTED', // Accountant/admin rejected; senior must edit and resubmit
  'PAID', // Completed/paid
  'LOCKED', // Junior salary locked until senior has validated income for the month
  // Drop role - phase 4-B round 2. Cash channel placeholder — set on the PAYOUT
  // row when DROP clicks «Я передал нал админу». No income transactions exist
  // for the cascade until ACCOUNTANT/ADMIN confirms which admin received the
  // cash via /confirm-cash. See migration 0024_pending_cash_confirm.sql.
  'PENDING_CASH_CONFIRM',
])

export const payoutRequestStatusEnum = pgEnum('payout_request_status', [
  'PENDING', // Created by senior, txHash not yet submitted
  'PAID', // Senior submitted txHash, auto-transactions created
])

export const paymentMethodEnum = pgEnum('payment_method', ['USDT_ERC20', 'BANK_UAH_FOP'])

export const documentCategoryEnum = pgEnum('document_category', [
  'RESUME',
  'SCAN',
  'CONTRACT',
  'RECEIPT',
  'AVATAR',
  'LOGO',
  'INVOICE',
])

export const invoiceSignerRoleEnum = pgEnum('invoice_signer_role', ['COMPANY', 'COUNTERPARTY'])

export const invoiceSignatureMethodEnum = pgEnum('invoice_signature_method', [
  'AUTO_COMPANY',
  'MANUAL_CLICK',
])

// task-vacancies-api — public vacancies (landing) + admin CRUD (CRM).
/**
 * task-domains-expansion — order MUST match `VACANCY_DOMAINS` (`@crm/shared`)
 * and the live prod type: the original four first, then the 2026-08-05
 * additions in the order `drizzle/manual/2026-08-05_vacancy_domain_expansion.sql`
 * appends them. Spelled out literally rather than imported from `@crm/shared`
 * on purpose — `drizzle-kit` loads this file with its own loader, so keeping
 * it dependency-free keeps `db:push` (dev/CI) working regardless of workspace
 * resolution. The three definitions (this one, the shared const, the prod DDL)
 * are tied together by `vacancy-domain-enum-consistency.spec.ts`, which fails
 * on any drift instead of leaving it to be discovered on prod.
 */
export const vacancyDomainEnum = pgEnum('vacancy_domain', [
  'AI',
  'EDTECH',
  'ECOMMERCE',
  'OTHER',
  'FINTECH',
  'IGAMING',
  'ADULT',
  'SAAS',
  'HEALTHTECH',
  'ADTECH',
  'LOGISTICS',
  'PROPTECH',
  'TRAVEL',
  'MEDIA',
  'WEB3',
  'HRTECH',
  'CYBERSEC',
])
export const vacancySeniorityEnum = pgEnum('vacancy_seniority', ['SENIOR', 'LEAD'])
export const vacancyEmploymentTypeEnum = pgEnum('vacancy_employment_type', [
  'FULL_TIME',
  'PART_TIME',
  'CONTRACT',
])
export const vacancyStatusEnum = pgEnum('vacancy_status', ['DRAFT', 'PUBLISHED', 'CLOSED'])
export const vacancyApplicationStatusEnum = pgEnum('vacancy_application_status', [
  'NEW',
  'VIEWED',
  'REJECTED',
])
// task-job-sourcing-slice1 — external job sourcing (DOU RSS today, aggregators
// in a later slice). Mirrors packages/shared/src/schemas/job-sourcing.ts, which
// is the wire-level source of truth for these same value sets.
export const jobSourceTypeEnum = pgEnum('job_source_type', ['DOU_RSS'])
export const jobSuggestionStatusEnum = pgEnum('job_suggestion_status', [
  'NEW',
  'APPLIED',
  'REJECTED',
])
export const jobExclusionKindEnum = pgEnum('job_exclusion_kind', ['COMPANY', 'KEYWORD'])
// task-vacancy-matching §4/§5 — per-source request budgets and how a source may
// be triggered. Mirrors jobSourceBudgetWindowSchema / jobSourceTriggerModeSchema.
// Stryker disable next-line StringLiteral,ArrayDeclaration: a Postgres type name and its members — these exist in the DATABASE, so only the integration suite (which the mutation gate does not run) can observe them; the same two members are asserted from both sides in packages/shared/src/schemas/job-sourcing.spec.ts, and the prod DDL declares them in 2026-08-12_job_source_budgets.sql
export const jobSourceBudgetWindowEnum = pgEnum('job_source_budget_window', ['DAY', 'MONTH'])
// Stryker disable next-line StringLiteral,ArrayDeclaration: Postgres type name + member list — same reasoning as the window enum above: they live in the DATABASE, so only the integration suite can observe them, and the members are asserted from both sides in packages/shared/src/schemas/job-sourcing.spec.ts
export const jobSourceTriggerModeEnum = pgEnum('job_source_trigger_mode', [
  // Stryker disable next-line StringLiteral: member of the Postgres enum above; SCHEDULED is exercised against a real database in job-matching.integration.spec.ts, which the unit-scoped mutation gate does not run
  'SCHEDULED',
  // Stryker disable next-line StringLiteral: one member of that Postgres enum; MANUAL is exercised against a real database in job-matching.integration.spec.ts (the cron must not touch a manual-only source), which the unit-scoped mutation gate does not run
  'MANUAL',
  // Stryker disable next-line StringLiteral: member of the Postgres enum above; BOTH is exercised against a real database in job-matching.integration.spec.ts (a source both the cron and a human may collect)
  'BOTH',
])
// task-vacancy-salary-range — matches Google's JobPosting baseSalary.value.unitText
// enum exactly (case-sensitive) + packages/shared's VACANCY_SALARY_PERIODS.
export const vacancySalaryPeriodEnum = pgEnum('vacancy_salary_period', [
  'HOUR',
  'DAY',
  'WEEK',
  'MONTH',
  'YEAR',
])

// task-telemetry-api — CRM Telemetry (prod-errors + UX-analytics).
export const telemetrySourceEnum = pgEnum('telemetry_source', ['WEB', 'API'])
export const telemetryErrorStatusEnum = pgEnum('telemetry_error_status', [
  'NEW',
  'NOTIFIED',
  'RESOLVED',
])
export const telemetryEventTypeEnum = pgEnum('telemetry_event_type', [
  'route_enter',
  'route_leave',
  'feature_click',
  'form_abandon',
  'form_submit',
])

// task-csp-reports-and-flip — Часть A. Latest occurrence's disposition on an
// aggregated CSP violation row (see `cspReports` below).
export const cspDispositionEnum = pgEnum('csp_disposition', ['report', 'enforce'])

// task-resume-base — state of the one-shot AI extraction that turns an
// uploaded PDF/DOCX (or pasted text) into structured resume content.
// QUEUED → RUNNING → READY | FAILED. Mirrors packages/shared
// `resumeExtractionStatusSchema` (SSOT).
export const resumeExtractionStatusEnum = pgEnum('resume_extraction_status', [
  'QUEUED',
  'RUNNING',
  'READY',
  'FAILED',
])

// task-resume-template — state of the PDF render job that joins the stored
// Typst template with the stored fields. Separate from the extraction status
// because the two run at different times for different reasons: extraction
// happens once per uploaded file, a render happens on every content or layout
// change. `IDLE` = nothing has ever been rendered for this resume.
export const resumeRenderStatusEnum = pgEnum('resume_render_status', [
  'IDLE',
  'QUEUED',
  'RUNNING',
  'READY',
  'FAILED',
])

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  // Google / dicebear fallback URL — used when the user has no custom upload.
  // Renamed from `avatar` in migration 0013 for semantic clarity.
  avatarUrl: varchar('avatar_url', { length: 1000 }),
  // FK to documents (category = AVATAR). When set, takes priority over
  // `avatarUrl` everywhere on the front-end. ON DELETE SET NULL so a hard-
  // deleted document naturally reverts to the Google fallback. The actual
  // FK constraint is declared in migration 0013 — keeping the Drizzle column
  // metadata-only here avoids the circular import with `documents` (defined
  // further down in this file).
  avatarDocumentId: uuid('avatar_document_id'),
  role: roleEnum().notNull().default('JUNIOR'),
  googleId: varchar('google_id', { length: 255 }).unique(),
  telegram: varchar('telegram', { length: 100 }),
  phone: varchar('phone', { length: 30 }),
  // Tech stack — array of strings (chip-input on frontend)
  techStack: text('tech_stack').array(),
  // Payment requisites
  paymentMethod: paymentMethodEnum('payment_method'),
  walletUsdtErc20: text('wallet_usdt_erc20'),
  walletUsdtLabel: text('wallet_usdt_label'),
  bankUahRecipient: text('bank_uah_recipient'),
  bankUahIban: text('bank_uah_iban'),
  bankUahRnokpp: text('bank_uah_rnokpp'),
  bankUahBankName: text('bank_uah_bank_name'),
  // For SENIOR and ADMIN: percentage they keep from project income (0-100)
  seniorSharePercent: integer('senior_share_percent').notNull().default(26),
  // For DROP: percentage the drop keeps from project income (0-100, default 5).
  // Nullable for non-DROP roles. Drop role - phase 1.
  dropSharePercent: integer('drop_share_percent').default(5),
  // For JUNIOR/HR/ACCOUNTANT: fixed monthly salary (currency set separately)
  monthlySalary: numeric('monthly_salary', { precision: 10, scale: 2 }),
  salaryCurrency: currencyEnum('salary_currency').default('USD'),
  // Legal full name (Cyrillic, order: Surname First Patronymic).
  // Set by ADMIN at user creation / edit. Used in MSA contract instead of displayName.
  // NULL = not set → interpolateVariables falls back to displayName.
  legalFullName: text('legal_full_name'),
  // ФОП registration address (адреса реєстрації ФОП).
  // Used in contract templates via {{registrationAddress}}. Nullable.
  registrationAddress: text('registration_address'),
  // Soft delete (archived users hidden from main UI, restorable)
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  // Admin note (single overwriteable text field)
  adminNote: text('admin_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export const teams = pgTable('teams', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  // Discriminator: 'SENIOR' = legacy senior-team (default), 'DROP' = drop-team.
  // Mapping logic in TeamsService.mapTeam early-returns to mapDropTeam when
  // type='DROP'. Drop role - phase 1.
  type: teamTypeEnum('type').notNull().default('SENIOR'),
  telegram: varchar('telegram', { length: 500 }),
  // Optional Telegram channel handle (5–32 latin chars / digits / _, optional @).
  // Edited from the SENIOR's Edit dialog and propagates here via UsersService.adminUpdateUser.
  telegramChannel: text('telegram_channel'),
  notes: text('notes'),
  // task-team-senior-share-override. Team-level override for the SENIOR's
  // share percent (0-100). NULL = no team override → fall through to the
  // legacy resolver (project override → user default). Editable by ADMIN
  // and by HR (when owner of the team). Snapshotted into
  // `transactions.seniorSharePercent` + `seniorSharePercentSource` at
  // SENIOR_INCOME / DROP_INCOME creation time, so historical rows keep
  // their value after edits.
  seniorSharePercentOverride: integer('senior_share_percent_override'),
  // Soft delete (archived teams hidden from main UI, restorable)
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const teamMembers = pgTable('team_members', {
  id: uuid('id').defaultRandom().primaryKey(),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  // Soft delete of membership (NULL = active, timestamp = left)
  leftAt: timestamp('left_at', { withTimezone: true }),
})

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
  // task-drop-share-override-and-receiver (Part A). Per-project override for the
  // DROP's share percent (0-100). NULL = use users.dropSharePercent (→ 5).
  // Editable only by ADMIN/ACCOUNTANT. Resolved by resolveDropShare and
  // snapshotted onto DROP_INCOME / obligation rows. Mirror column below in
  // project_finance_settings for symmetry with the senior override.
  dropSharePercentOverride: integer('drop_share_percent_override'),
  // Soft delete (archived projects hidden from main UI, restorable). The
  // project lifecycle is binary: ACTIVE (archivedAt = null) vs ARCHIVED
  // (archivedAt = timestamp of when the project ended).
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

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
// Interviews
// ---------------------------------------------------------------------------

export const interviews = pgTable(
  'interviews',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    seniorId: uuid('senior_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    hrId: uuid('hr_id').references(() => users.id, { onDelete: 'set null' }),
    companyName: varchar('company_name', { length: 255 }).notNull(),
    vacancyUrl: varchar('vacancy_url', { length: 1000 }),
    callUrl: varchar('call_url', { length: 1000 }),
    stage: interviewStageEnum().notNull().default('HR_SCREEN'),
    notesDomain: varchar('notes_domain', { length: 255 }),
    notesTechStack: varchar('notes_tech_stack', { length: 500 }),
    notesTeamSize: varchar('notes_team_size', { length: 100 }),
    notesBenefits: varchar('notes_benefits', { length: 500 }),
    notesPaymentType: varchar('notes_payment_type', { length: 100 }),
    notesSalaryReview: varchar('notes_salary_review', { length: 255 }),
    notesCorpTech: varchar('notes_corp_tech', { length: 255 }),
    notesGeneral: varchar('notes_general', { length: 1000 }),
    position: integer('position').notNull().default(0),
    /**
     * BIZ-07: idempotency guard for HIRED → auto-project creation.
     * Set to the project.id the first time this interview is moved to HIRED.
     * On subsequent HIRED transitions the service checks this field and skips
     * createFromInterview, preventing duplicate projects / project_members.
     *
     * Partial unique index (WHERE created_project_id IS NOT NULL) is the
     * DB-level backstop: even a concurrent race cannot insert a second non-null
     * value for the same interview row because the index enforces uniqueness
     * across the entire table (not just per-interview — effectively each row
     * is unique by PK, so the partial index catches any attempt to set two
     * different project ids via concurrent transactions).
     *
     * ADD COLUMN DDL (apply to dev/prod manually before deploy):
     *   ALTER TABLE interviews ADD COLUMN created_project_id uuid;
     *   CREATE UNIQUE INDEX uq_interviews_created_project_id
     *     ON interviews (created_project_id)
     *     WHERE created_project_id IS NOT NULL;
     */
    createdProjectId: uuid('created_project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // BIZ-07: partial unique index — each created project can be linked to at
    // most one interview. Prevents duplicate project creation on repeated HIRED.
    uniqueIndex('uq_interviews_created_project_id')
      .on(t.createdProjectId)
      .where(sql`${t.createdProjectId} IS NOT NULL`),
  ],
)

// ---------------------------------------------------------------------------
// Finance — Transactions (unified ledger)
// ---------------------------------------------------------------------------

// Groups validated SENIOR_INCOME transactions into a single payout obligation
export const payoutRequests = pgTable(
  'payout_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    seniorId: uuid('senior_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Total income amount across all linked SENIOR_INCOME transactions
    incomeAmount: numeric('income_amount', { precision: 18, scale: 6 }).notNull(),
    // Amount senior must pay = incomeAmount * (1 - seniorSharePercent/100)
    payableAmount: numeric('payable_amount', { precision: 18, scale: 6 }).notNull(),
    // Destination wallet — generated server-side at create time (stub until
    // PHASE 8 deploys the real PaymentSplitter). Shape-compatible with
    // Ethereum addresses: '0x' + 40 hex chars. SENIOR copies this and sends
    // the payable_amount in USDT to it, then submits the tx_hash for
    // verification.
    contractAddress: varchar('contract_address', { length: 255 }).notNull(),
    txHash: varchar('tx_hash', { length: 255 }),
    // task-onchain-payment-integrity. The on-chain SENDER of the settling
    // transfer (ERC-20 `topics[1]`, tx-level `from` as fallback), lowercase.
    // OBSERVED, NOT ENFORCED: staff often withdraw from an exchange, so this is
    // frequently the exchange's hot wallet rather than their own address —
    // gating on it would reject honest payments (owner decision). Recorded so
    // ADMIN/ACCOUNTANT can see who actually paid; NULL for pending payouts,
    // off-chain manual confirmations and dev-simulate settlements.
    txFromAddress: varchar('tx_from_address', { length: 42 }),
    status: payoutRequestStatusEnum().notNull().default('PENDING'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // SECURITY (NEW-M1): TOCTOU backstop for the txHash-reuse guard. A given
    // on-chain txHash may settle at most ONE payout PAID. The app-level
    // check-then-act guards in payPayoutRequest / manualConfirmPayout race under
    // concurrency (two PENDING payouts confirmed with the same real hash can both
    // pass the SELECT before either UPDATE commits → company balance credited
    // TWICE for one transfer). This partial unique index makes the second flip-to-
    // PAID fail at the DB (code 23505), caught in applyPayoutPaidCascade.
    //
    // Partial (WHERE status='PAID' AND tx_hash IS NOT NULL): PENDING rows carry a
    // null/placeholder hash and must NOT collide, and synthetic markers
    // (0xMANUAL… / 0xSIM…) are unique by construction so they never false-positive.
    // Mirrors uq_transactions_company_deposit_tx_hash (#249 M3).
    uniqueIndex('uq_payout_requests_txhash_paid')
      .on(t.txHash)
      .where(sql`${t.status} = 'PAID' AND ${t.txHash} IS NOT NULL`),
  ],
)

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    type: transactionTypeEnum().notNull(),
    status: transactionStatusEnum().notNull().default('PENDING'),
    amount: numeric('amount', { precision: 18, scale: 6 }).notNull(),
    // currency always stored; USDT for crypto flows, USD for salary/expenses
    currency: currencyEnum().notNull().default('USDT'),
    /**
     * task-salary-pay-amount — OBLIGATION snapshot, written by `paySalary` at
     * the PENDING→PAID flip. task-drop-payout-currency (2026-08) extends the
     * SAME triple to `PendingSettlementService.settleByCompany`'s DROP-only
     * branch (settling a DROP_PENDING_PAYOUT obligation in a non-obligation
     * currency) — byte-for-byte the same three columns, same
     * `isStorableExchangeRate` guard, only the amount is SERVER-computed via
     * `convertToBase` rather than client-supplied (the settle dialog's amount
     * field is fully disabled — there is no client fact to record, only a
     * conversion). A SENIOR settle does NOT write these — unaffected by this
     * task, unchanged pre-existing behaviour. All three are NULL on every
     * other row (including a SENIOR settle).
     *
     * WHY THIS EXISTS. A salary is created as a PENDING reminder denominated in
     * the obligation's own currency («800 USD»). It is settled later, possibly
     * in another currency, and the owner requires `amount`/`currency` above to
     * carry the FACT of that payment («30 000 UAH») so a bank statement
     * reconciles one-to-one. Overwriting them with the fact and nothing else
     * would DESTROY the obligation — and USD reporting, balances and the
     * «projects unpaid this month» metric are all built on it. So the fact goes
     * into `amount`/`currency`, and the obligation it settled is preserved
     * here. Nothing is lost; both readings of the row stay derivable forever.
     *
     *   original_amount   — `amount`   as it stood immediately BEFORE payment.
     *   original_currency — `currency` as it stood immediately BEFORE payment.
     *   exchange_rate     — the EFFECTIVE applied rate, `paid / original`
     *                       (units of the paid currency per 1 unit of the
     *                       original). Computed SERVER-SIDE from the two
     *                       amounts, never accepted from the client — for
     *                       paySalary the payer settles at their own bank's
     *                       rate, which is by definition whatever those two
     *                       amounts imply; for settleByCompany's DROP branch
     *                       there is no external fact at all (the amount
     *                       field is disabled), so the server derives BOTH
     *                       amounts via the NBU rate. Either way a
     *                       client-supplied rate would add nothing but a
     *                       spoofable field. A SNAPSHOT of what was applied at
     *                       pay time (like `senior_share_percent`) — a later
     *                       `adminEditTransaction` on `amount` does not rewrite
     *                       it; the audit log records that edit separately.
     *                       scale 8 (not the 6 used for money) so a
     *                       sub-unit rate — e.g. UAH→USD ≈ 0.02666667 — keeps
     *                       full precision; it is a ratio, not an amount.
     *
     * NULLABLE, NO DEFAULT, NO BACKFILL — deliberately. NULL reads as «this row
     * was never paid through the amount-aware flow», which is the literal truth
     * for every legacy row: their `amount` still means exactly what it always
     * meant, so there is nothing to migrate and every existing balance/metric
     * keeps returning the same number it returned before this column existed.
     *
     * ADD COLUMN DDL (prod is applied via deploy.yml — there is no SSH; see
     * apps/api/drizzle/manual/2026-08-05_salary_paid_amount.sql):
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS original_amount numeric(18,6);
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS original_currency currency;
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS exchange_rate numeric(18,8);
     */
    originalAmount: numeric('original_amount', { precision: 18, scale: 6 }),
    originalCurrency: currencyEnum('original_currency'),
    exchangeRate: numeric('exchange_rate', { precision: 18, scale: 8 }),
    // Sender: real user or null (use senderLabel for named non-user entities)
    senderId: uuid('sender_id').references(() => users.id, { onDelete: 'set null' }),
    // "CheekyCheeseIT", "Project: Acme Corp", expense category, etc.
    senderLabel: varchar('sender_label', { length: 255 }),
    // Receiver: real user or null
    receiverId: uuid('receiver_id').references(() => users.id, { onDelete: 'set null' }),
    receiverLabel: varchar('receiver_label', { length: 255 }),
    // Drop role - phase 2. Optional, nullable explicit recipient reference for
    // transactions whose intended payee is NOT the same as receiverId (e.g.
    // PAYOUT_DROP semantics — receiverId = DROP user, recipientId = DROP user;
    // future-friendly for transactions that need a 3rd-party FK).
    // For backward compatibility every existing row keeps NULL.
    // FK ON DELETE SET NULL: keeps audit trail intact if a referenced user is
    // hard-deleted (we soft-delete via archivedAt — this is defensive).
    recipientId: uuid('recipient_id').references(() => users.id, { onDelete: 'set null' }),
    // Project this income/payout is associated with
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    // For PAYOUT / PAYOUT_ADMIN: links to the payout_request that triggered them
    payoutRequestId: uuid('payout_request_id').references(() => payoutRequests.id, {
      onDelete: 'set null',
    }),
    /**
     * security-review PR #443 (MED-B): a POSITIVE, permanent origin marker for
     * a DROP_PENDING_PAYOUT / PAYOUT_DROP row — true ⟺ this row's drop-share
     * IOU was booked by the drop-payout CASCADE (applyPayoutPaidCascade), i.e.
     * its money NEVER touched the shared company account (only `payable =
     * income*(1-dropShare%)` did — the drop keeps their own cut before the
     * on-chain transfer). `false` for an admin-USDT-declaration-booked drop
     * IOU (declareUsdtProjectIncome).
     *
     * CORRECTION (round 5): `false` is a cascade-vs-declaration discriminator,
     * NOT a "the company account holds this money" guarantee.
     * declareUsdtProjectIncome can route a declared income to a SPECIFIC
     * admin's personal wallet instead of the shared pool
     * (`toCompanyPool=false`) — the obligations it books still get `false`
     * here even though the company pool never received that income either.
     * Which pot actually pays is decided at SETTLE time by the ADMIN/
     * ACCOUNTANT's funding-source choice (COMPANY_ACCOUNT vs ADMIN_PERSONAL —
     * see settleByCompany, pending-settlement.service.ts), same as the
     * analogous senior-obligation case. This column only rules out the ONE
     * scenario where the money is PROVABLY never in the pool (the drop-
     * payout self-service cascade); it does not prove the opposite.
     *
     * WHY a dedicated column instead of `payoutRequestId IS NOT NULL`: that FK
     * is `ON DELETE SET NULL` — a future cleanup of an unrelated
     * `payout_requests` row would silently null it, and the settleByCompany
     * HIGH-1 funding-source guard (pending-settlement.service.ts) would then
     * fail OPEN (a cascade-originated row would look indistinguishable from an
     * admin-declared one and wrongly allow a COMPANY_ACCOUNT-funded settle —
     * debiting money the company never received). This column is stamped ONCE
     * at INSERT time (bookCompanyObligations, transactions.service.ts) from
     * the CALLER's intent, not derived from `payoutRequestId` afterwards —
     * later FK activity on `payout_requests` can never touch it. The backfill
     * script (`2026-07-27_drop_share_pending_parity_backfill.sql`) stamps the
     * SAME marker on the historical rows it converts, for the identical reason.
     *
     * NULLABLE, NO DEFAULT (security-review PR #443 round 3, LOW): a
     * `NOT NULL DEFAULT false` column cannot distinguish "explicitly verified
     * non-cascade" from "nobody ever set this" — an unrelated FUTURE insert
     * path for a DROP_PENDING_PAYOUT row that forgets to stamp this field
     * would silently inherit the PERMISSIVE default (`false`, "safe to settle
     * from the company account") rather than failing loudly. Left nullable
     * instead: `NULL` = unknown/unset, and the settleByCompany guard below
     * treats `!== false` (i.e. `true` OR `null`) as BLOCK — only an EXPLICIT
     * `false` (stamped by bookCompanyObligations for the admin-declared path)
     * allows a COMPANY_ACCOUNT settle. A silently-forgotten stamp therefore
     * fails SAFE (blocks) instead of failing OPEN. Not made `NOT NULL` outright
     * (which would force every OTHER transaction type's insert call site —
     * SALARY, EXPENSE, ADMIN_INCOME, COMPANY_DEPOSIT, …, none of which this
     * column is meaningful for — to explicitly pass a value, and would need a
     * backfill migration for existing rows) — that cost is disproportionate to
     * a column only `DROP_PENDING_PAYOUT`/`PAYOUT_DROP` rows ever read.
     *
     * ADD COLUMN DDL (apply to dev/prod manually before deploy — same
     * additive-push pattern as `idempotencyKey` above):
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS drop_cascade_origin boolean;
     */
    dropCascadeOrigin: boolean('drop_cascade_origin'),
    // Snapshot of senior share percent at time of SENIOR_INCOME creation
    seniorSharePercent: integer('senior_share_percent'),
    // task-team-senior-share-override. Snapshot of *where* the percent above
    // came from at creation time. One of 'PROJECT' | 'TEAM' | 'USER_DEFAULT'.
    // Nullable to keep legacy rows (pre-task) renderable as-is. The hierarchy
    // resolved here is: project override → team override → user default.
    seniorSharePercentSource: varchar('senior_share_percent_source', { length: 16 }),
    // task-drop-share-override-and-receiver (Part A). Snapshot of the DROP share
    // percent at DROP_INCOME / DROP_PENDING_PAYOUT creation time — makes the
    // distribution deterministic (changing users.dropSharePercent later does not
    // retroactively re-price existing rows). Nullable — only drop-flow rows
    // carry it; legacy DROP_INCOME rows (pre-task) fall back to the resolver.
    dropSharePercent: integer('drop_share_percent'),
    // Snapshot source for the percent above — 'PROJECT' | 'USER_DEFAULT' (no
    // team level for the drop). Nullable for legacy / non-drop rows.
    dropSharePercentSource: varchar('drop_share_percent_source', { length: 16 }),
    /**
     * task-admin-income-drop-backfill (2026-08-12). Links a SENIOR_PENDING_PAYOUT
     * / DROP_PENDING_PAYOUT obligation row back to the ADMIN_INCOME (or other
     * admin-USDT declaration) transaction it was booked FROM, when known.
     *
     * WHY THIS EXISTS. Before this column, "does this income already have a
     * booked share?" could only be answered by matching project + amount +
     * time — good enough to browse, not good enough to move real money on.
     * `createAdminIncome` never called `bookCompanyObligations` (the historical
     * bug this task's data-fix backfills — see
     * apps/api/drizzle/manual/2026-08-12_admin_income_drop_backfill_*.sql), so a
     * project can carry ADMIN_INCOME rows with zero, one, or several
     * DROP_PENDING_PAYOUT rows and no reliable way to tell which income each one
     * covers. This column makes that link explicit and queryable.
     *
     * Stamped ONCE, by `bookCompanyObligations`, on BOTH the senior and the drop
     * IOU it books — set to the id of the income row that caused the booking,
     * when the caller knows it. `declareUsdtProjectIncome` always does (it is
     * the ADMIN_INCOME row it just inserted, in the SAME db transaction).
     * `applyPayoutPaidCascade` deliberately does NOT pass it: that call books
     * ONE obligation per payout REQUEST, which can aggregate several linked
     * SENIOR_INCOME/DROP_INCOME rows behind a single `payoutRequestId` — there
     * is no single source income to name, and `payoutRequestId` +
     * `dropCascadeOrigin` already discriminate that origin. NULL there is the
     * honest answer, not a gap.
     *
     * NULLABLE, NO DEFAULT, NO BACKFILL of the column itself (the DATA backfill
     * for historical rows is a separate, explicit two-deploy SQL pair — see the
     * files named above) — every row created before this column existed keeps
     * NULL forever. That is the literal truth: their origin was genuinely never
     * recorded, and inventing one after the fact is guessing, not data.
     *
     * Self-referencing FK, ON DELETE SET NULL — a (hypothetical, ADMIN-only)
     * hard-delete of the source income never blocks or cascades into the
     * obligation it produced; the obligation itself is truth about money owed
     * regardless of what later happens to its origin's audit trail.
     *
     * ADD COLUMN DDL (prod is applied via deploy.yml — there is no SSH; see
     * apps/api/drizzle/manual/2026-08-12_admin_income_drop_backfill_column.sql):
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source_income_transaction_id uuid
     *     REFERENCES transactions(id) ON DELETE SET NULL;
     *
     * security-review round 2 (PR #517, MED-F): the backfill script's own
     * SELECT predicate ("not already linked") is a read-then-write guard —
     * correct for a single sequential run, but NOT a structural defence
     * against two overlapping `apply.sql` executions (a manual re-run
     * triggered while a prior one is still in flight). The partial unique
     * index below converts that guarantee from "predicate, hopefully
     * evaluated once" into "the database physically refuses a second
     * DROP_PENDING_PAYOUT/PAYOUT_DROP row for the same source income" — a
     * genuine concurrent race hits 23505 instead of silently double-booking.
     * Scoped to the drop-share row types (not senior) because those are the
     * ONLY types this backfill ever creates; a co-existing
     * SENIOR_PENDING_PAYOUT row for the SAME income (created by the SAME
     * `bookCompanyObligations` call, same `sourceIncomeTransactionId`) is a
     * different `type` value and therefore outside this partial index's row
     * set — no conflict with the normal declare flow, which always books
     * both in one call. See `uq_transactions_admin_income_idempotency_key`
     * above for the sibling pattern this mirrors.
     *
     * ADD INDEX DDL — same file as the column above:
     *   CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_source_income_drop_link
     *     ON transactions (source_income_transaction_id)
     *     WHERE type IN ('DROP_PENDING_PAYOUT', 'PAYOUT_DROP')
     *       AND source_income_transaction_id IS NOT NULL;
     */
    sourceIncomeTransactionId: uuid('source_income_transaction_id').references(
      (): AnyPgColumn => transactions.id,
      { onDelete: 'set null' },
    ),
    /**
     * task-drop-sees-own-obligations (security-review PR #523 round 1, MED-4).
     * Snapshot of `projects.companyName` at the moment `bookCompanyObligations`
     * books a SENIOR_PENDING_PAYOUT / DROP_PENDING_PAYOUT IOU row — the same
     * "snapshot at creation, never re-derived" contract `dropSharePercent` /
     * `seniorSharePercent` already use above, applied to the display name
     * instead of a money figure.
     *
     * WHY THIS EXISTS. `getDropSelfIncomes` (the drop's own incomes feed)
     * resolves an obligation row's `companyName` by joining the LIVE
     * `projects` row (`senderLabel` on these rows is always the literal
     * 'COMPANY' marker other code branches on — see transactions.service.ts
     * `findAll`'s `sideLabel === 'COMPANY'` check and TransactionRow.tsx's
     * matching branch — so it can never carry the real company name the way
     * `createDropIncome`'s `senderLabel` already does for the OLD
     * self-declared model). A live join means renaming the project later
     * silently rewrites what a drop reads as history for money already
     * booked under the OLD name — the one thing a money-history view must
     * never do. This column is the fix: read once, frozen forever, exactly
     * like every other snapshot column on this row.
     *
     * NULLABLE, NO BACKFILL — every DROP_PENDING_PAYOUT/PAYOUT_DROP row
     * created before this column existed keeps NULL; `getDropSelfIncomes`
     * falls back to the live `projects` join for those (§AC — same fallback
     * `companyName` behaviour it always had, only for rows genuinely
     * created before a snapshot was possible to take).
     *
     * ADD COLUMN DDL (prod is applied via deploy.yml — there is no SSH; see
     * apps/api/drizzle/manual/2026-08-12_drop_obligation_company_name_snapshot.sql):
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS company_name_snapshot varchar(255);
     */
    companyNameSnapshot: varchar('company_name_snapshot', { length: 255 }),
    // Receipt — uploaded file (FK to documents.id, category=RECEIPT) OR an
    // external URL (etherscan link, screenshot). Mutually exclusive — enforced
    // by a row-level CHECK constraint, see migration 0013. Both NULL = no
    // receipt attached.
    receiptDocumentId: uuid('receipt_document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    receiptExternalUrl: text('receipt_external_url'),
    // FK to documents (category = INVOICE). Points at the currently-active
    // signed/pending invoice PDF for this transaction. ON DELETE SET NULL so
    // hard-deleting an invoice document leaves the transaction intact but
    // marks it as having no active invoice attached (a fresh one can be
    // regenerated by ADMIN). Populated only for SENIOR_INCOME (after payout
    // submission) and SALARY (after status → PAID). Other transaction types
    // never have invoices.
    invoiceDocumentId: uuid('invoice_document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    // Blockchain TX hash (for PAYOUT, PAYOUT_ADMIN, COMPANY_DEPOSIT)
    txHash: varchar('tx_hash', { length: 255 }),
    // task-onchain-payment-integrity. On-chain SENDER of that transfer
    // (ERC-20 `topics[1]`, tx-level `from` as fallback), lowercase. Same
    // OBSERVED-NOT-ENFORCED contract as `payout_requests.tx_from_address` —
    // recorded for ADMIN/ACCOUNTANT audit, never a credit gate (exchange
    // withdrawals legitimately show the exchange's wallet). NULL wherever no
    // on-chain sender was resolved.
    txFromAddress: varchar('tx_from_address', { length: 42 }),
    // task-company-account-backend. Funding source of a SALARY row:
    //   'COMPANY_ACCOUNT' — paid from the shared company USDT account (debits
    //                       its derived balance); always USDT.
    //   'ADMIN_PERSONAL'  — paid from an admin partner's personal account; does
    //                       NOT touch the company balance.
    // NULL on every non-SALARY row (and on legacy SALARY rows, treated as
    // admin-personal for balance purposes). varchar (not a pg enum) to keep the
    // additive migration push-friendly and the nullable semantics simple.
    fundingSource: varchar('funding_source', { length: 16 }),
    /**
     * Client-supplied idempotency key. SHARED across two idempotent flows —
     * one nullable column, one key namespace, guarded by two DISJOINT partial
     * unique indexes (one per `type`):
     *   - BIZ-19 (MED-2): DIVIDEND_TO_ADMIN (createDividend).
     *   - PR #367 (MED-1): ADMIN_INCOME    (declareUsdtProjectIncome).
     * The caller generates a UUID and passes it on the first request; a
     * subsequent request with the same key returns the existing row (no-op).
     * NULL for all other rows and for legacy callers without a key
     * (backward-compat: keyless rows get fresh rows, unaffected by the indexes).
     *
     * ADD COLUMN + INDEX DDL (apply to dev/prod manually before deploy):
     *   ALTER TABLE transactions ADD COLUMN idempotency_key uuid;
     *   CREATE UNIQUE INDEX uq_transactions_dividend_idempotency_key
     *     ON transactions (idempotency_key)
     *     WHERE type = 'DIVIDEND_TO_ADMIN' AND idempotency_key IS NOT NULL;
     *   CREATE UNIQUE INDEX uq_transactions_admin_income_idempotency_key
     *     ON transactions (idempotency_key)
     *     WHERE type = 'ADMIN_INCOME' AND idempotency_key IS NOT NULL;
     */
    idempotencyKey: uuid('idempotency_key'),
    // Accountant/admin validation fields (for SENIOR_INCOME)
    validatedBy: uuid('validated_by').references(() => users.id, { onDelete: 'set null' }),
    validatedAt: timestamp('validated_at', { withTimezone: true }),
    rejectionReason: varchar('rejection_reason', { length: 500 }),
    notes: varchar('notes', { length: 1000 }),
    // Calendar month this transaction belongs to (for SALARY/LOCKED logic): YYYY-MM
    salaryMonth: varchar('salary_month', { length: 7 }),
    // User-specified transaction date (defaults to creation time if not provided)
    txDate: timestamp('tx_date', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    /**
     * task-soft-delete-and-money-audit (security-audit finding 3, 27.07).
     * Soft-delete triple — `adminDeleteTransaction` now marks a row instead of
     * physically removing it (`DELETE FROM transactions` is gone). All three
     * are NULL on an active row and set together at delete time, cleared
     * together at restore time (`restoreTransaction`, ADMIN-only).
     *
     * Visibility (owner requirement, 27.07): a deleted row is visible ONLY to
     * ADMIN/ACCOUNTANT, and even then hidden from the default list — see the
     * `TransactionsService.findAll` `includeDeleted` toggle. Every other role
     * gets a 404 (never 403) both in the list and on a direct `GET
     * /transactions/:id` — a 403 would leak that the row exists.
     *
     * ON DELETE SET NULL on `deletedBy` (not RESTRICT/CASCADE): keeps the
     * deleted row's audit trail intact even if the deleting ADMIN's user row
     * is later removed — mirrors `validatedBy`/`createdBy` above.
     *
     * ADD COLUMN + INDEX DDL (apply to dev/prod manually before deploy — same
     * additive-push pattern as `idempotencyKey` above; migration file:
     * apps/api/drizzle/manual/2026-08-01_transaction_soft_delete.sql):
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS deleted_by uuid
     *     REFERENCES users(id) ON DELETE SET NULL;
     *   ALTER TABLE transactions ADD COLUMN IF NOT EXISTS deletion_reason varchar(500);
     *   CREATE INDEX IF NOT EXISTS idx_transactions_active_created_at
     *     ON transactions (created_at) WHERE deleted_at IS NULL;
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    deletionReason: varchar('deletion_reason', { length: 500 }),
  },
  (t) => [
    // task-soft-delete-and-money-audit: supports the `WHERE deleted_at IS
    // NULL` predicate every hot read (findAll default list, every balance /
    // summary aggregate) now carries. Partial so the index stays small — it
    // never needs to cover the (presumably rare) deleted rows.
    index('idx_transactions_active_created_at')
      .on(t.createdAt)
      .where(sql`${t.deletedAt} IS NULL`),
    // PR-3: 1:1 receipt ↔ income invariant — one receipt document can be linked
    // to at most one transaction. Partial index (WHERE IS NOT NULL) so that
    // multiple transactions with no receipt (NULL) are still allowed.
    uniqueIndex('uq_transactions_receipt_document_id')
      .on(t.receiptDocumentId)
      .where(sql`${t.receiptDocumentId} IS NOT NULL`),
    // task-company-account-backend. Idempotency for company deposits: a given
    // on-chain txHash can be submitted at most once as a COMPANY_DEPOSIT. Partial
    // (WHERE type='COMPANY_DEPOSIT') so PAYOUT/PAYOUT_ADMIN rows that legitimately
    // reuse a hash (e.g. simulate stubs) are unaffected. A duplicate submit hits
    // this constraint OR is short-circuited by the service's lookup-first guard.
    uniqueIndex('uq_transactions_company_deposit_tx_hash')
      .on(t.txHash)
      .where(sql`${t.type} = 'COMPANY_DEPOSIT' AND ${t.txHash} IS NOT NULL`),
    // Audit 2026-06-27 (LOW #5). Idempotency for the monthly salary cron: a given
    // (receiver, salaryMonth) can hold at most ONE SALARY row. Without it the cron
    // had a find-then-insert gap (TOCTOU) — a concurrent / re-run cron could
    // create duplicate salary reminders for the same employee+month. Partial
    // (WHERE type='SALARY' AND salaryMonth IS NOT NULL) so non-salary rows and
    // legacy salary rows with no month are unaffected. The cron now inserts with
    // `onConflictDoNothing` targeting this index — the DB is the single source of
    // truth for "already created", closing the gap.
    uniqueIndex('uq_transactions_salary_receiver_month')
      .on(t.receiverId, t.salaryMonth)
      .where(sql`${t.type} = 'SALARY' AND ${t.salaryMonth} IS NOT NULL`),
    // BIZ-19: idempotency key for DIVIDEND_TO_ADMIN. Client supplies a UUID;
    // the DB enforces that the same key cannot produce two dividend rows.
    // Partial (WHERE type='DIVIDEND_TO_ADMIN' AND idempotency_key IS NOT NULL)
    // so all other transaction types and keyless dividends are unaffected.
    uniqueIndex('uq_transactions_dividend_idempotency_key')
      .on(t.idempotencyKey)
      .where(sql`${t.type} = 'DIVIDEND_TO_ADMIN' AND ${t.idempotencyKey} IS NOT NULL`),
    // PR #367 (MED-1): idempotency key for ADMIN_INCOME (declareUsdtProjectIncome).
    // Last-line-of-defence backstop for a double-submitted admin-USDT income —
    // the service's early-SELECT short-circuits the common replay; two truly
    // concurrent submits that both miss it collide here (23505) instead of
    // creating two incomes + two obligation sets. Partial + type-scoped so it is
    // DISJOINT from the dividend index above (same column, different type) and
    // leaves every other transaction type and keyless row untouched.
    uniqueIndex('uq_transactions_admin_income_idempotency_key')
      .on(t.idempotencyKey)
      .where(sql`${t.type} = 'ADMIN_INCOME' AND ${t.idempotencyKey} IS NOT NULL`),
    // security-review round 2 (PR #517, MED-F) — structural race guard for the
    // admin-income-drop-backfill apply script. See the doc comment on
    // `sourceIncomeTransactionId` above for the full reasoning: at most one
    // DROP_PENDING_PAYOUT/PAYOUT_DROP row may ever carry a given
    // `source_income_transaction_id` — a concurrent second `apply.sql` run
    // hits 23505 instead of double-booking a drop's share.
    uniqueIndex('uq_transactions_source_income_drop_link')
      .on(t.sourceIncomeTransactionId)
      .where(
        sql`${t.type} IN ('DROP_PENDING_PAYOUT', 'PAYOUT_DROP') AND ${t.sourceIncomeTransactionId} IS NOT NULL`,
      ),
  ],
)

// ---------------------------------------------------------------------------
// nonDeletedTransactions — security-review PR #456 round 2 (verdict BLOCK on
// 4834458611/4840207923). ELIMINATE, not detect.
// ---------------------------------------------------------------------------
//
// Round 1 added `transaction-visibility.util.ts` (guard FUNCTIONS a caller
// must remember to invoke) plus a text-scanning spec meant to catch a caller
// who forgot. Round 2's review defeated the scanner 7/7 with realistic
// variants (a second unguarded read sharing a guarded function's window; a
// bare `deletedAt` substring inside a COMMENT; `.rightJoin`/`alias()`/nested
// relational `with: { transactions: true }` — forms the pattern list never
// enumerated) and, most importantly, DELETED the guard call itself from
// `getDepositStatus` while leaving the explaining comment behind — the
// scanner stayed green. A textual pattern-match can always be defeated by a
// slightly different text; "detect the mistake" does not scale against that.
//
// This view makes the mistake impossible to make for every read that must
// NEVER see a deleted row regardless of caller privilege (every list/
// aggregate/join in invoices, documents, admin-summary, balance, projects,
// and this service's own non-privileged aggregates) — a SQL VIEW filters at
// the FROM clause itself, before any WHERE a caller could forget to write:
//
//   SELECT * FROM nonDeletedTransactions
//
// can never return a soft-deleted row, no matter how it is joined, aliased,
// interpolated into a raw `sql` template, or extended by a future column —
// there is no WHERE clause to omit. And critically: `db.update(nonDeleted
// Transactions)` / `.insert(...)` / `.delete(...)` do not TYPECHECK — Drizzle
// views do not satisfy the `PgTable` shape `.update()`/`.insert()`/`.delete()`
// require (verified: `tsc --noEmit` rejects it with "Property '$inferInsert'
// is missing"), so a view-only import cannot be misused for a write either.
//
// Combined with the ESLint `no-restricted-imports` rule (apps/api/eslint
// .config.mjs) that bans importing the raw `transactions` table from outside
// `finance/**`, a module like `invoices/` or `documents/` can no longer
// reach an unfiltered row AT ALL for its list/aggregate/join reads — not "is
// discouraged from", CANNOT: the raw symbol is not an available import.
//
// What this view does NOT cover (by design, not oversight):
//   - Single-row-by-id reads where ADMIN/ACCOUNTANT must still see a deleted
//     row (findOne, getInvoice, signInvoice, getDepositStatus, the audit-log
//     read) — these need role-conditional visibility a static view cannot
//     express. These stay on the raw `transactions` table INSIDE `finance/`
//     (the only place still allowed to import it) and route through
//     `fetchVisibleTransactionOrThrow` / `fetchWritableTransactionOrThrow`
//     (transaction-visibility.util.ts) — fetch and guard are ONE function
//     call there, specifically so the getDepositStatus-class mistake (delete
//     the guard line, keep the fetch) is no longer two separate statements
//     where one can be silently dropped.
//   - Idempotency-by-hash/key lookups (submitDeposit, declareUsdtProjectIncome,
//     describeReferent, …) that must see a deleted row so a hash/key cannot
//     be replayed past a soft-deleted duplicate — these are read-only
//     diagnostic/idempotency paths, never a money or visibility decision,
//     and stay on the raw table too (still finance/-only).
// security-review PR #456 round 3 (LOW, flagged as the one worth fixing): the
// view's filter is now defined in exactly ONE place in TypeScript —
// `NON_DELETED_TRANSACTIONS_PREDICATE` — instead of being inlined only inside
// the `pgView(...).as(...)` callback below. This exists so
// `non-deleted-transactions-view-consistency.spec.ts` can compile the SAME
// predicate object the view actually uses (not a hand-copied re-statement of
// it) and diff its rendered SQL against
// `drizzle/manual/2026-08-03_non_deleted_transactions_view.sql`'s WHERE
// clause — the two sources (dev/CI: this file, via `drizzle-kit push`; prod:
// the manual SQL file, since prod ships no drizzle-kit) have no other tie
// keeping them in sync, and were flagged as able to "разъехаться молча" (drift
// apart silently) if either changes without the other.
export const NON_DELETED_TRANSACTIONS_PREDICATE = isNull(transactions.deletedAt)

export const nonDeletedTransactions = pgView('non_deleted_transactions').as((qb) =>
  qb.select().from(transactions).where(NON_DELETED_TRANSACTIONS_PREDICATE),
)

// ---------------------------------------------------------------------------
// Consumed on-chain tx hashes — task-onchain-payment-integrity (CROSS-PATH)
// ---------------------------------------------------------------------------
//
// SECURITY INVARIANT: a REAL on-chain transfer may settle AT MOST ONE thing in
// this system — either one payout, or one company deposit. Never both, never
// twice.
//
// Why a dedicated table: before this, each money path guarded its own hash
// re-use in its OWN table and was blind to the other —
//   • payPayoutRequest / manualConfirmPayout scanned `payout_requests`
//     (backstop `uq_payout_requests_txhash_paid`),
//   • submitDeposit scanned `transactions WHERE type='COMPANY_DEPOSIT'`
//     (backstop `uq_transactions_company_deposit_tx_hash`).
// Both indexes are partial and DISJOINT, so ONE transfer could legally land in
// both tables and `computeCompanyAccountBalanceFromLedger` summed BOTH terms →
// the company balance was credited TWICE for a single transfer (phantom money
// that then funds salary/expense/dividend gates). Fixing one path could never
// close it: the two paths must share ONE registry.
//
// The row is inserted INSIDE the same DB transaction that performs the credit,
// so a concurrent double-spend is decided by the unique index (23505 → clean
// 400), not by a check-then-act read that can go stale.
//
// Only REAL on-chain hashes (0x + 64 hex) are registered; synthetic audit
// markers (`0xSIM…` dev-simulate, `0xMANUAL…` off-chain confirmations) are
// unique by construction and reference no on-chain transfer — see
// `normalizeOnChainTxHash` in `finance/onchain-tx.ts` (single source of truth
// for the shape rule + lowercase normalisation).
export const consumedTxHashes = pgTable(
  'consumed_tx_hashes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // ALWAYS lowercase-normalised (`normalizeOnChainTxHash`). Storing the
    // normalised form lets the uniqueness be a plain column index — no
    // expression index — while `0xAB…` and `0xab…` still collide.
    txHash: varchar('tx_hash', { length: 66 }).notNull(),
    // Which money path consumed it: 'PAYOUT' | 'COMPANY_DEPOSIT'.
    purpose: varchar('purpose', { length: 32 }).notNull(),
    // payout_requests.id or transactions.id. Deliberately NOT an FK: the
    // registry must outlive its referent (a deleted payout must not free the
    // hash for re-use).
    referenceId: uuid('reference_id'),
    // Who submitted the hash (audit trail for abuse investigation).
    consumedByUserId: uuid('consumed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    // ── TOMBSTONE (security-review round 5, MED-J) ──────────────────────────
    // An ADMIN release marks the claim released instead of DELETEing it.
    // Deleting erased the evidence: the double credit stayed in the ledger
    // while the "released → spent again" pair — the exact sequence an
    // investigator needs — left no trace anywhere. Kept rows also let the
    // re-claim be detected and recorded (`ONCHAIN_HASH_RECLAIMED_AFTER_RELEASE`).
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedBy: uuid('released_by').references(() => users.id, { onDelete: 'set null' }),
    releasedReason: text('released_reason'),
  },
  (t) => [
    // THE cross-path guard. PARTIAL: uniqueness binds only ACTIVE claims, so a
    // released tombstone stays in the table (evidence) without blocking the
    // re-settlement the release was granted for.
    uniqueIndex('uq_consumed_tx_hashes_active_tx_hash')
      .on(t.txHash)
      .where(sql`${t.releasedAt} IS NULL`),
  ],
)

// ---------------------------------------------------------------------------
// Company Account (USDT) — task-company-account-backend
// ---------------------------------------------------------------------------
//
// Single-row table holding the shared company USDT wallet config. The balance
// itself is NOT stored — it is derived on-demand from the transactions ledger
// (COMPANY_DEPOSIT − DIVIDEND_TO_ADMIN − company-funded SALARY), keeping the
// ledger the single source of truth (same philosophy as BalanceService).
export const companyAccount = pgTable('company_account', {
  id: uuid('id').defaultRandom().primaryKey(),
  // Nullable until an admin configures the wallet. Validated as a 0x+40-hex ETH
  // address at the service/Zod layer before write.
  walletAddress: varchar('wallet_address', { length: 42 }),
  // Confirmations required before a deposit flips PENDING → PAID. Default 12.
  confirmationThreshold: integer('confirmation_threshold').notNull().default(12),
  // Company requisites markdown (nullable until ADMIN configures it). Auto-appended
  // as a «Реквизиты компании» section at the END of every NEW contract at sign
  // time → baked immutably into signed_contracts.body_markdown_snapshot. Editing
  // it later affects ONLY future signings (existing snapshots are never rewritten).
  requisitesMarkdown: text('requisites_markdown'),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Pending Obligations (Phase 4-A)
// ---------------------------------------------------------------------------
//
// Tracks "X owes senior Y `amount` `currency`". Separate from the
// transactions ledger because the lifecycle is its own state machine:
//   PENDING (created with the source transaction, e.g. TOV_INCOME)
//     ↓
//   PAID (closed by a SENIOR_PAID transaction; closingTransactionId set)
//     ↓
//   CANCELLED (written off; closingTransactionId may stay null)
//
// Why a dedicated table vs. computing closure from a (TOV_INCOME, SENIOR_PAID)
// pair: explicit lifecycle = explicit history. Cancellation, partial payment
// (future), and multi-source obligations are first-class concepts here. The
// senior's *real* balance still derives from SENIOR_PAID / SENIOR_INCOME_*
// rows on the transactions ledger — this table is auxiliary.

export const pendingObligations = pgTable(
  'pending_obligations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Senior who is owed money.
    creditorUserId: uuid('creditor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    debtorType: pendingObligationDebtorTypeEnum('debtor_type').notNull(),
    // FK populated when debtorType is DROP or ADMIN (a user). NULL when
    // debtorType is TOV (corporate account, no user row).
    debtorUserId: uuid('debtor_user_id').references(() => users.id, { onDelete: 'set null' }),
    // Transaction that created this obligation (TOV_INCOME, SENIOR_PENDING_PAYOUT, …).
    sourceTransactionId: uuid('source_transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'restrict' }),
    // SENIOR_PAID row that closed it; nullable until the close.
    closingTransactionId: uuid('closing_transaction_id').references(() => transactions.id, {
      onDelete: 'set null',
    }),
    amount: numeric('amount', { precision: 20, scale: 6 }).notNull(),
    currency: currencyEnum().notNull().default('USDT'),
    status: pendingObligationStatusEnum('status').notNull().default('PENDING'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_pending_obligations_creditor').on(t.creditorUserId),
    index('idx_pending_obligations_status').on(t.status),
    index('idx_pending_obligations_source').on(t.sourceTransactionId),
    // BIZ-11 (2026-07-03): one PENDING obligation per source transaction.
    // Prevents a double-pending-obligation race when two concurrent income flows
    // both try to create an obligation for the same source transaction.
    // Partial (WHERE status='PENDING') so PAID/CANCELLED rows are unaffected —
    // a source tx can have one PAID + one new PENDING at different lifecycle stages.
    // Enforced at service layer too (PendingSettlementService), but the DB constraint
    // is the authoritative race-safe guard.
    uniqueIndex('uq_pending_obligations_source_pending')
      .on(t.sourceTransactionId)
      .where(sql`${t.status} = 'PENDING'`),
  ],
)

// ---------------------------------------------------------------------------
// Documents (PHASE 6)
// ---------------------------------------------------------------------------
//
// Storage layer for all uploaded files (resumes, scans, contracts, receipts,
// avatars, logos). The file bytes live in S3/MinIO; this table only tracks
// metadata + the immutable `s3_key`. Soft delete is two-stage: owner/ADMIN
// soft-delete sets `deletedAt` + `deletedBy`; ADMIN-only hard delete then
// removes the S3 object and the DB row.
//
// FK references from `users.avatar_document_id`, `projects.logo_document_id`,
// `transactions.receipt_document_id` are added in subsequent migrations
// (0011–0013) — this table does not depend on them.

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // NULL for resume/scan/receipt/avatar; NOT NULL for contract/logo (enforced
    // in Zod / service layer rather than CHECK constraint to keep migrations
    // simple and the validation message human-readable).
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    category: documentCategoryEnum('category').notNull(),
    // Sanitized (ASCII-only) filename — used inside the S3 key and as the
    // download-as filename. Variant 3 "hybrid": s3_key strict, original_name
    // preserved, UI shows original, download = normalized.
    name: varchar('name', { length: 255 }).notNull(),
    // Original filename as uploaded by the user (cyrillic / unicode preserved).
    // Backfilled from `name` for legacy rows; new uploads always populate this.
    originalName: varchar('original_name', { length: 255 }),
    // Immutable S3 object key — `documents/<category>/<ownerId>/<docId>-<file>`.
    // Unique so new versions always allocate a new UUID (browser can cache
    // immutably for a year, see PHASE 6 caching strategy).
    s3Key: varchar('s3_key', { length: 512 }).notNull().unique(),
    // S3 key of the synchronously-generated 256x256 JPEG thumbnail.
    // NULL for non-image MIME types (PDFs fall back to a category icon).
    thumbnailS3Key: varchar('thumbnail_s3_key', { length: 512 }),
    // Size after server-side compression.
    sizeBytes: integer('size_bytes').notNull(),
    // Final MIME type after re-encode (HEIC → image/jpeg, etc.).
    mimeType: varchar('mime_type', { length: 64 }).notNull(),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    // Soft delete (Stage 1: owner or ADMIN).
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Partial indexes — hot path is "list active documents for owner/project".
    index('idx_documents_owner')
      .on(t.ownerId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('idx_documents_project')
      .on(t.projectId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('idx_documents_category').on(t.category),
  ],
)

// ---------------------------------------------------------------------------
// Invoice Signatures (Invoice Signing Epic)
// ---------------------------------------------------------------------------
//
// Each `transactions` row of type SENIOR_INCOME or SALARY can have up to two
// signatures — one per role. COMPANY is signed automatically by the system
// (method = AUTO_COMPANY) the moment the PDF is generated; COUNTERPARTY is
// signed manually by the recipient via /api/invoices/:id/sign (method =
// MANUAL_CLICK). The `pdf_hash` field captures SHA-256 of the signed bytes
// and is used by the public /verify endpoint to detect tampering. `ip` and
// `user_agent` are stored for accountability but NEVER returned by the
// public verify endpoint (privacy).

export const invoiceSignatures = pgTable(
  'invoice_signatures',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    signerRole: invoiceSignerRoleEnum('signer_role').notNull(),
    signerId: uuid('signer_id')
      .notNull()
      .references(() => users.id),
    signedAt: timestamp('signed_at', { withTimezone: true }).defaultNow().notNull(),
    // SHA-256 of the signed PDF bytes, hex-encoded (64 chars).
    pdfHash: char('pdf_hash', { length: 64 }).notNull(),
    // PostgreSQL INET; never surfaced by the public verify endpoint.
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    method: invoiceSignatureMethodEnum('method').notNull(),
  },
  (t) => [
    // One signature per (transaction, role) — guards against double-sign races.
    unique('uniq_sig').on(t.transactionId, t.signerRole),
    index('idx_invoice_signatures_transaction').on(t.transactionId),
    index('idx_invoice_signatures_signer').on(t.signerId),
  ],
)

// ---------------------------------------------------------------------------
// Onboarding (Phase 6A) — MSA contracts + Terms of Service
// ---------------------------------------------------------------------------
//
// Workflow: every non-ADMIN user must sign one MSA (per their role) and
// accept the current ToS version before the OnboardingGuard lets them past
// `/api/onboarding/*` / `/api/auth/*` / `/api/tos/current` / `/api/contracts/
// templates/current/*` / `/api/contracts/sign` / `/api/tos/accept`. ADMINs
// bypass the guard entirely and never sign contracts (DB-level CHECK on
// `contract_templates.target_role` enforces the latter).
//
// Templates carry `is_active` semantics: at most one row per (target_role)
// can have `is_active=true`. Partial unique index `uq_contract_templates_active_role`
// (declared in the builder below) + atomic deactivation in ContractTemplatesService.publish
// enforce this invariant. Signed contracts freeze the template body via
// `body_markdown_snapshot` + `variables_filled` JSONB at the moment of signing — immutable.
//
// `contract_number` (CHK-<6 hex>) is generated server-side with retry-on-collision.
// Monotonic uniqueness enforced by `signed_contracts.contract_number` UNIQUE constraint.

export const contractTemplates = pgTable(
  'contract_templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // target_role must not be 'ADMIN' — enforced at service layer
    // (ContractTemplatesService.publish throws CANNOT_PUBLISH_ADMIN_CONTRACT_TEMPLATE
    // before reaching the DB). Code-only invariant; no DB CHECK here (would require
    // a raw sql() expression and makes drizzle-kit push harder to reason about).
    targetRole: roleEnum('target_role').notNull(),
    version: integer('version').notNull(),
    bodyMarkdown: text('body_markdown').notNull(),
    isActive: boolean('is_active').notNull().default(false),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    // Array of admin-authored custom variable definitions for this template version.
    // Each entry: { key: string, label: string, defaultValue?: string }.
    // Stored as JSONB; defaults to [] for backward compat.
    // Migration adds `custom_variables jsonb NOT NULL DEFAULT '[]'`.
    customVariables: jsonb('custom_variables')
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('contract_templates_target_role_version_unique').on(t.targetRole, t.version),
    // BIZ-11 (2026-07-03): one active template per target_role.
    // ContractTemplatesService.publish atomically deactivates the previous active
    // row before inserting a new one (service-layer enforcement). This partial unique
    // index is the DB-level safety net for concurrent publish calls.
    uniqueIndex('uq_contract_templates_active_role')
      .on(t.targetRole, t.isActive)
      .where(sql`${t.isActive} = true`),
  ],
)

export const signedContracts = pgTable(
  'signed_contracts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    templateId: uuid('template_id')
      .notNull()
      .references(() => contractTemplates.id),
    bodyMarkdownSnapshot: text('body_markdown_snapshot').notNull(),
    // JSONB blob of `{ employeeName, employeeEmail, role, onboardingDate,
    // companyName, walletUsdt, bankUahFop, preferredMethod }` resolved at
    // signing time. Stored verbatim so we can re-render the snapshot exactly
    // without a re-resolve later.
    variablesFilled: jsonb('variables_filled').notNull().default({}),
    signedTypedName: text('signed_typed_name').notNull(),
    signedIp: text('signed_ip'),
    signedUserAgent: text('signed_user_agent'),
    signedAt: timestamp('signed_at', { withTimezone: true }).defaultNow().notNull(),
    contractNumber: text('contract_number').notNull().unique(),
    // task-junior-ut-round2 §7: real PDF size in bytes. Filled at signing time
    // (deterministic render), lazily backfilled on first download for legacy
    // rows. NULL = not yet computed (documents list falls back to 0 until then).
    pdfSizeBytes: integer('pdf_size_bytes'),
  },
  (t) => [index('signed_contracts_user_id_idx').on(t.userId)],
)

export const tosVersions = pgTable(
  'tos_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    version: integer('version').notNull().unique(),
    bodyMarkdown: text('body_markdown').notNull(),
    // BIZ-11 (2026-07-03): at most one globally active ToS version at a time.
    // Partial unique index declared in the builder below (was previously noted as
    // "lives in migration 0027" — phantom comment, no such migration file exists;
    // project uses drizzle-kit push). TosService.publish atomically deactivates
    // the previous active row; this index is the DB-level safety net for races.
    isActive: boolean('is_active').notNull().default(false),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Enforce at most one active ToS globally.
    uniqueIndex('uq_tos_versions_active')
      .on(t.isActive)
      .where(sql`${t.isActive} = true`),
  ],
)

export const tosAcceptances = pgTable(
  'tos_acceptances',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tosVersionId: uuid('tos_version_id')
      .notNull()
      .references(() => tosVersions.id),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).defaultNow().notNull(),
    acceptedIp: text('accepted_ip'),
    acceptedUserAgent: text('accepted_user_agent'),
  },
  (t) => [
    unique('tos_acceptances_user_id_tos_version_id_unique').on(t.userId, t.tosVersionId),
    index('tos_acceptances_user_id_idx').on(t.userId),
  ],
)

// ---------------------------------------------------------------------------
// Employee Contracts (A3-1 — per-employee editable contracts)
// ---------------------------------------------------------------------------
//
// Per-employee contract layer on top of `contract_templates` (role-level defaults)
// and `signed_contracts` (immutable audit snapshots).
//
// One cyclic row per non-ADMIN user:
//   DRAFT → READY_TO_SIGN → SIGNED  (admin can revert SIGNED → DRAFT)
//   CANCELLED — terminal (archived / fired employee).
//
// Invariants:
//   - Partial unique index `employee_contracts_one_per_user` WHERE status != 'CANCELLED'
//     declared in the Drizzle builder below (BIZ-11, 2026-07-03).
//   - No ADMIN in user_id — enforced at service layer (EmployeeContractsService checks
//     userRole !== 'ADMIN' before creating a contract; no DB trigger, code-only invariant).

export const employeeContractStatusEnum = pgEnum('employee_contract_status', [
  'DRAFT',
  'READY_TO_SIGN',
  'SIGNED',
  'CANCELLED',
])

export const employeeContracts = pgTable(
  'employee_contracts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceTemplateId: uuid('source_template_id')
      .notNull()
      .references(() => contractTemplates.id, { onDelete: 'restrict' }),
    bodyMarkdown: text('body_markdown').notNull(),
    status: employeeContractStatusEnum('status').notNull().default('DRAFT'),
    // Set to null when admin reverts SIGNED → DRAFT (old snapshot preserved in signed_contracts)
    signedContractId: uuid('signed_contract_id').references(() => signedContracts.id, {
      onDelete: 'set null',
    }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // Admin-supplied custom variable values for this contract (Screen 2).
    // Keys match custom_variables[].key from the source template.
    // Stored as JSONB; defaults to {} for backward compat.
    customValues: jsonb('custom_values').$type<Record<string, string>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('employee_contracts_user_status_idx').on(t.userId, t.status),
    // BIZ-11 (2026-07-03): one non-CANCELLED contract per user.
    // Prevents duplicate active contracts for the same employee (race in admin UI).
    // CANCELLED rows are excluded so that a re-issued contract after termination
    // is valid (the old CANCELLED row doesn't block a new DRAFT).
    // Partial (WHERE status != 'CANCELLED') mirrors the lifecycle rule documented above.
    uniqueIndex('employee_contracts_one_per_user')
      .on(t.userId)
      .where(sql`${t.status} != 'CANCELLED'`),
  ],
)

// ---------------------------------------------------------------------------
// Notifications (Invoice Signing Epic — also reusable for future events)
// ---------------------------------------------------------------------------
//
// Server-side persistence of in-app notifications. Drives the header
// колокольчик badge + dropdown. `type` is left as VARCHAR (not enum) so new
// event types can be added without a DB migration — validation lives in the
// shared Zod enum instead. INVOICE_SIGN_REQUIRED + INVOICE_SIGNED are the
// two types emitted by InvoicesService today; future epics can append more.

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 50 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    body: text('body'),
    link: varchar('link', { length: 500 }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Drives unread-count query + "unread only" filter in /api/notifications.
    index('idx_notifications_user_unread')
      .on(t.userId)
      .where(sql`${t.readAt} IS NULL`),
    // Drives the chronological dropdown listing (10 most recent for the user).
    index('idx_notifications_user_created').on(t.userId, t.createdAt.desc()),
  ],
)

// ---------------------------------------------------------------------------
// Legends — client-facing persona profiles, one per project
//
// 1:1 with a PROJECT (not a user). The legend is the persona the senior
// presents to the client company on that specific project.
// Intentionally separate from users.legalFullName (passport name for contracts).
// ---------------------------------------------------------------------------

export const legends = pgTable('legends', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id')
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: 'cascade' }),
  /** Client-facing persona full name (Cyrillic). NOT the same as legalFullName. */
  fullName: text('full_name').notNull(),
  dateOfBirth: text('date_of_birth'),
  address: text('address'),
  presentedRole: text('presented_role'),
  presentedStack: text('presented_stack'),
  backstory: text('backstory'),
  hobbies: text('hobbies'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Legend Entries — journal entries that complement the legend persona
// ---------------------------------------------------------------------------

export const legendEntries = pgTable('legend_entries', {
  id: uuid('id').defaultRandom().primaryKey(),
  legendId: uuid('legend_id')
    .notNull()
    .references(() => legends.id, { onDelete: 'cascade' }),
  // ON DELETE NO ACTION (Drizzle default) is intentional: we preserve
  // journal history even when a user is later deleted. If hard-delete of
  // users is ever introduced, a manual cleanup of orphaned authorId rows
  // will be required before the FK constraint allows the delete.
  authorId: uuid('author_id')
    .notNull()
    .references(() => users.id),
  text: text('text').notNull(),
  /**
   * Optional event date (YYYY-MM-DD text). When set, represents the real-world
   * date of the event described in the entry, allowing backdating. Entries are
   * sorted by COALESCE(event_date, created_at::date) so the journal timeline
   * reflects event order, not insertion order. NULL = use createdAt for display.
   */
  eventDate: text('event_date'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
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

// ---------------------------------------------------------------------------
// User Audit Log
// ---------------------------------------------------------------------------

export const userAuditLog = pgTable(
  'user_audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    changes: jsonb('changes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('user_audit_log_target_id_idx').on(t.targetId)],
)

// ---------------------------------------------------------------------------
// Team Audit Log — mirrors user_audit_log shape but targets teams.
// ---------------------------------------------------------------------------

export const teamAuditLog = pgTable(
  'team_audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    changes: jsonb('changes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('team_audit_log_target_id_idx').on(t.targetId),
    index('team_audit_log_created_at_idx').on(t.createdAt),
  ],
)

// ---------------------------------------------------------------------------
// Project Audit Log — mirrors user_audit_log shape but targets projects.
// ---------------------------------------------------------------------------

export const projectAuditLog = pgTable(
  'project_audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    changes: jsonb('changes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('project_audit_log_target_id_idx').on(t.targetId),
    index('project_audit_log_created_at_idx').on(t.createdAt),
  ],
)

// ---------------------------------------------------------------------------
// Transaction Audit Log — task-receipts-backend. Records receipt attach/replace
// mutations made through the generic PATCH /transactions/:id/receipt endpoint.
//
// Unlike the other *_audit_log tables, targetId is NOT an FK-cascade to
// transactions: an audit trail must OUTLIVE the row it describes (deleting a
// transaction must not erase the record that a receipt was attached/replaced on
// it). actorId → users with ON DELETE SET NULL (keep the audit if the actor is
// removed). action is a plain text discriminator ('ATTACH' | 'REPLACE').
// ---------------------------------------------------------------------------

export const transactionAuditLog = pgTable(
  'transaction_audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    // transactions.id — intentionally NO FK reference (audit survives tx delete).
    targetId: uuid('target_id').notNull(),
    action: text('action').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('transaction_audit_log_target_id_idx').on(t.targetId),
    index('transaction_audit_log_created_at_idx').on(t.createdAt),
  ],
)

// ---------------------------------------------------------------------------
// Document Access Log — task-file-storage-hardening §7. Mirrors
// transaction_audit_log's shape (no FK-cascade to the referenced row — a
// scan/resume can be hard-deleted or retention-purged and the access trail
// must outlive it). Records WHO fetched a presigned download/preview link
// for a sensitive document (RESUME/SCAN from `documents`, or a vacancy
// application resume) and WHEN — never the URL itself (`metadata` only
// carries the category + a source discriminator). Answers "who downloaded
// this scan" after the fact; write-only from the app's perspective in this
// PR (no read endpoint — an ADMIN can query the table directly for now).
//
// MED-5 (security-review round 1): `actor_id` index added — "who accessed
// what" queries filter by actor at least as often as by target ("what did
// this person download") — and a 365-day retention purge is wired via
// `DocumentAccessLogRetentionCronService` (apps/api/src/documents/
// document-access-log-retention.cron.ts). No OTHER *_audit_log table in this
// schema (user/team/project/transaction) has a retention cron either — this
// is a new, project-local precedent, not a gap relative to an existing
// pattern; 365 days is a reasoned default (audit trails conventionally
// outlive the PII they describe) documented in that cron's own file header,
// not an owner-mandated figure — revisit if the owner wants a different window.
// ---------------------------------------------------------------------------

export const documentAccessLog = pgTable(
  'document_access_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    // documents.id OR vacancy_applications.id — intentionally NO FK
    // reference, same rationale as transaction_audit_log.targetId.
    targetId: uuid('target_id').notNull(),
    action: text('action').notNull(), // 'DOWNLOAD' | 'PREVIEW' | 'THUMBNAIL'
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('document_access_log_target_id_idx').on(t.targetId),
    index('document_access_log_actor_id_idx').on(t.actorId),
    index('document_access_log_created_at_idx').on(t.createdAt),
  ],
)

// ---------------------------------------------------------------------------
// Vacancies (task-vacancies-api)
// ---------------------------------------------------------------------------
//
// Public hiring channel for new SENIORs — completely separate from the
// interviews Kanban (that board tracks a candidate a SENIOR is already
// placing on a project; vacancies are visible on the landing before the
// applicant is a user at all). No salary fields — never add them here.

export const vacancies = pgTable(
  'vacancies',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    descriptionMd: text('description_md').notNull(),
    domain: vacancyDomainEnum('domain').notNull(),
    seniority: vacancySeniorityEnum('seniority').notNull(),
    employmentType: vacancyEmploymentTypeEnum('employment_type').notNull(),
    location: text('location').notNull(),
    status: vacancyStatusEnum('status').notNull().default('DRAFT'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    // task-vacancy-i18n-jobposting — nullable; shape imported from
    // packages/shared (VacancyTranslations, the SSOT) instead of duplicated
    // here — owner scope-change 2026-07-25 made the locale set data-driven
    // (VACANCY_TRANSLATION_LOCALES), so this column's type follows it
    // automatically instead of needing a matching edit on every language add.
    // `en` is the row's own title/descriptionMd above; every other locale is
    // an optional, independently-present override.
    translations: jsonb('translations').$type<VacancyTranslations>(),
    // JobPosting (Google for Jobs) enrichment — all optional/admin-entered,
    // never invented (see packages/shared vacancySeoFieldsSchema doc).
    skills: text('skills').array(),
    experienceMonths: integer('experience_months'),
    qualifications: text('qualifications'),
    responsibilities: text('responsibilities'),
    jobBenefits: text('job_benefits'),
    workHours: text('work_hours'),
    // task-vacancy-salary-range (owner decision 2026-07-31) — public salary
    // range, MANDATORY going forward (enforced in packages/shared
    // createVacancySchema + VacanciesService.assertSalaryFilled), but
    // nullable HERE: 3 vacancies were already PUBLISHED on prod before this
    // change and a NOT NULL constraint can't be retrofitted onto existing
    // rows without inventing values — see the manual DDL's header comment.
    // `salaryCurrency` reuses the EXISTING `currency` pg enum (already shared
    // by users.salaryCurrency/transactions.currency) — a real DB-level type,
    // unlike packages/shared's OWN independently-declared
    // `vacancySalaryCurrencySchema` (deliberately not imported from
    // payment-requisites.ts — see that file's doc comment for why).
    salaryMin: numeric('salary_min', { precision: 12, scale: 2 }),
    salaryMax: numeric('salary_max', { precision: 12, scale: 2 }),
    salaryCurrency: currencyEnum('salary_currency'),
    salaryPeriod: vacancySalaryPeriodEnum('salary_period'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('idx_vacancies_status').on(t.status)],
)

export const vacancyApplications = pgTable(
  'vacancy_applications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    vacancyId: uuid('vacancy_id')
      .notNull()
      .references(() => vacancies.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    email: text('email').notNull(),
    telegram: text('telegram'),
    linkedinUrl: text('linkedin_url'),
    githubUrl: text('github_url'),
    coverLetter: text('cover_letter'),
    // Immutable R2/S3 object key —
    // `vacancy-applications/<vacancyId>/<applicationId>.pdf`.
    // task-file-storage-hardening §2 (owner decision 2026-08-01, 6-month
    // resume retention): NULLABLE — `VacanciesRetentionCronService` clears
    // both this and `resumeSizeBytes` once an application turns 180 days old
    // (any status, including the evergreen NEW/VIEWED ones that used to keep
    // their file forever alongside the vacancy). The application ROW stays
    // (hiring-history value), only the file+size are scrubbed.
    resumeS3Key: text('resume_s3_key'),
    resumeSizeBytes: integer('resume_size_bytes'),
    status: vacancyApplicationStatusEnum('status').notNull().default('NEW'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Admin application list per vacancy, most recent first.
    index('idx_vacancy_applications_vacancy_created').on(t.vacancyId, t.createdAt.desc()),
    // Duplicate-submission check: same email + vacancy within 24h.
    index('idx_vacancy_applications_email_vacancy').on(t.email, t.vacancyId),
  ],
)

// ---------------------------------------------------------------------------
// Job sourcing (task-job-sourcing-slice1) — EXTERNAL vacancies a senior can
// apply to. The mirror image of the `vacancies` block above: those are OUR
// openings shown on the landing; these are OTHER companies' openings pulled in
// from a third-party feed and offered to our seniors.
// ---------------------------------------------------------------------------
//
// Everything in `job_postings` is UNTRUSTED third-party content — see the
// header of packages/shared/src/schemas/job-sourcing.ts for the full contract
// (https-only URLs, markdown-without-raw-HTML descriptions).

/**
 * A configured feed. `config` holds ONLY source-specific knobs (for DOU: the
 * category, validated against an allow-list) — deliberately NOT a URL: letting
 * an admin store an arbitrary URL here would turn the collector into an SSRF
 * primitive. The endpoint is a constant in the provider implementation.
 */
export const jobSources = pgTable(
  'job_sources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    type: jobSourceTypeEnum('type').notNull(),
    config: jsonb('config').notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    lastCollectedAt: timestamp('last_collected_at', { withTimezone: true }),

    // --- request budget (task-vacancy-matching §4) ---------------------------
    //
    // A PROPERTY OF THE SOURCE, not of the caller: whoever asks for a
    // collection — the cron or an admin pressing the button — spends from the
    // same counter, so twenty clicks in a row cannot burn a month of JSearch's
    // 200 requests. Arithmetic (rollover, remaining, reset instant) lives in
    // `@crm/shared`'s source-budget.ts so the API and the UI cannot disagree.
    //
    // NULL `budget_limit` means "no published limit" (DOU's feed) — and it is
    // the ONLY value that means that. A nonsense number does NOT: see the
    // hostile-input rule in source-budget.ts.
    // Stryker disable next-line StringLiteral: a COLUMN NAME — it exists in the database, so no unit test can observe it; the prod DDL declares the same identifier in 2026-08-12_job_source_budgets.sql and the integration suite reads through it
    budgetLimit: integer('budget_limit'),
    // Stryker disable next-line StringLiteral: same — a column name, verified against a real database by the integration suite and by the DDL script, never by a unit test
    budgetWindow: jobSourceBudgetWindowEnum('budget_window'),
    // Stryker disable next-line StringLiteral: a COLUMN NAME — it exists in the database, so no unit test can observe it; the prod DDL declares the same identifier in 2026-08-12_job_source_budgets.sql and the integration suite reads through it
    budgetUsed: integer('budget_used').notNull().default(0),
    /** Start of the window `budget_used` is counted in (UTC, calendar-anchored). */
    // Stryker disable next-line BooleanLiteral,StringLiteral,ObjectLiteral: the column name and its options — withTimezone decides timestamptz vs timestamp — a COLUMN TYPE in Postgres, declared by 2026-08-12_job_source_budgets.sql and exercised by the integration suite. It appeared killed locally only because this machine runs at UTC+03 while CI runs at UTC, so a unit test comparing an ISO string happened to notice; that is a property of the runner's timezone, not an assertion about the schema
    budgetWindowStartedAt: timestamp('budget_window_started_at', { withTimezone: true }),

    // --- how this source may be collected (task-vacancy-matching §5) ---------
    //
    // Cheap sources run on the schedule; expensive ones wait for a human. The
    // driver is arithmetic: JSearch's 200/month is ~6/day, useless on a cron but
    // ample when aimed at one senior by hand.
    // Stryker disable next-line StringLiteral: the column DEFAULT is applied by Postgres on INSERT, so no unit test can see it; the default is pinned in the DDL script and exercised by job-matching.integration.spec.ts, which inserts a source without a trigger mode and expects the scheduled cron to pick it up
    triggerMode: jobSourceTriggerModeEnum('trigger_mode').notNull().default('SCHEDULED'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // One row per (type, settings) pair — re-seeding the same source is a
    // no-op instead of silently doubling every collection run.
    unique('uq_job_sources_type_config').on(t.type, t.config),
  ],
)

export const jobPostings = pgTable(
  'job_postings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceType: jobSourceTypeEnum('source_type').notNull(),
    sourceId: uuid('source_id').references(() => jobSources.id, { onDelete: 'set null' }),
    /** Stable identity WITHIN a source — the canonical, query-stripped URL. */
    externalId: text('external_id').notNull(),
    /** Original posting URL. https-only, enforced at ingest and on the wire. */
    url: text('url').notNull(),
    title: text('title').notNull(),
    companyName: text('company_name').notNull(),
    /**
     * `normalizeCompanyName(companyName)` — persisted so company filtering is a
     * plain string comparison instead of re-folding every row on every read.
     * Recomputed on every ingest, never edited by hand.
     */
    companyNameNormalized: text('company_name_normalized').notNull(),
    location: text('location'),
    /** Markdown, never raw HTML — converted + stripped at ingest. */
    descriptionMd: text('description_md').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /**
     * sha256(sourceType + '|' + canonical URL) — the dedupe key (AC1). It is
     * computed from the CANONICALIZED url (query string stripped) because DOU's
     * `<guid>` carries a fresh timestamp query on every fetch, so a raw-URL
     * fingerprint would treat the same vacancy as new on every single run.
     */
    fingerprint: text('fingerprint').notNull(),
    collectedAt: timestamp('collected_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('uq_job_postings_fingerprint').on(t.fingerprint),
    index('idx_job_postings_published_at').on(t.publishedAt.desc()),
    index('idx_job_postings_company_normalized').on(t.companyNameNormalized),
  ],
)

export const jobSuggestions = pgTable(
  'job_suggestions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    postingId: uuid('posting_id')
      .notNull()
      .references(() => jobPostings.id, { onDelete: 'cascade' }),
    seniorId: uuid('senior_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: jobSuggestionStatusEnum('status').notNull().default('NEW'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
    statusChangedBy: uuid('status_changed_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // One suggestion per (posting, senior). This is what makes a REJECTED
    // posting stay rejected (AC4): a later collection run cannot insert a
    // second NEW row for the same pair.
    uniqueIndex('uq_job_suggestions_posting_senior').on(t.postingId, t.seniorId),
    index('idx_job_suggestions_senior_status').on(t.seniorId, t.status),
  ],
)

/**
 * Manual exclusions. `senior_id IS NULL` means the studio-wide (GLOBAL) list.
 *
 * NOT stored here: exclusions derived from the senior's own projects — those
 * are recomputed on every read (see JobSourcingService.buildExclusionSet) so
 * they can never go stale after a project is added, renamed or archived.
 */
export const jobExclusionFilters = pgTable(
  'job_exclusion_filters',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    seniorId: uuid('senior_id').references(() => users.id, { onDelete: 'cascade' }),
    kind: jobExclusionKindEnum('kind').notNull(),
    /** As typed by the human — shown in the UI. */
    value: text('value').notNull(),
    /** Canonical form used for matching (`normalizeCompanyName`). */
    normalizedValue: text('normalized_value').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Two PARTIAL unique indexes rather than one `NULLS NOT DISTINCT` index:
    // in Postgres NULLs are distinct by default, so a plain unique index on a
    // nullable senior_id would happily accept the same GLOBAL entry twice.
    uniqueIndex('uq_job_exclusions_global').on(t.kind, t.normalizedValue).where(isNull(t.seniorId)),
    uniqueIndex('uq_job_exclusions_senior')
      .on(t.seniorId, t.kind, t.normalizedValue)
      .where(sql`${t.seniorId} IS NOT NULL`),
    index('idx_job_exclusions_senior').on(t.seniorId),
  ],
)

// ---------------------------------------------------------------------------
// Telemetry (task-telemetry-api) — prod-error tracking + UX-analytics.
// ---------------------------------------------------------------------------
//
// Two tables, deliberately separate lifecycles:
//   - `telemetry_errors` — one row PER DISTINCT ERROR (grouped by
//     `fingerprint`), upserted (count++/last_seen bump on repeat; RESOLVED +
//     repeat = regression → back to NEW). Retention: 180 days since last_seen.
//   - `telemetry_events` — one row PER RAW UX EVENT (route_enter/leave,
//     feature_click, form_abandon/submit). High volume, short retention
//     (90 days) + a 1M-row safety cap — see TelemetryRetentionCronService.
//
// Privacy: telemetry_events NEVER stores a raw userId — only a daily-salted
// `session_hash` (see apps/api/src/telemetry/session-hash.ts) + role.

export const telemetryErrors = pgTable(
  'telemetry_errors',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // sha256(source + normalized message + top-3 stack frames) — see
    // apps/api/src/telemetry/fingerprint.ts. Groups repeats of the same error.
    fingerprint: text('fingerprint').notNull().unique(),
    source: telemetrySourceEnum('source').notNull(),
    // Sanitized (secrets redacted) + truncated to 500/4000 chars BEFORE
    // insert — see apps/api/src/telemetry/sanitize.ts.
    message: text('message').notNull(),
    stack: text('stack'),
    route: text('route'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    userRole: text('user_role'),
    // ua / viewport / appVersion ONLY — never request bodies.
    meta: jsonb('meta').notNull().default({}),
    count: integer('count').notNull().default(1),
    firstSeen: timestamp('first_seen', { withTimezone: true }).defaultNow().notNull(),
    lastSeen: timestamp('last_seen', { withTimezone: true }).defaultNow().notNull(),
    status: telemetryErrorStatusEnum('status').notNull().default('NEW'),
    githubIssueNumber: integer('github_issue_number'),
  },
  (t) => [index('idx_telemetry_errors_status_last_seen').on(t.status, t.lastSeen)],
)

export const telemetryEvents = pgTable(
  'telemetry_events',
  {
    // bigserial (not uuid) — this table is high-volume and short-lived
    // (90-day retention), same rationale as an activity/analytics log.
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sessionHash: text('session_hash').notNull(),
    userRole: text('user_role').notNull(),
    event: telemetryEventTypeEnum('event').notNull(),
    route: text('route').notNull(),
    // [data-track] feature identifier for feature_click — never free text.
    target: text('target'),
    // Time-on-screen for route_leave, in milliseconds.
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_telemetry_events_event_created').on(t.event, t.createdAt),
    index('idx_telemetry_events_route_created').on(t.route, t.createdAt),
  ],
)

// ---------------------------------------------------------------------------
// CSP violation reports (task-csp-reports-and-flip, Часть A) — aggregated
// PUBLIC browser CSP violation reports (POST /api/public/csp-report).
// ---------------------------------------------------------------------------
//
// ONE row per DISTINCT (effectiveDirective, blockedUri, documentPath) tuple —
// same upsert shape as telemetry_errors (count++/last_seen bump on repeat).
// Deliberately NOT a raw event stream: this is UNTRUSTED PUBLIC input (any
// browser on the internet can POST here) — see CspReportsService.recordViolation
// (apps/api/src/csp-reports/csp-reports.service.ts) for the normalize +
// sanitize + upsert pipeline. Retention: 90 days since last_seen, via
// TelemetryRetentionCronService (reuses the existing retention cron, per task
// §Часть A item 5).

export const cspReports = pgTable(
  'csp_reports',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // CSP directive that was violated (e.g. 'script-src') — resolved from
    // effective-directive, falling back to the first token of
    // violated-directive. See apps/api/src/csp-reports/normalize.ts.
    effectiveDirective: text('effective_directive').notNull(),
    // Normalized to origin+pathname (query/fragment stripped) — or a CSP
    // special keyword ('inline', 'eval', ...) passed through as-is.
    blockedUri: text('blocked_uri').notNull(),
    // document-uri/documentURL, pathname ONLY (origin + query/fragment stripped).
    documentPath: text('document_path').notNull(),
    // Latest occurrence's disposition — 'report' (Report-Only) or 'enforce'.
    disposition: cspDispositionEnum('disposition').notNull().default('report'),
    // Latest occurrence's User-Agent header, sanitized + truncated.
    userAgent: text('user_agent'),
    count: integer('count').notNull().default(1),
    firstSeen: timestamp('first_seen', { withTimezone: true }).defaultNow().notNull(),
    lastSeen: timestamp('last_seen', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Aggregation key (task §3) — CspReportsService.recordViolation upserts
    // against this exact composite index.
    uniqueIndex('uq_csp_reports_aggregate_key').on(
      t.effectiveDirective,
      t.blockedUri,
      t.documentPath,
    ),
    // Digest (`last_seen >= since`) + retention cron (`last_seen < cutoff`)
    // both filter on this column.
    index('idx_csp_reports_last_seen').on(t.lastSeen),
  ],
)

// ---------------------------------------------------------------------------
// Senior resume (task-resume-base)
// ---------------------------------------------------------------------------

/**
 * One canonical resume per senior. The uploaded file is an INPUT only: after
 * a single AI extraction the system works with `content` (JSONB), never with
 * the file. `version` grows on every content save so task-resume-tailoring can
 * detect vacancy-tailored variants built from a now-stale base.
 *
 * `user_id` is UNIQUE — enforced at the DB level, so two concurrent
 * "create my resume" requests can never produce two rows (the loser gets a
 * unique-violation, which the service turns into a re-read).
 */
export const seniorResumes = pgTable(
  'senior_resumes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** ResumeContent (packages/shared). UNTRUSTED — validated on read + write. */
    content: jsonb('content').$type<ResumeContent>().notNull().default(EMPTY_RESUME_CONTENT),
    status: resumeExtractionStatusEnum('status').notNull().default('READY'),
    /** ResumeFailureCode (packages/shared) — set together with `error_message`. */
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    /** When the Cloudflare daily allowance resets (QUOTA_EXCEEDED only). */
    quotaResetsAt: timestamp('quota_resets_at', { withTimezone: true }),
    /** Set when a RUNNING extraction started — drives the stuck-sweep cron. */
    extractionStartedAt: timestamp('extraction_started_at', { withTimezone: true }),
    /**
     * Identifies WHICH extraction attempt currently owns this row.
     *
     * Generated when a run claims the row and required (unchanged) by that
     * run's terminal write. Anything that supersedes the run — a second upload,
     * a pasted text, a manual save — clears it, so the superseded run finds no
     * matching row and discards its result instead of overwriting newer data
     * with the contents of a file that has already been deleted.
     */
    extractionRunId: uuid('extraction_run_id'),
    /** Neurons/tokens spent on the last extraction — makes the spend visible. */
    lastExtractionTokens: integer('last_extraction_tokens'),
    /** Private R2/S3 key of the original file — served only via our endpoint. */
    sourceS3Key: text('source_s3_key'),
    sourceFileName: text('source_file_name'),
    sourceFileSizeBytes: integer('source_file_size_bytes'),
    sourceMimeType: text('source_mime_type'),
    version: integer('version').notNull().default(0),

    // --- layout half of the "template + data" split (task-resume-template) ---
    /**
     * The senior's own Typst template. NULL = the one shipped in the repo.
     *
     * A template is executable typesetting code, and NO ENDPOINT WRITES THIS
     * COLUMN — personal templates are authored by the designer as a separate
     * task, through a path that does not exist yet. That is deliberate: the
     * editable surface for a human is `layout` below, an enumerated set of
     * switches, so the render can never be steered by text a user (or a model)
     * supplies. The renderer sandboxes the template anyway (`--root` on a
     * scratch directory), but the first line of defence is that nothing can
     * put anything here.
     */
    templateSource: text('template_source'),
    /** Display label for the template. Never its source. */
    templateName: text('template_name'),
    /** ResumeLayoutOptions — section order, hidden sections, density, font scale. */
    layout: jsonb('layout').$type<ResumeLayoutOptions>().notNull().default(DEFAULT_RESUME_LAYOUT),

    // --- rendered PDF (built by a job, never inside a request) ---------------
    /** Private S3 key of the rendered PDF, or NULL when none exists yet. */
    pdfS3Key: text('pdf_s3_key'),
    /**
     * SHA-256 of the exact render input the stored PDF was built from.
     *
     * Freshness is decided by COMPARING this with the fingerprint of the
     * current content+layout+template rather than by trusting a version
     * counter: the render is deterministic, so equal fingerprints really do
     * mean equal bytes, and a stale PDF can never be served as the current one.
     */
    pdfFingerprint: text('pdf_fingerprint'),
    pdfRenderStatus: resumeRenderStatusEnum('pdf_render_status').notNull().default('IDLE'),
    /** Russian, user-safe — set together with `pdf_render_status = 'FAILED'`. */
    pdfRenderError: text('pdf_render_error'),
    /** Set while a render is RUNNING; drives the stuck-render sweep. */
    pdfRenderStartedAt: timestamp('pdf_render_started_at', { withTimezone: true }),
    /**
     * Which render attempt owns the row, exactly as `extraction_run_id` does
     * for extraction: a slow render that has been superseded by a newer save
     * must discard its result instead of overwriting fresher bytes.
     */
    pdfRenderRunId: uuid('pdf_render_run_id'),

    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // The stuck-RUNNING sweep filters on exactly this pair.
    index('idx_senior_resumes_status').on(t.status, t.extractionStartedAt),
    // The abandoned-QUEUED sweep filters on a DIFFERENT pair: a QUEUED row has
    // no `extraction_started_at` (nothing ever claimed it), so it can only be
    // aged by `updated_at`. The index above does not serve that query at all.
    index('idx_senior_resumes_status_updated_at').on(t.status, t.updatedAt),
    // The stuck-RENDER sweep asks a third question again: which renders have
    // been RUNNING too long. Same shape as the extraction sweep, own columns.
    index('idx_senior_resumes_render_status').on(t.pdfRenderStatus, t.pdfRenderStartedAt),
  ],
)

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const seniorResumesRelations = relations(seniorResumes, ({ one }) => ({
  user: one(users, {
    fields: [seniorResumes.userId],
    references: [users.id],
    relationName: 'seniorResumeOwner',
  }),
  updatedBy: one(users, {
    fields: [seniorResumes.updatedByUserId],
    references: [users.id],
    relationName: 'seniorResumeEditor',
  }),
}))

export const employeeContractsRelations = relations(employeeContracts, ({ one }) => ({
  user: one(users, { fields: [employeeContracts.userId], references: [users.id] }),
  sourceTemplate: one(contractTemplates, {
    fields: [employeeContracts.sourceTemplateId],
    references: [contractTemplates.id],
  }),
  signedContract: one(signedContracts, {
    fields: [employeeContracts.signedContractId],
    references: [signedContracts.id],
  }),
  createdByUser: one(users, {
    fields: [employeeContracts.createdByUserId],
    references: [users.id],
  }),
}))

export const usersRelations = relations(users, ({ many }) => ({
  teamMemberships: many(teamMembers),
  projects: many(projects, { relationName: 'projectSenior' }),
  dropProjects: many(projects, { relationName: 'projectDrop' }),
  projectMemberships: many(projectMembers),
  seniorInterviews: many(interviews, { relationName: 'seniorInterviews' }),
  hrInterviews: many(interviews, { relationName: 'hrInterviews' }),
  sentTransactions: many(transactions, { relationName: 'sentTransactions' }),
  receivedTransactions: many(transactions, { relationName: 'receivedTransactions' }),
  validatedTransactions: many(transactions, { relationName: 'validatedTransactions' }),
  createdTransactions: many(transactions, { relationName: 'createdTransactions' }),
  payoutRequests: many(payoutRequests),
  auditLogAsActor: many(userAuditLog, { relationName: 'auditLogAsActor' }),
  auditLogAsTarget: many(userAuditLog, { relationName: 'auditLogAsTarget' }),
}))

export const teamsRelations = relations(teams, ({ many }) => ({
  members: many(teamMembers),
}))

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, { fields: [teamMembers.teamId], references: [teams.id] }),
  user: one(users, { fields: [teamMembers.userId], references: [users.id] }),
}))

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

export const interviewsRelations = relations(interviews, ({ one }) => ({
  senior: one(users, {
    fields: [interviews.seniorId],
    references: [users.id],
    relationName: 'seniorInterviews',
  }),
  hr: one(users, {
    fields: [interviews.hrId],
    references: [users.id],
    relationName: 'hrInterviews',
  }),
}))

export const payoutRequestsRelations = relations(payoutRequests, ({ one, many }) => ({
  senior: one(users, { fields: [payoutRequests.seniorId], references: [users.id] }),
  transactions: many(transactions),
}))

export const transactionsRelations = relations(transactions, ({ one, many }) => ({
  sender: one(users, {
    fields: [transactions.senderId],
    references: [users.id],
    relationName: 'sentTransactions',
  }),
  receiver: one(users, {
    fields: [transactions.receiverId],
    references: [users.id],
    relationName: 'receivedTransactions',
  }),
  validator: one(users, {
    fields: [transactions.validatedBy],
    references: [users.id],
    relationName: 'validatedTransactions',
  }),
  creator: one(users, {
    fields: [transactions.createdBy],
    references: [users.id],
    relationName: 'createdTransactions',
  }),
  project: one(projects, { fields: [transactions.projectId], references: [projects.id] }),
  payoutRequest: one(payoutRequests, {
    fields: [transactions.payoutRequestId],
    references: [payoutRequests.id],
  }),
  receiptDocument: one(documents, {
    fields: [transactions.receiptDocumentId],
    references: [documents.id],
  }),
  invoiceDocument: one(documents, {
    fields: [transactions.invoiceDocumentId],
    references: [documents.id],
    relationName: 'invoiceDocument',
  }),
  signatures: many(invoiceSignatures),
}))

export const pendingObligationsRelations = relations(pendingObligations, ({ one }) => ({
  creditor: one(users, {
    fields: [pendingObligations.creditorUserId],
    references: [users.id],
    relationName: 'pendingObligationsAsCreditor',
  }),
  debtor: one(users, {
    fields: [pendingObligations.debtorUserId],
    references: [users.id],
    relationName: 'pendingObligationsAsDebtor',
  }),
  sourceTransaction: one(transactions, {
    fields: [pendingObligations.sourceTransactionId],
    references: [transactions.id],
    relationName: 'pendingObligationsAsSource',
  }),
  closingTransaction: one(transactions, {
    fields: [pendingObligations.closingTransactionId],
    references: [transactions.id],
    relationName: 'pendingObligationsAsClosing',
  }),
}))

export const invoiceSignaturesRelations = relations(invoiceSignatures, ({ one }) => ({
  transaction: one(transactions, {
    fields: [invoiceSignatures.transactionId],
    references: [transactions.id],
  }),
  signer: one(users, { fields: [invoiceSignatures.signerId], references: [users.id] }),
}))

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}))

export const legendsRelations = relations(legends, ({ one, many }) => ({
  project: one(projects, { fields: [legends.projectId], references: [projects.id] }),
  entries: many(legendEntries),
}))

export const legendEntriesRelations = relations(legendEntries, ({ one }) => ({
  legend: one(legends, { fields: [legendEntries.legendId], references: [legends.id] }),
  author: one(users, { fields: [legendEntries.authorId], references: [users.id] }),
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

export const userAuditLogRelations = relations(userAuditLog, ({ one }) => ({
  actor: one(users, {
    fields: [userAuditLog.actorId],
    references: [users.id],
    relationName: 'auditLogAsActor',
  }),
  target: one(users, {
    fields: [userAuditLog.targetId],
    references: [users.id],
    relationName: 'auditLogAsTarget',
  }),
}))

export const teamAuditLogRelations = relations(teamAuditLog, ({ one }) => ({
  actor: one(users, { fields: [teamAuditLog.actorId], references: [users.id] }),
  target: one(teams, { fields: [teamAuditLog.targetId], references: [teams.id] }),
}))

export const projectAuditLogRelations = relations(projectAuditLog, ({ one }) => ({
  actor: one(users, { fields: [projectAuditLog.actorId], references: [users.id] }),
  target: one(projects, { fields: [projectAuditLog.targetId], references: [projects.id] }),
}))

export const documentsRelations = relations(documents, ({ one }) => ({
  owner: one(users, {
    fields: [documents.ownerId],
    references: [users.id],
    relationName: 'documentsAsOwner',
  }),
  project: one(projects, {
    fields: [documents.projectId],
    references: [projects.id],
  }),
  uploader: one(users, {
    fields: [documents.uploadedBy],
    references: [users.id],
    relationName: 'documentsAsUploader',
  }),
  deleter: one(users, {
    fields: [documents.deletedBy],
    references: [users.id],
    relationName: 'documentsAsDeleter',
  }),
}))

// Job sourcing relations (task-job-sourcing-slice1)
export const jobPostingsRelations = relations(jobPostings, ({ one, many }) => ({
  source: one(jobSources, { fields: [jobPostings.sourceId], references: [jobSources.id] }),
  suggestions: many(jobSuggestions),
}))

export const jobSuggestionsRelations = relations(jobSuggestions, ({ one }) => ({
  posting: one(jobPostings, {
    fields: [jobSuggestions.postingId],
    references: [jobPostings.id],
  }),
  senior: one(users, {
    fields: [jobSuggestions.seniorId],
    references: [users.id],
    relationName: 'jobSuggestionsAsSenior',
  }),
  statusChangedByUser: one(users, {
    fields: [jobSuggestions.statusChangedBy],
    references: [users.id],
    relationName: 'jobSuggestionsAsStatusChanger',
  }),
}))

// Onboarding relations
export const contractTemplatesRelations = relations(contractTemplates, ({ one, many }) => ({
  createdBy: one(users, {
    fields: [contractTemplates.createdByUserId],
    references: [users.id],
    relationName: 'contractTemplatesAsCreator',
  }),
  signed: many(signedContracts),
}))

export const signedContractsRelations = relations(signedContracts, ({ one }) => ({
  user: one(users, {
    fields: [signedContracts.userId],
    references: [users.id],
    relationName: 'signedContractsAsUser',
  }),
  template: one(contractTemplates, {
    fields: [signedContracts.templateId],
    references: [contractTemplates.id],
  }),
}))

export const tosVersionsRelations = relations(tosVersions, ({ one, many }) => ({
  createdBy: one(users, {
    fields: [tosVersions.createdByUserId],
    references: [users.id],
    relationName: 'tosVersionsAsCreator',
  }),
  acceptances: many(tosAcceptances),
}))

export const tosAcceptancesRelations = relations(tosAcceptances, ({ one }) => ({
  user: one(users, {
    fields: [tosAcceptances.userId],
    references: [users.id],
    relationName: 'tosAcceptancesAsUser',
  }),
  version: one(tosVersions, {
    fields: [tosAcceptances.tosVersionId],
    references: [tosVersions.id],
  }),
}))

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Team = typeof teams.$inferSelect
export type NewTeam = typeof teams.$inferInsert
export type TeamMember = typeof teamMembers.$inferSelect
export type NewTeamMember = typeof teamMembers.$inferInsert
export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
export type ProjectMember = typeof projectMembers.$inferSelect
export type NewProjectMember = typeof projectMembers.$inferInsert
export type ProjectFinanceSettings = typeof projectFinanceSettings.$inferSelect
export type NewProjectFinanceSettings = typeof projectFinanceSettings.$inferInsert
export type Interview = typeof interviews.$inferSelect
export type NewInterview = typeof interviews.$inferInsert
export type Transaction = typeof transactions.$inferSelect
export type NewTransaction = typeof transactions.$inferInsert
export type JobSource = typeof jobSources.$inferSelect
export type NewJobSource = typeof jobSources.$inferInsert
export type JobPosting = typeof jobPostings.$inferSelect
export type NewJobPosting = typeof jobPostings.$inferInsert
export type JobSuggestion = typeof jobSuggestions.$inferSelect
export type NewJobSuggestion = typeof jobSuggestions.$inferInsert
export type JobExclusionFilter = typeof jobExclusionFilters.$inferSelect
export type NewJobExclusionFilter = typeof jobExclusionFilters.$inferInsert
export type PayoutRequest = typeof payoutRequests.$inferSelect
export type NewPayoutRequest = typeof payoutRequests.$inferInsert
export type UserAuditLogEntry = typeof userAuditLog.$inferSelect
export type NewUserAuditLogEntry = typeof userAuditLog.$inferInsert
export type TeamAuditLogEntry = typeof teamAuditLog.$inferSelect
export type NewTeamAuditLogEntry = typeof teamAuditLog.$inferInsert
export type ProjectAuditLogEntry = typeof projectAuditLog.$inferSelect
export type NewProjectAuditLogEntry = typeof projectAuditLog.$inferInsert
export type Document = typeof documents.$inferSelect
export type NewDocument = typeof documents.$inferInsert
export type InvoiceSignature = typeof invoiceSignatures.$inferSelect
export type NewInvoiceSignature = typeof invoiceSignatures.$inferInsert
export type Notification = typeof notifications.$inferSelect
export type NewNotification = typeof notifications.$inferInsert
export type PendingObligation = typeof pendingObligations.$inferSelect
export type NewPendingObligation = typeof pendingObligations.$inferInsert
export type ContractTemplate = typeof contractTemplates.$inferSelect
export type NewContractTemplate = typeof contractTemplates.$inferInsert
export type SignedContract = typeof signedContracts.$inferSelect
export type NewSignedContract = typeof signedContracts.$inferInsert
export type TosVersion = typeof tosVersions.$inferSelect
export type NewTosVersion = typeof tosVersions.$inferInsert
export type TosAcceptance = typeof tosAcceptances.$inferSelect
export type NewTosAcceptance = typeof tosAcceptances.$inferInsert
export type EmployeeContract = typeof employeeContracts.$inferSelect
export type NewEmployeeContract = typeof employeeContracts.$inferInsert
export type Legend = typeof legends.$inferSelect
export type NewLegend = typeof legends.$inferInsert
export type SeniorResume = typeof seniorResumes.$inferSelect
export type NewSeniorResume = typeof seniorResumes.$inferInsert
