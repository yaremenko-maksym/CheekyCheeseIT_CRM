import { z } from 'zod'

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
])
export type TransactionType = z.infer<typeof transactionTypeSchema>

export const transactionStatusSchema = z.enum([
  'PENDING', // Awaiting action
  'VALIDATED', // Accountant/admin confirmed
  'PENDING_PAYMENT', // Senior created payout request, awaiting payment
  'REJECTED', // Accountant/admin rejected; senior must edit and resubmit
  'PAID', // Completed
  'LOCKED', // Junior salary locked until senior has validated income
  // Drop role - phase 4-B round 2. PAYOUT row sits in this status from the
  // moment the DROP clicks «Я передал нал админу» until ACCOUNTANT/ADMIN
  // picks which admin actually received the cash via /confirm-cash. While in
  // this status NO income transactions exist for the cascade — the row is a
  // placeholder. /confirm-cash flips it to PAID and inserts the cascade.
  'PENDING_CASH_CONFIRM',
])
export type TransactionStatus = z.infer<typeof transactionStatusSchema>

export const payoutRequestStatusSchema = z.enum(['PENDING', 'PAID'])
export type PayoutRequestStatus = z.infer<typeof payoutRequestStatusSchema>

// ---------------------------------------------------------------------------
// Transaction DTO
// ---------------------------------------------------------------------------

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
    })
    .nullable()
    .optional(),
  seniorSharePercent: z.number().nullable(),
  // Receipt: either a documents.id reference (uploaded RECEIPT file) OR an
  // external URL (etherscan, screenshot link). Mutually exclusive — the
  // backend enforces a row-level CHECK constraint. Both null = no receipt.
  receiptDocumentId: z.string().uuid().nullable(),
  receiptExternalUrl: z.string().nullable(),
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
  // Destination wallet (server-generated stub until PHASE 8). SENIOR copies
  // this to send their 74% payable_amount in USDT.
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
 */
const receiptFields = {
  receiptDocumentId: z.string().uuid().optional().nullable(),
  receiptExternalUrl: z.string().url().optional().nullable(),
}

const receiptXor = (data: {
  receiptDocumentId?: string | null | undefined
  receiptExternalUrl?: string | null | undefined
}) => !(data.receiptDocumentId && data.receiptExternalUrl)

const receiptXorMessage = {
  message: 'Receipt must be either a document upload OR an external URL — not both',
  path: ['receiptExternalUrl'],
}

// ADMIN_INCOME — admin declares project income, no validation needed
export const createAdminIncomeSchema = z
  .object({
    projectId: z.string().uuid(),
    amount: z.number().positive(),
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
export type CreateAdminIncomeDto = z.infer<typeof createAdminIncomeSchema>

// SENIOR_INCOME — senior registers project income, awaits validation
export const createSeniorIncomeSchema = z
  .object({
    projectId: z.string().uuid(),
    amount: z.number().positive(),
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
    amount: z.number().positive(),
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
    amount: z.number().positive().optional(),
    currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']).optional(),
    ...receiptFields,
    notes: z.string().max(1000).optional().nullable(),
  })
  .refine(receiptXor, receiptXorMessage)
export type UpdateSeniorIncomeDto = z.infer<typeof updateSeniorIncomeSchema>

// EXPENSE — admin declares a company expense
export const createExpenseSchema = z
  .object({
    amount: z.number().positive(),
    currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
    category: z.string().min(1).max(255),
    notes: z.string().max(1000).optional().nullable(),
    ...receiptFields,
    txDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .nullable(),
  })
  .refine(receiptXor, receiptXorMessage)
export type CreateExpenseDto = z.infer<typeof createExpenseSchema>

// SALARY — admin creates salary transaction for HR/ACCOUNTANT/JUNIOR
export const createSalarySchema = z.object({
  receiverId: z.string().uuid(),
  amount: z.number().positive(),
  currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']).default('USDT'),
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
  amount: z.number().positive(),
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

// Pay payout request (senior submits txHash).
//
// `simulateResult` is a DEV-only escape hatch: when present and the API is
// not in production, the backend either skips the etherscan check and runs
// the success cascade ("success") or throws a deterministic 400 ("error")
// so the SENIOR can rehearse the error path on User Testing without sending
// a real on-chain transaction. In production the field is ignored.
//
// `txHash` is conditionally required: in real mode the SENIOR must paste the
// on-chain hash (min 10 chars), but when `simulateResult` is set (dev only)
// it can be empty — backend synthesizes a stub `0xSIM...` value so the audit
// row never holds null. `.superRefine` enforces this at the schema layer so
// the controller doesn't need branch logic.
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

// Update project finance settings (ADMIN/ACCOUNTANT)
export const updateProjectFinanceSettingsSchema = z.object({
  seniorSharePercentOverride: z.number().int().min(0).max(100).nullable().optional(),
  juniorSalaryOverride: z.number().nonnegative().nullable().optional(),
})
export type UpdateProjectFinanceSettingsDto = z.infer<typeof updateProjectFinanceSettingsSchema>

// Admin edit any transaction (ADMIN only, blocks PAYOUT/PAYOUT_ADMIN on backend)
export const adminUpdateTransactionSchema = z
  .object({
    amount: z.number().positive().optional(),
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

// Mark PENDING salary as PAID (admin pays it manually)
export const paySalarySchema = z.object({
  txHash: z.string().max(255).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
})
export type PaySalaryDto = z.infer<typeof paySalarySchema>

// Drop role - phase 3 (spec §8.4). Manual payout confirmation — ACCOUNTANT/ADMIN
// confirms a PAYOUT actually arrived to a selected admin partner. Body carries
// the chosen admin id; backend validates: PAYOUT row in PENDING_PAYMENT,
// recipient is an active (non-archived) ADMIN, idempotency (no double-confirm).
//
// Note: we accept any UUID shape (not just strict RFC-versioned). The seeded
// partner ids `00000000-0000-0000-0000-00000000000{1,2}` (MAKSYM_ID/KOSTYA_ID)
// have a literal `0` in the version nibble, which Zod v4's built-in `.uuid()`
// rejects. The recipient is re-validated server-side (must exist, role=ADMIN,
// not archived) so format permissiveness is safe here.
const UUID_LIKE_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
export const confirmPayoutSchema = z.object({
  recipientAdminId: z.string().regex(UUID_LIKE_REGEX, 'Invalid UUID'),
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

// Pending obligations — table-backed, distinct lifecycle from the
// transactions ledger. Each row: "creditor (senior) is owed `amount`
// `currency` by debtor (DROP user / TOВ / admin)". A SENIOR_PAID
// transaction closes the obligation (status → PAID + closingTransactionId).
export const pendingObligationDebtorTypeSchema = z.enum(['DROP', 'TOV', 'ADMIN'])
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

// Bank channel — drop transfers UAH to the corporate ТОВ account. Backend
// returns the ТОВ banking details + a unique reference (per income) the drop
// includes in the wire description so accountant can match it later.
export const tovBankDetailsSchema = z.object({
  recipient: z.string(),
  iban: z.string(),
  rnokpp: z.string(),
  bankName: z.string(),
  reference: z.string(), // INV-INC-<id>
})
export type TovBankDetailsDto = z.infer<typeof tovBankDetailsSchema>

export const initiateBankPaymentResponseSchema = z.object({
  tovBankDetails: tovBankDetailsSchema,
  amount: z.string(), // total drop pays to ТОВ (all but drop share)
  currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
})
export type InitiateBankPaymentResponseDto = z.infer<typeof initiateBankPaymentResponseSchema>

export const initiateBankPaymentSchema = z.object({
  incomeId: z.string().regex(UUID_LIKE_REGEX, 'Invalid UUID'),
})
export type InitiateBankPaymentDto = z.infer<typeof initiateBankPaymentSchema>

export const confirmBankPaymentSchema = z.object({
  incomeId: z.string().regex(UUID_LIKE_REGEX, 'Invalid UUID'),
})
export type ConfirmBankPaymentDto = z.infer<typeof confirmBankPaymentSchema>

// Cash channel — drop hands cash to ONE of the admins out-of-band (Maksym or
// Kostya). Round-2 fix: the drop no longer chooses the recipient. The
// `/initiate-cash` call only marks the PAYOUT as `PENDING_CASH_CONFIRM` and
// records no income transactions — the ACCOUNTANT/ADMIN then picks which
// admin actually received the cash via `/confirm-cash`, which creates the
// real `ADMIN_INCOME_CASH` + `SENIOR_PENDING_PAYOUT` rows.
export const initiateCashPaymentSchema = z.object({
  incomeId: z.string().regex(UUID_LIKE_REGEX, 'Invalid UUID'),
})
export type InitiateCashPaymentDto = z.infer<typeof initiateCashPaymentSchema>

// Confirm-cash body — accountant picks one of the active admins.
export const confirmCashPaymentSchema = z.object({
  incomeId: z.string().regex(UUID_LIKE_REGEX, 'Invalid UUID'),
  recipientAdminId: z.string().regex(UUID_LIKE_REGEX, 'Invalid UUID'),
})
export type ConfirmCashPaymentDto = z.infer<typeof confirmCashPaymentSchema>

// Lightweight initiate-cash response — frontend just needs to know the
// status; transactions appear only after confirm.
export const initiateCashPaymentResponseSchema = z.object({
  incomeId: z.string(),
  payoutId: z.string().nullable(),
  status: z.literal('PENDING_CASH_CONFIRM'),
})
export type InitiateCashPaymentResponseDto = z.infer<typeof initiateCashPaymentResponseSchema>

// GET /api/payments/pending-cash — one row per PAYOUT in PENDING_CASH_CONFIRM,
// enriched with drop / project / amount so the accountant can pick the
// recipient admin without follow-up requests.
export const pendingCashItemSchema = z.object({
  incomeId: z.string(),
  payoutId: z.string(),
  dropId: z.string(),
  dropName: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  amount: z.string(),
  currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
  initiatedAt: z.string(),
})
export type PendingCashItemDto = z.infer<typeof pendingCashItemSchema>

export const pendingCashListResponseSchema = z.array(pendingCashItemSchema)
export type PendingCashListResponseDto = z.infer<typeof pendingCashListResponseSchema>

// Wire response for the cash and bank confirm flows — returns the list of
// transactions created so the UI can refresh without a second round-trip.
export const paymentChannelCascadeResponseSchema = z.object({
  income: transactionSchema,
  created: z.array(transactionSchema),
})
export type PaymentChannelCascadeResponseDto = z.infer<typeof paymentChannelCascadeResponseSchema>

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
  dropBalances: z
    .array(
      z.object({
        userId: z.string().uuid(),
        displayName: z.string(),
        balance: z.number(),
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
