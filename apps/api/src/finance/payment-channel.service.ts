/**
 * Drop role - phase 4-B. Payment channels for settling a validated
 * DROP_INCOME with the company. Three alternative channels live alongside the
 * legacy Phase 2 `payPayoutRequest` and Phase 3 `confirmPayout` flows — none
 * of those existing paths are touched by this service.
 *
 *   1. Crypto direct  — drop sends USDT to 3 wallets (senior + 2 admins).
 *                       Creates SENIOR_INCOME_CRYPTO + 2× ADMIN_INCOME_CRYPTO
 *                       on confirm.
 *   2. Bank transfer  — drop wires UAH to the corporate ТОВ account. On
 *                       accountant confirmation creates TOV_INCOME +
 *                       SENIOR_PENDING_PAYOUT (debtorType=TOV) and registers
 *                       a pending_obligations row for the senior payout.
 *   3. Cash to admin  — drop hands physical cash to ONE admin (Maksym/Kostya).
 *                       Creates ADMIN_INCOME_CASH + SENIOR_PENDING_PAYOUT
 *                       (debtorType=DROP) immediately — no validation step.
 *
 * All three channels close the placeholder PAYOUT row (PENDING_PAYMENT → PAID)
 * created during DROP_INCOME validation so the drop's «Платить компании»
 * action is single-use per income.
 *
 * Numbers — math is generic but spec uses 16% senior / 10% drop / 37%+37%
 * partners on $3500: senior=$560, drop=$350, partners=$1295 each.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, eq, inArray } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { MAKSYM_ID, KOSTYA_ID } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import {
  pendingObligations,
  projects,
  transactions,
  users,
  type Transaction,
} from '../database/schema'
import { TransactionsService } from './transactions.service'

// Banking details of the corporate (ТОВ) account. Server-side env-driven so
// production/staging can swap without code changes. Defaults are documented
// placeholders matching the Phase 4-B spec example.
function readTovBankDetails() {
  return {
    recipient: process.env['TOV_BANK_RECIPIENT'] ?? 'ТОВ "Cheeky Cheese IT"',
    iban: process.env['TOV_BANK_IBAN'] ?? 'UA00 0000 0000 0000 0000 0000 000',
    rnokpp: process.env['TOV_BANK_RNOKPP'] ?? '00000000',
    bankName: process.env['TOV_BANK_NAME'] ?? 'JSC «Universal Bank»',
  }
}

export interface CryptoRecipient {
  userId: string
  displayName: string
  address: string
  amount: string
  currency: 'USDT' | 'USD' | 'EUR' | 'UAH'
  role: 'SENIOR' | 'ADMIN'
}

export interface InitiateCryptoResult {
  contractAddress: string | null
  recipients: CryptoRecipient[]
  currency: 'USDT' | 'USD' | 'EUR' | 'UAH'
}

export interface InitiateBankResult {
  tovBankDetails: {
    recipient: string
    iban: string
    rnokpp: string
    bankName: string
    reference: string
  }
  amount: string
  currency: 'USDT' | 'USD' | 'EUR' | 'UAH'
}

/**
 * Resolved bundle of everything we need to act on a DROP_INCOME: the income
 * row, the drop-project + drop user + senior user, and the computed
 * distribution (senior / drop / 50-50 partners). Computed once at the start
 * of every channel flow so the rest of the service deals with structured
 * data instead of re-fetching.
 */
interface ResolvedIncomeContext {
  income: Transaction
  project: { id: string; dropId: string | null; seniorId: string }
  drop: { id: string; displayName: string; walletUsdtErc20: string | null }
  senior: { id: string; displayName: string; walletUsdtErc20: string | null }
  distribution: {
    seniorAmount: number
    dropAmount: number
    partnerShares: { adminId: string; amount: number }[]
    /** total drop has to pay company-side (= senior + partners) */
    payableTotal: number
  }
  payoutTxId: string | null
}

@Injectable()
export class PaymentChannelService {
  constructor(
    private readonly db: DatabaseService,
    private readonly transactionsService: TransactionsService,
  ) {}

  // ── Crypto channel ──────────────────────────────────────────────────────

  async initiateCryptoPayment(incomeId: string, actor: SessionUser): Promise<InitiateCryptoResult> {
    const ctx = await this.resolveIncome(incomeId, actor)
    this.assertCanInitiate(ctx, actor)

    // Wallets: senior + 2 admin partners. Phase 4-B doesn't auto-create
    // wallets; if a participant has no wallet on file we surface an empty
    // string so the frontend can prompt them rather than failing the entire
    // flow. The actual transaction creation in confirm requires non-empty
    // hashes (one per recipient).
    const recipients: CryptoRecipient[] = []
    recipients.push({
      userId: ctx.senior.id,
      displayName: ctx.senior.displayName,
      address: ctx.senior.walletUsdtErc20 ?? '',
      amount: String(ctx.distribution.seniorAmount),
      currency: 'USDT',
      role: 'SENIOR',
    })
    for (const share of ctx.distribution.partnerShares) {
      const admin = await this.db.db.query.users.findFirst({
        where: eq(users.id, share.adminId),
      })
      if (!admin) continue
      recipients.push({
        userId: admin.id,
        displayName: admin.displayName,
        address: admin.walletUsdtErc20 ?? '',
        amount: String(share.amount),
        currency: 'USDT',
        role: 'ADMIN',
      })
    }

    return {
      contractAddress: null, // Phase 5: PaymentSplitter address; null today.
      recipients,
      currency: 'USDT',
    }
  }

  async confirmCryptoPayment(
    incomeId: string,
    txHashes: string[],
    actor: SessionUser,
  ): Promise<{ income: Transaction; created: Transaction[] }> {
    if (!Array.isArray(txHashes) || txHashes.length === 0) {
      throw new BadRequestException('txHashes is required')
    }
    const ctx = await this.resolveIncome(incomeId, actor)
    this.assertCanConfirmCrypto(ctx, actor)

    // We log one hash per recipient. If the drop supplied only one (single
    // PaymentSplitter call), we reuse it across all 3 rows so the audit trail
    // never carries a null hash. If they supplied 3 distinct hashes we
    // align by index (senior first, partners after).
    const hashFor = (i: number): string => txHashes[i] ?? txHashes[0] ?? '0xUNKNOWN'

    const created: Transaction[] = []
    await this.db.db.transaction(async (dbtx) => {
      // 1) Senior income (crypto direct).
      const [seniorRow] = await dbtx
        .insert(transactions)
        .values({
          type: 'SENIOR_INCOME_CRYPTO',
          status: 'PAID',
          amount: String(ctx.distribution.seniorAmount),
          currency: 'USDT',
          senderId: ctx.drop.id,
          receiverId: ctx.senior.id,
          recipientId: ctx.senior.id,
          projectId: ctx.project.id,
          payoutRequestId: ctx.income.payoutRequestId,
          txHash: hashFor(0),
          notes: 'Phase 4-B crypto channel — senior direct',
          createdBy: actor.id,
        })
        .returning()
      if (seniorRow) created.push(seniorRow)

      // 2) Admin partners (crypto direct), one row each.
      let i = 1
      for (const share of ctx.distribution.partnerShares) {
        const [adminRow] = await dbtx
          .insert(transactions)
          .values({
            type: 'ADMIN_INCOME_CRYPTO',
            status: 'PAID',
            amount: String(share.amount),
            currency: 'USDT',
            senderId: ctx.drop.id,
            receiverId: share.adminId,
            recipientId: share.adminId,
            projectId: ctx.project.id,
            payoutRequestId: ctx.income.payoutRequestId,
            txHash: hashFor(i),
            notes: 'Phase 4-B crypto channel — admin direct',
            createdBy: actor.id,
          })
          .returning()
        if (adminRow) created.push(adminRow)
        i += 1
      }

      // 3) Close the placeholder PAYOUT row, if one exists. The DROP_INCOME
      //    was validated via the legacy cascade which already inserted PAYOUT
      //    in PENDING_PAYMENT; we flip it to PAID and stamp the first hash.
      await this.closePayout(dbtx, ctx.payoutTxId, hashFor(0))
    })

    const refreshed = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, ctx.income.id),
    })
    return { income: refreshed ?? ctx.income, created }
  }

  // ── Bank channel ────────────────────────────────────────────────────────

  initiateBankPayment(incomeId: string, _actor?: SessionUser): InitiateBankResult
  initiateBankPayment(incomeId: string, actor: SessionUser): Promise<InitiateBankResult>
  initiateBankPayment(
    incomeId: string,
    actor?: SessionUser,
  ): InitiateBankResult | Promise<InitiateBankResult> {
    // Two-arg overload returns a promise — we hit the DB to verify access.
    if (actor) {
      return (async () => {
        const ctx = await this.resolveIncome(incomeId, actor)
        this.assertCanInitiate(ctx, actor)
        const details = readTovBankDetails()
        return {
          tovBankDetails: { ...details, reference: `INV-INC-${ctx.income.id}` },
          amount: String(ctx.distribution.payableTotal),
          currency: 'USDT',
        }
      })()
    }
    // Single-arg sync overload — used by unit tests to verify the reference
    // shape without standing up the DB. Kept private to the module surface.
    const details = readTovBankDetails()
    return {
      tovBankDetails: { ...details, reference: `INV-INC-${incomeId}` },
      amount: '0',
      currency: 'USDT',
    }
  }

  async confirmBankPayment(
    incomeId: string,
    actor: SessionUser,
  ): Promise<{ income: Transaction; created: Transaction[] }> {
    if (actor.role !== 'ADMIN' && actor.role !== 'ACCOUNTANT') {
      throw new ForbiddenException('Только ADMIN/ACCOUNTANT может подтверждать банковскую оплату')
    }
    const ctx = await this.resolveIncome(incomeId, actor)
    this.assertNotAlreadyPaid(ctx)

    const created: Transaction[] = []
    await this.db.db.transaction(async (dbtx) => {
      // 1) TOV_INCOME — money lands on the corporate account. Amount is the
      //    entire payable (senior + partners), not just the partner residual.
      const [tovRow] = await dbtx
        .insert(transactions)
        .values({
          type: 'TOV_INCOME',
          status: 'PAID',
          amount: String(ctx.distribution.payableTotal),
          currency: 'USDT',
          senderId: ctx.drop.id,
          receiverLabel: 'FIAT_TOV',
          projectId: ctx.project.id,
          payoutRequestId: ctx.income.payoutRequestId,
          notes: `Phase 4-B bank channel — ТОВ счёт, ref INV-INC-${ctx.income.id}`,
          createdBy: actor.id,
        })
        .returning()
      if (tovRow) created.push(tovRow)

      // 2) SENIOR_PENDING_PAYOUT — TOВ owes the senior. Source row carries
      //    the obligation amount; balance is NOT moved until a SENIOR_PAID
      //    row closes it (Phase 4-C).
      const [pendingRow] = await dbtx
        .insert(transactions)
        .values({
          type: 'SENIOR_PENDING_PAYOUT',
          status: 'PENDING_PAYMENT',
          amount: String(ctx.distribution.seniorAmount),
          currency: 'USDT',
          senderLabel: 'ТОВ',
          receiverId: ctx.senior.id,
          recipientId: ctx.senior.id,
          projectId: ctx.project.id,
          payoutRequestId: ctx.income.payoutRequestId,
          notes: 'Phase 4-B bank channel — senior IOU (debtor=TOV)',
          createdBy: actor.id,
        })
        .returning()
      if (pendingRow) {
        created.push(pendingRow)
        await dbtx.insert(pendingObligations).values({
          creditorUserId: ctx.senior.id,
          debtorType: 'TOV',
          debtorUserId: null,
          sourceTransactionId: pendingRow.id,
          amount: String(ctx.distribution.seniorAmount),
          currency: 'USDT',
          status: 'PENDING',
        })
      }

      // 3) Close the placeholder PAYOUT row.
      await this.closePayout(dbtx, ctx.payoutTxId, null)
    })

    const refreshed = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, ctx.income.id),
    })
    return { income: refreshed ?? ctx.income, created }
  }

  // ── Cash channel (round-2 architecture) ────────────────────────────────
  //
  // Two-step flow:
  //   1. /initiate-cash — DROP (or ACCOUNTANT/ADMIN acting on the drop's
  //      behalf) marks the placeholder PAYOUT row as PENDING_CASH_CONFIRM.
  //      No income transactions are inserted yet — the recipient admin is
  //      decided out-of-band (call, physical handoff) and recorded in step 2.
  //   2. /confirm-cash — ACCOUNTANT/ADMIN picks which admin actually got the
  //      cash. ADMIN_INCOME_CASH + SENIOR_PENDING_PAYOUT cascade is inserted
  //      against that admin and the PAYOUT flips to PAID.

  async initiateCashPayment(
    incomeId: string,
    actor: SessionUser,
  ): Promise<{ incomeId: string; payoutId: string | null; status: 'PENDING_CASH_CONFIRM' }> {
    const ctx = await this.resolveIncome(incomeId, actor)
    this.assertCanInitiate(ctx, actor)

    if (!ctx.payoutTxId) {
      // Legacy DROP_INCOMEs (pre-Phase-2) skip the cascade — we cannot mark
      // anything as PENDING_CASH_CONFIRM without a PAYOUT row. Reject so the
      // UI never lands in a state where the drop "submitted" but the
      // accountant has nothing to confirm.
      throw new BadRequestException(
        'DROP_INCOME has no placeholder PAYOUT row — cash channel is unavailable',
      )
    }

    // Re-fetch to detect "already initiated" state — resolveIncome doesn't
    // distinguish between PENDING_PAYMENT and PENDING_CASH_CONFIRM (both are
    // "not yet PAID"), so we surface a friendlier 400 here.
    const payoutRow = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, ctx.payoutTxId),
    })
    if (payoutRow?.status === 'PENDING_CASH_CONFIRM') {
      throw new BadRequestException('Этот приход уже ожидает подтверждения бухгалтера')
    }

    // Wrap the single update in a transaction so the mock test harness
    // (which only stubs the transactional `.update`) still sees the call.
    const payoutTxId = ctx.payoutTxId
    await this.db.db.transaction(async (dbtx) => {
      await dbtx
        .update(transactions)
        .set({ status: 'PENDING_CASH_CONFIRM', updatedAt: new Date() })
        .where(eq(transactions.id, payoutTxId))
    })

    return {
      incomeId: ctx.income.id,
      payoutId: payoutTxId,
      status: 'PENDING_CASH_CONFIRM',
    }
  }

  async confirmCashPayment(
    incomeId: string,
    recipientAdminId: string,
    actor: SessionUser,
  ): Promise<{ income: Transaction; created: Transaction[] }> {
    // RBAC: only ACCOUNTANT / ADMIN — DROP is explicitly forbidden.
    if (actor.role !== 'ACCOUNTANT' && actor.role !== 'ADMIN') {
      throw new ForbiddenException(
        'Подтверждать получение нала может только бухгалтер или администратор',
      )
    }

    // Re-resolve income context. We allow the resolver to run as ACCOUNTANT/
    // ADMIN — DROP-only guards inside `resolveIncome` are skipped because the
    // actor role isn't DROP here. The confirm-variant also returns the
    // payout row itself so we can verify its status without an extra fetch.
    const { ctx, payoutRow } = await this.resolveIncomeForConfirm(incomeId)

    if (!ctx.payoutTxId) {
      throw new BadRequestException('No placeholder PAYOUT row to confirm')
    }
    if (!payoutRow) {
      throw new NotFoundException('PAYOUT row not found')
    }
    if (payoutRow.status !== 'PENDING_CASH_CONFIRM') {
      throw new BadRequestException(
        `PAYOUT must be in PENDING_CASH_CONFIRM to confirm cash receipt (is ${payoutRow.status})`,
      )
    }

    const admin = await this.db.db.query.users.findFirst({
      where: eq(users.id, recipientAdminId),
    })
    if (!admin) throw new BadRequestException('Recipient admin not found')
    if (admin.role !== 'ADMIN') {
      throw new BadRequestException('Recipient must be an ADMIN')
    }
    if (admin.archivedAt) {
      throw new BadRequestException('Recipient admin is archived')
    }

    // Cash = the chosen admin received the full partner share (both admins'
    // 50-50 combined). Senior share remains owed by the drop personally
    // (debtorType=DROP) — Phase 4-C will close it via SENIOR_PAID when the
    // drop and senior settle off-platform.
    const partnerTotal = ctx.distribution.partnerShares.reduce((s, p) => s + p.amount, 0)

    const created: Transaction[] = []
    await this.db.db.transaction(async (dbtx) => {
      const [cashRow] = await dbtx
        .insert(transactions)
        .values({
          type: 'ADMIN_INCOME_CASH',
          status: 'PAID',
          amount: String(partnerTotal),
          currency: 'USDT',
          senderId: ctx.drop.id,
          receiverId: admin.id,
          recipientId: admin.id,
          projectId: ctx.project.id,
          payoutRequestId: ctx.income.payoutRequestId,
          notes: 'Phase 4-B cash channel — admin received cash',
          createdBy: actor.id,
        })
        .returning()
      if (cashRow) created.push(cashRow)

      const [pendingRow] = await dbtx
        .insert(transactions)
        .values({
          type: 'SENIOR_PENDING_PAYOUT',
          status: 'PENDING_PAYMENT',
          amount: String(ctx.distribution.seniorAmount),
          currency: 'USDT',
          senderId: ctx.drop.id,
          senderLabel: 'DROP',
          receiverId: ctx.senior.id,
          recipientId: ctx.senior.id,
          projectId: ctx.project.id,
          payoutRequestId: ctx.income.payoutRequestId,
          notes: 'Phase 4-B cash channel — senior IOU (debtor=DROP)',
          createdBy: actor.id,
        })
        .returning()
      if (pendingRow) {
        created.push(pendingRow)
        await dbtx.insert(pendingObligations).values({
          creditorUserId: ctx.senior.id,
          debtorType: 'DROP',
          debtorUserId: ctx.drop.id,
          sourceTransactionId: pendingRow.id,
          amount: String(ctx.distribution.seniorAmount),
          currency: 'USDT',
          status: 'PENDING',
        })
      }

      await this.closePayout(dbtx, ctx.payoutTxId, null)
    })

    const refreshed = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, ctx.income.id),
    })
    return { income: refreshed ?? ctx.income, created }
  }

  /**
   * GET /api/payments/pending-cash — accountant / admin dashboard list of
   * PAYOUT rows sitting in PENDING_CASH_CONFIRM. One row per income; we walk
   * back to the drop user + project for display.
   */
  async listPendingCash(actor: SessionUser): Promise<
    {
      incomeId: string
      payoutId: string
      dropId: string
      dropName: string
      projectId: string | null
      projectName: string | null
      amount: string
      currency: 'USDT' | 'USD' | 'EUR' | 'UAH'
      initiatedAt: string
    }[]
  > {
    if (actor.role !== 'ACCOUNTANT' && actor.role !== 'ADMIN') {
      throw new ForbiddenException(
        'Список ожидающих подтверждения нала виден только бухгалтеру и админу',
      )
    }
    const pendingRows = await this.db.db.query.transactions.findMany({
      where: and(eq(transactions.type, 'PAYOUT'), eq(transactions.status, 'PENDING_CASH_CONFIRM')),
    })

    const result: Awaited<ReturnType<PaymentChannelService['listPendingCash']>> = []
    for (const payout of pendingRows) {
      if (!payout.payoutRequestId) continue
      // Find the DROP_INCOME that drives this payout.
      const income = await this.db.db.query.transactions.findFirst({
        where: and(
          eq(transactions.payoutRequestId, payout.payoutRequestId),
          eq(transactions.type, 'DROP_INCOME'),
        ),
      })
      if (!income) continue
      const [drop, project] = await Promise.all([
        payout.senderId
          ? this.db.db.query.users.findFirst({ where: eq(users.id, payout.senderId) })
          : Promise.resolve(undefined),
        income.projectId
          ? this.db.db.query.projects.findFirst({ where: eq(projects.id, income.projectId) })
          : Promise.resolve(undefined),
      ])
      result.push({
        incomeId: income.id,
        payoutId: payout.id,
        dropId: drop?.id ?? payout.senderId ?? '',
        dropName: drop?.displayName ?? '—',
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        amount: payout.amount,
        currency: payout.currency as 'USDT' | 'USD' | 'EUR' | 'UAH',
        initiatedAt: (payout.updatedAt ?? payout.createdAt).toISOString(),
      })
    }
    return result
  }

  /**
   * Confirm-cash variant of `resolveIncome` that does NOT trip the
   * "channel cascade already exists" guard — by design the placeholder
   * PAYOUT row is in PENDING_CASH_CONFIRM (not PAID) and no cascade rows
   * exist yet. Skips the cascade-existence check and the DROP-only RBAC.
   * Also returns the raw payout row so the caller can verify its status.
   */
  private async resolveIncomeForConfirm(
    incomeId: string,
  ): Promise<{ ctx: ResolvedIncomeContext; payoutRow: Transaction | null }> {
    const income = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, incomeId),
    })
    if (!income) throw new NotFoundException('Income transaction not found')
    if (income.type !== 'DROP_INCOME') {
      throw new BadRequestException('Only DROP_INCOME can be paid via channels')
    }
    if (income.status !== 'VALIDATED') {
      throw new BadRequestException('DROP_INCOME must be VALIDATED before payment')
    }

    if (!income.projectId) {
      throw new BadRequestException('DROP_INCOME has no projectId')
    }
    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, income.projectId),
    })
    if (!project) throw new NotFoundException('Project not found')
    if (!project.dropId) {
      throw new BadRequestException('Project is not a drop-project')
    }
    if (!project.seniorId) {
      throw new BadRequestException('Project has no senior assigned')
    }

    const [drop, senior] = await Promise.all([
      this.db.db.query.users.findFirst({ where: eq(users.id, project.dropId) }),
      this.db.db.query.users.findFirst({ where: eq(users.id, project.seniorId) }),
    ])
    if (!drop) throw new NotFoundException('Drop user not found')
    if (!senior) throw new NotFoundException('Senior user not found')

    const gross = parseFloat(income.amount)
    const distribution = this.transactionsService.computeDropDistribution(
      gross,
      { id: project.id, dropId: project.dropId },
      { id: drop.id, dropSharePercent: drop.dropSharePercent },
      { id: senior.id, seniorSharePercent: senior.seniorSharePercent },
    )
    const payableTotal =
      distribution.seniorShare.amount + distribution.partnerShares.reduce((s, p) => s + p.amount, 0)

    let payoutTxId: string | null = null
    let payoutRow: Transaction | null = null
    if (income.payoutRequestId) {
      const row = await this.db.db.query.transactions.findFirst({
        where: and(
          eq(transactions.payoutRequestId, income.payoutRequestId),
          eq(transactions.type, 'PAYOUT'),
        ),
      })
      if (row) {
        // For confirm-cash we expect PENDING_CASH_CONFIRM; caller checks the
        // exact value.
        payoutTxId = row.id
        payoutRow = row
      }
    }

    const ctx: ResolvedIncomeContext = {
      income,
      project: { id: project.id, dropId: project.dropId, seniorId: project.seniorId },
      drop: {
        id: drop.id,
        displayName: drop.displayName,
        walletUsdtErc20: drop.walletUsdtErc20,
      },
      senior: {
        id: senior.id,
        displayName: senior.displayName,
        walletUsdtErc20: senior.walletUsdtErc20,
      },
      distribution: {
        seniorAmount: distribution.seniorShare.amount,
        dropAmount: distribution.dropShare.amount,
        partnerShares: distribution.partnerShares,
        payableTotal,
      },
      payoutTxId,
    }
    return { ctx, payoutRow }
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  /**
   * Pulls the DROP_INCOME row, the drop project, the drop + senior users,
   * computes the distribution, and locates the placeholder PAYOUT row from
   * validation cascade. The same context backs all three channels.
   */
  private async resolveIncome(
    incomeId: string,
    actor: SessionUser,
  ): Promise<ResolvedIncomeContext> {
    const income = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, incomeId),
    })
    if (!income) throw new NotFoundException('Income transaction not found')
    if (income.type !== 'DROP_INCOME') {
      throw new BadRequestException('Only DROP_INCOME can be paid via channels')
    }
    if (income.status !== 'VALIDATED') {
      throw new BadRequestException('DROP_INCOME must be VALIDATED before payment')
    }

    if (!income.projectId) {
      throw new BadRequestException('DROP_INCOME has no projectId')
    }
    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, income.projectId),
    })
    if (!project) throw new NotFoundException('Project not found')
    if (!project.dropId) {
      throw new BadRequestException('Project is not a drop-project')
    }
    if (!project.seniorId) {
      throw new BadRequestException('Project has no senior assigned')
    }

    const [drop, senior] = await Promise.all([
      this.db.db.query.users.findFirst({ where: eq(users.id, project.dropId) }),
      this.db.db.query.users.findFirst({ where: eq(users.id, project.seniorId) }),
    ])
    if (!drop) throw new NotFoundException('Drop user not found')
    if (!senior) throw new NotFoundException('Senior user not found')

    // RBAC pre-check: DROP can only act on their own income.
    if (actor.role === 'DROP' && drop.id !== actor.id) {
      throw new ForbiddenException('DROP может оплачивать только свои приходы')
    }

    // Distribution math reuses the same primitives as Phase 2.
    const gross = parseFloat(income.amount)
    const distribution = this.transactionsService.computeDropDistribution(
      gross,
      { id: project.id, dropId: project.dropId },
      { id: drop.id, dropSharePercent: drop.dropSharePercent },
      { id: senior.id, seniorSharePercent: senior.seniorSharePercent },
    )
    const payableTotal =
      distribution.seniorShare.amount + distribution.partnerShares.reduce((s, p) => s + p.amount, 0)

    // Phase 4-B prevents double-payment by looking at the placeholder PAYOUT
    // row created during validation. If it's already PAID some other channel
    // already settled the income — abort.
    let payoutTxId: string | null = null
    if (income.payoutRequestId) {
      const payoutRow = await this.db.db.query.transactions.findFirst({
        where: and(
          eq(transactions.payoutRequestId, income.payoutRequestId),
          eq(transactions.type, 'PAYOUT'),
        ),
      })
      if (payoutRow) {
        if (payoutRow.status === 'PAID') {
          throw new BadRequestException('DROP_INCOME already settled via another channel')
        }
        payoutTxId = payoutRow.id
      }
    }

    // Additional double-payment guard: any Phase 4-B credit rows for this
    // income already in the ledger means a previous attempt landed.
    if (income.payoutRequestId) {
      const channelRows = await this.db.db.query.transactions.findMany({
        where: and(
          eq(transactions.payoutRequestId, income.payoutRequestId),
          inArray(transactions.type, [
            'SENIOR_INCOME_CRYPTO',
            'ADMIN_INCOME_CRYPTO',
            'TOV_INCOME',
            'ADMIN_INCOME_CASH',
            'SENIOR_PENDING_PAYOUT',
          ]),
        ),
      })
      if (channelRows.length > 0) {
        throw new BadRequestException('DROP_INCOME already has a payment-channel cascade')
      }
    }

    return {
      income,
      project: { id: project.id, dropId: project.dropId, seniorId: project.seniorId },
      drop: {
        id: drop.id,
        displayName: drop.displayName,
        walletUsdtErc20: drop.walletUsdtErc20,
      },
      senior: {
        id: senior.id,
        displayName: senior.displayName,
        walletUsdtErc20: senior.walletUsdtErc20,
      },
      distribution: {
        seniorAmount: distribution.seniorShare.amount,
        dropAmount: distribution.dropShare.amount,
        partnerShares: distribution.partnerShares,
        payableTotal,
      },
      payoutTxId,
    }
  }

  /**
   * Closes the placeholder PAYOUT row inserted at DROP_INCOME validation
   * (Phase 2 cascade). Best-effort — if the row was never created (legacy
   * income before Phase 2) we silently no-op.
   */
  private async closePayout(
    dbtx: Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0],
    payoutTxId: string | null,
    txHash: string | null,
  ): Promise<void> {
    if (!payoutTxId) return
    await dbtx
      .update(transactions)
      .set({
        status: 'PAID',
        ...(txHash !== null ? { txHash } : {}),
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, payoutTxId))
  }

  private assertCanInitiate(ctx: ResolvedIncomeContext, actor: SessionUser): void {
    if (actor.role === 'DROP' && ctx.drop.id !== actor.id) {
      throw new ForbiddenException('DROP может оплачивать только свои приходы')
    }
    if (actor.role !== 'DROP' && actor.role !== 'ADMIN' && actor.role !== 'ACCOUNTANT') {
      throw new ForbiddenException(
        'Доступ к payment-channels только DROP (свои), ADMIN, ACCOUNTANT',
      )
    }
    this.assertNotAlreadyPaid(ctx)
  }

  private assertCanConfirmCrypto(ctx: ResolvedIncomeContext, actor: SessionUser): void {
    if (actor.role !== 'DROP' && actor.role !== 'ACCOUNTANT' && actor.role !== 'ADMIN') {
      throw new ForbiddenException('Подтверждать crypto-канал может DROP/ACCOUNTANT/ADMIN')
    }
    if (actor.role === 'DROP' && ctx.drop.id !== actor.id) {
      throw new ForbiddenException('DROP может оплачивать только свои приходы')
    }
    this.assertNotAlreadyPaid(ctx)
  }

  private assertNotAlreadyPaid(ctx: ResolvedIncomeContext): void {
    if (ctx.income.status !== 'VALIDATED') {
      throw new BadRequestException(`DROP_INCOME must be VALIDATED, is ${ctx.income.status}`)
    }
  }

  /** Helper for partner test fixtures — partner ids are stable seed UUIDs. */
  static get PARTNER_IDS(): string[] {
    return [MAKSYM_ID, KOSTYA_ID]
  }
}
