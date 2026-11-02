import { z } from 'zod'
import {
  dropSharePercentSourceSchema,
  payoutRequestStatusSchema,
  seniorSharePercentSourceSchema,
  transactionStatusSchema,
  transactionTypeSchema,
} from './enums'
import { receiptFields, receiptXor, receiptXorMessage } from './validation'

export const transactionSchema = z.object({
  id: z.string().uuid(),
  type: transactionTypeSchema,
  status: transactionStatusSchema,
  amount: z.string(), // numeric string from DB
  currency: z.enum(['USDT', 'USD', 'EUR', 'UAH']),
  /**
   * task-salary-pay-amount — OBLIGATION snapshot, stamped by `paySalary` at the
   * moment a PENDING salary flips to PAID.
   *
   * From that task on, `amount`/`currency` above carry the FACT of the payment
   * (what actually left the payer's account — e.g. «30 000 UAH», so a bank
   * statement reconciles one-to-one), which may be denominated differently from
   * the obligation the row was created with (e.g. «800 USD»). These three fields
   * preserve that obligation so USD reporting, balances and the
   * «projects unpaid this month» metric never lose the original denomination:
   *
   *   originalAmount   — `amount` as it stood immediately BEFORE the payment.
   *   originalCurrency — `currency` as it stood immediately BEFORE the payment.
   *   exchangeRate     — the EFFECTIVE applied rate, computed server-side as
   *                      `amount / originalAmount` (units of the paid currency
   *                      per 1 unit of the original one). Never client-supplied:
   *                      the payer's own bank rate is whatever the two amounts
   *                      imply, so accepting a rate from the client would only
   *                      add a spoofable field.
   *
   * ON A ROW CLOSED BY MORE THAN ONE PAYMENT (task-drop-topup, task 3b —
   * SR-L-1). Since the drop top-up shipped, a drop row can be closed, reopened
   * by an income edit, and closed again. The three definitions above are
   * unchanged, but note WHICH payment they describe: the triplet is re-stamped
   * at EVERY closure and cleared by the revert in between, so it always
   * describes the CLOSURE the row currently stands in — never one of the
   * payments that made it up. `amount` there is the SUM of every payment, and
   * `exchangeRate` is that sum over the obligation, which is why the numerator
   * is `amount` and not "this payment". The identity
   * `amount = originalAmount × exchangeRate` therefore still holds, and holds
   * only because a top-up is refused in any currency but the obligation's
   * (`settleByCompany`, AC8) — otherwise the rate would be an average no single
   * transfer was ever made at. The authoritative copy of all this lives on
   * `transactions.originalAmount` in `apps/api/src/database/schema.ts`; this is
   * the wire-contract restatement of it, and the two are meant to agree.
   *
   * `null` reads as "this row does not stand in a closed, amount-aware form".
   * That covers every row never paid through this flow (all non-SALARY types,
   * PENDING salaries, every salary paid before that task shipped) AND, since
   * task 3b, a drop row whose closure was retracted by a cascade revert — the
   * revert clears the triplet precisely so the row stops claiming it was paid.
   * Legacy rows keep `amount` meaning exactly what it always meant.
   * `.optional()` (alongside `.nullable()`) keeps every pre-existing fixture /
   * mock DTO across the codebase valid without a rewrite — same pattern as
   * `dropCascadeOrigin` / `deletedAt`.
   */
  originalAmount: z.string().nullable().optional(),
  originalCurrency: z.enum(['USDT', 'USD', 'EUR', 'UAH']).nullable().optional(),
  exchangeRate: z.string().nullable().optional(),
  /**
   * task-cascade-preview-ui (task 5) — the MONOTONIC accumulator of what has
   * actually been paid out against this row, and the currency it accumulated
   * in. The columns landed with task 1 (PR #599) and drive `loadCascadeSnapshot`
   * / `applyEditCascade` server-side; this is the wire-contract restatement of
   * them, added because three operator-facing surfaces cannot be honest without
   * it and cannot derive it from anything already exposed:
   *
   *   - the list ("Paid 5,000 · remaining 3,000" under the amount),
   *   - the detail dialog (the same split as a `Row`),
   *   - `SettleSeniorPayoutDialog`, which showed the FULL obligation as "Amount"
   *     while the server pays only the remainder — one number on screen, a
   *     different one leaving the account, at the point of an irreversible
   *     decision.
   *
   * NOT MASKED, deliberately — but NOT by analogy with `originalAmount` above
   * (SR-M-2, security-review: that analogy broke inside the same task, which
   * gates the triplet behind `privileged` in the detail dialog while showing
   * this figure to everyone).
   *
   * The reason is that THE VIEWER IS A PARTY TO THIS ROW: every non-privileged
   * path scopes rows on `senderId`/`receiverId` before the projection runs, so
   * this describes the viewer's own money and carries no counterparty
   * identity. Hiding it while leaving `amount` visible would only set the two
   * figures on screen against each other. Pinned by
   * `transaction-settled-exposure.unit.spec.ts` — SE-4/SE-5 for the disclosure,
   * SE-6/SE-7 for the scoping premise it depends on.
   *
   * `null` reads as "this row never went through a settle" — distinct from `0`,
   * which would claim a settle that moved nothing. `.optional()` alongside
   * `.nullable()` keeps every pre-existing fixture valid, same pattern as
   * `originalAmount` / `dropCascadeOrigin`.
   */
  settledAmount: z.string().nullable().optional(),
  settledCurrency: z.enum(['USDT', 'USD', 'EUR', 'UAH']).nullable().optional(),
  /**
   * task-paid-salary-amount-edit (SR-M-1) — present ONLY on the response of
   * `PATCH :id/admin-edit`, when the edit committed but voiding or re-issuing
   * an invoice afterwards failed. The edit is saved; the invoice is not in
   * step with it. Never on list/detail reads.
   *
   * COPY-M-6 — two outcomes, because only one of them has a remedy the
   * operator can perform:
   *   `SELF_REPAIRABLE` — the broken invoice is the edited salary's own, and
   *                       saving the row again re-issues it;
   *   `MANUAL_CHECK`    — the failure is on a DERIVED row (or on a salary the
   *                       automatic repair cannot recognise). Saving again
   *                       changes nothing, so the text must not promise it.
   */
  invoiceReissueIncomplete: z.enum(['SELF_REPAIRABLE', 'MANUAL_CHECK']).optional(),
  senderId: z.string().uuid().nullable(),
  senderLabel: z.string().nullable(),
  senderName: z.string().nullable(), // resolved from user if senderId set
  receiverId: z.string().uuid().nullable(),
  receiverLabel: z.string().nullable(),
  receiverName: z.string().nullable(), // resolved from user if receiverId set
  projectId: z.string().uuid().nullable(),
  projectName: z.string().nullable(),
  payoutRequestId: z.string().uuid().nullable(),
  /**
   * security-review PR #443 (MED-1, round 4). Origin marker for a
   * DROP_PENDING_PAYOUT / PAYOUT_DROP row — `true` ⟺ booked by the
   * drop-payout CASCADE (its slice PROVABLY never touched the shared company
   * account); `false` ⟺ booked by the admin-USDT declaration path
   * (declareUsdtProjectIncome) — a cascade-vs-declaration discriminator, NOT
   * a guarantee the company account holds the money (a declaration can also
   * route to a specific admin's personal wallet — see the column comment in
   * schema.ts, corrected round 5); `null` ⟺ unstamped/unknown
   * (pre-marker-column legacy row, or a future insert path that forgot to
   * set it) — treated as cascade-equivalent (block) by the server, same as
   * `true`. Exposed so `SettleSeniorPayoutDialog` can read the SAME signal
   * `settleByCompany`'s HIGH-1/MED-B guard authoritatively uses, instead of
   * re-deriving a (weaker, FK-dependent) approximation from
   * `payoutRequestId`. `undefined` on transaction types other than
   * DROP_PENDING_PAYOUT/PAYOUT_DROP (the column exists on every row, but is
   * only ever meaningful for these two).
   */
  dropCascadeOrigin: z.boolean().nullable().optional(),
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
  /**
   * task-drop-share-override-and-receiver (Part A). Snapshot of the DROP share
   * percent stamped on a DROP_INCOME at creation time (and carried onto the
   * DROP_PENDING_PAYOUT IOU). Nullable — only DROP-flow rows carry it.
   */
  dropSharePercent: z.number().nullable().optional(),
  /**
   * Snapshot source for `dropSharePercent` — 'PROJECT' | 'USER_DEFAULT'. No
   * team level (see `dropSharePercentSourceSchema`). Nullable for legacy /
   * non-drop rows.
   */
  dropSharePercentSource: dropSharePercentSourceSchema.nullable().optional(),
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
  /**
   * Audit field — the ADMIN/ACCOUNTANT who validated (approved) the row.
   *
   * RBAC identity-masking (follow-up to createdBy masking, security review PR
   * #385): the raw validator UUID is disclosed only to ADMIN/ACCOUNTANT. For
   * every other viewer `mapTx` nulls it (validation is ADMIN/ACCOUNTANT-only, so
   * a non-privileged viewer is never the validator — the raw admin UUID would
   * otherwise leak on their own VALIDATED rows). Nullable so the masked DTO is
   * representable and typed honestly on the client.
   */
  validatedBy: z.string().uuid().nullable(),
  validatedAt: z.string().datetime().nullable(),
  rejectionReason: z.string().nullable(),
  notes: z.string().nullable(),
  salaryMonth: z.string().nullable(), // YYYY-MM
  txDate: z.string().datetime().nullable(),
  /**
   * UX-M-2 / QA-LOW-3 — `true` when the admin edit would refuse a change of
   * `txDate` on this row (`FINANCE_TX_DATE_LOCKED_ROW`), so the form can disable
   * the date field instead of letting the save fail. Computed server-side by the
   * same predicate the edit guard uses (`isTxDateLocked`).
   *
   * RBAC: only an ADMIN viewer gets the real value — only an ADMIN can edit the
   * date. Every other viewer gets `false`, so the flag cannot be read as a proxy
   * for the lock causes (on-chain hash, company-account funding, settlements).
   * `.optional()` keeps pre-existing fixtures valid; `undefined` reads as "not
   * locked" and the server guard stays authoritative.
   */
  isDateLocked: z.boolean().optional(),
  // Drop role - phase 2. Optional, nullable explicit recipient pointer for
  // transactions whose intended payee is NOT the senior on the row (e.g.
  // PAYOUT_DROP whose receiverId is the DROP user). Existing types
  // (SENIOR_INCOME, PAYOUT, …) keep their semantics — recipientId is set
  // alongside receiverId only for the new PAYOUT_DROP path. Adding it as
  // optional + nullable keeps the existing client contract compatible.
  recipientId: z.string().uuid().nullable().optional(),
  /**
   * Audit field — the ADMIN/ACCOUNTANT (or, for self-declared income, the
   * SENIOR/DROP) who booked the row.
   *
   * RBAC identity-masking (follow-up to counterparty masking, security review
   * PR #384): the raw creator UUID is disclosed only to ADMIN/ACCOUNTANT. For
   * every other viewer `mapTx` nulls it UNLESS it is the viewer's own id (their
   * own self-declared income — needed by `canAttachReceipt`'s author gate and a
   * non-leak since they already know their own id). Nullable so the masked DTO
   * is representable and typed honestly on the client.
   */
  createdBy: z.string().uuid().nullable(),
  /**
   * task-onchain-payment-integrity. On-chain SENDER (ERC-20 `topics[1]`, tx
   * `from` as fallback) of the transfer behind this row — a payout settlement
   * or a company deposit. Lowercase.
   *
   * OBSERVED, NOT ENFORCED: staff often withdraw USDT straight from an
   * exchange, so this is frequently the exchange's hot wallet rather than the
   * payer's own address; the API records it for investigation but never gates a
   * settlement on it. AUDIT-SCOPED: returned to ADMIN/ACCOUNTANT only, null for
   * every other viewer (same masking class as `validatedBy` / counterparty).
   * Null on every row with no on-chain transfer behind it.
   */
  txFromAddress: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /**
   * task-soft-delete-and-money-audit (security-audit finding 3, 27.07). Soft-
   * delete marker — the row is never physically removed. Visibility: only
   * ADMIN/ACCOUNTANT can ever receive a non-null value here (every other
   * viewer gets a 404 for a deleted transaction, both in the list and by
   * direct id — see TransactionsService.findAll/findOne). `.optional()`
   * alongside `.nullable()` keeps every pre-existing fixture/mock DTO across
   * the codebase valid without a rewrite (mirrors `dropCascadeOrigin` above).
   */
  deletedAt: z.string().datetime().nullable().optional(),
  /** Audit UUID of the ADMIN/ACCOUNTANT who deleted the row. Same visibility as `deletedAt`. */
  deletedBy: z.string().uuid().nullable().optional(),
  /** Mandatory at delete time (see `deleteTransactionSchema`) — never blank on a deleted row. */
  deletionReason: z.string().nullable().optional(),
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
  /**
   * task-onchain-payment-integrity. On-chain SENDER of the settling transfer
   * (ERC-20 `topics[1]`, tx `from` as fallback), lowercase.
   *
   * OBSERVED, NOT ENFORCED: staff often withdraw USDT straight from an
   * exchange, so this is frequently the exchange's hot wallet rather than the
   * payer's own address — the API records it for investigation but never gates
   * a settlement on it. AUDIT-SCOPED: the API returns it to ADMIN/ACCOUNTANT
   * only; every other role (incl. the payout's own SENIOR/DROP) receives null.
   * Also null for pending payouts, manual off-chain confirmations and
   * dev-simulate settlements.
   */
  txFromAddress: z.string().nullable(),
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

/**
 * Body for the generic `PATCH /transactions/:id/receipt` attach/replace endpoint
 * (pm-brief §6). Exactly one of receiptDocumentId / receiptExternalUrl, mandatory
 * (a request that clears the receipt is not allowed via this endpoint). The
 * currency-aware rule (USDT → explorer-only) is applied in the SERVICE because
 * the effective currency comes from the EXISTING transaction, not the body.
 */
export const attachReceiptSchema = z
  .object({ ...receiptFields })
  .refine(receiptXor, receiptXorMessage)
  .refine((d) => !!d.receiptDocumentId || !!d.receiptExternalUrl, {
    message: 'zod.RECEIPT_REQUIRED',
    path: ['receiptExternalUrl'],
  })
export type AttachReceiptDto = z.infer<typeof attachReceiptSchema>

// security-review PR #456 (MED-3): `transaction_audit_log` was write-only —
// every DELETE/RESTORE/VALIDATE/REJECT/CREATE/AMOUNT_OR_RECEIVER_CHANGE/
// ATTACH/REPLACE entry was journaled but nothing in the API ever read it back.
// GET /api/transactions/:id/audit-log (ADMIN only) surfaces the journal for a
// single transaction — `actorName` is resolved server-side (a raw `actorId`
// UUID is not user-facing) and is `null` when the actor row no longer exists
// (`ON DELETE SET NULL` on `transaction_audit_log.actor_id`). There is no
// apps/web consumer of the audit log yet, so the localized «User deleted»
// fallback is DEFERRED until a transaction-audit UI exists (tracked in
// backlog) (i18n server-text PR4, S4).
export const transactionAuditLogEntrySchema = z.object({
  id: z.string().uuid(),
  action: z.string(),
  actorId: z.string().uuid().nullable(),
  actorName: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
})
export type TransactionAuditLogEntryDto = z.infer<typeof transactionAuditLogEntrySchema>

export const transactionAuditLogListSchema = z.array(transactionAuditLogEntrySchema)
