/**
 * Drop role - phase 4 (refactor — task-drop-phase4-refactor-remove-tov.md).
 *
 * Payment channels for settling a validated DROP_INCOME with the company.
 * After the refactor only two channels remain, and the cash flow is
 * admin-initiated:
 *
 *   1. Crypto direct — drop sends USDT to 3 wallets (senior + 2 admins).
 *                      Creates SENIOR_INCOME_CRYPTO + 2× ADMIN_INCOME_CRYPTO
 *                      on confirm.
 *   2. Cash to admin — ACCOUNTANT/ADMIN clicks «Cash передан» on the
 *                      VALIDATED DROP_INCOME row in /crm/finance, picks
 *                      Maksym/Kostya in a dialog. Creates ADMIN_INCOME_CASH
 *                      + SENIOR_PENDING_PAYOUT (debtorType=DROP).
 *                      DROP no longer has any UI to initiate cash.
 *
 * Bank channel (was: corporate ТОВ wire transfer) has been removed
 * entirely. The TOV_INCOME / debtorType='TOV' code path that produced
 * SENIOR_PENDING_PAYOUT against the ТОВ balance is gone — see refactor
 * task AC1 / AC3.
 *
 * Both remaining channels close the placeholder PAYOUT row
 * (PENDING_PAYMENT → PAID) created during DROP_INCOME validation so the
 * drop's «Платить компании» action is single-use per income.
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
  /**
   * task-team-senior-share-override. Snapshot of the senior-share
   * resolution used for `distribution` — propagated into every cascade
   * transaction insert (SENIOR_INCOME_CRYPTO, SENIOR_PENDING_PAYOUT, …)
   * so the source badge follows the money trail through the ledger.
   */
  seniorShareSnapshot: {
    value: number
    source: 'PROJECT' | 'TEAM' | 'USER_DEFAULT'
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
      // task-team-senior-share-override. Snapshot both value + source on
      // the cascade row so the UI can render «Доля: X% · команда» (or
      // 'проект' / 'default') on the SENIOR_INCOME_CRYPTO line.
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
          seniorSharePercent: ctx.seniorShareSnapshot.value,
          seniorSharePercentSource: ctx.seniorShareSnapshot.source,
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

  // ── Cash channel (admin-initiated, post-Phase-4-refactor) ───────────────
  //
  // Single-step flow:
  //   ACCOUNTANT/ADMIN sees the VALIDATED DROP_INCOME row that does not yet
  //   have a payment-channel cascade. They click «Cash передан», pick which
  //   admin actually received the cash, and submit. The handler inserts
  //   ADMIN_INCOME_CASH + SENIOR_PENDING_PAYOUT (debtorType=DROP) and flips
  //   the placeholder PAYOUT to PAID — same shape as the prior round-2
  //   confirm-cash flow, only without the DROP-initiated PENDING_CASH_CONFIRM
  //   intermediate state.

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

    // Resolve income context. We use a confirm-variant resolver that returns
    // the payout row (if any) but DOES enforce the cascade-existence guard so
    // a second click on an already-settled income surfaces a clean 400.
    const ctx = await this.resolveIncomeForCashConfirm(incomeId)

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
    // (debtorType=DROP) until SENIOR_PAID closes the obligation.
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
          notes: 'Phase 4 cash channel — admin received cash (admin-initiated)',
          createdBy: actor.id,
        })
        .returning()
      if (cashRow) created.push(cashRow)

      // task-team-senior-share-override. Same source-propagation as the
      // crypto branch — the IOU carries the snapshot used to compute it.
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
          seniorSharePercent: ctx.seniorShareSnapshot.value,
          seniorSharePercentSource: ctx.seniorShareSnapshot.source,
          notes: 'Phase 4 cash channel — senior IOU (debtor=DROP)',
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

      // Close or create the PAYOUT placeholder. Pre-existing legacy
      // DROP_INCOMEs (created before Phase 2 cascade) lack a PAYOUT row;
      // re-create it as PAID so audit/list views see a consistent record.
      if (ctx.payoutTxId) {
        await this.closePayout(dbtx, ctx.payoutTxId, null)
      } else {
        await dbtx.insert(transactions).values({
          type: 'PAYOUT',
          status: 'PAID',
          amount: String(ctx.distribution.payableTotal),
          currency: 'USDT',
          senderId: ctx.drop.id,
          receiverLabel: 'CheekyCheeseIT',
          projectId: ctx.project.id,
          payoutRequestId: ctx.income.payoutRequestId,
          notes: 'Phase 4 cash channel — PAYOUT auto-created at confirm time',
          createdBy: actor.id,
          validatedBy: actor.id,
          validatedAt: new Date(),
        })
      }
    })

    const refreshed = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, ctx.income.id),
    })
    return { income: refreshed ?? ctx.income, created }
  }

  /**
   * Cash-confirm variant of `resolveIncome`. Enforces the same DROP_INCOME +
   * VALIDATED gate as `resolveIncome`, AND also runs the cascade-existence
   * guard so a second confirm on an already-settled income surfaces 400.
   * Skips the DROP-only RBAC because cash confirm is ADMIN/ACCOUNTANT only.
   */
  private async resolveIncomeForCashConfirm(incomeId: string): Promise<ResolvedIncomeContext> {
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
    // task-team-senior-share-override. Resolve senior share with source
    // before distribution math — the `value` overrides the senior's user
    // default in `computeDropDistribution`, the `source` is preserved on
    // the returned context for downstream cascade inserts.
    const snapshot = await this.transactionsService.resolveSeniorShareSnapshot(
      { seniorSharePercentOverride: project.seniorSharePercentOverride },
      { id: senior.id, seniorSharePercent: senior.seniorSharePercent },
    )
    const distribution = this.transactionsService.computeDropDistribution(
      gross,
      { id: project.id, dropId: project.dropId },
      { id: drop.id, dropSharePercent: drop.dropSharePercent },
      { id: senior.id, seniorSharePercent: snapshot.value },
    )
    const payableTotal =
      distribution.seniorShare.amount + distribution.partnerShares.reduce((s, p) => s + p.amount, 0)

    // Find PAYOUT row (might be PENDING_PAYMENT, PAID, or — legacy — absent).
    let payoutTxId: string | null = null
    let payoutAlreadyPaid = false
    if (income.payoutRequestId) {
      const payoutRow = await this.db.db.query.transactions.findFirst({
        where: and(
          eq(transactions.payoutRequestId, income.payoutRequestId),
          eq(transactions.type, 'PAYOUT'),
        ),
      })
      if (payoutRow) {
        payoutTxId = payoutRow.id
        if (payoutRow.status === 'PAID') payoutAlreadyPaid = true
      }
    }
    if (payoutAlreadyPaid) {
      throw new BadRequestException('DROP_INCOME already settled via another channel')
    }

    // Cascade-existence guard: no Phase 4 income/credit rows must exist yet.
    if (income.payoutRequestId) {
      const channelRows = await this.db.db.query.transactions.findMany({
        where: and(
          eq(transactions.payoutRequestId, income.payoutRequestId),
          inArray(transactions.type, [
            'SENIOR_INCOME_CRYPTO',
            'ADMIN_INCOME_CRYPTO',
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
      seniorShareSnapshot: snapshot,
      payoutTxId,
    }
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  /**
   * Pulls the DROP_INCOME row, the drop project, the drop + senior users,
   * computes the distribution, and locates the placeholder PAYOUT row from
   * validation cascade. The same context backs the crypto channel.
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
    // task-team-senior-share-override. Apply the same resolver hierarchy
    // as `assertCanInitiate` so the cascade math matches across paths.
    const gross = parseFloat(income.amount)
    const snapshot = await this.transactionsService.resolveSeniorShareSnapshot(
      { seniorSharePercentOverride: project.seniorSharePercentOverride },
      { id: senior.id, seniorSharePercent: senior.seniorSharePercent },
    )
    const distribution = this.transactionsService.computeDropDistribution(
      gross,
      { id: project.id, dropId: project.dropId },
      { id: drop.id, dropSharePercent: drop.dropSharePercent },
      { id: senior.id, seniorSharePercent: snapshot.value },
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

    // Additional double-payment guard: any Phase 4 credit rows for this
    // income already in the ledger means a previous attempt landed.
    if (income.payoutRequestId) {
      const channelRows = await this.db.db.query.transactions.findMany({
        where: and(
          eq(transactions.payoutRequestId, income.payoutRequestId),
          inArray(transactions.type, [
            'SENIOR_INCOME_CRYPTO',
            'ADMIN_INCOME_CRYPTO',
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
      seniorShareSnapshot: snapshot,
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
