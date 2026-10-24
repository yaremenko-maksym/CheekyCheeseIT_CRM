import { z } from 'zod'
import { withMoneyFloor } from '../money'
import { mandatoryReceiptRefine, receiptFields, transactionBusinessDateFields } from './validation'

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
const ethAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'zod.USDT_ADDRESS_FORMAT')

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
  requisitesMarkdown: z.string().max(COMPANY_REQUISITES_MAX, 'zod.REQUISITES_TOO_LONG'),
})
export type UpdateRequisitesDto = z.infer<typeof updateRequisitesSchema>

// POST /api/company-account/deposits — SENIOR/DROP submit a deposit.
// Accept either a bare txHash (0x + 64 hex) or an Etherscan link containing one
// — the service extracts the hash via regex. min(10) keeps the message generic
// while the service does the strict extraction/validation.
export const createCompanyDepositSchema = z.object({
  txHashOrLink: z.string().min(10, 'zod.TX_HASH_MIN_LENGTH').max(500),
  ...transactionBusinessDateFields,
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
// NOTE (task-onchain-payment-integrity): the deposit's recorded on-chain sender
// is deliberately NOT part of this DTO. `POST /company-account/deposits` is a
// SENIOR/DROP-only endpoint and the sender is ADMIN/ACCOUNTANT audit data, so
// the field would be permanently null here. It is exposed where a privileged
// viewer actually looks — on the COMPANY_DEPOSIT ledger row
// (`transactionSchema.txFromAddress`) and on the payout
// (`payoutRequestSchema.txFromAddress`).

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
// BIZ-19 (MED-2) — idempotencyKey: REQUIRED client-generated UUID. The
// frontend generates a fresh UUID at dialog OPEN (not per render) and sends
// it on submit. A second POST with the same key returns the EXISTING dividend
// row (no double-debit). Zod rejects requests without the key (400).
export const createDividendSchema = z
  .object({
    // task-money-floor-and-lying-comments: hand-entered by the ADMIN — writes
    // straight to `transactions.amount` (`numeric(18,6)`), same as the other
    // create schemas above, so the same floor applies. Deliberately NOT
    // `.max(MAX_TRANSACTION_AMOUNT)` — this schema has never had a ceiling
    // ("no balance gate — owner decision" above); the floor does not change
    // that.
    amount: withMoneyFloor(z.number().positive()),
    adminId: z.string().uuid().optional(),
    idempotencyKey: z.string().uuid(),
    ...transactionBusinessDateFields,
    // task-receipts-backend (#9): a dividend is a USDT withdrawal from the company
    // account → receipt MANDATORY and explorer-only (no currency field: always USDT).
    ...receiptFields,
  })
  .superRefine(mandatoryReceiptRefine(() => 'USDT'))
export type CreateDividendDto = z.infer<typeof createDividendSchema>
