/**
 * Pending senior settlement service.
 *
 * task-drop-company-debt-and-invoices (post Phase 4 refactor):
 *
 * Senior share from drop-projects is owed by **the COMPANY**, not by the
 * DROP user. The new flows:
 *
 *   debtorType='COMPANY': both crypto + cash channels create a
 *   SENIOR_PENDING_PAYOUT (debtor=COMPANY) immediately after the
 *   drop→company payment is recorded. The senior balance only moves once
 *   ACCOUNTANT/ADMIN closes the obligation via `settleByCompany`, which
 *   (task-settle-in-place, ADR 2026-07-14):
 *     - flips the source IOU row (SENIOR_PENDING_PAYOUT) → SENIOR_INCOME
 *       (status=PAID, the legal invoice type) IN PLACE — no second row,
 *     - marks the obligation PAID (closingTransactionId = the flipped row),
 *     - triggers `autoCreateForSeniorPayout(<flipped id>)` so the
 *       senior receives a signable invoice mirroring the existing
 *       payPayoutRequest cascade.
 *
 *   The DROP user no longer holds any debt to the senior and has no UI
 *   to close one — `listDropObligations` + `settleByDrop` are removed.
 *
 * Legacy values remain readable:
 *   debtorType='DROP' — historical pre-refactor cash rows. We still list
 *   them under `listSeniorObligations` so the senior view shows them.
 *   debtorType='TOV'  — bank channel rows (read endpoints filter them out).
 *
 * Read endpoints:
 *   - `listSeniorObligations` — SENIOR sees own; ADMIN/ACCOUNTANT see all
 *     active COMPANY-debt + legacy DROP-debt obligations.
 *   - `listCompanyObligations` — ADMIN/ACCOUNTANT-only view of pending
 *     COMPANY debts to seniors. Used by the new finance page card.
 *
 * The DTO denormalises debtor/senior/project names so the UI cards render
 * without follow-up requests.
 */
import { forwardRef, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common'
import { and, eq, inArray } from 'drizzle-orm'
import {
  COMPANY_ACCOUNT_LABEL,
  kyivToday,
  MAX_TRANSACTION_AMOUNT,
  receiptMandatoryError,
  selfPayError,
} from '@crm/shared'
import type {
  PendingSettlementItemDto,
  PendingObligationDto,
  SessionUser,
  TransactionDto,
} from '@crm/shared'
import { apiError } from '../common/api-error'
import { zodErrorBadRequest } from '../common/zod-error-exception'
import { DatabaseService } from '../database/database.service'
import {
  pendingObligations,
  transactionAuditLog,
  users,
  type Transaction,
} from '../database/schema'
import { InvoicesService } from '../invoices/invoices.service'
import { COMPANY_ACCOUNT_FUNDING_SOURCE } from './company-account-balance'
import { settleObligationInTx } from './pending-settlement-tx.util'
import { assertReceiptDocumentBindable } from './receipt.util'
import { NbuCurrencyService } from './nbu-currency.service'
import type { BalanceCurrency } from './balance.service'
import { settledAmountError, throwSettledAmountError } from './exchange-rate.util'
import { parseTransactionBusinessDate } from './transaction-date.util'
import { toObligationDto, toTransactionDto } from './pending-settlement-mapper.util'
import {
  denormalise,
  loadObligation as loadObligationRead,
  resolveSource,
} from './pending-settlement-read.util'
import { assertSettleCurrencyAllowed, isUsdPegPair } from './settle-currency.util'
import {
  assertDropCurrencyInvariants,
  convertDropPayoutAmount,
  finalizeDropPayout,
  isFundingSourceMismatch,
  remainingOwed,
  resolveCompanyDebit,
  resolveSettleCurrency,
} from './pending-settlement-arithmetic.util'

/**
 * task-senior-settle-owner: the pay-time funding selection for a senior IOU
 * settlement. Identical contract to paySalary — the ADMIN/ACCOUNTANT picks the
 * source (shared company account vs an admin partner's personal account) and,
 * for ADMIN_PERSONAL, which admin paid.
 *   - COMPANY_ACCOUNT → currency forced USDT, debits the shared account.
 *   - ADMIN_PERSONAL  → payerAdminId (validated ADMIN) is the sender; the
 *     company account is untouched.
 *
 * task-remove-settle-currency (2026-07): `currency` is OPTIONAL — a SENIOR
 * settle still never sends one (every senior obligation is denominated in
 * USDT; see transactions.service.ts createIous). When omitted,
 * `settleByCompany` defaults it to `obligation.currency` (always USDT in
 * practice). It stays on the type (not removed) so a defensive/legacy caller
 * that still passes an explicit currency keeps working — the BIZ-03 guard
 * below still validates it when present.
 *
 * task-drop-payout-currency (2026-08): a DROP settle DOES now send `currency`
 * explicitly — the owner-facing dialog lets the recipient's payout be paid in
 * any of the four currencies. See the amount-conversion block in
 * `settleByCompany` for how the actual paid figure is derived (never trusted
 * from the client — there is nothing to trust, the dialog's amount field is
 * fully disabled).
 *
 * task-drop-payout-currency (owner addendum, 2026-08): `txDate` — the
 * operator-selected date this settlement is recorded as of. DROP-only (a
 * SENIOR settle's dialog never renders the picker and never sends this).
 * Governs BOTH which day's NBU rate computes `paidAmount` AND the flipped
 * row's `txDate` column — see the amount-conversion block below. Optional:
 * every caller that predates this feature (legacy route, e2e fixtures, unit
 * specs) omits it and gets byte-for-byte the pre-existing behaviour ("now").
 */
export type SettleFunding = {
  fundingSource: 'COMPANY_ACCOUNT' | 'ADMIN_PERSONAL'
  payerAdminId?: string | undefined
  currency?: 'USDT' | 'USD' | 'EUR' | 'UAH' | undefined
  txDate?: string | null | undefined
  // task-receipts-backend (#10): mandatory settle proof — currency-aware
  // (COMPANY_ACCOUNT → USDT → explorer-only; ADMIN_PERSONAL USD → file/url).
  receiptDocumentId?: string | null | undefined
  receiptExternalUrl?: string | null | undefined
}

@Injectable()
export class PendingSettlementService {
  private readonly logger = new Logger(PendingSettlementService.name)

  constructor(
    private readonly db: DatabaseService,
    @Inject(forwardRef(() => InvoicesService))
    private readonly invoicesService: InvoicesService,
    // task-drop-payout-currency: NBU rates for converting a DROP obligation's
    // USDT-booked amount into whichever currency the payout is settled in.
    // SENIOR settlements never reach the branch that uses this.
    private readonly nbuCurrency: NbuCurrencyService,
  ) {}

  // ── Read endpoints ────────────────────────────────────────────────────────

  /**
   * SENIOR self-view: returns own PENDING obligations (COMPANY-debt + legacy
   * DROP-debt for backwards compatibility). ADMIN/ACCOUNTANT: returns every
   * PENDING obligation across all seniors. TOV-debtor history rows are
   * intentionally excluded.
   */
  async listSeniorObligations(actor: SessionUser): Promise<PendingSettlementItemDto[]> {
    if (actor.role !== 'SENIOR' && actor.role !== 'ADMIN' && actor.role !== 'ACCOUNTANT') {
      throw apiError('FINANCE_PENDING_ACCRUALS_LIST_FORBIDDEN', HttpStatus.FORBIDDEN)
    }
    const conjuncts: Array<ReturnType<typeof eq>> = [eq(pendingObligations.status, 'PENDING')]
    // Include both new COMPANY-debt rows and legacy DROP-debt rows so the
    // senior view continues to show pre-refactor obligations.
    if (actor.role === 'SENIOR') {
      conjuncts.push(eq(pendingObligations.creditorUserId, actor.id))
    }
    const rows = await this.db.db.query.pendingObligations.findMany({
      where: and(...conjuncts, inArray(pendingObligations.debtorType, ['COMPANY', 'DROP'])),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    })
    return denormalise(this.db.db, rows)
  }

  /**
   * Company-debt view. ADMIN/ACCOUNTANT-only — DROP no longer has any
   * obligations to close. Returns every PENDING obligation with
   * debtorType='COMPANY'.
   */
  async listCompanyObligations(actor: SessionUser): Promise<PendingSettlementItemDto[]> {
    if (actor.role !== 'ADMIN' && actor.role !== 'ACCOUNTANT') {
      throw apiError('FINANCE_COMPANY_OBLIGATIONS_LIST_FORBIDDEN', HttpStatus.FORBIDDEN)
    }
    const rows = await this.db.db.query.pendingObligations.findMany({
      where: and(
        eq(pendingObligations.status, 'PENDING'),
        eq(pendingObligations.debtorType, 'COMPANY'),
      ),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    })
    return denormalise(this.db.db, rows)
  }

  // ── Settle endpoints ──────────────────────────────────────────────────────

  /**
   * Close a COMPANY-debt obligation. RBAC: ACCOUNTANT / ADMIN only. DROP is
   * explicitly forbidden — they no longer hold or close senior debts.
   *
   * task-settle-in-place (ADR 2026-07-14): the settlement transitions the source
   * IOU row (`*_PENDING_PAYOUT`) PENDING_PAYMENT → PAID **in place** — it does NOT
   * insert a second transaction. The row flips to its final type
   * (SENIOR_PENDING_PAYOUT → SENIOR_INCOME, DROP_PENDING_PAYOUT → PAYOUT_DROP),
   * so there is no lingering "Ожидает выплаты" phantom.
   *
   * Atomic cascade:
   *   - Conditional UPDATE `pending_obligations` PENDING → PAID (TOCTOU money
   *     gate; the loser of a double-settle rolls back with no money write).
   *   - For a company-funded settle: advisory-lock the company account + refuse
   *     to drive the balance negative.
   *   - UPDATE the SOURCE IOU row in place → final type + status=PAID + funding
   *     fields (fundingSource marker, sender, currency, receipt); reset
   *     payoutRequestId; SENIOR_INCOME is the legally signable invoice type per
   *     InvoicesService.autoCreateForSeniorPayout.
   *   - Patch obligation → closingTransactionId = sourceTransactionId (self).
   *   - Trigger `autoCreateForSeniorPayout(<flipped SENIOR_INCOME id>)` outside
   *     the transaction so a failing PDF/S3 step doesn't roll back the closure.
   */
  async settleByCompany(
    obligationId: string,
    actor: SessionUser,
    funding?: SettleFunding,
  ): Promise<{ obligation: PendingObligationDto; created: TransactionDto[] }> {
    if (actor.role !== 'ADMIN' && actor.role !== 'ACCOUNTANT') {
      throw apiError('FINANCE_COMPANY_OBLIGATION_CLOSE_FORBIDDEN', HttpStatus.FORBIDDEN)
    }

    const obligation = await this.loadObligation(obligationId)
    if (obligation.debtorType !== 'COMPANY' && obligation.debtorType !== 'DROP') {
      // Keep legacy 'DROP'-debt closeable through this endpoint so admins
      // can clean up pre-refactor rows the same way.
      throw apiError('FINANCE_OBLIGATION_NOT_COMPANY_TYPE', HttpStatus.BAD_REQUEST)
    }
    // NOTE: this is only a fast-fail UX gate read OUTSIDE the transaction; it is
    // NOT the authority. The PENDING→PAID transition is decided atomically by the
    // conditional UPDATE inside the transaction below (see SECURITY note), which
    // is the single source of truth against a double-settle race.
    if (obligation.status !== 'PENDING') {
      throw apiError('FINANCE_OBLIGATION_ALREADY_CLOSED', HttpStatus.BAD_REQUEST)
    }

    // We only need the source IOU's TYPE (the drop-vs-senior discriminator),
    // its `dropCascadeOrigin` marker (cascade-vs-declaration discriminator —
    // see the guard below, since PR #443 HIGH-1/MED-B), and — task-settled-
    // amount-snapshot — its CURRENT share-percent snapshot and settled-
    // currency label. All five are read HERE, before the transaction.
    //
    // security-review round 1 (MED-3, PR #599): a PRIOR version of this
    // comment claimed the conditional claim on `pending_obligations` (below)
    // protects THIS pre-transaction read. That is imprecise — the claim is a
    // conditional UPDATE on the `pending_obligations` row, it never locks
    // `transactions`. The ACTUAL invariant that makes a pre-transaction read
    // of `sourceType`/`sourceDropCascadeOrigin`/the share-percent columns
    // safe is: the partial unique index
    // `uq_pending_obligations_source_pending` (schema.ts) permits AT MOST
    // ONE `PENDING` `pending_obligations` row per `sourceTransactionId` at a
    // time, and the flip below is itself gated on
    // `transactions.status = 'PENDING_PAYMENT'`. Together they mean at most
    // one settle of a given source row can be in flight at any moment — a
    // second concurrent settle of the SAME row is rejected at the DB before
    // it could ever race this read. (`settled_amount` itself no longer
    // depends on this invariant at all — see the DB-native `coalesce(...)
    // + delta` increment below, which is correct even if this invariant is
    // ever weakened.) The flipped row keeps its own projectId booked on the
    // IOU — no re-stamp.
    const {
      sourceType,
      sourceDropCascadeOrigin,
      sourceSeniorSharePercent,
      sourceDropSharePercent,
      sourceSettledCurrency,
      sourceSettledAmount,
      sourceFundingSource,
      sourceSenderId,
      sourceSenderLabel,
      sourceTxDate,
      sourceCreatedAt,
    } = await resolveSource(this.db.db, obligation.sourceTransactionId)

    // `remainingOwed` (pure, pending-settlement-arithmetic.util.ts) is the one
    // description of "still owed", called from BOTH the pre-transaction
    // computation and the money gate inside the transaction.
    const priorSettledAmount = Number(sourceSettledAmount ?? 0)

    // task-drop-share-override-and-receiver (D5). Branch by the source IOU type:
    //   - DROP_PENDING_PAYOUT → settle by flipping the SOURCE row in place to
    //     PAYOUT_DROP (PAID — task-settle-in-place, ADR 2026-07-14; NOT a
    //     second inserted row) that credits the drop's balance
    //     (computeDropAggregate.received). NO senior invoice (Q6 — a drop
    //     settlement is an internal payout). Booked either by
    //     declareUsdtProjectIncome (payoutRequestId=null) or, since PR #443
    //     (task-drop-share-pending-parity), by the drop-payout cascade itself
    //     (payoutRequestId set — see the HIGH-1 funding-source guard above).
    //   - anything else (SENIOR_PENDING_PAYOUT / legacy) → existing SENIOR_INCOME
    //     branch + autoCreateForSeniorPayout. UNCHANGED.
    // pending_obligations does not store the creditor role, so the source
    // transaction type is the discriminator (mirrors the docstring contract).
    const isDropObligation = sourceType === 'DROP_PENDING_PAYOUT'

    // task-drop-topup (task 3b): the blanket refusal of a drop top-up
    // (`isDropObligation && priorSettledAmount > 0`) USED TO STAND HERE, and
    // removing it is the content of that task.
    //
    // What it was protecting: on a drop row `amount` sits next to
    // `originalAmount`/`originalCurrency`/`exchangeRate`, and those three
    // described exactly ONE conversion, so a second payment broke
    // `amount = originalAmount × exchangeRate`. The triplet now describes the
    // CLOSURE rather than one payment (addendum 3b, 1.4), `amount` accumulates
    // by the same expression as the accumulator (below), and the one premise
    // the new arithmetic rests on — both payments at the same rate — is
    // asserted explicitly where the rate is stamped, instead of being inferred
    // from five refusals in three files.
    //
    // The FIRST settle is unaffected either way: with an empty accumulator
    // `owedNow === obligation.amount` and `cumulativePaid === paidAmount`, so
    // every formula below reduces to the one that was there before.

    const { debitsCompanyAccount } = resolveCompanyDebit({
      debtorType: obligation.debtorType,
      funding,
      isDropObligation,
      sourceDropCascadeOrigin,
    })

    let senderId: string | null = null
    let senderLabel: string = COMPANY_ACCOUNT_LABEL
    if (funding && funding.fundingSource === 'ADMIN_PERSONAL') {
      // ADMIN_PERSONAL: paid from an admin partner's personal account. The payer
      // defaults to the calling (ADMIN/ACCOUNTANT) user only when they are an
      // ADMIN; an explicit payerAdminId must resolve to an ADMIN. The company
      // account is NOT touched. Mirrors paySalary.
      const payerAdminId = funding.payerAdminId ?? actor.id
      const payer = await this.db.db.query.users.findFirst({
        where: eq(users.id, payerAdminId),
      })
      if (!payer || payer.role !== 'ADMIN') {
        throw apiError('FINANCE_PAYER_ACCOUNT_MUST_BE_ADMIN', HttpStatus.BAD_REQUEST)
      }
      senderId = payer.id
      senderLabel = payer.displayName
    }
    const currency = resolveSettleCurrency({
      obligationCurrency: obligation.currency,
      funding,
      isDropObligation,
      debitsCompanyAccount,
    })

    // security-review round 2 (MED-1 finding, same shape as `paySalary` —
    // security-reviewer's own linkage): friendly 400 BEFORE the DB CHECK
    // (ck_transactions_sender_ne_receiver) would reject the UPDATE below with
    // an opaque constraint-violation error. This method updates the SAME
    // pre-existing row `paySalary` does (sender resolved here, receiver fixed
    // at IOU-creation time by `bookCompanyObligations`) and, same as there,
    // never re-checks the CREDITOR's current role. `obligation.creditorUserId`
    // is the settling row's `receiverId` — `bookCompanyObligations` stamps
    // both to the SAME id in the SAME insert (senior.id / drop.id), so no
    // extra read is needed.
    //
    // Verified NOT reachable today the same way as `paySalary`: a senior/drop
    // creditor can never become an ADMIN either — `UsersService.changeRole`
    // and `.adminUpdateUser` both refuse `role === 'ADMIN'` unconditionally
    // ("ADMIN pool is fixed"), and only an ADMIN/ACCOUNTANT-verified ADMIN can
    // be an `ADMIN_PERSONAL` payer here. Kept as defense-in-depth for the same
    // reason as `paySalary`'s guard — do not rely on that invariant forever.
    const settleSelfPayErr = selfPayError(senderId, obligation.creditorUserId)
    if (settleSelfPayErr) throw zodErrorBadRequest(settleSelfPayErr)

    // SECURITY (defense-in-depth, security-review PR #381 — BIZ-03 guard bypass
    // on the omitted-currency path): the branches above can leave `currency` at
    // its DEFAULT (`obligation.currency`, declared above and always USDT in
    // practice — see the module-level obligation-creation code) WITHOUT ever
    // going through the explicit-currency re-validation, because
    // task-remove-settle-currency made `funding.currency` optional and a
    // senior settle dialog never sends one. That default path currently
    // relies entirely on the invariant "every pending_obligations row is
    // USDT" — this re-asserts the SAME whitelist against the FULLY-RESOLVED
    // currency so a corrupted/legacy obligation currency can never silently
    // bypass BIZ-03. Covers BOTH funding sources (COMPANY_ACCOUNT is forced to
    // USDT just above — trivially passes). Skipped for a DROP obligation —
    // see the extended comment on `assertSettleCurrencyAllowed`.
    if (!isDropObligation) assertSettleCurrencyAllowed(currency)

    // ── task-drop-payout-currency: the FACT of the payment vs the OBLIGATION ──
    //
    // A DROP obligation is always booked in USDT (see `bookCompanyObligations`
    // in transactions.service.ts). The owner-facing dialog lets the payout be
    // settled in any of the four currencies, but its amount field is fully
    // DISABLED — there is no client-typed figure to trust or distrust, only a
    // conversion to perform. `paidAmount` is therefore computed HERE, from the
    // NBU rate, mirroring `TransactionsService.paySalary`'s original/exchange
    // -rate bookkeeping byte-for-byte (same three columns, same
    // `isStorableExchangeRate` guard) — but with the amount SERVER-derived
    // instead of client-supplied, because (unlike a salary payer settling at
    // their own bank's rate) there is no external fact to record: the payout
    // amount IS the conversion.
    //
    // A SENIOR settlement never enters this block — `paidAmount` stays
    // `undefined` and the flipped row's `amount` column is left untouched,
    // byte-for-byte the pre-existing behaviour.
    let paidAmount: number | undefined
    let originalAmount: string | undefined
    let originalCurrency: 'USDT' | 'USD' | 'EUR' | 'UAH' | undefined
    let exchangeRate: string | null | undefined
    // Business date this settlement is recorded as of. Applies to both
    // SENIOR and DROP settlements; legacy callers that omit it keep the
    // existing source row date untouched.
    let txDateToWrite: Date | undefined
    const selectedDateStr = funding?.txDate ?? undefined
    if (selectedDateStr) {
      const sourceBusinessDate = (sourceTxDate ?? sourceCreatedAt ?? obligation.createdAt)
        .toISOString()
        .slice(0, 10)
      if (selectedDateStr < sourceBusinessDate) {
        throw apiError('FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION', HttpStatus.BAD_REQUEST)
      }
      // SR-809-M-2 = CR-809-H-1: the upper bound. It USED to be an absolute
      // "not after kyivToday()" in `settleSeniorPayoutSchema`, which combined
      // with the lower bound above into an unsatisfiable range whenever the
      // SOURCE row was itself future-dated — min > max, so the obligation could
      // not be settled by anyone, with an empty date picker and no way out.
      //
      // A Zod schema cannot see the source row, so it cannot compute this. Here
      // the source IS known: a settlement may be recorded as of today, or as of
      // the source's own day when that day is still ahead of today — and never
      // later than both. `kyivToday()` is the same business-day clock the
      // pickers and the NBU rate day use.
      // Stryker disable next-line EqualityOperator: PROVABLY equivalent mutant, not an untested guard. Mutating `>` to `>=` changes which BRANCH is taken only in the `sourceBusinessDate === kyivToday()` case — and in that case the two branches return the same string, because the comparison that selected them established the operands are equal. Verified exhaustively over the three orderings (src > today, src === today, src < today): the returned value is identical for all three, so no test can distinguish the mutant. The bound itself IS tested four ways in pending-settlement.spec.ts ("business-date upper bound").
      const latestAllowed = sourceBusinessDate > kyivToday() ? sourceBusinessDate : kyivToday()
      if (selectedDateStr > latestAllowed) {
        throw apiError('FINANCE_TX_DATE_IN_FUTURE', HttpStatus.BAD_REQUEST)
      }
      // This path historically stores an explicitly selected settlement day at
      // UTC midnight, including when the operator selects today. Keep that
      // ledger contract while sharing the strict calendar parser used by the
      // other finance writers.
      txDateToWrite = parseTransactionBusinessDate(selectedDateStr)
    }
    // Stryker disable next-line ConditionalExpression: for a SENIOR settlement this block's four locals are ASSIGNED but never READ — the `.set()` patch below spreads them behind its OWN, separately-tested `isDropObligation` ternary (see the `'originalAmount' in flips[0]!` assertions in pending-settlement.spec.ts), so entering this block unnecessarily has no observable output. It is also provably side-effect-free: a SENIOR obligation is ALWAYS booked in USDT and BIZ-03 restricts a SENIOR settle's currency to USD/USDT — the only pair convertToBase short-circuits WITHOUT calling `this.nbuCurrency.getRates()` — so no stray network call either
    if (isDropObligation) {
      const obligationAmount = parseFloat(obligation.amount)
      // task-drop-topup (task 3b, AC3): what is STILL owed — the figure this
      // settle actually converts and pays. The SAME `remainingOwed` the senior
      // branch uses (one description of "still owed", two call sites), so a
      // top-up pays the remainder rather than the obligation a second time.
      //
      // `obligationAmount` stays a separate local BECAUSE the two are different
      // questions: what is being paid now (`owedNow`) versus what the
      // obligation is worth in total (`obligationAmount`) — the latter is the
      // rate's denominator and the value of `original_amount`.
      //
      // On a first settle the accumulator is NULL, so `owedNow` IS
      // `obligationAmount` and every line below behaves exactly as before.
      const owedNow = remainingOwed(obligation.amount, priorSettledAmount)
      const obligationCurrency = obligation.currency as BalanceCurrency
      const targetCurrency = currency as BalanceCurrency

      assertDropCurrencyInvariants(obligationCurrency, targetCurrency, priorSettledAmount)

      // task-drop-payout-currency (owner addendum): the date-of-record is
      // validated before currency logic. The shared date schema rejects
      // malformed calendar dates and this NBU-priced flow separately rejects
      // future Kyiv days. The lower bound above compares against the source
      // transaction's UTC calendar key, matching how txDate stores a selected
      // YYYY-MM-DD value. A payment therefore cannot predate its source row.
      // Skip the NBU round-trip entirely when there is nothing to convert —
      // i.e. the pair is USD⇄USDT-pegged 1:1 (see `convertToBase`'s own
      // short-circuit). `obligationCurrency` is provably 'USDT' at this
      // point (the MED-1 invariant assert just above threw otherwise), so
      // this single check ALSO covers the exact-match default case
      // (paid in the obligation's own currency) — `targetCurrency ===
      // obligationCurrency` would only ever be true for `targetCurrency
      // === 'USDT'`, which `isUsdPegPair` already matches. A SEPARATE
      // `targetCurrency === obligationCurrency` disjunct would therefore be
      // unreachable-redundant, not real defense-in-depth — kept as ONE
      // condition rather than two that can never disagree.
      //
      // security-review PR #521 round 3 (LOW): before this task, the check
      // WAS exact-match-only, so paying a USDT obligation out in USD took
      // the (correct, no-op) ELSE branch and needlessly hit the MED-2
      // staleness gate during an NBU outage, even though no NBU data was
      // ever going to be used for that pair. `convertToBase` would
      // short-circuit to the same value anyway either way; this just avoids
      // the network call (and, for the whole peg pair, the staleness gate,
      // which has nothing to guard when no rate is actually applied).
      if (isUsdPegPair(obligationCurrency, targetCurrency)) {
        paidAmount = owedNow
      } else {
        // task-drop-payout-currency (owner addendum): fetch the rate AS OF
        // the selected date (undefined ⇒ NbuCurrencyService defaults to
        // today — byte-for-byte the pre-existing behaviour for every caller
        // that never sends a date).
        const rates = await this.nbuCurrency.getRates(selectedDateStr?.replace(/-/g, ''))
        paidAmount = convertDropPayoutAmount(owedNow, obligationCurrency, targetCurrency, rates)
      }

      originalAmount = obligation.amount
      originalCurrency = obligationCurrency
      exchangeRate = finalizeDropPayout({
        obligationAmount,
        owedNow,
        paidAmount,
        priorSettledAmount,
      })
    }

    // task-receipts-backend (#10): a settle from the user-facing dialog supplies
    // `funding` carrying a MANDATORY receipt. Re-validate on the service against
    // the RESOLVED currency (COMPANY_ACCOUNT → USDT → explorer-only), and verify
    // the doc binding for an ADMIN_PERSONAL file receipt. The legacy obligation-id
    // `:id/settle-company` route passes NO funding and keeps its pre-feature
    // behaviour (no receipt — backward compat; that route has no UI to attach one).
    if (funding) {
      const receiptErr = receiptMandatoryError(
        {
          receiptDocumentId: funding.receiptDocumentId,
          receiptExternalUrl: funding.receiptExternalUrl,
        },
        currency,
      )
      if (receiptErr) throw zodErrorBadRequest(receiptErr)
      if (funding.receiptDocumentId) {
        await assertReceiptDocumentBindable(this.db.db, funding.receiptDocumentId, actor)
      }
    }

    // task-settled-amount-snapshot (AC4, MONOTONIC accumulator). The FACT
    // amount THIS settle records — for a DROP settle that IS `paidAmount`
    // (currency-converted above, guaranteed assigned inside the
    // `isDropObligation` block reached above without throwing); a SENIOR
    // settle never touches `amount` at all (see the `.set()` comment below),
    // so its contribution is the pre-existing obligation amount — the same
    // value `amount` already holds and will keep holding after this flip.
    //
    // task-cascade-apply (task 3, AC10): on the SENIOR branch that contribution
    // is now the REMAINDER (`obligation.amount − already accumulated`), not the
    // obligation's full figure. On a first settle the accumulator is NULL, so
    // `remainingOwed` returns exactly `obligation.amount` and the behaviour is
    // byte-for-byte what it was.
    const settledAmountThisSettle = isDropObligation
      ? paidAmount!
      : remainingOwed(obligation.amount, priorSettledAmount)

    // task-cascade-apply (task 3, AC10 as revised by AC15 / addendum §1.14).
    //
    // `owedNow === 0` is NOT an error — it is an idempotent close. Zero means
    // "exactly as much has been paid as the obligation is worth", and closing
    // on zero is ledger-neutral: the row leaves term 9 carrying
    // `settled_amount` and enters term 7 carrying `amount`, and those two are
    // equal. Refusing here (as the first round did) created the dead end
    // SR-M-4 describes: an "edit up, then edit back down" round trip left a
    // reopened obligation that could never be closed again.
    //
    // A NEGATIVE remainder is still refused. The `max(newAmount,
    // settledAmount)` floor in the cascade (AC5) makes that state unreachable;
    // this stays as a fail-loud tripwire in case it is ever reached another
    // way, because paying a negative amount is not a thing.
    if (settledAmountThisSettle < 0) {
      throw apiError('FINANCE_OBLIGATION_OVERPAID', HttpStatus.BAD_REQUEST)
    }

    // MED-2 (security-review round 1, PR #599): `pending_obligations.amount`
    // carries ZERO CHECK constraints (verified against a scratch DB by the
    // reviewer), and Postgres' own `'NaN'::numeric >= 0` evaluates `true` —
    // a corrupted/legacy row's amount could otherwise reach the money-gate
    // above (`parseFloat(obligation.amount)`, the `debitsCompanyAccount`
    // balance check) AND this accumulator write completely unchecked on the
    // SENIOR path. Same class of defect as MED-A in PR #521 (settle a DROP
    // obligation's server-computed figure without re-validating it) — reuse
    // the SAME validator, not a second one.
    //
    // Runs UNCONDITIONALLY, not gated on `!isDropObligation` (mutation-gate:
    // provably equivalent to removing that gate — for a DROP settle,
    // `settledAmountThisSettle` IS `paidAmount`, which ALREADY passed this
    // EXACT SAME validator a few lines up via `paidAmountError`; re-running
    // it here on an already-valid value is a no-op that can never throw
    // differently. A conditional no test can ever observe firing vs not is
    // not real defense-in-depth — removing it is simpler and behaviourally
    // identical, same reasoning as the `funding.currency !== undefined`
    // Stryker note above.)
    const settledAmountErr = settledAmountError(settledAmountThisSettle, MAX_TRANSACTION_AMOUNT)
    if (settledAmountErr) throwSettledAmountError(settledAmountErr)

    // MED-1 (security-review round 1, PR #599): the accumulator sums FACT
    // amounts across every settle of THIS row — summing amounts recorded in
    // DIFFERENT currencies (e.g. 500 USDT + 300 EUR) under one column would
    // silently misrepresent the total as if both were the same unit, with
    // `settled_currency` left holding only the LAST currency's label.
    // Unreachable today (a row settles at most once — the return-to-PENDING
    // cascade that lets the SAME row settle a second time, in a possibly
    // different currency, is a later task in this decomposition), but the
    // WRITE contract must refuse the mismatch outright the moment that
    // cascade exists, rather than silently mislabel it. `sourceSettledCurrency`
    // is NULL on a first-ever settle (nothing to conflict with yet).
    if (sourceSettledCurrency && sourceSettledCurrency !== currency) {
      throw apiError('FINANCE_SETTLEMENT_ALREADY_IN_OTHER_CURRENCY', HttpStatus.BAD_REQUEST, {
        sourceSettledCurrency,
      })
    }

    const settleFundingSource = debitsCompanyAccount ? COMPANY_ACCOUNT_FUNDING_SOURCE : null
    if (
      isFundingSourceMismatch({
        priorSettledAmount,
        settleFundingSource,
        sourceFundingSource,
        senderId,
        sourceSenderId,
      })
    ) {
      const describe = (value: string | null) => value ?? 'особистий рахунок адміністратора'
      // The person, when there was one. `senderLabel` is written by the same
      // flip that writes `senderId` (the payer's display name for an
      // `ADMIN_PERSONAL` settle, 'COMPANY' otherwise), so no extra read is
      // needed to name them.
      const priorPayer = sourceSenderId ? ` (плательщик — ${sourceSenderLabel ?? 'админ'})` : ''
      // task-i18n-stage4-task2 (Step 1 pattern, "разбор — в лог"): the
      // funding-source description + payer NAME stay server-side only — a
      // display name is PII and does not belong in an `apiError` `params`
      // object (task file "Уточнения оркестратора" §4). The generic code
      // below carries the actionable instruction; this log line keeps the
      // full diagnostic for whoever investigates the refusal.
      this.logger.warn(
        `settleByCompany funding source mismatch: source=«${describe(sourceFundingSource)}»` +
          `${priorPayer}, settle=«${describe(settleFundingSource)}»`,
      )
      throw apiError('FINANCE_SETTLEMENT_FUNDING_SOURCE_MUST_MATCH', HttpStatus.BAD_REQUEST)
    }

    // ONE transaction; the in-tx sequence (claim → amount re-check → lock+gate →
    // flip → closing link) lives in settleObligationInTx. Post-commit steps below.
    const paidRow = await this.db.db.transaction((dbtx) =>
      settleObligationInTx(dbtx, {
        obligation,
        actor,
        funding,
        isDropObligation,
        debitsCompanyAccount,
        currency,
        senderId,
        senderLabel,
        priorSettledAmount,
        settledAmountThisSettle,
        sourceSettledAmount,
        sourceSeniorSharePercent,
        sourceDropSharePercent,
        originalAmount,
        originalCurrency,
        exchangeRate,
        txDateToWrite,
      }),
    )
    const created: Transaction[] = [paidRow]

    // Fire-and-forget invoice trigger — outside the DB transaction so a
    // failing PDF/S3 step does not roll back the settlement.
    const seniorIncomeId = created.find((c) => c.type === 'SENIOR_INCOME')?.id
    if (seniorIncomeId) {
      try {
        await this.invoicesService.autoCreateForSeniorPayout(seniorIncomeId)
      } catch {
        // Swallow — the invoice can be re-triggered manually. Status change is
        // already persisted, the obligation is closed regardless.
      }
    }

    // task-soft-delete-and-money-audit (AC5): "оплата" — settling a senior/
    // drop IOU from the company account is a payment action just like
    // paySalary. Best-effort, run AFTER the settle transaction has already
    // committed (same convention as the invoice trigger above and
    // TransactionsService.paySalary — a logging hiccup must not turn a
    // successful settlement into a 500).
    const flippedRow = created[0]
    if (flippedRow) {
      try {
        await this.db.db.insert(transactionAuditLog).values({
          actorId: actor.impersonatorId ?? actor.id,
          targetId: flippedRow.id,
          action: 'PAY',
          metadata: {
            type: flippedRow.type,
            amount: flippedRow.amount,
            currency: flippedRow.currency,
            obligationId: obligation.id,
            fundingSource: debitsCompanyAccount ? COMPANY_ACCOUNT_FUNDING_SOURCE : null,
          },
        })
      } catch (auditErr) {
        this.logger.error(
          `settleByCompany: failed to persist audit record for transaction=${flippedRow.id}: ${(auditErr as Error).message}`,
          (auditErr as Error).stack,
        )
      }
    }

    const refreshed = await this.db.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.id, obligation.id),
    })
    return {
      obligation: toObligationDto(refreshed ?? { ...obligation, status: 'PAID' as const }),
      created: created.map((c) => toTransactionDto(c)),
    }
  }

  /**
   * task-senior-settle-in-tx-row: settle a senior IOU keyed on its SOURCE
   * transaction (the SENIOR_PENDING_PAYOUT row), not the obligation id.
   *
   * The finance-page transactions list pays the senior directly from the
   * SENIOR_PENDING_PAYOUT row's «Выплатить» button — the row carries the
   * transaction id, but the settle money-gate lives on the linked
   * `pending_obligations` row (joined via `sourceTransactionId`). We resolve the
   * single PENDING obligation for that source transaction and delegate to the
   * existing, audited `settleByCompany` (which performs the atomic + idempotent
   * PENDING→PAID flip, company-account debit gate, and SENIOR_INCOME + invoice
   * cascade). RBAC, money gate and double-settle protection are all inherited
   * verbatim from settleByCompany — this method adds NO new money path.
   *
   * RBAC is checked HERE first (ADMIN/ACCOUNTANT only) so a non-privileged
   * caller gets 403 BEFORE we reveal whether any obligation exists (no
   * enumeration oracle). settleByCompany re-checks the same gate (defense in
   * depth).
   */
  async settleByCompanySourceTransaction(
    sourceTransactionId: string,
    actor: SessionUser,
    funding?: SettleFunding,
  ): Promise<{ obligation: PendingObligationDto; created: TransactionDto[] }> {
    if (actor.role !== 'ADMIN' && actor.role !== 'ACCOUNTANT') {
      throw apiError('FINANCE_COMPANY_OBLIGATION_CLOSE_FORBIDDEN', HttpStatus.FORBIDDEN)
    }

    // Find the single still-open obligation backing this SENIOR_PENDING_PAYOUT
    // row. Scoping to status=PENDING avoids re-resolving an already-closed
    // obligation (settleByCompany would 400 on it anyway, but this gives a
    // precise 404 for «nothing left to pay» and never reuses a stale row).
    const obligation = await this.db.db.query.pendingObligations.findFirst({
      where: and(
        eq(pendingObligations.sourceTransactionId, sourceTransactionId),
        eq(pendingObligations.status, 'PENDING'),
      ),
    })
    if (!obligation) {
      throw apiError('FINANCE_OPEN_OBLIGATION_NOT_FOUND_FOR_TRANSACTION', HttpStatus.NOT_FOUND)
    }

    return this.settleByCompany(obligation.id, actor, funding)
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  // Thin delegate kept: obligation-amount-divergence.integration.spec.ts
  // overrides `loadObligation` on the instance to simulate a stale
  // pre-transaction read (TOCTOU). Call site stays OUTSIDE the transaction.
  private async loadObligation(obligationId: string) {
    return loadObligationRead(this.db.db, obligationId)
  }
}
