/**
 * Payout requests, salary initialisation, tx-hash dedupe, company account, obligations.
 */
import { isNull, relations, sql } from 'drizzle-orm'
import {
  index,
  integer,
  numeric,
  pgTable,
  pgView,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import {
  currencyEnum,
  payoutRequestStatusEnum,
  pendingObligationDebtorTypeEnum,
  pendingObligationStatusEnum,
} from './enums'
import { transactions } from './transactions'
import { users } from './users'

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

// Monthly cron idempotency must not constrain the business ledger: operators
// may create several salary parts for one employee/month. A durable marker
// claims only the automatic component and survives salary edits/soft-deletes.
export const salaryMonthInitializations = pgTable(
  'salary_month_initializations',
  {
    // Drizzle infers the same physical name (id) from this property key.
    // Avoid an explicit redundant literal that mutation testing cannot distinguish
    // from the empty-name form because Drizzle normalizes both to the property key.
    id: uuid().defaultRandom().primaryKey(),
    receiverId: uuid('receiver_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    salaryMonth: varchar('salary_month', { length: 7 }).notNull(),
    initializedBy: uuid('initialized_by').references(() => users.id, { onDelete: 'set null' }),
    initializedAt: timestamp('initialized_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('uq_salary_month_initializations_receiver_month').on(t.receiverId, t.salaryMonth),
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
    // task-settle-payout-link-lost (backlog 74/B-1). Durable "which payout
    // request caused this obligation" link — stamped ONCE at booking time
    // (bookCompanyObligations, transactions.service.ts) from the SAME
    // payoutRequestId the source IOU transaction receives. Deliberately a
    // SEPARATE column from (and never touched by) settleByCompany's reset of
    // `transactions.payoutRequestId` on the flipped row (pending-settlement
    // .service.ts — that reset is intentional, see the CRITICAL comment
    // there: keeping it would bleed a settled row into
    // autoCreateForPayout's payoutRequestId aggregation and the findOne
    // SENIOR_INCOME-by-payoutRequestId enrichment). This column exists
    // purely so a payout's detail read can still resolve "which obligations
    // arose from it" — via `sourceTransactionId` — AFTER the obligation is
    // settled, when the transaction-level link is already gone. NULL for an
    // obligation booked outside a payout cascade (declareUsdtProjectIncome —
    // no payout_requests row exists at that point). ON DELETE SET NULL
    // mirrors `transactions.payoutRequestId`'s own FK behaviour — this
    // column is informational (display only), never a security/money gate,
    // so a future payout_requests cleanup nulling it is harmless.
    payoutRequestId: uuid('payout_request_id').references(() => payoutRequests.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_pending_obligations_creditor').on(t.creditorUserId),
    index('idx_pending_obligations_status').on(t.status),
    index('idx_pending_obligations_source').on(t.sourceTransactionId),
    index('idx_pending_obligations_payout_request').on(t.payoutRequestId),
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

export const payoutRequestsRelations = relations(payoutRequests, ({ one, many }) => ({
  senior: one(users, { fields: [payoutRequests.seniorId], references: [users.id] }),
  transactions: many(transactions),
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

export type SalaryMonthInitialization = typeof salaryMonthInitializations.$inferSelect

export type NewSalaryMonthInitialization = typeof salaryMonthInitializations.$inferInsert

export type PayoutRequest = typeof payoutRequests.$inferSelect

export type NewPayoutRequest = typeof payoutRequests.$inferInsert

export type PendingObligation = typeof pendingObligations.$inferSelect

export type NewPendingObligation = typeof pendingObligations.$inferInsert
