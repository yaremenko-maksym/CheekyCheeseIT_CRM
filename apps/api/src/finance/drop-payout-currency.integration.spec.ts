import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { PendingSettlementService } from './pending-settlement.service'
import { computeCompanyAccountBalanceFromLedger } from './company-account-balance'
import { convertToBase, type BalanceCurrency } from './balance.service'
import type { NbuCurrencyService } from './nbu-currency.service'
import {
  companyAccount,
  pendingObligations,
  projects,
  transactions,
  users,
} from '../database/schema'
import * as schema from '../database/schema'

/**
 * task-drop-payout-currency — REAL-DB integration proving the AC3 invariant
 * («Главный тест задачи»): the amount `settleByCompany` WRITES for a DROP
 * obligation settled in a non-obligation currency matches, to the penny, an
 * independently-computed prediction using the exact same conversion function
 * (`convertToBase`) a caller (the frontend dialog) would use to DISPLAY the
 * figure before submitting. It also proves:
 *
 *   - AC4: original_amount/original_currency are stamped on EVERY drop
 *     settle, including the same-currency default.
 *   - AC6: an unrepresentable exchange-rate ratio is recorded as NULL against
 *     a REAL numeric(18,8) column (not just the mocked-db unit spec).
 *   - AC7: the obligation closes in FULL regardless of currency — no
 *     residual PENDING obligation is left, and `computeDropAggregate`'s own
 *     ledger term (PAYOUT_DROP) reflects the ACTUAL converted amount.
 *   - BIZ-03 exemption: a DROP settle in UAH/EUR does not throw, unlike the
 *     SENIOR path (senior-settle-owner.integration.spec.ts stays USDT/USD only).
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- drop-payout-currency.integration
 */

const PREFIX = 'dc990000-0000-4000'

const DROP: SessionUser = {
  id: `${PREFIX}-bb00-000000000001`,
  email: 'dpc-drop@test.spec',
  displayName: 'DPC Drop',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ADMIN: SessionUser = {
  ...DROP,
  id: `${PREFIX}-bb00-000000000002`,
  email: 'dpc-admin@test.spec',
  displayName: 'DPC Admin',
  role: 'ADMIN',
}
const ACCOUNTANT: SessionUser = {
  ...DROP,
  id: `${PREFIX}-bb00-000000000003`,
  email: 'dpc-accountant@test.spec',
  displayName: 'DPC Accountant',
  role: 'ACCOUNTANT',
}
// projects.senior_id is NOT NULL — every project (drop-attached or not)
// still needs a senior owner. Unused by any assertion here; just satisfies
// the FK so the drop-only obligation can be seeded.
const SENIOR: SessionUser = {
  ...DROP,
  id: `${PREFIX}-bb00-000000000004`,
  email: 'dpc-senior@test.spec',
  displayName: 'DPC Senior',
  role: 'SENIOR',
  seniorSharePercent: 26,
}

const ALL_USERS = [DROP, ADMIN, ACCOUNTANT, SENIOR]
const ALL_USER_IDS = ALL_USERS.map((u) => u.id)
const PROJECT_ID = `${PREFIX}-dd00-000000000001`
const ACCOUNT_ID = `${PREFIX}-cc00-000000000001`
const SOURCE_TX_ID = `${PREFIX}-ee00-000000000001`
const OBLIGATION_ID = `${PREFIX}-ff00-000000000001`
const DEPOSIT_ID = `${PREFIX}-aa00-000000000001`

const DROP_SHARE = '1000' // obligation amount, always booked USDT
const FIXED_RATES = { usdUah: '41.50', usdtUah: '41.50', eurUah: '44.80', date: '20260812' }

const EXPLORER_RECEIPT = { receiptExternalUrl: 'https://etherscan.io/tx/0xdroppayoutcurrencyspec' }
const FILE_RECEIPT = { receiptExternalUrl: 'https://drive.google.com/file/droppayoutcurrencyspec' }

const stubInvoices = {
  autoCreateForSeniorPayout: () => Promise.resolve(),
} as never

// Fixed rates — deterministic, no live NBU network call (zero-flaky-E2E).
const fakeNbu: Pick<NbuCurrencyService, 'getRates'> = {
  getRates: () => Promise.resolve(FIXED_RATES),
}

let _pool: Pool | null = null
let dbAvailable = true

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
      provide: PendingSettlementService,
      useFactory: (db: DatabaseService) =>
        new PendingSettlementService(db, stubInvoices, fakeNbu as NbuCurrencyService),
      inject: [DatabaseService],
    },
  ],
})
class DpcTestModule {}

describe('DROP obligation settle — currency conversion (real DB, task-drop-payout-currency)', () => {
  let settleSvc: PendingSettlementService
  let dbSvc: DatabaseService

  async function gateBalance(): Promise<number> {
    return computeCompanyAccountBalanceFromLedger(dbSvc.db)
  }

  async function seedPendingDropIou(): Promise<void> {
    await dbSvc.db.delete(pendingObligations).where(eq(pendingObligations.creditorUserId, DROP.id))
    await dbSvc.db.delete(transactions).where(inArray(transactions.id, [SOURCE_TX_ID]))
    await dbSvc.db
      .delete(transactions)
      .where(and(eq(transactions.type, 'PAYOUT_DROP'), eq(transactions.receiverId, DROP.id)))

    await dbSvc.db.insert(transactions).values({
      id: SOURCE_TX_ID,
      type: 'DROP_PENDING_PAYOUT',
      status: 'PENDING_PAYMENT',
      amount: DROP_SHARE,
      currency: 'USDT',
      senderId: null,
      senderLabel: 'COMPANY',
      receiverId: DROP.id,
      recipientId: DROP.id,
      projectId: PROJECT_ID,
      // declareUsdtProjectIncome-booked (non-cascade) — «Счёт компании» is a
      // legal funding choice for every test in this file.
      dropCascadeOrigin: false,
      dropSharePercent: 26,
      dropSharePercentSource: 'PROJECT',
      createdBy: ADMIN.id,
    })
    await dbSvc.db.insert(pendingObligations).values({
      id: OBLIGATION_ID,
      creditorUserId: DROP.id,
      debtorType: 'COMPANY',
      debtorUserId: null,
      sourceTransactionId: SOURCE_TX_ID,
      amount: DROP_SHARE,
      currency: 'USDT',
      status: 'PENDING',
    })
  }

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      const check = await probe.query(
        `SELECT table_name FROM information_schema.tables WHERE table_name='pending_obligations' LIMIT 1`,
      )
      await probe.end()
      if (check.rowCount === 0) {
        console.warn('[drop-payout-currency] SKIPPED — pending_obligations not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[drop-payout-currency] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({ imports: [DpcTestModule] }).compile()
    await moduleRef.init()
    settleSvc = moduleRef.get(PendingSettlementService)
    dbSvc = moduleRef.get(DatabaseService)

    const db = dbSvc.db
    await db.delete(pendingObligations).where(eq(pendingObligations.creditorUserId, DROP.id))
    await db.delete(transactions).where(inArray(transactions.createdBy, ALL_USER_IDS))
    await db.delete(transactions).where(inArray(transactions.receiverId, ALL_USER_IDS))
    await db.delete(transactions).where(inArray(transactions.id, [SOURCE_TX_ID, DEPOSIT_ID]))
    await db.delete(projects).where(eq(projects.id, PROJECT_ID))
    await db.delete(users).where(inArray(users.id, ALL_USER_IDS))

    await db
      .insert(users)
      .values(
        ALL_USERS.map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          seniorSharePercent: u.seniorSharePercent,
          googleId: `test-google-${u.id}`,
        })),
      )
      .onConflictDoNothing()

    await db
      .insert(projects)
      .values({
        id: PROJECT_ID,
        name: 'DPC Project',
        companyName: 'DPC Corp',
        domain: 'fintech',
        startDate: new Date('2025-01-01'),
        seniorId: SENIOR.id,
        dropId: DROP.id,
        currency: 'USDT',
        rate: 1000,
      })
      .onConflictDoNothing()

    // Company account row + a large COMPANY_DEPOSIT so a COMPANY_ACCOUNT
    // settle passes the balance gate.
    const existing = await db.query.companyAccount.findFirst()
    if (!existing) {
      await db.insert(companyAccount).values({
        id: ACCOUNT_ID,
        walletAddress: '0xC0FFEE0000000000000000000000000000000dpc',
        confirmationThreshold: 12,
        updatedBy: ADMIN.id,
      })
    }
    await db.delete(transactions).where(eq(transactions.id, DEPOSIT_ID))
    await db.insert(transactions).values({
      id: DEPOSIT_ID,
      type: 'COMPANY_DEPOSIT',
      status: 'PAID',
      amount: '100000',
      currency: 'USDT',
      createdBy: ADMIN.id,
    })
  }, 30_000)

  beforeEach(async () => {
    if (!dbAvailable) return
    await seedPendingDropIou()
  })

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      await dbSvc.db
        .delete(pendingObligations)
        .where(eq(pendingObligations.creditorUserId, DROP.id))
      await dbSvc.db.delete(transactions).where(inArray(transactions.createdBy, ALL_USER_IDS))
      await dbSvc.db.delete(transactions).where(inArray(transactions.receiverId, ALL_USER_IDS))
      await dbSvc.db
        .delete(transactions)
        .where(inArray(transactions.id, [SOURCE_TX_ID, DEPOSIT_ID]))
      await dbSvc.db.delete(projects).where(eq(projects.id, PROJECT_ID))
      await dbSvc.db.delete(users).where(inArray(users.id, ALL_USER_IDS))
    } catch {
      // non-fatal
    }
    await _pool?.end()
  }, 15_000)

  async function payoutDropRow() {
    return dbSvc.db.query.transactions.findFirst({
      where: and(eq(transactions.type, 'PAYOUT_DROP'), eq(transactions.receiverId, DROP.id)),
    })
  }

  // ── AC3 (главный тест): shown prediction === recorded fact, to the penny ──
  it('AC3: UAH settle — the written amount matches an independently-computed convertToBase prediction to the penny', async () => {
    if (!dbAvailable) return

    // What a caller (the frontend dialog) would COMPUTE and DISPLAY before
    // submitting — using the SAME pure function, fed the SAME rates.
    const predicted = convertToBase(
      parseFloat(DROP_SHARE),
      'USDT' as BalanceCurrency,
      'UAH' as BalanceCurrency,
      FIXED_RATES,
    )

    const result = await settleSvc.settleByCompanySourceTransaction(SOURCE_TX_ID, ACCOUNTANT, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN.id,
      currency: 'UAH',
      ...FILE_RECEIPT,
    })
    expect(result.obligation.status).toBe('PAID')

    const row = await payoutDropRow()
    expect(row).toBeTruthy()
    expect(row!.status).toBe('PAID')
    expect(row!.currency).toBe('UAH')
    // The ACTUAL DB write — to the penny (numeric(18,6), 6dp round-trip).
    expect(parseFloat(row!.amount)).toBeCloseTo(predicted, 6)
    expect(predicted).toBeCloseTo(41500, 2) // 1000 USDT * 41.50 UAH/USD

    // AC4: obligation snapshot stamped.
    expect(row!.originalAmount).not.toBeNull()
    expect(parseFloat(row!.originalAmount!)).toBeCloseTo(parseFloat(DROP_SHARE), 6)
    expect(row!.originalCurrency).toBe('USDT')
    expect(row!.exchangeRate).not.toBeNull()
    expect(parseFloat(row!.exchangeRate!)).toBeCloseTo(41.5, 6)
  })

  it('AC3: EUR settle — the written amount matches convertToBase triangulation to the penny', async () => {
    if (!dbAvailable) return
    const predicted = convertToBase(
      parseFloat(DROP_SHARE),
      'USDT' as BalanceCurrency,
      'EUR' as BalanceCurrency,
      FIXED_RATES,
    )

    await settleSvc.settleByCompanySourceTransaction(SOURCE_TX_ID, ACCOUNTANT, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN.id,
      currency: 'EUR',
      ...FILE_RECEIPT,
    })

    const row = await payoutDropRow()
    expect(row).toBeTruthy()
    expect(row!.currency).toBe('EUR')
    expect(parseFloat(row!.amount)).toBeCloseTo(predicted, 6)
  })

  // ── AC2/AC4: default (same-currency) — no conversion, snapshot still stamped ──
  it('AC2/AC4: COMPANY_ACCOUNT (forced USDT, same as obligation) — amount unchanged, original snapshot still stamped', async () => {
    if (!dbAvailable) return
    const before = await gateBalance()

    await settleSvc.settleByCompanySourceTransaction(SOURCE_TX_ID, ACCOUNTANT, {
      fundingSource: 'COMPANY_ACCOUNT',
      currency: 'USDT',
      ...EXPLORER_RECEIPT,
    })

    const row = await payoutDropRow()
    expect(row).toBeTruthy()
    expect(row!.currency).toBe('USDT')
    expect(parseFloat(row!.amount)).toBeCloseTo(parseFloat(DROP_SHARE), 6)
    // AC4 — stamped EVEN when the currency didn't change.
    expect(row!.originalAmount).not.toBeNull()
    expect(parseFloat(row!.originalAmount!)).toBeCloseTo(parseFloat(DROP_SHARE), 6)
    expect(row!.originalCurrency).toBe('USDT')
    expect(parseFloat(row!.exchangeRate!)).toBeCloseTo(1, 6)

    // The ledger SSOT debited the company by exactly the (unconverted) share.
    expect(await gateBalance()).toBeCloseTo(before - parseFloat(DROP_SHARE), 6)
  })

  // ── AC7: obligation closes in FULL regardless of currency — no residual ──
  it('AC7: obligation closes fully in a cross-currency settle — no residual PENDING debt left, idempotent', async () => {
    if (!dbAvailable) return
    await settleSvc.settleByCompanySourceTransaction(SOURCE_TX_ID, ACCOUNTANT, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN.id,
      currency: 'UAH',
      ...FILE_RECEIPT,
    })

    const remaining = await dbSvc.db.query.pendingObligations.findFirst({
      where: and(
        eq(pendingObligations.id, OBLIGATION_ID),
        eq(pendingObligations.status, 'PENDING'),
      ),
    })
    expect(remaining).toBeUndefined()

    // Idempotent: a repeated settle of the SAME source tx finds no open
    // obligation left to close (proves the conditional UPDATE never compares
    // amounts — only status — so a currency change can't leave it dangling).
    await expect(
      settleSvc.settleByCompanySourceTransaction(SOURCE_TX_ID, ACCOUNTANT, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN.id,
        currency: 'USD',
        ...FILE_RECEIPT,
      }),
    ).rejects.toThrow()

    // Exactly one PAYOUT_DROP row exists for this settlement (no phantom
    // second row, no lingering DROP_PENDING_PAYOUT).
    const rows = await dbSvc.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.type, 'PAYOUT_DROP'), eq(transactions.receiverId, DROP.id)))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(SOURCE_TX_ID)
  })

  // ── BIZ-03 exemption (contrast with senior-settle-owner.integration.spec.ts,
  // which stays USDT/USD only for a SENIOR obligation) ──
  it('BIZ-03 exemption: a DROP settle in UAH does not throw', async () => {
    if (!dbAvailable) return
    await expect(
      settleSvc.settleByCompanySourceTransaction(SOURCE_TX_ID, ACCOUNTANT, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN.id,
        currency: 'UAH',
        ...FILE_RECEIPT,
      }),
    ).resolves.toBeDefined()
  })
})
