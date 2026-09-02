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
 *
 * NOTE on `pool.query(migrationSql)` vs prod's `psql -f`: node-postgres'
 * simple query protocol runs every statement in a plain (no-params) string
 * as ONE implicit transaction — a later statement's failure rolls back
 * every earlier one IN THAT SAME CALL. `psql -f` (no `-1`/`--single-
 * transaction`, as deploy.yml invokes it) does the opposite: each top-level
 * statement autocommits separately, so a failure on the LAST statement (the
 * SR-M-6 fail-loud check below) leaves the backfill it just verified
 * already committed. This file's tests rely on the node-pg behavior (a
 * rejected call here leaves NO new state — see the SR-M-6 block below) —
 * that is a stricter, not weaker, guarantee for what these tests check
 * (no partial writes from a single failed call), so the divergence from
 * prod's autocommit semantics does not undermine what is being verified.
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
//
// Inserted LATER (its own describe block below), NOT in this file's
// beforeAll: SR-M-6 (round 2) made the migration fail LOUD on exactly this
// state, so seeding it up front would make the earlier happy-path tests
// (which re-apply the same migration file) fail too. Real production only
// ever hits this collision once, at the very first apply — this file
// reproduces that ordering instead of an artificial "collision present the
// whole time" fixture.
const LEGACY_USER_C_ID = 'a17a0004-0000-0000-0000-000000000003'
const LEGACY_USER_C_EMAIL = 'Backfill-Legacy-A@Test.Spec'
const LEGACY_USER_C_RESOLVED_EMAIL = 'backfill-legacy-c-resolved@test.spec'

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
      //
      // Only A and B here — see LEGACY_USER_C's comment above for why the
      // collision fixture is seeded later, in its own test block.
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
      // DO NOTHING backfill line, on this repo's real schema. No collision
      // is present yet (see LEGACY_USER_C above), so the SR-M-6 fail-loud
      // check at the end of the file passes silently.
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
      // bare ON CONFLICT DO NOTHING made it a true no-op. (C does not exist
      // yet, so it contributes nothing to this count.)
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

    // ── SR-M-6 (security-review PR #623 round 2, MED) ──────────────────────
    // The bare `ON CONFLICT DO NOTHING` backfill still skips the
    // later-ordered user of a case-collision pair — that half of SR-H-1's
    // fix is unchanged. What changed: the migration no longer reports
    // success while doing that. A verify block right after the backfill now
    // RAISES with a COUNT of users still missing a WORK row (never their
    // addresses — this file's console output is a PUBLIC deploy log; see
    // the migration file's own AGGREGATE-ONLY comment on that block), and
    // `psql -v ON_ERROR_STOP=1` (deploy.yml) turns that into a red,
    // actionable deploy-job failure instead of a silent lockout discovered
    // from a support ticket.

    describe('a pre-existing case collision (LEGACY_USER_C vs LEGACY_USER_A)', () => {
      it('makes the migration FAIL LOUD instead of silently leaving the loser without a WORK row', async () => {
        // Introduce the collision NOW — after A already has a committed WORK
        // row from the earlier tests, so the backfill's deterministic
        // ordering (`created_at, id`) makes C the later-ordered, losing side.
        await db.insert(users).values({
          id: LEGACY_USER_C_ID,
          email: LEGACY_USER_C_EMAIL,
          displayName: 'Backfill Legacy C (case-collides with A)',
          role: 'JUNIOR',
        })

        await expect(pool.query(migrationSql)).rejects.toThrow(
          /user_emails backfill: 1 user\(s\) still have no WORK row/,
        )

        // The rejected call's own statements — including the no-op INSERT
        // attempt for C — all rolled back together (see the file-header
        // note on node-pg's implicit transaction for a multi-statement
        // string): C still has no WORK row at all.
        const rowC = await db.query.userEmails.findFirst({
          where: eq(userEmails.userId, LEGACY_USER_C_ID),
        })
        expect(rowC).toBeUndefined()

        // A — the pair's WINNER — is completely unaffected: still the same
        // login-enabled WORK row it has had since the earlier "running the
        // real migration file backfills…" test.
        const rowA = await db.query.userEmails.findFirst({
          where: eq(userEmails.userId, LEGACY_USER_A_ID),
        })
        expect(rowA?.email).toBe(LEGACY_USER_A_EMAIL)
        expect(rowA?.canLogin).toBe(true)
      })

      it('keeps the affected email OUT of the raised error — this file is applied via a step whose console output is a PUBLIC GitHub Actions log, and this repo already has the row-level version of this exact leak on record (2026-08-12_admin_income_drop_backfill_report.sql, PR #517 HIGH-3)', async () => {
        // C is still present from the previous test in this block (not
        // cleaned up mid-describe — afterAll handles it). Re-running the
        // migration hits the exact same collision again — the error carries
        // a COUNT, never the address.
        let caught: unknown
        try {
          await pool.query(migrationSql)
        } catch (err) {
          caught = err
        }
        expect(caught, 'expected the same collision to raise again').toBeInstanceOf(Error)
        const message = (caught as Error).message
        expect(message).toMatch(/user_emails backfill: 1 user\(s\) still have no WORK row/)
        expect(
          message,
          'the raised message must not leak the colliding email address into a public deploy log',
        ).not.toContain(LEGACY_USER_C_EMAIL)
      })

      it('the affected email IS still discoverable — by running the VERIFY query below the fail-loud block BY HAND (never auto-printed)', async () => {
        // This is the operator's actual recovery path: the raised error
        // (previous test) only ever says "1 user(s)". This query — the exact
        // one documented in the migration file's own VERIFY section — is how
        // an owner turns that count into a name, on their own terminal.
        const skipped = await pool.query<{ id: string; email: string }>(
          `SELECT u.id, u.email FROM users u
           WHERE u.id = ANY($1)
             AND NOT EXISTS (
               SELECT 1 FROM user_emails ue WHERE ue.user_id = u.id AND ue.kind = 'WORK'
             )`,
          [[LEGACY_USER_A_ID, LEGACY_USER_C_ID]],
        )
        expect(skipped.rows).toHaveLength(1)
        expect(skipped.rows[0]?.email).toBe(LEGACY_USER_C_EMAIL)
      })

      it('re-applying after the collision is resolved by hand succeeds cleanly — fail-loud is not sticky', async () => {
        // The documented resolution (this file's own "Case collisions in
        // existing data" section, and its VERIFY footer): correct whichever
        // of the two addresses is the actual typo/dupe. Simulated here by
        // renaming C's `users.email` to something that no longer collides —
        // exactly the operator action the migration's header describes, not
        // a test-only shortcut (deleting the user would sidestep the
        // "resolve and re-apply" path entirely).
        await db
          .update(users)
          .set({ email: LEGACY_USER_C_RESOLVED_EMAIL })
          .where(eq(users.id, LEGACY_USER_C_ID))

        await expect(pool.query(migrationSql)).resolves.toBeDefined()

        const rowC = await db.query.userEmails.findFirst({
          where: eq(userEmails.userId, LEGACY_USER_C_ID),
        })
        expect(rowC?.email).toBe(LEGACY_USER_C_RESOLVED_EMAIL)
        expect(rowC?.kind).toBe('WORK')
        expect(rowC?.canLogin).toBe(true)

        // A is still untouched by any of this.
        const rowA = await db.query.userEmails.findFirst({
          where: eq(userEmails.userId, LEGACY_USER_A_ID),
        })
        expect(rowA?.email).toBe(LEGACY_USER_A_EMAIL)
      })
    })
  },
)
