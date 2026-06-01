import { randomBytes } from 'crypto'
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
  Inject,
} from '@nestjs/common'
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { MAKSYM_ID, KOSTYA_ID } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import {
  projectFinanceSettings,
  projectMembers,
  payoutRequests,
  projects,
  transactions,
  users,
  type Transaction,
} from '../database/schema'
import { InvoicesService } from '../invoices/invoices.service'

type TxWithRelations = Transaction & {
  sender: { displayName: string } | null
  receiver: { displayName: string } | null
  project: { name: string } | null
  payoutRequest?: {
    seniorId: string
    incomeAmount: string
    payableAmount: string
    seniorSharePercent: number | null
  } | null
}

@Injectable()
export class TransactionsService {
  // Invoice triggers fire on best-effort and only log failures so a hiccup in
  // S3/PDF/notifications never reverts a successful financial transition.
  private readonly logger = new Logger(TransactionsService.name)

  constructor(
    private db: DatabaseService,
    @Inject(forwardRef(() => InvoicesService))
    private readonly invoicesService: InvoicesService,
  ) {}

  /**
   * Resolve the business-time of a transaction from a user-supplied input.
   *
   * Frontend sends `txDate` from `<input type="date">` (YYYY-MM-DD) which the
   * Date constructor parses to midnight UTC (00:00:00.000Z). This breaks
   * sort-by-date — all "today's" rows tie at 00:00 and order falls back to
   * unrelated keys (e.g. payouts with txDate=null land first because their
   * `createdAt` carries the real time-of-day).
   *
   * Rule:
   * - User picked nothing → `new Date()` (now, with full time-of-day).
   * - User picked a *past* day (different YYYY-MM-DD vs today UTC) → keep
   *   their pick as-is (midnight is correct for "this happened on day X").
   * - User picked *today* → merge today's calendar date with current
   *   time-of-day so the row sorts above same-day rows created earlier.
   *
   * This is fix-forward: legacy midnight rows are not migrated. The frontend
   * sort tie-breaker handles them by falling through to `createdAt`.
   */
  private resolveTxDate(rawTxDate: string | null | undefined): Date {
    const now = new Date()
    if (!rawTxDate) return now
    const picked = new Date(rawTxDate)
    if (Number.isNaN(picked.getTime())) return now
    // Compare UTC calendar dates (matches how the input is parsed).
    const sameDay =
      picked.getUTCFullYear() === now.getUTCFullYear() &&
      picked.getUTCMonth() === now.getUTCMonth() &&
      picked.getUTCDate() === now.getUTCDate()
    if (!sameDay) return picked
    // Same calendar day: keep picked date, fold in current time-of-day.
    return new Date(
      Date.UTC(
        picked.getUTCFullYear(),
        picked.getUTCMonth(),
        picked.getUTCDate(),
        now.getUTCHours(),
        now.getUTCMinutes(),
        now.getUTCSeconds(),
        now.getUTCMilliseconds(),
      ),
    )
  }

  /**
   * Fire-and-forget wrapper so a failing invoice generation (e.g. S3 outage)
   * does NOT roll back the underlying transaction state change. The PAID
   * status flip is the source of truth; the invoice is a derived artefact
   * that can always be re-generated (autoCreate is idempotent on
   * `invoice_document_id`).
   */
  private async safeAutoCreateInvoice(
    kind: 'SENIOR_INCOME' | 'SALARY',
    transactionId: string,
  ): Promise<void> {
    try {
      if (kind === 'SENIOR_INCOME') {
        await this.invoicesService.autoCreateForSeniorPayout(transactionId)
      } else {
        await this.invoicesService.autoCreateForSalary(transactionId)
      }
    } catch (err) {
      this.logger.warn(
        `auto-create invoice failed for ${kind} tx=${transactionId}: ${(err as Error).message}`,
      )
    }
  }

  private mapTx(tx: TxWithRelations) {
    return {
      id: tx.id,
      type: tx.type,
      status: tx.status,
      amount: tx.amount,
      currency: tx.currency,
      senderId: tx.senderId,
      senderLabel: tx.senderLabel,
      senderName: tx.sender?.displayName ?? null,
      receiverId: tx.receiverId,
      receiverLabel: tx.receiverLabel,
      receiverName: tx.receiver?.displayName ?? null,
      projectId: tx.projectId,
      projectName: tx.project?.name ?? null,
      payoutRequestId: tx.payoutRequestId,
      payoutRequest: tx.payoutRequest ?? null,
      seniorSharePercent: tx.seniorSharePercent,
      receiptDocumentId: tx.receiptDocumentId,
      receiptExternalUrl: tx.receiptExternalUrl,
      txHash: tx.txHash,
      validatedBy: tx.validatedBy,
      validatedAt: tx.validatedAt ? tx.validatedAt.toISOString() : null,
      rejectionReason: tx.rejectionReason,
      notes: tx.notes,
      salaryMonth: tx.salaryMonth,
      txDate: tx.txDate ? tx.txDate.toISOString() : null,
      // Drop role - phase 2. Optional explicit recipient — populated on
      // PAYOUT_DROP today; null on every legacy row. Exposing on the DTO so
      // the frontend list/detail views can distinguish drop payouts cleanly.
      recipientId: (tx as Transaction & { recipientId?: string | null }).recipientId ?? null,
      createdBy: tx.createdBy,
      createdAt: tx.createdAt.toISOString(),
      updatedAt: tx.updatedAt.toISOString(),
    }
  }

  // ── Distribution helpers (Drop role - phase 2) ───────────────────────────
  //
  // Pure helpers — no DB writes, no side-effects. The drop-project flow
  // branches on `project.dropId` and calls `computeDropDistribution`, while
  // the senior-project flow keeps calling `computePartnersSplit` directly.
  // Senior path math is byte-for-byte identical to pre-phase-2 behavior:
  // `computePartnersSplit(payable)` returns `[{ MAKSYM_ID, payable/2 }, …]`
  // which is what the legacy inline loop produced.

  /**
   * Split a payable amount 50/50 between the two hard-coded admin partners
   * (Maksym + Kostya). Used by:
   *   - senior-project `payPayoutRequest` (pre-phase-2 path, unchanged result)
   *   - `computeDropDistribution` for the residual after senior + drop cuts
   *
   * Returns an array (length=2) so callers can iterate without caring about
   * the admin identities — keeps the test surface small and future-proofs
   * for an N-partner split if the model ever changes.
   */
  computePartnersSplit(payableAmount: number): { adminId: string; amount: number }[] {
    const half = payableAmount / 2
    return [
      { adminId: MAKSYM_ID, amount: half },
      { adminId: KOSTYA_ID, amount: half },
    ]
  }

  /**
   * Distribute a drop-project's incoming amount across senior, drop, and the
   * two admin partners. Spec §8.1 example for income $1000, senior 26%,
   * drop 5%:
   *   senior: 260, drop: 50, partners: [345, 345].
   *
   * Inputs:
   *   - income — gross amount that landed on the DROP from the client.
   *   - project — drop-project row (must have `dropId !== null` — caller
   *     verifies before invoking). Reserved for future per-project overrides.
   *   - drop — DROP user row (read `dropSharePercent`, default 5).
   *   - senior — SENIOR user row (read `seniorSharePercent`, default 26).
   *
   * Errors:
   *   - Throws `BadRequestException` if senior + drop percents exceed 100.
   *     This is a deliberate guard — the spec keeps both shares additive
   *     against the gross, so >100% is a configuration bug, not a math one.
   *
   * Returns a pure JS object — no DB writes. The caller threads the result
   * into `db.transaction(...)` and inserts one transaction per share.
   */
  computeDropDistribution(
    income: number,
    _project: { id: string; dropId: string | null },
    drop: { id: string; dropSharePercent: number | null },
    senior: { id: string; seniorSharePercent: number | null },
  ): {
    seniorShare: { amount: number; percent: number }
    dropShare: { amount: number; percent: number }
    partnerShares: { adminId: string; amount: number }[]
  } {
    const seniorPercent = senior.seniorSharePercent ?? 26
    const dropPercent = drop.dropSharePercent ?? 5

    if (seniorPercent + dropPercent > 100) {
      throw new BadRequestException('Sum of senior+drop shares exceeds 100%')
    }

    const seniorAmount = (income * seniorPercent) / 100
    const dropAmount = (income * dropPercent) / 100
    const remainder = income - seniorAmount - dropAmount

    return {
      seniorShare: { amount: seniorAmount, percent: seniorPercent },
      dropShare: { amount: dropAmount, percent: dropPercent },
      partnerShares: this.computePartnersSplit(remainder),
    }
  }

  async findAll(
    currentUser: SessionUser,
    filters?: {
      type?: string
      status?: string
      projectId?: string
      seniorId?: string
      month?: string
    },
  ) {
    const allTxs = (await this.db.db.query.transactions.findMany({
      orderBy: [desc(transactions.createdAt)],
      with: {
        sender: { columns: { displayName: true } },
        receiver: { columns: { displayName: true } },
        project: { columns: { name: true } },
      },
    })) as TxWithRelations[]

    let result = allTxs

    // RBAC filtering
    if (currentUser.role === 'SENIOR') {
      // Drop role - phase 3: PAYOUT_CONFIRMED rows live on the admin side of
      // the ledger (manual confirmation step). SENIOR/DROP must not see them
      // for the same reason PAYOUT_ADMIN is filtered out — these rows expose
      // partner attribution that's none of their business.
      result = result.filter(
        (tx) =>
          (tx.senderId === currentUser.id || tx.receiverId === currentUser.id) &&
          tx.type !== 'PAYOUT_ADMIN' &&
          tx.type !== 'PAYOUT_CONFIRMED',
      )
    } else if (currentUser.role === 'JUNIOR') {
      result = result.filter((tx) => tx.receiverId === currentUser.id)
    } else if (currentUser.role === 'HR') {
      // HR sees salary transactions for their team members + their own
      result = result.filter(
        (tx) =>
          tx.type === 'SALARY' ||
          tx.receiverId === currentUser.id ||
          tx.senderId === currentUser.id,
      )
    } else if (currentUser.role === 'DROP') {
      // Drop role - phase 1 (AC1, security): DROP must only see transactions
      // where they are the sender or receiver — never other seniors' income,
      // payouts, expenses, or junior salaries. In Phase 1 the drop has no
      // dedicated transactions yet (distribution lands in Phase 2), so this
      // filter typically yields an empty list. Phase 2 will attach
      // transactions to dropId/seniorId and this same filter naturally
      // surfaces them. Same `PAYOUT_ADMIN` exclusion as SENIOR so dropping
      // a row from an admin payout never leaks the admin balance.
      result = result.filter(
        (tx) =>
          (tx.senderId === currentUser.id || tx.receiverId === currentUser.id) &&
          tx.type !== 'PAYOUT_ADMIN' &&
          tx.type !== 'PAYOUT_CONFIRMED',
      )
    }
    // ADMIN, ACCOUNTANT see all

    // Apply optional filters
    if (filters?.type) result = result.filter((tx) => tx.type === filters.type)
    if (filters?.status) result = result.filter((tx) => tx.status === filters.status)
    if (filters?.projectId) result = result.filter((tx) => tx.projectId === filters.projectId)
    if (filters?.seniorId) {
      result = result.filter(
        (tx) => tx.senderId === filters.seniorId || tx.receiverId === filters.seniorId,
      )
    }
    if (filters?.month) result = result.filter((tx) => tx.salaryMonth === filters.month)

    return result.map((tx) => this.mapTx(tx))
  }

  async findOne(id: string, currentUser: SessionUser) {
    const tx = (await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
      with: {
        sender: { columns: { displayName: true } },
        receiver: { columns: { displayName: true } },
        project: { columns: { name: true } },
        payoutRequest: {
          columns: { seniorId: true, incomeAmount: true, payableAmount: true },
        },
      },
    })) as TxWithRelations | undefined

    if (!tx) throw new NotFoundException('Transaction not found')
    this.assertReadAccess(tx, currentUser)

    // Enrich payoutRequest with seniorSharePercent snapshot from first linked income tx
    if (tx.payoutRequest && tx.payoutRequestId) {
      const firstIncome = await this.db.db.query.transactions.findFirst({
        where: and(
          eq(transactions.payoutRequestId, tx.payoutRequestId),
          eq(transactions.type, 'SENIOR_INCOME'),
        ),
      })
      if (firstIncome) {
        tx.payoutRequest = {
          ...tx.payoutRequest,
          seniorSharePercent: firstIncome.seniorSharePercent,
        }
      }
    }

    return this.mapTx(tx)
  }

  // ── Create ADMIN_INCOME ──────────────────────────────────────────────────

  async createAdminIncome(
    data: {
      projectId: string
      amount: number
      currency: string
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      notes?: string | null | undefined
      txDate?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, data.projectId),
    })
    if (!project) throw new NotFoundException('Project not found')
    if (project.seniorId !== currentUser.id) {
      throw new ForbiddenException('You can only add income for your own projects')
    }

    const [tx] = await this.db.db
      .insert(transactions)
      .values({
        type: 'ADMIN_INCOME',
        status: 'PAID',
        amount: String(data.amount),
        currency: data.currency as 'USDT' | 'USD' | 'EUR' | 'UAH',
        senderId: null,
        senderLabel: project.companyName,
        receiverId: currentUser.id,
        projectId: data.projectId,
        receiptDocumentId: data.receiptDocumentId ?? null,
        receiptExternalUrl: data.receiptExternalUrl ?? null,
        notes: data.notes ?? null,
        txDate: this.resolveTxDate(data.txDate),
        createdBy: currentUser.id,
      })
      .returning()

    return this.findOne(tx!.id, currentUser)
  }

  // ── Create SENIOR_INCOME ─────────────────────────────────────────────────

  async createSeniorIncome(
    data: {
      projectId: string
      amount: number
      currency: string
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      notes?: string | null | undefined
      txDate?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'SENIOR') throw new ForbiddenException()

    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, data.projectId),
      with: { financeSettings: true },
    })
    if (!project) throw new NotFoundException('Project not found')
    if (project.seniorId !== currentUser.id) {
      throw new ForbiddenException('You can only add income for your own projects')
    }

    const senior = await this.db.db.query.users.findFirst({
      where: eq(users.id, currentUser.id),
    })
    if (!senior) throw new NotFoundException('Senior not found')

    // Resolve share percent: project override → user default
    const settings = (
      project as typeof project & {
        financeSettings: typeof projectFinanceSettings.$inferSelect | null
      }
    ).financeSettings
    const sharePercent = settings?.seniorSharePercentOverride ?? senior.seniorSharePercent

    const [tx] = await this.db.db
      .insert(transactions)
      .values({
        type: 'SENIOR_INCOME',
        status: 'PENDING',
        amount: String(data.amount),
        currency: data.currency as 'USDT' | 'USD' | 'EUR' | 'UAH',
        senderId: null,
        senderLabel: project.companyName,
        receiverId: currentUser.id,
        projectId: data.projectId,
        seniorSharePercent: sharePercent,
        receiptDocumentId: data.receiptDocumentId ?? null,
        receiptExternalUrl: data.receiptExternalUrl ?? null,
        notes: data.notes ?? null,
        txDate: this.resolveTxDate(data.txDate),
        createdBy: currentUser.id,
      })
      .returning()

    return this.findOne(tx!.id, currentUser)
  }

  // ── Create DROP_INCOME (Drop role - phase 2) ─────────────────────────────
  //
  // Parallel to `createSeniorIncome` for DROP users on drop-projects. Keeps
  // the senior-income path unchanged. Validation cascade (validateTransaction
  // below) understands both types and routes DROP_INCOME through the
  // distribution branch.

  async createDropIncome(
    data: {
      projectId: string
      amount: number
      currency: string
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      notes?: string | null | undefined
      txDate?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'DROP') throw new ForbiddenException()

    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, data.projectId),
    })
    if (!project) throw new NotFoundException('Project not found')
    // The drop can only declare income on a drop-project routed through them.
    if (project.dropId !== currentUser.id) {
      throw new ForbiddenException('Это не drop-проект под вами')
    }

    const [tx] = await this.db.db
      .insert(transactions)
      .values({
        type: 'DROP_INCOME',
        status: 'PENDING',
        amount: String(data.amount),
        currency: data.currency as 'USDT' | 'USD' | 'EUR' | 'UAH',
        senderId: null,
        senderLabel: project.companyName,
        receiverId: currentUser.id,
        recipientId: currentUser.id,
        projectId: data.projectId,
        receiptDocumentId: data.receiptDocumentId ?? null,
        receiptExternalUrl: data.receiptExternalUrl ?? null,
        notes: data.notes ?? null,
        txDate: this.resolveTxDate(data.txDate),
        createdBy: currentUser.id,
      })
      .returning()

    return this.findOne(tx!.id, currentUser)
  }

  // ── Update REJECTED SENIOR_INCOME ────────────────────────────────────────

  async updateSeniorIncome(
    id: string,
    data: {
      amount?: number | undefined
      currency?: string | undefined
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      notes?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
    })
    if (!tx) throw new NotFoundException('Transaction not found')
    if (tx.type !== 'SENIOR_INCOME')
      throw new BadRequestException('Can only edit SENIOR_INCOME transactions')
    if (tx.status !== 'REJECTED')
      throw new BadRequestException('Can only edit REJECTED transactions')
    if (tx.receiverId !== currentUser.id) throw new ForbiddenException()

    // Resolve XOR: if exactly one is provided as defined, the other becomes
    // null to satisfy the DB CHECK. If both are undefined, leave row unchanged.
    const receiptDocChanged = data.receiptDocumentId !== undefined
    const receiptUrlChanged = data.receiptExternalUrl !== undefined
    const nextDocId = receiptDocChanged
      ? (data.receiptDocumentId ?? null)
      : receiptUrlChanged && data.receiptExternalUrl
        ? null
        : tx.receiptDocumentId
    const nextExtUrl = receiptUrlChanged
      ? (data.receiptExternalUrl ?? null)
      : receiptDocChanged && data.receiptDocumentId
        ? null
        : tx.receiptExternalUrl

    await this.db.db
      .update(transactions)
      .set({
        amount: data.amount !== undefined ? String(data.amount) : tx.amount,
        currency: (data.currency as 'USDT' | 'USD' | 'EUR' | 'UAH' | undefined) ?? tx.currency,
        receiptDocumentId: nextDocId,
        receiptExternalUrl: nextExtUrl,
        notes: data.notes !== undefined ? data.notes : tx.notes,
        status: 'PENDING',
        rejectionReason: null,
        validatedBy: null,
        validatedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, id))

    return this.findOne(id, currentUser)
  }

  // ── Admin Edit (any type except PAYOUT/PAYOUT_ADMIN) ─────────────────────

  async adminUpdateTransaction(
    id: string,
    data: {
      amount?: number | undefined
      currency?: string | undefined
      notes?: string | null | undefined
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      category?: string | undefined
      salaryMonth?: string | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
    })
    if (!tx) throw new NotFoundException('Transaction not found')
    // Drop role - phase 3: PAYOUT_CONFIRMED rows are the audit trail of a
    // manual confirmation — editing them in-place would corrupt the link to
    // the originating PAYOUT. Group the prohibition with the existing PAYOUT
    // family so the contract is consistent.
    if (tx.type === 'PAYOUT' || tx.type === 'PAYOUT_ADMIN' || tx.type === 'PAYOUT_CONFIRMED') {
      throw new BadRequestException('Cannot edit PAYOUT transactions')
    }
    if (tx.payoutRequestId) {
      throw new BadRequestException('Cannot edit a transaction linked to a payout request')
    }

    // Resolve XOR before write (same logic as updateSeniorIncome). Either
    // field provided as defined wipes the other to satisfy the CHECK.
    const receiptDocChanged = data.receiptDocumentId !== undefined
    const receiptUrlChanged = data.receiptExternalUrl !== undefined
    const receiptPatch: { receiptDocumentId?: string | null; receiptExternalUrl?: string | null } =
      {}
    if (receiptDocChanged || receiptUrlChanged) {
      receiptPatch.receiptDocumentId = receiptDocChanged
        ? (data.receiptDocumentId ?? null)
        : receiptUrlChanged && data.receiptExternalUrl
          ? null
          : tx.receiptDocumentId
      receiptPatch.receiptExternalUrl = receiptUrlChanged
        ? (data.receiptExternalUrl ?? null)
        : receiptDocChanged && data.receiptDocumentId
          ? null
          : tx.receiptExternalUrl
    }

    await this.db.db
      .update(transactions)
      .set({
        ...(data.amount !== undefined && { amount: String(data.amount) }),
        ...(data.currency !== undefined && {
          currency: data.currency as 'USDT' | 'USD' | 'EUR' | 'UAH',
        }),
        ...(data.notes !== undefined && { notes: data.notes }),
        ...receiptPatch,
        ...(data.category !== undefined && { receiverLabel: data.category }),
        ...(data.salaryMonth !== undefined && { salaryMonth: data.salaryMonth }),
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, id))

    return this.findOne(id, currentUser)
  }

  // ── Admin Delete ──────────────────────────────────────────────────────────

  async adminDeleteTransaction(id: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
    })
    if (!tx) throw new NotFoundException('Transaction not found')
    // Drop role - phase 3: PAYOUT_CONFIRMED is also non-deletable for the same
    // audit-trail reason as PAYOUT/PAYOUT_ADMIN.
    if (tx.type === 'PAYOUT' || tx.type === 'PAYOUT_ADMIN' || tx.type === 'PAYOUT_CONFIRMED') {
      throw new BadRequestException('Cannot delete PAYOUT transactions')
    }
    if (tx.payoutRequestId) {
      throw new BadRequestException('Cannot delete a transaction linked to a payout request')
    }

    await this.db.db.delete(transactions).where(eq(transactions.id, id))
    return { deleted: true }
  }

  // ── Validate / Reject SENIOR_INCOME ──────────────────────────────────────

  async validateTransaction(
    id: string,
    action: 'validate' | 'reject',
    rejectionReason: string | null | undefined,
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException()
    }

    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
    })
    if (!tx) throw new NotFoundException('Transaction not found')
    // Drop role - phase 2: validate also handles DROP_INCOME with the same
    // shape — flip to VALIDATED + create payout_request + insert placeholder
    // PAYOUT row. The drop-specific distribution math lives in
    // `payPayoutRequest` (drop branch) — at validate time we only book a
    // payable that represents what the wallet owner will transfer off-platform
    // (= income * (1 - share/100), using dropSharePercent for DROP_INCOME).
    if (tx.type !== 'SENIOR_INCOME' && tx.type !== 'DROP_INCOME') {
      throw new BadRequestException('Only SENIOR_INCOME or DROP_INCOME can be validated')
    }
    // AC4: idempotency. The action is only valid on PENDING rows — a second
    // click after a successful validate would otherwise create a duplicate
    // PAYOUT row. We throw rather than silently no-op so the UI can show
    // a clear error to the ACCOUNTANT (vs. pretending it worked twice).
    if (tx.status !== 'PENDING')
      throw new BadRequestException('Transaction is not in PENDING status')

    if (action === 'validate') {
      // PR #56 final UT fix (AC2): validate atomically flips SENIOR_INCOME to
      // **VALIDATED** (terminal state for the income) and creates the 1-to-1
      // «Выплата» row in PENDING_PAYMENT. Rationale per user: «давай статус
      // будет "Подтверждено" типу как финальный статус для прихода синьера,
      // а дальше уже идет флоу Выплаты». SENIOR_INCOME no longer carries the
      // «Оплатить» button — only the PAYOUT row does. SENIOR_INCOME flips to
      // PAID later in payPayoutRequest once the on-chain payment lands.
      //
      // db.transaction() guarantees both the UPDATE and the INSERT happen
      // together — if the PAYOUT insert fails, the SENIOR_INCOME stays
      // PENDING and the ACCOUNTANT can retry.
      if (!tx.receiverId) {
        throw new BadRequestException(`${tx.type} has no receiverId — cannot create payout`)
      }
      const walletOwner = await this.db.db.query.users.findFirst({
        where: eq(users.id, tx.receiverId),
      })
      if (!walletOwner) throw new NotFoundException('Receiver not found')

      // Resolve the share kept by the wallet owner:
      //   SENIOR_INCOME → tx.seniorSharePercent ?? users.seniorSharePercent ?? 26
      //   DROP_INCOME   → users.dropSharePercent ?? 5
      // Pays `100 - share`% off-platform (placeholder PAYOUT amount).
      const sharePercent =
        tx.type === 'DROP_INCOME'
          ? (walletOwner.dropSharePercent ?? 5)
          : (tx.seniorSharePercent ?? walletOwner.seniorSharePercent ?? 26)
      const incomeAmount = parseFloat(tx.amount)
      const payableAmount = incomeAmount * (1 - sharePercent / 100)

      // Stub Ethereum-shape contract address (0x + 40 hex). Each PAYOUT gets
      // a fresh one — when PHASE 8 ships these will be replaced by the real
      // PaymentSplitter contract address. See createPayoutRequest for the
      // batch counterpart that does the same thing.
      const contractAddress = '0x' + randomBytes(20).toString('hex')

      const now = new Date()

      await this.db.db.transaction(async (dbtx) => {
        // 1) Create the payout_request row first (FK target for both tx
        //    updates below).
        const [req] = await dbtx
          .insert(payoutRequests)
          .values({
            seniorId: tx.receiverId!,
            incomeAmount: String(incomeAmount),
            payableAmount: String(payableAmount),
            contractAddress,
            status: 'PENDING',
          })
          .returning()

        // 2) Flip SENIOR_INCOME status to VALIDATED (terminal for income —
        //    «Подтверждено» badge) + link it to the payout_request so the UI
        //    can group them. The «Оплатить» button moves to the PAYOUT row
        //    inserted below.
        await dbtx
          .update(transactions)
          .set({
            status: 'VALIDATED',
            payoutRequestId: req!.id,
            validatedBy: currentUser.id,
            validatedAt: now,
            updatedAt: now,
          })
          .where(eq(transactions.id, id))

        // 3) Insert the placeholder «Выплата» row (PAYOUT, PENDING_PAYMENT).
        //    senderId = the senior (who pays out); receiverLabel = company.
        //    1-to-1 with the SENIOR_INCOME row (task explicitly out-of-scope:
        //    batch payouts where N incomes → 1 payout).
        await dbtx.insert(transactions).values({
          type: 'PAYOUT',
          status: 'PENDING_PAYMENT',
          amount: String(payableAmount),
          currency: tx.currency,
          senderId: tx.receiverId!,
          receiverLabel: 'CheekyCheeseIT',
          projectId: tx.projectId,
          payoutRequestId: req!.id,
          createdBy: currentUser.id,
        })
      })

      // Unlock junior salary for this project's current month if locked.
      // Outside the transaction is fine — it's a best-effort secondary
      // effect; if it fails the validate still succeeded.
      await this.unlockJuniorSalaryForProject(tx.projectId, tx)
    } else {
      if (!rejectionReason) throw new BadRequestException('Rejection reason is required')
      await this.db.db
        .update(transactions)
        .set({
          status: 'REJECTED',
          validatedBy: currentUser.id,
          validatedAt: new Date(),
          rejectionReason,
          updatedAt: new Date(),
        })
        .where(eq(transactions.id, id))
    }

    return this.findOne(id, currentUser)
  }

  // ── Manual payout confirmation (Drop role - phase 3, spec §8.4) ──────────
  //
  // ACCOUNTANT/ADMIN confirms a previously created PAYOUT actually landed on a
  // specific admin partner (Maksym/Kostya) off-platform. This is a **safety
  // net** on top of the auto 50/50 PAYOUT_ADMIN split that `payPayoutRequest`
  // emits — both flows live in parallel; phase 2 distribution math is NOT
  // touched here.
  //
  // Effects (single DB transaction):
  //   1) The PAYOUT row flips PENDING_PAYMENT → PAID. `validatedBy` +
  //      `validatedAt` are set on the PAYOUT row so the audit trail mirrors
  //      SENIOR_INCOME validation semantics.
  //   2) A fresh PAYOUT_CONFIRMED row is inserted in PAID:
  //      - `receiverId` + `recipientId` = chosen ADMIN (recipientId mirrors
  //        the phase-2 PAYOUT_DROP pattern for explicit "money landed here"
  //        attribution).
  //      - `amount` / `currency` / `projectId` mirror the PAYOUT row.
  //      - `senderId` = `PAYOUT.senderId` so the chain "senior/drop pays →
  //        admin receives" stays traceable.
  //      - `payoutRequestId` is copied so reporting can group the auto-split
  //        rows with this manual confirmation under one umbrella.
  //      - `notes` records who confirmed + when, for the audit trail.
  //
  // Validation:
  //   - RBAC: ADMIN + ACCOUNTANT only. Anyone else → 403.
  //   - PAYOUT row must exist, type = PAYOUT, status = PENDING_PAYMENT.
  //   - `recipientAdminId` must exist, role = ADMIN, NOT archived.
  //
  // Idempotency:
  //   - A second click on an already-PAID PAYOUT throws 400 («Already
  //     confirmed»). This is enforced by the status check on the PAYOUT row —
  //     once it's PAID the predicate fails before any insert runs, so we can
  //     never double-credit an admin.
  async confirmPayout(
    payoutTxId: string,
    recipientAdminId: string,
    currentUser: SessionUser,
    options: { method?: 'CRYPTO' | 'CASH'; txHash?: string | null } = {},
  ) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException()
    }

    // Drop role - phase 4 refactor (task-drop-phase4-refactor-remove-tov.md
    // AC4). PAYOUT_CONFIRMED rows now carry an explicit payment method:
    // CRYPTO (default — txHash required) or CASH (no on-chain hash). Cash
    // path covers manual confirmations where the senior settled with the
    // partner via fiat / hand-off; crypto path keeps the legacy contract.
    const method = options.method ?? 'CRYPTO'
    const txHashRaw = options.txHash?.trim() ?? ''
    if (method === 'CRYPTO' && txHashRaw.length < 10) {
      throw new BadRequestException('Для crypto-метода требуется txHash минимум 10 символов')
    }
    const recordedTxHash = method === 'CRYPTO' ? txHashRaw : null

    const payoutTx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, payoutTxId),
    })
    if (!payoutTx) throw new NotFoundException('Transaction not found')
    if (payoutTx.type !== 'PAYOUT') {
      throw new BadRequestException('Only PAYOUT transactions can be confirmed')
    }
    // Idempotency guard. Once PAYOUT has flipped to PAID a second confirm
    // would either no-op or duplicate the PAYOUT_CONFIRMED row depending on
    // which side races; throw early so the UI can show «уже подтверждено».
    if (payoutTx.status !== 'PENDING_PAYMENT') {
      throw new BadRequestException('Payout is not pending payment (already confirmed?)')
    }

    const recipient = await this.db.db.query.users.findFirst({
      where: eq(users.id, recipientAdminId),
    })
    if (!recipient) throw new BadRequestException('Recipient admin not found')
    if (recipient.role !== 'ADMIN') {
      throw new BadRequestException('Recipient must be an ADMIN')
    }
    if (recipient.archivedAt) {
      throw new BadRequestException('Recipient admin is archived')
    }

    const now = new Date()
    const confirmationNote = `Manual payout confirmation by ${currentUser.id} at ${now.toISOString()} (method=${method})`

    await this.db.db.transaction(async (dbtx) => {
      // 1) Flip PAYOUT to PAID + record who/when confirmed. For CRYPTO method
      //    also stamp the txHash on the PAYOUT row so the senior-side audit
      //    matches the new credit row.
      await dbtx
        .update(transactions)
        .set({
          status: 'PAID',
          validatedBy: currentUser.id,
          validatedAt: now,
          updatedAt: now,
          ...(method === 'CRYPTO' && recordedTxHash ? { txHash: recordedTxHash } : {}),
        })
        .where(eq(transactions.id, payoutTxId))

      // 2) Insert the PAYOUT_CONFIRMED row crediting the chosen admin. The
      //    inputs (amount/currency/projectId/payoutRequestId) snapshot the
      //    PAYOUT row so a later edit to PAYOUT (out of scope here — PAYOUT
      //    is non-editable per `adminUpdateTransaction`) wouldn't desync the
      //    credit row. senderId mirrors PAYOUT.senderId for traceability.
      //    The payment method is captured via senderLabel marker so existing
      //    schema columns are reused (no schema change needed). Cash method
      //    keeps txHash null per AC4; crypto records the on-chain hash.
      await dbtx.insert(transactions).values({
        type: 'PAYOUT_CONFIRMED',
        status: 'PAID',
        amount: payoutTx.amount,
        currency: payoutTx.currency,
        senderId: payoutTx.senderId,
        senderLabel: `PAYOUT_METHOD:${method}`,
        receiverId: recipient.id,
        recipientId: recipient.id,
        projectId: payoutTx.projectId,
        payoutRequestId: payoutTx.payoutRequestId,
        txHash: recordedTxHash,
        notes: confirmationNote,
        createdBy: currentUser.id,
      })
    })

    // Return both rows so the UI can update the table in a single round-trip:
    // the now-PAID PAYOUT and the freshly created credit row.
    const updatedPayout = await this.findOne(payoutTxId, currentUser)
    const confirmedRow = await this.db.db.query.transactions.findFirst({
      where: and(
        eq(transactions.type, 'PAYOUT_CONFIRMED'),
        eq(transactions.payoutRequestId, payoutTx.payoutRequestId ?? ''),
        eq(transactions.receiverId, recipient.id),
        eq(transactions.notes, confirmationNote),
      ),
      orderBy: [desc(transactions.createdAt)],
    })
    const confirmed = confirmedRow ? await this.findOne(confirmedRow.id, currentUser) : null

    return { payout: updatedPayout, confirmed }
  }

  // ── Create EXPENSE ───────────────────────────────────────────────────────

  async createExpense(
    data: {
      amount: number
      currency: string
      category: string
      notes?: string | null
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
      txDate?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const [tx] = await this.db.db
      .insert(transactions)
      .values({
        type: 'EXPENSE',
        status: 'PAID',
        amount: String(data.amount),
        currency: data.currency as 'USDT' | 'USD' | 'EUR' | 'UAH',
        senderId: currentUser.id,
        receiverLabel: data.category,
        notes: data.notes ?? null,
        receiptDocumentId: data.receiptDocumentId ?? null,
        receiptExternalUrl: data.receiptExternalUrl ?? null,
        txDate: this.resolveTxDate(data.txDate),
        createdBy: currentUser.id,
      })
      .returning()

    return this.findOne(tx!.id, currentUser)
  }

  // ── Create SALARY ─────────────────────────────────────────────────────────

  async createSalary(
    data: {
      receiverId: string
      amount: number
      currency?: string
      salaryMonth: string
      notes?: string | null | undefined
      txDate?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const receiver = await this.db.db.query.users.findFirst({
      where: eq(users.id, data.receiverId),
    })
    if (!receiver) throw new NotFoundException('User not found')
    if (!['JUNIOR', 'HR', 'ACCOUNTANT'].includes(receiver.role)) {
      throw new BadRequestException('Salary can only be created for JUNIOR, HR, or ACCOUNTANT')
    }

    const [tx] = await this.db.db
      .insert(transactions)
      .values({
        type: 'SALARY',
        status: 'PAID',
        amount: String(data.amount),
        currency: (data.currency ?? 'USD') as 'USDT' | 'USD' | 'EUR' | 'UAH',
        senderId: currentUser.id,
        senderLabel: 'CheekyCheeseIT',
        receiverId: data.receiverId,
        salaryMonth: data.salaryMonth,
        notes: data.notes ?? null,
        txDate: this.resolveTxDate(data.txDate),
        createdBy: currentUser.id,
      })
      .returning()

    // Trigger 2: invoice auto-create — SALARY rows from this path land
    // straight in PAID, so the invoice should be generated immediately.
    await this.safeAutoCreateInvoice('SALARY', tx!.id)

    return this.findOne(tx!.id, currentUser)
  }

  // ── Create ADMIN_TRANSFER ─────────────────────────────────────────────────

  async createAdminTransfer(
    data: {
      senderId?: string | undefined
      receiverId: string
      amount: number
      currency?: string | undefined
      notes?: string | null | undefined
      txDate?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const effectiveSenderId = data.senderId ?? currentUser.id

    if (data.senderId && data.senderId !== currentUser.id) {
      const sender = await this.db.db.query.users.findFirst({ where: eq(users.id, data.senderId) })
      if (!sender || sender.role !== 'ADMIN')
        throw new BadRequestException('Sender must be an ADMIN')
    }

    const receiver = await this.db.db.query.users.findFirst({
      where: eq(users.id, data.receiverId),
    })
    if (!receiver) throw new NotFoundException('User not found')
    if (receiver.role !== 'ADMIN')
      throw new BadRequestException('Can only transfer to another ADMIN')
    if (receiver.id === effectiveSenderId)
      throw new BadRequestException('Cannot transfer to yourself')

    const [tx] = await this.db.db
      .insert(transactions)
      .values({
        type: 'ADMIN_TRANSFER',
        status: 'PAID',
        amount: String(data.amount),
        currency: (data.currency ?? 'USDT') as 'USDT' | 'USD' | 'EUR' | 'UAH',
        senderId: effectiveSenderId,
        receiverId: data.receiverId,
        notes: data.notes ?? null,
        txDate: this.resolveTxDate(data.txDate),
        createdBy: currentUser.id,
      })
      .returning()

    return this.findOne(tx!.id, currentUser)
  }

  // ── Create Payout Request ─────────────────────────────────────────────────

  async createPayoutRequest(transactionIds: string[], currentUser: SessionUser) {
    if (currentUser.role !== 'SENIOR') throw new ForbiddenException()

    // Fetch and validate all selected transactions
    const txs = await this.db.db.query.transactions.findMany({
      where: and(
        inArray(transactions.id, transactionIds),
        eq(transactions.type, 'SENIOR_INCOME'),
        eq(transactions.status, 'VALIDATED'),
        eq(transactions.receiverId, currentUser.id),
      ),
    })

    if (txs.length !== transactionIds.length) {
      throw new BadRequestException(
        'Some transactions are not valid VALIDATED SENIOR_INCOME for this senior',
      )
    }

    const incomeAmount = txs.reduce((sum, tx) => sum + parseFloat(tx.amount), 0)
    const sharePercent = txs[0]!.seniorSharePercent ?? 26
    // payable = income * (1 - seniorKeepsPercent/100)
    // senior keeps sharePercent, pays (100-sharePercent)%
    const payableAmount = incomeAmount * (1 - sharePercent / 100)

    // Stub contract address — Ethereum-shape (0x + 40 hex). Per-payout fresh
    // address, swapped for the real PaymentSplitter when PHASE 8 ships. See
    // migration 0019 for the column rationale.
    const contractAddress = '0x' + randomBytes(20).toString('hex')

    const [req] = await this.db.db
      .insert(payoutRequests)
      .values({
        seniorId: currentUser.id,
        incomeAmount: String(incomeAmount),
        payableAmount: String(payableAmount),
        contractAddress,
        status: 'PENDING',
      })
      .returning()

    // Link transactions to this payout request and set status to PENDING_PAYMENT
    await this.db.db
      .update(transactions)
      .set({ payoutRequestId: req!.id, status: 'PENDING_PAYMENT', updatedAt: new Date() })
      .where(inArray(transactions.id, transactionIds))

    // Create the placeholder «Выплата» transaction (PAYOUT, PENDING_PAYMENT).
    // It's visible in the transactions table immediately so the SENIOR has a
    // single row to click «Оплатить» on — the linked SENIOR_INCOME rows just
    // flip status, they no longer carry the inline pay button. The same row
    // is mutated to PAID in payPayoutRequest (txHash + status) — we don't
    // INSERT a fresh PAYOUT there anymore.
    await this.db.db.insert(transactions).values({
      type: 'PAYOUT',
      status: 'PENDING_PAYMENT',
      amount: String(payableAmount),
      currency: 'USDT',
      senderId: currentUser.id,
      receiverLabel: 'CheekyCheeseIT',
      payoutRequestId: req!.id,
      createdBy: currentUser.id,
    })

    return this.findPayoutRequest(req!.id, currentUser)
  }

  // ── Pay Payout Request ────────────────────────────────────────────────────

  async payPayoutRequest(
    requestId: string,
    txHash: string | undefined,
    currentUser: SessionUser,
    simulateResult?: 'success' | 'error',
  ) {
    // Drop role - phase 2: DROP users own drop-project payouts. The legacy
    // SENIOR check is kept for senior-projects; either role can call this
    // endpoint and the `req.seniorId === currentUser.id` line below enforces
    // ownership in both cases. payout_requests.seniorId is a FK to users.id
    // (not constrained by role) — for drop flows it points at the DROP user.
    if (currentUser.role !== 'SENIOR' && currentUser.role !== 'DROP') {
      throw new ForbiddenException()
    }

    const req = await this.db.db.query.payoutRequests.findFirst({
      where: eq(payoutRequests.id, requestId),
    })
    if (!req) throw new NotFoundException('Payout request not found')
    if (req.seniorId !== currentUser.id) throw new ForbiddenException()
    if (req.status !== 'PENDING') throw new BadRequestException('Payout request is already paid')

    // DEV-only simulate toggle (see PayPayoutRequestDto.simulateResult).
    // The dev/staging UI surfaces a radio group that lets the SENIOR rehearse
    // either branch of the etherscan stub without going on-chain. In
    // production the flag is ignored — real verification logic owns the
    // decision.
    const isDevMode = process.env['NODE_ENV'] !== 'production'
    const isSimulating = isDevMode && simulateResult !== undefined
    if (isSimulating && simulateResult === 'error') {
      throw new BadRequestException('Симуляция: транзакция не подтверждена')
    }
    // simulateResult === 'success' falls through to the normal cascade below
    // (which already short-circuits etherscan today — see EtherscanService
    // header comment about the missing real-verification call site).
    //
    // When the SENIOR submits without a real on-chain hash (simulate mode),
    // we synthesize a deterministic stub hash so the audit trail (txHash
    // column on payout_requests + linked transactions) is never empty. The
    // 0xSIM prefix is the convention the UI uses to skip the etherscan link
    // (see PayoutDetailDialog footer).
    const effectiveTxHash =
      txHash && txHash.trim().length >= 10
        ? txHash.trim()
        : isSimulating
          ? `0xSIM${randomBytes(28).toString('hex')}`
          : (() => {
              throw new BadRequestException('Хеш транзакции обязателен')
            })()

    // Mark payout request as paid
    await this.db.db
      .update(payoutRequests)
      .set({
        txHash: effectiveTxHash,
        status: 'PAID',
        updatedAt: new Date(),
      })
      .where(eq(payoutRequests.id, requestId))

    // Mark linked SENIOR_INCOME transactions as PAID
    await this.db.db
      .update(transactions)
      .set({
        status: 'PAID',
        updatedAt: new Date(),
      })
      .where(eq(transactions.payoutRequestId, requestId))

    // Trigger 1: invoice auto-create for each linked income just paid.
    // Best-effort — see safeAutoCreateInvoice for the no-rollback contract.
    // We re-fetch (the UPDATE above doesn't return rows in drizzle's current
    // Postgres flavour without `.returning()` chaining); the result feeds
    // both invoice generation and the drop-vs-senior project routing below.
    // Drop role - phase 2: DROP_INCOME is included here so drop-projects also
    // get an invoice generated for the income side.
    const paidIncomeTxs = await this.db.db
      .select({ id: transactions.id, projectId: transactions.projectId, type: transactions.type })
      .from(transactions)
      .where(
        and(
          eq(transactions.payoutRequestId, requestId),
          or(eq(transactions.type, 'SENIOR_INCOME'), eq(transactions.type, 'DROP_INCOME')),
        ),
      )
    for (const incomeTx of paidIncomeTxs) {
      // SENIOR_INCOME invoice generation path is the only one that exists
      // today; DROP_INCOME re-uses the same artefact (recipient = wallet
      // owner). Keeping the kind argument as SENIOR_INCOME until a
      // dedicated drop invoice template lands.
      await this.safeAutoCreateInvoice('SENIOR_INCOME', incomeTx.id)
    }

    // Mark the placeholder PAYOUT row (created at createPayoutRequest time)
    // as PAID + attach the on-chain txHash. We don't INSERT a fresh PAYOUT
    // here — the row already exists with status PENDING_PAYMENT so the
    // SENIOR could see «Выплата» in the table before clicking «Оплатить».
    await this.db.db
      .update(transactions)
      .set({
        status: 'PAID',
        txHash: effectiveTxHash,
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.payoutRequestId, requestId), eq(transactions.type, 'PAYOUT')))

    // Drop role - phase 2 (AC3). Resolve whether the linked SENIOR_INCOMEs
    // belong to a drop-project. Senior-projects (project.dropId === null)
    // keep the legacy 50/50 split untouched — this is the regression-safe
    // path. Drop-projects route the partner residual through
    // `computeDropDistribution` and additionally insert PAYOUT_DROP.
    //
    // The payout_request groups SENIOR_INCOMEs by senior; in the current
    // model all of them target the same senior, but they may span multiple
    // projects. We treat the FIRST linked SENIOR_INCOME's project as the
    // "primary" project for drop-vs-senior routing. The standing UX is "a
    // payout = one project" — see PayoutDetailDialog header — so this
    // assumption matches what the SENIOR sees.
    const primaryProjectId = paidIncomeTxs[0]?.projectId ?? null
    const primaryProject = primaryProjectId
      ? await this.db.db.query.projects.findFirst({
          where: eq(projects.id, primaryProjectId),
        })
      : null

    const dropUser = primaryProject?.dropId
      ? await this.db.db.query.users.findFirst({
          where: eq(users.id, primaryProject.dropId),
        })
      : null

    const payable = parseFloat(req.payableAmount)

    if (dropUser && primaryProject) {
      // Drop-project branch.
      //
      // Distribution is computed on the GROSS income, not on `payable`.
      // `payable` is `income * (1 - dropShare/100)` here (validateTransaction
      // recorded this when flipping DROP_INCOME→VALIDATED on a drop-project),
      // and represents what the drop transfers off-platform — the residual
      // for partners after the drop keeps their slice. In the senior-project
      // path the same `payable` field means something different (income *
      // (1 - seniorShare/100)) — context is the project, not the column.
      //
      // The SENIOR share is computed on GROSS, not on payable, so we read
      // the senior from the project (not from `req.seniorId` — that field
      // points at the wallet owner, which is the DROP in this flow).
      const senior = primaryProject.seniorId
        ? await this.db.db.query.users.findFirst({
            where: eq(users.id, primaryProject.seniorId),
          })
        : null
      if (!senior) throw new NotFoundException('Senior not found on drop-project')

      const income = parseFloat(req.incomeAmount)
      const distribution = this.computeDropDistribution(
        income,
        { id: primaryProject.id, dropId: primaryProject.dropId },
        { id: dropUser.id, dropSharePercent: dropUser.dropSharePercent },
        { id: senior.id, seniorSharePercent: senior.seniorSharePercent },
      )

      // Drop's slice — visible on the DROP user's balance.
      // senderId = senior (who initiated the off-platform settlement);
      // receiverId + recipientId both = drop (explicit semantics — see
      // schema comment on recipient_id).
      await this.db.db.insert(transactions).values({
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: String(distribution.dropShare.amount),
        currency: 'USDT',
        senderId: currentUser.id,
        receiverId: dropUser.id,
        recipientId: dropUser.id,
        projectId: primaryProject.id,
        payoutRequestId: requestId,
        txHash: effectiveTxHash,
        createdBy: currentUser.id,
      })

      // Partner residual (50/50 split) on the drop-project's remainder.
      for (const share of distribution.partnerShares) {
        const admin = await this.db.db.query.users.findFirst({
          where: eq(users.id, share.adminId),
        })
        if (admin) {
          await this.db.db.insert(transactions).values({
            type: 'PAYOUT_ADMIN',
            status: 'PAID',
            amount: String(share.amount),
            currency: 'USDT',
            senderId: currentUser.id,
            receiverId: share.adminId,
            projectId: primaryProject.id,
            payoutRequestId: requestId,
            txHash: effectiveTxHash,
            createdBy: currentUser.id,
          })
        }
      }
    } else {
      // Senior-project branch (legacy split math). `computePartnersSplit(payable)`
      // returns `[{maksym, payable/2}, {kostya, payable/2}]` — unchanged from
      // pre-AC1. Backlog AC5: include `projectId` on each PAYOUT_ADMIN insert
      // so the row is traceable back to the originating project (matches the
      // drop-branch shape above). `primaryProject` is null only when the
      // payout has no linked SENIOR_INCOME rows — a degenerate case that
      // can't actually happen here (the cascade short-circuits earlier on
      // empty payouts) but we keep the fallback to `null` for safety.
      const partnerShares = this.computePartnersSplit(payable)
      const senderProjectId = primaryProject?.id ?? null

      for (const share of partnerShares) {
        const admin = await this.db.db.query.users.findFirst({
          where: eq(users.id, share.adminId),
        })
        if (admin) {
          await this.db.db.insert(transactions).values({
            type: 'PAYOUT_ADMIN',
            status: 'PAID',
            amount: String(share.amount),
            currency: 'USDT',
            senderId: currentUser.id,
            receiverId: share.adminId,
            projectId: senderProjectId,
            payoutRequestId: requestId,
            txHash: effectiveTxHash,
            createdBy: currentUser.id,
          })
        }
      }
    }

    return this.findPayoutRequest(requestId, currentUser)
  }

  // ── Payout Requests ───────────────────────────────────────────────────────

  async findPayoutRequests(currentUser: SessionUser) {
    const all = await this.db.db.query.payoutRequests.findMany({
      orderBy: [desc(payoutRequests.createdAt)],
      with: {
        senior: { columns: { displayName: true } },
      },
    })

    const filtered =
      currentUser.role === 'SENIOR'
        ? all.filter((r) => r.seniorId === currentUser.id)
        : currentUser.role === 'DROP'
          ? // Drop role - phase 2 (backlog AC4): DROP sees only their OWN
            // payout requests. In drop-project flows `payoutRequests.seniorId`
            // points at the DROP user (the column is reused as "owner of the
            // payout" — see `payPayoutRequest` header comment around the
            // `req.seniorId === currentUser.id` check). Same filter shape as
            // SENIOR.
            all.filter((r) => r.seniorId === currentUser.id)
          : currentUser.role === 'JUNIOR' || currentUser.role === 'HR'
            ? // Same idea — these roles never owned payout requests.
              []
            : all

    return filtered.map((r) => ({
      id: r.id,
      seniorId: r.seniorId,
      seniorName:
        (r as typeof r & { senior: { displayName: string } | null }).senior?.displayName ?? '',
      incomeAmount: r.incomeAmount,
      payableAmount: r.payableAmount,
      contractAddress: r.contractAddress,
      txHash: r.txHash,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }))
  }

  async findPayoutRequest(id: string, currentUser: SessionUser) {
    const req = await this.db.db.query.payoutRequests.findFirst({
      where: eq(payoutRequests.id, id),
      with: {
        senior: { columns: { displayName: true } },
        transactions: {
          with: {
            sender: { columns: { displayName: true } },
            receiver: { columns: { displayName: true } },
            project: { columns: { name: true } },
          },
        },
      },
    })
    if (!req) throw new NotFoundException('Payout request not found')
    if (currentUser.role === 'SENIOR' && req.seniorId !== currentUser.id)
      throw new ForbiddenException()
    // Drop role - phase 2 (backlog AC4): DROP CAN inspect their own payout
    // requests. In drop-project flows `payout_requests.seniorId` actually
    // points at the DROP user (the column is reused as "owner of the
    // payout"; see `payPayoutRequest` header comment around the
    // `req.seniorId === currentUser.id` check). The phase-1 blanket
    // ForbiddenException made `payPayoutRequest` return HTTP 403 even after
    // the cascade had committed, because the method tail-calls this lookup
    // to build the response. Allow DROP to read THEIR OWN payout request;
    // continue to deny when they would peek at someone else's.
    if (currentUser.role === 'DROP' && req.seniorId !== currentUser.id)
      throw new ForbiddenException()

    return {
      id: req.id,
      seniorId: req.seniorId,
      seniorName:
        (req as typeof req & { senior: { displayName: string } | null }).senior?.displayName ?? '',
      incomeAmount: req.incomeAmount,
      payableAmount: req.payableAmount,
      contractAddress: req.contractAddress,
      txHash: req.txHash,
      status: req.status,
      transactions: (req as typeof req & { transactions: TxWithRelations[] }).transactions.map(
        (tx) => this.mapTx(tx),
      ),
      createdAt: req.createdAt.toISOString(),
      updatedAt: req.updatedAt.toISOString(),
    }
  }

  // ── Finance Summary (stats) ───────────────────────────────────────────────

  async getSummary(_currentUser: SessionUser) {
    const allTxs = (await this.db.db.query.transactions.findMany({
      with: {
        sender: { columns: { displayName: true } },
        receiver: { columns: { displayName: true } },
        project: { columns: { name: true } },
      },
    })) as TxWithRelations[]

    const paid = allTxs.filter((tx) => tx.status === 'PAID')

    // Drop role - phase 2: DROP_INCOME counts toward total income for
    // reporting purposes (gross money that came in through DROPs).
    const totalIncome = paid
      .filter(
        (tx) =>
          tx.type === 'ADMIN_INCOME' || tx.type === 'SENIOR_INCOME' || tx.type === 'DROP_INCOME',
      )
      .reduce((sum, tx) => sum + parseFloat(tx.amount), 0)

    const totalExpenses = paid
      .filter((tx) => tx.type === 'EXPENSE')
      .reduce((sum, tx) => sum + parseFloat(tx.amount), 0)

    const totalSalaries = paid
      .filter((tx) => tx.type === 'SALARY')
      .reduce((sum, tx) => sum + parseFloat(tx.amount), 0)

    // Admin balances: sum of PAYOUT_ADMIN received + ADMIN_INCOME - ADMIN_TRANSFER sent.
    // Drop role - phase 3 (spec §8.4): PAYOUT_CONFIRMED — the row inserted by
    // `confirmPayout` when ACCOUNTANT/ADMIN manually confirms an off-platform
    // payout — also credits the chosen admin's balance. Phase 2 PAYOUT_ADMIN
    // (automatic 50/50 split) remains untouched and continues to count too;
    // both flows run in parallel per task scope ("Phase 2 auto-50/50 НЕ
    // ТРОГАТЬ — manual flow живёт параллельно"). Senior-only / legacy admin
    // balance values are unchanged because they never produce PAYOUT_CONFIRMED
    // rows.
    const adminUsers = await this.db.db.query.users.findMany({
      where: eq(users.role, 'ADMIN'),
    })

    const adminBalances = adminUsers.map((admin) => {
      const received = paid
        .filter(
          (tx) =>
            tx.receiverId === admin.id &&
            (tx.type === 'PAYOUT_ADMIN' ||
              tx.type === 'ADMIN_INCOME' ||
              tx.type === 'ADMIN_TRANSFER' ||
              tx.type === 'PAYOUT_CONFIRMED'),
        )
        .reduce((sum, tx) => sum + parseFloat(tx.amount), 0)
      const sent = paid
        .filter((tx) => tx.senderId === admin.id && tx.type === 'ADMIN_TRANSFER')
        .reduce((sum, tx) => sum + parseFloat(tx.amount), 0)
      return { userId: admin.id, displayName: admin.displayName, balance: received - sent }
    })

    // Drop role - phase 2 (AC4): aggregate balance per DROP user — credit on
    // PAYOUT_DROP (their slice of drop-project distribution) minus any debit
    // (none today; field kept here for symmetry with adminBalances). Empty
    // array when no DROP users exist. The shape is intentionally identical
    // to adminBalances so the frontend can render both side-by-side.
    const dropUsers = await this.db.db.query.users.findMany({
      where: eq(users.role, 'DROP'),
    })

    const dropBalances = dropUsers.map((drop) => {
      const received = paid
        .filter((tx) => tx.receiverId === drop.id && tx.type === 'PAYOUT_DROP')
        .reduce((sum, tx) => sum + parseFloat(tx.amount), 0)
      const sent = paid
        .filter((tx) => tx.senderId === drop.id && tx.type === 'PAYOUT_DROP')
        .reduce((sum, tx) => sum + parseFloat(tx.amount), 0)
      return { userId: drop.id, displayName: drop.displayName, balance: received - sent }
    })

    // Monthly breakdown
    const monthMap = new Map<string, { income: number; expenses: number; salaries: number }>()

    for (const tx of paid) {
      const month = tx.createdAt.toISOString().slice(0, 7) // YYYY-MM
      if (!monthMap.has(month)) monthMap.set(month, { income: 0, expenses: 0, salaries: 0 })
      const entry = monthMap.get(month)!
      const amt = parseFloat(tx.amount)

      if (tx.type === 'ADMIN_INCOME' || tx.type === 'SENIOR_INCOME' || tx.type === 'DROP_INCOME') {
        entry.income += amt
      } else if (tx.type === 'EXPENSE') entry.expenses += amt
      else if (tx.type === 'SALARY') entry.salaries += amt
    }

    const monthly = Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({
        month,
        income: v.income,
        expenses: v.expenses,
        salaries: v.salaries,
        profit: v.income - v.expenses - v.salaries,
      }))

    return {
      totalIncome,
      totalExpenses,
      totalSalaries,
      netBalance: totalIncome - totalExpenses - totalSalaries,
      adminBalances,
      dropBalances,
      monthly,
    }
  }

  // ── Project Finance Settings ──────────────────────────────────────────────

  async getProjectFinanceSettings(projectId: string, currentUser: SessionUser) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException()
    }

    const settings = await this.db.db.query.projectFinanceSettings.findFirst({
      where: eq(projectFinanceSettings.projectId, projectId),
    })
    return settings ?? null
  }

  async upsertProjectFinanceSettings(
    projectId: string,
    data: {
      seniorSharePercentOverride?: number | null | undefined
      juniorSalaryOverride?: number | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException()
    }

    const project = await this.db.db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    })
    if (!project) throw new NotFoundException('Project not found')

    const existing = await this.db.db.query.projectFinanceSettings.findFirst({
      where: eq(projectFinanceSettings.projectId, projectId),
    })

    const values = {
      seniorSharePercentOverride: data.seniorSharePercentOverride ?? null,
      juniorSalaryOverride:
        data.juniorSalaryOverride !== undefined && data.juniorSalaryOverride !== null
          ? String(data.juniorSalaryOverride)
          : null,
      updatedBy: currentUser.id,
      updatedAt: new Date(),
    }

    if (existing) {
      await this.db.db
        .update(projectFinanceSettings)
        .set(values)
        .where(eq(projectFinanceSettings.projectId, projectId))
    } else {
      await this.db.db.insert(projectFinanceSettings).values({ projectId, ...values })
    }

    return this.getProjectFinanceSettings(projectId, currentUser)
  }

  // ── Pay salary manually ───────────────────────────────────────────────────

  async paySalary(
    id: string,
    data: {
      txHash?: string | null | undefined
      notes?: string | null | undefined
    },
    currentUser: SessionUser,
  ) {
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()

    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, id),
    })
    if (!tx) throw new NotFoundException('Transaction not found')
    if (tx.type !== 'SALARY') throw new BadRequestException('Can only pay SALARY transactions')
    if (tx.status !== 'PENDING') throw new BadRequestException('Transaction is not PENDING')

    await this.db.db
      .update(transactions)
      .set({
        status: 'PAID',
        txHash: data.txHash ?? null,
        notes: data.notes ?? tx.notes,
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, id))

    // Trigger 2: invoice auto-create for SALARY → PAID transitions.
    await this.safeAutoCreateInvoice('SALARY', id)

    return this.findOne(id, currentUser)
  }

  // ── Cron helpers ──────────────────────────────────────────────────────────

  async createMonthlySalaries(month: string) {
    // Create PENDING salary for HR and ACCOUNTANT
    const employees = await this.db.db.query.users.findMany({
      where: or(eq(users.role, 'HR'), eq(users.role, 'ACCOUNTANT')),
    })

    // Find the admin who creates (Maksym by default)
    const admin = await this.db.db.query.users.findFirst({
      where: and(eq(users.role, 'ADMIN'), eq(users.id, MAKSYM_ID)),
    })
    if (!admin) return

    for (const emp of employees) {
      if (!emp.monthlySalary) continue

      // Skip if already created for this month
      const existing = await this.db.db.query.transactions.findFirst({
        where: and(
          eq(transactions.type, 'SALARY'),
          eq(transactions.receiverId, emp.id),
          eq(transactions.salaryMonth, month),
        ),
      })
      if (existing) continue

      await this.db.db.insert(transactions).values({
        type: 'SALARY',
        status: 'PENDING',
        amount: emp.monthlySalary,
        currency: 'USD',
        senderId: admin.id,
        senderLabel: 'CheekyCheeseIT',
        receiverId: emp.id,
        salaryMonth: month,
        createdBy: admin.id,
      })
    }

    // Create LOCKED salary for JUNIORs on active projects
    const activeMembers = await this.db.db.query.projectMembers.findMany({
      where: isNull(projectMembers.leftAt),
      with: {
        user: true,
        project: { with: { financeSettings: true } },
      },
    })

    for (const member of activeMembers) {
      const user = (member as typeof member & { user: typeof users.$inferSelect | null }).user
      const project = (
        member as typeof member & {
          project:
            | (typeof projects.$inferSelect & {
                financeSettings: typeof projectFinanceSettings.$inferSelect | null
              })
            | null
        }
      ).project

      if (!user || user.role !== 'JUNIOR' || !project) continue

      const existing = await this.db.db.query.transactions.findFirst({
        where: and(
          eq(transactions.type, 'SALARY'),
          eq(transactions.receiverId, user.id),
          eq(transactions.salaryMonth, month),
        ),
      })
      if (existing) continue

      // Check if project already has a validated income this month → PENDING, else LOCKED
      const currentMonthStart = new Date(`${month}-01`)
      const nextMonthStart = new Date(currentMonthStart)
      nextMonthStart.setMonth(nextMonthStart.getMonth() + 1)

      // Drop role - phase 2 (AC5): drop-projects unlock junior salary on a
      // validated DROP_INCOME as well — the income side is what matters for
      // the unlock, not whether the wallet is a SENIOR or a DROP.
      const hasValidatedIncome = await this.db.db.query.transactions.findFirst({
        where: and(
          or(eq(transactions.type, 'SENIOR_INCOME'), eq(transactions.type, 'DROP_INCOME')),
          eq(transactions.projectId, project.id),
          eq(transactions.status, 'VALIDATED'),
        ),
      })

      // Resolve salary: project override → user default
      const salaryAmount = project.financeSettings?.juniorSalaryOverride ?? user.monthlySalary
      if (!salaryAmount) continue

      await this.db.db.insert(transactions).values({
        type: 'SALARY',
        status: hasValidatedIncome ? 'PENDING' : 'LOCKED',
        amount: String(salaryAmount),
        currency: 'USD',
        senderId: admin.id,
        senderLabel: 'CheekyCheeseIT',
        receiverId: user.id,
        projectId: project.id,
        salaryMonth: month,
        createdBy: admin.id,
      })
    }
  }

  // Unlock LOCKED junior salary when a senior OR drop income is validated.
  // Drop role - phase 2 (AC5): the trigger condition is "any validated income
  // on the project" — caller passes the validated row (SENIOR_INCOME or
  // DROP_INCOME) and we flip the LOCKED salary for the active junior.
  private async unlockJuniorSalaryForProject(projectId: string | null, incomeTx: Transaction) {
    if (!projectId) return

    const month = incomeTx.createdAt.toISOString().slice(0, 7)

    // Find the active junior on this project
    const activeMember = await this.db.db.query.projectMembers.findFirst({
      where: and(eq(projectMembers.projectId, projectId), isNull(projectMembers.leftAt)),
      with: { user: true },
    })

    const juniorUser = (
      activeMember as (typeof activeMember & { user: typeof users.$inferSelect | null }) | undefined
    )?.user
    if (!juniorUser || juniorUser.role !== 'JUNIOR') return

    await this.db.db
      .update(transactions)
      .set({
        status: 'PENDING',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(transactions.type, 'SALARY'),
          eq(transactions.receiverId, juniorUser.id),
          eq(transactions.salaryMonth, month),
          eq(transactions.status, 'LOCKED'),
        ),
      )
  }

  // ── Access guard ──────────────────────────────────────────────────────────

  private assertReadAccess(tx: TxWithRelations, currentUser: SessionUser) {
    if (currentUser.role === 'ADMIN' || currentUser.role === 'ACCOUNTANT') return
    if (currentUser.role === 'SENIOR') {
      // Drop role - phase 3: PAYOUT_CONFIRMED matches PAYOUT_ADMIN — admin
      // attribution rows are never visible to SENIOR via findOne either.
      if (
        (tx.senderId === currentUser.id || tx.receiverId === currentUser.id) &&
        tx.type !== 'PAYOUT_ADMIN' &&
        tx.type !== 'PAYOUT_CONFIRMED'
      )
        return
      throw new ForbiddenException()
    }
    if (currentUser.role === 'JUNIOR') {
      if (tx.receiverId === currentUser.id) return
      throw new ForbiddenException()
    }
    if (currentUser.role === 'HR') {
      if (tx.receiverId === currentUser.id || tx.senderId === currentUser.id) return
      throw new ForbiddenException()
    }
    // Drop role - phase 1 (AC1, security): same shape as SENIOR — own
    // sender/receiver rows only, no PAYOUT_ADMIN. In Phase 1 the row set is
    // typically empty; explicit clause keeps the contract crisp.
    if (currentUser.role === 'DROP') {
      if (
        (tx.senderId === currentUser.id || tx.receiverId === currentUser.id) &&
        tx.type !== 'PAYOUT_ADMIN' &&
        tx.type !== 'PAYOUT_CONFIRMED'
      )
        return
      throw new ForbiddenException()
    }
    throw new ForbiddenException()
  }
}
