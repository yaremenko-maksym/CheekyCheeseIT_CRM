import { z } from 'zod'
import { moneyFloorAndPrecisionError } from '../money'
import { COMPANY_ACCOUNT_RECEIVER } from './enums'

function isRealCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/**
 * SR-809-L-2 — the sane year window every operator-entered financial date sits
 * inside. Before this, "is a real calendar day" was the ONLY check, so `0000-01-01`
 * and `9999-12-31` both validated; year 0 does not exist for Postgres
 * `timestamptz`, so it surfaced as a driver 500 instead of a 400.
 *
 * The lower bound is the first year this company has financial records for. The
 * upper bound is a typo-catcher, deliberately far beyond any legitimate planned
 * row (a pending salary is planned weeks ahead, not decades), so widening the
 * window is never needed to record real business.
 *
 * This window is role- and flow-INDEPENDENT on purpose. "How far back may THIS
 * caller backdate" and "may THIS flow accept a future date at all" depend on the
 * caller's role and on the flow; a Zod schema cannot see either, so those live in
 * the server-side policy (`transaction-date-policy.ts`) instead.
 */
export const MIN_TRANSACTION_BUSINESS_YEAR = 2020
export const MAX_TRANSACTION_BUSINESS_YEAR = 2100

function isWithinBusinessYearWindow(value: string): boolean {
  const year = Number(value.slice(0, 4))
  return year >= MIN_TRANSACTION_BUSINESS_YEAR && year <= MAX_TRANSACTION_BUSINESS_YEAR
}

// Every financial date input uses one strict YYYY-MM-DD calendar validator.
// Whether a future date is legal is flow-specific (for example, NBU-priced
// settlement forbids it, while a pending salary may legitimately be planned) and
// is decided by the server-side policy, not here.
export const transactionBusinessDateSchema = z
  .string()
  .refine(isRealCalendarDate, { message: 'zod.DATE_FORMAT_YYYYMMDD' })
  .refine(isWithinBusinessYearWindow, { message: 'zod.DATE_YEAR_OUT_OF_RANGE' })

// ---------------------------------------------------------------------------
// Create / Update schemas
// ---------------------------------------------------------------------------

/**
 * task-money-floor-and-lying-comments — decision ledger for EVERY money
 * amount in this file (AC1: "a decision for every amount, including the ones
 * you don't change"). Full per-field reasoning lives in the PR body; this is
 * the durable, in-repo index so a future reader does not have to dig through
 * PR history to see the classification.
 *
 * HAND-ENTERED — floored by this task (a human types the figure; a value
 * that would silently round to zero/lose digits on write must be rejected,
 * not accepted and corrupted):
 *   createAdminIncomeSchema.amount, createUsdtIncomeSchema.amount,
 *   createSeniorIncomeSchema.amount, createDropIncomeSchema.amount,
 *   updateSeniorIncomeSchema.amount, updateDropIncomeSchema.amount,
 *   createExpenseSchema.amount, createSalarySchema.amount (the field named in
 *   the task — `createSalary(amount: 1e-7)` used to validate and land as
 *   `0.000000`), createAdminTransferSchema.amount,
 *   adminUpdateTransactionSchema.amount, createDividendSchema.amount (no
 *   pre-existing ceiling — the floor does not add one; "no balance gate" is
 *   an unrelated, untouched business decision), and
 *   updateProjectFinanceSettingsSchema.juniorSalaryOverride (its OWN floor —
 *   `numeric(10,2)`, not `(18,6)`; feeds the `createMonthlySalaries` cron
 *   insert directly, bypassing `createSalarySchema` entirely).
 *
 * MED-1 (security-review): `juniorSalaryOverride` is only HALF of
 * `createMonthlySalaries`' `salaryAmount = juniorSalaryOverride ??
 * user.monthlySalary` expression — the OTHER operand, `users.monthly_salary`
 * (same `numeric(10,2)` scale), was reachable via THREE more unguarded write
 * paths outside this file (`createUserSchema`/`adminUpdateUserSchema` in
 * `users.ts`, `changeSalarySchema` in `admin-actions.ts`) and a SECOND direct
 * cron insert (`amount: emp.monthlySalary`, HR/ACCOUNTANT) that bypasses
 * `createSalarySchema` exactly like the JUNIOR one does. All four now run the
 * SAME shared `withSalaryFloor`/`salaryAmountFloorError` in `./money` — see
 * that file's module comment for the full write-path map, AND for exactly
 * what that floor does and does not close (it rejects a value strictly
 * BELOW one storable unit; an explicit `0` is unaffected by design, and
 * still reaches `paySalary` with no further check when `paidAmount` is
 * omitted — a separate, open business question, not a gap in this floor).
 *
 * HAND-ENTERED — already floored (security-review PR #485, untouched here):
 *   paySalarySchema.paidAmount (`transactionAmountError`).
 *
 * COMPUTED or READ-ONLY — deliberately left WITHOUT a floor. A floor here
 * would reject a legitimate long-tail float (e.g. `income * 0.5` →
 * `333.33333333333337`) as if it were a typo — the exact trap this task
 * warns against. Every one of these is either a server-derived aggregate
 * (income × percent splits, sums, balances) or a plain read-DTO mirror of a
 * row whose WRITE side is already covered above:
 *   transactionSchema.{amount,originalAmount,exchangeRate},
 *   payoutRequestSchema.{incomeAmount,payableAmount},
 *   projectFinanceSettingsSchema.juniorSalaryOverride (read mirror of the
 *   now-floored write side), pendingObligationSchema.amount (booked as
 *   `share% × income` by bookCompanyObligations — see `settledAmountError`'s
 *   comment in exchange-rate.util.ts for the sibling rule that governs a
 *   computed figure), cryptoRecipientSchema.amount (Phase 4-B split math),
 *   balanceSchema.balance, totalEarnedSchema.totalEarned,
 *   dropSelfSummarySchema.{balance,debtToCompany,pendingObligationAmount},
 *   dropIncomeDtoSchema.amount, dropPaymentDtoSchema.amount,
 *   financeSummarySchema.{totalIncome,totalExpenses,totalSalaries,netBalance,
 *   adminBalances[].balance,dropBalances[].balance,monthly[].*},
 *   accountantSummarySchema.{pendingValidation,validatedThisMonth,
 *   paidThisMonth}.amount, seniorMonthlyEarningSchema.amount,
 *   seniorSummarySchema.seniorShareIncome.{total,thisMonth},
 *   seniorEarningsStatsSchema.lastMonthIncome, companyAccountSchema.balance,
 *   companyDepositSchema.amountUsdt, depositStatusSchema.amountUsdt
 *   (Etherscan-verified on-chain, never typed).
 */

/**
 * BIZ-13 — the single reasonable ceiling every money amount in this module is
 * capped by. Was a bare `500_000` literal repeated at ~10 call sites (each with
 * its own `// BIZ-13` comment); named here so a new amount field (e.g.
 * task-salary-pay-amount's `paidAmount`) can carry PROVABLY the same ceiling as
 * `createSalarySchema.amount` — referencing one symbol rather than re-typing a
 * literal that could silently drift.
 */
export const MAX_TRANSACTION_AMOUNT = 500_000

// `AMOUNT_DECIMAL_PLACES` / `MIN_TRANSACTION_AMOUNT` / `decimalPlacesOf` /
// `moneyFloorAndPrecisionError` / `withMoneyFloor` live in `./money` — see
// that file's module comment for why (BLOCKER round: the mutation-testing
// blind spot that made a suppression here unavoidable while the function
// stayed in THIS file, which consumes it 11 times at module-import time).

/**
 * The ONE definition of "is this a storable money amount", shared verbatim by
 * the Zod boundary, the service's defense-in-depth re-check and the client's
 * inline validation — so the three can never disagree about what is accepted or
 * about what the user is told. Returns a stable `zod.<CODE>` key (see
 * `zod-errors.ts`), or
 * `null` when the amount is fine.
 *
 * Order matters: a too-small value is reported as too small, not as
 * "too many decimals" (which is true of `1e-7` as well, but useless to read).
 */
export function transactionAmountError(value: number): string | null {
  if (!Number.isFinite(value)) return 'zod.AMOUNT_NOT_A_NUMBER'
  if (value <= 0) return 'zod.AMOUNT_MUST_BE_POSITIVE'
  if (value > MAX_TRANSACTION_AMOUNT) {
    return 'zod.TRANSACTION_AMOUNT_EXCEEDS_MAX'
  }
  // Floor + precision — delegates to the SAME function `./money`'s own
  // 11 module-import-time callers use (task-i18n-stage4-task4, COPY-M-shared-10
  // dedup): this used to repeat `moneyFloorAndPrecisionError`'s two branches
  // verbatim. Order is unaffected — a value cannot be both `< MIN_TRANSACTION_AMOUNT`
  // and `> MAX_TRANSACTION_AMOUNT` at once (MIN < MAX), so moving the max
  // check ahead of the delegated floor+precision check cannot change which
  // branch a given value hits.
  return moneyFloorAndPrecisionError(value)
}

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
 * MED-2 fix: receiptExternalUrl is scheme-restricted via an explicit refine
 * on top of .url() — blocks javascript:/data: XSS vectors that .url() alone
 * does not reject in all Zod versions.
 *
 * fix/external-receipt-rendering: tightened from http(s) to https-only for
 * NEW input. `http://` already silently failed for the viewer (mixed content
 * — the site is https, and `img-src`/CSP allow `https:` only), so accepting
 * it here just deferred a guaranteed-broken value to render time. This is the
 * WRITE-side schema only; the READ-side `transactionSchema.receiptExternalUrl`
 * above still accepts `^https?://` so already-saved http:// rows keep parsing
 * and displaying (their "Open receipt" link still works — only the embed is
 * skipped, see `receipt-panel.tsx`).
 */
export const receiptFields = {
  receiptDocumentId: z.string().uuid().optional().nullable(),
  receiptExternalUrl: z
    .string()
    .url()
    .refine((v) => /^https:\/\//i.test(v), {
      message: 'Receipt URL must use https scheme',
    })
    .optional()
    .nullable(),
}

export const receiptXor = (data: {
  receiptDocumentId?: string | null | undefined
  receiptExternalUrl?: string | null | undefined
}) => !(data.receiptDocumentId && data.receiptExternalUrl)

export const receiptXorMessage = {
  message: 'Receipt must be either a document upload OR an external URL — not both',
  path: ['receiptExternalUrl'],
}

// ---------------------------------------------------------------------------
// Mandatory receipt + blockchain-explorer allowlist (task-receipts-backend)
// ---------------------------------------------------------------------------

/**
 * Blockchain-explorer host allowlist — the SINGLE source of truth for both the
 * frontend hint and the backend validation (pm-brief §5). A USDT-currency
 * transaction's receipt MUST be a link to one of these explorers (a file is NOT
 * accepted); partners often send TRC-20 from Tron because of the cheap fees, so
 * the list spans the networks where USDT realistically moves. The owner may
 * widen / narrow this set — it is config, not logic.
 */
export const BLOCKCHAIN_EXPLORER_HOSTS: ReadonlySet<string> = new Set([
  'etherscan.io', // Ethereum ERC-20 (canonical — verified in etherscan.service.ts)
  'tronscan.org', // Tron TRC-20
  'bscscan.com', // BNB Chain BEP-20
  'polygonscan.com', // Polygon
  'arbiscan.io', // Arbitrum
  'basescan.org', // Base
  'optimistic.etherscan.io', // Optimism
  'snowtrace.io', // Avalanche C-Chain
])

/**
 * True iff `url` is an https link to a known blockchain-explorer host with a
 * non-empty path (a bare host is not a transaction proof). Host match is
 * case-insensitive with a leading `www.` stripped. Rejects non-https, unknown
 * hosts, and `javascript:` / `data:` schemes.
 *
 * Self-contained parsing (no `URL` global — `@crm/shared` targets a minimal lib
 * consumed by both Node and the browser) with exact host match, so a look-alike
 * like `etherscan.io.evil.com`, `evil.com/etherscan.io`, or a userinfo trick
 * `etherscan.io@evil.com` all fail. Any `@` (userinfo) or `:` (port) is stripped
 * from the authority before the allowlist check.
 */
export function isExplorerUrl(url: string): boolean {
  // Require https + capture the authority (up to the first / ? or #) and rest.
  // Stryker disable next-line Regex: equivalent mutant - making the ([/?#].*) group mandatory only turns a bare host into a regex miss, which already returns false via the rest.length > 0 check (400k-input differential fuzz, 0 diffs)
  const match = /^https:\/\/([^/?#]+)([/?#].*)?$/i.exec(url)
  if (!match) return false
  let authority = match[1]!.toLowerCase()
  // Strip userinfo (`user:pass@host`) — keep only the segment after the last `@`.
  const atIdx = authority.lastIndexOf('@')
  // Stryker disable next-line ConditionalExpression: equivalent mutant - for atIdx === -1, slice(atIdx + 1) is slice(0), a no-op, so the condition is irrelevant (400k-input differential fuzz, 0 diffs)
  if (atIdx >= 0) authority = authority.slice(atIdx + 1)
  // Strip the port.
  const colonIdx = authority.indexOf(':')
  // Stryker disable next-line EqualityOperator: equivalent mutant - colonIdx === 0 means the authority starts with ':', which is not an allowlisted host whether or not it is sliced to '' (verified by differential fuzz, 0 diffs)
  if (colonIdx >= 0) authority = authority.slice(0, colonIdx)
  const host = authority.replace(/^www\./, '')
  if (!BLOCKCHAIN_EXPLORER_HOSTS.has(host)) return false
  // Require SOMETHING after the host (path, query, OR fragment) — a bare host
  // ('' or a lone '/') is not a tx proof. Do NOT strip the fragment first:
  // hash-routed explorers keep the tx id in the fragment, e.g.
  // tronscan.org/#/transaction/<hash>.
  // Stryker disable next-line Regex: equivalent mutant - dropping the ^ anchor removes the first '/' anywhere; a remainder not starting with '/' keeps its first char, so rest.length > 0 is unchanged (verified by differential fuzz, 0 diffs)
  const rest = (match[2] ?? '').replace(/^\//, '')
  return rest.length > 0
}

type ReceiptShape = {
  receiptDocumentId?: string | null | undefined
  receiptExternalUrl?: string | null | undefined
}

/**
 * Pure, framework-agnostic receipt validator SHARED by the Zod refine (client +
 * controller boundary) and the service defense-in-depth re-check. Returns a
 * stable `zod.<CODE>` key (fix-round 1, COPY-H-2 — this used to return a raw
 * English literal because of dual-use across many `apps/api` direct-throw
 * call sites outside this task's original scope; the orchestrator's
 * fix-round decision reverses that: the code is registered like every other
 * message in this file, and those throw-sites now resolve it via
 * `zodErrorBadRequest` (`apps/api/src/common/zod-error-exception.ts`), which
 * itself delegates to `zodErrorFallbackText` — the ONE place that owns the
 * `code → EN fallback` mapping (fix-round 2, CR-M-2) — instead of getting a literal
 * for free — see each call site), or `null` when the receipt is valid for the
 * given EFFECTIVE currency. Rules (pm-brief §4/§6):
 *   - exactly ONE of receiptDocumentId / receiptExternalUrl (mandatory — neither
 *     present → error; both present → error);
 *   - effective currency === 'USDT' → receiptExternalUrl REQUIRED and MUST pass
 *     isExplorerUrl; receiptDocumentId FORBIDDEN (a file is not accepted);
 *   - otherwise → a file OR any http(s) url is accepted.
 */
export function receiptMandatoryError(
  receipt: ReceiptShape,
  effectiveCurrency: string | undefined,
): string | null {
  const hasDoc = !!receipt.receiptDocumentId
  const hasUrl = !!receipt.receiptExternalUrl
  if (hasDoc && hasUrl) {
    return 'zod.RECEIPT_BOTH_NOT_ALLOWED'
  }
  if (!hasDoc && !hasUrl) {
    return 'zod.RECEIPT_REQUIRED'
  }
  if (effectiveCurrency === 'USDT') {
    if (hasDoc) {
      return 'zod.RECEIPT_USDT_LINK_ONLY'
    }
    if (!isExplorerUrl(receipt.receiptExternalUrl!)) {
      return 'zod.RECEIPT_USDT_LINK_REQUIRED'
    }
  }
  return null
}

/**
 * superRefine factory that makes the receipt MANDATORY + currency-aware on
 * create/pay schemas. `getCurrency` derives the EFFECTIVE currency from the
 * parsed data (e.g. `data.currency`, the `USDT` literal, or
 * `COMPANY_ACCOUNT → 'USDT'` for salary/settle). Delegates the rule set to the
 * shared `receiptMandatoryError` so the client, the controller and the service
 * never drift. IMPORTANT: the receipt fields stay optional in the object shape
 * (so the inferred DTO type keeps them optional and frontend call-sites that
 * have not yet added the receipt still TYPE-check); the requirement is enforced
 * at PARSE time (400), not at the type level.
 */
export function mandatoryReceiptRefine<T extends ReceiptShape>(
  getCurrency: (data: T) => string | undefined,
) {
  return (data: T, ctx: z.RefinementCtx): void => {
    const message = receiptMandatoryError(data, getCurrency(data))
    if (message) {
      ctx.addIssue({
        code: 'custom',
        message,
        path: data.receiptDocumentId ? ['receiptDocumentId'] : ['receiptExternalUrl'],
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Sender/receiver invariant (task-sender-receiver-invariant, backlog A-2)
// ---------------------------------------------------------------------------

/**
 * Pure, framework-agnostic mirror of the DB-level
 * `ck_transactions_sender_ne_receiver` CHECK on `transactions`
 * (`sender_id <> receiver_id`, see the constraint's doc comment in
 * `apps/api/src/database/schema.ts`) — SAME shape as `receiptMandatoryError`
 * above: one function, called wherever a write path needs a friendly 400
 * INSTEAD of letting the constraint reject the INSERT/UPDATE as a raw
 * Postgres error.
 *
 * Mirrors the DB's SQL three-valued-logic semantics exactly, on purpose:
 * `senderId === receiverId` only ever returns an error when BOTH are
 * non-null AND equal. Either side `null`/`undefined` always passes — most
 * `transactions` rows legitimately carry one or both sides empty (a
 * company-labelled sender via `senderLabel`, an obligation row with no
 * `senderId` yet, …), exactly the case the DB CHECK's `<>` (not
 * `IS DISTINCT FROM`) was chosen to keep passing.
 *
 * security-review round 2 (MED-2): compares CASE-INSENSITIVELY. Postgres's
 * `uuid` column type normalises on comparison — `'AAAA…'::uuid =
 * 'aaaa…'::uuid` is TRUE — so the DB CHECK this function mirrors would
 * reject two differently-cased strings that name the SAME row. A naive `===`
 * would not: it treats them as different and lets the INSERT/UPDATE through
 * to fail on the constraint with an opaque 500, defeating the entire point
 * of this function (AC4 — a friendly 400 BEFORE the DB). Reachable in
 * practice on `createAdminTransfer`'s ACCOUNTANT path, where `senderId` is a
 * raw client-supplied UUID string (case not normalised by Zod's `.uuid()`,
 * which is format-only) compared against `receiver.id`, always
 * lower-case as returned by Postgres.
 */
export function selfPayError(
  senderId: string | null | undefined,
  receiverId: string | null | undefined,
  // Default is the coded key (fix-round 1, COPY-H-2 — same treatment as
  // `receiptMandatoryError` above), translated through `zodErrorBadRequest` /
  // `translateZodMessage` at every call site. fix-round 2 (COPY-M-12):
  // `transactions.service.ts`'s `createAdminTransfer` used to override this
  // with its own literal (`'Cannot transfer to yourself'`) — an
  // untranslated English duplicate of the SAME refusal every other self-pay
  // check already speaks through the registry. That override is gone; EVERY
  // caller now goes through this one default, so there is exactly one
  // sentence for "sender and receiver cannot be the same", not two.
  message = 'zod.SENDER_RECEIVER_SAME',
): string | null {
  if (
    senderId != null &&
    receiverId != null &&
    senderId.toLowerCase() === receiverId.toLowerCase()
  ) {
    return message
  }
  return null
}

// Shared superRefine guard: when fundingSource = COMPANY_ACCOUNT an explicit
// non-USDT currency is a client bug (company account is USDT-only). The service
// also forces USDT, but surfacing the contradiction early gives a clear error.
// Extracted so SALARY / EXPENSE / ADMIN_INCOME schemas stay byte-for-byte
// consistent (DRY — single rule, no drift).
export function refineCompanyAccountUsdt(
  data: {
    fundingSource?: 'COMPANY_ACCOUNT' | 'ADMIN_PERSONAL' | undefined
    currency?: string | undefined
  },
  ctx: z.RefinementCtx,
): void {
  if (
    data.fundingSource === 'COMPANY_ACCOUNT' &&
    data.currency !== undefined &&
    data.currency !== 'USDT'
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'zod.COMPANY_ACCOUNT_USDT_ONLY',
      path: ['currency'],
    })
  }
}

// Shared refine: when receiverId = COMPANY_ACCOUNT_RECEIVER an explicit
// non-USDT currency is a client bug (the company account is USDT-only). The
// service also forces USDT server-side; surfacing the contradiction early
// gives a clear error. task-admin-income-unified: keyed on `receiverId`, the
// SAME field `createUsdtIncomeSchema` uses (no second "which account" field).
export function refineAdminIncomeCompanyAccountUsdt(
  data: { receiverId?: string | undefined; currency?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (
    data.receiverId === COMPANY_ACCOUNT_RECEIVER &&
    // Stryker disable next-line ConditionalExpression: empirically verified (direct console instrumentation of this function, both createAdminIncomeSchema call sites) — Zod v4 never INVOKES this superRefine at all when `currency` itself fails its own `z.enum([...])` validation (confirmed for both an omitted key and an explicit invalid value); it only calls this function once `currency` has already parsed to a real enum member. So whenever this line executes, `data.currency !== undefined` is unconditionally true — not by this guard, but by the field having already been validated upstream. The `string | undefined` parameter type is defensive for the shared-helper shape, not evidence this branch is reachable-as-false here.
    data.currency !== undefined &&
    data.currency !== 'USDT'
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'zod.COMPANY_ACCOUNT_USDT_ONLY',
      path: ['currency'],
    })
  }
}

/**
 * A real Ethereum transaction hash ANYWHERE in the input — deliberately
 * NON-anchored so one rule covers both a bare hash and an explorer link
 * (`https://etherscan.io/tx/0x…`).
 *
 * SECURITY (security-review PR #438, HIGH-1): this is the SINGLE definition of
 * "what is a real on-chain hash" for the whole system. It used to be three
 * different rules — an anchored `^0x[0-9a-f]{64}$` in the consumed-hash
 * registry, a non-anchored one in `submitDeposit`, and a bare
 * `length >= 10` in `manualConfirmPayout` — and the gap between them WAS an
 * exploit: a manual confirmation pasted as an explorer LINK credited the
 * company account while the registry's anchored regex saw "not a hash" and
 * silently skipped the claim, so the same transfer could then be credited a
 * second time as a deposit.
 */
export const ON_CHAIN_TX_HASH_RE = /0x[0-9a-fA-F]{64}/

/**
 * Extract the real on-chain tx hash from a bare hash OR an explorer link,
 * normalised to lowercase. Returns null when the input carries no real hash.
 *
 * `null` also (correctly) covers the synthetic audit markers `0xSIM…` /
 * `0xMANUAL…`: their prefixes are not hex, so no `0x`+64hex substring exists.
 * They reference no on-chain transfer and must never be registered.
 *
 * Lives in `@crm/shared` so the Zod write-boundary and every server path apply
 * the IDENTICAL rule (a divergence between them is the bug this closes).
 */
export function extractOnChainTxHash(raw: string | null | undefined): string | null {
  const match = ON_CHAIN_TX_HASH_RE.exec(
    // Stryker disable next-line MethodExpression: equivalent mutant - ON_CHAIN_TX_HASH_RE is unanchored and a 0x+64-hex match cannot contain whitespace, so trim() cannot change whether or what it matches
    raw?.trim() ??
      // Stryker disable next-line StringLiteral: equivalent mutant - the fallback only feeds the unanchored hash regex; any non-hash string (including the mutated one) yields no match, same as ''
      '',
  )
  return match ? match[0].toLowerCase() : null
}

/**
 * task-salary-pay-amount — relative deviation above which a hand-entered paid
 * amount is worth warning about.
 *
 * 5%: comfortably above a real bank/exchange spread over the NBU reference rate
 * the expectation is derived from (typically 1-3%, occasionally ~4% for cash),
 * so an honest payment at the payer's own rate does NOT nag; and vastly below
 * the order-of-magnitude slip this exists to catch (300 typed instead of
 * 30 000 = 99% deviation). Deliberately a WARNING, never a block — the owner
 * may legitimately pay at a rate we have no way of knowing, and the payment
 * closes the obligation in full either way, so a hard gate would only teach
 * people to work around it.
 */
export const SALARY_PAID_AMOUNT_WARN_THRESHOLD = 0.05

/**
 * Relative deviation of an entered `paidAmount` from the rate-derived
 * expectation, or `null` when it is within tolerance / not comparable.
 *
 * Returns a fraction (0.99 = "differs by 99%") so the caller renders the
 * number in its own copy. Shared (not UI-local) because it is the pure,
 * unit-testable core of the typo guard — and because the SAME rule must hold
 * wherever a paid amount is entered next.
 */
export function salaryPaidAmountDeviation(
  paidAmount: number,
  expectedAmount: number,
  threshold: number = SALARY_PAID_AMOUNT_WARN_THRESHOLD,
): number | null {
  // Not comparable: no usable expectation (rates not loaded, zero/garbage
  // obligation) or no usable input yet — say nothing rather than cry wolf.
  if (!Number.isFinite(paidAmount) || !Number.isFinite(expectedAmount)) return null
  if (expectedAmount <= 0 || paidAmount <= 0) return null
  const deviation = Math.abs(paidAmount - expectedAmount) / expectedAmount
  return deviation > threshold ? deviation : null
}
