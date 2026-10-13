import { z } from 'zod'
import { kyivToday } from '../../utils/kyiv-day'
import { withSalaryFloor } from '../money'
import { manualPayoutMethodSchema, salaryFundingSourceSchema } from './enums'
import { transactionSchema } from './transaction'
import {
  extractOnChainTxHash,
  mandatoryReceiptRefine,
  receiptFields,
  refineCompanyAccountUsdt,
  transactionBusinessDateSchema,
} from './validation'

// Create payout request (senior bundles their VALIDATED incomes)
export const createPayoutRequestSchema = z.object({
  transactionIds: z.array(z.string().uuid()).min(1),
  txDate: transactionBusinessDateSchema.optional().nullable(),
})
export type CreatePayoutRequestDto = z.infer<typeof createPayoutRequestSchema>

// Pay payout request (senior/drop submits the on-chain txHash of the USDT
// transfer they sent to the COMPANY wallet — Phase 8 v2).
//
// `txHash` is the hash the backend feeds to `EtherscanService.verifyDeposit`
// against the configured company wallet: a payout flips to PAID only when the
// on-chain recipient == company wallet, confirmations reach the threshold, and
// the transferred amount ≈ payableAmount (see payPayoutRequest). In real mode
// the SENIOR/DROP MUST paste the on-chain hash (min 10 chars).
//
// `simulateResult` is a DEV-only escape hatch: when present and the API is not
// in production, the backend bypasses the Etherscan check and either runs the
// success cascade ("success") or throws a deterministic 400 ("error") so User
// Testing can rehearse both branches without a real on-chain transaction. In
// production the field is ignored — real verification owns the decision. When
// simulating, txHash can be empty — the backend synthesizes a `0xSIM...` stub
// so the audit row never holds null. `.superRefine` enforces the conditional
// requirement at the schema layer so the controller needs no branch logic.
export const payPayoutRequestSchema = z
  .object({
    txHash: z.string().max(255).optional(),
    simulateResult: z.enum(['success', 'error']).optional(),
    txDate: transactionBusinessDateSchema.optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.simulateResult === undefined) {
      const trimmed = data.txHash?.trim() ?? ''
      if (trimmed.length < 10) {
        ctx.addIssue({
          code: 'custom',
          message: 'zod.TX_HASH_MIN_LENGTH',
          path: ['txHash'],
        })
      }
    }
  })
export type PayPayoutRequestDto = z.infer<typeof payPayoutRequestSchema>

/**
 * POST /api/transactions/onchain-hash/release — ADMIN only.
 *
 * MED-G (security-review PR #438): the escape hatch from a mis-claimed transfer
 * (a typo'd hash, a deposit whose hash collided). Without it a claim is
 * permanent and the money it blocks is unreachable. `reason` is REQUIRED and
 * lands in `transaction_audit_log` — a release is a deliberate, attributable
 * act, never a quiet un-spend.
 */
export const releaseOnChainHashSchema = z.object({
  txHash: z
    .string()
    .min(1)
    .max(255)
    .refine((v) => extractOnChainTxHash(v) !== null, {
      message: 'zod.TX_HASH_FORMAT',
    }),
  reason: z.string().trim().min(3, 'zod.REASON_REQUIRED_RELEASE').max(500),
})
export type ReleaseOnChainHashDto = z.infer<typeof releaseOnChainHashSchema>

export const manualConfirmPayoutSchema = z.object({
  method: manualPayoutMethodSchema,
  note: z.string().max(1000).optional().nullable(),
  txDate: transactionBusinessDateSchema.optional().nullable(),
  // HIGH-1 (security-review PR #438): the format is now validated at the write
  // boundary. A supplied txHash MUST contain a real on-chain hash (bare or as
  // an explorer link) — previously any string ≥10 chars was accepted verbatim,
  // became the payout's `tx_hash`, and slipped past the consumed-hash registry.
  // `.refine` (not a type-predicate) keeps the TS type `string`, per the
  // shared-schema convention — runtime strictness, no frontend type churn.
  txHash: z
    .string()
    .max(255)
    .optional()
    .nullable()
    .refine((v) => v === null || v === undefined || v === '' || extractOnChainTxHash(v) !== null, {
      message: 'zod.TX_HASH_FORMAT_OR_EMPTY',
    }),
})
export type ManualConfirmPayoutDto = z.infer<typeof manualConfirmPayoutSchema>

// Update project finance settings (ADMIN/ACCOUNTANT)
export const updateProjectFinanceSettingsSchema = z.object({
  seniorSharePercentOverride: z.number().int().min(0).max(100).nullable().optional(),
  // BIZ-14. task-money-floor-and-lying-comments: hand-entered by the
  // ADMIN/ACCOUNTANT — feeds `createMonthlySalaries`' cron insert directly
  // (bypasses createSalarySchema entirely), so an unfloored override here was
  // the SAME "obligation recorded as zero" bug at a different column scale
  // (numeric(10,2), not (18,6) — see `SALARY_AMOUNT_DECIMAL_PLACES` in
  // `./money`). Floor added via the SHARED `withSalaryFloor` (MED-1:
  // `users.monthlySalary`, the OTHER operand this cron reads, needed the
  // identical fix — see `./money`'s module comment); `0` itself stays valid
  // (a deliberate "no salary on this project" override, unchanged).
  juniorSalaryOverride: withSalaryFloor(z.number().nonnegative().max(500_000))
    .nullable()
    .optional(),
})
export type UpdateProjectFinanceSettingsDto = z.infer<typeof updateProjectFinanceSettingsSchema>

// Drop role - phase 3 (spec §8.4). Manual payout confirmation — ACCOUNTANT/ADMIN
// confirms a PAYOUT actually arrived to a selected admin partner. Body carries
// the chosen admin id, the payment method (crypto vs cash — refactor task
// task-drop-phase4-refactor-remove-tov.md AC4), and conditionally a txHash
// (required for CRYPTO, omitted for CASH).
//
// Note: we accept any UUID shape (not just strict RFC-versioned). The seeded
// partner ids `00000000-0000-0000-0000-00000000000{1,2}` (MAKSYM_ID/KOSTYA_ID)
// have a literal `0` in the version nibble, which Zod v4's built-in `.uuid()`
// rejects. The recipient is re-validated server-side (must exist, role=ADMIN,
// not archived) so format permissiveness is safe here.
const UUID_LIKE_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export const payoutMethodSchema = z.enum(['CRYPTO', 'CASH'])
export type PayoutMethod = z.infer<typeof payoutMethodSchema>

export const confirmPayoutSchema = z
  .object({
    recipientAdminId: z.string().regex(UUID_LIKE_REGEX, 'Invalid UUID'),
    method: payoutMethodSchema.default('CRYPTO'),
    txHash: z.string().max(255).optional().nullable(),
    txDate: transactionBusinessDateSchema.optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.method === 'CRYPTO') {
      const trimmed = data.txHash?.trim() ?? ''
      if (trimmed.length < 10) {
        ctx.addIssue({
          code: 'custom',
          message: 'zod.TX_HASH_MIN_LENGTH',
          path: ['txHash'],
        })
      }
    }
  })
export type ConfirmPayoutDto = z.infer<typeof confirmPayoutSchema>

// ---------------------------------------------------------------------------
// Finance summary / stats
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase 4-A — Balance infrastructure (computed on-demand, multi-currency)
// ---------------------------------------------------------------------------
//
// `BalanceService` (apps/api/src/finance/balance.service.ts) returns these
// shapes via /api/balances/{tov,admin/:id,senior/:id}. Balances are derived
// from the unified `transactions` ledger on every request (no stored balance
// columns). Multi-currency: amounts are converted to the requested base
// currency through `NbuCurrencyService` rates.
//
// `breakdown` is a free-form `Record<string, number>` so callers can show a
// per-component split (income, dividends_paid, expenses, tax, etc.) without
// pinning the contract to one specific layout. Each balance method returns
// a stable, documented set of keys (see balance.service.ts JSDoc).

export const balanceSchema = z.object({
  balance: z.number(),
  currency: z.string(),
  breakdown: z.record(z.string(), z.number()),
})
export type BalanceDto = z.infer<typeof balanceSchema>

// Total earned — lifetime accumulated money the COMPANY actually PAID this
// user, via `GET /api/balances/total-earned/:userId`. RBAC: ADMIN + ACCOUNTANT
// only (it is a privileged financial metric — see balance.service.ts
// assertCanReadTotalEarned). Surfaced on the "Finance" tab of an employee
// profile for those two viewer roles.
//
// Aggregation is over PAID transaction rows where the target user is the real
// money recipient, mapped per the target's role (see BalanceService.getTotalEarned
// JSDoc). All amounts are converted to a single base currency (default USD)
// through NbuCurrencyService so the figure is comparable across multi-currency
// rows. `breakdown` carries the per-source split (salary / income / payout / …).
export const totalEarnedSchema = z.object({
  /** Target user the figure belongs to. */
  userId: z.string().uuid(),
  /** Target user's role at query time — drives which PAID rows are summed. */
  role: z.enum(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']),
  /** Sum of all PAID money the company routed to this user, in `currency`. */
  totalEarned: z.number(),
  currency: z.string(),
  /** Per-source split (e.g. { salary, income, payout }). Always finite numbers. */
  breakdown: z.record(z.string(), z.number()),
})
export type TotalEarnedDto = z.infer<typeof totalEarnedSchema>

// Pending obligations — table-backed, distinct lifecycle from the
// transactions ledger. Each row: "creditor (senior) is owed `amount`
// `currency` by debtor (DROP / COMPANY / admin)". A SENIOR_PAID
// transaction closes the obligation (status → PAID + closingTransactionId).
//
// Post-Phase-4 refactor (task-drop-phase4-refactor-remove-tov.md AC3): the
// 'TOV' value remains in the enum because legacy/history rows may carry it,
// but NEW obligations are never created with debtorType='TOV' — the bank
// channel that produced them has been removed.
//
// task-drop-company-debt-and-invoices (post-refactor): the senior share
// from drop-projects is now owed by **the COMPANY**, not the DROP user.
// New cash + crypto flows insert SENIOR_PENDING_PAYOUT with
// `debtorType='COMPANY'`; closure happens via `settleByCompany` (ADMIN /
// ACCOUNTANT only). Historical 'DROP'-debt rows are left untouched so the
// audit trail stays intact.
export const pendingObligationDebtorTypeSchema = z.enum(['DROP', 'TOV', 'ADMIN', 'COMPANY'])
export type PendingObligationDebtorType = z.infer<typeof pendingObligationDebtorTypeSchema>

export const pendingObligationStatusSchema = z.enum(['PENDING', 'PAID', 'CANCELLED'])
export type PendingObligationStatus = z.infer<typeof pendingObligationStatusSchema>

export const pendingObligationSchema = z.object({
  id: z.string().uuid(),
  creditorUserId: z.string().uuid(),
  debtorType: pendingObligationDebtorTypeSchema,
  debtorUserId: z.string().uuid().nullable(),
  sourceTransactionId: z.string().uuid(),
  closingTransactionId: z.string().uuid().nullable(),
  amount: z.string(), // numeric string from DB to avoid float drift
  currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
  status: pendingObligationStatusSchema,
  // task-settle-payout-link-lost (backlog 74/B-1): durable link to the
  // payout_requests row that caused this obligation — see the column
  // comment in schema.ts. NULL for obligations booked outside a payout
  // cascade (declareUsdtProjectIncome).
  payoutRequestId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type PendingObligationDto = z.infer<typeof pendingObligationSchema>

// ---------------------------------------------------------------------------
// Phase 4-B — Payment Channels (crypto / bank / cash)
// ---------------------------------------------------------------------------
//
// PaymentChannelService (apps/api/src/finance/payment-channel.service.ts) is
// the entry point for drop-projects that need to settle a validated
// DROP_INCOME with the company. Three alternative channels (crypto, bank,
// cash) live alongside the legacy Phase 2 `payPayoutRequest` and Phase 3
// `confirmPayout` flows — both remain functional. Phase 4-B does NOT replace
// the existing paths.
//
// Numbers are spec-aligned for the canonical $3500 example:
//   - 10% drop share ($350) — stays with the drop, no transaction recorded
//   - 16% senior share ($560) — paid out (crypto direct OR senior IOU)
//   - 37% / 37% admin partner shares ($1295 each)
// Generic math: `senior = income * seniorPercent / 100`,
//               `drop   = income * dropPercent / 100`,
//               `partners = income - senior - drop`, split 50/50.

// Recipient shape for the crypto channel — drop sees one row per wallet
// transfer (senior + Maksym + Kostya). The frontend renders this as 3 cards
// with "send $X USDT to 0x…" instructions.
export const cryptoRecipientSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  address: z.string(),
  amount: z.string(), // numeric string mirrors transactions.amount
  currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
  role: z.enum(['SENIOR', 'ADMIN']),
})
export type CryptoRecipientDto = z.infer<typeof cryptoRecipientSchema>

export const initiateCryptoPaymentResponseSchema = z.object({
  contractAddress: z.string().nullable(), // Phase 5: PaymentSplitter address; null today
  recipients: z.array(cryptoRecipientSchema),
  currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
})
export type InitiateCryptoPaymentResponseDto = z.infer<typeof initiateCryptoPaymentResponseSchema>

// Request body for /api/payments/confirm-crypto. txHashes is one hash per
// recipient (3 today: senior + 2 admins) OR a single hash if Phase 5 routes
// everything through one PaymentSplitter call. The backend just records what
// it receives — no on-chain verification yet.
//
// Note on UUID shape: payment-channel body ids use `UUID_LIKE_REGEX` instead
// of Zod v4's strict `.uuid()` (which requires an RFC version digit 1-8 in
// the third octet). Seeded MAKSYM_ID/KOSTYA_ID + a few legacy income rows
// have a literal `0` there. Backend re-validates existence / role / archived
// for every body id so the format permissiveness is safe. Same pattern as
// `confirmPayoutSchema` (Phase 3 fix).
export const confirmCryptoPaymentSchema = z.object({
  incomeId: z.string().regex(UUID_LIKE_REGEX, 'Invalid UUID'),
  txHashes: z.array(z.string().min(4).max(255)).min(1),
})
export type ConfirmCryptoPaymentDto = z.infer<typeof confirmCryptoPaymentSchema>

export const initiateCryptoPaymentSchema = z.object({
  incomeId: z.string().regex(UUID_LIKE_REGEX, 'Invalid UUID'),
})
export type InitiateCryptoPaymentDto = z.infer<typeof initiateCryptoPaymentSchema>

// ---------------------------------------------------------------------------
// Phase 4-C — Pending senior settlement (post task-drop-company-debt-and-invoices)
// ---------------------------------------------------------------------------
//
// Senior share from drop-projects is owed by **the COMPANY**, not the DROP:
//
//   debtorType='COMPANY': both crypto + cash channels create the senior IOU
//   against the company (after sending the admin share via crypto, or after
//   ADMIN/ACCOUNTANT logged the cash handoff). Closed by ACCOUNTANT/ADMIN
//   via /api/pending-settlements/:id/settle-company — never by DROP.
//
// Settle-company also auto-creates an INVOICE on the resulting SENIOR_INCOME
// row, mirroring the Phase 2 `payPayoutRequest` trigger.
//
// Legacy values:
//   debtorType='DROP' — historical rows from the pre-refactor cash flow.
//   debtorType='TOV'  — historical rows from the removed bank channel.

export const pendingSettlementItemSchema = z.object({
  obligationId: z.string(), // pending_obligations.id
  sourceTransactionId: z.string(),
  // task-drop-company-debt-and-invoices: new obligations carry
  // debtorType='COMPANY'. 'DROP' is legacy (kept for historical rows),
  // 'TOV'/'ADMIN' reserved.
  debtorType: pendingObligationDebtorTypeSchema,
  debtorUserId: z.string().nullable(),
  debtorName: z.string().nullable(),
  seniorId: z.string(),
  seniorName: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  amount: z.string(),
  currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
  createdAt: z.string(),
})
export type PendingSettlementItemDto = z.infer<typeof pendingSettlementItemSchema>

export const pendingSettlementListResponseSchema = z.array(pendingSettlementItemSchema)
export type PendingSettlementListResponseDto = z.infer<typeof pendingSettlementListResponseSchema>

// task-receipts-backend (review round 1, MED-1): `settleObligationParamSchema`
// backed the now-REMOVED legacy `POST /pending-settlements/:id/settle-company`
// route (obligation-id, no funding/receipt) — a privileged bypass of the
// mandatory-receipt invariant with zero apps/web callers. See the removal note
// in pending-settlement.controller.ts.

// task-senior-settle-in-tx-row: alternative settle entry point keyed on the
// SOURCE transaction (the SENIOR_PENDING_PAYOUT row) instead of the obligation
// id. The finance-page transactions list pays a senior IOU directly from its
// SENIOR_PENDING_PAYOUT row — the row knows the transaction id, not the
// obligation id. The backend resolves the PENDING obligation linked via
// `pending_obligations.sourceTransactionId` and delegates to the SAME
// (idempotent, ADMIN/ACCOUNTANT-only) settleByCompany cascade. Same permissive
// UUID-like shape as the obligation-id param (seeded users carry version-nibble
// 0 in their UUIDs).
export const settleBySourceTransactionParamSchema = z.object({
  sourceTransactionId: z.string().regex(UUID_LIKE_REGEX, 'Invalid UUID'),
})
export type SettleBySourceTransactionParamDto = z.infer<typeof settleBySourceTransactionParamSchema>

// task-senior-settle-owner: paying a senior IOU now mirrors the SALARY pay flow —
// the ADMIN/ACCOUNTANT chooses, AT PAY TIME, which account funds the payout and
// (for an admin-personal payout) which admin partner actually paid. This is the
// SAME contract as paySalarySchema (DRY — same funding enum + same
// COMPANY_ACCOUNT→USDT refine), only the route shape differs.
//   - COMPANY_ACCOUNT → currency MUST be USDT (USDT-only account; refined here
//     and forced server-side); the money debits the shared company account
//     (advisory lock + balance gate). payerAdminId is irrelevant (sender =
//     company), so the closing SENIOR_INCOME carries fundingSource=COMPANY_ACCOUNT.
//   - ADMIN_PERSONAL → `payerAdminId` selects whose personal account paid
//     (validated server-side: must be an ADMIN); currency may be any of the enum.
//     The company account is NOT touched; the closing SENIOR_INCOME carries
//     senderId=payer + fundingSource=ADMIN_PERSONAL.
//
// task-remove-settle-currency (2026-07): the UI no longer lets the caller pick a
// currency — every senior/drop obligation is denominated in USDT (see
// transactions.service.ts createIous), and USD/USDT are treated 1:1 downstream
// (convertToBase), so the choice was purely cosmetic. `currency` is now OPTIONAL:
// when omitted the service defaults it to the obligation's own currency (always
// USDT in practice). It stays in the schema (not removed) so legacy/defensive
// callers (e2e fixtures, the BIZ-03 unit specs) that still send an explicit
// currency keep working byte-for-byte — see pending-settlement.service.ts.
export const settleSeniorPayoutSchema = z
  .object({
    // Reuse salaryFundingSourceSchema — the SAME COMPANY_ACCOUNT | ADMIN_PERSONAL
    // enum used by salary/expense/admin-income (DRY, single source of truth).
    fundingSource: salaryFundingSourceSchema,
    // For ADMIN_PERSONAL — whose personal account funds this payout. Must be an
    // ADMIN (validated server-side). Ignored for COMPANY_ACCOUNT.
    payerAdminId: z.string().uuid().optional(),
    // Optional (task-remove-settle-currency) — see comment above.
    currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']).optional(),
    // task-drop-payout-currency (owner addendum, 2026-08): the DATE the
    // operator is recording this settlement as of — for a DROP settle, this
    // is BOTH the day whose NBU rate is used to compute the paid amount AND
    // the value written to the flipped row's `txDate` (see the extended
    // comment in pending-settlement.service.ts). Defaults client-side to the
    // obligation's own creation date, but the field itself is optional here
    // (not required by the schema) so every EXISTING caller that never sends
    // one (the legacy route, e2e fixtures, unit specs, and every SENIOR
    // settle — the picker is DROP-only in the UI) keeps working byte-for-
    // byte: the service falls back to "now", the pre-existing behaviour.
    // Strict calendar validation comes from the shared financial-date schema.
    // This NBU-priced flow additionally forbids future dates below. The LOWER
    // bound (not before the obligation existed) needs row context and stays in
    // the service.
    txDate: transactionBusinessDateSchema.optional().nullable(),
    // task-receipts-backend (#10): closing a senior/drop IOU now requires proof.
    // Effective currency = USDT for COMPANY_ACCOUNT (USDT-only) or when `currency`
    // is omitted (task-remove-settle-currency default) → explorer-only; else the
    // explicitly chosen currency → file/url.
    ...receiptFields,
  })
  // Reuse the shared COMPANY_ACCOUNT→USDT guard (same rule as pay-salary /
  // create-salary / expense / admin-income): a company-account payout is USDT-only.
  .superRefine(refineCompanyAccountUsdt)
  .superRefine(
    mandatoryReceiptRefine((d) =>
      d.fundingSource === 'COMPANY_ACCOUNT' ? 'USDT' : (d.currency ?? 'USDT'),
    ),
  )
  .superRefine((data, ctx) => {
    // Stryker disable next-line ConditionalExpression: equivalent mutant - txDate null, undefined or '' compared with > against a YYYY-MM-DD string is already false, so the early return is redundant
    if (!data.txDate) return
    if (data.txDate > kyivToday()) {
      ctx.addIssue({
        code: 'custom',
        path: ['txDate'],
        message: 'zod.DATE_NOT_IN_FUTURE',
      })
    }
  })
export type SettleSeniorPayoutDto = z.infer<typeof settleSeniorPayoutSchema>

// Response after a successful settle: returns the updated obligation snapshot
// plus the new SENIOR_PAID transaction. Frontend uses this to invalidate
// balances / pending lists in one round-trip.
export const settleObligationResponseSchema = z.object({
  obligation: pendingObligationSchema,
  created: z.array(transactionSchema),
})
export type SettleObligationResponseDto = z.infer<typeof settleObligationResponseSchema>
