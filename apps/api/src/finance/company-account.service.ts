import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import type {
  CompanyAccountDto,
  CompanyDepositDto,
  DepositStatusDto,
  SessionUser,
} from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { companyAccount, transactions, userAuditLog, users } from '../database/schema'
import { EtherscanService } from './etherscan.service'
import {
  computeCompanyAccountBalanceFromLedger,
  lockCompanyAccount,
} from './company-account-balance'

/**
 * task-company-account-backend — the shared company USDT account.
 *
 * Replaces the cancelled smart-contract design. Responsibilities:
 *   - wallet config (ADMIN only, audited)
 *   - derived USDT balance from the ledger (single source of truth)
 *   - SENIOR/DROP deposit submission (Etherscan-verified, idempotent)
 *   - deposit status polling (confirmations progress; PENDING→PAID flip)
 *   - ADMIN dividend withdrawal (free amount, 50/50 accounted post-hoc)
 *
 * SECURITY INVARIANT #1: a deposit is credited (status=PAID) ONLY when the
 * on-chain recipient matches the configured company wallet AND confirmations
 * reach the threshold. Enforced in `submitDeposit` / `getDepositStatus` via
 * `EtherscanService.verifyDeposit` (which returns `toMatches` + `confirmed`).
 */
@Injectable()
export class CompanyAccountService {
  private readonly logger = new Logger(CompanyAccountService.name)

  // Extract a 0x-prefixed 32-byte tx hash from a bare hash or an Etherscan link.
  private static readonly TX_HASH_RE = /0x[0-9a-fA-F]{64}/

  constructor(
    private readonly db: DatabaseService,
    private readonly etherscan: EtherscanService,
  ) {}

  /** The single company_account row, created in seed. Throws if missing. */
  private async getRow() {
    const row = await this.db.db.query.companyAccount.findFirst()
    if (!row) throw new NotFoundException('Company account row not found (seed missing)')
    return row
  }

  /**
   * Derived USDT balance — delegates to the SINGLE SOURCE OF TRUTH
   * `computeCompanyAccountBalanceFromLedger` shared with the salary/expense
   * balance gate in TransactionsService. See company-account-balance.ts for the
   * full 6-term ledger formula. Both display (this endpoint) and gate use the
   * exact same function so they can never disagree (task-salary-company-account
   * reconciliation).
   */
  private async computeBalance(): Promise<number> {
    return computeCompanyAccountBalanceFromLedger(this.db.db)
  }

  /**
   * GET /api/company-account — wallet config + derived balance.
   * RBAC enforced at the controller (ADMIN/ACCOUNTANT) AND here defensively.
   */
  async getAccount(currentUser: SessionUser): Promise<CompanyAccountDto> {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw new ForbiddenException('Доступ к счёту компании: ADMIN или ACCOUNTANT')
    }
    const row = await this.getRow()
    const balance = await this.computeBalance()
    return {
      walletAddress: row.walletAddress,
      confirmationThreshold: row.confirmationThreshold,
      balance,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
    }
  }

  /**
   * PATCH /api/company-account/wallet — ADMIN only. Validates the ETH address
   * (Zod did the format check; we double-check here), updates the row, records
   * an audit entry (redacted value — a wallet is sensitive payment routing).
   */
  async updateWallet(walletAddress: string, currentUser: SessionUser): Promise<CompanyAccountDto> {
    if (currentUser.role !== 'ADMIN') {
      throw new ForbiddenException('Менять кошелёк компании может только ADMIN')
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      throw new BadRequestException('Некорректный адрес кошелька (ожидается 0x + 40 hex)')
    }

    const row = await this.getRow()
    const before = row.walletAddress

    await this.db.db.transaction(async (tx) => {
      await tx
        .update(companyAccount)
        .set({ walletAddress, updatedBy: currentUser.id, updatedAt: new Date() })
        .where(eq(companyAccount.id, row.id))

      // Audit the change. The wallet is sensitive payment-routing config, so we
      // record THAT it changed without persisting the raw addresses at-rest.
      // targetId = the acting admin (no per-account target id; the company
      // account is org-wide). action documents the event.
      if (before !== walletAddress) {
        await tx.insert(userAuditLog).values({
          actorId: currentUser.id,
          targetId: currentUser.id,
          action: 'company_account.wallet_changed',
          changes: { walletAddress: { before: '[redacted]', after: '[redacted]' } },
        })
      }
    })

    return this.getAccount(currentUser)
  }

  /**
   * POST /api/company-account/deposits — SENIOR/DROP submit a USDT deposit.
   *
   * Flow:
   *   1. Extract a tx hash from the input (bare hash OR Etherscan link).
   *   2. IDEMPOTENCY: if a COMPANY_DEPOSIT already exists for this hash, return
   *      it unchanged (no second row, balance never doubles).
   *   3. verifyDeposit against the configured wallet + threshold.
   *   4. Insert a COMPANY_DEPOSIT: PAID iff (toMatches && confirmed), else
   *      PENDING. amount = verified amount (0 when unknown / pending).
   *
   * SECURITY: a mismatching recipient or sub-threshold confirmation count NEVER
   * yields PAID — the deposit stays PENDING and contributes 0 to the balance.
   */
  async submitDeposit(
    input: { txHashOrLink: string },
    currentUser: SessionUser,
  ): Promise<CompanyDepositDto> {
    if (currentUser.role !== 'SENIOR' && currentUser.role !== 'DROP') {
      throw new ForbiddenException('Пополнять счёт компании могут SENIOR или DROP')
    }

    const match = CompanyAccountService.TX_HASH_RE.exec(input.txHashOrLink)
    if (!match) {
      throw new BadRequestException(
        'Не удалось извлечь hash транзакции (ожидается 0x + 64 hex или ссылка Etherscan)',
      )
    }
    const txHash = match[0]

    const account = await this.getRow()

    // ── IDEMPOTENCY: return the existing deposit if this hash was already
    // submitted as a COMPANY_DEPOSIT (the partial unique index is the hard
    // backstop; this lookup avoids hitting it and returns the original row).
    const existing = await this.db.db.query.transactions.findFirst({
      where: and(eq(transactions.type, 'COMPANY_DEPOSIT'), eq(transactions.txHash, txHash)),
    })
    if (existing) {
      return this.toDepositDto(existing, account.confirmationThreshold)
    }

    const verification = await this.etherscan.verifyDeposit(
      txHash,
      account.walletAddress,
      account.confirmationThreshold,
    )

    // Credit (PAID + amount) ONLY when recipient matches, confirmed, AND a
    // positive amount resolved (M4). A confirmed-but-unknown-amount stays
    // PENDING and is resolved later by getDepositStatus re-polling.
    const verifiedAmount = verification.amountUsdt ?? 0
    const credited = verification.toMatches && verification.confirmed && verifiedAmount > 0
    const amount = credited ? verifiedAmount : 0

    let tx: typeof transactions.$inferSelect
    try {
      const [inserted] = await this.db.db
        .insert(transactions)
        .values({
          type: 'COMPANY_DEPOSIT',
          status: credited ? 'PAID' : 'PENDING',
          amount: String(amount),
          currency: 'USDT',
          senderId: currentUser.id,
          senderLabel: currentUser.displayName,
          receiverId: null,
          receiverLabel: 'Счёт компании',
          txHash,
          createdBy: currentUser.id,
        })
        .returning()
      tx = inserted!
    } catch (err) {
      // M3 (idempotency race): a concurrent submit of the same hash can slip
      // past the lookup above and collide on the partial unique index
      // (`uq_transactions_company_deposit_tx_hash`, code 23505). Return the row
      // the winner inserted — idempotent, never a 500.
      if ((err as { code?: string }).code === '23505') {
        const winner = await this.db.db.query.transactions.findFirst({
          where: and(eq(transactions.type, 'COMPANY_DEPOSIT'), eq(transactions.txHash, txHash)),
        })
        if (winner) return this.toDepositDto(winner, account.confirmationThreshold)
      }
      throw err
    }

    return this.toDepositDto(tx, account.confirmationThreshold, verification)
  }

  /**
   * GET /api/company-account/deposits/:id/status — owner | ADMIN | ACCOUNTANT.
   *
   * If the deposit is still PENDING, re-query Etherscan and refresh
   * confirmations; when it now meets the threshold (and recipient matches) flip
   * PENDING→PAID and persist the resolved amount. Returns the light polling DTO.
   */
  async getDepositStatus(id: string, currentUser: SessionUser): Promise<DepositStatusDto> {
    const tx = await this.db.db.query.transactions.findFirst({
      where: and(eq(transactions.id, id), eq(transactions.type, 'COMPANY_DEPOSIT')),
    })
    if (!tx) throw new NotFoundException('Депозит не найден')

    const isOwner = tx.senderId === currentUser.id
    const isPrivileged = currentUser.role === 'ADMIN' || currentUser.role === 'ACCOUNTANT'
    if (!isOwner && !isPrivileged) {
      throw new ForbiddenException('Доступ к статусу депозита: владелец, ADMIN или ACCOUNTANT')
    }

    const account = await this.getRow()
    const threshold = account.confirmationThreshold

    // Terminal states need no re-poll.
    if (tx.status === 'PAID') {
      return {
        status: 'PAID',
        confirmations: threshold,
        threshold,
        amountUsdt: parseFloat(tx.amount),
      }
    }

    // PENDING → re-verify live.
    const verification = await this.etherscan.verifyDeposit(
      tx.txHash ?? '',
      account.walletAddress,
      threshold,
    )

    const resolvedAmount = verification.amountUsdt ?? parseFloat(tx.amount)
    if (verification.toMatches && verification.confirmed && resolvedAmount > 0) {
      // M4: only credit when a positive amount resolved; otherwise stay PENDING.
      await this.db.db
        .update(transactions)
        .set({ status: 'PAID', amount: String(resolvedAmount), updatedAt: new Date() })
        .where(eq(transactions.id, tx.id))
      return {
        status: 'PAID',
        confirmations: verification.confirmations,
        threshold,
        amountUsdt: resolvedAmount,
      }
    }

    // Still pending — surface live confirmations for the progress bar.
    return {
      status: 'PENDING',
      confirmations: verification.confirmations,
      threshold,
      amountUsdt: verification.amountUsdt,
    }
  }

  /**
   * POST /api/company-account/dividends — ADMIN only. Inserts a PAID
   * DIVIDEND_TO_ADMIN crediting the chosen admin (defaults to the caller).
   * Debits the company balance.
   *
   * MED (audit 2026-06-27) — BALANCE GATE + TOCTOU. A dividend is a company-
   * account DEBIT (the ledger formula subtracts every PAID DIVIDEND_TO_ADMIN),
   * yet this path previously inserted UNCONDITIONALLY — overdrawing the shared
   * account into a negative balance. Mirrors the createExpense / paySalary /
   * settleByCompany debit pattern: wrap gate-read + debit-write in ONE DB
   * transaction and acquire the SHARED company-account advisory lock FIRST, so
   * two concurrent dividends serialize — the second blocks, re-reads the
   * already-reduced balance and is correctly refused. The lock entry also folds
   * the dividend into the same advisory-lock serialization ring as every other
   * company-account debit (closes the TOCTOU vs. concurrent salary/expense).
   */
  async createDividend(
    input: { amount: number; adminId?: string | undefined },
    currentUser: SessionUser,
  ): Promise<{ id: string; amount: number; receiverId: string }> {
    if (currentUser.role !== 'ADMIN') {
      throw new ForbiddenException('Выводить дивиденды может только ADMIN')
    }
    if (!(input.amount > 0)) {
      throw new BadRequestException('Сумма дивидендов должна быть положительной')
    }

    const receiverId = input.adminId ?? currentUser.id

    // The receiver must be an ADMIN — dividends only flow to admin partners.
    const receiver = await this.db.db.query.users.findFirst({
      where: eq(users.id, receiverId),
    })
    if (!receiver) throw new NotFoundException('Получатель не найден')
    if (receiver.role !== 'ADMIN') {
      throw new BadRequestException('Дивиденды можно вывести только на счёт админа')
    }

    // MED (TOCTOU + overdraw): gate-read + debit-write serialized under the
    // shared company-account advisory lock. Acquire the lock FIRST, then re-read
    // the live ledger balance INSIDE the transaction and refuse to drive the
    // account negative. Identical structure to TransactionsService.createExpense.
    const tx = await this.db.db.transaction(async (dbtx) => {
      await lockCompanyAccount(dbtx)
      const balance = await computeCompanyAccountBalanceFromLedger(dbtx)
      if (input.amount > balance) {
        throw new BadRequestException(
          'Недостаточно средств на счёте компании для вывода дивидендов',
        )
      }
      const [row] = await dbtx
        .insert(transactions)
        .values({
          type: 'DIVIDEND_TO_ADMIN',
          status: 'PAID',
          amount: String(input.amount),
          currency: 'USDT',
          senderId: null,
          senderLabel: 'Счёт компании',
          receiverId,
          recipientId: receiverId,
          createdBy: currentUser.id,
        })
        .returning()
      return row!
    })

    return { id: tx.id, amount: input.amount, receiverId }
  }

  // ── Mapping helpers ─────────────────────────────────────────────────────────

  private toDepositDto(
    tx: typeof transactions.$inferSelect,
    threshold: number,
    verification?: {
      toMatches: boolean
      confirmations: number
      amountUsdt: number | null
    },
  ): CompanyDepositDto {
    const amountUsdt = parseFloat(tx.amount)
    return {
      id: tx.id,
      txHash: tx.txHash ?? '',
      amountUsdt: Number.isFinite(amountUsdt) ? amountUsdt : null,
      status: (tx.status === 'PAID' ? 'PAID' : 'PENDING') as CompanyDepositDto['status'],
      confirmations: verification?.confirmations ?? (tx.status === 'PAID' ? threshold : 0),
      threshold,
      toMatches: verification?.toMatches ?? tx.status === 'PAID',
      createdAt: tx.createdAt.toISOString(),
    }
  }
}
