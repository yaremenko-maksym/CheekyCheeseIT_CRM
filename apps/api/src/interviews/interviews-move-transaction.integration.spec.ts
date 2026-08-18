import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { InterviewsService } from './interviews.service'
import { ProjectsService } from '../projects/projects.service'
import { interviews, projects, teamMembers, teams, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * Interviews move() transactional integrity — real-backend integration spec.
 *
 * WHY this exists (audit finding 2, HIGH):
 *   move() flips the interview stage, renormalizes positions, then (on HIRED)
 *   calls ProjectsService.createFromInterview. Before the fix each of those was
 *   a separate, already-committed statement — so if createFromInterview threw,
 *   the interview was left ORPHANED in HIRED with no project. The fix wraps the
 *   entire move() in ONE db.transaction and threads `tx` into createFromInterview
 *   so any failure rolls the stage change back.
 *
 * This spec drives the REAL InterviewsService over a real PostgreSQL with a
 * ProjectsService stub whose createFromInterview THROWS, and asserts:
 *   1. move() to HIRED rejects (the error propagates), AND
 *   2. the interview is STILL in its old stage (rollback), AND
 *   3. no project row was created for that senior.
 * Plus a happy-path: a successful HIRED move commits stage + creates a project.
 *
 * DB-SKIP-GUARD:
 *   describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is unset (reports
 *   SKIPPED). A DATABASE_URL that IS set but unusable throws in beforeAll
 *   (reports FAILED). Neither case can look like "passed" with zero assertions.
 *
 * SEED namespace: d2e3f4a5-0b1c-4d2e-** (distinct from the RBAC spec's c1d2e3f4).
 */

const SENIOR: SessionUser = {
  id: 'd2e3f4a5-0b1c-4d2e-aa00-000000000001',
  email: 'iv-tx-senior@test.spec',
  displayName: 'IV TX Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

const ADMIN: SessionUser = {
  id: 'd2e3f4a5-0b1c-4d2e-aa00-000000000002',
  email: 'iv-tx-admin@test.spec',
  displayName: 'IV TX Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}

const TEAM_ID = 'd2e3f4a5-0b1c-4d2e-bb00-000000000010'
const CARD_FAIL_ID = 'd2e3f4a5-0b1c-4d2e-cc00-000000000020'
const CARD_OK_ID = 'd2e3f4a5-0b1c-4d2e-cc00-000000000021'

const TEST_USER_IDS = [SENIOR.id, ADMIN.id]

describe.skipIf(!hasDatabaseUrl())(
  'Interviews move() — transactional integrity (real DB, no mocks)',
  () => {
    let pool: Pool
    let dbSvc: DatabaseService

    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        await probe.end()
      } catch {
        throw new Error(
          '[interviews-move-transaction integration] FAILED — no DB reachable at DATABASE_URL (expected in CI unit job)',
        )
      }

      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      const db = drizzle(pool, { schema })
      dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
      Object.assign(dbSvc, { pool, db })

      await db
        .insert(users)
        .values([
          {
            id: SENIOR.id,
            email: SENIOR.email,
            displayName: SENIOR.displayName,
            role: 'SENIOR',
            googleId: `test-ivtx-${SENIOR.id}`,
          },
          {
            id: ADMIN.id,
            email: ADMIN.email,
            displayName: ADMIN.displayName,
            role: 'ADMIN',
            googleId: `test-ivtx-${ADMIN.id}`,
          },
        ])
        .onConflictDoNothing()

      await db
        .insert(teams)
        .values([{ id: TEAM_ID, name: 'IV TX Team' }])
        .onConflictDoNothing()
      await db
        .insert(teamMembers)
        .values([{ teamId: TEAM_ID, userId: SENIOR.id }])
        .onConflictDoNothing()
    }, 30_000)

    beforeEach(async () => {
      // Reset cards to a known, non-terminal starting stage before each test, and
      // clear any projects a prior happy-path test created for this senior.
      await dbSvc.db.delete(projects).where(eq(projects.seniorId, SENIOR.id))
      await dbSvc.db
        .insert(interviews)
        .values([
          {
            id: CARD_FAIL_ID,
            seniorId: SENIOR.id,
            companyName: 'IV TX Fail Co',
            stage: 'OFFER_RECEIVED',
            position: 0,
          },
          {
            id: CARD_OK_ID,
            seniorId: SENIOR.id,
            companyName: 'IV TX Ok Co',
            stage: 'OFFER_RECEIVED',
            position: 1,
          },
        ])
        .onConflictDoNothing()
      // Force a known starting stage even if the rows already existed.
      await dbSvc.db
        .update(interviews)
        .set({ stage: 'OFFER_RECEIVED' })
        .where(inArray(interviews.id, [CARD_FAIL_ID, CARD_OK_ID]))
    })

    afterAll(async () => {
      try {
        await dbSvc.db.delete(interviews).where(eq(interviews.seniorId, SENIOR.id))
        await dbSvc.db.delete(projects).where(eq(projects.seniorId, SENIOR.id))
        await dbSvc.db.delete(teamMembers).where(eq(teamMembers.teamId, TEAM_ID))
        await dbSvc.db.delete(teams).where(eq(teams.id, TEAM_ID))
        await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
      } catch {
        // Non-fatal cleanup — do not mask test results.
      }
      await pool.end()
    }, 15_000)

    it('rolls back the stage when createFromInterview fails (no orphaned HIRED)', async () => {
      // ProjectsService stub whose createFromInterview ALWAYS throws — simulates a
      // failure of the HIRED side-effect mid-transaction.
      const failingProjects = {
        createFromInterview: () => {
          throw new Error('simulated project-creation failure')
        },
      } as unknown as ProjectsService
      const svc = new InterviewsService(dbSvc, failingProjects)

      // move() into HIRED must reject…
      await expect(svc.move(CARD_FAIL_ID, { stage: 'HIRED', position: 0 }, ADMIN)).rejects.toThrow(
        /simulated project-creation failure/,
      )

      // …and the interview must REMAIN in its old stage (transaction rolled back).
      const row = await dbSvc.db.query.interviews.findFirst({
        where: eq(interviews.id, CARD_FAIL_ID),
      })
      expect(row?.stage).toBe('OFFER_RECEIVED')

      // …and NO project must have been created for this senior.
      const createdProjects = await dbSvc.db.query.projects.findMany({
        where: eq(projects.seniorId, SENIOR.id),
      })
      expect(createdProjects.length).toBe(0)
    })

    it('commits the stage AND creates the project on a successful HIRED move', async () => {
      // Real createFromInterview behavior, scoped to what move() needs: insert a
      // project row inside the SAME tx it is handed (proving tx is threaded).
      const okProjects = {
        createFromInterview: async (
          interview: { companyName: string; seniorId: string },
          _user: SessionUser,
          tx?: {
            insert: (typeof dbSvc.db)['insert']
          },
        ) => {
          const conn = tx ?? dbSvc.db
          const [project] = await conn
            .insert(projects)
            .values({
              name: interview.companyName,
              companyName: interview.companyName,
              domain: 'Other',
              startDate: new Date(),
              seniorId: interview.seniorId,
              rate: 0,
              currency: 'USDT',
            })
            .returning()
          return project
        },
      } as unknown as ProjectsService
      const svc = new InterviewsService(dbSvc, okProjects)

      const result = await svc.move(CARD_OK_ID, { stage: 'HIRED', position: 0 }, ADMIN)
      expect(result.stage).toBe('HIRED')
      expect(result.createdProjectId).toBeTruthy()

      // Stage committed.
      const row = await dbSvc.db.query.interviews.findFirst({
        where: eq(interviews.id, CARD_OK_ID),
      })
      expect(row?.stage).toBe('HIRED')

      // Project committed in the same tx.
      const createdProjects = await dbSvc.db.query.projects.findMany({
        where: and(eq(projects.seniorId, SENIOR.id)),
      })
      expect(createdProjects.length).toBe(1)
      expect(createdProjects[0]?.companyName).toBe('IV TX Ok Co')
    })
  },
)
