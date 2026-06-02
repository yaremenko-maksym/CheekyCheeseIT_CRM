import { relations, sql } from 'drizzle-orm'
import {
  char,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

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
  // Soft delete (archived users hidden from main UI, restorable)
  archivedAt: timestamp('archived_at'),
  // Admin note (single overwriteable text field)
  adminNote: text('admin_note'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
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
  archivedAt: timestamp('archived_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const teamMembers = pgTable('team_members', {
  id: uuid('id').defaultRandom().primaryKey(),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  joinedAt: timestamp('joined_at').defaultNow().notNull(),
  // Soft delete of membership (NULL = active, timestamp = left)
  leftAt: timestamp('left_at'),
})

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const projects = pgTable('projects', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  companyName: varchar('company_name', { length: 255 }).notNull(),
  domain: varchar('domain', { length: 100 }).notNull(),
  startDate: timestamp('start_date').notNull(),
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
  paymentType: varchar('payment_type', { length: 100 }),
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
  // Soft delete (archived projects hidden from main UI, restorable). The
  // project lifecycle is binary: ACTIVE (archivedAt = null) vs ARCHIVED
  // (archivedAt = timestamp of when the project ended).
  archivedAt: timestamp('archived_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
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
  // Override junior monthly salary for this project; null = use users.monthlySalary
  juniorSalaryOverride: numeric('junior_salary_override', { precision: 10, scale: 2 }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const projectMembers = pgTable('project_members', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  joinedAt: timestamp('joined_at').defaultNow().notNull(),
  leftAt: timestamp('left_at'),
})

// ---------------------------------------------------------------------------
// Interviews
// ---------------------------------------------------------------------------

export const interviews = pgTable('interviews', {
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
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// Finance — Transactions (unified ledger)
// ---------------------------------------------------------------------------

// Groups validated SENIOR_INCOME transactions into a single payout obligation
export const payoutRequests = pgTable('payout_requests', {
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
  status: payoutRequestStatusEnum().notNull().default('PENDING'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const transactions = pgTable('transactions', {
  id: uuid('id').defaultRandom().primaryKey(),
  type: transactionTypeEnum().notNull(),
  status: transactionStatusEnum().notNull().default('PENDING'),
  amount: numeric('amount', { precision: 18, scale: 6 }).notNull(),
  // currency always stored; USDT for crypto flows, USD for salary/expenses
  currency: currencyEnum().notNull().default('USDT'),
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
  // Snapshot of senior share percent at time of SENIOR_INCOME creation
  seniorSharePercent: integer('senior_share_percent'),
  // task-team-senior-share-override. Snapshot of *where* the percent above
  // came from at creation time. One of 'PROJECT' | 'TEAM' | 'USER_DEFAULT'.
  // Nullable to keep legacy rows (pre-task) renderable as-is. The hierarchy
  // resolved here is: project override → team override → user default.
  seniorSharePercentSource: varchar('senior_share_percent_source', { length: 16 }),
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
  // Blockchain TX hash (for PAYOUT, PAYOUT_ADMIN)
  txHash: varchar('tx_hash', { length: 255 }),
  // Accountant/admin validation fields (for SENIOR_INCOME)
  validatedBy: uuid('validated_by').references(() => users.id, { onDelete: 'set null' }),
  validatedAt: timestamp('validated_at'),
  rejectionReason: varchar('rejection_reason', { length: 500 }),
  notes: varchar('notes', { length: 1000 }),
  // Calendar month this transaction belongs to (for SALARY/LOCKED logic): YYYY-MM
  salaryMonth: varchar('salary_month', { length: 7 }),
  // User-specified transaction date (defaults to creation time if not provided)
  txDate: timestamp('tx_date'),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
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
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_pending_obligations_creditor').on(t.creditorUserId),
    index('idx_pending_obligations_status').on(t.status),
    index('idx_pending_obligations_source').on(t.sourceTransactionId),
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
    deletedAt: timestamp('deleted_at'),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
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
    signedAt: timestamp('signed_at').defaultNow().notNull(),
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
    readAt: timestamp('read_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
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
    createdAt: timestamp('created_at').defaultNow().notNull(),
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
    createdAt: timestamp('created_at').defaultNow().notNull(),
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
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('project_audit_log_target_id_idx').on(t.targetId),
    index('project_audit_log_created_at_idx').on(t.createdAt),
  ],
)

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

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
