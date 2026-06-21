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
 *   ACCOUNTANT/ADMIN closes the obligation via `settleByCompany`, which:
 *     - inserts a SENIOR_INCOME row (status=PAID, the legal invoice type),
 *     - marks the obligation PAID,
 *     - triggers `safeAutoCreateInvoice('SENIOR_INCOME', ...)` so the
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
  NotFoundException,
} from '@nestjs/common'
import { and, eq, inArray } from 'drizzle-orm'
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
  users,
  type Transaction,
} from '../database/schema'
import { InvoicesService } from '../invoices/invoices.service'
import {
  COMPANY_ACCOUNT_FUNDING_SOURCE,
  computeCompanyAccountBalanceFromLedger,
  lockCompanyAccount,
} from './company-account-balance'

/**
 * task-senior-settle-owner: the pay-time funding selection for a senior IOU
 * settlement. Identical contract to paySalary — the ADMIN/ACCOUNTANT picks the
 * source (shared company account vs an admin partner's personal account) and,
 * for ADMIN_PERSONAL, which admin paid + in which currency.
 *   - COMPANY_ACCOUNT → currency forced USDT, debits the shared account.
 *   - ADMIN_PERSONAL  → payerAdminId (validated ADMIN) is the sender; any
 *     currency; the company account is untouched.
 */
export type SettleFunding = {
  fundingSource: 'COMPANY_ACCOUNT' | 'ADMIN_PERSONAL'
  payerAdminId?: string | undefined
  currency: 'USDT' | 'USD' | 'EUR' | 'UAH'
}

@Injectable()
export class PendingSettlementService {
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
   * Atomic cascade:
   *   - Insert SENIOR_INCOME transaction (senderLabel='COMPANY',
   *     receiverId=senior) with status=PAID. This is the legally signable
   *     invoice type per InvoicesService.autoCreateForSeniorPayout.
   *   - Patch obligation → status=PAID, closingTransactionId=<paid row id>.
   *   - Trigger `safeAutoCreateInvoice('SENIOR_INCOME', <id>)` outside the
   *     transaction so a failing PDF/S3 step doesn't roll back the closure.
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

    const project = await this.resolveSourceProject(obligation.sourceTransactionId)

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

    let senderId: string | null = null
    let senderLabel = 'COMPANY'
    let currency = obligation.currency
    if (funding && funding.fundingSource === 'ADMIN_PERSONAL') {
      // ADMIN_PERSONAL: paid from an admin partner's personal account. The payer
      // defaults to the calling (ADMIN/ACCOUNTANT) user only when they are an
      // ADMIN; an explicit payerAdminId must resolve to an ADMIN. The company
      // account is NOT touched; currency is the chosen one (any). Mirrors paySalary.
      const payerAdminId = funding.payerAdminId ?? actor.id
      const payer = await this.db.db.query.users.findFirst({
        where: eq(users.id, payerAdminId),
      })
      if (!payer || payer.role !== 'ADMIN') {
        throw new BadRequestException('Личный счёт-плательщик должен принадлежать ADMIN')
      }
      senderId = payer.id
      senderLabel = payer.displayName
      currency = funding.currency
    } else if (debitsCompanyAccount) {
      // COMPANY_ACCOUNT: USDT-only account (the schema refine + this force keep
      // the currency label consistent with the ledger).
      currency = 'USDT'
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

      // task-drop-company-debt-and-invoices. Use SENIOR_INCOME (status=PAID)
      // so InvoicesService.autoCreateForSeniorPayout picks it up — the
      // existing invoice trigger gates on `tx.type === 'SENIOR_INCOME'`.
      const [paidRow] = await dbtx
        .insert(transactions)
        .values({
          type: 'SENIOR_INCOME',
          status: 'PAID',
          amount: obligation.amount,
          // task-senior-settle-owner: currency follows the funding choice
          // (COMPANY_ACCOUNT → USDT; ADMIN_PERSONAL → chosen; legacy default →
          // obligation currency).
          currency,
          // ADMIN_PERSONAL → the paying partner is the sender; COMPANY_ACCOUNT /
          // legacy → no personal sender, label 'COMPANY'.
          senderId,
          senderLabel,
          // Company-account debit marker — counted by the ledger SSOT. Only set
          // for a company-funded settlement; an ADMIN_PERSONAL payout carries no
          // marker (the shared balance must not move).
          fundingSource: debitsCompanyAccount ? COMPANY_ACCOUNT_FUNDING_SOURCE : null,
          receiverId: obligation.creditorUserId,
          recipientId: obligation.creditorUserId,
          projectId: project?.id ?? null,
          notes: `Выплата senior IOU (obligation ${obligation.id})`,
          createdBy: actor.id,
          validatedBy: actor.id,
          validatedAt: new Date(),
        })
        .returning()
      if (paidRow) created.push(paidRow)
      // Backfill the closing transaction pointer now that the SENIOR_INCOME row
      // exists. The status flip already happened atomically above; this only adds
      // the audit FK and is safe — we still scope it to the row we just claimed.
      await dbtx
        .update(pendingObligations)
        .set({
          closingTransactionId: paidRow?.id ?? null,
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
   */
  private async resolveSourceProject(
    sourceTransactionId: string,
  ): Promise<{ id: string; name: string } | null> {
    const source = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, sourceTransactionId),
    })
    if (!source?.projectId) return null
    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, source.projectId),
    })
    return project ? { id: project.id, name: project.name } : null
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
