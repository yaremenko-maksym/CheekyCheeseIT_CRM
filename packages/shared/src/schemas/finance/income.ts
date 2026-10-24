import { z } from 'zod'
import { withMoneyFloor } from '../money'
import { COMPANY_ACCOUNT_RECEIVER, salaryFundingSourceSchema, salaryOriginSchema } from './enums'
import {
  MAX_TRANSACTION_AMOUNT,
  mandatoryReceiptRefine,
  receiptFields,
  receiptXor,
  receiptXorMessage,
  refineAdminIncomeCompanyAccountUsdt,
  refineCompanyAccountUsdt,
  transactionAmountError,
  transactionBusinessDateFields,
} from './validation'

// ADMIN_INCOME — admin declares project income for a project they own (or, for
// ACCOUNTANT, an admin-owned project on that admin's behalf).
//
// task-admin-income-unified (2026-08-12). `receiverId` REPLACES the old
// `fundingSource` toggle — "who gets credited" is now the SAME choice
// `createUsdtIncomeSchema` already offers (an active ADMIN's uuid, or the
// COMPANY_ACCOUNT_RECEIVER sentinel for the shared pool), extended to this
// non-USDT path so one form covers both routes with one receiver concept.
// Optional → legacy default (service credits the project's admin owner,
// unchanged behaviour) for callers that do not send it. ACCOUNTANT MAY NOT
// send an explicit receiverId at all (server rejects — see
// TransactionsService.createAdminIncome): the accountant has always been a
// recorder, never a router of funds, and this task does not change that.
export const createAdminIncomeSchema = z
  .object({
    projectId: z.string().uuid(),
    // BIZ-13: reasonable ceiling. task-money-floor-and-lying-comments: hand-
    // entered by the ADMIN/ACCOUNTANT declaring income — floor added.
    amount: withMoneyFloor(z.number().positive().max(MAX_TRANSACTION_AMOUNT)),
    currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
    ...receiptFields,
    notes: z.string().max(1000).optional().nullable(),
    ...transactionBusinessDateFields,
    // Stryker disable next-line ArrayDeclaration: this array literal is evaluated ONCE at module-import time (schema construction), before any test's per-test coverage window opens, so Stryker's vitest-runner falls back to a single whole-suite run for this "static" mutant and reports 0 tests completed. Verified independently outside Stryker's sandbox (plain node, this repo's exact zod@4.3.6): `z.union([])` throws synchronously inside `new ZodUnion` the instant the module is imported — every test file importing anything from finance.ts would fail to even load. Not an equivalent mutant (it is a real, severe regression); real behavioural tests already exist accepting a UUID and the COMPANY_ACCOUNT sentinel for this exact field (createAdminIncomeSchema.spec.ts) — they just cannot register as "covering" a construction-time literal, a tool blind spot for module-scope Zod unions.
    receiverId: z.union([z.string().uuid(), z.literal(COMPANY_ACCOUNT_RECEIVER)]).optional(),
    // security-review (PR #522, MED-1): `receiverId` REPLACED `fundingSource` on
    // this schema, but z.object() defaults to `.strip()` — a legacy client tab
    // (open before this change deployed) sending the OLD `fundingSource:
    // 'COMPANY_ACCOUNT'` shape would have that key silently dropped, not
    // rejected, and fall through to the personal-credit default. That is not
    // merely "wrong receiver": `settlementConsumesTransfer(..., null)` (the
    // funding-source-gated branch) returns false for the resulting row, so the
    // on-chain tx hash never gets claimed in the consumed-hash registry — the
    // exact double-spend window PR #438 (MED-1) closed reopens. Declaring the
    // field explicitly as `z.never()` makes Zod REJECT any non-undefined value
    // instead of stripping it, so a stale client gets a 400, not a silently
    // mis-routed 201.
    fundingSource: z.never().optional(),
  })
  .superRefine(refineAdminIncomeCompanyAccountUsdt)
  // task-receipts-backend: receipt MANDATORY. Effective currency = USDT when
  // routed to the company account (USDT-only) → explorer-only; else the input
  // currency → file/url.
  .superRefine(
    mandatoryReceiptRefine((d) =>
      d.receiverId === COMPANY_ACCOUNT_RECEIVER ? 'USDT' : d.currency,
    ),
  )
export type CreateAdminIncomeDto = z.infer<typeof createAdminIncomeSchema>

// task-drop-share-override-and-receiver (D3). Admin-only declaration of USDT
// project income on a USDT-paymentType project. The gross amount lands on the
// chosen receiver; the company then atomically books obligations to the
// project's senior / drop (see bookCompanyObligations). The income row itself is
// an ADMIN_INCOME transaction (adopt-before-extend — identical money semantics
// to createAdminIncome, zero churn on ledger/summary/exhaustive maps).
//
//   receiverId = <uuid>            → an active ADMIN: gross credits THAT admin's
//                                    personal balance (fundingSource=null,
//                                    receiverId=admin).
//   receiverId = 'COMPANY_ACCOUNT' → gross credits the shared company USDT pool
//                                    (fundingSource=COMPANY_ACCOUNT,
//                                    receiverId=caller, excluded from personal).
//
// Currency is always USDT (USDT project); the server enforces it too. RBAC:
// ADMIN only (Q4 — ACCOUNTANT may NOT declare). Created immediately PAID (Q2).
export const createUsdtIncomeSchema = z
  .object({
    projectId: z.string().uuid(),
    // BIZ-13: reasonable ceiling. task-money-floor-and-lying-comments: hand-
    // entered by the ADMIN declaring USDT income — floor added.
    amount: withMoneyFloor(z.number().positive().max(MAX_TRANSACTION_AMOUNT)),
    currency: z.literal('USDT'),
    receiverId: z.union([z.string().uuid(), z.literal(COMPANY_ACCOUNT_RECEIVER)]),
    // Security-review PR #367 (MED-1) — idempotencyKey: REQUIRED client-generated
    // UUID, mirroring the dividend BIZ-19 (MED-2) contract 1:1. The frontend
    // generates a fresh UUID at dialog OPEN (not per render) and sends it on
    // submit. A double-submit (double click / network retry) with the SAME key
    // returns the EXISTING ADMIN_INCOME row — NO second income and NO duplicated
    // company obligations (senior/drop shares). Zod rejects a missing / non-uuid
    // key with 400 (the server never falls back to a fresh row for this flow).
    idempotencyKey: z.string().uuid(),
    // task-receipts-backend (#4): receipt is now MANDATORY for admin-declared USDT
    // income (reverses the PR #367 decision to omit it). Currency is the USDT
    // literal → the mandatory refine below requires a blockchain-explorer link.
    ...receiptFields,
    notes: z.string().max(1000).optional().nullable(),
    ...transactionBusinessDateFields,
  })
  .superRefine(mandatoryReceiptRefine(() => 'USDT'))
export type CreateUsdtIncomeDto = z.infer<typeof createUsdtIncomeSchema>

// SENIOR_INCOME — senior registers project income, awaits validation
export const createSeniorIncomeSchema = z
  .object({
    projectId: z.string().uuid(),
    // BIZ-13: reasonable ceiling. task-money-floor-and-lying-comments: hand-
    // entered by the SENIOR registering income — floor added.
    amount: withMoneyFloor(z.number().positive().max(MAX_TRANSACTION_AMOUNT)),
    currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
    // task-senior-drop-income-idempotency (backlog 73/A-3): REQUIRED client-
    // generated UUID, mirroring the ADMIN_INCOME (PR #367, MED-1) / dividend
    // (BIZ-19, MED-2) idempotency contract 1:1 — see createUsdtIncomeSchema
    // above. The frontend generates a fresh UUID at dialog OPEN (not per
    // render/submit) and sends it on every submit within that session. A
    // double-submit (double click / network retry) with the SAME key returns
    // the EXISTING SENIOR_INCOME row instead of creating a second one — the
    // second income used to book a second company obligation for the same
    // piece of work once it reached payout validation. Zod rejects a missing
    // / non-uuid key with 400.
    idempotencyKey: z.string().uuid(),
    ...receiptFields,
    notes: z.string().max(1000).optional().nullable(),
    ...transactionBusinessDateFields,
  })
  // task-receipts-backend: receipt MANDATORY + currency-aware (USDT → explorer-only).
  .superRefine(mandatoryReceiptRefine((d) => d.currency))
export type CreateSeniorIncomeDto = z.infer<typeof createSeniorIncomeSchema>

// DROP_INCOME — drop registers project income on a drop-project, awaits
// validation. Mirror of createSeniorIncomeSchema field-for-field so the
// frontend can reuse the same form. Drop role - phase 2.
// Constraint enforced server-side: project.dropId must equal the caller's id.
//
// task-drop-share-override-and-receiver (C14): a DROP declares its OWN income on
// a FOP/GIG project WITHOUT a receiver selector — the money landed on the drop.
// The `receiverId` selector belongs to the NEW admin-only USDT declaration flow
// (`createUsdtIncomeSchema`), NOT here (this reverts the M1 mistake where
// createDropIncome carried a REQUIRED receiverId). On a USDT project SENIOR/DROP
// cannot declare at all — the backend gates them (only ADMIN declares USDT).
export const createDropIncomeSchema = z
  .object({
    projectId: z.string().uuid(),
    // BIZ-13: reasonable ceiling. task-money-floor-and-lying-comments: hand-
    // entered by the DROP registering income — floor added.
    amount: withMoneyFloor(z.number().positive().max(MAX_TRANSACTION_AMOUNT)),
    currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
    // task-senior-drop-income-idempotency (backlog 73/A-3): same REQUIRED
    // client-generated UUID contract as createSeniorIncomeSchema above (see
    // its comment for the full rationale) — mirrored 1:1 onto DROP_INCOME.
    idempotencyKey: z.string().uuid(),
    ...receiptFields,
    notes: z.string().max(1000).optional().nullable(),
    ...transactionBusinessDateFields,
  })
  // task-receipts-backend: receipt MANDATORY + currency-aware (USDT → explorer-only).
  .superRefine(mandatoryReceiptRefine((d) => d.currency))
export type CreateDropIncomeDto = z.infer<typeof createDropIncomeSchema>

// Update REJECTED senior income (resets to PENDING)
export const updateSeniorIncomeSchema = z
  .object({
    // BIZ-13: reasonable ceiling. task-money-floor-and-lying-comments: hand-
    // re-entered by the SENIOR editing a rejected income — floor added.
    amount: withMoneyFloor(z.number().positive().max(MAX_TRANSACTION_AMOUNT)).optional(),
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
    // BIZ-13: reasonable ceiling. task-money-floor-and-lying-comments: hand-
    // re-entered by the DROP editing a rejected income — floor added.
    amount: withMoneyFloor(z.number().positive().max(MAX_TRANSACTION_AMOUNT)).optional(),
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
    // BIZ-13: reasonable ceiling. task-money-floor-and-lying-comments: hand-
    // entered by the ADMIN declaring an expense — floor added.
    amount: withMoneyFloor(z.number().positive().max(MAX_TRANSACTION_AMOUNT)),
    currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
    category: z.string().min(1).max(255),
    notes: z.string().max(1000).optional().nullable(),
    ...receiptFields,
    ...transactionBusinessDateFields,
    // Reuse salaryFundingSourceSchema — only COMPANY_ACCOUNT is meaningful here.
    // Optional → legacy expense (no company routing, no balance impact).
    fundingSource: salaryFundingSourceSchema.optional(),
  })
  .superRefine(refineCompanyAccountUsdt)
  // task-receipts-backend: receipt MANDATORY. Effective currency = USDT when
  // funded from the company account (USDT-only) → explorer-only; else the input
  // currency → file/url.
  .superRefine(
    mandatoryReceiptRefine((d) => (d.fundingSource === 'COMPANY_ACCOUNT' ? 'USDT' : d.currency)),
  )
export type CreateExpenseDto = z.infer<typeof createExpenseSchema>

// SALARY — admin/accountant creates a salary transaction for eligible roles.
// task-salary-pay-flow: a manually-created salary is a NEUTRAL PENDING reminder
// — NO funding source and NO currency-lock at creation. The funding source
// (company account vs admin personal) and the actual payment currency are chosen
// later, at pay time, via paySalary (see paySalarySchema). `currency` here is the
// nominal of the reminder (default USD); it is overridden by the pay-time choice.
// YYYY-MM with a real month (01-12): `2026-13` / `2026-00` are rejected.
// Shared by createSalary and the admin transaction edit.
// `salaryMonthField` is the single regex; callers whose error text is pinned
// (gap query / report / backfill) pass their own message.
export const salaryMonthField = (message: string) =>
  z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, message)
export const salaryMonthSchema = salaryMonthField('Format YYYY-MM')

export const createSalarySchema = z.object({
  receiverId: z.string().uuid(),
  // BIZ-13: reasonable ceiling. task-money-floor-and-lying-comments
  // (security-review follow-up to PR #485): hand-entered by the
  // ADMIN/ACCOUNTANT creating the reminder — `createSalary(amount: 1e-7)`
  // used to pass this schema and land in `numeric(18,6)` as `0.000000`, an
  // obligation created for zero. Floor added.
  amount: withMoneyFloor(z.number().positive().max(MAX_TRANSACTION_AMOUNT)),
  currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']).default('USD'),
  salaryMonth: salaryMonthSchema,
  // One UUID = one manual salary-part intent. Required so a stale/custom
  // client cannot create an unprotected financial write that is impossible to
  // distinguish from an intentional second, identical salary part.
  idempotencyKey: z.string().uuid(),
  notes: z.string().max(1000).optional().nullable(),
  ...transactionBusinessDateFields,
})
export type CreateSalaryDto = z.infer<typeof createSalarySchema>

// ADMIN_TRANSFER — balance equalization between Maksym and Kostya
export const createAdminTransferSchema = z
  .object({
    senderId: z.string().uuid().optional(),
    receiverId: z.string().uuid(),
    // BIZ-13: reasonable ceiling. task-money-floor-and-lying-comments: hand-
    // entered by the ADMIN equalizing balances — floor added.
    amount: withMoneyFloor(z.number().positive().max(MAX_TRANSACTION_AMOUNT)),
    currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']).default('USDT'),
    // task-receipts-backend (#8): receipt now MANDATORY + currency-aware (default
    // USDT → explorer-only). The default is applied before the refine runs, so
    // an omitted currency is treated as USDT.
    ...receiptFields,
    notes: z.string().max(1000).optional().nullable(),
    ...transactionBusinessDateFields,
  })
  .superRefine(mandatoryReceiptRefine((d) => d.currency))
export type CreateAdminTransferDto = z.infer<typeof createAdminTransferSchema>

// Validate or reject SENIOR_INCOME
export const validateTransactionSchema = z.object({
  action: z.enum(['validate', 'reject']),
  rejectionReason: z.string().max(500).optional().nullable(),
})
export type ValidateTransactionDto = z.infer<typeof validateTransactionSchema>

// task-soft-delete-and-money-audit. Soft-delete a transaction — ADMIN only.
// The reason is MANDATORY (owner requirement: "six months from now, 'why was
// this deleted' must be recoverable") and lands verbatim in
// `transaction_audit_log.metadata.reason` — same shape/message convention as
// the existing `releaseOnChainHashSchema.reason`.
export const deleteTransactionSchema = z.object({
  reason: z.string().trim().min(3, 'zod.REASON_REQUIRED_DELETE').max(500),
})
export type DeleteTransactionDto = z.infer<typeof deleteTransactionSchema>

// task-soft-delete-and-money-audit. Restore a soft-deleted transaction — ADMIN
// only (ACCOUNTANT can see a deleted row but not restore it). Reason is
// mandatory for the same audit-trail reason as delete.
export const restoreTransactionSchema = z.object({
  reason: z.string().trim().min(3, 'zod.REASON_REQUIRED_RESTORE').max(500),
})
export type RestoreTransactionDto = z.infer<typeof restoreTransactionSchema>

// Admin edit any transaction (ADMIN only, blocks PAYOUT/PAYOUT_ADMIN on backend)
export const adminUpdateTransactionSchema = z
  .object({
    // BIZ-13: reasonable ceiling. task-money-floor-and-lying-comments: hand-
    // entered by the ADMIN correcting a transaction — floor added.
    amount: withMoneyFloor(z.number().positive().max(MAX_TRANSACTION_AMOUNT)).optional(),
    currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']).optional(),
    notes: z.string().max(1000).optional().nullable(),
    ...receiptFields,
    category: z.string().min(1).max(255).optional(),
    salaryMonth: salaryMonthSchema.optional(),
    /**
     * task-cascade-apply (task 3) — the optimistic-locking token
     * `GET /transactions/:id/edit-preview` handed back
     * (`computeCascadeVersion`, packages/shared/src/schemas/edit-cascade.ts).
     *
     * MANDATORY on the server whenever a PAID row's `amount` actually
     * changes: the server re-reads the snapshot under `SELECT … FOR UPDATE`,
     * re-derives this same string and refuses with 409 on a mismatch, so an
     * edit confirmed against a preview that has since gone stale (an
     * accountant settled the obligation in another tab) is rejected rather
     * than silently recomputed — "a silent recompute IS the exact
     * preview/actual divergence this task closes, just masked as success"
     * (ADR AC4). OPTIONAL here because this same body also carries ordinary
     * metadata-only edits (notes / receipt / category) and non-PAID amount
     * edits, which need no token; the requirement is enforced where the
     * condition is actually known, in `adminUpdateTransaction`.
     *
     * `.min(1)`: an empty string is not a version — accepting it would let a
     * client satisfy "a token was sent" with nothing.
     */
    cascadeVersion: z.string().min(1).optional(),
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
    /**
     * task-salary-pay-amount — the amount ACTUALLY paid, in `currency`.
     *
     * The obligation the salary row was created with is denominated in its own
     * currency (typically USD). When an ADMIN settles it in another one, the
     * figure that must land on the row is the one their bank statement shows
     * (e.g. «30 000 UAH»), not the untouched nominal — otherwise reconciliation
     * never matches. The server stamps the pre-payment amount/currency into
     * `original_amount`/`original_currency` and derives `exchange_rate`, so the
     * obligation is preserved rather than overwritten (see `transactionSchema`).
     *
     * OPTIONAL for backward compatibility: an omitted `paidAmount` keeps the
     * historical behaviour (the row's amount is carried over unchanged, only
     * the currency LABEL changes).
     *
     * Bounds come from `transactionAmountError` — the same function the client
     * and the service use, so all three agree. It rejects 0 / negatives (a
     * salary is never closed by paying nothing), keeps the BIZ-13 ceiling of
     * `createSalarySchema.amount`, and — security-review PR #485 (MED-1) —
     * refuses anything the `numeric(18,6)` column could not store WITHOUT LOSS:
     * `1e-7` used to validate fine and then be written as `0.000000`, closing
     * the obligation with a payment recorded as zero.
     *
     * The payment CLOSES the obligation in full regardless of this figure
     * (owner decision, 2026-08-05: there are no partial payments in the model),
     * which is exactly why the client warns on a large deviation from the
     * rate-derived expectation — see `salaryPaidAmountDeviation`.
     */
    paidAmount: z
      .number()
      .superRefine((v, ctx) => {
        const message = transactionAmountError(v)
        if (message) ctx.addIssue({ code: 'custom', message })
      })
      .optional(),
    ...transactionBusinessDateFields,
    txHash: z.string().max(255).optional().nullable(),
    // task-receipts-backend (#7): pay-time proof is now MANDATORY. Effective
    // currency = USDT for COMPANY_ACCOUNT (USDT-only) → explorer-only; else the
    // chosen currency → file/url.
    ...receiptFields,
    notes: z.string().max(1000).optional().nullable(),
  })
  // Reuse the shared COMPANY_ACCOUNT→USDT guard (same rule as create-salary /
  // expense / admin-income): a company-account payout is USDT-only.
  .superRefine(refineCompanyAccountUsdt)
  .superRefine(
    mandatoryReceiptRefine((d) => (d.fundingSource === 'COMPANY_ACCOUNT' ? 'USDT' : d.currency)),
  )
export type PaySalaryDto = z.infer<typeof paySalarySchema>

// ---------------------------------------------------------------------------
// Salary month gap report + backfill — task-salary-month-gap-and-status (E-5)
// ---------------------------------------------------------------------------
//
// `createMonthlySalaries` (the monthly cron) is the ONLY thing that mints
// PENDING SALARY rows for HR / ACCOUNTANT (unconditionally, if `monthlySalary`
// is set) and JUNIOR (via an active project membership, project override ??
// user default). It always targets "the previous calendar month, right now" —
// there was no way to see a month it silently missed (cron didn't fire, died
// mid-run, or ran before someone's `monthlySalary` was configured) until this
// report existed. See the E-5 module comment on
// `TransactionsService.resolveHrAccountantSalaryReceivers` /
// `resolveJuniorSalaryReceivers` for why the report's population is drawn
// from the EXACT SAME query the cron uses (not a hand-duplicated one) — that
// is what makes "missing" here mean the same thing "missing" means to the
// cron, not a second, possibly-drifted opinion. For the same reason the
// report's DEFAULT month (when `?month` is omitted) is the PREVIOUS calendar
// month — the one the cron itself would just have targeted — computed by the
// SAME `previousSalaryMonthKey()` resolver `SalaryCronService` uses
// (security-review HIGH-2: a report defaulting to the CURRENT month, which
// the cron never touches, reads as "100% missing" for the entire salaried
// population every single day of the month before the 1st).
//
// Deliberately OUT of scope: SENIOR / DROP salaries. `SALARY_ELIGIBLE_ROLES`
// (users.ts) also allows those two roles to receive a MANUALLY created salary
// (`createSalary`), but the cron never auto-creates one for them — so a
// SENIOR/DROP with `monthlySalary` set and no row this month is not a
// cron-gap (nothing failed to run); it would show as a permanent, unfixable
// "gap" that this report's own backfill could never close. That is a
// different, legitimate question ("should the cron cover these roles too?")
// this task does not decide.
export const salaryMonthGapQuerySchema = z.object({
  month: salaryMonthField('month must be YYYY-MM').optional(),
})
export type SalaryMonthGapQuery = z.infer<typeof salaryMonthGapQuerySchema>

// One person the cron SHOULD have accrued a SALARY for this month but did
// not. `expectedAmount` mirrors the cron's own resolution (project override
// ?? user default for JUNIOR; `monthlySalary` for HR/ACCOUNTANT) — always USD
// (the cron never writes any other currency for these rows). `projectId` /
// `projectName` are set for JUNIOR only (the accrual is per active
// membership); null for HR/ACCOUNTANT.
export const salaryMonthGapReceiverSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  role: z.enum(['HR', 'ACCOUNTANT', 'JUNIOR']),
  expectedAmount: z.number(),
  projectId: z.string().uuid().nullable(),
  projectName: z.string().nullable(),
})
export type SalaryMonthGapReceiverDto = z.infer<typeof salaryMonthGapReceiverSchema>

// GET /api/finance/salary-month-gap?month=YYYY-MM — ADMIN + ACCOUNTANT only.
// `month` resolved server-side (explicit ?month, else the PREVIOUS calendar
// month — see the module comment above, HIGH-2). code-review: this OUTPUT
// regex used to be the looser `/^\d{4}-\d{2}$/` (copied from
// `incomeComplianceOverviewSchema.month`, which predates this task and is
// left as-is) — tightened to the SAME `01-12` pattern the two INPUT schemas
// in this file use, so a month value can never be well-formed on the way in
// and only loosely-shaped on the way out.
export const salaryMonthGapReportSchema = z.object({
  month: salaryMonthField("Expected 'YYYY-MM' format"),
  missing: z.array(salaryMonthGapReceiverSchema),
})
export type SalaryMonthGapReportDto = z.infer<typeof salaryMonthGapReportSchema>

// POST /api/finance/salary-month-backfill — ADMIN only. `month` is REQUIRED
// (unlike the report's optional query) — a backfill must never silently
// default to "whatever month it happens to be run in"; the caller states
// which month's gap they are closing. Idempotent: the handler re-invokes the
// SAME `createMonthlySalaries(month)` the cron itself calls (unique index +
// `ON CONFLICT DO NOTHING`), so running it twice — or running it for a month
// the cron already fully covered — creates nothing extra.
export const salaryMonthBackfillSchema = z.object({
  month: salaryMonthField('month must be YYYY-MM'),
})
export type SalaryMonthBackfillDto = z.infer<typeof salaryMonthBackfillSchema>

// ---------------------------------------------------------------------------
// Existing salary parts for one receiver/month (SR-795-M-1, owner decision D-3)
// ---------------------------------------------------------------------------
//
// GET /api/finance/salary-parts?receiverId=…&month=YYYY-MM — ADMIN + ACCOUNTANT,
// the same pair that may create a salary. The second half of D-3: before an
// operator submits a salary part, the dialog shows what is already on the ledger
// for that person and month.
//
// Why a dedicated endpoint rather than a filter on the transactions list: the
// list is viewer-masked and paginated, and the question here is narrow and
// pre-submit. It answers with exactly what an operator needs to recognise a
// duplicate — the figure, its state, and whether it was theirs or the cron's.
// Nothing viewer-sensitive is added: both roles already see these rows in the
// finance table.
export const salaryPartsQuerySchema = z.object({
  receiverId: z.string().uuid(),
  month: salaryMonthField('month must be YYYY-MM'),
})
export type SalaryPartsQuery = z.infer<typeof salaryPartsQuerySchema>

export const salaryPartSchema = z.object({
  id: z.string().uuid(),
  amount: z.number(),
  currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
  status: z.enum(['PENDING', 'PAID', 'LOCKED']),
  // NULL for a legacy row written before the column existed — the UI reads that
  // as "automatic", the same way every predicate on the server does.
  salaryOrigin: salaryOriginSchema.nullable(),
  // ISO string, like `transactionSchema.txDate` — the same `mapTx` convention.
  txDate: z.string().datetime().nullable(),
  notes: z.string().nullable(),
})
export type SalaryPartDto = z.infer<typeof salaryPartSchema>

export const salaryPartsResponseSchema = z.object({
  receiverId: z.string().uuid(),
  month: salaryMonthField("Expected 'YYYY-MM' format"),
  parts: z.array(salaryPartSchema),
})
export type SalaryPartsResponseDto = z.infer<typeof salaryPartsResponseSchema>
