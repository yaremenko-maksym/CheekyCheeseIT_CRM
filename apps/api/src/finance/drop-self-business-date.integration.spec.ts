/**
 * Real-DB spec for the DROP self-feeds' business-date window and ordering
 * (CR-809-M-6, retro review of PR #809).
 *
 * WHY THIS FILE EXISTS. Before this change `getDropSelfIncomes` read every one
 * of the caller's rows and filtered the from/to window in JS over `createdAt`.
 * Both halves were wrong: `createdAt` is the date the row was ENTERED, not the
 * date the money happened, so a backdated row fell into the bucket for the
 * wrong month — contradicting the date the same row shows in the finance
 * tables — and the filter did no work for the database.
 *
 * The window is now a SQL predicate on `coalesce(tx_date, created_at)`. That
 * moved the boundary semantics out of JS and into a comparison Postgres
 * performs, which is why these cases live in a real-DB spec: the mocked facade
 * spec (`transactions.drop-self-feeds.spec.ts`) uses a stub whose `findMany`
 * ignores its `where`, so it structurally cannot observe a SQL predicate — it
 * would return every canned row and pass by being blind.
 *
 * WHAT it covers:
 *   - a row whose business date is inside the window but whose `createdAt` is
 *     outside it IS returned, and the mirror case is NOT (the two rows that can
 *     tell the two columns apart at all);
 *   - the inclusive edges: `from` from that day's 00:00:00 UTC, `to` through
 *     its 23:59:59.999 — including a row at noon on the `to` day, the
 *     regression MED review finding code-review-2 fixed;
 *   - rows with a NULL `tx_date` (everything predating #809) still window by
 *     `created_at` through the coalesce fallback;
 *   - ordering is newest-business-date first, so the page order matches the
 *     date column the client renders;
 *   - `txDate` reaches the DTO, for incomes and for payments.
 *
 * DB-SKIP-GUARD:
 *   describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is unset (reports
 *   SKIPPED). A DATABASE_URL that IS set but unusable throws in beforeAll
 *   (reports FAILED). Neither case can look like "passed" with zero assertions.
 *
 * SEED strategy: UUID namespace bd700000-* — distinct from other specs.
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DropIncomesQuery, SessionUser } from '@crm/shared'
import { dropIncomesQuerySchema, dropIncomeDtoSchema, dropPaymentDtoSchema } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { DropSelfService } from './drop-self.service'
import { transactions, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

const DROP_USER: SessionUser = {
  id: 'bd700000-0000-4000-aa00-000000000001',
  email: 'bd-drop@test.spec',
  displayName: 'BD Drop',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

// ── Income fixtures ─────────────────────────────────────────────────────────
// The window under test is June 2026 (`from: 2026-06-01`, `to: 2026-06-30`).
// Each row states where `createdAt` sits and where the BUSINESS date sits, and
// the two are deliberately on opposite sides for the first two.
const IN_BY_TXDATE = 'bd700001-0000-4000-b000-000000000001' // created JULY, dated 15 JUN → IN
const OUT_BY_TXDATE = 'bd700001-0000-4000-b000-000000000002' // created 15 JUN, dated JULY → OUT
const IN_BY_FALLBACK = 'bd700001-0000-4000-b000-000000000003' // created 10 JUN, NO tx_date → IN
const OUT_BY_FALLBACK = 'bd700001-0000-4000-b000-000000000004' // created MAY, NO tx_date → OUT
const EDGE_FROM_FIRST_INSTANT = 'bd700001-0000-4000-b000-000000000005' // dated 01 JUN 00:00:00.000 → IN
const EDGE_FROM_ONE_MS_BEFORE = 'bd700001-0000-4000-b000-000000000006' // dated 31 MAY 23:59:59.999 → OUT
const EDGE_TO_NOON = 'bd700001-0000-4000-b000-000000000007' // dated 30 JUN 12:30 → IN
const EDGE_TO_LAST_INSTANT = 'bd700001-0000-4000-b000-000000000008' // dated 30 JUN 23:59:59.999 → IN
const EDGE_TO_ONE_MS_AFTER = 'bd700001-0000-4000-b000-000000000009' // dated 01 JUL 00:00:00.000 → OUT

const PAYMENT_DATED = 'bd700002-0000-4000-b000-000000000001'
const PAYMENT_UNDATED = 'bd700002-0000-4000-b000-000000000002'

const ALL_TX_IDS = [
  IN_BY_TXDATE,
  OUT_BY_TXDATE,
  IN_BY_FALLBACK,
  OUT_BY_FALLBACK,
  EDGE_FROM_FIRST_INSTANT,
  EDGE_FROM_ONE_MS_BEFORE,
  EDGE_TO_NOON,
  EDGE_TO_LAST_INSTANT,
  EDGE_TO_ONE_MS_AFTER,
  PAYMENT_DATED,
  PAYMENT_UNDATED,
]

/** The ids the June window must return, newest business date first. */
const EXPECTED_IN_WINDOW = [
  EDGE_TO_LAST_INSTANT, // 30 Jun 23:59:59.999
  EDGE_TO_NOON, // 30 Jun 12:30
  IN_BY_TXDATE, // 15 Jun
  IN_BY_FALLBACK, // 10 Jun (via created_at)
  EDGE_FROM_FIRST_INSTANT, // 01 Jun 00:00:00.000
]

const JUNE = { from: '2026-06-01', to: '2026-06-30' }

function q(overrides: Partial<DropIncomesQuery> = {}): DropIncomesQuery {
  return dropIncomesQuerySchema.parse(overrides)
}

let _pool: Pool | null = null
let svc: DropSelfService

describe.skipIf(!hasDatabaseUrl())(
  'CR-809-M-6 — DROP self-feeds window and order on the business date (real-DB)',
  () => {
    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        await probe.end()
      } catch {
        throw new Error(
          '[drop-self-business-date] FAILED — no DB reachable at DATABASE_URL (expected in CI unit job)',
        )
      }

      _pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      const db = drizzle(_pool, { schema })

      const dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
      Object.assign(dbSvc, { pool: _pool, db })
      // The NBU rates are irrelevant to the feeds under test (only
      // `getDropSelfSummary` converts currency), so a flat stub keeps this spec
      // off the network.
      svc = new DropSelfService(dbSvc, {
        getRates: () => Promise.resolve({}),
      } as never)

      await db
        .insert(users)
        .values({
          id: DROP_USER.id,
          email: DROP_USER.email,
          displayName: DROP_USER.displayName,
          role: 'DROP',
          seniorSharePercent: 0,
          dropSharePercent: 5,
        })
        .onConflictDoNothing()

      // Clean first so a re-run against a seeded scratch DB starts from a known
      // state rather than colliding on the primary key.
      await db.delete(transactions).where(inArray(transactions.id, ALL_TX_IDS))

      const income = (id: string, createdAt: string, txDate: string | null, amount: string) => ({
        id,
        type: 'DROP_INCOME' as const,
        status: 'PENDING' as const,
        amount,
        currency: 'USDT',
        receiverId: DROP_USER.id,
        recipientId: DROP_USER.id,
        senderLabel: 'BD Client Co',
        createdAt: new Date(createdAt),
        txDate: txDate ? new Date(txDate) : null,
        createdBy: DROP_USER.id,
      })

      await db.insert(transactions).values([
        income(IN_BY_TXDATE, '2026-07-05T09:00:00.000Z', '2026-06-15T00:00:00.000Z', '100'),
        income(OUT_BY_TXDATE, '2026-06-15T09:00:00.000Z', '2026-07-05T00:00:00.000Z', '200'),
        income(IN_BY_FALLBACK, '2026-06-10T09:00:00.000Z', null, '300'),
        income(OUT_BY_FALLBACK, '2026-05-10T09:00:00.000Z', null, '400'),
        income(
          EDGE_FROM_FIRST_INSTANT,
          '2026-07-01T09:00:00.000Z',
          '2026-06-01T00:00:00.000Z',
          '500',
        ),
        income(
          EDGE_FROM_ONE_MS_BEFORE,
          '2026-07-01T09:00:00.000Z',
          '2026-05-31T23:59:59.999Z',
          '600',
        ),
        income(EDGE_TO_NOON, '2026-05-01T09:00:00.000Z', '2026-06-30T12:30:00.000Z', '700'),
        income(EDGE_TO_LAST_INSTANT, '2026-05-01T09:00:00.000Z', '2026-06-30T23:59:59.999Z', '800'),
        income(EDGE_TO_ONE_MS_AFTER, '2026-05-01T09:00:00.000Z', '2026-07-01T00:00:00.000Z', '900'),
        // Outgoing payments (drop → company): `senderId`-scoped, type PAYOUT.
        {
          id: PAYMENT_DATED,
          type: 'PAYOUT' as const,
          status: 'PAID' as const,
          amount: '1000',
          currency: 'USDT',
          senderId: DROP_USER.id,
          createdAt: new Date('2026-07-05T09:00:00.000Z'),
          txDate: new Date('2026-06-20T00:00:00.000Z'),
          createdBy: DROP_USER.id,
        },
        {
          id: PAYMENT_UNDATED,
          type: 'PAYOUT' as const,
          status: 'PAID' as const,
          amount: '1100',
          currency: 'USDT',
          senderId: DROP_USER.id,
          createdAt: new Date('2026-08-01T09:00:00.000Z'),
          txDate: null,
          createdBy: DROP_USER.id,
        },
      ])
    })

    afterAll(async () => {
      if (!_pool)
        throw new Error(
          '[require-real-db] _pool not initialized — beforeAll should have thrown already',
        )
      const db = drizzle(_pool, { schema })
      await db.delete(transactions).where(inArray(transactions.id, ALL_TX_IDS))
      await db.delete(users).where(inArray(users.id, [DROP_USER.id]))
      await _pool.end()
      _pool = null
    })

    /** Ids the June window returns, in the order the service returned them. */
    async function juneIds(): Promise<string[]> {
      const res = await svc.getDropSelfIncomes(DROP_USER, q({ ...JUNE, limit: 100 }))
      return res.items.map((i) => i.id)
    }

    // ── the business-date key ────────────────────────────────────────────────

    it('returns a row dated inside the window though it was created after it', async () => {
      expect(await juneIds()).toContain(IN_BY_TXDATE)
    })

    it('omits a row created inside the window but dated after it', async () => {
      // The mirror of the case above. A `created_at` window returns this row and
      // drops the other, so the two together pin the column rather than the
      // accident of one fixture's dates.
      expect(await juneIds()).not.toContain(OUT_BY_TXDATE)
    })

    it('windows a NULL tx_date row by created_at through the coalesce fallback', async () => {
      const ids = await juneIds()
      // Every row predating #809 has a NULL tx_date; without the fallback they
      // would all vanish from every window at once.
      expect(ids).toContain(IN_BY_FALLBACK)
      expect(ids).not.toContain(OUT_BY_FALLBACK)
    })

    // ── inclusive edges ─────────────────────────────────────────────────────

    it('includes the first instant of the `from` day and excludes the ms before it', async () => {
      const ids = await juneIds()
      expect(ids).toContain(EDGE_FROM_FIRST_INSTANT)
      expect(ids).not.toContain(EDGE_FROM_ONE_MS_BEFORE)
    })

    it('includes noon and the last ms of the `to` day, and excludes the ms after', async () => {
      const ids = await juneIds()
      // Noon on the `to` day is the regression MED review finding code-review-2
      // fixed: `Date.parse('YYYY-MM-DD')` is that day's midnight, so without the
      // +86_399_999 ms extension everything after 00:00:00 on the last day was
      // dropped.
      expect(ids).toContain(EDGE_TO_NOON)
      expect(ids).toContain(EDGE_TO_LAST_INSTANT)
      expect(ids).not.toContain(EDGE_TO_ONE_MS_AFTER)
    })

    it('returns exactly the five in-window rows and nothing else', async () => {
      // The whole window in one assertion, so a predicate that widened or
      // narrowed in some way none of the cases above happens to probe still
      // fails. The expected list is written out by hand from the fixture
      // comments, not derived from the service's own answer.
      expect((await juneIds()).slice().sort()).toEqual(EXPECTED_IN_WINDOW.slice().sort())
    })

    // ── ordering ────────────────────────────────────────────────────────────

    it('orders the page newest business date first', async () => {
      // Three of these five rows are ordered the OTHER way round by created_at
      // (EDGE_TO_NOON and EDGE_TO_LAST_INSTANT were created in May, IN_BY_TXDATE
      // in July), so this sequence is only produced by sorting on the business
      // date — which is the date the client renders and sorts by.
      expect(await juneIds()).toEqual(EXPECTED_IN_WINDOW)
    })

    it('orders the payments feed newest business date first', async () => {
      const items = await svc.getDropSelfPayments(DROP_USER)
      const ours = items.filter((p) => p.id === PAYMENT_DATED || p.id === PAYMENT_UNDATED)
      // PAYMENT_UNDATED was created 1 Aug and has no business date, so it
      // coalesces to 1 Aug; PAYMENT_DATED was created 5 Jul but is DATED 20 Jun.
      // By created_at the order is the same, so the discriminating fact is the
      // date each row reports — asserted in the DTO case below.
      expect(ours.map((p) => p.id)).toEqual([PAYMENT_UNDATED, PAYMENT_DATED])
    })

    // ── the DTO carries the business date ───────────────────────────────────

    it('exposes txDate on an income row and parses against the shared schema', async () => {
      const res = await svc.getDropSelfIncomes(DROP_USER, q({ ...JUNE, limit: 100 }))
      const row = res.items.find((i) => i.id === IN_BY_TXDATE)
      expect(row).toBeDefined()
      // The shared schema is the wire contract; parsing here proves the service
      // and `dropIncomeDtoSchema` agree, which is what the web client relies on.
      const parsed = dropIncomeDtoSchema.parse(row)
      expect(parsed.txDate).toBe('2026-06-15T00:00:00.000Z')
      // And the two dates are genuinely different on this row — otherwise the
      // assertion above would hold for a mapper that returned `createdAt`.
      expect(parsed.createdAt).toBe('2026-07-05T09:00:00.000Z')
    })

    it('exposes txDate as null for a row that predates custom dates', async () => {
      const res = await svc.getDropSelfIncomes(DROP_USER, q({ ...JUNE, limit: 100 }))
      const row = res.items.find((i) => i.id === IN_BY_FALLBACK)
      expect(dropIncomeDtoSchema.parse(row).txDate).toBeNull()
    })

    it('exposes txDate on a payment row and parses against the shared schema', async () => {
      const items = await svc.getDropSelfPayments(DROP_USER)
      const dated = items.find((p) => p.id === PAYMENT_DATED)
      const undated = items.find((p) => p.id === PAYMENT_UNDATED)
      expect(dropPaymentDtoSchema.parse(dated).txDate).toBe('2026-06-20T00:00:00.000Z')
      expect(dropPaymentDtoSchema.parse(undated).txDate).toBeNull()
    })

    // ── self-scope is unchanged by any of the above ─────────────────────────

    it('still refuses a non-DROP caller on both feeds', async () => {
      // The window moving into SQL must not have disturbed the RBAC guard that
      // runs before the query. Both feeds are DROP-only.
      const admin: SessionUser = {
        ...DROP_USER,
        id: 'bd700000-0000-4000-aa00-0000000000ff',
        role: 'ADMIN',
      }
      await expect(svc.getDropSelfIncomes(admin, q())).rejects.toMatchObject({
        response: { code: 'FINANCE_DROP_INCOMES_FORBIDDEN', statusCode: 403 },
      })
      await expect(svc.getDropSelfPayments(admin)).rejects.toMatchObject({
        response: { code: 'FINANCE_DROP_PAYMENTS_FORBIDDEN', statusCode: 403 },
      })
    })
  },
)
