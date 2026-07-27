import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { COMPANY_REQUISITES_MAX, receiptMandatoryError } from '@crm/shared'
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
import { isUniqueViolation } from '../database/pg-errors'
import {
  addressesMatch,
  consumeTxHash,
  findConsumedTxHash,
  TX_HASH_ALREADY_CONSUMED_MESSAGE,
} from './onchain-tx'

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
 * on-chain recipient matches the configured company wallet, the on-chain SENDER
 * matches the submitter's registered wallet, AND confirmations reach the
 * threshold. Enforced in `submitDeposit` / `getDepositStatus` via
 * `EtherscanService.verifyDeposit` (`toMatches` + `fromMatches` + `confirmed`).
 *
 * SECURITY INVARIANT #2 (task-onchain-payment-integrity): a real on-chain
 * transfer settles AT MOST ONE thing system-wide. Both this service and the
 * payout path claim the hash in the shared `consumed_tx_hashes` registry inside
 * the same transaction as the credit, so one transfer can no longer be spent
 * both as a payout and as a deposit.
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
      requisitesMarkdown: row.requisitesMarkdown,
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
   * PATCH /api/company-account/requisites — ADMIN only. Stores the company
   * requisites markdown that gets auto-appended as a «Реквизиты компании»
   * section at the END of every NEW contract at sign time.
   *
   * - Empty / whitespace-only input is coerced to NULL so a blank value never
   *   produces a heading-only section in future contracts.
   * - Length is capped (defensively re-checked here; the Zod schema already
   *   enforces COMPANY_REQUISITES_MAX at the controller boundary).
   * - Audited under a DISTINCT action (`company_account.requisites_changed`) so
   *   wallet vs requisites edits are separable in the audit log. The body is
   *   business config (not a secret like the wallet), so we record presence +
   *   length rather than redacting — enough to audit without bloating the log.
   * - Uses a transaction + WHERE on the single row id so a concurrent wallet
   *   edit cannot clobber this write (each UPDATE sets only its own column).
   */
  async updateRequisites(
    requisitesMarkdown: string,
    currentUser: SessionUser,
  ): Promise<CompanyAccountDto> {
    if (currentUser.role !== 'ADMIN') {
      throw new ForbiddenException('Менять реквизиты компании может только ADMIN')
    }
    if (requisitesMarkdown.length > COMPANY_REQUISITES_MAX) {
      throw new BadRequestException(
        `Реквизиты не должны превышать ${COMPANY_REQUISITES_MAX} символов`,
      )
    }

    // Coerce empty / whitespace-only to NULL (no heading-only section later).
    const normalized = requisitesMarkdown.trim() === '' ? null : requisitesMarkdown

    const row = await this.getRow()
    const before = row.requisitesMarkdown

    await this.db.db.transaction(async (tx) => {
      await tx
        .update(companyAccount)
        .set({ requisitesMarkdown: normalized, updatedBy: currentUser.id, updatedAt: new Date() })
        .where(eq(companyAccount.id, row.id))

      if (before !== normalized) {
        await tx.insert(userAuditLog).values({
          actorId: currentUser.id,
          targetId: currentUser.id,
          action: 'company_account.requisites_changed',
          changes: {
            requisitesMarkdown: {
              beforeLength: before?.length ?? 0,
              afterLength: normalized?.length ?? 0,
            },
          },
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
   *   3. CROSS-PATH: reject a hash already consumed by a payout settlement.
   *   4. verifyDeposit against the configured wallet + THE SUBMITTER'S OWN
   *      wallet + threshold.
   *   5. Insert a COMPANY_DEPOSIT + claim the hash in `consumed_tx_hashes`, in
   *      ONE transaction: PAID iff (toMatches && fromMatches && confirmed),
   *      else PENDING. amount = verified amount (0 when unknown / pending).
   *
   * SECURITY: a mismatching recipient, a MISMATCHING SENDER, or a sub-threshold
   * confirmation count NEVER yields PAID — the deposit stays PENDING (or is
   * rejected outright, for a sender that is known-not-you) and contributes 0 to
   * the balance.
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

    // ── SECURITY (task-onchain-payment-integrity, HOLE 2): CROSS-PATH fast-fail.
    // The idempotency lookup above only sees COMPANY_DEPOSIT rows. A hash that
    // already settled a PAYOUT lives in `payout_requests` — invisible here, and
    // the two unique indexes are disjoint — so the very same transfer used to
    // be creditable a second time as a deposit (the balance sums both terms).
    // The authoritative claim is `consumeTxHash` inside the insert transaction
    // below; this read is the clean early error.
    const consumed = await findConsumedTxHash(this.db.db, txHash)
    if (consumed) {
      throw new BadRequestException(TX_HASH_ALREADY_CONSUMED_MESSAGE)
    }

    // ── SECURITY (task-onchain-payment-integrity, HOLE 1): WHOSE money is it.
    // Verification used to assert the RECIPIENT only, so a SENIOR/DROP could
    // take any stranger's transfer into the company wallet off a public
    // explorer and credit the company account (and thus their own standing)
    // with it. The submitter's registered wallet is the reference the on-chain
    // sender is compared against.
    //
    // FAIL-CLOSED on an unset wallet — with nothing to compare against, "allow"
    // would restore the hole in one click (clear the field, claim anything).
    const submitter = await this.db.db.query.users.findFirst({
      where: eq(users.id, currentUser.id),
      columns: { walletUsdtErc20: true },
    })
    const submitterWallet = submitter?.walletUsdtErc20?.trim() ?? null
    if (!submitterWallet) {
      throw new BadRequestException(
        'Укажите свой USDT (ERC-20) кошелёк в профиле — с него должно быть отправлено пополнение',
      )
    }

    const verification = await this.etherscan.verifyDeposit(
      txHash,
      account.walletAddress,
      submitterWallet,
      account.confirmationThreshold,
    )

    // KNOWN-not-you sender → hard 400, no row at all. Unlike a missing
    // confirmation (which time fixes, hence a PENDING row + polling), a wrong
    // sender can never become right, so there is nothing to poll: reject, and
    // do not let the submitter park somebody else's hash in our tables.
    // `fromAddress === null` (chain unreachable / not mined yet) deliberately
    // does NOT hard-fail — it falls through to a PENDING, uncredited row.
    if (verification.fromAddress !== null && !verification.fromMatches) {
      throw new BadRequestException(
        'Отправитель транзакции не совпадает с вашим USDT-кошельком — пополнение можно подтвердить только своим переводом',
      )
    }

    // Credit (PAID + amount) ONLY when recipient matches, SENDER matches,
    // confirmed, AND a positive amount resolved (M4). A confirmed-but-unknown-
    // amount stays PENDING and is resolved later by getDepositStatus re-polling.
    // (`confirmed` already embeds `fromMatches`; both are named here so the gate
    // reads as the invariant it enforces.)
    const verifiedAmount = verification.amountUsdt ?? 0
    const credited =
      verification.toMatches &&
      verification.fromMatches &&
      addressesMatch(verification.fromAddress, submitterWallet) &&
      verification.confirmed &&
      verifiedAmount > 0
    const amount = credited ? verifiedAmount : 0

    let tx: typeof transactions.$inferSelect
    try {
      // ONE transaction: the deposit row and its claim on the on-chain hash
      // commit together, so a concurrent payout/deposit racing for the same
      // hash is resolved by the DB (unique index) rather than by a stale read.
      tx = await this.db.db.transaction(async (dbtx) => {
        const [inserted] = await dbtx
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

        // Claimed even while PENDING: the hash is spoken for the moment it is
        // attached to a deposit row (matching the pre-existing behaviour of
        // `uq_transactions_company_deposit_tx_hash`, which already blocked
        // re-submission regardless of status) — otherwise the window between
        // submit and confirmation would let the same transfer settle a payout.
        await consumeTxHash(dbtx, {
          txHash,
          purpose: 'COMPANY_DEPOSIT',
          referenceId: inserted!.id,
          consumedByUserId: currentUser.id,
        })

        return inserted!
      })
    } catch (err) {
      // 23505 — two different constraints can fire here, so we disambiguate by
      // re-reading rather than by matching constraint names:
      //   • `uq_transactions_company_deposit_tx_hash` (M3 idempotency race): a
      //     concurrent submit of the SAME hash slipped past the lookup above →
      //     return the winner's row (idempotent, never a 500).
      //   • `uq_consumed_tx_hashes_tx_hash` (HOLE 2 race): the hash was claimed
      //     by a PAYOUT settling concurrently → no deposit row exists → 400.
      // NB: uses the shared cause-chain check; the previous top-level `.code`
      // read missed drizzle-wrapped violations and turned them into 500s.
      if (isUniqueViolation(err)) {
        const winner = await this.db.db.query.transactions.findFirst({
          where: and(eq(transactions.type, 'COMPANY_DEPOSIT'), eq(transactions.txHash, txHash)),
        })
        if (winner) return this.toDepositDto(winner, account.confirmationThreshold)
        throw new BadRequestException(TX_HASH_ALREADY_CONSUMED_MESSAGE)
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
    //
    // SECURITY (task-onchain-payment-integrity, HOLE 1): this is the THIRD path
    // that can flip a deposit to PAID, so it needs the same sender check as
    // `submitDeposit` — otherwise a deposit that failed the sender gate at
    // submit time (or was created before this fix) could be credited by simply
    // polling its status. The reference wallet belongs to the deposit's OWNER
    // (`tx.senderId`), NOT to whoever is polling: an ADMIN/ACCOUNTANT may poll
    // somebody else's deposit, and it must still be judged against the money's
    // claimed sender.
    const depositOwner = tx.senderId
      ? await this.db.db.query.users.findFirst({
          where: eq(users.id, tx.senderId),
          columns: { walletUsdtErc20: true },
        })
      : null
    const ownerWallet = depositOwner?.walletUsdtErc20?.trim() ?? null

    const verification = await this.etherscan.verifyDeposit(
      tx.txHash ?? '',
      account.walletAddress,
      ownerWallet,
      threshold,
    )

    const resolvedAmount = verification.amountUsdt ?? parseFloat(tx.amount)
    if (
      verification.toMatches &&
      // Sender gate — `confirmed` embeds it too; spelled out so the credit
      // condition states the full invariant. Fails closed when the owner has no
      // registered wallet (`ownerWallet === null` → `fromMatches === false`).
      verification.fromMatches &&
      addressesMatch(verification.fromAddress, ownerWallet) &&
      verification.confirmed &&
      resolvedAmount > 0
    ) {
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
    input: {
      amount: number
      adminId?: string | undefined
      idempotencyKey: string
      // task-receipts-backend (#9): a dividend is a USDT withdrawal → receipt
      // MANDATORY and explorer-only. Zod enforces this; re-checked below.
      receiptDocumentId?: string | null | undefined
      receiptExternalUrl?: string | null | undefined
    },
    currentUser: SessionUser,
  ): Promise<{ id: string; amount: number; receiverId: string }> {
    if (currentUser.role !== 'ADMIN') {
      throw new ForbiddenException('Выводить дивиденды может только ADMIN')
    }
    if (!(input.amount > 0)) {
      throw new BadRequestException('Сумма дивидендов должна быть положительной')
    }

    // task-receipts-backend defense-in-depth: USDT → explorer-only, mandatory.
    const receiptErr = receiptMandatoryError(
      { receiptDocumentId: input.receiptDocumentId, receiptExternalUrl: input.receiptExternalUrl },
      'USDT',
    )
    if (receiptErr) throw new BadRequestException(receiptErr)

    // BIZ-19 (MED-2): idempotency check. Look for an existing DIVIDEND_TO_ADMIN
    // row with that key BEFORE acquiring the advisory lock (the lookup is a plain
    // SELECT — no concurrency risk). On hit, return the existing row immediately
    // — no double-debit, no error.
    const existing = await this.db.db.query.transactions.findFirst({
      where: and(
        eq(transactions.type, 'DIVIDEND_TO_ADMIN'),
        eq(transactions.idempotencyKey, input.idempotencyKey),
      ),
    })
    if (existing) {
      return {
        id: existing.id,
        amount: parseFloat(existing.amount as unknown as string),
        receiverId: existing.receiverId ?? currentUser.id,
      }
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
      let row: typeof transactions.$inferSelect | undefined
      try {
        const [inserted] = await dbtx
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
            // task-receipts-backend (#9): explorer link (USDT → explorer-only, so
            // receiptDocumentId is always null here).
            receiptDocumentId: input.receiptDocumentId ?? null,
            receiptExternalUrl: input.receiptExternalUrl ?? null,
            // BIZ-19: persist the key so the unique index enforces idempotency
            // as a DB-level backstop (concurrent races that bypass the SELECT above).
            idempotencyKey: input.idempotencyKey ?? null,
          })
          .returning()
        row = inserted
      } catch (err) {
        // MED-1 (BIZ-19 race): two concurrent requests with the same
        // idempotencyKey both miss the early-SELECT (it runs outside the lock),
        // both enter the advisory-lock serialization queue, A inserts + commits,
        // B hits the partial unique index (23505). Instead of a 500 we re-read
        // the committed row and return it — idempotent response, no double-debit.
        if (input.idempotencyKey && isUniqueViolation(err)) {
          // After a 23505 the Postgres transaction is in aborted state — any
          // further query on `dbtx` would fail with "current transaction is
          // aborted". Use a fresh connection (this.db.db) to re-read the row
          // that the concurrent winner already committed.
          const existing = await this.db.db.query.transactions.findFirst({
            where: and(
              eq(transactions.type, 'DIVIDEND_TO_ADMIN'),
              eq(transactions.idempotencyKey, input.idempotencyKey),
            ),
          })
          if (existing) return existing
        }
        throw err
      }
      return row!
    })

    return {
      id: tx.id,
      // Use input.amount (already a number) for the happy-path INSERT return.
      // The tx row holds amount as a string column; parseFloat is only needed
      // for idempotent re-read paths (early-SELECT / MED-1 catch) that map DB
      // rows — those return early above with their own parseFloat calls.
      amount: input.amount,
      receiverId: tx.receiverId ?? receiverId,
    }
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
