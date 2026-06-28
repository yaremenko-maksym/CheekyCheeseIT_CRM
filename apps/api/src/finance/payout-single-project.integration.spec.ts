import { Global, Module } from '@nestjs/common'
import { BadRequestException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { EtherscanService } from './etherscan.service'
import type { NbuCurrencyService } from './nbu-currency.service'
import { companyAccount, payoutRequests, projects, transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * Audit 2026-06-28 (#5) — REAL-DB integration: a DROP payout must bundle incomes
 * from a SINGLE project.
 *
 * The pay cascade (applyPayoutPaidCascade) reads the FIRST linked income's
 * project as the "primary" and applies THAT project's drop/senior share split to
 * the WHOLE batch. A batch spanning two drop-projects would therefore settle the
 * second project's slice at the first project's percent. createPayoutRequest now
 * rejects (BadRequest, → 400) a DROP batch whose VALIDATED incomes span more than
 * one distinct projectId.
 *
 * Asserts against REAL PostgreSQL (crm_qa scratch — NEVER crm_db):
 *   1. DROP bundling two DROP_INCOME rows from TWO different projects → 400.
 *   2. DROP bundling two DROP_INCOME rows from the SAME project → OK (payout made).
 *
 * Run against the scratch DB:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- payout-single-project.integration
 */

const WALLET = '0xABCD000000000000000000000000000000005501'

const SENIOR: SessionUser = {
  id: 'a5500000-0000-4000-bb00-000000000001',
  email: 'psp-senior@test.spec',
  displayName: 'PSP Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const DROP: SessionUser = {
  ...SENIOR,
  id: 'a5500000-0000-4000-bb00-000000000002',
  email: 'psp-drop@test.spec',
  displayName: 'PSP Drop',
  role: 'DROP',
}

const TEST_USERS = [SENIOR, DROP]
const TEST_USER_IDS = TEST_USERS.map((u) => u.id)
const ACCOUNT_ID = 'a5500000-0000-4000-cc00-000000000001'
const PROJECT_A = 'a5500000-0000-4000-dd00-000000000001'
const PROJECT_B = 'a5500000-0000-4000-dd00-000000000002'
const PROJECT_IDS = [PROJECT_A, PROJECT_B]

const fakeNbu: Pick<NbuCurrencyService, 'getRates'> = {
  getRates: () =>
    Promise.resolve({ usdUah: '40.0000', usdtUah: '40.0000', eurUah: '44.0000', date: '20260628' }),
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
} as never
const stubInvoices = {
  autoCreateForPayout: () => Promise.resolve(),
  autoCreateForSeniorPayout: () => Promise.resolve(),
  autoCreateForSalary: () => Promise.resolve(),
  autoCreateForIncome: () => Promise.resolve(),
} as never

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
      provide: TransactionsService,
      useFactory: (db: DatabaseService) =>
        makeTransactionsService({
          db,
          invoicesService: stubInvoices,
          nbuCurrencyService: fakeNbu as NbuCurrencyService,
          etherscanService: fakeEtherscan as EtherscanService,
        }),
      inject: [DatabaseService],
    },
  ],
})
class PspTestModule {}

describe('createPayoutRequest — #5: DROP payout must be single-project (real DB)', () => {
  let svc: TransactionsService
  let dbSvc: DatabaseService

  async function clearLedger() {
    await dbSvc.db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
    await dbSvc.db.delete(transactions).where(inArray(transactions.receiverId, TEST_USER_IDS))
    await dbSvc.db.delete(payoutRequests).where(inArray(payoutRequests.seniorId, TEST_USER_IDS))
  }

  // Seed a VALIDATED DROP_INCOME for DROP on the given project.
  async function seedValidatedDropIncome(projectId: string, amount: string): Promise<string> {
    await dbSvc.db
      .insert(projects)
      .values({
        id: projectId,
        name: `PSP ${projectId.slice(-4)}`,
        companyName: 'PSP Corp',
        domain: 'fintech',
        startDate: new Date('2025-01-01'),
        seniorId: SENIOR.id,
        dropId: DROP.id,
        currency: 'USDT',
        rate: 1000,
      })
      .onConflictDoNothing()

    const [income] = await dbSvc.db
      .insert(transactions)
      .values({
        type: 'DROP_INCOME',
        status: 'VALIDATED',
        amount,
        currency: 'USDT',
        senderId: null,
        senderLabel: 'PSP Corp',
        receiverId: DROP.id,
        recipientId: DROP.id,
        projectId,
        createdBy: DROP.id,
      })
      .returning()
    return income!.id
  }

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      const check = await probe.query(
        `SELECT table_name FROM information_schema.tables WHERE table_name='payout_requests' LIMIT 1`,
      )
      await probe.end()
      if (check.rowCount === 0) {
        console.warn('[payout-single-project] SKIPPED — payout_requests not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[payout-single-project] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({ imports: [PspTestModule] }).compile()
    await moduleRef.init()
    svc = moduleRef.get(TransactionsService)
    dbSvc = moduleRef.get(DatabaseService)

    const db = dbSvc.db
    await db.delete(projects).where(inArray(projects.id, PROJECT_IDS))
    await clearLedger()
    await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    await db
      .insert(users)
      .values(
        TEST_USERS.map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          seniorSharePercent: u.seniorSharePercent,
          ...(u.role === 'DROP' ? { dropSharePercent: 5 } : {}),
          googleId: `test-google-${u.id}`,
        })),
      )
      .onConflictDoNothing()

    const existing = await db.query.companyAccount.findFirst()
    if (!existing) {
      await db.insert(companyAccount).values({
        id: ACCOUNT_ID,
        walletAddress: WALLET,
        confirmationThreshold: 12,
        updatedBy: SENIOR.id,
      })
    }
  }, 30_000)

  beforeEach(async () => {
    if (!dbAvailable) return
    await clearLedger()
  })

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      await clearLedger()
      await dbSvc.db.delete(projects).where(inArray(projects.id, PROJECT_IDS))
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal
    }
    await _pool?.end()
  }, 15_000)

  it('DROP bundling DROP_INCOME from TWO projects → BadRequest (400)', async () => {
    if (!dbAvailable) return
    const a = await seedValidatedDropIncome(PROJECT_A, '500')
    const b = await seedValidatedDropIncome(PROJECT_B, '300')
    await expect(svc.createPayoutRequest([a, b], DROP)).rejects.toBeInstanceOf(BadRequestException)
    // No payout_request must have been created.
    const pr = await dbSvc.db.query.payoutRequests.findFirst({
      where: (tbl, { eq }) => eq(tbl.seniorId, DROP.id),
    })
    expect(pr).toBeUndefined()
  }, 30_000)

  it('DROP bundling DROP_INCOME from the SAME project → OK (payout created)', async () => {
    if (!dbAvailable) return
    const a = await seedValidatedDropIncome(PROJECT_A, '500')
    const b = await seedValidatedDropIncome(PROJECT_A, '300')
    const pr = await svc.createPayoutRequest([a, b], DROP)
    expect(pr).toBeDefined()
    expect(pr.status).toBe('PENDING')
  }, 30_000)
})
