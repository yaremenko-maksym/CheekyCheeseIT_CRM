/**
 * sender-receiver-invariant.integration.spec.ts — task-sender-receiver-invariant
 * (backlog A-2), AC2 + AC5.
 *
 * Proves, against a REAL Postgres (scratch DB — NEVER crm_db), that the
 * `ck_transactions_sender_ne_receiver` CHECK constraint on `transactions`
 * (`sender_id <> receiver_id`) behaves exactly per its own doc comment in
 * apps/api/src/database/schema.ts — the four-case truth table this task's
 * own instructions warned is easy to get backwards:
 *
 *   AC2-a  both sides set and DIFFERENT           → INSERT succeeds
 *   AC2-b  both sides set and EQUAL               → INSERT rejected (23514)
 *   AC2-c  one side NULL, other set                → INSERT succeeds
 *   AC2-d  BOTH sides NULL (the trap)              → INSERT succeeds
 *
 * AC2-d is the one that is easy to get backwards: `IS DISTINCT FROM` would
 * WRONGLY reject it (`NULL IS DISTINCT FROM NULL` = true → rejected), which
 * would break the overwhelming majority of `transactions` rows that
 * legitimately carry no user FK on one or both sides (senderLabel-only
 * company rows, un-settled obligation rows, …). `<>` (this constraint's
 * actual definition) correctly lets it through — NULL on either side makes
 * `sender_id <> receiver_id` evaluate to SQL NULL, and CHECK only rejects an
 * explicit FALSE.
 *
 * RED-PROOF (AC5): AC2-b's assertion structurally CANNOT pass unless the
 * constraint exists and is defined with `<>` semantics — dropping the
 * constraint (`ALTER TABLE transactions DROP CONSTRAINT
 * ck_transactions_sender_ne_receiver`) or catching this file in an idle
 * moment before this task's migration was applied turns AC2-b red
 * immediately (the insert would succeed, `.rejects.toThrow` fails). The
 * dedicated "constraint definition" test below is the SECOND way it can go
 * red: it reads back the live `pg_constraint` row and asserts the exact SQL
 * text, so a well-meaning "let me just tighten this a bit" edit that swaps
 * in `IS DISTINCT FROM` is caught even if AC2-d is somehow not run.
 *
 * DB-SKIP-GUARD: describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is
 * unset (reports SKIPPED, never silently "passed" — see
 * src/test/require-real-db.ts). A DATABASE_URL that IS set but unusable
 * throws in beforeAll (reports FAILED).
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@<docker-postgres-host>:5432/crm_qa \
 *     pnpm --filter @crm/api exec vitest run sender-receiver-invariant.integration
 */
import { randomUUID } from 'crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { transactions, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

const CONSTRAINT_NAME = 'ck_transactions_sender_ne_receiver'

const USER_A_ID = 'a5100000-0000-4000-a000-000000000001'
const USER_B_ID = 'a5100000-0000-4000-a000-000000000002'
const TEST_USER_IDS = [USER_A_ID, USER_B_ID]

let _pool: Pool | null = null

describe.skipIf(!hasDatabaseUrl())(
  'ck_transactions_sender_ne_receiver — real Postgres CHECK (task-sender-receiver-invariant, backlog A-2)',
  () => {
    let db: ReturnType<typeof drizzle<typeof schema>>

    async function cleanup() {
      await db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    }

    beforeAll(async () => {
      _pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 5 })
      db = drizzle(_pool, { schema })

      // Fail loud (not silently skip) if the constraint this whole file
      // exists to test is not even present on this DATABASE_URL — e.g. a
      // scratch DB that was never `db:push`-ed after this task's schema
      // change. A missing constraint must FAIL this suite, not let every
      // insert below "pass" for the wrong reason (nothing to reject).
      const constraintCheck = await _pool.query(
        `SELECT conname FROM pg_constraint WHERE conname = $1 AND conrelid = 'transactions'::regclass`,
        [CONSTRAINT_NAME],
      )
      if (constraintCheck.rowCount === 0) {
        throw new Error(
          `[sender-receiver-invariant] BLOCKED: constraint "${CONSTRAINT_NAME}" not found on ` +
            `"transactions" at this DATABASE_URL. Run \`pnpm --filter @crm/api db:push\` against ` +
            `it (schema.ts now declares this CHECK) before running this spec.`,
        )
      }

      await cleanup()
      await db.insert(users).values([
        {
          id: USER_A_ID,
          email: 'sri-a@test.spec',
          displayName: 'SRI User A',
          role: 'JUNIOR',
        },
        {
          id: USER_B_ID,
          email: 'sri-b@test.spec',
          displayName: 'SRI User B',
          role: 'JUNIOR',
        },
      ])
    }, 15_000)

    afterAll(async () => {
      try {
        await cleanup()
      } catch {
        // non-fatal
      }
      await _pool?.end()
    }, 15_000)

    it('AC2-a: sender != receiver (both set, different) → INSERT succeeds', async () => {
      const [row] = await db
        .insert(transactions)
        .values({
          type: 'EXPENSE',
          status: 'PAID',
          amount: '10',
          currency: 'USD',
          senderId: USER_A_ID,
          receiverId: USER_B_ID,
          createdBy: USER_A_ID,
        })
        .returning()
      expect(row).toBeDefined()
      expect(row!.senderId).toBe(USER_A_ID)
      expect(row!.receiverId).toBe(USER_B_ID)
    })

    it('AC2-b (RED-PROOF): sender === receiver (both set, EQUAL) → INSERT rejected by the DB CHECK', async () => {
      await expect(
        db.insert(transactions).values({
          type: 'EXPENSE',
          status: 'PAID',
          amount: '10',
          currency: 'USD',
          senderId: USER_A_ID,
          receiverId: USER_A_ID,
          createdBy: USER_A_ID,
        }),
      ).rejects.toMatchObject({
        // drizzle-orm wraps query failures in a DrizzleQueryError — the
        // original pg error (the one carrying `.code`/`.constraint`) lives
        // on `.cause`, same pattern as `isUniqueViolation` in
        // ../database/pg-errors.ts.
        cause: {
          code: '23514', // Postgres check_violation
          constraint: CONSTRAINT_NAME,
        },
      })

      // The row must never have landed — a rejected INSERT should insert
      // nothing (sanity, not a Postgres-transactionality re-test).
      const survivors = await db.query.transactions.findMany({
        where: (t, { and, eq }) => and(eq(t.senderId, USER_A_ID), eq(t.receiverId, USER_A_ID)),
      })
      expect(survivors).toHaveLength(0)
    })

    it('AC2-c: one side NULL (sender set, receiver null) → INSERT succeeds', async () => {
      const [row] = await db
        .insert(transactions)
        .values({
          type: 'EXPENSE',
          status: 'PAID',
          amount: '10',
          currency: 'USD',
          senderId: USER_A_ID,
          receiverId: null,
          receiverLabel: 'Office supplies',
          createdBy: USER_A_ID,
        })
        .returning()
      expect(row).toBeDefined()
      expect(row!.senderId).toBe(USER_A_ID)
      expect(row!.receiverId).toBeNull()
    })

    it('AC2-c (mirror): one side NULL (receiver set, sender null) → INSERT succeeds', async () => {
      const [row] = await db
        .insert(transactions)
        .values({
          type: 'SALARY',
          status: 'PENDING',
          amount: '10',
          currency: 'USD',
          senderId: null,
          receiverId: USER_B_ID,
          createdBy: USER_A_ID,
        })
        .returning()
      expect(row).toBeDefined()
      expect(row!.senderId).toBeNull()
      expect(row!.receiverId).toBe(USER_B_ID)
    })

    it('AC2-d (the trap): BOTH sides NULL → INSERT succeeds (NOT rejected — most rows are shaped like this)', async () => {
      const [row] = await db
        .insert(transactions)
        .values({
          type: 'EXPENSE',
          status: 'PAID',
          amount: '10',
          currency: 'USD',
          senderId: null,
          senderLabel: 'CheekyCheeseIT',
          receiverId: null,
          receiverLabel: 'Office supplies',
          createdBy: USER_A_ID,
        })
        .returning()
      expect(row).toBeDefined()
      expect(row!.senderId).toBeNull()
      expect(row!.receiverId).toBeNull()
    })

    it('the live constraint definition is exactly `<>`, not `IS DISTINCT FROM` (guards against a well-meaning tightening)', async () => {
      const result = await _pool!.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conname = $1 AND conrelid = 'transactions'::regclass`,
        [CONSTRAINT_NAME],
      )
      expect(result.rowCount).toBe(1)
      const def = result.rows[0]!.def
      expect(def).toContain('sender_id <> receiver_id')
      expect(def).not.toContain('IS DISTINCT FROM')
    })

    it('idempotency sanity: the constraint survives a second createdBy-scoped insert/rollback cycle unchanged', async () => {
      // Not a re-run of the manual migration file itself (that is proven by
      // the manual SQL script's own DO-block guards, run by hand against a
      // scratch DB per the task report) — this asserts the constraint stays
      // in force across multiple inserts in the SAME test process, i.e. it
      // is a real, persistent table constraint and not a one-shot statement
      // trigger that only fires once.
      await expect(
        db.insert(transactions).values({
          id: randomUUID(),
          type: 'EXPENSE',
          status: 'PAID',
          amount: '5',
          currency: 'USD',
          senderId: USER_B_ID,
          receiverId: USER_B_ID,
          createdBy: USER_A_ID,
        }),
      ).rejects.toMatchObject({ cause: { code: '23514', constraint: CONSTRAINT_NAME } })
    })
  },
)
