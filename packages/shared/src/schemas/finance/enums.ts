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
  // TOV_INCOME           — money lands on the corporate (TOV) account.
  // SENIOR_PENDING_PAYOUT — TOV owes a senior; obligation row in pending_obligations.
  //                         Does NOT move the senior's balance until closed.
  // SENIOR_PAID          — closes a pending obligation; credits the senior's
  //                         real balance; links to the pending_obligation row.
  // ADMIN_INCOME_CASH    — admin personally received cash for a project.
  // ADMIN_INCOME_CRYPTO  — admin personally received USDT on crypto wallet.
  // SENIOR_INCOME_CRYPTO — senior personally received USDT on crypto wallet.
  // DIVIDEND_TO_ADMIN    — distribution from TOV → admin balance (50/50 to each).
  // DIVIDEND_TAX         — 6.5% tax on dividends; debits TOV balance only.
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
  // task-drop-share-override-and-receiver (Part B). The company owes the DROP
  // their share when a DROP_INCOME's receiver is an ADMIN (money landed on the
  // admin, not on the drop). Mirror of SENIOR_PENDING_PAYOUT: a visible IOU row
  // (status=PENDING_PAYMENT) paired with a pending_obligations row
  // (creditor=DROP, debtor=COMPANY), settled by ACCOUNTANT/ADMIN via
  // settleByCompany. Kept LAST for a clean additive `ALTER TYPE ... ADD VALUE`.
  'DROP_PENDING_PAYOUT',
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

/**
 * task-drop-share-override-and-receiver (Part A). Provenance of the DROP share
 * percent snapshotted on a DROP_INCOME transaction.
 *
 * Hierarchy (highest priority first) — NO team level (unlike senior; the drop
 * is bound to a project via `projects.dropId`, not through team membership):
 *   - `'PROJECT'`      — `projects.dropSharePercentOverride` was set.
 *   - `'USER_DEFAULT'` — fell back to `users.dropSharePercent` (or default 5).
 *
 * Nullable in the transaction snapshot to keep legacy DROP_INCOME rows
 * (created before this column existed) renderable as-is.
 */
export const dropSharePercentSourceSchema = z.enum(['PROJECT', 'USER_DEFAULT'])
export type DropSharePercentSource = z.infer<typeof dropSharePercentSourceSchema>

/**
 * server-text PR3 — the stable CODE stored in `transactions.sender_label` /
 * `receiver_label` when the shared company account is the party (settle-by-
 * company, COMPANY_DEPOSIT, DIVIDEND_TO_ADMIN, company-funded EXPENSE/SALARY).
 * It is a code, not prose: the web maps it to the viewer-locale «Рахунок
 * компанії» / "Company account" through the Lingui catalog. Non-privileged
 * viewers never receive it (`mapTx` rebrands the side to `CheekyCheeseIT`).
 */
export const COMPANY_ACCOUNT_LABEL = 'COMPANY'

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

// task-drop-share-override-and-receiver (D3). Sentinel value for the "company
// account" receiver of an admin-declared income — distinguishes crediting the
// shared USDT pool from crediting a specific ADMIN's personal balance. Used by
// BOTH `createAdminIncomeSchema` (task-admin-income-unified) and
// `createUsdtIncomeSchema` below — declared once, before its first use.
export const COMPANY_ACCOUNT_RECEIVER = 'COMPANY_ACCOUNT'

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
