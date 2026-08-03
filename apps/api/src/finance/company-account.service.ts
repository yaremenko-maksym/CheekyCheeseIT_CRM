import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { COMPANY_REQUISITES_MAX, extractOnChainTxHash, receiptMandatoryError } from '@crm/shared'
import type {
  CompanyAccountDto,
  CompanyDepositDto,
  DepositStatusDto,
  SessionUser,
} from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import {
  companyAccount,
  transactionAuditLog,
  transactions,
  userAuditLog,
  users,
} from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { EtherscanService } from './etherscan.service'
import {
  computeCompanyAccountBalanceFromLedger,
  lockCompanyAccount,
} from './company-account-balance'
import { isUniqueViolation } from '../database/pg-errors'
import {
  consumeTxHash,
  findConsumedTxHash,
  normalizeEthAddress,
  normalizeOnChainTxHash,
  settlementConsumesTransfer,
  TX_HASH_ALREADY_CONSUMED_MESSAGE,
} from './onchain-tx'
import { assertFoundAndVisible } from './transaction-visibility.util'

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
 * on-chain recipient matches the configured company wallet, the transfer is
 * REAL USDT (the log's emitting contract is the USDT contract), AND
 * confirmations reach the threshold. Enforced in `submitDeposit` /
 * `getDepositStatus` via `EtherscanService.verifyDeposit`
 * (`toMatches` + `confirmed`). The on-chain SENDER is recorded for audit but is
 * NOT a gate (exchange withdrawals legitimately show the exchange's wallet).
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

  // HIGH-1 (security-review PR #438): the local `TX_HASH_RE` lived here and was
  // ONE of three different rules for "what is a hash" across the money paths.
  // It is gone — every path now calls `extractOnChainTxHash` from `@crm/shared`,
  // the same rule the consumed-hash registry and the Zod boundary use.

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
   * MED-J (security-review round 5) — a released transfer is being spent again
   * on the deposit path. Mirrors `TransactionsService.recordReclaimAfterRelease`;
   * the pair "released by an ADMIN → consumed again" is what an investigation
   * reconstructs, and only the second half shows up in the ledger.
   */
  private async recordReclaimAfterRelease(
    dbtx: DrizzleTx,
    params: { path: string; txHash: string; referenceId: string | null; actorId: string },
  ): Promise<void> {
    await dbtx.insert(transactionAuditLog).values({
      actorId: params.actorId,
      targetId: params.referenceId ?? params.actorId,
      action: 'ONCHAIN_HASH_RECLAIMED_AFTER_RELEASE',
      metadata: {
        path: params.path,
        txHash: normalizeOnChainTxHash(params.txHash),
        referenceId: params.referenceId,
      },
    })
    this.logger.warn(
      `[onchain-registry] previously RELEASED hash consumed again — ` +
        `path=${params.path} referenceId=${params.referenceId ?? 'none'} actorId=${params.actorId}.`,
    )
  }

  /**
   * POST /api/company-account/deposits — SENIOR/DROP submit a USDT deposit.
   *
   * Flow:
   *   1. Extract a tx hash from the input (bare hash OR Etherscan link).
   *   2. IDEMPOTENCY: if a COMPANY_DEPOSIT already exists for this hash, return
   *      it unchanged (no second row, balance never doubles).
   *   3. CROSS-PATH: reject a hash already consumed by a payout settlement.
   *   4. verifyDeposit against the configured wallet + threshold.
   *   5. Insert a COMPANY_DEPOSIT (stamping the observed on-chain sender) +
   *      claim the hash in `consumed_tx_hashes`, in ONE transaction: PAID iff
   *      (toMatches && confirmed), else PENDING. amount = verified amount
   *      (0 when unknown / pending).
   *
   * SECURITY: a mismatching recipient or a sub-threshold confirmation count
   * NEVER yields PAID — the deposit stays PENDING and contributes 0 to the
   * balance. The on-chain sender is RECORDED for audit but never gates the
   * credit (exchange withdrawals show the exchange's wallet).
   */
  async submitDeposit(
    input: { txHashOrLink: string },
    currentUser: SessionUser,
  ): Promise<CompanyDepositDto> {
    if (currentUser.role !== 'SENIOR' && currentUser.role !== 'DROP') {
      throw new ForbiddenException('Пополнять счёт компании могут SENIOR или DROP')
    }

    // HIGH-1 (security-review PR #438): the SHARED extractor — the same rule the
    // registry, the Zod write boundary and the payout paths use. Note it also
    // LOWERCASES, which the old local regex did not: a mixed-case hash used to
    // be stored (and idempotency-matched) verbatim while the registry stored the
    // lowercase form.
    const txHash = extractOnChainTxHash(input.txHashOrLink)
    if (!txHash) {
      throw new BadRequestException(
        'Не удалось извлечь hash транзакции (ожидается 0x + 64 hex или ссылка Etherscan)',
      )
    }

    const account = await this.getRow()

    // ── IDEMPOTENCY: return the existing deposit if this hash was already
    // submitted as a COMPANY_DEPOSIT (the partial unique index is the hard
    // backstop; this lookup avoids hitting it and returns the original row).
    // LOW (security-review round 2): match case-INSENSITIVELY. `txHash` is now
    // normalised to lowercase, but rows written before that (and any legacy
    // mixed-case hash) would miss this exact-match lookup and fall through to
    // the registry, where the user got a confusing «хеш уже использован» for
    // their OWN existing deposit. Idempotency must recognise the same transfer
    // regardless of the casing it was stored with.
    const existing = await this.db.db.query.transactions.findFirst({
      where: and(
        eq(transactions.type, 'COMPANY_DEPOSIT'),
        sql`lower(${transactions.txHash}) = ${txHash}`,
      ),
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

    const verification = await this.etherscan.verifyDeposit(
      txHash,
      account.walletAddress,
      account.confirmationThreshold,
    )

    // Credit (PAID + amount) ONLY when recipient matches, confirmed, AND a
    // positive amount resolved (M4). A confirmed-but-unknown-amount stays
    // PENDING and is resolved later by getDepositStatus re-polling.
    //
    // NOTE ON AMOUNTS (task-onchain-payment-integrity): the payout path demands
    // an EXACT amount because a payout carries a declared obligation to match.
    // A deposit declares no amount — it credits whatever the chain says landed
    // on the company wallet — so there is nothing to compare it to and no
    // tolerance to remove here. The deposit's protections are the recipient
    // match, the confirmation threshold, and the consumed-hash registry.
    const verifiedAmount = verification.amountUsdt ?? 0
    const credited = verification.toMatches && verification.confirmed && verifiedAmount > 0
    const amount = credited ? verifiedAmount : 0

    // WHO SENT IT — recorded, not enforced (task-onchain-payment-integrity).
    // A deposit from an exchange withdrawal legitimately shows the exchange's
    // hot wallet, so gating on the sender would reject honest top-ups; instead
    // the address is persisted and shown to ADMIN/ACCOUNTANT.
    const onChainFromAddress = normalizeEthAddress(verification.fromAddress)

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
            txFromAddress: onChainFromAddress,
            createdBy: currentUser.id,
          })
          .returning()

        // ── MED-3 (security-review PR #438): claim ONLY on an actual credit.
        // This used to run unconditionally, so an UNVERIFIED, uncredited PENDING
        // row still burned the hash system-wide. The company wallet address is
        // published to every payer, so any SENIOR/DROP could read a stranger's
        // incoming transfer off the explorer, submit its hash first, and — even
        // without ever crediting — leave the real payer unable to settle their
        // payout («хеш уже использован»). A claim now accompanies MONEY, not an
        // intent: a PENDING deposit blocks nothing outside its own table, and
        // the claim happens when `getDepositStatus` later flips it to PAID.
        if (settlementConsumesTransfer({ kind: 'COMPANY_DEPOSIT', credited })) {
          const claim = await consumeTxHash(dbtx, {
            txHash,
            purpose: 'COMPANY_DEPOSIT',
            referenceId: inserted!.id,
            consumedByUserId: currentUser.id,
          })
          if (claim.reclaimedAfterRelease) {
            await this.recordReclaimAfterRelease(dbtx, {
              path: 'submitDeposit',
              txHash,
              referenceId: inserted!.id,
              // security-review PR #456 (MED-2): impersonator-aware attribution —
              // consistent with every other transaction_audit_log write.
              actorId: currentUser.impersonatorId ?? currentUser.id,
            })
          }
        }

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
          where: and(
            eq(transactions.type, 'COMPANY_DEPOSIT'),
            sql`lower(${transactions.txHash}) = ${txHash}`,
          ),
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
    // security-review PR #456 round 2: fetch + visibility guard fused into
    // ONE expression via `assertFoundAndVisible` — round 1 had them as two
    // separate statements, and the round-2 review deleted just the guard
    // line (leaving the fetch and an explanatory comment behind) to prove no
    // scanner would notice. There is no longer a line to delete that removes
    // only the guard: the assignment IS the guard. An owner whose deposit
    // was soft-deleted gets the SAME 404 a stranger would, not a normal 200.
    const tx = assertFoundAndVisible(
      await this.db.db.query.transactions.findFirst({
        where: and(eq(transactions.id, id), eq(transactions.type, 'COMPANY_DEPOSIT')),
      }),
      currentUser,
    )

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

    // security-review PR #456 round 2 (MED): a deleted PENDING deposit is
    // only reachable here by ADMIN/ACCOUNTANT (assertFoundAndVisible above
    // already 404'd everyone else) — and the owner requirement is "видны
    // админу/бухгалтеру", i.e. they must get a REAL status back, not an
    // error. Round 1 threw `assertTransactionNotDeleted` unconditionally
    // here, which put a WRITE gate on a READ endpoint — ADMIN/ACCOUNTANT got
    // a 400 instead of a status. Fixed: only the MUTATING re-poll/flip is
    // skipped for a deleted row; the read itself always succeeds. No live
    // Etherscan call for a deleted row (nothing to progress toward), so
    // `confirmations` reports 0 — restore the deposit first to resume
    // live tracking.
    if (tx.deletedAt) {
      return {
        status: 'PENDING',
        confirmations: 0,
        threshold,
        amountUsdt: parseFloat(tx.amount),
      }
    }

    // PENDING (not deleted) → re-verify live.
    const verification = await this.etherscan.verifyDeposit(
      tx.txHash ?? '',
      account.walletAddress,
      threshold,
    )

    const resolvedAmount = verification.amountUsdt ?? parseFloat(tx.amount)
    if (verification.toMatches && verification.confirmed && resolvedAmount > 0) {
      // M4: only credit when a positive amount resolved; otherwise stay PENDING.
      // task-onchain-payment-integrity: this is the SECOND path that can flip a
      // deposit to PAID, so it also records the observed on-chain sender — a
      // deposit submitted before the tx was mined has no sender yet, and this
      // re-poll is where it becomes known. `?? tx.txFromAddress` keeps an
      // already-recorded value if the chain read came back empty.
      //
      // MED-3 (security-review PR #438): since `submitDeposit` now claims the
      // hash ONLY when it actually credits, THIS is where a poll-credited
      // deposit gets claimed — flip + claim in ONE transaction so the credit and
      // the registry entry cannot diverge.
      try {
        await this.db.db.transaction(async (dbtx) => {
          const flipped = await dbtx
            .update(transactions)
            .set({
              status: 'PAID',
              amount: String(resolvedAmount),
              txFromAddress: normalizeEthAddress(verification.fromAddress) ?? tx.txFromAddress,
              updatedAt: new Date(),
            })
            // LOW (review): re-assert PENDING in the WHERE so two concurrent
            // polls cannot both flip (and both claim) the same deposit — the
            // loser sees 0 rows and skips the claim.
            // security-review PR #456 (MED-1): also re-assert deleted_at IS
            // NULL — the in-memory `assertTransactionNotDeleted` check above
            // ran against a read from BEFORE this transaction opened; a
            // concurrent admin delete could still land in between. DB-level
            // recheck closes that window.
            .where(
              and(
                eq(transactions.id, tx.id),
                eq(transactions.status, 'PENDING'),
                isNull(transactions.deletedAt),
              ),
            )
            .returning({ id: transactions.id })

          if (flipped.length === 0) return // already credited (or deleted) by a concurrent call

          // `credited: true` — this branch IS the credit (the flip above).
          if (settlementConsumesTransfer({ kind: 'COMPANY_DEPOSIT', credited: true })) {
            const claim = await consumeTxHash(dbtx, {
              txHash: tx.txHash ?? '',
              purpose: 'COMPANY_DEPOSIT',
              referenceId: tx.id,
              consumedByUserId: tx.senderId,
            })
            if (claim.reclaimedAfterRelease) {
              await this.recordReclaimAfterRelease(dbtx, {
                path: 'getDepositStatus',
                txHash: tx.txHash ?? '',
                referenceId: tx.id,
                // security-review PR #456 (MED-2): impersonator-aware attribution.
                actorId: currentUser.impersonatorId ?? currentUser.id,
              })
            }
          }
        })
      } catch (err) {
        // The hash was claimed by another settlement (e.g. a payout) between
        // submit and this poll → the whole flip rolls back: the deposit stays
        // PENDING and uncredited, and the caller gets a clean 400 instead of a
        // 500 (never a silent credit without a registry entry).
        if (isUniqueViolation(err)) {
          throw new BadRequestException(TX_HASH_ALREADY_CONSUMED_MESSAGE)
        }
        throw err
      }
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
