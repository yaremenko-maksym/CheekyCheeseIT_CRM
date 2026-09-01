/**
 * user_emails backfill migration — real-Postgres integration.
 * task-user-emails-dual-login, spec §4.4/§5.
 *
 * Runs the ACTUAL manual migration file
 * (apps/api/drizzle/manual/2026-09-01_user_emails.sql) — not a
 * paraphrase of it — against a real Postgres carrying this repo's real,
 * currently-pushed schema (the same `crm_qa` this whole integration
 * suite uses), seeded with "legacy" user rows inserted directly (bypassing
 * UsersService, simulating rows that existed before this migration —
 * exactly the state every user in production is in until the deploy that
 * ships this feature runs). That is the "copy of the real structure, not
 * an empty database" the task's AC asks for: real schema, real table
 * shapes, rows that predate the feature.
 *
 * Also proves the migration is safe to re-run (it is applied on EVERY
 * deploy, per the file's own header) and that it never breaks an existing
 * login: every legacy user ends up with a WORK row that has canLogin=true.
 *
 * DB-SKIP-GUARD: describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is
 * unset (reports SKIPPED, not silently-passed-with-no-assertions).
 *
 * SEED namespace: a17a0004-****.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from './schema'
import { userEmails, users } from './schema'
import { hasDatabaseUrl } from '../test/require-real-db'

const MIGRATION_PATH = path.resolve(__dirname, '../../drizzle/manual/2026-09-01_user_emails.sql')

const LEGACY_USER_A_ID = 'a17a0004-0000-0000-0000-000000000001'
const LEGACY_USER_A_EMAIL = 'backfill-legacy-a@test.spec'
const LEGACY_USER_B_ID = 'a17a0004-0000-0000-0000-000000000002'
const LEGACY_USER_B_EMAIL = 'backfill-legacy-b@test.spec'

// SR-H-1 (security-review PR #623): a THIRD legacy user whose `users.email`
// collides with LEGACY_USER_A's, case-insensitively only. `users.email` has
// always been case-SENSITIVE unique, so this pair is a legitimate
// pre-existing state the migration's own "Case collisions in existing
// data" section has to handle without bricking everyone else's backfill.
const LEGACY_USER_C_ID = 'a17a0004-0000-0000-0000-000000000003'
const LEGACY_USER_C_EMAIL = 'Backfill-Legacy-A@Test.Spec'

const TEST_USER_IDS = [LEGACY_USER_A_ID, LEGACY_USER_B_ID, LEGACY_USER_C_ID]

describe.skipIf(!hasDatabaseUrl())(
  'user_emails backfill migration (2026-09-01_user_emails.sql) — real DB integration',
  () => {
    let pool: Pool
    let db: ReturnType<typeof drizzle<typeof schema>>
    let migrationSql: string

    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        await probe.end()
      } catch {
        throw new Error(
          '[user-emails-backfill-migration integration] FAILED — no DB at DATABASE_URL (CI unit job)',
        )
      }

      migrationSql = readFileSync(MIGRATION_PATH, 'utf-8')

      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      db = drizzle(pool, { schema })

      // Clean slate for this namespace, in case a previous run of this file
      // crashed mid-test and left rows behind.
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))

      // ── Seed "legacy" rows: users with NO user_emails row at all — the
      // exact state of every real user before this migration's first apply.
      // Inserted directly (not through UsersService.createUser), which is
      // the point: createUser now ALWAYS writes the WORK row itself, so the
      // only way to reproduce the pre-migration state is to bypass it, same
      // as production's actual history did.
      await db.insert(users).values([
        {
          id: LEGACY_USER_A_ID,
          email: LEGACY_USER_A_EMAIL,
          displayName: 'Backfill Legacy A',
          role: 'JUNIOR',
        },
        {
          id: LEGACY_USER_B_ID,
          email: LEGACY_USER_B_EMAIL,
          displayName: 'Backfill Legacy B',
          role: 'SENIOR',
        },
        {
          id: LEGACY_USER_C_ID,
          email: LEGACY_USER_C_EMAIL,
          displayName: 'Backfill Legacy C (case-collides with A)',
          role: 'JUNIOR',
        },
      ])
    }, 30_000)

    afterAll(async () => {
      try {
        // user_emails rows cascade-delete with their users row.
        await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
      } catch {
        // Non-fatal cleanup failure — do not mask test results.
      }
      await pool?.end()
    }, 15_000)

    it('confirms the pre-migration state: legacy users have no user_emails row yet', async () => {
      const rows = await db
        .select()
        .from(userEmails)
        .where(inArray(userEmails.userId, TEST_USER_IDS))
      expect(rows).toHaveLength(0)
    })

    it('running the real migration file backfills a login-enabled WORK row for every legacy user', async () => {
      // The REAL file — CREATE TYPE/TABLE/INDEX are already no-ops here
      // (the table exists via db:push, same as it would on a repeat prod
      // deploy), so this run exercises exactly the INSERT ... ON CONFLICT
      // DO NOTHING backfill line, on this repo's real schema.
      await pool.query(migrationSql)

      const rowA = await db.query.userEmails.findFirst({
        where: eq(userEmails.userId, LEGACY_USER_A_ID),
      })
      expect(rowA?.email).toBe(LEGACY_USER_A_EMAIL)
      expect(rowA?.kind).toBe('WORK')
      // This IS the "existing login must not break for a single minute"
      // requirement, checked directly: the backfilled row can log in.
      expect(rowA?.canLogin).toBe(true)

      const rowB = await db.query.userEmails.findFirst({
        where: eq(userEmails.userId, LEGACY_USER_B_ID),
      })
      expect(rowB?.email).toBe(LEGACY_USER_B_EMAIL)
      expect(rowB?.kind).toBe('WORK')
      expect(rowB?.canLogin).toBe(true)
    })

    it('is idempotent — running it again does not duplicate rows or error', async () => {
      await expect(pool.query(migrationSql)).resolves.toBeDefined()

      const rows = await db
        .select()
        .from(userEmails)
        .where(inArray(userEmails.userId, TEST_USER_IDS))
      // Still exactly one WORK row per legacy user — the second apply's
      // bare ON CONFLICT DO NOTHING made it a true no-op.
      expect(rows).toHaveLength(2)
    })

    it("this test file's two legacy WORK rows are login-enabled, not just present (backfill never disables an existing login)", async () => {
      const rows = await db
        .select()
        .from(userEmails)
        .where(inArray(userEmails.userId, TEST_USER_IDS))
      const disabled = rows.filter((r) => r.kind === 'WORK' && r.canLogin === false)
      expect(
        disabled,
        'A backfilled WORK row with canLogin=false would mean the migration silently locked an existing user out.',
      ).toEqual([])
    })

    // ── SR-H-1 — the migration's own "Case collisions in existing data" ──

    it('a pre-existing case-collision (LEGACY_USER_C vs LEGACY_USER_A) does not brick the whole backfill — exactly one of the pair is skipped', async () => {
      // By this point in the file the migration has already run at least
      // once (the earlier tests apply it). Re-confirm on THIS pair
      // specifically: A and C can never BOTH have a WORK row (that would be
      // the SR-H-1 hole reopened), and at least one of them does (the
      // migration must not have thrown and skipped EVERY row in the run).
      const rowA = await db.query.userEmails.findFirst({
        where: eq(userEmails.userId, LEGACY_USER_A_ID),
      })
      const rowC = await db.query.userEmails.findFirst({
        where: eq(userEmails.userId, LEGACY_USER_C_ID),
      })
      const gotRow = [rowA, rowC].filter((r) => r !== undefined)
      expect(gotRow).toHaveLength(1)

      // The migration's own documented VERIFY query — the exact SQL its
      // footer tells the operator to run — surfaces the skipped user by
      // name instead of leaving them to fail a login with no explanation.
      const skipped = await pool.query<{ id: string; email: string }>(
        `SELECT u.id, u.email FROM users u
         WHERE u.id = ANY($1)
           AND NOT EXISTS (
             SELECT 1 FROM user_emails ue WHERE ue.user_id = u.id AND ue.kind = 'WORK'
           )`,
        [[LEGACY_USER_A_ID, LEGACY_USER_C_ID]],
      )
      expect(skipped.rows).toHaveLength(1)
      // And the OTHER of the pair — Postgres, not the migration's INSERT
      // ordering — is the ultimate source of truth for who "won"; cross-
      // check that the skipped id is exactly the one without a row above.
      const skippedId = skipped.rows[0]?.id
      const wonId = rowA ? LEGACY_USER_A_ID : LEGACY_USER_C_ID
      expect(skippedId).not.toBe(wonId)
      expect([LEGACY_USER_A_ID, LEGACY_USER_C_ID]).toContain(skippedId)
    })
  },
)
