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
      createdBy: tx.createdBy,
      createdAt: tx.createdAt.toISOString(),
      updatedAt: tx.updatedAt.toISOString(),
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
      result = result.filter(
        (tx) =>
          (tx.senderId === currentUser.id || tx.receiverId === currentUser.id) &&
          tx.type !== 'PAYOUT_ADMIN',
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
        txDate: data.txDate ? new Date(data.txDate) : null,
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
        txDate: data.txDate ? new Date(data.txDate) : null,
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
    if (tx.type === 'PAYOUT' || tx.type === 'PAYOUT_ADMIN') {
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
    if (tx.type === 'PAYOUT' || tx.type === 'PAYOUT_ADMIN') {
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
    if (tx.type !== 'SENIOR_INCOME')
      throw new BadRequestException('Only SENIOR_INCOME can be validated')
    // AC4: idempotency. The action is only valid on PENDING rows — a second
    // click after a successful validate would otherwise create a duplicate
    // PAYOUT row. We throw rather than silently no-op so the UI can show
    // a clear error to the ACCOUNTANT (vs. pretending it worked twice).
    if (tx.status !== 'PENDING')
      throw new BadRequestException('Transaction is not in PENDING status')

    if (action === 'validate') {
      // AC1 + AC5: validate atomically flips the SENIOR_INCOME to
      // PENDING_PAYMENT *and* creates the 1-to-1 «Выплата» row. The PAYOUT
      // row carries the «Оплатить» button — SENIOR_INCOME no longer does.
      //
      // We deliberately skip the VALIDATED intermediate state in this flow:
      // status moves PENDING → PENDING_PAYMENT directly. «VALIDATED» remains
      // a valid value for legacy rows + the batch payout endpoint
      // (createPayoutRequest) which still uses VALIDATED → PENDING_PAYMENT.
      //
      // db.transaction() guarantees both the UPDATE and the INSERT happen
      // together — if the PAYOUT insert fails, the SENIOR_INCOME stays
      // PENDING and the ACCOUNTANT can retry.
      if (!tx.receiverId) {
        throw new BadRequestException(
          'SENIOR_INCOME has no receiverId — cannot create payout',
        )
      }
      const senior = await this.db.db.query.users.findFirst({
        where: eq(users.id, tx.receiverId),
      })
      if (!senior) throw new NotFoundException('Senior receiver not found')

      // Senior keeps `sharePercent`%, pays `100 - sharePercent`% to company.
      // Snapshot from the SENIOR_INCOME row (set at createSeniorIncome time
      // from project override → user default) so the payout uses the same %
      // that was visible to the senior when they submitted income.
      const sharePercent = tx.seniorSharePercent ?? senior.seniorSharePercent ?? 26
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

        // 2) Flip SENIOR_INCOME status to PENDING_PAYMENT + link it to the
        //    payout_request so the UI groups them.
        await dbtx
          .update(transactions)
          .set({
            status: 'PENDING_PAYMENT',
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
        txDate: data.txDate ? new Date(data.txDate) : null,
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
        txDate: data.txDate ? new Date(data.txDate) : null,
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
        txDate: data.txDate ? new Date(data.txDate) : null,
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
    txHash: string,
    currentUser: SessionUser,
    simulateResult?: 'success' | 'error',
  ) {
    if (currentUser.role !== 'SENIOR') throw new ForbiddenException()

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
    if (isDevMode && simulateResult === 'error') {
      throw new BadRequestException('Симуляция: транзакция не подтверждена')
    }
    // simulateResult === 'success' falls through to the normal cascade below
    // (which already short-circuits etherscan today — see EtherscanService
    // header comment about the missing real-verification call site).

    // Mark payout request as paid
    await this.db.db
      .update(payoutRequests)
      .set({
        txHash,
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

    // Trigger 1: invoice auto-create for each SENIOR_INCOME just paid.
    // Best-effort — see safeAutoCreateInvoice for the no-rollback contract.
    // Fetched separately (the UPDATE above doesn't return rows in drizzle's
    // current Postgres flavour without `.returning()` chaining).
    const paidSeniorIncomeTxs = await this.db.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(eq(transactions.payoutRequestId, requestId), eq(transactions.type, 'SENIOR_INCOME')),
      )
    for (const incomeTx of paidSeniorIncomeTxs) {
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
        txHash,
        updatedAt: new Date(),
      })
      .where(
        and(eq(transactions.payoutRequestId, requestId), eq(transactions.type, 'PAYOUT')),
      )

    // Create 2x PAYOUT_ADMIN transactions (50/50 split)
    const adminShare = parseFloat(req.payableAmount) / 2
    const adminIds = [MAKSYM_ID, KOSTYA_ID]

    for (const adminId of adminIds) {
      const admin = await this.db.db.query.users.findFirst({
        where: eq(users.id, adminId),
      })
      if (admin) {
        await this.db.db.insert(transactions).values({
          type: 'PAYOUT_ADMIN',
          status: 'PAID',
          amount: String(adminShare),
          currency: 'USDT',
          senderId: currentUser.id,
          receiverId: adminId,
          payoutRequestId: requestId,
          txHash,
          createdBy: currentUser.id,
        })
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
      currentUser.role === 'SENIOR' ? all.filter((r) => r.seniorId === currentUser.id) : all

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

    const totalIncome = paid
      .filter((tx) => tx.type === 'ADMIN_INCOME' || tx.type === 'SENIOR_INCOME')
      .reduce((sum, tx) => sum + parseFloat(tx.amount), 0)

    const totalExpenses = paid
      .filter((tx) => tx.type === 'EXPENSE')
      .reduce((sum, tx) => sum + parseFloat(tx.amount), 0)

    const totalSalaries = paid
      .filter((tx) => tx.type === 'SALARY')
      .reduce((sum, tx) => sum + parseFloat(tx.amount), 0)

    // Admin balances: sum of PAYOUT_ADMIN received + ADMIN_INCOME - ADMIN_TRANSFER sent
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
              tx.type === 'ADMIN_TRANSFER'),
        )
        .reduce((sum, tx) => sum + parseFloat(tx.amount), 0)
      const sent = paid
        .filter((tx) => tx.senderId === admin.id && tx.type === 'ADMIN_TRANSFER')
        .reduce((sum, tx) => sum + parseFloat(tx.amount), 0)
      return { userId: admin.id, displayName: admin.displayName, balance: received - sent }
    })

    // Monthly breakdown
    const monthMap = new Map<string, { income: number; expenses: number; salaries: number }>()

    for (const tx of paid) {
      const month = tx.createdAt.toISOString().slice(0, 7) // YYYY-MM
      if (!monthMap.has(month)) monthMap.set(month, { income: 0, expenses: 0, salaries: 0 })
      const entry = monthMap.get(month)!
      const amt = parseFloat(tx.amount)

      if (tx.type === 'ADMIN_INCOME' || tx.type === 'SENIOR_INCOME') entry.income += amt
      else if (tx.type === 'EXPENSE') entry.expenses += amt
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

      const hasValidatedIncome = await this.db.db.query.transactions.findFirst({
        where: and(
          eq(transactions.type, 'SENIOR_INCOME'),
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

  // Unlock LOCKED junior salary when a senior income is validated
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
      if (
        (tx.senderId === currentUser.id || tx.receiverId === currentUser.id) &&
        tx.type !== 'PAYOUT_ADMIN'
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
    throw new ForbiddenException()
  }
}
