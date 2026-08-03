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
import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { and, eq, inArray } from 'drizzle-orm'
import { receiptMandatoryError } from '@crm/shared'
import type {
  PendingSettlementItemDto,
  PendingObligationDto,
  SessionUser,
  TransactionDto,
} from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import {
  pendingObligations,
  projects,
  transactions,
  transactionAuditLog,
  users,
  type Transaction,
} from '../database/schema'
import { InvoicesService } from '../invoices/invoices.service'
import {
  COMPANY_ACCOUNT_FUNDING_SOURCE,
  computeCompanyAccountBalanceFromLedger,
  lockCompanyAccount,
} from './company-account-balance'
import { assertReceiptDocumentBindable } from './receipt.util'

/**
 * task-senior-settle-owner: the pay-time funding selection for a senior IOU
 * settlement. Identical contract to paySalary — the ADMIN/ACCOUNTANT picks the
 * source (shared company account vs an admin partner's personal account) and,
 * for ADMIN_PERSONAL, which admin paid.
 *   - COMPANY_ACCOUNT → currency forced USDT, debits the shared account.
 *   - ADMIN_PERSONAL  → payerAdminId (validated ADMIN) is the sender; the
 *     company account is untouched.
 *
 * task-remove-settle-currency (2026-07): `currency` is now OPTIONAL — the
 * settle dialog no longer lets the caller pick one (every senior/drop
 * obligation is denominated in USDT; see transactions.service.ts createIous).
 * When omitted, `settleByCompany` defaults it to `obligation.currency`
 * (always USDT in practice). It stays on the type (not removed) so a
 * defensive/legacy caller that still passes an explicit currency keeps
 * working — the BIZ-03 guard below still validates it when present.
 */
export type SettleFunding = {
  fundingSource: 'COMPANY_ACCOUNT' | 'ADMIN_PERSONAL'
  payerAdminId?: string | undefined
  currency?: 'USDT' | 'USD' | 'EUR' | 'UAH' | undefined
  // task-receipts-backend (#10): mandatory settle proof — currency-aware
  // (COMPANY_ACCOUNT → USDT → explorer-only; ADMIN_PERSONAL USD → file/url).
  receiptDocumentId?: string | null | undefined
  receiptExternalUrl?: string | null | undefined
}

/**
 * BIZ-03 (HIGH) — canonical whitelist of currencies a senior/drop IOU may be
 * settled in. Every IOU is booked in USDT (see `bookCompanyObligations` /
 * `createIous` in transactions.service.ts); the downstream balance readers
 * (getSeniorBalance / getTotalEarned / getSummary) convert the RESOLVED
 * currency LABEL via `convertToBase`, which is only value-preserving for
 * USD/USDT (1:1 short-circuit) — UAH/EUR triangulate through NBU rates and
 * would silently UNDER-count the payout by ~40×.
 *
 * SINGLE SOURCE OF TRUTH — reused by BOTH the explicit-currency
 * re-validation (an `ADMIN_PERSONAL` caller that still supplies `currency`)
 * AND the defense-in-depth assert on the fully-resolved currency
 * (security-review PR #381, task-remove-settle-currency) below, so the two
 * checks can never drift into two different lists.
 */
const SETTLE_ALLOWED_CURRENCIES: ReadonlySet<string> = new Set(['USDT', 'USD'])

function assertSettleCurrencyAllowed(currency: string): void {
  if (!SETTLE_ALLOWED_CURRENCIES.has(currency)) {
    throw new BadRequestException(
      `Закрытие USDT-обязательства в ${currency} не поддерживается без конверсии суммы. Используйте USD или USDT.`,
    )
  }
}

@Injectable()
export class PendingSettlementService {
  private readonly logger = new Logger(PendingSettlementService.name)

  constructor(
    private readonly db: DatabaseService,
    @Inject(forwardRef(() => InvoicesService))
    private readonly invoicesService: InvoicesService,
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
      throw new ForbiddenException(
        'Список ожидающих зачислений доступен синьорам, бухгалтерам и админам',
      )
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
    return this.denormalise(rows)
  }

  /**
   * Company-debt view. ADMIN/ACCOUNTANT-only — DROP no longer has any
   * obligations to close. Returns every PENDING obligation with
   * debtorType='COMPANY'.
   */
  async listCompanyObligations(actor: SessionUser): Promise<PendingSettlementItemDto[]> {
    if (actor.role !== 'ADMIN' && actor.role !== 'ACCOUNTANT') {
      throw new ForbiddenException(
        'Список долгов компании перед синьорами доступен только админам и бухгалтерам',
      )
    }
    const rows = await this.db.db.query.pendingObligations.findMany({
      where: and(
        eq(pendingObligations.status, 'PENDING'),
        eq(pendingObligations.debtorType, 'COMPANY'),
      ),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    })
    return this.denormalise(rows)
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
      throw new ForbiddenException('Закрывать долг компании могут только админ или бухгалтер')
    }

    const obligation = await this.loadObligation(obligationId)
    if (obligation.debtorType !== 'COMPANY' && obligation.debtorType !== 'DROP') {
      // Keep legacy 'DROP'-debt closeable through this endpoint so admins
      // can clean up pre-refactor rows the same way.
      throw new BadRequestException(
        'Этот долг не закрывается компанией (debtorType должен быть COMPANY)',
      )
    }
    // NOTE: this is only a fast-fail UX gate read OUTSIDE the transaction; it is
    // NOT the authority. The PENDING→PAID transition is decided atomically by the
    // conditional UPDATE inside the transaction below (see SECURITY note), which
    // is the single source of truth against a double-settle race.
    if (obligation.status !== 'PENDING') {
      throw new BadRequestException('Долг уже закрыт или отменён')
    }

    // We only need the source IOU's TYPE (the drop-vs-senior discriminator)
    // and, since PR #443 (HIGH-1 / MED-B), its `dropCascadeOrigin` marker
    // (cascade-vs-declaration discriminator — see the guard below). The
    // flipped row keeps its own projectId booked on the IOU — no re-stamp.
    const { sourceType, sourceDropCascadeOrigin } = await this.resolveSource(
      obligation.sourceTransactionId,
    )

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

    // task-senior-settle-owner: the senior IOU is now paid via the SAME funding
    // selection as a SALARY — the ADMIN/ACCOUNTANT picks AT PAY TIME whether the
    // money leaves the shared company account (COMPANY_ACCOUNT) or an admin
    // partner's personal account (ADMIN_PERSONAL). Mirrors paySalary exactly.
    //
    // Default (no funding arg → legacy obligation-id `settle-company` route and
    // pre-existing callers): COMPANY_ACCOUNT for a COMPANY debt, or "no company
    // marker" for a legacy DROP debt (the money came from the drop, not the
    // company). This preserves the previous behaviour byte-for-byte.
    const isCompanyDebt = obligation.debtorType === 'COMPANY'
    // Resolve the funding choice → sender + currency + the SENIOR_INCOME marker.
    // A legacy DROP debt is never company-funded regardless of the passed source.
    const useCompanyAccount = funding ? funding.fundingSource === 'COMPANY_ACCOUNT' : isCompanyDebt
    // Does this settlement debit the shared company account (advisory lock + gate
    // + COMPANY_ACCOUNT marker)? Only when funded by the company AND it is a
    // COMPANY debt (legacy DROP debts never touch the company balance).
    const debitsCompanyAccount = useCompanyAccount && isCompanyDebt

    // SECURITY (HIGH-1, security-review PR #443): a cascade-originated drop
    // obligation (applyPayoutPaidCascade → bookCompanyObligations, `drop`
    // param) must NEVER settle from COMPANY_ACCOUNT — in BOTH branches that
    // can drive `debitsCompanyAccount` true (an explicit
    // funding.fundingSource='COMPANY_ACCOUNT', AND the legacy no-funding
    // default, which resolves useCompanyAccount=isCompanyDebt=true for any
    // COMPANY debt). The drop's slice paid by the cascade NEVER touched the
    // company pool — the PAYOUT row backing this payout_request only credited
    // `payable = income*(1-dropShare%)` (the company never receives the
    // drop's own cut; the drop keeps it before the on-chain transfer).
    // Debiting the company account here would subtract money the company
    // never held, silently understating the balance by exactly the drop's
    // share on every such settle (and, over time, falsely tripping the
    // "insufficient funds" gate below for otherwise-legitimate payouts).
    // The admin-declared USDT path (declareUsdtProjectIncome) is NOT
    // affected by this guard — `dropCascadeOrigin=false` there is a
    // cascade-vs-declaration discriminator, not a "money is in the pool"
    // guarantee (declareUsdtProjectIncome can also route to a SPECIFIC
    // admin's personal wallet, toCompanyPool=false — see the column comment
    // in schema.ts, corrected round 5). Which pot actually pays a
    // `false`-marked obligation is decided by the ADMIN/ACCOUNTANT's
    // funding-source choice below, same as it already is for the analogous
    // senior obligation — unchanged by this PR.
    //
    // SECURITY (MED-B, security-review PR #443 round 2, fail-safe hardening):
    // the discriminator is `dropCascadeOrigin` — a POSITIVE marker stamped
    // ONCE at INSERT time (see bookCompanyObligations, transactions.service.ts,
    // and the column comment in schema.ts) — NOT `payoutRequestId IS NOT
    // NULL`. That FK is `ON DELETE SET NULL`: a future cleanup of an
    // unrelated `payout_requests` row would silently null it, and a
    // condition keyed on it would fail OPEN (a cascade-originated row would
    // become indistinguishable from an admin-declared one and wrongly allow
    // a COMPANY_ACCOUNT settle). `dropCascadeOrigin` is never derived from
    // `payoutRequestId` after the fact, so it survives that entirely.
    // Backfilled historical rows (task-drop-share-pending-parity) get the
    // SAME marker stamped by the backfill script, for the identical reason.
    //
    // `!== false` (not a truthy check) — security-review PR #443 round 3,
    // LOW: the column is nullable with NO default (see schema.ts), so `null`
    // means "nobody ever stamped an origin for this row" (a future insert
    // path that forgets to set it, or any pre-marker-column legacy row this
    // backfill never touched). Treating that as BLOCK — same as an explicit
    // `true` — means an unknown origin fails SAFE; only an EXPLICIT `false`
    // (admin-declared path) is treated as "known safe to debit the company
    // account".
    if (isDropObligation && sourceDropCascadeOrigin !== false && debitsCompanyAccount) {
      throw new BadRequestException(
        'Доля дропа из этой выплаты не проходила через счёт компании — выберите личный счёт админа',
      )
    }

    let senderId: string | null = null
    let senderLabel = 'COMPANY'
    // task-remove-settle-currency: default is the OBLIGATION's own currency
    // (always USDT for a senior/drop IOU — see transactions.service.ts
    // createIous). The settle dialog no longer sends a currency at all; this
    // is the value that ends up on the flipped row for both funding sources
    // unless a caller explicitly overrides it below (defensive/legacy path).
    let currency = obligation.currency
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
        throw new BadRequestException('Личный счёт-плательщик должен принадлежать ADMIN')
      }
      senderId = payer.id
      senderLabel = payer.displayName
      // BIZ-03 (HIGH), kept as a safety net (task-remove-settle-currency): the
      // frontend no longer sends a currency, so `funding.currency` is normally
      // undefined here and `currency` stays `obligation.currency` (USDT) from
      // the declaration above. IF a caller still supplies one explicitly
      // (legacy/defensive), re-validate it — the SENIOR_INCOME row carries the
      // chosen currency, and downstream (getSeniorBalance / getTotalEarned /
      // summary) converts it via convertToBase using the currency LABEL — not a
      // fixed USDT amount. So:
      //   • USD/USDT → convertToBase short-circuits 1:1 → correct $-amount ✅
      //   • UAH      → convertToBase divides by usdUah (~40) → ~40× undercount ✗
      //   • EUR      → further triangulation → similar distortion ✗
      // Allow only USD and USDT (equivalent to the USDT obligation value 1:1).
      // UAH/EUR are rejected with a clear message; if multi-currency settlement
      // is ever needed the amount must be converted to USDT before recording.
      if (funding.currency !== undefined) {
        assertSettleCurrencyAllowed(funding.currency)
        currency = funding.currency
      }
    } else if (debitsCompanyAccount) {
      // COMPANY_ACCOUNT: USDT-only account (the schema refine + this force keep
      // the currency label consistent with the ledger).
      currency = 'USDT'
    }

    // SECURITY (defense-in-depth, security-review PR #381 — BIZ-03 guard bypass
    // on the omitted-currency path): the branches above can leave `currency` at
    // its DEFAULT (`obligation.currency`, declared above and always USDT in
    // practice — see the module-level obligation-creation code) WITHOUT ever
    // going through the explicit-currency re-validation, because
    // task-remove-settle-currency made `funding.currency` optional and the
    // settle dialog no longer sends one. That default path currently relies
    // entirely on the invariant "every pending_obligations row is USDT" — this
    // re-asserts the SAME whitelist against the FULLY-RESOLVED currency so a
    // corrupted/legacy obligation currency can never silently bypass BIZ-03.
    // Covers BOTH funding sources (COMPANY_ACCOUNT is forced to USDT just
    // above — trivially passes) and BOTH source-IOU types: this code path is
    // shared by SENIOR_PENDING_PAYOUT and DROP_PENDING_PAYOUT settlements
    // (`isDropObligation` only changes the flipped row's TYPE below, not the
    // currency resolution above).
    assertSettleCurrencyAllowed(currency)

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
      if (receiptErr) throw new BadRequestException(receiptErr)
      if (funding.receiptDocumentId) {
        await assertReceiptDocumentBindable(this.db.db, funding.receiptDocumentId, actor)
      }
    }

    const created: Transaction[] = []
    await this.db.db.transaction(async (dbtx) => {
      // SECURITY (TOCTOU, MED — PR #262): the PENDING→PAID transition is the
      // money gate and MUST be atomic + idempotent, else two concurrent / repeated
      // settle calls (e.g. a double-clicked ADMIN/ACCOUNTANT button) both pass the
      // out-of-transaction status read above, both insert a SENIOR_INCOME and both
      // debit the company account → DOUBLE payout to the senior. There is no
      // unique/partial-index backstop on pending_obligations (unlike the payout
      // path's uq_payout_requests_txhash_paid), so we serialize at the row level
      // with a CONDITIONAL UPDATE: flip to PAID only WHERE the row is still
      // PENDING, and RETURN the affected rows. The UPDATE takes a row lock and
      // re-evaluates `status='PENDING'` against the committed row, so exactly one
      // caller wins. If zero rows come back the obligation was already settled by a
      // concurrent winner → throw, which rolls back THIS transaction (no
      // SENIOR_INCOME row, no company-account debit). Doing the conditional UPDATE
      // FIRST means the loser bails out before any money write happens.
      const claimed = await dbtx
        .update(pendingObligations)
        .set({
          status: 'PAID',
          updatedAt: new Date(),
        })
        .where(
          and(eq(pendingObligations.id, obligation.id), eq(pendingObligations.status, 'PENDING')),
        )
        .returning({ id: pendingObligations.id })
      if (claimed.length === 0) {
        // Idempotent: a concurrent / repeated call already closed this obligation.
        throw new BadRequestException('Долг уже закрыт или отменён')
      }

      // SECURITY (TOCTOU): a company-account DEBIT must serialize against every
      // other company-account debit (salary / expense / other settlements) via
      // the SHARED advisory lock, then re-read the balance and refuse to drive
      // the account negative. Mirrors createSalary / createExpense. Only runs for
      // a COMPANY-funded settlement — an ADMIN_PERSONAL payout never touches the
      // shared account so it needs neither lock nor gate.
      if (debitsCompanyAccount) {
        await lockCompanyAccount(dbtx)
        const balance = await computeCompanyAccountBalanceFromLedger(dbtx)
        const amount = parseFloat(obligation.amount)
        if (amount > balance) {
          throw new BadRequestException(
            'Недостаточно средств на счёте компании для закрытия долга перед синьором',
          )
        }
      }

      // task-settle-in-place (ADR 2026-07-14). The obligation transitions
      // PENDING_PAYMENT → PAID **in place**: instead of inserting a SECOND
      // transaction (the phantom bug — a lingering `*_PENDING_PAYOUT` row plus a
      // separate settle row), we UPDATE the SOURCE IOU row itself. It flips type
      // to its final form and stamps the same funding fields the old "second row"
      // carried, becoming byte-for-byte equivalent to yesterday's settle row —
      // only reusing the IOU's id instead of allocating a new one. Every ledger /
      // drop-aggregate / invoice / C4 consumer keys on that FINAL form
      // (type + status=PAID + funding markers), so none of them change:
      //   - senior IOU → type=SENIOR_INCOME (status=PAID): InvoicesService
      //     .autoCreateForSeniorPayout picks it up (gate `tx.type==='SENIOR_INCOME'`).
      //   - drop IOU → type=PAYOUT_DROP (status=PAID): credits the drop's balance
      //     via computeDropAggregate (receiverId=drop, senderId≠drop so NOT
      //     double-counted as `sent` — C6); no invoice (Q6).
      // The flip runs AFTER the winning conditional claim above, so it executes
      // exactly once. Defense-in-depth: scope the UPDATE to the still-PENDING_PAYMENT
      // source row so a corrupted / already-flipped state can never be re-settled.
      const [paidRow] = await dbtx
        .update(transactions)
        .set({
          type: isDropObligation ? 'PAYOUT_DROP' : 'SENIOR_INCOME',
          status: 'PAID',
          // task-senior-settle-owner: currency follows the funding choice
          // (COMPANY_ACCOUNT → USDT; ADMIN_PERSONAL → chosen; legacy default →
          // obligation currency). The IOU was booked USDT; this may re-stamp it.
          currency,
          // ADMIN_PERSONAL → the paying partner is the sender; COMPANY_ACCOUNT /
          // legacy → no personal sender, label 'COMPANY' (the IOU's booked label).
          senderId,
          senderLabel,
          // Company-account debit marker — counted by the ledger SSOT (the C7
          // PAYOUT_DROP(COMPANY_ACCOUNT) term for a drop settle, the existing
          // SENIOR_INCOME(COMPANY_ACCOUNT) term for a senior settle). Only set for
          // a company-funded settlement; an ADMIN_PERSONAL payout carries no
          // marker (the shared balance must not move).
          fundingSource: debitsCompanyAccount ? COMPANY_ACCOUNT_FUNDING_SOURCE : null,
          // task-receipts-backend (#10): stamp the settle proof (only the
          // user-facing funding-carrying flow supplies one; legacy → null).
          receiptDocumentId: funding?.receiptDocumentId ?? null,
          receiptExternalUrl: funding?.receiptExternalUrl ?? null,
          // CRITICAL (ADR): a cascade-sourced IOU (applyPayoutPaidCascade) carries
          // `payoutRequestId`. Keeping it on a flipped SENIOR_INCOME would bleed the
          // row into autoCreateForPayout's payoutRequestId aggregation AND the
          // findOne SENIOR_INCOME-by-payoutRequestId enrichment. Yesterday's settle
          // SENIOR_INCOME had payoutRequestId=null; reset preserves byte-identity.
          // Audit link is retained via pending_obligations + notes + projectId.
          payoutRequestId: null,
          // CRITICAL (money, beyond ADR's consumer table): the IOU was booked with
          // `amount` = the ALREADY-NET share (income × share%) AND a non-null
          // seniorSharePercent/dropSharePercent snapshot. But getSeniorBalance /
          // getTotalEarned / getSeniorSummary use seniorSharePercent as a GROSS↔NET
          // discriminator on SENIOR_INCOME: non-null ⇒ treat amount as GROSS and
          // multiply by share% (→ NET × 26% = a ~26× UNDER-count of the senior).
          // Yesterday's settle-INSERTED SENIOR_INCOME left these null, so the amount
          // was used as-is (NET). We MUST null them to stay byte-identical and avoid
          // the double-application. (The drop side is safe today — computeDropAggregate
          // reads PAYOUT_DROP.amount directly — but we null it too for parity, since
          // yesterday's settle PAYOUT_DROP carried no share snapshot either.)
          seniorSharePercent: null,
          seniorSharePercentSource: null,
          dropSharePercent: null,
          dropSharePercentSource: null,
          notes: isDropObligation
            ? `Выплата drop IOU (obligation ${obligation.id})`
            : `Выплата senior IOU (obligation ${obligation.id})`,
          updatedAt: new Date(),
          // Income rows carry validation provenance; a PAYOUT_DROP is a payout,
          // not a validated income, so it leaves these untouched (mirrors the
          // cascade PAYOUT_DROP shape). `createdBy` intentionally stays the
          // booking author — the settler is captured in `validatedBy` (senior) and
          // the notes (per ADR §Consequences: minor audit delta, deliberate).
          //
          // security-review PR #456 round 2 (MED-3): under impersonation this
          // used to record the IMPERSONATED target as the settler, while the
          // audit-log insert 20 lines below (in the same transaction, same
          // action) already correctly attributed the REAL operator via
          // `actor.impersonatorId ?? actor.id` — two provenance columns for one
          // action, disagreeing under the exact condition provenance exists to
          // catch. Same resolution, same field, now homogeneous.
          ...(isDropObligation
            ? {}
            : { validatedBy: actor.impersonatorId ?? actor.id, validatedAt: new Date() }),
        })
        .where(
          and(
            eq(transactions.id, obligation.sourceTransactionId),
            eq(transactions.status, 'PENDING_PAYMENT'),
          ),
        )
        .returning()
      if (!paidRow) {
        // The claim already won (obligation was PENDING) so the source IOU MUST
        // have been PENDING_PAYMENT. Zero rows here means a corrupted invariant
        // (source flipped / deleted out of band) — abort so we never leave the
        // obligation PAID with no closing row (rolls back the claim too).
        throw new BadRequestException(
          'Не удалось закрыть долг: исходная транзакция обязательства не в статусе ожидания выплаты',
        )
      }
      created.push(paidRow)
      // Point closingTransactionId at the SAME row we just flipped (self-
      // reference). This keeps the C4 discriminator working: the flipped
      // SENIOR_INCOME id ∈ settlementTxIds so it is excluded from totalIncome
      // (its gross was already counted as the ADMIN_INCOME / DROP_INCOME).
      await dbtx
        .update(pendingObligations)
        .set({
          closingTransactionId: obligation.sourceTransactionId,
          updatedAt: new Date(),
        })
        .where(eq(pendingObligations.id, obligation.id))
    })

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
      obligation: this.toObligationDto(refreshed ?? { ...obligation, status: 'PAID' as const }),
      created: created.map((c) => this.toTransactionDto(c)),
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
      throw new ForbiddenException('Закрывать долг компании могут только админ или бухгалтер')
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
      throw new NotFoundException('Открытый долг для этой транзакции не найден')
    }

    return this.settleByCompany(obligation.id, actor, funding)
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async loadObligation(obligationId: string) {
    const row = await this.db.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.id, obligationId),
    })
    if (!row) throw new NotFoundException('Обязательство не найдено')
    return row
  }

  /**
   * Walk source transaction → projectId so the SENIOR_INCOME row keeps the
   * project pointer for audit. Failures are non-fatal: a missing source or
   * missing project just yields `null`.
   *
   * security-review PR #443 (HIGH-1 / MED-B): also returns the source row's
   * `dropCascadeOrigin` — the deterministic, FK-independent cascade-vs-
   * declaration discriminator `settleByCompany` uses below to refuse a
   * COMPANY_ACCOUNT-funded settle on a cascade-originated drop obligation
   * (see the HIGH-1 guard for why, and the MED-B note on why this reads the
   * dedicated marker column rather than `payoutRequestId`).
   */
  private async resolveSource(sourceTransactionId: string): Promise<{
    project: { id: string; name: string } | null
    sourceType: string | null
    // Nullable — `null` means "unstamped" and the HIGH-1/MED-B guard above
    // treats that as unknown-origin (BLOCK), same as `true`. Only an
    // explicit `false` means "verified non-cascade, safe".
    sourceDropCascadeOrigin: boolean | null
  }> {
    const source = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, sourceTransactionId),
    })
    if (!source) return { project: null, sourceType: null, sourceDropCascadeOrigin: null }
    const project = source.projectId
      ? await this.db.db.query.projects.findFirst({ where: eq(projects.id, source.projectId) })
      : null
    return {
      project: project ? { id: project.id, name: project.name } : null,
      sourceType: source.type,
      sourceDropCascadeOrigin: source.dropCascadeOrigin,
    }
  }

  /**
   * Denormalise obligation rows with creditor / debtor / project names so the
   * UI cards render without follow-up requests.
   */
  private async denormalise(
    rows: Array<{
      id: string
      creditorUserId: string
      debtorType: 'DROP' | 'TOV' | 'ADMIN' | 'COMPANY'
      debtorUserId: string | null
      sourceTransactionId: string
      amount: string
      currency: string
      createdAt: Date
    }>,
  ): Promise<PendingSettlementItemDto[]> {
    const result: PendingSettlementItemDto[] = []
    for (const row of rows) {
      const [senior, debtor, source] = await Promise.all([
        this.db.db.query.users.findFirst({ where: eq(users.id, row.creditorUserId) }),
        row.debtorUserId
          ? this.db.db.query.users.findFirst({ where: eq(users.id, row.debtorUserId) })
          : Promise.resolve(undefined),
        this.db.db.query.transactions.findFirst({
          where: eq(transactions.id, row.sourceTransactionId),
        }),
      ])
      const project = source?.projectId
        ? await this.db.db.query.projects.findFirst({ where: eq(projects.id, source.projectId) })
        : undefined

      result.push({
        obligationId: row.id,
        sourceTransactionId: row.sourceTransactionId,
        debtorType: row.debtorType,
        debtorUserId: row.debtorUserId,
        debtorName: debtor?.displayName ?? null,
        seniorId: row.creditorUserId,
        seniorName: senior?.displayName ?? '—',
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        amount: row.amount,
        currency: row.currency as 'USDT' | 'USD' | 'EUR' | 'UAH',
        createdAt: row.createdAt.toISOString(),
      })
    }
    return result
  }

  private toObligationDto(row: {
    id: string
    creditorUserId: string
    debtorType: 'DROP' | 'TOV' | 'ADMIN' | 'COMPANY'
    debtorUserId: string | null
    sourceTransactionId: string
    closingTransactionId: string | null
    amount: string
    currency: string
    status: 'PENDING' | 'PAID' | 'CANCELLED'
    createdAt: Date | string
    updatedAt: Date | string
  }): PendingObligationDto {
    const toIso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v)
    return {
      id: row.id,
      creditorUserId: row.creditorUserId,
      debtorType: row.debtorType,
      debtorUserId: row.debtorUserId,
      sourceTransactionId: row.sourceTransactionId,
      closingTransactionId: row.closingTransactionId,
      amount: row.amount,
      currency: row.currency as 'USDT' | 'USD' | 'EUR' | 'UAH',
      status: row.status,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    }
  }

  private toTransactionDto(row: Transaction): TransactionDto {
    const toIso = (v: Date | string | null | undefined): string | null => {
      if (v === null || v === undefined) return null
      if (v instanceof Date) return v.toISOString()
      return typeof v === 'string' ? v : null
    }
    const nowIso = new Date().toISOString()
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      amount: row.amount,
      currency: row.currency,
      senderId: row.senderId ?? null,
      senderLabel: row.senderLabel ?? null,
      senderName: null,
      receiverId: row.receiverId ?? null,
      receiverLabel: row.receiverLabel ?? null,
      receiverName: null,
      projectId: row.projectId ?? null,
      projectName: null,
      payoutRequestId: row.payoutRequestId ?? null,
      seniorSharePercent: row.seniorSharePercent ?? null,
      seniorSharePercentSource: null,
      receiptDocumentId: row.receiptDocumentId ?? null,
      receiptExternalUrl: row.receiptExternalUrl ?? null,
      txHash: row.txHash ?? null,
      // task-onchain-payment-integrity: the recorded on-chain sender is
      // ADMIN/ACCOUNTANT-only audit data. This mapper serves the settlement
      // endpoints (no viewer in scope) and the rows it returns are
      // company-obligation settlements, not on-chain transfers — always null,
      // matching the masking applied in `TransactionsService.mapTx`.
      txFromAddress: null,
      validatedBy: row.validatedBy ?? null,
      validatedAt: toIso(row.validatedAt),
      rejectionReason: row.rejectionReason ?? null,
      notes: row.notes ?? null,
      salaryMonth: row.salaryMonth ?? null,
      txDate: toIso(row.txDate),
      recipientId: row.recipientId ?? null,
      createdBy: row.createdBy,
      createdAt: toIso(row.createdAt) ?? nowIso,
      updatedAt: toIso(row.updatedAt) ?? nowIso,
    }
  }
}
