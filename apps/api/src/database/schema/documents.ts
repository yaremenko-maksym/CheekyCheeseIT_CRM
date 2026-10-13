/**
 * Documents, invoice signatures, contract templates, signed contracts, ToS, employee contracts.
 */
import { relations, sql } from 'drizzle-orm'
import {
  boolean,
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
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import {
  currencyEnum,
  documentCategoryEnum,
  invoiceSignatureMethodEnum,
  invoiceSignerRoleEnum,
  roleEnum,
} from './enums'
import { projects } from './projects'
import { transactions } from './transactions'
import { users } from './users'

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
// Documents (PHASE 6)
// ---------------------------------------------------------------------------
//
// Storage layer for all uploaded files (resumes, scans, contracts, receipts,
// avatars, logos). The file bytes live in S3 (RustFS in dev/CI, R2 in prod);
// this table only tracks metadata + the immutable `s3_key`. Soft delete is
// two-stage: owner/ADMIN soft-delete sets `deletedAt` + `deletedBy`;
// ADMIN-only hard delete then removes the S3 object and the DB row.
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
    // task-invoice-signature-integrity (AC2, owner decision 2026-08-22):
    // stamped once, when the amount-edit path (task-3,
    // paid-transaction-edit-cascade) VOIDS the invoice this row attests to.
    // NULL = still the active attestation for the transaction's CURRENT
    // invoice. Non-null rows are kept forever, never deleted — "person X
    // clicked sign on file with hash H at time T" stays true even after the
    // underlying transaction amount changes and a fresh invoice is issued;
    // only the row's *authority* over "is this tx currently signed" is
    // retired. This is the audit trail an investigation would need.
    // Stryker disable next-line StringLiteral,BooleanLiteral,ObjectLiteral: column name + type (timestamptz vs timestamp) — DB-only, no unit test can observe either.
    // The prod DDL declares the same identifier/type in
    // 2026-08-22_invoice_signature_void_and_snapshot.sql, and
    // invoice-signature-integrity.integration.spec.ts exercises the column
    // through every void/reissue/re-sign step in the spec.
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    // task-invoice-signature-integrity (AC3): what the FINAL rendered PDF
    // actually contains at signing time, frozen verbatim — never recomputed
    // on read (same discipline as `originalAmount`/`exchangeRate`, see C2 in
    // docs/architecture/2026-08-22-paid-transaction-edit-cascade.md). Only
    // populated on the COUNTERPARTY row — the one the public /verify
    // endpoint reads — so a later `transactions.amount` edit (or any write
    // that bypasses the void path in AC2) can never surface as "confirmed".
    // Stryker disable next-line StringLiteral,ObjectLiteral: column name + numeric(18,6) precision/scale — DB-only, enforced by Postgres, not by any mocked Drizzle layer.
    // Exercised against a real database by
    // invoice-signature-integrity.integration.spec.ts, which asserts the
    // stored/returned value is exactly '1500.000000' (6dp) after a re-sign.
    amountSnapshot: numeric('amount_snapshot', { precision: 18, scale: 6 }),
    // Stryker disable next-line StringLiteral: a COLUMN NAME — it exists in
    // the database, so no unit test can observe it; the prod DDL declares
    // the same identifier in
    // 2026-08-22_invoice_signature_void_and_snapshot.sql and
    // invoice-signature-integrity.integration.spec.ts reads through it.
    currencySnapshot: currencyEnum('currency_snapshot'),
  },
  (t) => [
    // One ACTIVE signature per (transaction, role) — guards against
    // double-sign races. Partial (WHERE voided_at IS NULL), not blanket:
    // task-invoice-signature-integrity needs a transaction to carry more
    // than one HISTORICAL signature per role across successive
    // void → reissue → re-sign cycles. Same "one active, unlimited history"
    // shape as `uq_pending_obligations_source_pending` elsewhere in this file.
    // Stryker disable next-line StringLiteral: an INDEX NAME — it exists in
    // the database, so no unit test can observe it; the prod DDL declares
    // the same identifier and invoice-signature-integrity.integration.spec.ts
    // proves the constraint it enforces (re-sign after void does not 23505).
    uniqueIndex('uq_invoice_signatures_active')
      .on(t.transactionId, t.signerRole)
      .where(
        // Stryker disable next-line StringLiteral: the partial-index WHERE clause is Postgres DDL, observable only against a real database.
        // invoice-signature-integrity.integration.spec.ts's re-sign-after-void
        // step would hit a 23505 unique violation if this clause were dropped
        // (the OLD voided COUNTERPARTY row would collide with the new one).
        sql`${t.voidedAt} IS NULL`,
      ),
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

export const invoiceSignaturesRelations = relations(invoiceSignatures, ({ one }) => ({
  transaction: one(transactions, {
    fields: [invoiceSignatures.transactionId],
    references: [transactions.id],
  }),
  signer: one(users, { fields: [invoiceSignatures.signerId], references: [users.id] }),
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

export type Document = typeof documents.$inferSelect

export type NewDocument = typeof documents.$inferInsert

export type InvoiceSignature = typeof invoiceSignatures.$inferSelect

export type NewInvoiceSignature = typeof invoiceSignatures.$inferInsert

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
