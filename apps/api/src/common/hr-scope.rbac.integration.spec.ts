import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DatabaseService } from '../database/database.service'
import { teamMembers, teams, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'
import { getHrScope, HrAccessService } from './hr-access.service'

/**
 * HR project scope — real-DB integration spec.
 *
 * WHY: every HR path (project read/list/update, members, credentials, legends,
 * HR contact) decides through `getHrScope` / `HrAccessService.hrCoversProject`.
 * The unit specs mock the query, so this spec runs the real one: a project is in
 * scope when its SENIOR or DROP is an active member of one of the HR's active
 * teams; an archived DROP is excluded, an archived SENIOR is not.
 *
 * SEED: isolated rows (namespace c7d8e9f0-a1b2-4c3d-9e00-<seq>), cleaned in afterAll.
 * Skipped when DATABASE_URL is unset.
 */

const ns = (n: number) => `c7d8e9f0-a1b2-4c3d-9e00-${String(n).padStart(12, '0')}`

const HR = ns(1)
const HR_LEFT = ns(2)
const SENIOR_IN = ns(3)
const DROP_IN = ns(4)
const DROP_FOREIGN = ns(5)
const DROP_LEFT = ns(6)
const DROP_ARCHIVED = ns(7)
const SENIOR_ARCHIVED = ns(8)

const HR_TEAM = ns(20)
const FOREIGN_TEAM = ns(21)
const HR_LEFT_TEAM = ns(22)

const allUserIds = [
  HR,
  HR_LEFT,
  SENIOR_IN,
  DROP_IN,
  DROP_FOREIGN,
  DROP_LEFT,
  DROP_ARCHIVED,
  SENIOR_ARCHIVED,
]
const allTeamIds = [HR_TEAM, FOREIGN_TEAM, HR_LEFT_TEAM]

describe.skipIf(!hasDatabaseUrl())(
  'HR project scope — real DB (getHrScope / hrCoversProject)',
  () => {
    let pool: Pool
    let dbSvc: DatabaseService
    let hrAccess: HrAccessService

    beforeAll(async () => {
      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await pool.query('SELECT 1')
      dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
      Object.assign(dbSvc, { pool, db: drizzle(pool, { schema }) })
      hrAccess = new HrAccessService(dbSvc)
      const db = dbSvc.db

      const user = (id: string, role: 'HR' | 'SENIOR' | 'DROP', archived = false) => ({
        id,
        email: `hr-scope-${id}@test.spec`,
        displayName: `HR scope ${role}`,
        role,
        googleId: `test-google-${id}`,
        archivedAt: archived ? new Date() : null,
      })
      await db
        .insert(users)
        .values([
          user(HR, 'HR'),
          user(HR_LEFT, 'HR'),
          user(SENIOR_IN, 'SENIOR'),
          user(DROP_IN, 'DROP'),
          user(DROP_FOREIGN, 'DROP'),
          user(DROP_LEFT, 'DROP'),
          user(DROP_ARCHIVED, 'DROP', true),
          user(SENIOR_ARCHIVED, 'SENIOR', true),
        ])
      await db.insert(teams).values([
        { id: HR_TEAM, name: 'HR scope — HR team', type: 'DROP' },
        { id: FOREIGN_TEAM, name: 'HR scope — foreign team', type: 'DROP' },
        { id: HR_LEFT_TEAM, name: 'HR scope — team the HR left', type: 'DROP' },
      ])
      await db.insert(teamMembers).values([
        { teamId: HR_TEAM, userId: HR },
        { teamId: HR_TEAM, userId: SENIOR_IN },
        { teamId: HR_TEAM, userId: DROP_IN },
        { teamId: HR_TEAM, userId: DROP_LEFT, leftAt: new Date() },
        // archiveDropTeam keeps the drop's own membership row active
        { teamId: HR_TEAM, userId: DROP_ARCHIVED },
        { teamId: HR_TEAM, userId: SENIOR_ARCHIVED },
        { teamId: FOREIGN_TEAM, userId: DROP_FOREIGN },
        { teamId: HR_LEFT_TEAM, userId: HR_LEFT, leftAt: new Date() },
        { teamId: HR_LEFT_TEAM, userId: DROP_IN },
      ])
    })

    afterAll(async () => {
      const db = dbSvc?.db
      if (db) {
        await db.delete(teamMembers).where(inArray(teamMembers.teamId, allTeamIds))
        await db.delete(teams).where(inArray(teams.id, allTeamIds))
        await db.delete(users).where(inArray(users.id, allUserIds))
      }
      await pool?.end()
    })

    const covers = (hrId: string, project: { seniorId: string | null; dropId: string | null }) =>
      hrAccess.hrCoversProject(hrId, project)

    it('a drop-project whose drop is in the HR team is in scope (senior elsewhere)', async () => {
      expect(await covers(HR, { seniorId: null, dropId: DROP_IN })).toBe(true)
    })

    it('a project whose senior is in the HR team is in scope', async () => {
      expect(await covers(HR, { seniorId: SENIOR_IN, dropId: null })).toBe(true)
    })

    it('a drop in a foreign team gives no scope', async () => {
      expect(await covers(HR, { seniorId: null, dropId: DROP_FOREIGN })).toBe(false)
    })

    it('a drop that left the HR team (leftAt set) gives no scope', async () => {
      expect(await covers(HR, { seniorId: null, dropId: DROP_LEFT })).toBe(false)
    })

    it('an archived drop gives no scope, though its membership row is still active', async () => {
      expect(await covers(HR, { seniorId: null, dropId: DROP_ARCHIVED })).toBe(false)
    })

    it('an archived senior with an active membership keeps the senior-only rule', async () => {
      expect(await covers(HR, { seniorId: SENIOR_ARCHIVED, dropId: null })).toBe(true)
    })

    it('an HR who left the team (leftAt set) gets no scope from it', async () => {
      expect(await covers(HR_LEFT, { seniorId: null, dropId: DROP_IN })).toBe(false)
    })

    it('getHrScope returns the active seniors and the active, non-archived drop', async () => {
      const scope = await getHrScope(dbSvc, HR)
      expect([...scope.seniorIds].sort()).toEqual([SENIOR_IN, SENIOR_ARCHIVED].sort())
      expect(scope.dropIds).toEqual([DROP_IN])
    })
  },
)
