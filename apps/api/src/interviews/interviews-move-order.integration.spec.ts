import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { InterviewsService } from './interviews.service'
import { interviews, teamMembers, teams, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * CR4-M-1 + SPEC-L-1 + SPEC-L-2 — Move position renormalisation integration spec.
 *
 * Verifies that move() places the moved card at the requested target index and that
 * column positions remain distinct (0..n-1), whether moving up or down within a column
 * or between columns, without sliding back on refetch due to createdAt tie-breaking.
 */

const SENIOR: SessionUser = {
  id: 'c7d8e9f0-0b1c-4d2e-aa00-000000000001',
  email: 'iv-order-senior@test.spec',
  displayName: 'IV Order Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

const ADMIN: SessionUser = {
  id: 'c7d8e9f0-0b1c-4d2e-aa00-000000000002',
  email: 'iv-order-admin@test.spec',
  displayName: 'IV Order Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}

const TEAM_ID = 'c7d8e9f0-0b1c-4d2e-bb00-000000000010'
const CARD_X_ID = 'c7d8e9f0-0b1c-4d2e-cc00-000000000020'
const CARD_Y_ID = 'c7d8e9f0-0b1c-4d2e-cc00-000000000021'
const CARD_Z_ID = 'c7d8e9f0-0b1c-4d2e-cc00-000000000022'
const CARD_W_ID = 'c7d8e9f0-0b1c-4d2e-cc00-000000000023'

const CARD_H0_ID = 'c7d8e9f0-0b1c-4d2e-cc00-000000000030'
const CARD_H1_ID = 'c7d8e9f0-0b1c-4d2e-cc00-000000000031'

const TEST_USER_IDS = [SENIOR.id, ADMIN.id]

describe.skipIf(!hasDatabaseUrl())(
  'Interviews move() — position renormalisation outcome (CR4-M-1 real DB)',
  () => {
    let pool: Pool
    let dbSvc: DatabaseService
    let service: InterviewsService

    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        await probe.end()
      } catch {
        throw new Error(
          '[interviews-move-order integration] FAILED — no DB reachable at DATABASE_URL',
        )
      }

      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      const db = drizzle(pool, { schema })
      dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
      Object.assign(dbSvc, { pool, db })
      service = new InterviewsService(dbSvc, {} as never)

      await db
        .insert(users)
        .values([
          {
            id: SENIOR.id,
            email: SENIOR.email,
            displayName: SENIOR.displayName,
            role: 'SENIOR',
            googleId: `test-ivorder-${SENIOR.id}`,
          },
          {
            id: ADMIN.id,
            email: ADMIN.email,
            displayName: ADMIN.displayName,
            role: 'ADMIN',
            googleId: `test-ivorder-${ADMIN.id}`,
          },
        ])
        .onConflictDoNothing()

      await db
        .insert(teams)
        .values([{ id: TEAM_ID, name: 'IV Order Team' }])
        .onConflictDoNothing()
      await db
        .insert(teamMembers)
        .values([{ teamId: TEAM_ID, userId: SENIOR.id }])
        .onConflictDoNothing()
    }, 30_000)

    beforeEach(async () => {
      await dbSvc.db.delete(interviews).where(eq(interviews.seniorId, SENIOR.id))

      // Insert 4 cards in HR_SCREEN with increasing createdAt and positions 0..3:
      // X (pos 0, T0), Y (pos 1, T1), Z (pos 2, T2), W (pos 3, T3)
      await dbSvc.db.insert(interviews).values([
        {
          id: CARD_X_ID,
          seniorId: SENIOR.id,
          companyName: 'Company X',
          stage: 'HR_SCREEN',
          position: 0,
          createdAt: new Date('2026-11-19T10:00:00.000Z'),
        },
        {
          id: CARD_Y_ID,
          seniorId: SENIOR.id,
          companyName: 'Company Y',
          stage: 'HR_SCREEN',
          position: 1,
          createdAt: new Date('2026-11-19T10:00:01.000Z'),
        },
        {
          id: CARD_Z_ID,
          seniorId: SENIOR.id,
          companyName: 'Company Z',
          stage: 'HR_SCREEN',
          position: 2,
          createdAt: new Date('2026-11-19T10:00:02.000Z'),
        },
        {
          id: CARD_W_ID,
          seniorId: SENIOR.id,
          companyName: 'Company W',
          stage: 'HR_SCREEN',
          position: 3,
          createdAt: new Date('2026-11-19T10:00:03.000Z'),
        },
      ])
    })

    afterAll(async () => {
      try {
        await dbSvc.db.delete(interviews).where(eq(interviews.seniorId, SENIOR.id))
        await dbSvc.db.delete(teamMembers).where(eq(teamMembers.teamId, TEAM_ID))
        await dbSvc.db.delete(teams).where(eq(teams.id, TEAM_ID))
        await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
      } catch {
        // Non-fatal cleanup
      }
      await pool.end()
    }, 15_000)

    it('drag UP onto occupied index places moved card at target index with distinct positions', async () => {
      // Drag W (pos 3) onto Y (targetIndex = 1).
      // Expected order: [X, W, Y, Z] with positions 0, 1, 2, 3.
      // Under unpatched head: W ties with Y at pos 1, but Y is older (10:00:01 < 10:00:03),
      // so Y wins the tie-break and W slips to pos 2 -> [X, Y, W, Z].
      await service.move(CARD_W_ID, { stage: 'HR_SCREEN', position: 1 }, ADMIN)

      const board = await service.findBySenior(SENIOR.id, ADMIN)
      const hrCards = board.filter((c) => c.stage === 'HR_SCREEN')

      expect(hrCards.map((c) => c.id)).toEqual([CARD_X_ID, CARD_W_ID, CARD_Y_ID, CARD_Z_ID])
      expect(hrCards.map((c) => c.position)).toEqual([0, 1, 2, 3])
    })

    it('drag DOWN onto occupied index places moved card at target index with distinct positions', async () => {
      // Drag X (pos 0) onto Z (targetIndex = 2).
      // Expected order: [Y, Z, X, W] with positions 0, 1, 2, 3.
      // Under unpatched head: X ties with Z at pos 2, but X is older (10:00:00 < 10:00:02),
      // so X wins the tie-break and takes pos 1 -> [Y, X, Z, W].
      await service.move(CARD_X_ID, { stage: 'HR_SCREEN', position: 2 }, ADMIN)

      const board = await service.findBySenior(SENIOR.id, ADMIN)
      const hrCards = board.filter((c) => c.stage === 'HR_SCREEN')

      expect(hrCards.map((c) => c.id)).toEqual([CARD_Y_ID, CARD_Z_ID, CARD_X_ID, CARD_W_ID])
      expect(hrCards.map((c) => c.position)).toEqual([0, 1, 2, 3])
    })

    it('drag across stages onto occupied index places card at target index and renumbers both columns', async () => {
      // Seed target column TECH_INTERVIEW with H0 (pos 0) and H1 (pos 1)
      await dbSvc.db.insert(interviews).values([
        {
          id: CARD_H0_ID,
          seniorId: SENIOR.id,
          companyName: 'Company H0',
          stage: 'TECH_INTERVIEW',
          position: 0,
          createdAt: new Date('2026-11-19T09:00:00.000Z'),
        },
        {
          id: CARD_H1_ID,
          seniorId: SENIOR.id,
          companyName: 'Company H1',
          stage: 'TECH_INTERVIEW',
          position: 1,
          createdAt: new Date('2026-11-19T09:00:01.000Z'),
        },
      ])

      // Move Card Y (created at 10:00:01, younger than H1) into TECH_INTERVIEW at position 1.
      // Expected TECH_INTERVIEW: [H0, Y, H1] with positions [0, 1, 2]
      // Expected HR_SCREEN: [X, Z, W] with positions [0, 1, 2]
      await service.move(CARD_Y_ID, { stage: 'TECH_INTERVIEW', position: 1 }, ADMIN)

      const board = await service.findBySenior(SENIOR.id, ADMIN)
      const techCards = board.filter((c) => c.stage === 'TECH_INTERVIEW')
      const hrCards = board.filter((c) => c.stage === 'HR_SCREEN')

      expect(techCards.map((c) => c.id)).toEqual([CARD_H0_ID, CARD_Y_ID, CARD_H1_ID])
      expect(techCards.map((c) => c.position)).toEqual([0, 1, 2])

      expect(hrCards.map((c) => c.id)).toEqual([CARD_X_ID, CARD_Z_ID, CARD_W_ID])
      expect(hrCards.map((c) => c.position)).toEqual([0, 1, 2])
    })
    // R5-L-5 — concurrent moves into one column. The race window (a card moved INTO a column
    // between another move's read and its renumbering) is timing-dependent, so this outcome
    // check repeats the asymmetric interleave; the lock test below is the deterministic pin.
    it('two concurrent moves into one column end with distinct dense positions', async () => {
      for (let round = 0; round < 10; round++) {
        await dbSvc.db.delete(interviews).where(eq(interviews.id, CARD_H0_ID))
        await dbSvc.db
          .update(interviews)
          .set({ stage: 'HR_SCREEN' })
          .where(eq(interviews.seniorId, SENIOR.id))
        for (const [index, cardId] of [CARD_X_ID, CARD_Y_ID, CARD_Z_ID, CARD_W_ID].entries()) {
          await dbSvc.db
            .update(interviews)
            .set({ position: index })
            .where(eq(interviews.id, cardId))
        }
        await dbSvc.db.insert(interviews).values({
          id: CARD_H0_ID,
          seniorId: SENIOR.id,
          companyName: 'Company H0',
          stage: 'TECH_INTERVIEW',
          position: 0,
          createdAt: new Date('2026-11-19T09:00:00.000Z'),
        })

        await Promise.all([
          service.move(CARD_H0_ID, { stage: 'HR_SCREEN', position: 0 }, ADMIN),
          service.move(CARD_W_ID, { stage: 'HR_SCREEN', position: 1 }, ADMIN),
        ])

        const hrCards = (await service.findBySenior(SENIOR.id, ADMIN)).filter(
          (c) => c.stage === 'HR_SCREEN',
        )
        expect(hrCards.map((c) => c.position)).toEqual([0, 1, 2, 3, 4])
      }
    })

    it('a move waits for a concurrent lock on any card of the same senior (R5-L-5 deterministic pin)', async () => {
      // H0 sits in a column the move below neither leaves nor enters, so only the
      // per-senior lock (not the renumbering writes) can make the move wait for it.
      await dbSvc.db.insert(interviews).values({
        id: CARD_H0_ID,
        seniorId: SENIOR.id,
        companyName: 'Company H0',
        stage: 'TECH_INTERVIEW',
        position: 0,
        createdAt: new Date('2026-11-19T09:00:00.000Z'),
      })

      const holder = await pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM interviews WHERE id = $1 FOR UPDATE', [CARD_H0_ID])

        let settled = false
        const moving = service
          .move(CARD_W_ID, { stage: 'HR_SCREEN', position: 0 }, ADMIN)
          .finally(() => {
            settled = true
          })
        await new Promise((resolve) => setTimeout(resolve, 500))
        expect(settled).toBe(false)

        await holder.query('COMMIT')
        await moving
      } finally {
        // A failed assertion above must not leave the lock held (no-op after COMMIT).
        await holder.query('ROLLBACK').catch(() => undefined)
        holder.release()
      }

      const [w] = await dbSvc.db
        .select({ position: interviews.position })
        .from(interviews)
        .where(and(eq(interviews.id, CARD_W_ID), eq(interviews.stage, 'HR_SCREEN')))
      expect(w?.position).toBe(0)
    })
  },
)
