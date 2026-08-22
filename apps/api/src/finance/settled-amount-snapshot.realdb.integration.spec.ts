/**
 * task-settled-amount-snapshot — MED-A (security-review round 2, PR #599).
 *
 * THE GAP THIS FILE CLOSES
 * -------------------------
 * `pending-settlement.spec.ts`'s AC7 "monotonic chain" test proves nothing
 * about the DB-native `coalesce(transactions.settled_amount, 0) + delta`
 * increment on real Postgres. Its hand-rolled mock's `resolveSettledAmountPatch`
 * inspects the drizzle `sql` fragment's `queryChunks`, finds the first
 * `number` in the array, and computes `prior + delta` ITSELF — the SQL TEXT
 * never enters the picture at all. Round-2 review verified this empirically:
 * that mock returns the identical `'680.000000'` for the real fragment AND
 * for four broken variants, including `col + d` (no `coalesce` — would write
 * NULL on a first-ever settle on real Postgres) and a bare `${d}` (a silent
 * OVERWRITE — exactly the bug AC7 exists to catch). The unit-test "proof"
 * therefore proved nothing about monotonicity; it only proved the MOCK can
 * add two numbers.
 *
 * This spec is the fix: it calls `PendingSettlementService.settleByCompany`
 * TWICE against a REAL Postgres — through the REAL DB-native UPDATE — and
 * reads `settled_amount` back with a FRESH `SELECT` afterwards. The database
 * itself is the assertion, not our interpretation of a fragment's shape.
 *
 * Scenario mirrors the unit-test's AC7 chain exactly: settle(560) → simulate
 * a cascade reopen (task 3, not built yet — same direct-DB-write technique
 * the unit test uses, since there is no app code to perform it) → settle a
 * delta(120) on the SAME source row → assert the row's `settled_amount` is
 * `680.000000` (560+120), never `120.000000` (an overwrite) and never NULL
 * (a `coalesce`-less increment on the first settle would have produced that).
 *
 * MANUALLY VERIFIED (not asserted in-repo — the whole point is that a REAL
 * Postgres run, not another mock, is what proves this): temporarily swapping
 * the service's `settledAmount: sql\`coalesce(...) + ...\`` for each of the
 * four broken variants the reviewer listed turns this spec red — see the
 * Coder's final report for the transcript.
 *
 * RUN — this repo's port 5432 has TWO Postgres instances answering (a native
 * Homebrew install shadows the docker-compose container on the loopback
 * address specifically — see integration-db-guard.ts's docblock). Connect via
 * the host's LAN IP (or any address the native instance did not bind), never
 * bare `127.0.0.1`/`localhost`, and confirm the reported version is 16.x
 * before trusting the result:
 *   createdb -h <docker-postgres-reachable-host> -p 5432 -U crm_user crm_scratch_x
 *   DATABASE_URL=postgresql://crm_user:password@<host>:5432/crm_scratch_x \
 *     pnpm --filter @crm/api db:push
 *   DATABASE_URL=postgresql://crm_user:password@<host>:5432/crm_scratch_x \
 *     pnpm --filter @crm/api exec vitest run settled-amount-snapshot.realdb.integration.spec
 */
import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { PendingSettlementService } from './pending-settlement.service'
import type { InvoicesService } from '../invoices/invoices.service'
import type { NbuCurrencyService } from './nbu-currency.service'
import { companyAccount, pendingObligations, transactions, users } from '../database/schema'
import * as schema from '../database/schema'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'

// ── Stable id namespace sas599- (task-settled-amount-snapshot, PR #599) ─────
const ADMIN_ID = 'a5990000-0000-4000-aa00-000000000001'
const SENIOR_ID = 'a5990000-0000-4000-aa00-000000000002'
const ALL_USER_IDS = [ADMIN_ID, SENIOR_ID] as const

const SOURCE_TX_ID = 'a5990000-0000-4000-cc00-000000000001'
const OBLIGATION_ID = 'a5990000-0000-4000-dd00-000000000001'
const DELTA_OBLIGATION_ID = 'a5990000-0000-4000-dd00-000000000002'
const DEPOSIT_LABEL = 'sas599-spec-deposit'
const WALLET = '0xC0FFEE0000000000000000000000000000000f99'

const ADMIN_ACTOR: SessionUser = {
  id: ADMIN_ID,
  email: 'sas599-admin@test.spec',
  displayName: 'SAS599 Admin',
  avatarUrl: null,
  avatarDocumentId: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}

const stubInvoices = {
  autoCreateForSeniorPayout: () => Promise.resolve(),
} as unknown as InvoicesService
const stubNbu = {
  getRates: () =>
    Promise.reject(new Error('sas599: getRates must never be called for a SENIOR settle')),
} as unknown as NbuCurrencyService

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
          configurable: true,
        })
        Object.defineProperty(instance, 'onModuleDestroy', {
          value: () => Promise.resolve(),
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
      useFactory: (db: DatabaseService) => new PendingSettlementService(db, stubInvoices, stubNbu),
      inject: [DatabaseService],
    },
  ],
})
class Sas599Module {}

describe.skipIf(!hasDatabaseUrl())(
  'settleByCompany — settled_amount DB-native increment, REAL Postgres (task-settled-amount-snapshot, MED-A)',
  () => {
    let settleSvc: PendingSettlementService
    let dbSvc: DatabaseService

    async function wipe(): Promise<void> {
      const db = dbSvc.db
      await db
        .delete(pendingObligations)
        .where(inArray(pendingObligations.creditorUserId, [...ALL_USER_IDS]))
      await db.delete(transactions).where(eq(transactions.senderLabel, DEPOSIT_LABEL))
      await db.delete(transactions).where(inArray(transactions.createdBy, [...ALL_USER_IDS]))
      await db.delete(users).where(inArray(users.id, [...ALL_USER_IDS]))
    }

    async function readSourceTx() {
      const [row] = await dbSvc.db
        .select({
          settledAmount: transactions.settledAmount,
          settledCurrency: transactions.settledCurrency,
          settledSharePercent: transactions.settledSharePercent,
          status: transactions.status,
          type: transactions.type,
        })
        .from(transactions)
        .where(eq(transactions.id, SOURCE_TX_ID))
      return row!
    }

    beforeAll(async () => {
      await assertRealDbSchema([
        { table: 'transactions', column: 'settled_amount' },
        { table: 'transactions', column: 'settled_currency' },
        { table: 'transactions', column: 'settled_share_percent' },
      ])

      const moduleRef = await Test.createTestingModule({ imports: [Sas599Module] }).compile()
      await moduleRef.init()
      settleSvc = moduleRef.get(PendingSettlementService)
      dbSvc = moduleRef.get(DatabaseService)
    })

    beforeEach(async () => {
      await wipe()
      const db = dbSvc.db

      await db.insert(users).values([
        {
          id: ADMIN_ID,
          email: 'sas599-admin@test.spec',
          displayName: 'SAS599 Admin',
          role: 'ADMIN',
          googleId: `g-${ADMIN_ID}`,
        },
        {
          id: SENIOR_ID,
          email: 'sas599-senior@test.spec',
          displayName: 'SAS599 Senior',
          role: 'SENIOR',
          seniorSharePercent: 26,
          googleId: `g-${SENIOR_ID}`,
        },
      ])

      // A funded company account — settleByCompany's balance gate reads it
      // (COMPANY_ACCOUNT funding, the default for a COMPANY debt).
      const existingAccount = await db.query.companyAccount.findFirst()
      if (existingAccount) {
        await db.update(companyAccount).set({ walletAddress: WALLET })
      } else {
        await db.insert(companyAccount).values({ walletAddress: WALLET })
      }
      await db.insert(transactions).values({
        type: 'COMPANY_DEPOSIT',
        status: 'PAID',
        amount: '100000',
        currency: 'USDT',
        senderLabel: DEPOSIT_LABEL,
        createdBy: ADMIN_ID,
      })

      // The source IOU (SENIOR_PENDING_PAYOUT) — inserted directly, same
      // shape `bookCompanyObligations` would produce, so this spec stays
      // scoped to settleByCompany's own write behaviour rather than pulling
      // in the whole income-declaration flow.
      await db.insert(transactions).values({
        id: SOURCE_TX_ID,
        type: 'SENIOR_PENDING_PAYOUT',
        status: 'PENDING_PAYMENT',
        amount: '560',
        currency: 'USDT',
        receiverId: SENIOR_ID,
        recipientId: SENIOR_ID,
        senderLabel: 'COMPANY',
        seniorSharePercent: 26,
        seniorSharePercentSource: 'PROJECT',
        createdBy: ADMIN_ID,
      })
      await db.insert(pendingObligations).values({
        id: OBLIGATION_ID,
        creditorUserId: SENIOR_ID,
        debtorType: 'COMPANY',
        sourceTransactionId: SOURCE_TX_ID,
        amount: '560',
        currency: 'USDT',
        status: 'PENDING',
      })
    })

    afterAll(async () => {
      if (dbSvc) await wipe()
      if (_pool) await _pool.end()
    })

    it('MED-A: two real settles of the SAME row accumulate on real Postgres — 0+560 then 560+120=680, never an overwrite, never NULL', async () => {
      // ── Settle 1: first-ever settle of this row. Proves
      // `coalesce(NULL, 0) + 560` — a `col + d` variant with no `coalesce`
      // would leave this NULL on real Postgres (NULL + anything = NULL);
      // this assertion alone already distinguishes the real fragment from
      // that specific broken variant.
      await settleSvc.settleByCompany(OBLIGATION_ID, ADMIN_ACTOR)
      const afterFirst = await readSourceTx()
      expect(afterFirst.settledAmount).toBe('560.000000')
      expect(afterFirst.settledCurrency).toBe('USDT')
      expect(afterFirst.status).toBe('PAID')
      expect(afterFirst.settledSharePercent).toBe(26)

      // ── Simulated cascade reopen (task 3, not built yet) — same
      // direct-DB-write technique the unit test uses: return the source
      // row to PENDING_PAYMENT, restore the share-percent snapshot (what
      // the future cascade will do per the architecture doc's AC3), and
      // open a NEW obligation for the delta against the SAME source row.
      await dbSvc.db
        .update(transactions)
        .set({
          status: 'PENDING_PAYMENT',
          type: 'SENIOR_PENDING_PAYOUT',
          seniorSharePercent: afterFirst.settledSharePercent,
        })
        .where(eq(transactions.id, SOURCE_TX_ID))
      await dbSvc.db.insert(pendingObligations).values({
        id: DELTA_OBLIGATION_ID,
        creditorUserId: SENIOR_ID,
        debtorType: 'COMPANY',
        sourceTransactionId: SOURCE_TX_ID,
        amount: '120',
        currency: 'USDT',
        status: 'PENDING',
      })

      // ── Settle 2: a SECOND real settle of the SAME row. This is the
      // assertion that actually separates the real fragment from an
      // overwrite (`${d}`) — an overwrite would leave this at
      // '120.000000', not '680.000000'.
      await settleSvc.settleByCompany(DELTA_OBLIGATION_ID, ADMIN_ACTOR)
      const afterSecond = await readSourceTx()
      expect(afterSecond.settledAmount).toBe('680.000000')
      expect(afterSecond.settledCurrency).toBe('USDT')
      expect(afterSecond.status).toBe('PAID')
    }, 30_000)
  },
)
