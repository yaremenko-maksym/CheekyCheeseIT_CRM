import { z } from 'zod'
import { mySalaryStatusSchema } from './interviews'

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const transactionTypeSchema = z.enum([
  'ADMIN_INCOME', // Admin income from own project — no validation needed
  'SENIOR_INCOME', // Senior income — requires accountant/admin validation
  'EXPENSE', // Company expense (receiverLabel = category)
  'SALARY', // Salary to HR/ACCOUNTANT/JUNIOR
  'ADMIN_TRANSFER', // Balance equalization between Maksym and Kostya
  'PAYOUT', // Senior pays CheekyCheeseIT (linked to payout_request)
  'PAYOUT_ADMIN', // Auto-created 50/50 split to each admin after payout
  // Drop role - phase 2. DROP receives project income through their account
  // and is the financial pass-through for the senior. These mirror
  // SENIOR_INCOME/PAYOUT but live in their own type so the senior path stays
  // 1:1 with pre-phase-2 behavior. See drop-role-and-finance-spec.md §8.1.
  'DROP_INCOME', // Drop income from project — requires accountant/admin validation
  'PAYOUT_DROP', // Auto-created drop share after payPayoutRequest on a drop-project
  // Drop role - phase 3. Manual payout confirmation (spec §8.4): ACCOUNTANT/ADMIN
  // confirms that an off-platform PAYOUT actually landed on a specific admin
  // partner. Distinct from PAYOUT_ADMIN (which is the automated 50/50 split
  // from payPayoutRequest) so the manual safety-net flow stays separable from
  // the auto-distribution in reports / filters / balance attribution. See
  // drop-role-and-finance-spec.md §8.4 and migration 0022.
  'PAYOUT_CONFIRMED',
  // Drop role - phase 4-A (spec). New balance infrastructure types — used by
  // the BalanceService computed-on-demand balance pipeline. Migration 0023 adds
  // these enum values. They DO NOT replace the legacy summary computed by
  // TransactionsService.getSummary; the new BalanceService runs in parallel.
  //
  // TOV_INCOME           — money lands on the corporate (ТОВ) account.
  // SENIOR_PENDING_PAYOUT — TOВ owes a senior; obligation row in pending_obligations.
  //                         Does NOT move the senior's balance until closed.
  // SENIOR_PAID          — closes a pending obligation; credits the senior's
  //                         real balance; links to the pending_obligation row.
  // ADMIN_INCOME_CASH    — admin personally received cash for a project.
  // ADMIN_INCOME_CRYPTO  — admin personally received USDT on crypto wallet.
  // SENIOR_INCOME_CRYPTO — senior personally received USDT on crypto wallet.
  // DIVIDEND_TO_ADMIN    — distribution from TOВ → admin balance (50/50 to each).
  // DIVIDEND_TAX         — 6.5% tax on dividends; debits TOВ balance only.
  'TOV_INCOME',
  'SENIOR_PENDING_PAYOUT',
  'SENIOR_PAID',
  'ADMIN_INCOME_CASH',
  'ADMIN_INCOME_CRYPTO',
  'SENIOR_INCOME_CRYPTO',
  'DIVIDEND_TO_ADMIN',
  'DIVIDEND_TAX',
  // task-company-account-backend. A SENIOR/DROP-submitted USDT deposit onto the
  // shared company wallet (Etherscan-verified). PENDING until confirmations
  // reach the threshold AND the recipient matches the company wallet, then PAID.
  // Credits the company account balance once PAID.
  'COMPANY_DEPOSIT',
])
export type TransactionType = z.infer<typeof transactionTypeSchema>

export const transactionStatusSchema = z.enum([
  'PENDING', // Awaiting action
  'VALIDATED', // Accountant/admin confirmed
  'PENDING_PAYMENT', // Senior created payout request, awaiting payment
  'REJECTED', // Accountant/admin rejected; senior must edit and resubmit
  'PAID', // Completed
  'LOCKED', // Junior salary locked until senior has validated income
  // Drop role - phase 4-B round 2 (DEPRECATED in Phase 4 refactor).
  // Status value left in the enum so historical rows that may carry it can
  // still be loaded. NEW rows MUST NOT set this status — the bank/cash drop
  // initiation flows that produced it have been removed (refactor task
  // task-drop-phase4-refactor-remove-tov.md, AC2).
  'PENDING_CASH_CONFIRM',
])
export type TransactionStatus = z.infer<typeof transactionStatusSchema>

export const payoutRequestStatusSchema = z.enum(['PENDING', 'PAID'])
export type PayoutRequestStatus = z.infer<typeof payoutRequestStatusSchema>

// ---------------------------------------------------------------------------
// Transaction DTO
// ---------------------------------------------------------------------------

/**
 * Where the snapshotted `seniorSharePercent` on a transaction came from at
 * SENIOR_INCOME / DROP_INCOME creation time. Drives the source badge on
 * TransactionRow / TransactionDetailDialog / PayoutDialog / MyProjectShares.
 *
 * Hierarchy (highest priority first):
 *   - `'PROJECT'`      — `projects.seniorSharePercentOverride` was set.
 *   - `'TEAM'`         — `teams.seniorSharePercentOverride` was set (new in
 *                        task-team-senior-share-override).
 *   - `'USER_DEFAULT'` — fell back to `users.seniorSharePercent`.
 *
 * Nullable to keep legacy transactions (created before the source column
 * existed) renderable as-is — the UI shows "—" / hides the badge.
 */
export const seniorSharePercentSourceSchema = z.enum(['PROJECT', 'TEAM', 'USER_DEFAULT'])
export type SeniorSharePercentSource = z.infer<typeof seniorSharePercentSourceSchema>

export const transactionSchema = z.object({
  id: z.string().uuid(),
  type: transactionTypeSchema,
  status: transactionStatusSchema,
  amount: z.string(), // numeric string from DB
  currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
  senderId: z.string().uuid().nullable(),
  senderLabel: z.string().nullable(),
  senderName: z.string().nullable(), // resolved from user if senderId set
  receiverId: z.string().uuid().nullable(),
  receiverLabel: z.string().nullable(),
  receiverName: z.string().nullable(), // resolved from user if receiverId set
  projectId: z.string().uuid().nullable(),
  projectName: z.string().nullable(),
  payoutRequestId: z.string().uuid().nullable(),
  payoutRequest: z
    .object({
      seniorId: z.string(),
      incomeAmount: z.string(),
      payableAmount: z.string(),
      seniorSharePercent: z.number().nullable(),
      seniorSharePercentSource: seniorSharePercentSourceSchema.nullable().optional(),
    })
    .nullable()
    .optional(),
  seniorSharePercent: z.number().nullable(),
  /**
   * Snapshot source for `seniorSharePercent` — set at creation time, never
   * mutated. Nullable for legacy rows (transactions created before the
   * column existed). See `seniorSharePercentSourceSchema`.
   */
  seniorSharePercentSource: seniorSharePercentSourceSchema.nullable().optional(),
  // Receipt: either a documents.id reference (uploaded RECEIPT file) OR an
  // external URL (etherscan, screenshot link). Mutually exclusive — the
  // backend enforces a row-level CHECK constraint. Both null = no receipt.
  // Security: receiptExternalUrl is scheme-restricted to http(s) only — .url()
  // alone allows javascript:/data: URIs in some runtimes; the refine enforces
  // an explicit allow-list. DB audit confirmed all 91 existing non-null values
  // are valid HTTP(S) URLs — no data loss from hardening.
  // MED-2 fix: ^https?:// refine on read-DTO blocks javascript:/data: XSS.
  receiptDocumentId: z.string().uuid().nullable(),
  receiptExternalUrl: z
    .string()
    .url()
    .refine((v) => /^https?:\/\//i.test(v), {
      message: 'Receipt URL must use http or https scheme',
    })
    .nullable(),
  txHash: z.string().nullable(),
  validatedBy: z.string().uuid().nullable(),
  validatedAt: z.string().datetime().nullable(),
  rejectionReason: z.string().nullable(),
  notes: z.string().nullable(),
  salaryMonth: z.string().nullable(), // YYYY-MM
  txDate: z.string().datetime().nullable(),
  // Drop role - phase 2. Optional, nullable explicit recipient pointer for
  // transactions whose intended payee is NOT the senior on the row (e.g.
  // PAYOUT_DROP whose receiverId is the DROP user). Existing types
  // (SENIOR_INCOME, PAYOUT, …) keep their semantics — recipientId is set
  // alongside receiverId only for the new PAYOUT_DROP path. Adding it as
  // optional + nullable keeps the existing client contract compatible.
  recipientId: z.string().uuid().nullable().optional(),
  createdBy: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type TransactionDto = z.infer<typeof transactionSchema>

// ---------------------------------------------------------------------------
// Payout Request DTO
// ---------------------------------------------------------------------------

export const payoutRequestSchema = z.object({
  id: z.string().uuid(),
  seniorId: z.string().uuid(),
  seniorName: z.string(),
  incomeAmount: z.string(),
  payableAmount: z.string(),
  // Destination wallet = the COMPANY USDT wallet (Phase 8 v2). The
  // `contract_address` column is reused as the recipient address (schema not
  // broken): SENIOR/DROP copies it and sends `payable_amount` USDT to the
  // company wallet, then submits the on-chain txHash for Etherscan
  // verification. payableAmount is always USDT (cross-currency company-shares
  // are converted to USDT at create time — see createPayoutRequest).
  contractAddress: z.string(),
  txHash: z.string().nullable(),
  status: payoutRequestStatusSchema,
  transactions: z.array(transactionSchema).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type PayoutRequestDto = z.infer<typeof payoutRequestSchema>

// ---------------------------------------------------------------------------
// Project Finance Settings DTO
// ---------------------------------------------------------------------------

export const projectFinanceSettingsSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  seniorSharePercentOverride: z.number().int().min(0).max(100).nullable(),
  juniorSalaryOverride: z.string().nullable(),
  updatedBy: z.string().uuid().nullable(),
  updatedAt: z.string().datetime(),
})
export type ProjectFinanceSettingsDto = z.infer<typeof projectFinanceSettingsSchema>

// ---------------------------------------------------------------------------
// Create / Update schemas
// ---------------------------------------------------------------------------

/**
 * Receipt payload — uploaded document FK XOR external URL.
 *
 * The transactions table enforces this exclusivity at the DB level with a
 * row-level CHECK constraint (`receipt_document_id IS NULL OR
 * receipt_external_url IS NULL`). We mirror that contract here so callers
 * get a human-readable Zod error instead of a 500 from postgres.
 *
 * Both fields are optional + nullable so the same shape can be reused for
 * Create (where the caller may omit receipt entirely) and Patch (where
 * undefined = "leave unchanged" and null = "clear field").
 *
 * MED-2 fix: receiptExternalUrl is scheme-restricted to http(s) only via an
 * explicit refine on top of .url() — blocks javascript:/data: XSS vectors
 * that .url() alone does not reject in all Zod versions.
 */
const receiptFields = {
  receiptDocumentId: z.string().uuid().optional().nullable(),
  receiptExternalUrl: z
    .string()
    .url()
    .refine((v) => /^https?:\/\//i.test(v), {
      message: 'Receipt URL must use http or https scheme',
    })
    .optional()
    .nullable(),
}

const receiptXor = (data: {
  receiptDocumentId?: string | null | undefined
  receiptExternalUrl?: string | null | undefined
}) => !(data.receiptDocumentId && data.receiptExternalUrl)

const receiptXorMessage = {
  message: 'Receipt must be either a document upload OR an external URL — not both',
  path: ['receiptExternalUrl'],
}

// task-company-account-backend / task-salary-company-account. Where a money
// movement is funded from:
//   - COMPANY_ACCOUNT — paid out of (SALARY/EXPENSE) or into (ADMIN_INCOME) the
//     shared company USDT account. Currency is forced to USDT server-side
//     regardless of input; the company balance gate applies for outflows.
//   - ADMIN_PERSONAL  — paid from an admin partner's personal account (Maksym or
//     Kostya). `payerAdminId` chooses whose account; currency may be USDT/UAH.
//     (SALARY-only — EXPENSE/ADMIN_INCOME use the enum solely for COMPANY_ACCOUNT.)
// Optional to keep the contract backward-compatible with callers that do not
// yet send a funding source. NOTE (task-salary-company-account): for SALARY the
// service now defaults an ABSENT fundingSource to COMPANY_ACCOUNT (was
// ADMIN_PERSONAL). For EXPENSE/ADMIN_INCOME absent → legacy behaviour (no
// company routing). See company-account-spec.md.
export const salaryFundingSourceSchema = z.enum(['COMPANY_ACCOUNT', 'ADMIN_PERSONAL'])
export type SalaryFundingSource = z.infer<typeof salaryFundingSourceSchema>

// Shared superRefine guard: when fundingSource = COMPANY_ACCOUNT an explicit
// non-USDT currency is a client bug (company account is USDT-only). The service
// also forces USDT, but surfacing the contradiction early gives a clear error.
// Extracted so SALARY / EXPENSE / ADMIN_INCOME schemas stay byte-for-byte
// consistent (DRY — single rule, no drift).
function refineCompanyAccountUsdt(
  data: { fundingSource?: 'COMPANY_ACCOUNT' | 'ADMIN_PERSONAL' | undefined; currency?: string },
  ctx: z.RefinementCtx,
): void {
  if (
    data.fundingSource === 'COMPANY_ACCOUNT' &&
    data.currency !== undefined &&
    data.currency !== 'USDT'
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Операция со счёта компании проводится только в USDT',
      path: ['currency'],
    })
  }
}

// ADMIN_INCOME — admin declares project income, no validation needed.
// task-salary-company-account: optional `fundingSource` — when COMPANY_ACCOUNT
// the income is directed INTO the shared company USDT account (credits its
// balance) instead of the admin's personal balance. Currency forced to USDT.
export const createAdminIncomeSchema = z
  .object({
    projectId: z.string().uuid(),
    amount: z.number().positive().max(500_000), // BIZ-13: reasonable ceiling
    currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
    ...receiptFields,
    notes: z.string().max(1000).optional().nullable(),
    txDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .nullable(),
    // Reuse salaryFundingSourceSchema — only COMPANY_ACCOUNT is meaningful here
    // (ADMIN_PERSONAL is implicit/legacy when absent). Optional → legacy path.
    fundingSource: salaryFundingSourceSchema.optional(),
  })
  .refine(receiptXor, receiptXorMessage)
  .superRefine(refineCompanyAccountUsdt)
export type CreateAdminIncomeDto = z.infer<typeof createAdminIncomeSchema>

// SENIOR_INCOME — senior registers project income, awaits validation
export const createSeniorIncomeSchema = z
  .object({
    projectId: z.string().uuid(),
    amount: z.number().positive().max(500_000), // BIZ-13: reasonable ceiling
    currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
    ...receiptFields,
    notes: z.string().max(1000).optional().nullable(),
    txDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .nullable(),
  })
  .refine(receiptXor, receiptXorMessage)
export type CreateSeniorIncomeDto = z.infer<typeof createSeniorIncomeSchema>

// DROP_INCOME — drop registers project income on a drop-project, awaits
// validation. Mirror of createSeniorIncomeSchema field-for-field so the
// frontend can reuse the same form. Drop role - phase 2.
// Constraint enforced server-side: project.dropId must equal the caller's id.
export const createDropIncomeSchema = z
  .object({
    projectId: z.string().uuid(),
    amount: z.number().positive().max(500_000), // BIZ-13: reasonable ceiling
    currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
    ...receiptFields,
    notes: z.string().max(1000).optional().nullable(),
    txDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .nullable(),
  })
  .refine(receiptXor, receiptXorMessage)
export type CreateDropIncomeDto = z.infer<typeof createDropIncomeSchema>

// Update REJECTED senior income (resets to PENDING)
export const updateSeniorIncomeSchema = z
  .object({
    amount: z.number().positive().max(500_000).optional(), // BIZ-13: reasonable ceiling
    currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']).optional(),
    ...receiptFields,
    notes: z.string().max(1000).optional().nullable(),
  })
  .refine(receiptXor, receiptXorMessage)
export type UpdateSeniorIncomeDto = z.infer<typeof updateSeniorIncomeSchema>

// BIZ-17: Update REJECTED drop income (resets to PENDING for re-validation).
// Parallel to updateSeniorIncomeSchema — DROP role resubmission path.
export const updateDropIncomeSchema = z
  .object({
    amount: z.number().positive().max(500_000).optional(), // BIZ-13: reasonable ceiling
    currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']).optional(),
    ...receiptFields,
    notes: z.string().max(1000).optional().nullable(),
  })
  .refine(receiptXor, receiptXorMessage)
export type UpdateDropIncomeDto = z.infer<typeof updateDropIncomeSchema>

// EXPENSE — admin declares a company expense.
// task-salary-company-account: optional `fundingSource` — when COMPANY_ACCOUNT
// the expense is paid OUT of the shared company USDT account (debits its
// balance, gated by available funds). Currency forced to USDT. Absent → legacy.
export const createExpenseSchema = z
  .object({
    amount: z.number().positive().max(500_000), // BIZ-13: reasonable ceiling
    currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
    category: z.string().min(1).max(255),
    notes: z.string().max(1000).optional().nullable(),
    ...receiptFields,
    txDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .nullable(),
    // Reuse salaryFundingSourceSchema — only COMPANY_ACCOUNT is meaningful here.
    // Optional → legacy expense (no company routing, no balance impact).
    fundingSource: salaryFundingSourceSchema.optional(),
  })
  .refine(receiptXor, receiptXorMessage)
  .superRefine(refineCompanyAccountUsdt)
export type CreateExpenseDto = z.infer<typeof createExpenseSchema>

// SALARY — admin/accountant creates a salary transaction for eligible roles.
// task-salary-pay-flow: a manually-created salary is a NEUTRAL PENDING reminder
// — NO funding source and NO currency-lock at creation. The funding source
// (company account vs admin personal) and the actual payment currency are chosen
// later, at pay time, via paySalary (see paySalarySchema). `currency` here is the
// nominal of the reminder (default USD); it is overridden by the pay-time choice.
export const createSalarySchema = z.object({
  receiverId: z.string().uuid(),
  amount: z.number().positive().max(500_000), // BIZ-13: reasonable ceiling
  currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']).default('USD'),
  salaryMonth: z.string().regex(/^\d{4}-\d{2}$/, 'Format YYYY-MM'),
  notes: z.string().max(1000).optional().nullable(),
  txDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
})
export type CreateSalaryDto = z.infer<typeof createSalarySchema>

// ADMIN_TRANSFER — balance equalization between Maksym and Kostya
export const createAdminTransferSchema = z.object({
  senderId: z.string().uuid().optional(),
  receiverId: z.string().uuid(),
  amount: z.number().positive().max(500_000), // BIZ-13: reasonable ceiling
  currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']).default('USDT'),
  notes: z.string().max(1000).optional().nullable(),
  txDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
})
export type CreateAdminTransferDto = z.infer<typeof createAdminTransferSchema>

// Validate or reject SENIOR_INCOME
export const validateTransactionSchema = z.object({
  action: z.enum(['validate', 'reject']),
  rejectionReason: z.string().max(500).optional().nullable(),
})
export type ValidateTransactionDto = z.infer<typeof validateTransactionSchema>

// Create payout request (senior bundles their VALIDATED incomes)
export const createPayoutRequestSchema = z.object({
  transactionIds: z.array(z.string().uuid()).min(1),
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
  })
  .superRefine((data, ctx) => {
    if (data.simulateResult === undefined) {
      const trimmed = data.txHash?.trim() ?? ''
      if (trimmed.length < 10) {
        ctx.addIssue({
          code: 'custom',
          message: 'txHash должен содержать минимум 10 символов',
          path: ['txHash'],
        })
      }
    }
  })
export type PayPayoutRequestDto = z.infer<typeof payPayoutRequestSchema>

// ---------------------------------------------------------------------------
// Manual payout confirmation (Phase 8 v2) — ADMIN/ACCOUNTANT only.
// ---------------------------------------------------------------------------
//
// Escape hatch for when a payout was settled OFF the on-chain happy path:
//   - COMPANY_ACCOUNT — the senior/drop did send USDT to the company wallet but
//     on-chain verification is unavailable (no Etherscan key / link); ADMIN
//     vouches for it. CREDITS the company account (same effect as a verified
//     on-chain confirm).
//   - ADMIN_USDT — the money was sent to an admin's PERSONAL USDT wallet
//     instead of the company wallet. Does NOT credit the company account.
//   - CASH — settled in fiat/cash off-platform. Does NOT credit the company
//     account.
// The chosen `method` is persisted on the PAYOUT row (audit) and decides
// whether the company balance moves (see manualConfirmPayout in
// transactions.service). RBAC: ADMIN/ACCOUNTANT only (enforced server-side).
export const manualPayoutMethodSchema = z.enum(['CASH', 'ADMIN_USDT', 'COMPANY_ACCOUNT'])
export type ManualPayoutMethod = z.infer<typeof manualPayoutMethodSchema>

export const manualConfirmPayoutSchema = z.object({
  method: manualPayoutMethodSchema,
  note: z.string().max(1000).optional().nullable(),
  txHash: z.string().max(255).optional().nullable(),
})
export type ManualConfirmPayoutDto = z.infer<typeof manualConfirmPayoutSchema>

// Update project finance settings (ADMIN/ACCOUNTANT)
export const updateProjectFinanceSettingsSchema = z.object({
  seniorSharePercentOverride: z.number().int().min(0).max(100).nullable().optional(),
  juniorSalaryOverride: z.number().nonnegative().max(500_000).nullable().optional(), // BIZ-14
})
export type UpdateProjectFinanceSettingsDto = z.infer<typeof updateProjectFinanceSettingsSchema>

// Admin edit any transaction (ADMIN only, blocks PAYOUT/PAYOUT_ADMIN on backend)
export const adminUpdateTransactionSchema = z
  .object({
    amount: z.number().positive().max(500_000).optional(), // BIZ-13: reasonable ceiling
    currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']).optional(),
    notes: z.string().max(1000).optional().nullable(),
    ...receiptFields,
    category: z.string().min(1).max(255).optional(),
    salaryMonth: z
      .string()
      .regex(/^\d{4}-\d{2}$/, 'Format YYYY-MM')
      .optional(),
  })
  .refine(receiptXor, receiptXorMessage)
export type AdminUpdateTransactionDto = z.infer<typeof adminUpdateTransactionSchema>

// Mark PENDING salary as PAID (admin pays it manually).
// task-salary-pay-flow: the funding source + currency are chosen HERE (at pay
// time), not at creation. A salary row is created as a neutral PENDING reminder
// (fundingSource=null, USD nominal); the ADMIN decides at payment whether it
// comes from the shared company USDT account (COMPANY_ACCOUNT) or an admin
// partner's personal account (ADMIN_PERSONAL), and in which currency.
//   - COMPANY_ACCOUNT → currency MUST be USDT (USDT-only account; refined below
//     and forced server-side); payerAdminId is irrelevant (sender = company).
//   - ADMIN_PERSONAL  → `payerAdminId` selects whose personal account pays
//     (validated server-side: must be an ADMIN); currency may be any of the
//     enum. The amount is NOT converted — only the currency LABEL changes.
export const paySalarySchema = z
  .object({
    // Reuse salaryFundingSourceSchema — the SAME COMPANY_ACCOUNT | ADMIN_PERSONAL
    // enum used by salary/expense/admin-income (DRY, single source of truth).
    fundingSource: salaryFundingSourceSchema,
    // For ADMIN_PERSONAL — whose personal account funds this payment. Must be an
    // ADMIN (validated server-side). Ignored for COMPANY_ACCOUNT.
    payerAdminId: z.string().uuid().optional(),
    currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
    txHash: z.string().max(255).optional().nullable(),
    notes: z.string().max(1000).optional().nullable(),
  })
  // Reuse the shared COMPANY_ACCOUNT→USDT guard (same rule as create-salary /
  // expense / admin-income): a company-account payout is USDT-only.
  .superRefine(refineCompanyAccountUsdt)
export type PaySalaryDto = z.infer<typeof paySalarySchema>

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
  })
  .superRefine((data, ctx) => {
    if (data.method === 'CRYPTO') {
      const trimmed = data.txHash?.trim() ?? ''
      if (trimmed.length < 10) {
        ctx.addIssue({
          code: 'custom',
          message: 'txHash должен содержать минимум 10 символов',
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
// assertCanReadTotalEarned). Surfaced on the «Финансы» tab of an employee
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

// settle-drop endpoint takes an empty body — the obligation id is in the URL.
// The route param `:id` is validated as UUID-like (same permissive shape as
// payment-channel ids) since seeded users carry version-nibble 0 in their UUIDs.
export const settleObligationParamSchema = z.object({
  id: z.string().regex(UUID_LIKE_REGEX, 'Invalid UUID'),
})
export type SettleObligationParamDto = z.infer<typeof settleObligationParamSchema>

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
export const settleSeniorPayoutSchema = z
  .object({
    // Reuse salaryFundingSourceSchema — the SAME COMPANY_ACCOUNT | ADMIN_PERSONAL
    // enum used by salary/expense/admin-income (DRY, single source of truth).
    fundingSource: salaryFundingSourceSchema,
    // For ADMIN_PERSONAL — whose personal account funds this payout. Must be an
    // ADMIN (validated server-side). Ignored for COMPANY_ACCOUNT.
    payerAdminId: z.string().uuid().optional(),
    currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
  })
  // Reuse the shared COMPANY_ACCOUNT→USDT guard (same rule as pay-salary /
  // create-salary / expense / admin-income): a company-account payout is USDT-only.
  .superRefine(refineCompanyAccountUsdt)
export type SettleSeniorPayoutDto = z.infer<typeof settleSeniorPayoutSchema>

// Response after a successful settle: returns the updated obligation snapshot
// plus the new SENIOR_PAID transaction. Frontend uses this to invalidate
// balances / pending lists in one round-trip.
export const settleObligationResponseSchema = z.object({
  obligation: pendingObligationSchema,
  created: z.array(transactionSchema),
})
export type SettleObligationResponseDto = z.infer<typeof settleObligationResponseSchema>

// ---------------------------------------------------------------------------
// Drop role - phase 1 (task-drop-1-backend). Self-only DROP summary.
// ---------------------------------------------------------------------------
//
// Returned by `GET /api/finance/drop/me/summary` — DROP-only (every other role
// gets 403). This is the drop-facing slice of the admin/accountant
// `financeSummarySchema.dropBalances` aggregate, computed ONLY for the
// authenticated drop. It NEVER carries any other drop's figures.
//
// Fields:
//   - balance              — accrued drop share: Σ PAYOUT_DROP received − sent
//                            (the slice the drop keeps; same math as
//                            dropBalances[].balance in getSummary).
//   - dropSharePercent     — the drop's configured share % (?? default 5).
//   - pendingIncomesCount  — DROP_INCOME rows for this drop still in
//                            PENDING|VALIDATED status (= dropBalances[].pendingCount).
//   - debtToCompany        — amount the drop still owes the company for
//                            VALIDATED-but-unsettled incomes. Formula (see
//                            transactions.service `computeDropAggregate`):
//                            Σ over PAYOUT rows where senderId = drop AND
//                            status = 'PENDING_PAYMENT' of `amount`
//                            (= income × (1 − dropSharePercent/100) per income,
//                            booked at validation, cleared on company payment).
export const dropSelfSummarySchema = z.object({
  balance: z.number(),
  dropSharePercent: z.number().int().min(0).max(100),
  pendingIncomesCount: z.number().int().min(0),
  debtToCompany: z.number(),
})
export type DropSelfSummaryDto = z.infer<typeof dropSelfSummarySchema>

// ── Drop self-view DTOs (Drop role - phase 2, task-drop-2-backend) ──────────
//
// Three read-only, DROP-only data contracts consumed by the drop «Мой роутинг»
// hub + finance cabinet (design spec docs/design/drop-role-ux.md §10). Every
// endpoint behind them is self-scoped (drop sees only their own rows); these
// schemas only describe the wire shape — RBAC lives in the service.

/**
 * Drop income status — the four states the FE renders for a DROP_INCOME row.
 * Derived from the DB `transaction_status` enum (PENDING|VALIDATED|PAID|REJECTED);
 * the other DB statuses (PENDING_PAYMENT / LOCKED / PENDING_CASH_CONFIRM) never
 * apply to a DROP_INCOME income row, so they are intentionally excluded here.
 */
export const dropIncomeStatusSchema = z.enum(['pending', 'validated', 'paid', 'rejected'])
export type DropIncomeStatus = z.infer<typeof dropIncomeStatusSchema>

// GET /api/finance/drop/me/incomes — one row of the drop's income feed.
// `companyName` is the client company that paid (sourced from the income's
// senderLabel / project.companyName). `amount` is the gross income before the
// drop's share is split out.
export const dropIncomeDtoSchema = z.object({
  id: z.string().uuid(),
  companyName: z.string(),
  amount: z.number(),
  currency: z.string(),
  createdAt: z.string(), // ISO date
  status: dropIncomeStatusSchema,
})
export type DropIncomeDto = z.infer<typeof dropIncomeDtoSchema>

// Paginated envelope for the incomes feed. Mirrors the established
// `auditLogListSchema` shape (items + total + page + limit). `total` is the
// count BEFORE pagination so the FE can render «N приходов» and page controls.
export const paginatedDropIncomesSchema = z.object({
  items: z.array(dropIncomeDtoSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
})
export type PaginatedDropIncomes = z.infer<typeof paginatedDropIncomesSchema>

// Query filters for GET /api/finance/drop/me/incomes. All optional; status/type
// narrow the feed, from/to bound the createdAt window (ISO date strings), and
// page/limit drive pagination (defaults 1 / 20). `type` currently only accepts
// DROP_INCOME (the sole income type a drop owns) but is kept as a filter for
// forward-compatibility and to mirror the FE filter UI.
export const dropIncomesQuerySchema = z.object({
  status: dropIncomeStatusSchema.optional(),
  // forward-compat: type is not used in WHERE (only DROP_INCOME rows are ever
  // returned for a drop), but kept as an explicit filter field so the FE can
  // pass it without errors and future income types can narrow without a schema
  // change. LOW review finding — intentionally NOT removed.
  type: z.literal('DROP_INCOME').optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
})
export type DropIncomesQuery = z.infer<typeof dropIncomesQuerySchema>

// GET /api/projects/drop/me — drop-project with its income aggregate.
// `seniorDisplayName` is the senior's REAL display name (the drop coordinates
// directly with the senior — NOT masked, unlike the JUNIOR legend persona).
// `incomesCount` = number of DROP_INCOME rows the drop owns on this project.
// `status` maps project archival: active = not archived, closed = archived.
export const dropProjectDtoSchema = z.object({
  id: z.string().uuid(),
  companyName: z.string(),
  seniorDisplayName: z.string(),
  incomesCount: z.number().int().nonnegative(),
  status: z.enum(['active', 'closed']),
})
export type DropProjectDto = z.infer<typeof dropProjectDtoSchema>

/**
 * Drop payment status — the three states the FE renders for an outgoing
 * PAYOUT (drop → company). Derived from the DB `transaction_status` enum:
 * PENDING_PAYMENT → pending, PAID → confirmed, REJECTED → failed.
 */
export const dropPaymentStatusSchema = z.enum(['pending', 'confirmed', 'failed'])
export type DropPaymentStatus = z.infer<typeof dropPaymentStatusSchema>

// GET /api/finance/drop/me/payments — one outgoing payment (drop → company).
// `txHash` present only for crypto payments; omitted otherwise.
export const dropPaymentDtoSchema = z.object({
  id: z.string().uuid(),
  amount: z.number(),
  currency: z.string(),
  txHash: z.string().optional(),
  status: dropPaymentStatusSchema,
  createdAt: z.string(), // ISO date
})
export type DropPaymentDto = z.infer<typeof dropPaymentDtoSchema>

export const financeSummarySchema = z.object({
  totalIncome: z.number(),
  totalExpenses: z.number(),
  totalSalaries: z.number(),
  netBalance: z.number(),
  adminBalances: z.array(
    z.object({
      userId: z.string().uuid(),
      displayName: z.string(),
      balance: z.number(),
    }),
  ),
  // Drop role - phase 2. Aggregated PAYOUT_DROP credit minus debit per DROP
  // user — surfaced on the DROP user's profile / finance overview. Empty array
  // when there are no DROP users in the system. Existing UIs that ignore this
  // field stay unaffected.
  //
  // Redesign (feat/drop-balances-panel):
  //   dropSharePercent — always a number; backend applies ?? DEFAULT_DROP_SHARE_PERCENT
  //                      before returning, so null never reaches the client.
  //   pendingCount     — number of DROP_INCOME rows in PENDING|VALIDATED
  //                      status for this drop. Used by the «N ожидают» badge.
  dropBalances: z
    .array(
      z.object({
        userId: z.string().uuid(),
        displayName: z.string(),
        balance: z.number(),
        dropSharePercent: z.number().int().min(0).max(100),
        pendingCount: z.number().int().min(0),
      }),
    )
    .default([]),
  monthly: z.array(
    z.object({
      month: z.string(),
      income: z.number(),
      expenses: z.number(),
      salaries: z.number(),
      profit: z.number(),
    }),
  ),
})
export type FinanceSummaryDto = z.infer<typeof financeSummarySchema>

// ---------------------------------------------------------------------------
// Accountant summary DTO (ACCOUNTANT Sprint 1)
// ---------------------------------------------------------------------------
//
// KPI snapshot for the ACCOUNTANT финансовый хаб-дашборд (and ADMIN, who sees
// the same financial scope). Surfaced by GET /api/finance/accountant-summary —
// RBAC: ACCOUNTANT + ADMIN only; every other role gets 403 (the endpoint would
// otherwise leak company-wide payment-validation figures).
//
// Все суммы — USD-эквивалент (numeric → JS number, scaled-integer accumulation
// in the service to avoid float drift). Counts — целые неотрицательные.
//
// Fields:
//   pendingValidation   — income rows (SENIOR_INCOME + DROP_INCOME) still in
//                         PENDING status, i.e. awaiting accountant validation.
//                         { count, amount }.
//   validatedThisMonth  — rows the accountant VALIDATED in the current calendar
//                         month (by `validatedAt`). { count, amount }.
//   paidThisMonth       — income/payout money settled (status PAID) whose
//                         `createdAt` falls in the current month. { amount }.
//   recipientCount      — number of distinct income parties (seniors / drops)
//                         whose finances the accountant oversees.
export const accountantSummarySchema = z.object({
  pendingValidation: z.object({
    count: z.number().int().nonnegative(),
    amount: z.number(),
  }),
  validatedThisMonth: z.object({
    count: z.number().int().nonnegative(),
    amount: z.number(),
  }),
  paidThisMonth: z.object({
    amount: z.number(),
  }),
  recipientCount: z.number().int().nonnegative(),
})
export type AccountantSummaryDto = z.infer<typeof accountantSummarySchema>

// ---------------------------------------------------------------------------
// Senior summary DTO (SENIOR dashboard / senior хаб-дашборд)
// ---------------------------------------------------------------------------
//
// KPI snapshot for the SENIOR ролевой дашборд (and ADMIN, for debugging — they
// see the SAME self-scoped figures the SENIOR they impersonate would see; the
// endpoint is STRICTLY scoped to currentUser.id, so a senior can NEVER read
// another senior's projects / income / payouts). Surfaced by
// GET /api/finance/senior-summary — RBAC: SENIOR + ADMIN only; every other role
// (JUNIOR / HR / ACCOUNTANT / DROP) gets 403.
//
// Content chosen by USER (only this — no «команда» / «собеседования»):
//   1. «Мои проекты + доход»  → activeProjects + seniorShareIncome.
//   2. «Статус моих выплат»    → pendingPayouts + mySalaryStatus.
//
// Fields:
//   activeProjects     — the caller's OWN active (archivedAt IS NULL) senior-
//                        projects (seniorId === self), each with the effective
//                        senior share % resolved from the project override →
//                        user default. `count` is the list length (convenience
//                        for the KPI card).
//   seniorShareIncome  — the caller's senior SHARE of PAID SENIOR_INCOME on
//                        their own projects (amount * sharePercent/100), summed
//                        over all time (`total`) and the current calendar month
//                        (`thisMonth`, by `txDate ?? createdAt`). Mirrors the
//                        getTotalEarned SENIOR gate (PAID SENIOR_INCOME) but
//                        reports the senior's NET share, not the gross income.
//   pendingPayouts     — the caller's own `payout_requests` still in PENDING
//                        status. { count, amount } where amount = Σ payableAmount
//                        (what the senior still owes / is queued to settle).
//   mySalaryStatus     — the caller's OWN SALARY transaction for the current
//                        month (receiver = self), or null. Same shape/semantics
//                        as the HR dashboard's mySalaryStatus.
export const seniorActiveProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  companyName: z.string(),
  sharePercent: z.number().int().min(0).max(100),
})

// task-senior-stats-block — «Статистика заработка» block on the SENIOR dashboard.
// One `{ month, amount }` point per recent calendar month for the «Всего
// заработано» sparkline. `month` is the UTC `YYYY-MM` key (oldest → newest);
// `amount` is the senior's NET SHARE of PAID SENIOR_INCOME credited that month
// (same snapshot-share math as `seniorShareIncome` — reuses the same rows). A
// month with no income contributes a 0 point so the sparkline keeps a stable
// length / x-axis (no gaps).
export const seniorMonthlyEarningSchema = z.object({
  month: z.string(), // 'YYYY-MM' (UTC)
  amount: z.number(),
})

// task-senior-stats-block — «Статистика заработка». Self-scoped earnings stats
// surfaced ALONGSIDE the existing KPI fields (additive — every #234/#235 field
// is preserved). Intentionally carries NO money "expected" figure: the real
// arriving amount depends on each company's payment method / ФОП-tax handling /
// the junior's worked days, so only the per-company arrival PROGRESS (X/N) is
// reported (USER decision). All figures are the senior's NET share in USD (same
// `currency: 'USD'` display label as `seniorShareIncome`, no conversion).
export const seniorEarningsStatsSchema = z.object({
  // Senior's NET share of PAID SENIOR_INCOME for the PREVIOUS calendar month.
  lastMonthIncome: z.number(),
  // ~6-8 most-recent months (oldest → newest) for the «Всего» sparkline.
  monthlyHistory: z.array(seniorMonthlyEarningSchema),
  // Per-company arrival progress for the CURRENT month — NOT money. `total` =
  // active own projects (each = a company paying monthly); `received` = how many
  // of them ALREADY have ≥1 PAID SENIOR_INCOME dated this month. Render as «X/N
  // приходов от компаний». `received` ≤ `total`.
  companyIncomeProgress: z.object({
    received: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
})

export const seniorSummarySchema = z.object({
  activeProjects: z.object({
    count: z.number().int().nonnegative(),
    items: z.array(seniorActiveProjectSchema),
  }),
  seniorShareIncome: z.object({
    total: z.number(),
    thisMonth: z.number(),
    currency: z.literal('USD'),
  }),
  pendingPayouts: z.object({
    count: z.number().int().nonnegative(),
    amount: z.number(),
  }),
  // Reuses the shared `mySalaryStatusSchema` (interviews.ts) — identical shape
  // to the HR dashboard, now including the salary row's own `currency` so the
  // dashboard formats the amount in its real currency (no $-hardcode).
  mySalaryStatus: mySalaryStatusSchema,
  // task-senior-stats-block — earnings statistics («Статистика заработка»).
  earningsStats: seniorEarningsStatsSchema,
})

export type SeniorActiveProjectDto = z.infer<typeof seniorActiveProjectSchema>
export type SeniorMonthlyEarningDto = z.infer<typeof seniorMonthlyEarningSchema>
export type SeniorEarningsStatsDto = z.infer<typeof seniorEarningsStatsSchema>
export type SeniorSummaryDto = z.infer<typeof seniorSummarySchema>

// ---------------------------------------------------------------------------
// Income compliance overview DTO («Контроль приходов» — task-income-compliance)
// ---------------------------------------------------------------------------
//
// Company-wide control surface for ADMIN + ACCOUNTANT: «кто из получателей
// дохода ещё НЕ внёс приход за месяц». Surfaced by
// GET /api/finance/income-compliance?month=YYYY-MM — RBAC: ADMIN + ACCOUNTANT
// only; every other role (SENIOR / JUNIOR / HR / DROP) gets 403. This is an
// AGGREGATE over MANY income receivers (NOT self-scoped), so it must never reach
// a non-privileged caller — both a @Roles gate AND a service-side role check
// guard it (defense-in-depth, same pattern as getAccountantSummary).
//
// Receivers = SENIOR + ADMIN-as-senior (projects.seniorId) AND DROP
// (projects.dropId). Only receivers with ≥1 active (archivedAt IS NULL) project
// appear (a drop with no active drop-projects has N=0 → excluded, R5).
//
// «Приход внесён по проекту» (owner decision, task-file) = существует ≥1 строка
// income соответствующего типа (SENIOR_INCOME / ADMIN_INCOME / DROP_INCOME) для
// проекта со статусом VALIDATED|PAID и `(txDate ?? createdAt)` в границах
// целевого месяца (UTC). PENDING НЕ считается внесённым — но проекты, у которых
// есть только PENDING-строка за месяц, помечаются `pendingValidation: true`
// (мелкий бейдж «на валидации»). REJECTED игнорируется.

// Role label on a receiver row — drives the UI sub-label (senior / admin-as-
// senior / drop). 'ADMIN_SENIOR' = an ADMIN user who owns projects as their
// senior (income type ADMIN_INCOME, written PAID immediately).
export const incomeComplianceRoleSchema = z.enum(['SENIOR', 'ADMIN_SENIOR', 'DROP'])
export type IncomeComplianceRole = z.infer<typeof incomeComplianceRoleSchema>

// One project under a receiver. `submitted` = has a VALIDATED|PAID income this
// month. `pendingValidation` = has ONLY a PENDING income this month (counts as
// NOT submitted, but the UI shows a «на валидации» badge instead of «нет
// прихода»). A project can never be both `submitted` and `pendingValidation`.
export const incomeComplianceProjectSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string(),
  companyName: z.string(),
  submitted: z.boolean(),
  pendingValidation: z.boolean(),
})
export type IncomeComplianceProjectDto = z.infer<typeof incomeComplianceProjectSchema>

// One income receiver. `expected` (N) = active projects; `submitted` (X) =
// projects with a counted (VALIDATED|PAID) income this month. `missingProjects`
// = the projects WITHOUT a counted income (for the expand drawer), each flagged
// whether it is merely pending validation. `pendingCount` = how many of the
// missing projects are pending (drives the per-receiver «N на валидации» badge).
export const incomeComplianceReceiverSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  role: incomeComplianceRoleSchema,
  expected: z.number().int().nonnegative(),
  submitted: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  missingProjects: z.array(incomeComplianceProjectSchema),
})
export type IncomeComplianceReceiverDto = z.infer<typeof incomeComplianceReceiverSchema>

// The full overview. `month` is the resolved target month (UTC 'YYYY-MM').
// `totals` is the company roll-up for the KPI strip. `receivers` is sorted
// laggards-first (least coverage on top) by the service.
export const incomeComplianceOverviewSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, "Expected 'YYYY-MM' format"), // 'YYYY-MM' (UTC)
  totals: z.object({
    // Σ expected projects across all receivers (the denominator of «X/N приходов»).
    expectedProjects: z.number().int().nonnegative(),
    // Σ submitted (VALIDATED|PAID) projects this month (the numerator).
    submittedProjects: z.number().int().nonnegative(),
    // Receivers who have ≥1 missing project (X < N).
    laggingReceivers: z.number().int().nonnegative(),
    // Receivers whose every active project has a counted income (X === N).
    completeReceivers: z.number().int().nonnegative(),
    // Projects whose only income this month is still PENDING (на валидации).
    pendingProjects: z.number().int().nonnegative(),
  }),
  receivers: z.array(incomeComplianceReceiverSchema),
})
export type IncomeComplianceOverviewDto = z.infer<typeof incomeComplianceOverviewSchema>

// Query schema for the optional ?month=YYYY-MM param. Defaults handled in the
// service (current UTC month) when absent.
export const incomeComplianceQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM')
    .optional(),
})

// ---------------------------------------------------------------------------
// Company Account (USDT) — task-company-account-backend
// ---------------------------------------------------------------------------
//
// A single shared company USDT wallet. Replaces the cancelled smart-contract
// design. Deposits are submitted by SENIOR/DROP (txHash/link), auto-verified
// against Etherscan (recipient + confirmations), and credited to the company
// balance only when the recipient matches the company wallet AND confirmations
// reach the threshold. Dividends and company-funded salaries debit the balance.

// Reused ETH address shape — must match users.walletUsdtErc20 validation.
const ethAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Адрес кошелька должен начинаться с 0x и содержать 42 символа')

// Company requisites markdown — payment/legal block auto-appended to NEW
// contracts (see appendCompanyRequisitesSection). ADMIN-edited; capped to keep
// the contract PDF body bounded and the audit payload reasonable.
export const COMPANY_REQUISITES_MAX = 10000

// GET /api/company-account response — wallet config + derived USDT balance.
export const companyAccountSchema = z.object({
  walletAddress: z.string().nullable(),
  confirmationThreshold: z.number().int().positive(),
  // Derived USDT balance: Σ(COMPANY_DEPOSIT PAID) − Σ(DIVIDEND_TO_ADMIN PAID)
  //   − Σ(SALARY PAID where fundingSource='COMPANY_ACCOUNT'). Always USDT.
  balance: z.number(),
  // Company requisites markdown (nullable until ADMIN sets it). Appended to the
  // END of every NEW contract at sign time (immutable in the resulting snapshot).
  requisitesMarkdown: z.string().nullable(),
  updatedAt: z.string().datetime().nullable(),
})
export type CompanyAccountDto = z.infer<typeof companyAccountSchema>

// PATCH /api/company-account/wallet — ADMIN only.
export const updateWalletSchema = z.object({
  walletAddress: ethAddressSchema,
})
export type UpdateWalletDto = z.infer<typeof updateWalletSchema>

// PATCH /api/company-account/requisites — ADMIN only. Empty string is allowed
// (clears the section); coerced to null at the service so an empty block never
// appends a heading-only section. max() guards the contract-body/audit size.
export const updateRequisitesSchema = z.object({
  requisitesMarkdown: z
    .string()
    .max(
      COMPANY_REQUISITES_MAX,
      `Реквизиты не должны превышать ${COMPANY_REQUISITES_MAX} символов`,
    ),
})
export type UpdateRequisitesDto = z.infer<typeof updateRequisitesSchema>

// POST /api/company-account/deposits — SENIOR/DROP submit a deposit.
// Accept either a bare txHash (0x + 64 hex) or an Etherscan link containing one
// — the service extracts the hash via regex. min(10) keeps the message generic
// while the service does the strict extraction/validation.
export const createCompanyDepositSchema = z.object({
  txHashOrLink: z.string().min(10, 'Укажите hash транзакции или ссылку на Etherscan').max(500),
})
export type CreateCompanyDepositDto = z.infer<typeof createCompanyDepositSchema>

// Deposit status — used both by the POST response and the polling GET endpoint.
export const companyDepositStatusSchema = z.enum(['PENDING', 'PAID', 'REJECTED'])
export type CompanyDepositStatus = z.infer<typeof companyDepositStatusSchema>

export const companyDepositSchema = z.object({
  id: z.string().uuid(),
  txHash: z.string(),
  amountUsdt: z.number().nullable(),
  status: companyDepositStatusSchema,
  confirmations: z.number().int().nonnegative(),
  threshold: z.number().int().positive(),
  // True only when the on-chain recipient matches the configured company wallet.
  // A false here is the security invariant that blocks crediting.
  toMatches: z.boolean(),
  createdAt: z.string().datetime(),
})
export type CompanyDepositDto = z.infer<typeof companyDepositSchema>

// GET /api/company-account/deposits/:id/status — light polling payload.
export const depositStatusSchema = z.object({
  status: companyDepositStatusSchema,
  confirmations: z.number().int().nonnegative(),
  threshold: z.number().int().positive(),
  amountUsdt: z.number().nullable(),
})
export type DepositStatusDto = z.infer<typeof depositStatusSchema>

// POST /api/company-account/dividends — ADMIN only. Free amount (no balance
// gate — owner decision). Receiver defaults to the calling admin; `adminId`
// targets a specific admin partner.
//
// BIZ-19 — idempotencyKey: optional client-generated UUID. When supplied, a
// second POST with the same key returns the EXISTING dividend row (no-op)
// instead of creating a duplicate. Omitting the key preserves backward-
// compatible behaviour (every call creates a fresh row).
export const createDividendSchema = z.object({
  amount: z.number().positive(),
  adminId: z.string().uuid().optional(),
  idempotencyKey: z.string().uuid().optional(),
})
export type CreateDividendDto = z.infer<typeof createDividendSchema>
export type IncomeComplianceQuery = z.infer<typeof incomeComplianceQuerySchema>
