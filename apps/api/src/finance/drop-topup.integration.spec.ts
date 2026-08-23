import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { MAKSYM_ID } from '@crm/shared'

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
 * task-drop-topup (task 3b of the paid-transaction-edit-cascade decomposition)
 * — closing the REMAINDER of a partly paid drop obligation, against real
 * Postgres.
 *
 * WHY A REAL DATABASE IS NOT OPTIONAL HERE. The two figures this task moves —
 * `transactions.amount` and `transactions.settled_amount` on a drop row — are
 * now written by ONE `sql\`coalesce(...) + delta\`` expression, and Stryker has
 * no mutator for arithmetic inside a template literal. The unit double
 * (`pending-settlement.drop-currency.spec.ts`) can prove the two expressions are
 * IDENTICAL, which is the property that makes them unable to disagree; only
 * Postgres can prove what they EVALUATE TO. The mutation gate cannot execute
 * this file at all (`.claude/rules/common/mutation-gate-integration-specs.md`),
 * so the two are complements, never duplicates.
 *
 * THE FIXTURE, and why it is shaped this way (inherited from
 * `cascade-apply.integration.spec.ts`, same reasoning): the source income is
 * declared to an ADMIN PERSONALLY, so `funding_source` stays NULL on it and it
 * sits in NO ledger term. The drop settle IS company-funded, so the drop
 * derivative — and nothing else — moves the company balance. That is what lets
 * every balance assertion below be an exact equality instead of "equal after
 * subtracting the income delta".
 *
 * The senior derivative of the same income is never settled here, so it too
 * stays out of every ledger term; it exists only because a project has a
 * senior.
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api exec vitest run drop-topup.integration.spec
 */

const SENIOR: SessionUser = {
  id: 'd0b70b00-0000-4000-bb00-000000000001',
  email: 'drop-topup-senior@test.spec',
  displayName: 'Top-up Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 20,
  legalFullName: null,
}
const DROP: SessionUser = {
  ...SENIOR,
  id: 'd0b70b00-0000-4000-bb00-000000000002',
  email: 'drop-topup-drop@test.spec',
  displayName: 'Top-up Drop',
  role: 'DROP',
}
const ADMIN: SessionUser = {
  ...SENIOR,
  id: MAKSYM_ID,
  email: 'drop-topup-admin@test.spec',
  displayName: 'Top-up Admin',
  role: 'ADMIN',
  seniorSharePercent: 0,
}

const TEST_OWN_USER_IDS = [SENIOR.id, DROP.id]
const ACCOUNT_ID = 'd0b70b00-0000-4000-cc00-000000000001'
const PROJECT = 'd0b70b00-0000-4000-dd00-000000000001'
const DEPOSIT_LABEL = 'drop-topup-spec-deposit'
const SENIOR_SHARE = 20
/** 10% of a 1000 income is 100, and of 1300 is 130 — every figure below is exact. */
const DROP_SHARE = 10
const WALLET = '0xD0B0FF0000000000000000000000000000000abc'

/** A rate that is nowhere near 1, so a UAH figure can never be mistaken for a USDT one. */
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

/** Same rationale as `cascade-apply.integration.spec.ts`: the invoice side has its own real-DB coverage. */
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
class DropTopUpTestModule {}

describe.skipIf(!hasDatabaseUrl())('task-drop-topup — closing a drop remainder for real', () => {
  let svc: TransactionsService
  let settleSvc: PendingSettlementService
  let dbSvc: DatabaseService

  const FIRST_RECEIPT = 'https://etherscan.io/tx/0xfirstdroppayment'
  const SECOND_RECEIPT = 'https://etherscan.io/tx/0xseconddroppayment'

  function declare(amount: number) {
    return svc.declareUsdtProjectIncome(
      {
        projectId: PROJECT,
        amount,
        receiverId: ADMIN.id,
        idempotencyKey: randomUUID(),
        receiptExternalUrl: `https://etherscan.io/tx/0x${randomUUID().replace(/-/g, '')}`,
      },
      ADMIN,
    )
  }

  async function sourceIncome() {
    const row = await dbSvc.db.query.transactions.findFirst({
      where: and(eq(transactions.projectId, PROJECT), eq(transactions.type, 'ADMIN_INCOME')),
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

  /** Preview + apply, the way the UI does it: the token always comes from the preview. */
  async function editWithPreview(sourceId: string, newAmount: number) {
    const preview = await svc.getEditCascadePreview(sourceId, newAmount, ADMIN)
    await svc.adminUpdateTransaction(
      sourceId,
      { amount: newAmount, cascadeVersion: preview.version! },
      ADMIN,
    )
    return preview
  }

  /** The company-funded drop settle this task is about, receipt and all. */
  function settleDropFromCompany(obligationId: string, receiptExternalUrl: string) {
    return settleSvc.settleByCompany(obligationId, ADMIN, {
      fundingSource: 'COMPANY_ACCOUNT',
      currency: 'USDT',
      receiptExternalUrl,
    })
  }

  /** declare 1000 → drop IOU of 100 → pay it from the company account. */
  async function paidDropOf100() {
    await declare(1000)
    const first = await derivativeFor(DROP.id)
    await settleDropFromCompany(first.obligation.id, FIRST_RECEIPT)
    return sourceIncome()
  }

  async function clearLedger() {
    await dbSvc.db
      .delete(pendingObligations)
      .where(inArray(pendingObligations.creditorUserId, TEST_OWN_USER_IDS))
    await dbSvc.db.delete(transactions).where(eq(transactions.projectId, PROJECT))
    await dbSvc.db.delete(transactions).where(eq(transactions.senderLabel, DEPOSIT_LABEL))
    await sweepOrphanConsumedTxHashes(dbSvc)
  }

  beforeAll(async () => {
    const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const which = await probe.query('SELECT current_database() AS db')
    if (which.rows[0]?.db === 'crm_db') {
      await probe.end()
      throw new Error('[drop-topup] REFUSING to run against the live crm_db')
    }
    const check = await probe.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='transactions' AND column_name='settled_amount' LIMIT 1`,
    )
    await probe.end()
    if (check.rowCount === 0) {
      throw new Error('[drop-topup] FAILED — schema not migrated (no transactions.settled_amount)')
    }

    const moduleRef = await Test.createTestingModule({ imports: [DropTopUpTestModule] }).compile()
    await moduleRef.init()
    svc = moduleRef.get(TransactionsService)
    settleSvc = moduleRef.get(PendingSettlementService)
    dbSvc = moduleRef.get(DatabaseService)

    const db = dbSvc.db
    await clearLedger()
    await db.delete(projects).where(eq(projects.id, PROJECT))
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
      ])
      .onConflictDoNothing()
    await db
      .insert(projects)
      .values({
        id: PROJECT,
        name: 'Drop Top-up Project',
        companyName: 'Top-up Co',
        domain: 'fintech',
        startDate: new Date('2025-01-01'),
        seniorId: SENIOR.id,
        dropId: DROP.id,
        currency: 'USDT',
        rate: 1000,
        paymentType: 'USDT',
      })
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
      await dbSvc.db.delete(projects).where(eq(projects.id, PROJECT))
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_OWN_USER_IDS))
    }
    if (_pool) await _pool.end()
  })

  // ── risk 1 — the drop must not be paid the whole obligation twice ────────

  it('risk 1: the top-up debits the REMAINDER — 30, not the obligation`s full 130', async () => {
    // The expensive failure this task can produce. Lifting the two refusals
    // without switching the conversion input pays 130 on a debt of which 100 is
    // already paid: 230 leaves the account for a 130 obligation, and the drop is
    // 100 USDT richer than anyone owed them.
    const source = await paidDropOf100()
    const afterFirstPayment = await balance()

    await editWithPreview(source.id, 1300)
    const reopened = await derivativeFor(DROP.id)
    const beforeTopUp = await balance()

    await settleDropFromCompany(reopened.obligation.id, SECOND_RECEIPT)

    expect(beforeTopUp - (await balance())).toBeCloseTo(30, 6)
    // …and the whole obligation, first payment included, cost exactly 130.
    expect(afterFirstPayment + 100 - (await balance())).toBeCloseTo(130, 6)

    const closed = await derivativeFor(DROP.id)
    expect(closed.row.settledAmount).toBe('130.000000')
    expect(closed.row.amount).toBe('130.000000')
    // The unit label travels with each figure — a number without one is how
    // this class of defect gets written in the first place.
    expect(closed.row.settledCurrency).toBe('USDT')
    expect(closed.row.currency).toBe('USDT')
    expect(closed.obligation.status).toBe('PAID')
    expect(closed.obligation.currency).toBe('USDT')
  })

  // ── risk 2 / risk 3 — the payment fact describes the closure ─────────────

  it('risk 2: the triplet describes the CLOSURE, and the identity it asserts is true', async () => {
    const source = await paidDropOf100()
    await editWithPreview(source.id, 1300)
    const reopened = await derivativeFor(DROP.id)
    await settleDropFromCompany(reopened.obligation.id, SECOND_RECEIPT)

    const { row } = await derivativeFor(DROP.id)
    expect(row.originalAmount).toBe('130.000000')
    expect(row.originalCurrency).toBe('USDT')
    // Two USDT payments; each converted nothing, so the closure's rate is 1.
    // Recording 30/130 here (the LAST payment over the obligation) would make
    // the row assert a conversion that never happened.
    expect(row.exchangeRate).toBe('1.00000000')
    // T1, stated as the identity rather than as three separate values.
    expect(Number(row.amount)).toBeCloseTo(Number(row.originalAmount) * Number(row.exchangeRate), 6)
  })

  it('risk 3: the stamp is MOVED to the new obligation, not left over from the first payment', async () => {
    // Asserting "not the old value" as well as "the new one" is what tells a
    // re-stamp apart from an implementation that simply never touched the
    // columns — the old value is a perfectly plausible-looking number.
    const source = await paidDropOf100()
    expect((await derivativeFor(DROP.id)).row.originalAmount).toBe('100.000000')

    await editWithPreview(source.id, 1300)
    const reopened = await derivativeFor(DROP.id)
    await settleDropFromCompany(reopened.obligation.id, SECOND_RECEIPT)

    const { row } = await derivativeFor(DROP.id)
    expect(row.originalAmount).not.toBe('100.000000')
    expect(row.originalAmount).toBe('130.000000')
  })

  // ── risk 4 — the window between the edit and the top-up ─────────────────

  it('risk 4: a reverted row does not claim it was paid, and keeps every record that is still true', async () => {
    // This is the state the owner LOOKS AT while deciding how much to top up.
    // A triplet left behind would have the row asserting `amount(130) =
    // original(100) × 1` — false — for exactly that long.
    const source = await paidDropOf100()
    await editWithPreview(source.id, 1300)

    const { row, obligation } = await derivativeFor(DROP.id)
    expect(row.type).toBe('DROP_PENDING_PAYOUT')
    expect(row.status).toBe('PENDING_PAYMENT')
    expect(row.amount).toBe('130.000000')
    // Retracted: the three columns whose truth was stated relative to `amount`.
    expect(row.originalAmount).toBeNull()
    expect(row.originalCurrency).toBeNull()
    expect(row.exchangeRate).toBeNull()
    // Kept: every column that is a self-standing record of a payment that
    // really happened. Monotonic accumulator included — the money did leave.
    expect(row.settledAmount).toBe('100.000000')
    expect(row.settledCurrency).toBe('USDT')
    expect(row.settledSharePercent).toBe(DROP_SHARE)
    expect(row.fundingSource).toBe('COMPANY_ACCOUNT')
    expect(row.receiptExternalUrl).toBe(FIRST_RECEIPT)
    expect(row.currency).toBe('USDT')
    expect(obligation.status).toBe('PENDING')
    expect(obligation.amount).toBe('130.000000')
  })

  // ── risk 5 — the round trip has to come back on the drop side too ────────

  it('risk 5: edit up, then back down — the obligation closes on a zero remainder', async () => {
    // Reachable, not hypothetical: the cascade floors both copies of the figure
    // at the accumulator, so an income edited up and back down leaves an
    // obligation exactly as large as what is already paid. If the dust check
    // still compared against the obligation's full figure, this settle would be
    // refused as "the payment rounded to zero" and the obligation would have
    // nothing left that could close it.
    const source = await paidDropOf100()
    const afterFirstPayment = await balance()

    await editWithPreview(source.id, 1300)
    await editWithPreview(source.id, 1000)

    const reopened = await derivativeFor(DROP.id)
    expect(reopened.obligation.amount).toBe('100.000000')
    await settleDropFromCompany(reopened.obligation.id, SECOND_RECEIPT)

    const closed = await derivativeFor(DROP.id)
    expect(closed.row.type).toBe('PAYOUT_DROP')
    expect(closed.row.status).toBe('PAID')
    expect(closed.row.settledAmount).toBe('100.000000')
    expect(closed.row.amount).toBe('100.000000')
    // risk 10b: closing on a zero remainder is LEDGER-NEUTRAL — the row leaves
    // term 9 carrying `settled_amount` and enters term 8 carrying `amount`, and
    // this task is what makes those two the same number.
    expect(await balance()).toBeCloseTo(afterFirstPayment, 6)
  })

  // ── risk 6 / 6b — the currency boundary, both sides of it ────────────────

  it('risk 6: a top-up in another currency is refused, and writes nothing in either table', async () => {
    const source = await paidDropOf100()
    await editWithPreview(source.id, 1300)
    const reopened = await derivativeFor(DROP.id)
    const before = await balance()

    await expect(
      settleSvc.settleByCompany(reopened.obligation.id, ADMIN, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN.id,
        currency: 'UAH',
        receiptExternalUrl: 'https://drive.google.com/file/uah-topup-receipt',
      }),
    ).rejects.toThrow(/возможна только в USDT/)

    const after = await derivativeFor(DROP.id)
    expect(after.obligation.status).toBe('PENDING')
    expect(after.row.status).toBe('PENDING_PAYMENT')
    expect(after.row.settledAmount).toBe('100.000000')
    expect(after.row.settledCurrency).toBe('USDT')
    expect(after.row.originalAmount).toBeNull()
    expect(await balance()).toBeCloseTo(before, 6)
  })

  it('risk 6b: the SAME refusal is silent on a first settle — a drop payout in UAH still works', async () => {
    // The mirror. Without it, "refuse a cross-currency top-up" would be
    // indistinguishable from "refuse every cross-currency drop payout", which
    // would silently delete an existing feature (task-drop-payout-currency).
    await declare(1000)
    const first = await derivativeFor(DROP.id)
    await settleSvc.settleByCompany(first.obligation.id, ADMIN, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN.id,
      currency: 'UAH',
      receiptExternalUrl: 'https://drive.google.com/file/uah-first-receipt',
    })

    const { row } = await derivativeFor(DROP.id)
    expect(row.currency).toBe('UAH')
    expect(row.settledCurrency).toBe('UAH')
    // 100 USDT × 40 UAH/USD — the figure and its unit, both checked.
    expect(Number(row.amount)).toBeCloseTo(4000, 2)
    expect(row.originalAmount).toBe('100.000000')
    expect(row.originalCurrency).toBe('USDT')
    expect(Number(row.exchangeRate)).toBeCloseTo(40, 6)
  })

  // ── risk 9 / 10 / 12 — the invariant, the ledger, and the chain ──────────

  it('risk 10: the ledger hands the debit back and takes exactly the remainder', async () => {
    const source = await paidDropOf100()
    const b1 = await balance()

    await editWithPreview(source.id, 1300)
    const b2 = await balance()
    // Term 9 returns the debit the revert took out of terms 7/8 — the balance
    // is exactly where it was before the edit, because no money moved.
    expect(b2).toBeCloseTo(b1, 6)

    const reopened = await derivativeFor(DROP.id)
    await settleDropFromCompany(reopened.obligation.id, SECOND_RECEIPT)
    const b3 = await balance()
    // …and the top-up takes only what physically left: the remainder.
    expect(b1 - b3).toBeCloseTo(30, 6)
  })

  it('risk 9 / 12: a chain of edits and top-ups keeps the accumulator monotonic and equal to the amount', async () => {
    const source = await paidDropOf100()
    const seen: number[] = [100]

    for (const income of [1300, 1700]) {
      await editWithPreview(source.id, income)
      const reopened = await derivativeFor(DROP.id)
      await settleDropFromCompany(reopened.obligation.id, `${SECOND_RECEIPT}-${income}`)
      const { row } = await derivativeFor(DROP.id)
      // §1.2 after EVERY closure — the invariant ledger term 9 stands on.
      expect(row.amount).toBe(row.settledAmount)
      expect(row.currency).toBe(row.settledCurrency)
      seen.push(Number(row.settledAmount))
    }

    expect(seen).toEqual([100, 130, 170])
    // Strictly growing: an accumulator that ever went down would mean money was
    // un-paid, which is not a thing.
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!)
    // The company paid the final obligation once, not three times.
    expect(await balance()).toBeCloseTo(100000 - 170, 6)
  })

  // ── risk 11 — the top-up comes from the same pot and the same person ─────

  it('risk 11: a personal-account top-up on a company-paid drop row is refused', async () => {
    const source = await paidDropOf100()
    await editWithPreview(source.id, 1300)
    const reopened = await derivativeFor(DROP.id)
    const before = await balance()

    await expect(
      settleSvc.settleByCompany(reopened.obligation.id, ADMIN, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN.id,
        currency: 'USDT',
        receiptExternalUrl: SECOND_RECEIPT,
      }),
    ).rejects.toThrow(/Доплата обязана идти из того же источника/)

    // Nothing moved: without the guard the row would drop out of term 7 (its
    // funding marker gone) AND out of term 9 (no longer PENDING_PAYMENT), and
    // 100 USDT that really left the account would vanish from the ledger.
    expect(await balance()).toBeCloseTo(before, 6)
    expect((await derivativeFor(DROP.id)).obligation.status).toBe('PENDING')
  })

  it('risk 11 (control): the same top-up FROM the company account goes through', async () => {
    const source = await paidDropOf100()
    await editWithPreview(source.id, 1300)
    const reopened = await derivativeFor(DROP.id)
    await expect(
      settleDropFromCompany(reopened.obligation.id, SECOND_RECEIPT),
    ).resolves.toBeDefined()
    expect((await derivativeFor(DROP.id)).obligation.status).toBe('PAID')
  })

  // ── risk 13 — the first payment's proof must survive the second ──────────

  it('risk 13: the journal keeps the retracted payment fact, receipt link included', async () => {
    // The row has ONE pair of receipt columns and the closure now has two
    // payments, so the top-up overwrites the first payment's proof. That is
    // acceptable only because the revert recorded it — inside the money
    // transaction, not best-effort afterwards.
    const source = await paidDropOf100()
    const { row: paidRow } = await derivativeFor(DROP.id)
    expect(paidRow.receiptExternalUrl).toBe(FIRST_RECEIPT)

    await editWithPreview(source.id, 1300)

    const entries = await dbSvc.db.query.transactionAuditLog.findMany({
      where: and(
        eq(transactionAuditLog.targetId, paidRow.id),
        eq(transactionAuditLog.action, 'CASCADE_REOPEN'),
      ),
    })
    expect(entries).toHaveLength(1)
    const before = (entries[0]!.metadata as Record<string, unknown>)['before'] as Record<
      string,
      unknown
    >
    expect(before['amount']).toBe(100)
    expect(before['type']).toBe('PAYOUT_DROP')
    expect(before['status']).toBe('PAID')
    expect(before['originalAmount']).toBe(100)
    expect(before['originalCurrency']).toBe('USDT')
    expect(before['exchangeRate']).toBe('1.00000000')
    expect(before['receiptDocumentId']).toBeNull()
    expect(before['receiptExternalUrl']).toBe(FIRST_RECEIPT)

    // And after the top-up the row itself carries the SECOND payment's proof —
    // which is why the journal entry above is the only copy of the first.
    const reopened = await derivativeFor(DROP.id)
    await settleDropFromCompany(reopened.obligation.id, SECOND_RECEIPT)
    expect((await derivativeFor(DROP.id)).row.receiptExternalUrl).toBe(SECOND_RECEIPT)
  })

  // ── risk 12 — the closed row stays closed to a direct edit ───────────────

  it('risk 12: a topped-up drop row still refuses a DIRECT amount edit', async () => {
    // AC13 is a disjunction, so clearing the triplet on a revert opens nothing:
    // a closed drop row is held by its accumulator and by its closed obligation
    // independently of it.
    const source = await paidDropOf100()
    await editWithPreview(source.id, 1300)
    const reopened = await derivativeFor(DROP.id)
    await settleDropFromCompany(reopened.obligation.id, SECOND_RECEIPT)

    const { row } = await derivativeFor(DROP.id)
    await expect(svc.adminUpdateTransaction(row.id, { amount: 5 }, ADMIN)).rejects.toThrow()
    expect((await derivativeFor(DROP.id)).row.amount).toBe('130.000000')
  })

  it('risk 12 (the negative): the ordinary income edit this whole decomposition exists for still works', async () => {
    await declare(1000)
    const source = await sourceIncome()
    await expect(editWithPreview(source.id, 2500)).resolves.toBeDefined()
    expect((await sourceIncome()).amount).toBe('2500.000000')
  })
})
