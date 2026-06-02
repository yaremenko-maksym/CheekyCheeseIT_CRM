/**
 * Drop role - phase 4 (refactor — task-drop-phase4-refactor-remove-tov.md).
 * Pending senior settlement service.
 *
 * After the refactor only the DROP-debt lifecycle remains:
 *
 *   debtorType='DROP': the DROP user kept the senior share when they handed
 *   cash to the admin. The DROP closes this via `settleByDrop` once they
 *   pay the senior out-of-band — single SENIOR_PAID row records the closure.
 *
 * The TOV-debt lifecycle (bank channel) has been removed (AC3): both
 * `listTovObligations` and `settleByTov` are gone. Historical rows that
 * carry `debtorType='TOV'` may still exist in the table but are not surfaced
 * by the read endpoints below — only DROP-debtor rows are returned.
 *
 * Read endpoints:
 *   - `listSeniorObligations` — SENIOR sees own; ADMIN/ACCOUNTANT see all
 *     (DROP-debtor obligations only).
 *   - `listDropObligations`   — DROP sees own debts; ADMIN/ACCOUNTANT see all.
 *
 * The DTO denormalises drop/senior/project names so the UI cards render
 * without follow-up requests.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
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

@Injectable()
export class PendingSettlementService {
  constructor(private readonly db: DatabaseService) {}

  // ── Read endpoints ────────────────────────────────────────────────────────

  /**
   * SENIOR self-view: returns own PENDING obligations from DROP debtors.
   * ADMIN/ACCOUNTANT: returns every PENDING obligation from DROP debtors
   * across all seniors. TOV-debtor history rows are intentionally excluded.
   */
  async listSeniorObligations(actor: SessionUser): Promise<PendingSettlementItemDto[]> {
    if (actor.role !== 'SENIOR' && actor.role !== 'ADMIN' && actor.role !== 'ACCOUNTANT') {
      throw new ForbiddenException(
        'Список ожидающих зачислений доступен синьорам, бухгалтерам и админам',
      )
    }
    const conjuncts = [
      eq(pendingObligations.status, 'PENDING'),
      eq(pendingObligations.debtorType, 'DROP'),
    ]
    if (actor.role === 'SENIOR') {
      conjuncts.push(eq(pendingObligations.creditorUserId, actor.id))
    }
    return this.loadAndDenormalise(conjuncts)
  }

  /**
   * DROP-debt view. DROP sees only own obligations (debtorUserId === actor.id);
   * ADMIN/ACCOUNTANT see every debtorType='DROP' obligation across all drops.
   */
  async listDropObligations(actor: SessionUser): Promise<PendingSettlementItemDto[]> {
    if (actor.role !== 'DROP' && actor.role !== 'ADMIN' && actor.role !== 'ACCOUNTANT') {
      throw new ForbiddenException(
        'Список долгов перед синьорами доступен дропам, бухгалтерам и админам',
      )
    }
    const conjuncts = [
      eq(pendingObligations.status, 'PENDING'),
      eq(pendingObligations.debtorType, 'DROP'),
    ]
    if (actor.role === 'DROP') {
      conjuncts.push(eq(pendingObligations.debtorUserId, actor.id))
    }
    return this.loadAndDenormalise(conjuncts)
  }

  // ── Settle endpoints ──────────────────────────────────────────────────────

  /**
   * Close a DROP-debt obligation. RBAC: the debtor DROP themselves OR
   * ACCOUNTANT/ADMIN acting on their behalf.
   *
   * Atomic cascade:
   *   - Insert SENIOR_PAID transaction (senderId=drop, receiverId=senior).
   *     `senderLabel='DROP'` marks the audit trail so the senior balance
   *     breakdown can attribute the credit.
   *   - Patch obligation → status=PAID, closingTransactionId=<paid row id>.
   */
  async settleByDrop(
    obligationId: string,
    actor: SessionUser,
  ): Promise<{ obligation: PendingObligationDto; created: TransactionDto[] }> {
    const obligation = await this.loadObligation(obligationId)
    if (obligation.debtorType !== 'DROP') {
      throw new BadRequestException('Этот долг не закрывается дропом (debtorType должен быть DROP)')
    }
    if (obligation.status !== 'PENDING') {
      throw new BadRequestException('Долг уже закрыт или отменён')
    }
    // RBAC: drop debtor themselves, or ACCOUNTANT/ADMIN. Other roles 403.
    if (actor.role === 'DROP') {
      if (obligation.debtorUserId !== actor.id) {
        throw new ForbiddenException('Дроп может закрывать только свои долги')
      }
    } else if (actor.role !== 'ACCOUNTANT' && actor.role !== 'ADMIN') {
      throw new ForbiddenException('Закрывать DROP-долг могут только сам дроп, бухгалтер или админ')
    }

    const project = await this.resolveSourceProject(obligation.sourceTransactionId)
    const created: Transaction[] = []
    await this.db.db.transaction(async (dbtx) => {
      const [paidRow] = await dbtx
        .insert(transactions)
        .values({
          type: 'SENIOR_PAID',
          status: 'PAID',
          amount: obligation.amount,
          currency: obligation.currency,
          senderId: obligation.debtorUserId,
          senderLabel: 'DROP',
          receiverId: obligation.creditorUserId,
          recipientId: obligation.creditorUserId,
          projectId: project?.id ?? null,
          notes: `Phase 4-C — DROP закрыл senior IOU (obligation ${obligation.id})`,
          createdBy: actor.id,
        })
        .returning()
      if (paidRow) created.push(paidRow)
      await dbtx
        .update(pendingObligations)
        .set({
          status: 'PAID',
          closingTransactionId: paidRow?.id ?? null,
          updatedAt: new Date(),
        })
        .where(eq(pendingObligations.id, obligation.id))
    })

    const refreshed = await this.db.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.id, obligation.id),
    })
    return {
      obligation: this.toObligationDto(refreshed ?? { ...obligation, status: 'PAID' as const }),
      created: created.map((c) => this.toTransactionDto(c)),
    }
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
   * Walk source transaction → projectId so the SENIOR_PAID row keeps the
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
   * Load obligations matching the AND-conjuncts, then resolve creditor/debtor
   * display names + project name in batched per-row lookups. Result rows are
   * sorted by createdAt DESC (most recent first).
   */
  private async loadAndDenormalise(
    conjuncts: Array<ReturnType<typeof eq>>,
  ): Promise<PendingSettlementItemDto[]> {
    const rows = await this.db.db.query.pendingObligations.findMany({
      where: and(...conjuncts),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    })

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
    debtorType: 'DROP' | 'TOV' | 'ADMIN'
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
