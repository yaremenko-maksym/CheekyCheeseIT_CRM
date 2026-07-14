import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { createDividendSchema } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { CompanyAccountService } from './company-account.service'
import type { EtherscanService } from './etherscan.service'
import { transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * BIZ-19 — createDividend idempotency: duplicate submission with the same
 * idempotency-key must create exactly ONE dividend row.
 *
 * Approach chosen: explicit client-supplied `idempotencyKey` (UUID) in the
 * request body. The service stores it in `transactions.idempotency_key` with
 * a partial unique index (WHERE type = 'DIVIDEND_TO_ADMIN').
 *
 * On collision the service returns the existing row (no error), which is the
 * standard idempotency-key semantic used in Stripe, PayPal, etc.
 *
 * Rationale for this approach vs. time-window dedup:
 *   - Time-window dedup is ambiguous (how long is "same"?).
 *   - Amount+adminId dedup would block legitimate same-amount dividends.
 *   - Explicit key gives the caller deterministic control and is auditable.
 *
 * Seed namespace: f4a5b6c7-0d1e-4f4a-** (distinct from other specs).
 *
 * DB-SKIP-GUARD: skips when DATABASE_URL is not reachable or idempotency_key
 * column is not yet migrated.
 */

const ADMIN: SessionUser = {
  id: 'f4a5b6c7-0d1e-4f4a-aa00-000000000001',
  email: 'div-idem-admin@test.spec',
  displayName: 'Div Idem Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}

const SENIOR: SessionUser = {
  ...ADMIN,
  id: 'f4a5b6c7-0d1e-4f4a-aa00-000000000002',
  email: 'div-idem-senior@test.spec',
  displayName: 'Div Idem Senior',
  role: 'SENIOR',
}

const ALL = [ADMIN, SENIOR]
const TEST_USER_IDS = ALL.map((u) => u.id)
const DEPOSIT_ID = 'f4a5b6c7-0d1e-4f4a-ac00-000000000001'
const IDEM_KEY_1 = 'f4a5b6c7-0d1e-4f4a-8d00-000000000001'
const IDEM_KEY_2 = 'f4a5b6c7-0d1e-4f4a-8d00-000000000002'
// task-receipts-backend (review round 1): createDividend now requires a
// mandatory explorer-link receipt (USDT-only withdrawal) — orthogonal to the
// idempotency-key behavior this spec exercises.
const DIV_RECEIPT = { receiptExternalUrl: 'https://etherscan.io/tx/0xdividendidempotencyspec' }

const stubEtherscan = {} as unknown as EtherscanService

let _pool: Pool | null = null
let dbAvailable = true

@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (): DatabaseService => {
        _pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 5 })
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
      provide: CompanyAccountService,
      useFactory: (db: DatabaseService) => new CompanyAccountService(db, stubEtherscan),
      inject: [DatabaseService],
    },
  ],
})
class DividendIdemTestModule {}

describe('BIZ-19 — createDividend idempotency-key (real DB)', () => {
  let svc: CompanyAccountService
  let dbSvc: DatabaseService

  async function cleanup() {
    const db = dbSvc.db
    await db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
    await db.delete(transactions).where(inArray(transactions.id, [DEPOSIT_ID]))
  }

  async function countDividends(): Promise<number> {
    const rows = await dbSvc.db
      .select({ c: sql<string>`COUNT(*)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.type, 'DIVIDEND_TO_ADMIN' as never),
          inArray(transactions.createdBy, TEST_USER_IDS),
        ),
      )
    return parseInt(rows[0]?.c ?? '0', 10)
  }

  async function seedDeposit(amount: number) {
    await dbSvc.db.insert(transactions).values({
      id: DEPOSIT_ID,
      type: 'COMPANY_DEPOSIT' as never,
      status: 'PAID' as never,
      amount: String(amount),
      currency: 'USDT' as never,
      senderId: SENIOR.id,
      createdBy: ADMIN.id,
    })
  }

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      // Verify idempotency_key column exists
      const col = await probe.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'transactions' AND column_name = 'idempotency_key' LIMIT 1`,
      )
      await probe.end()
      if (col.rowCount === 0) {
        console.warn(
          '[dividend-idempotency integration] SKIPPED — idempotency_key column not yet migrated',
        )
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[dividend-idempotency integration] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [DividendIdemTestModule],
    }).compile()
    await moduleRef.init()
    svc = moduleRef.get(CompanyAccountService)
    dbSvc = moduleRef.get(DatabaseService)

    const db = dbSvc.db
    await cleanup()
    await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    await db
      .insert(users)
      .values(
        ALL.map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          googleId: `test-google-${u.id}`,
        })),
      )
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      await cleanup()
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal
    }
    await _pool?.end()
  }, 15_000)

  beforeEach(async () => {
    if (!dbAvailable) return
    await cleanup()
  })

  it('same idempotency-key submitted twice → only ONE dividend row, second call returns existing id', async () => {
    if (!dbAvailable) return
    await seedDeposit(100_000)

    const res1 = await svc.createDividend(
      { amount: 100, idempotencyKey: IDEM_KEY_1, ...DIV_RECEIPT },
      ADMIN,
    )
    expect(res1.id).toBeTruthy()
    expect(await countDividends()).toBe(1)

    // Second call with the SAME key — must be a no-op at the DB level
    const res2 = await svc.createDividend(
      { amount: 100, idempotencyKey: IDEM_KEY_1, ...DIV_RECEIPT },
      ADMIN,
    )
    expect(res2.id).toBe(res1.id)
    expect(await countDividends()).toBe(1)
  }, 30_000)

  it('different idempotency-keys create independent rows', async () => {
    if (!dbAvailable) return
    await seedDeposit(100_000)

    await svc.createDividend({ amount: 100, idempotencyKey: IDEM_KEY_1, ...DIV_RECEIPT }, ADMIN)
    await svc.createDividend({ amount: 100, idempotencyKey: IDEM_KEY_2, ...DIV_RECEIPT }, ADMIN)

    expect(await countDividends()).toBe(2)
  }, 30_000)

  it('missing idempotency-key → Zod rejects (400 path)', () => {
    // MED-2: idempotencyKey is REQUIRED. A body without the field must throw
    // a ZodError so the controller maps it to HTTP 400. No DB needed.
    expect(() => createDividendSchema.parse({ amount: 50 })).toThrow()
    expect(() => createDividendSchema.parse({ amount: 50, idempotencyKey: 'not-a-uuid' })).toThrow()
    // Valid UUID passes schema validation
    expect(() =>
      createDividendSchema.parse({ amount: 50, idempotencyKey: IDEM_KEY_1, ...DIV_RECEIPT }),
    ).not.toThrow()
  })

  it('idempotency check ignores amount mismatch — returns existing row without error', async () => {
    if (!dbAvailable) return
    await seedDeposit(100_000)

    const res1 = await svc.createDividend(
      { amount: 100, idempotencyKey: IDEM_KEY_1, ...DIV_RECEIPT },
      ADMIN,
    )
    // Same key, different amount → idempotent return of original
    const res2 = await svc.createDividend(
      { amount: 999, idempotencyKey: IDEM_KEY_1, ...DIV_RECEIPT },
      ADMIN,
    )

    expect(res2.id).toBe(res1.id)
    expect(res2.amount).toBe(100) // original amount preserved
    expect(await countDividends()).toBe(1)
  }, 30_000)

  it('MED-1: concurrent race with same key → one row, both calls succeed (no 500)', async () => {
    // Two simultaneous calls with the same idempotencyKey. Both miss the
    // early-SELECT (executed concurrently before either inserts). Under the
    // advisory lock they serialize: A inserts, B hits the unique index (23505),
    // the catch block re-reads and returns the committed row.
    // Expected: Promise.allSettled resolves BOTH as fulfilled, exactly 1 row.
    if (!dbAvailable) return
    await seedDeposit(100_000)

    const RACE_KEY = 'f4a5b6c7-0d1e-4f4a-ae00-000000000001'

    const results = await Promise.allSettled([
      svc.createDividend({ amount: 100, idempotencyKey: RACE_KEY, ...DIV_RECEIPT }, ADMIN),
      svc.createDividend({ amount: 100, idempotencyKey: RACE_KEY, ...DIV_RECEIPT }, ADMIN),
    ])

    // Both must resolve successfully (no 500, no rejection)
    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('fulfilled')

    const ids = results
      .filter(
        (r): r is PromiseFulfilledResult<{ id: string; amount: number; receiverId: string }> =>
          r.status === 'fulfilled',
      )
      .map((r) => r.value.id)

    // Both return the SAME id (idempotent)
    expect(ids[0]).toBe(ids[1])

    // Exactly ONE DIVIDEND_TO_ADMIN row in the DB
    expect(await countDividends()).toBe(1)
  }, 30_000)
})
