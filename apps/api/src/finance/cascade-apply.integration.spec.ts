import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { MAKSYM_ID, roundShareAmount } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { PendingSettlementService } from './pending-settlement.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { sweepOrphanConsumedTxHashes } from './__test-helpers__/consumed-tx-hashes'
import { computeCompanyAccountBalanceFromLedger } from './company-account-balance'
import type { EtherscanService } from './etherscan.service'
import type { NbuCurrencyService } from './nbu-currency.service'
import {
  companyAccount,
  pendingObligations,
  projects,
  transactionAuditLog,
  transactions,
  users,
} from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * task-cascade-apply (task 3 of the paid-transaction-edit-cascade
 * decomposition) — the cascade against REAL Postgres.
 *
 * The unit double (`cascade-apply.unit.spec.ts`) proves WHICH writes the
 * service issues and in what order; the mutation gate can see that file. What
 * it cannot prove is that those writes land on the rows they name, that the
 * ledger formula reading them returns the right number, or that a column name
 * is spelled correctly. That is this file's job, and the mutation gate cannot
 * execute it at all (`.claude/rules/common/mutation-gate-integration-specs.md`)
 * — the two are complements, not duplicates.
 *
 * THE FIXTURE, and why it is shaped this way. The source income is declared to
 * an ADMIN PERSONALLY (`receiverId` = an admin, not the COMPANY_ACCOUNT
 * marker), so `funding_source` stays NULL and the source row sits in NO ledger
 * term. The SETTLE is still company-funded (a COMPANY-debt obligation defaults
 * to the shared account), so the derivative DOES enter term 7. That separation
 * is what lets the balance assertions below be exact equalities rather than
 * "equal after subtracting the income delta": editing the source amount moves
 * no ledger term, so any change in the balance is the cascade's doing and
 * nothing else.
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- cascade-apply.integration
 */

const SENIOR: SessionUser = {
  id: 'ca5cade0-0000-4000-bb00-000000000001',
  email: 'cascade-apply-senior@test.spec',
  displayName: 'Cascade Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const DROP: SessionUser = {
  ...SENIOR,
  id: 'ca5cade0-0000-4000-bb00-000000000002',
  email: 'cascade-apply-drop@test.spec',
  displayName: 'Cascade Drop',
  role: 'DROP',
}
const ADMIN: SessionUser = {
  ...SENIOR,
  id: MAKSYM_ID,
  email: 'cascade-apply-admin@test.spec',
  displayName: 'Cascade Admin',
  role: 'ADMIN',
  seniorSharePercent: 0,
}

/**
 * A SECOND admin partner (SR-M-5). Inside `ADMIN_PERSONAL` the funding source
 * is the same NULL for every admin, so telling two partners apart needs a
 * second real user row, not another funding option.
 */
const ADMIN_TWO: SessionUser = {
  ...SENIOR,
  id: 'ca5cade0-0000-4000-bb00-000000000003',
  email: 'cascade-apply-admin-two@test.spec',
  displayName: 'Cascade Admin Two',
  role: 'ADMIN',
  seniorSharePercent: 0,
}

const TEST_OWN_USER_IDS = [SENIOR.id, DROP.id, ADMIN_TWO.id]
const ACCOUNT_ID = 'ca5cade0-0000-4000-cc00-000000000001'
/** Senior only — one derivative per declare, so every assertion names one row. */
const PROJECT_SENIOR = 'ca5cade0-0000-4000-dd00-000000000001'
/** Senior + drop — two derivatives, for the "cascade does not multiply rows" case. */
const PROJECT_BOTH = 'ca5cade0-0000-4000-dd00-000000000002'
const DEPOSIT_LABEL = 'cascade-apply-spec-deposit'
const SENIOR_SHARE = 26
const DROP_SHARE = 5
const WALLET = '0xC0FFEE0000000000000000000000000000000abc'

const fakeNbu: Pick<NbuCurrencyService, 'getRates'> = {
  getRates: () =>
    Promise.resolve({ usdUah: '40.0000', usdtUah: '40.0000', eurUah: '44.0000', date: '20260823' }),
}
const fakeEtherscan = {
  verifyDeposit: () =>
    Promise.resolve({
      found: false,
      toMatches: false,
      confirmed: false,
      confirmations: 0,
      amountUsdt: null,
    }),
} as unknown as EtherscanService

/**
 * The invoice side is stubbed on purpose. `voidAndReissueInvoiceForAmountEdit`
 * has its own real-DB coverage in
 * `apps/api/src/invoices/invoice-signature-integrity.integration.spec.ts`
 * (PR #600) — what THIS task adds is the CALL, which is pinned, spy-and-all, in
 * `cascade-apply.unit.spec.ts` where the mutation gate can see it. Re-driving a
 * PDF/S3 round trip here would prove neither of those things again and would
 * couple a money test to object storage.
 */
const stubInvoices = {
  autoCreateForPayout: () => Promise.resolve(),
  autoCreateForSeniorPayout: () => Promise.resolve(),
  autoCreateForSalary: () => Promise.resolve(),
  voidAndReissueInvoiceForAmountEdit: () => Promise.resolve(),
} as never
const stubDocuments = {} as never

let _pool: Pool | null = null

@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (): DatabaseService => {
        _pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
        const db = drizzle(_pool, { schema })
        const instance = Object.create(DatabaseService.prototype) as DatabaseService
        Object.assign(instance, { pool: _pool, db })
        Object.defineProperty(instance, 'onModuleInit', {
          value: () => Promise.resolve(),
          writable: false,
          enumerable: false,
          configurable: true,
        })
        Object.defineProperty(instance, 'onModuleDestroy', {
          value: () => _pool?.end() ?? Promise.resolve(),
          writable: false,
          enumerable: false,
          configurable: true,
        })
        return instance
      },
    },
  ],
  exports: [DatabaseService],
})
class TestDatabaseModule {}

@Module({
  imports: [TestDatabaseModule],
  providers: [
    {
      provide: TransactionsService,
      useFactory: (db: DatabaseService) =>
        makeTransactionsService({
          db,
          invoicesService: stubInvoices,
          documentsService: stubDocuments,
          nbuCurrencyService: fakeNbu as NbuCurrencyService,
          etherscanService: fakeEtherscan,
        }),
      inject: [DatabaseService],
    },
    {
      provide: PendingSettlementService,
      useFactory: (db: DatabaseService) =>
        new PendingSettlementService(db, stubInvoices as never, fakeNbu as NbuCurrencyService),
      inject: [DatabaseService],
    },
  ],
})
class CascadeApplyTestModule {}

describe.skipIf(!hasDatabaseUrl())('task-cascade-apply — the cascade against real Postgres', () => {
  let svc: TransactionsService
  let settleSvc: PendingSettlementService
  let dbSvc: DatabaseService

  function declare(projectId: string, amount: number) {
    return svc.declareUsdtProjectIncome(
      {
        projectId,
        amount,
        // An ADMIN personally, NOT the company pool — see the file header for
        // why that keeps the balance assertions exact.
        receiverId: ADMIN.id,
        idempotencyKey: randomUUID(),
        receiptExternalUrl: `https://etherscan.io/tx/0x${randomUUID().replace(/-/g, '')}`,
      },
      ADMIN,
    )
  }

  async function sourceIncome(projectId: string) {
    const row = await dbSvc.db.query.transactions.findFirst({
      where: and(eq(transactions.projectId, projectId), eq(transactions.type, 'ADMIN_INCOME')),
    })
    if (!row) throw new Error('no source income row')
    return row
  }

  async function derivativeFor(creditorId: string) {
    const obligation = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.creditorUserId, creditorId),
    })
    if (!obligation) throw new Error(`no obligation for creditor ${creditorId}`)
    const row = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, obligation.sourceTransactionId),
    })
    if (!row) throw new Error('no derivative row for the obligation')
    return { obligation, row }
  }

  const balance = () => computeCompanyAccountBalanceFromLedger(dbSvc.db)

  /** Preview + apply, the way the UI will: the token always comes from the preview. */
  async function editWithPreview(sourceId: string, newAmount: number) {
    const preview = await svc.getEditCascadePreview(sourceId, newAmount, ADMIN)
    await svc.adminUpdateTransaction(
      sourceId,
      { amount: newAmount, cascadeVersion: preview.version! },
      ADMIN,
    )
    return preview
  }

  async function journalFor(targetId: string, action: string) {
    return dbSvc.db.query.transactionAuditLog.findMany({
      where: and(
        eq(transactionAuditLog.targetId, targetId),
        eq(transactionAuditLog.action, action),
      ),
    })
  }

  async function clearLedger() {
    await dbSvc.db
      .delete(pendingObligations)
      .where(inArray(pendingObligations.creditorUserId, TEST_OWN_USER_IDS))
    await dbSvc.db
      .delete(transactions)
      .where(inArray(transactions.projectId, [PROJECT_SENIOR, PROJECT_BOTH]))
    await dbSvc.db.delete(transactions).where(eq(transactions.senderLabel, DEPOSIT_LABEL))
    await sweepOrphanConsumedTxHashes(dbSvc)
  }

  beforeAll(async () => {
    const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const which = await probe.query('SELECT current_database() AS db')
    if (which.rows[0]?.db === 'crm_db') {
      await probe.end()
      throw new Error('[cascade-apply] REFUSING to run against the live crm_db')
    }
    const check = await probe.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='transactions' AND column_name='settled_amount' LIMIT 1`,
    )
    await probe.end()
    if (check.rowCount === 0) {
      throw new Error(
        '[cascade-apply] FAILED — schema not migrated (no transactions.settled_amount)',
      )
    }

    const moduleRef = await Test.createTestingModule({
      imports: [CascadeApplyTestModule],
    }).compile()
    await moduleRef.init()
    svc = moduleRef.get(TransactionsService)
    settleSvc = moduleRef.get(PendingSettlementService)
    dbSvc = moduleRef.get(DatabaseService)

    const db = dbSvc.db
    await clearLedger()
    await db.delete(projects).where(inArray(projects.id, [PROJECT_SENIOR, PROJECT_BOTH]))
    await db.delete(users).where(inArray(users.id, TEST_OWN_USER_IDS))
    await db
      .insert(users)
      .values([
        {
          id: SENIOR.id,
          email: SENIOR.email,
          displayName: SENIOR.displayName,
          role: SENIOR.role,
          seniorSharePercent: SENIOR_SHARE,
          googleId: `test-google-${SENIOR.id}`,
        },
        {
          id: DROP.id,
          email: DROP.email,
          displayName: DROP.displayName,
          role: DROP.role,
          dropSharePercent: DROP_SHARE,
          googleId: `test-google-${DROP.id}`,
        },
        {
          id: ADMIN.id,
          email: ADMIN.email,
          displayName: ADMIN.displayName,
          role: ADMIN.role,
          seniorSharePercent: 0,
          googleId: `test-google-${ADMIN.id}`,
        },
        {
          id: ADMIN_TWO.id,
          email: ADMIN_TWO.email,
          displayName: ADMIN_TWO.displayName,
          role: ADMIN_TWO.role,
          seniorSharePercent: 0,
          googleId: `test-google-${ADMIN_TWO.id}`,
        },
      ])
      .onConflictDoNothing()
    await db
      .insert(projects)
      .values([
        {
          id: PROJECT_SENIOR,
          name: 'Cascade Apply Senior Project',
          companyName: 'Cascade Co',
          domain: 'fintech',
          startDate: new Date('2025-01-01'),
          seniorId: SENIOR.id,
          currency: 'USDT',
          rate: 1000,
          paymentType: 'USDT',
        },
        {
          id: PROJECT_BOTH,
          name: 'Cascade Apply Senior+Drop Project',
          companyName: 'Cascade Co',
          domain: 'fintech',
          startDate: new Date('2025-01-01'),
          seniorId: SENIOR.id,
          dropId: DROP.id,
          currency: 'USDT',
          rate: 1000,
          paymentType: 'USDT',
        },
      ])
      .onConflictDoNothing()

    const existing = await db.query.companyAccount.findFirst()
    if (!existing) {
      await db.insert(companyAccount).values({ id: ACCOUNT_ID, walletAddress: WALLET })
    } else {
      await db.update(companyAccount).set({ walletAddress: WALLET })
    }
  })

  beforeEach(async () => {
    await clearLedger()
    await dbSvc.db.insert(transactions).values({
      type: 'COMPANY_DEPOSIT',
      status: 'PAID',
      amount: '100000',
      currency: 'USDT',
      senderLabel: DEPOSIT_LABEL,
      createdBy: MAKSYM_ID,
    })
  })

  afterAll(async () => {
    if (dbSvc) {
      await clearLedger()
      await dbSvc.db.delete(projects).where(inArray(projects.id, [PROJECT_SENIOR, PROJECT_BOTH]))
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_OWN_USER_IDS))
    }
    if (_pool) await _pool.end()
  })

  // ── risk 1 / risk 2 — preview equals fact, and both copies move together ──

  it('risk 1: what the preview promised is exactly what the database ends up holding', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const source = await sourceIncome(PROJECT_SENIOR)

    const preview = await svc.getEditCascadePreview(source.id, 2500, ADMIN)
    const promised = preview.plan!.derivatives
    expect(promised).toHaveLength(1)

    await svc.adminUpdateTransaction(
      source.id,
      { amount: 2500, cascadeVersion: preview.version! },
      ADMIN,
    )

    // The WHOLE structure, field by field — "both have one row" passes even
    // when the sums are swapped (ADR AC6 risk 1).
    const { obligation, row } = await derivativeFor(SENIOR.id)
    const plan = promised[0]!
    expect(row.id).toBe(plan.id)
    expect(parseFloat(row.amount)).toBeCloseTo(plan.newAmount!, 6)
    expect(parseFloat(obligation.amount)).toBeCloseTo(plan.newAmount!, 6)
    expect(row.status).toBe('PENDING_PAYMENT')
    expect(row.type).toBe('SENIOR_PENDING_PAYOUT')
    expect(row.seniorSharePercent).toBe(plan.sharePercent)
    expect(obligation.status).toBe('PENDING')
  })

  it('risk 2: BOTH directions of the symmetric invariant hold after the cascade', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const source = await sourceIncome(PROJECT_SENIOR)
    await editWithPreview(source.id, 2500)

    const { obligation, row } = await derivativeFor(SENIOR.id)
    // Direction 1: the two stored copies agree with each other.
    expect(row.amount).toBe(obligation.amount)
    // Direction 2: and they agree with the share recomputed from the NEW
    // income — a one-sided check passes even when both copies are wrong
    // together (ADR AC6 risk 2).
    expect(parseFloat(obligation.amount)).toBeCloseTo(roundShareAmount(2500, SENIOR_SHARE), 6)
  })

  // ── risk 4 — the one no gate catches ────────────────────────────────────

  it('risk 4: reverting a settled derivative leaves the company balance EXACTLY where it was', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const { obligation } = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(obligation.id, ADMIN)

    const before = await balance()
    const source = await sourceIncome(PROJECT_SENIOR)
    await editWithPreview(source.id, 2500)

    const after = await balance()
    // The debit term 7 loses is precisely what term 9 gives back. WITHOUT the
    // ninth term this reads `before + 260`: the account would appear to hold
    // money that has already left it, and the money gates read this number.
    expect(after).toBeCloseTo(before, 6)
  })

  it('risk 4 (the row itself): a reverted derivative keeps its funding marker and its accumulator', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const { obligation } = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(obligation.id, ADMIN)
    const settled = (await derivativeFor(SENIOR.id)).row
    expect(settled.fundingSource).toBe('COMPANY_ACCOUNT')

    const source = await sourceIncome(PROJECT_SENIOR)
    await editWithPreview(source.id, 2500)

    const reverted = (await derivativeFor(SENIOR.id)).row
    // Both are what term 9 is computed FROM — erasing either makes the
    // compensation silently disappear.
    expect(reverted.fundingSource).toBe('COMPANY_ACCOUNT')
    expect(parseFloat(reverted.settledAmount!)).toBeCloseTo(roundShareAmount(1000, SENIOR_SHARE), 6)
    expect(reverted.settledCurrency).toBe('USDT')
    // And the proof that a payment happened is untouched.
    expect(reverted.validatedBy).not.toBeNull()
  })

  // ── risk 5 — the percent snapshot survives the round trip ───────────────

  it('risk 5: the percent lands back in the LIVE column, so the NEXT preview can still recompute', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const { obligation } = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(obligation.id, ADMIN)

    const settled = (await derivativeFor(SENIOR.id)).row
    expect(settled.seniorSharePercent).toBeNull() // the flip nulled it
    expect(settled.settledSharePercent).toBe(SENIOR_SHARE) // …into the snapshot

    const source = await sourceIncome(PROJECT_SENIOR)
    await editWithPreview(source.id, 2500)

    const reverted = (await derivativeFor(SENIOR.id)).row
    expect(reverted.seniorSharePercent).toBe(SENIOR_SHARE)
    expect(reverted.settledSharePercent).toBe(SENIOR_SHARE) // the snapshot is NOT disturbed
    expect(reverted.seniorSharePercentSource).toBeNull() // never invented

    // The real proof: a SECOND preview can still price the row. Leaving the
    // live column null makes this come back NO_SHARE_SNAPSHOT / newAmount null
    // — a row the revert itself made un-editable.
    const second = await svc.getEditCascadePreview(source.id, 4000, ADMIN)
    const plan = second.plan!.derivatives[0]!
    expect(plan.newAmount).not.toBeNull()
    expect(plan.newAmount).toBeCloseTo(roundShareAmount(4000, SENIOR_SHARE), 6)
  })

  // ── risk 6 — the accumulator across a full edit/top-up chain ────────────

  it('risk 6: settle → edit up → top up → edit up → top up keeps the accumulator monotonic and equal to the amount', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const source = await sourceIncome(PROJECT_SENIOR)
    const first = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(first.obligation.id, ADMIN)

    const afterFirstSettle = (await derivativeFor(SENIOR.id)).row
    const settled1 = parseFloat(afterFirstSettle.settledAmount!)
    expect(settled1).toBeCloseTo(roundShareAmount(1000, SENIOR_SHARE), 6)
    // The invariant term 9 rests on, checked rather than assumed.
    expect(parseFloat(afterFirstSettle.amount)).toBeCloseTo(settled1, 6)

    // Round 2 — income up, revert, top up.
    const preview2 = await editWithPreview(source.id, 2000)
    const owed2 = preview2.plan!.derivatives[0]!.remainingToPay!
    const balanceBeforeTopUp2 = await balance()
    const second = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(second.obligation.id, ADMIN)
    const afterSecondSettle = (await derivativeFor(SENIOR.id)).row
    const settled2 = parseFloat(afterSecondSettle.settledAmount!)

    expect(settled2).toBeGreaterThan(settled1) // strictly monotonic
    expect(parseFloat(afterSecondSettle.amount)).toBeCloseTo(settled2, 6)
    // "К доплате" as shown is what actually left the account.
    expect(balanceBeforeTopUp2 - (await balance())).toBeCloseTo(owed2, 6)

    // Round 3 — again, from a row that has now been settled twice.
    const preview3 = await editWithPreview(source.id, 4500)
    const owed3 = preview3.plan!.derivatives[0]!.remainingToPay!
    const balanceBeforeTopUp3 = await balance()
    const third = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(third.obligation.id, ADMIN)
    const afterThirdSettle = (await derivativeFor(SENIOR.id)).row
    const settled3 = parseFloat(afterThirdSettle.settledAmount!)

    expect(settled3).toBeGreaterThan(settled2)
    expect(parseFloat(afterThirdSettle.amount)).toBeCloseTo(settled3, 6)
    expect(settled3).toBeCloseTo(roundShareAmount(4500, SENIOR_SHARE), 6)
    expect(balanceBeforeTopUp3 - (await balance())).toBeCloseTo(owed3, 6)
  })

  it('risk 6 (the "pay it all again" bug): a top-up debits only the remainder', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const source = await sourceIncome(PROJECT_SENIOR)
    await settleSvc.settleByCompany((await derivativeFor(SENIOR.id)).obligation.id, ADMIN)
    await editWithPreview(source.id, 2000)

    const before = await balance()
    await settleSvc.settleByCompany((await derivativeFor(SENIOR.id)).obligation.id, ADMIN)
    const debited = before - (await balance())

    // 26% of 2000 = 520, of which 260 was already paid → 260 remains. Paying
    // the full 520 again would double the senior's money and drive the
    // accumulator to 780.
    expect(debited).toBeCloseTo(260, 6)
  })

  // ── risk 7 — the preview↔settle race ────────────────────────────────────

  it('risk 7: a settle landing between preview and save turns the save into a 409, writing nothing', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const source = await sourceIncome(PROJECT_SENIOR)
    const stale = await svc.getEditCascadePreview(source.id, 2500, ADMIN)

    // Another session closes the obligation after the preview was taken.
    await settleSvc.settleByCompany((await derivativeFor(SENIOR.id)).obligation.id, ADMIN)

    const beforeRows = await derivativeFor(SENIOR.id)
    const beforeSource = await sourceIncome(PROJECT_SENIOR)

    await expect(
      svc.adminUpdateTransaction(
        source.id,
        { amount: 2500, cascadeVersion: stale.version! },
        ADMIN,
      ),
    ).rejects.toThrow(/обновите предпросмотр/)

    // Not one row moved — including the SOURCE, whose own edit is inside the
    // same transaction.
    const afterRows = await derivativeFor(SENIOR.id)
    expect(afterRows.row.amount).toBe(beforeRows.row.amount)
    expect(afterRows.row.status).toBe(beforeRows.row.status)
    expect(afterRows.obligation.amount).toBe(beforeRows.obligation.amount)
    expect(afterRows.obligation.status).toBe(beforeRows.obligation.status)
    expect((await sourceIncome(PROJECT_SENIOR)).amount).toBe(beforeSource.amount)
  })

  // ── risk 9 — the journal, field by field ────────────────────────────────

  it('risk 9: a revert writes CASCADE_REOPEN against the DERIVATIVE with every field filled', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const { obligation } = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(obligation.id, ADMIN)
    const source = await sourceIncome(PROJECT_SENIOR)
    const preview = await editWithPreview(source.id, 2500)
    const derivativeId = preview.plan!.derivatives[0]!.id

    const entries = await journalFor(derivativeId, 'CASCADE_REOPEN')
    expect(entries).toHaveLength(1)
    const meta = entries[0]!.metadata as Record<string, unknown>
    expect(meta['obligationId']).toBe(obligation.id)
    expect(meta['causedBy']).toBe(source.id)
    expect(meta['settledAmount']).toBeCloseTo(roundShareAmount(1000, SENIOR_SHARE), 6)
    expect(meta['sharePercent']).toBe(SENIOR_SHARE)
    expect(meta['before']).toMatchObject({ type: 'SENIOR_INCOME', status: 'PAID' })
    expect(meta['after']).toMatchObject({
      type: 'SENIOR_PENDING_PAYOUT',
      status: 'PENDING_PAYMENT',
    })
    // The SOURCE keeps its own, separate entry — one journal line per cascade
    // would lose which row moved.
    expect(await journalFor(source.id, 'AMOUNT_OR_RECEIVER_CHANGE')).toHaveLength(1)
    expect(await journalFor(source.id, 'CASCADE_REOPEN')).toHaveLength(0)
  })

  it('risk 9: an open obligation writes CASCADE_AMOUNT_UPDATE, not a REOPEN', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const source = await sourceIncome(PROJECT_SENIOR)
    const preview = await editWithPreview(source.id, 2500)
    const derivativeId = preview.plan!.derivatives[0]!.id

    const entries = await journalFor(derivativeId, 'CASCADE_AMOUNT_UPDATE')
    expect(entries).toHaveLength(1)
    const meta = entries[0]!.metadata as Record<string, unknown>
    expect(meta['causedBy']).toBe(source.id)
    expect(meta['settledAmount']).toBe(0)
    expect(meta['amount']).toMatchObject({ before: roundShareAmount(1000, SENIOR_SHARE) })
    expect(await journalFor(derivativeId, 'CASCADE_REOPEN')).toHaveLength(0)
  })

  // ── risk 10 — the currency lock survives the BIZ-18 narrowing ───────────

  it('risk 10: currency on a PAID row is still refused, and the ledger keeps working afterwards', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const source = await sourceIncome(PROJECT_SENIOR)
    await settleSvc.settleByCompany((await derivativeFor(SENIOR.id)).obligation.id, ADMIN)

    await expect(svc.adminUpdateTransaction(source.id, { currency: 'EUR' }, ADMIN)).rejects.toThrow(
      /currency or salary month/,
    )

    expect((await sourceIncome(PROJECT_SENIOR)).currency).toBe('USDT')
    // The point of the refusal: one off-currency company row makes this throw,
    // and four money gates hang off it.
    await expect(balance()).resolves.toEqual(expect.any(Number))
  })

  // ── risk 11 — the cascade updates rows, never adds them ─────────────────

  it('risk 11: two edits in a row do not multiply the derivatives (senior + drop)', async () => {
    await declare(PROJECT_BOTH, 1000)
    const source = await sourceIncome(PROJECT_BOTH)

    const countDerivatives = async () =>
      (
        await dbSvc.db.query.transactions.findMany({
          where: eq(transactions.sourceIncomeTransactionId, source.id),
        })
      ).length
    const countObligations = async () =>
      (
        await dbSvc.db.query.pendingObligations.findMany({
          where: inArray(pendingObligations.creditorUserId, TEST_OWN_USER_IDS),
        })
      ).length

    expect(await countDerivatives()).toBe(2)
    await editWithPreview(source.id, 2000)
    expect(await countDerivatives()).toBe(2)
    expect(await countObligations()).toBe(2)
    await editWithPreview(source.id, 3000)
    expect(await countDerivatives()).toBe(2)
    expect(await countObligations()).toBe(2)
  })

  // ── risk 15 — the obligation's currency is checked, not assumed ─────────

  it('risk 15: an obligation booked in another currency refuses the edit and leaves everything alone', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const source = await sourceIncome(PROJECT_SENIOR)
    const { obligation } = await derivativeFor(SENIOR.id)
    // The only way to reach this state today is by hand — which is the point:
    // the guard is a trap for a future write path, and it has to actually
    // work against real rows, not just compile.
    await dbSvc.db
      .update(pendingObligations)
      .set({ currency: 'EUR' })
      .where(eq(pendingObligations.id, obligation.id))

    const preview = await svc.getEditCascadePreview(source.id, 2500, ADMIN)
    expect(preview.plan!.derivatives[0]!.warnings.map((w) => w.code)).toContain(
      'OBLIGATION_CURRENCY_MISMATCH',
    )

    await expect(
      svc.adminUpdateTransaction(
        source.id,
        { amount: 2500, cascadeVersion: preview.version! },
        ADMIN,
      ),
    ).rejects.toThrow(/валют/)

    const after = await derivativeFor(SENIOR.id)
    expect(after.row.amount).toBe((await derivativeFor(SENIOR.id)).row.amount)
    expect(parseFloat(after.obligation.amount)).toBeCloseTo(roundShareAmount(1000, SENIOR_SHARE), 6)
    expect((await sourceIncome(PROJECT_SENIOR)).amount).toBe(source.amount)
  })

  // ── risk 16 — the overpayment branch writes nothing ─────────────────────

  it('risk 16: cutting the income below what was already paid leaves the row PAID and the balance untouched', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const { obligation } = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(obligation.id, ADMIN)
    const paid = (await derivativeFor(SENIOR.id)).row
    const paidAmount = paid.amount

    const before = await balance()
    const source = await sourceIncome(PROJECT_SENIOR)
    await editWithPreview(source.id, 100) // new share 26, far below the 260 paid

    const after = await derivativeFor(SENIOR.id)
    // The row keeps counting in term 7 for the figure that actually left.
    expect(after.row.status).toBe('PAID')
    expect(after.row.type).toBe('SENIOR_INCOME')
    expect(after.row.amount).toBe(paidAmount)
    expect(after.obligation.status).toBe('PAID')
    expect(after.obligation.amount).toBe(obligation.amount)
    // Writing the smaller share would give the company back money it spent.
    expect(await balance()).toBeCloseTo(before, 6)

    const entries = await journalFor(after.row.id, 'CASCADE_OVERPAYMENT')
    expect(entries).toHaveLength(1)
    const meta = entries[0]!.metadata as Record<string, unknown>
    expect(meta['overpaidBy']).toBeCloseTo(260 - 26, 6)
  })

  // ── risk 17b — the invariant, on real rows ──────────────────────────────

  it('risk 17b: a company-funded row whose amount and accumulator disagree is refused, and nothing moves', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const { obligation } = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(obligation.id, ADMIN)

    // The shape a row edited BEFORE #598 can have: the two figures drifted
    // apart and nothing noticed. Produced here by hand because no current code
    // path produces it — which is exactly why the check is a check and not an
    // assumption.
    const settledRow = (await derivativeFor(SENIOR.id)).row
    await dbSvc.db
      .update(transactions)
      .set({ amount: '999.000000' })
      .where(eq(transactions.id, settledRow.id))

    const before = await balance()
    const source = await sourceIncome(PROJECT_SENIOR)
    const preview = await svc.getEditCascadePreview(source.id, 5000, ADMIN)

    await expect(
      svc.adminUpdateTransaction(
        source.id,
        { amount: 5000, cascadeVersion: preview.version! },
        ADMIN,
      ),
    ).rejects.toThrow(/settled_amount/)

    const after = await derivativeFor(SENIOR.id)
    expect(after.row.amount).toBe('999.000000')
    expect(after.row.status).toBe('PAID')
    expect(after.obligation.status).toBe('PAID')
    expect((await sourceIncome(PROJECT_SENIOR)).amount).toBe(source.amount)
    expect(await balance()).toBeCloseTo(before, 6)
  })

  it('risk 17b (mirror): the same row with the two figures AGREEING is reverted normally', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const { obligation } = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(obligation.id, ADMIN)

    const source = await sourceIncome(PROJECT_SENIOR)
    await editWithPreview(source.id, 5000)

    const after = await derivativeFor(SENIOR.id)
    expect(after.row.status).toBe('PENDING_PAYMENT')
    expect(after.obligation.status).toBe('PENDING')
  })

  // ── AC12 — a no-op edit is a no-op ──────────────────────────────────────

  it('AC12: re-saving the same amount runs no cascade and writes no journal line', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const source = await sourceIncome(PROJECT_SENIOR)
    const beforeDerivative = (await derivativeFor(SENIOR.id)).row

    await svc.adminUpdateTransaction(source.id, { amount: 1000 }, ADMIN)

    const afterDerivative = (await derivativeFor(SENIOR.id)).row
    expect(afterDerivative.updatedAt.getTime()).toBe(beforeDerivative.updatedAt.getTime())
    expect(await journalFor(source.id, 'AMOUNT_OR_RECEIVER_CHANGE')).toHaveLength(0)
    expect(await journalFor(afterDerivative.id, 'CASCADE_AMOUNT_UPDATE')).toHaveLength(0)
  })

  // ── risk 18 — the edited row is itself a ledger fact (SR-H-1) ───────────

  it('risk 18: editing the settled derivative ITSELF is refused, and the balance does not move', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const { obligation } = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(obligation.id, ADMIN)

    const settled = (await derivativeFor(SENIOR.id)).row
    // The shape that made this reachable, asserted rather than assumed — if
    // the flip ever starts stamping either field, this test would silently
    // stop covering the hole it was written for.
    expect(settled.type).toBe('SENIOR_INCOME')
    expect(settled.status).toBe('PAID')
    expect(settled.originalAmount).toBeNull() // the C2 guard cannot see it
    expect(settled.payoutRequestId).toBeNull() // guard 2 cannot see it
    expect(settled.fundingSource).toBe('COMPANY_ACCOUNT') // …and term 7 debits it

    const before = await balance()
    // CR-M-1: the preview now refuses it too, and hands out no token for a row
    // it will not let be saved. The write is asked with a placeholder anyway —
    // AC13 is checked BEFORE the version comparison precisely so the operator
    // hears "this row is not editable" rather than "your preview is stale".
    const preview = await svc.getEditCascadePreview(settled.id, 26, ADMIN)
    expect(preview.blockedReason).toBe('SETTLED_AMOUNT_RECORDED')
    expect(preview.version).toBeNull()
    await expect(
      svc.adminUpdateTransaction(
        settled.id,
        { amount: 26, cascadeVersion: 'no-such-version' },
        ADMIN,
      ),
    ).rejects.toThrow(/подтверждена фактическими выплатами/)

    // Without AC13 the edit lands, term 7's debit drops 260 → 26, and the
    // balance rises by 234 — money the company has already paid out.
    expect((await derivativeFor(SENIOR.id)).row.amount).toBe(settled.amount)
    expect(await balance()).toBeCloseTo(before, 6)
  })

  it('risk 18: a company deposit cannot have its amount edited either', async () => {
    const deposit = await dbSvc.db.query.transactions.findFirst({
      where: and(
        eq(transactions.senderLabel, DEPOSIT_LABEL),
        eq(transactions.type, 'COMPANY_DEPOSIT'),
      ),
    })
    const preview = await svc.getEditCascadePreview(deposit!.id, 42, ADMIN)
    expect(preview.blockedReason).toBe('ONCHAIN_DEPOSIT')
    await expect(
      svc.adminUpdateTransaction(
        deposit!.id,
        { amount: 42, cascadeVersion: 'no-such-version' },
        ADMIN,
      ),
    ).rejects.toThrow(/сверена с блокчейном/)
  })

  it('risk 22 (SR-H-3): a row that closed an obligation in the PRE-flip epoch is refused too', async () => {
    // The legacy shape, built by hand because no code path produces it any
    // more. Before the settle-in-place ADR (2026-07-14) closing an obligation
    // INSERTED a second transaction: the obligation kept
    // `source_transaction_id` on the still-hanging IOU and got
    // `closing_transaction_id` pointing at the new row. That new row is the
    // one standing in ledger term 7 — and the one an admin would edit.
    //
    // All three sibling predicates are structurally empty for this population:
    // `original_amount` (2026-08-05) and `settled_amount` (2026-08-22) were
    // both added "no backfill by design", and the row carries no payout
    // request. So before the `closing_transaction_id` disjunct it passed every
    // check and the 260 USDT debit could be edited down to nothing.
    await declare(PROJECT_SENIOR, 1000)
    const { obligation, row: iou } = await derivativeFor(SENIOR.id)

    const [closingRow] = await dbSvc.db
      .insert(transactions)
      .values({
        type: 'SENIOR_INCOME',
        status: 'PAID',
        amount: '260.000000',
        currency: 'USDT',
        receiverId: SENIOR.id,
        fundingSource: 'COMPANY_ACCOUNT',
        sourceIncomeTransactionId: iou.sourceIncomeTransactionId,
        projectId: PROJECT_SENIOR,
        createdBy: MAKSYM_ID,
        // Deliberately NOT set: this is the pre-#599 epoch.
        settledAmount: null,
        originalAmount: null,
      })
      .returning()
    await dbSvc.db
      .update(pendingObligations)
      .set({ status: 'PAID', closingTransactionId: closingRow!.id })
      .where(eq(pendingObligations.id, obligation.id))

    // The obligation is closed, but NOT by the row it points at as source.
    const legacy = await dbSvc.db.query.pendingObligations.findFirst({
      where: eq(pendingObligations.id, obligation.id),
    })
    expect(legacy!.sourceTransactionId).not.toBe(closingRow!.id)
    expect(legacy!.closingTransactionId).toBe(closingRow!.id)

    const before = await balance()
    const preview = await svc.getEditCascadePreview(closingRow!.id, 26, ADMIN)
    expect(preview.blockedReason).toBe('CLOSES_OBLIGATION')
    await expect(
      svc.adminUpdateTransaction(
        closingRow!.id,
        { amount: 26, cascadeVersion: 'no-such-version' },
        ADMIN,
      ),
    ).rejects.toThrow(/закрытым обязательством/)

    // Without the disjunct the edit lands, term 7's debit falls 260 → 26 and
    // the balance rises by 234 that has already left the account.
    const after = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, closingRow!.id),
    })
    expect(after!.amount).toBe('260.000000')
    expect(await balance()).toBeCloseTo(before, 6)
  })

  it('risk 18 (the negative): the ordinary income edit this whole task exists for still works', async () => {
    // AC13 must not "finish the job" on ADMIN_INCOME — it has no second
    // carrier of the amount, so an edit there means "we wrote the wrong
    // number" and the ledger is obliged to follow.
    await declare(PROJECT_SENIOR, 1000)
    const source = await sourceIncome(PROJECT_SENIOR)
    await expect(editWithPreview(source.id, 2500)).resolves.toBeDefined()
    expect((await sourceIncome(PROJECT_SENIOR)).amount).toBe('2500.000000')
  })

  // ── risk 19 / 19b — the top-up must come from the same pot (SR-H-2) ─────

  it('risk 19: a personal-account top-up on a company-paid row is refused, all in USDT', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const first = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(first.obligation.id, ADMIN)
    const source = await sourceIncome(PROJECT_SENIOR)
    await editWithPreview(source.id, 2000) // revert; term 9 now holds the 260

    const reopened = await derivativeFor(SENIOR.id)
    const before = await balance()
    await expect(
      settleSvc.settleByCompany(reopened.obligation.id, ADMIN, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN.id,
        currency: 'USDT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xcascadetopup',
      }),
    ).rejects.toThrow(/Доплата обязана идти из того же источника/)

    // Nothing moved. Without the guard the row would have dropped out of term
    // 7 (funding_source no longer COMPANY_ACCOUNT) AND out of term 9 (status
    // no longer PENDING_PAYMENT) — 260 USDT gone from the ledger.
    expect(await balance()).toBeCloseTo(before, 6)
    expect((await derivativeFor(SENIOR.id)).obligation.status).toBe('PENDING')
  })

  it('risk 19 (control): the same top-up FROM the company account is allowed and debits exactly the remainder', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const first = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(first.obligation.id, ADMIN)
    const source = await sourceIncome(PROJECT_SENIOR)
    const preview = await editWithPreview(source.id, 2000)
    const owed = preview.plan!.derivatives[0]!.remainingToPay!

    const before = await balance()
    const reopened = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(reopened.obligation.id, ADMIN)

    expect(before - (await balance())).toBeCloseTo(owed, 6)
    expect((await derivativeFor(SENIOR.id)).row.fundingSource).toBe('COMPANY_ACCOUNT')
  })

  it('risk 19b: the mirror order is refused too — a company top-up on an admin-paid row', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const first = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(first.obligation.id, ADMIN, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN.id,
      currency: 'USDT',
      receiptExternalUrl: 'https://etherscan.io/tx/0xadminfirst',
    })
    const source = await sourceIncome(PROJECT_SENIOR)
    await editWithPreview(source.id, 2000)

    const reopened = await derivativeFor(SENIOR.id)
    await expect(settleSvc.settleByCompany(reopened.obligation.id, ADMIN)).rejects.toThrow(
      /Доплата обязана идти из того же источника/,
    )
  })

  it('risk 23 (SR-M-5): a top-up by a DIFFERENT admin partner is refused, same pot or not', async () => {
    // Both settles are `ADMIN_PERSONAL`, so `funding_source` is NULL on both
    // sides and the pot comparison sees nothing wrong. What differs is the
    // PERSON: the flip overwrites `sender_id`, and `adminBalances.sent` sums
    // the row's whole `amount` under whoever holds it — so admin one's 260
    // would silently become admin two's.
    await declare(PROJECT_SENIOR, 1000)
    const first = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(first.obligation.id, ADMIN, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN.id,
      currency: 'USDT',
      receiptExternalUrl: 'https://etherscan.io/tx/0xadminone',
    })
    const paid = (await derivativeFor(SENIOR.id)).row
    expect(paid.senderId).toBe(ADMIN.id)
    expect(paid.fundingSource).toBeNull() // the pot check is blind here

    const source = await sourceIncome(PROJECT_SENIOR)
    await editWithPreview(source.id, 2000)

    // The revert must have PRESERVED the payer — that is what makes the
    // comparison possible at all (AC6).
    const reopened = await derivativeFor(SENIOR.id)
    expect(reopened.row.senderId).toBe(ADMIN.id)

    await expect(
      settleSvc.settleByCompany(reopened.obligation.id, ADMIN_TWO, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_TWO.id,
        currency: 'USDT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xadmintwo',
      }),
    ).rejects.toThrow(/Доплата обязана идти из того же источника/)

    expect((await derivativeFor(SENIOR.id)).row.senderId).toBe(ADMIN.id)
    expect((await derivativeFor(SENIOR.id)).obligation.status).toBe('PENDING')
  })

  it('risk 23 (control): the SAME admin partner may finish what they started', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const first = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(first.obligation.id, ADMIN, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN.id,
      currency: 'USDT',
      receiptExternalUrl: 'https://etherscan.io/tx/0xadminone-b',
    })
    const source = await sourceIncome(PROJECT_SENIOR)
    await editWithPreview(source.id, 2000)

    const reopened = await derivativeFor(SENIOR.id)
    await expect(
      settleSvc.settleByCompany(reopened.obligation.id, ADMIN, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN.id,
        currency: 'USDT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xadminone-c',
      }),
    ).resolves.toBeDefined()
    const closed = await derivativeFor(SENIOR.id)
    expect(closed.obligation.status).toBe('PAID')
    expect(closed.row.senderId).toBe(ADMIN.id)
    expect(closed.row.settledAmount).toBe(closed.row.amount)
  })

  it('risk 24 (SR-M-6): editing a REVERTED row directly is floored by its accumulator too', async () => {
    // The second write path. A reverted row is `PENDING_PAYMENT`, so
    // `isCascadeEdit` is false and neither AC13 nor the cascade's floor is
    // consulted — the #598 sync and the main UPDATE would happily store a
    // figure smaller than what has already been paid, leaving an obligation
    // that asserts a debt of 100 against 260 actually paid.
    await declare(PROJECT_SENIOR, 1000)
    const first = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(first.obligation.id, ADMIN)
    const source = await sourceIncome(PROJECT_SENIOR)
    await editWithPreview(source.id, 2000) // revert: amount 520, accumulator 260

    const reopened = await derivativeFor(SENIOR.id)
    expect(reopened.row.status).toBe('PENDING_PAYMENT')
    expect(reopened.row.settledAmount).toBe('260.000000')

    await svc.adminUpdateTransaction(reopened.row.id, { amount: 100 }, ADMIN)

    const floored = await derivativeFor(SENIOR.id)
    expect(floored.row.amount).toBe('260.000000')
    expect(floored.obligation.amount).toBe('260.000000')

    // And the consequence that makes it worth enforcing: the row still closes.
    await expect(settleSvc.settleByCompany(floored.obligation.id, ADMIN)).resolves.toBeDefined()
    expect((await derivativeFor(SENIOR.id)).obligation.status).toBe('PAID')
  })

  it('risk 24 (control): a direct edit ABOVE the accumulator is stored exactly as typed', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const first = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(first.obligation.id, ADMIN)
    const source = await sourceIncome(PROJECT_SENIOR)
    await editWithPreview(source.id, 2000)

    const reopened = await derivativeFor(SENIOR.id)
    await svc.adminUpdateTransaction(reopened.row.id, { amount: 900 }, ADMIN)

    const edited = await derivativeFor(SENIOR.id)
    expect(edited.row.amount).toBe('900.000000')
    expect(edited.obligation.amount).toBe('900.000000')
  })

  it('risk 25 (CR-M-1): the preview refuses the same real rows the write refuses', async () => {
    // The unit parity table proves the two call the ONE classifier; this
    // proves the rows reaching it come back from real Postgres. The
    // `CLOSES_OBLIGATION` case in particular exists only if the obligations
    // query actually finds the row (risk 22).
    await declare(PROJECT_SENIOR, 1000)
    const { obligation } = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(obligation.id, ADMIN)
    const settled = (await derivativeFor(SENIOR.id)).row
    const deposit = await dbSvc.db.query.transactions.findFirst({
      where: and(
        eq(transactions.senderLabel, DEPOSIT_LABEL),
        eq(transactions.type, 'COMPANY_DEPOSIT'),
      ),
    })
    const income = await sourceIncome(PROJECT_SENIOR)

    const rows: Array<{ label: string; id: string; expected: string | null }> = [
      { label: 'settled senior row', id: settled.id, expected: 'SETTLED_AMOUNT_RECORDED' },
      { label: 'company deposit', id: deposit!.id, expected: 'ONCHAIN_DEPOSIT' },
      { label: 'ordinary income', id: income.id, expected: null },
    ]

    const previewSays: Record<string, string | null> = {}
    const writeRefuses: Record<string, boolean> = {}
    for (const r of rows) {
      const preview = await svc.getEditCascadePreview(r.id, 42, ADMIN)
      previewSays[r.label] = preview.blockedReason
      try {
        await svc.adminUpdateTransaction(
          r.id,
          { amount: 42, cascadeVersion: preview.version ?? 'stale' },
          ADMIN,
        )
        writeRefuses[r.label] = false
      } catch {
        writeRefuses[r.label] = true
      }
    }

    expect(previewSays).toEqual(Object.fromEntries(rows.map((r) => [r.label, r.expected])))
    expect(writeRefuses).toEqual(
      Object.fromEntries(rows.map((r) => [r.label, r.expected !== null])),
    )
  })

  it('risk 26 (SR-H-1): a settle landing between the read and the write is refused, not overwritten', async () => {
    // THE RACE, placed deterministically rather than hoped for. Everything
    // `adminUpdateTransaction` decides — `isCascadeEdit`, `amountChanged`,
    // `requestedFloored` — comes from a read taken BEFORE it opens its DB
    // transaction, and on this (non-cascade) path it takes no lock at all. So
    // the window is real; the only hard part in a test is hitting it on
    // purpose. Spying on `db.transaction` puts the settle exactly there: it
    // commits, and THEN the edit's callback runs against the moved row.
    await declare(PROJECT_SENIOR, 1000)
    const { obligation, row: iou } = await derivativeFor(SENIOR.id)
    expect(iou.status).toBe('PENDING_PAYMENT')
    expect(iou.amount).toBe('260.000000')

    const beforeBalance = await balance()
    const realTransaction = dbSvc.db.transaction.bind(dbSvc.db)
    const spy = vi
      .spyOn(dbSvc.db, 'transaction')
      .mockImplementationOnce(async (cb: Parameters<typeof realTransaction>[0]) => {
        // The concurrent settle. Real service, real Postgres, committed.
        await settleSvc.settleByCompany(obligation.id, ADMIN)
        return realTransaction(cb)
      })

    // Edit DOWNWARD — the dangerous direction. Term 7 debits `amount`; 260
    // really left the company account. Storing 100 would understate the debit
    // by 160, i.e. inflate the balance by money already gone.
    await expect(svc.adminUpdateTransaction(iou.id, { amount: 100 }, ADMIN)).rejects.toThrow(
      /Состояние строки изменилось/,
    )
    spy.mockRestore()

    const after = await derivativeFor(SENIOR.id)
    expect(after.row.status).toBe('PAID')
    expect(after.row.amount).toBe('260.000000')
    expect(after.row.settledAmount).toBe('260.000000')
    // The settle's debit stands, whole and un-edited.
    expect(beforeBalance - (await balance())).toBeCloseTo(260, 6)
  })

  it('risk 26 (SR-H-1, the second loss): the stale read cannot smuggle an edit past AC13', async () => {
    // The other half of the same window. By the time the write lands the row
    // is PAID and carries an accumulator — exactly the shape AC13 refuses. But
    // AC13 was never consulted, because at READ time the row was
    // PENDING_PAYMENT and so `isCascadeEdit` was false: no preview token, no
    // ledger-fact check, no cascade. The status predicate is what makes the
    // write notice.
    await declare(PROJECT_SENIOR, 1000)
    const { obligation, row: iou } = await derivativeFor(SENIOR.id)

    const realTransaction = dbSvc.db.transaction.bind(dbSvc.db)
    const spy = vi
      .spyOn(dbSvc.db, 'transaction')
      .mockImplementationOnce(async (cb: Parameters<typeof realTransaction>[0]) => {
        await settleSvc.settleByCompany(obligation.id, ADMIN)
        return realTransaction(cb)
      })

    await expect(svc.adminUpdateTransaction(iou.id, { amount: 100 }, ADMIN)).rejects.toThrow()
    spy.mockRestore()

    // Nothing was written on either copy of the figure.
    const after = await derivativeFor(SENIOR.id)
    expect(after.row.amount).toBe('260.000000')
    expect(after.obligation.amount).toBe('260.000000')
    expect(after.obligation.status).toBe('PAID')
  })

  it('risk 27 (SR-L-1): a PENDING → PAID → PENDING round trip in the window is refused too', async () => {
    // The ABA remainder of the status predicate. Binding the status catches
    // "someone settled it", but not "someone settled it and something put the
    // status back" — the row reads `PENDING_PAYMENT` again at write time while
    // its accumulator now says 260 was paid.
    //
    // No "+"-direction money error follows (term 9 sums the accumulator, and
    // the next cascade floors by AC5), which is why this is LOW. But the
    // strengthening is one line and has a precedent on the same column in
    // `settleByCompany`'s flip, so there is no reason to leave the hole.
    await declare(PROJECT_SENIOR, 1000)
    const { obligation, row: iou } = await derivativeFor(SENIOR.id)
    expect(iou.settledAmount).toBeNull()

    const realTransaction = dbSvc.db.transaction.bind(dbSvc.db)
    const spy = vi
      .spyOn(dbSvc.db, 'transaction')
      .mockImplementationOnce(async (cb: Parameters<typeof realTransaction>[0]) => {
        // A → B: a real settle. The row becomes PAID and picks up an
        // accumulator.
        await settleSvc.settleByCompany(obligation.id, ADMIN)
        // B → A: the status goes back, the accumulator does NOT. This is the
        // shape a cascade revert leaves behind, reproduced directly so the
        // test states one thing.
        await dbSvc.db
          .update(transactions)
          .set({ status: 'PENDING_PAYMENT', type: 'SENIOR_PENDING_PAYOUT' })
          .where(eq(transactions.id, iou.id))
        return realTransaction(cb)
      })

    await expect(svc.adminUpdateTransaction(iou.id, { amount: 900 }, ADMIN)).rejects.toThrow(
      /Состояние строки изменилось/,
    )
    spy.mockRestore()

    // The stale read said "no accumulator"; the row says otherwise, and
    // nothing was written on that belief.
    const after = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, iou.id),
    })
    expect(after!.settledAmount).toBe('260.000000')
    expect(after!.amount).toBe('260.000000')
  })

  // ── risk 20 — never revert into a dead end (SR-M-3) ─────────────────────

  it('risk 20: a drop obligation closed in UAH blocks the edit — its remainder is not computable', async () => {
    await declare(PROJECT_BOTH, 1000)
    const { obligation } = await derivativeFor(DROP.id)
    await settleSvc.settleByCompany(obligation.id, ADMIN, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN.id,
      currency: 'UAH',
      receiptDocumentId: null,
      receiptExternalUrl: 'https://drive.google.com/file/uah-receipt',
    })
    const closed = await derivativeFor(DROP.id)
    expect(closed.obligation.status).toBe('PAID')

    const source = await sourceIncome(PROJECT_BOTH)
    const preview = await svc.getEditCascadePreview(source.id, 2000, ADMIN)
    // task-drop-topup (task 3b): the blanket drop refusal used to fire first
    // here and mask this case. With it gone, the refusal that remains is the
    // one about the ARITHMETIC: the accumulator is in UAH and the recomputed
    // share is in USDT, so "what is left to pay" is a subtraction across two
    // units — not an approximation, a different quantity. Reverting would
    // leave an obligation whose remainder nobody can compute, which is exactly
    // the dead end risk 20 is about.
    await expect(
      svc.adminUpdateTransaction(
        source.id,
        { amount: 2000, cascadeVersion: preview.version! },
        ADMIN,
      ),
    ).rejects.toThrow(/Остаток к доплате в такой паре не вычисляется/)

    // Zero writes — including on the SENIOR derivative, which was perfectly
    // fine. The cascade is all-or-nothing.
    expect((await derivativeFor(DROP.id)).obligation.status).toBe('PAID')
    expect((await derivativeFor(SENIOR.id)).obligation.amount).toBe(
      String(roundShareAmount(1000, SENIOR_SHARE).toFixed(6)),
    )
    expect((await sourceIncome(PROJECT_BOTH)).amount).toBe(source.amount)
  })

  it('risk 20: a SENIOR obligation closed in USD blocks — the cross-currency remainder case on its own', async () => {
    // BIZ-03 allows a senior settle in USD as well as USDT, so this reaches
    // the currency dead-end WITHOUT also tripping the drop rule — the two
    // conditions of AC15, told apart.
    await declare(PROJECT_SENIOR, 1000)
    const { obligation } = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(obligation.id, ADMIN, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN.id,
      currency: 'USD',
      receiptExternalUrl: 'https://drive.google.com/file/usd-receipt',
    })
    const closed = await derivativeFor(SENIOR.id)
    expect(closed.row.settledCurrency).toBe('USD')

    const source = await sourceIncome(PROJECT_SENIOR)
    const preview = await svc.getEditCascadePreview(source.id, 2000, ADMIN)
    expect(preview.plan!.derivatives[0]!.remainingToPay).toBeNull() // not computable
    await expect(
      svc.adminUpdateTransaction(
        source.id,
        { amount: 2000, cascadeVersion: preview.version! },
        ADMIN,
      ),
    ).rejects.toThrow(/Остаток к доплате в такой паре не вычисляется/)

    expect((await derivativeFor(SENIOR.id)).obligation.status).toBe('PAID')
    expect((await sourceIncome(PROJECT_SENIOR)).amount).toBe(source.amount)
  })

  it('risk 20 → task 3b: a drop obligation closed in USDT is REVERTED now, not refused', async () => {
    // This test used to assert the opposite, and that was the honest thing to
    // say while the top-up did not exist: reverting a row nothing could close
    // is worse than refusing the edit. `task-drop-topup` built the closing
    // half, so the same scenario now completes.
    //
    // The money side of it — how much actually leaves the account, what the
    // triplet ends up holding, what the ledger does between the two states —
    // is in `drop-topup.integration.spec.ts`. What belongs HERE is only that
    // the cascade no longer refuses.
    await declare(PROJECT_BOTH, 1000)
    const { obligation } = await derivativeFor(DROP.id)
    await settleSvc.settleByCompany(obligation.id, ADMIN)
    expect((await derivativeFor(DROP.id)).obligation.status).toBe('PAID')

    const source = await sourceIncome(PROJECT_BOTH)
    await expect(editWithPreview(source.id, 2000)).resolves.toBeDefined()

    const reopened = await derivativeFor(DROP.id)
    expect(reopened.obligation.status).toBe('PENDING')
    expect(reopened.row.type).toBe('DROP_PENDING_PAYOUT')
    expect(reopened.row.status).toBe('PENDING_PAYMENT')
    expect((await sourceIncome(PROJECT_BOTH)).amount).toBe('2000.000000')
  })

  // ── risk 21 — the round trip has to come back (SR-M-4) ──────────────────

  it('risk 21: edit up, then back down — the obligation closes normally instead of getting stuck', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const first = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(first.obligation.id, ADMIN)
    const settledFigure = roundShareAmount(1000, SENIOR_SHARE) // 260

    const source = await sourceIncome(PROJECT_SENIOR)
    await editWithPreview(source.id, 2000) // share 520 — revert
    expect((await derivativeFor(SENIOR.id)).obligation.status).toBe('PENDING')

    // …and straight back down. The recomputed share (260) equals what was
    // already paid, so the accumulator floor writes 260 rather than anything
    // smaller, and the remainder comes out at exactly zero.
    await editWithPreview(source.id, 1000)
    const back = await derivativeFor(SENIOR.id)
    expect(parseFloat(back.row.amount)).toBeCloseTo(settledFigure, 6)
    expect(parseFloat(back.obligation.amount)).toBeCloseTo(settledFigure, 6)
    expect(parseFloat(back.row.settledAmount!)).toBeCloseTo(settledFigure, 6)

    const preview = await svc.getEditCascadePreview(source.id, 1000, ADMIN)
    expect(preview.plan!.sourceAmountChanged).toBe(false)

    // The row must be closable again. Without `max` the remainder would be
    // negative; with the old "zero is an error" rule it would be refused —
    // either way the obligation would stay open forever, claiming a debt.
    const before = await balance()
    await expect(settleSvc.settleByCompany(back.obligation.id, ADMIN)).resolves.toBeDefined()

    const closed = await derivativeFor(SENIOR.id)
    expect(closed.obligation.status).toBe('PAID')
    expect(closed.row.status).toBe('PAID')
    expect(parseFloat(closed.row.settledAmount!)).toBeCloseTo(settledFigure, 6)
    // Closing on a zero remainder is ledger-neutral: the row leaves term 9
    // carrying `settled_amount` and enters term 7 carrying `amount`, and those
    // two are equal.
    expect(await balance()).toBeCloseTo(before, 6)
  })

  it('risk 21: editing BELOW what was paid on a reverted row floors the amount at the accumulator', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const first = await derivativeFor(SENIOR.id)
    await settleSvc.settleByCompany(first.obligation.id, ADMIN)
    const settledFigure = roundShareAmount(1000, SENIOR_SHARE) // 260

    const source = await sourceIncome(PROJECT_SENIOR)
    await editWithPreview(source.id, 2000) // revert
    await editWithPreview(source.id, 100) // share would be 26 — below the 260 paid

    const after = await derivativeFor(SENIOR.id)
    expect(parseFloat(after.row.amount)).toBeCloseTo(settledFigure, 6)
    expect(parseFloat(after.obligation.amount)).toBeCloseTo(settledFigure, 6)
    // The overpayment is still a fact a human has to see.
    const entries = await journalFor(after.row.id, 'CASCADE_OVERPAYMENT')
    expect(entries.length).toBeGreaterThan(0)
    const meta = entries.at(-1)!.metadata as Record<string, unknown>
    expect(meta['overpaidBy']).toBeCloseTo(settledFigure - 26, 6)
  })

  it('AC2: saving a PAID amount edit without a preview token is refused outright', async () => {
    await declare(PROJECT_SENIOR, 1000)
    const source = await sourceIncome(PROJECT_SENIOR)
    await expect(svc.adminUpdateTransaction(source.id, { amount: 2500 }, ADMIN)).rejects.toThrow(
      /предпросмотр/,
    )
    expect((await sourceIncome(PROJECT_SENIOR)).amount).toBe(source.amount)
  })
})
