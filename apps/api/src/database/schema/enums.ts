/**
 * Postgres enums shared across the schema domains (leaf module: no table imports).
 */
import { pgEnum } from 'drizzle-orm/pg-core'

export const roleEnum = pgEnum('role', ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'])

// task-i18n-stage2 (Task 3, spec §4.1) — interface language per user.
// Mirrors `LOCALES` in `packages/shared/src/i18n/locales.ts` (SSOT for the
// TS union + Zod schema); this enum is the DB-level twin, kept in sync
// manually (Drizzle has no cross-package enum sharing) — see
// `apps/api/drizzle/manual/2026-09-20_user_locale.sql` for the DDL twin.
export const userLocaleEnum = pgEnum('user_locale', ['uk', 'en'])

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

// task-project-draft-status. A project's CONFIRMATION lifecycle — a
// deliberately separate axis from `archivedAt` (see the comment on
// `projects.status` below for why merging the two is exactly the mistake
// this status exists to prevent). `DRAFT` → `ACTIVE` (every invited
// approver confirmed) or `DRAFT` → `REJECTED` (any one declined).
// Stryker disable next-line StringLiteral,ArrayDeclaration: a DB-level enum
// definition, unobservable from a mocked unit double. VERIFIED against real
// Postgres by `visible-projects-view.integration.spec.ts`'s own enum-range
// assertion ("the project_status enum has exactly DRAFT/ACTIVE/REJECTED").
export const projectStatusEnum = pgEnum('project_status', ['DRAFT', 'ACTIVE', 'REJECTED'])

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
export const jobSourceTypeEnum = pgEnum('job_source_type', [
  'DOU_RSS',
  'REMOTEOK_API',
  'REMOTIVE_API',
  'HIMALAYAS_API',
  'JOBICY_API',
  'ARBEITNOW_API',
  'WORKINGNOMADS_API',
  'JOBGETHER_API',
  'HN_HIRING',
  'GREENHOUSE_ATS',
  'LEVER_ATS',
  'ASHBY_ATS',
  'WORKABLE_ATS',
  'SMARTRECRUITERS_ATS',
  'RECRUITEE_ATS',
  'PERSONIO_ATS',
  'JOOBLE_API',
  'JSEARCH_API',
  'THEIRSTACK_API',
  'MUSE_API',
  'REED_API',
  'DJINNI_RSS',
  'WWR_RSS',
  'EUREMOTEJOBS_RSS',
  'JUSTJOIN_HTML',
  'NOFLUFF_HTML',
  'LANDINGJOBS_HTML',
  'NEXTLEVELJOBS_HTML',
  'DICE_HTML',
  'THEHUB_HTML',
  'WTTJ_HTML',
])

// Vacancy queue enums — mirror jobQueueStatusSchema / jobSeniorityLevelSchema /
// jobSignalKindSchema member for member (asserted in job-queue-schema.spec.ts).
// Stryker disable next-line StringLiteral: a Postgres TYPE name — it lives in the database, declared by 2026-10-05_vacancy_sourcing_schema.sql; the members are asserted against the shared enums by job-queue-schema.spec.ts
export const jobQueueStatusEnum = pgEnum('job_queue_status', ['NEW', 'IN_PROGRESS', 'DISMISSED'])

// Stryker disable next-line StringLiteral: a Postgres TYPE name — see jobQueueStatusEnum
export const jobSeniorityEnum = pgEnum('job_seniority', ['MIDDLE', 'SENIOR', 'LEAD', 'UNKNOWN'])

// Stryker disable next-line StringLiteral: a Postgres TYPE name — see jobQueueStatusEnum
export const jobSignalKindEnum = pgEnum('job_posting_signal_kind', [
  'OPENED',
  'TAKEN',
  'DEAD_LINK',
  'SPAM',
])

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
