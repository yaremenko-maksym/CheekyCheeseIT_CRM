/**
 * Real-DB integration test — HIGH-1 (security-audit authz-hardening):
 * a soft-deleted (`leftAt != null`) team_member row must NOT keep granting
 * access. removeMember soft-deletes (leftAt = now); every read of `team.members`
 * MUST filter `leftAt === null` before treating the row as "still a member".
 *
 * PROBLEM (before the fix): `isHrOfTeam`, `assertAccess`, and the SENIOR/JUNIOR
 * branch of `findAll` did a bare `m.userId === userId` match with no `leftAt`
 * filter — a removed HR (or any removed static member) kept full access
 * (read the team, rename it, remove other members, re-add themselves) as long
 * as their 7-day JWT was still valid. The DROP branch of `assertAccess`
 * already filtered `leftAt === null` correctly; this spec pins that same
 * contract for every role.
 *
 * ATTACK CHAIN pinned by this spec:
 *   1. ADMIN removes HR from the team (removeMember → soft-delete, row stays).
 *   2. The removed HR's JWT is still valid (7-day cookie) — they call
 *      findOne / update / addMember / removeMember / findAll on the SAME team.
 *   3. Before the fix: isHrOfTeam(team, removedHr.id) reads the dead row and
 *      returns true → every one of those calls succeeds (403 expected instead).
 *
 * SEED: isolated rows in beforeAll, deleted in afterAll. IDs namespaced tmrv-.
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable (CI unit job).
 */

import { ForbiddenException } from '@nestjs/common'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TeamsService } from './teams.service'
import { TeamAuditLogService } from './team-audit-log.service'
import { teamAuditLog, teamMembers, teams, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

// ── Test IDs — stable namespace tmrv- ──────────────────────────────────────
const TEAM_ID = '5a100003-0000-4000-aa00-000000000001'
const SENIOR_ID = '5a100003-0000-4000-bb00-000000000001'
const HR1_ID = '5a100003-0000-4000-bb00-000000000002' // stays active — satisfies "min 1 HR" guard
const REVOKED_HR_ID = '5a100003-0000-4000-bb00-000000000003' // removed mid-suite
const JUNIOR_ID = '5a100003-0000-4000-bb00-000000000004' // static team member (removed in AC-JUNIOR)
const TEST_USER_IDS = [SENIOR_ID, HR1_ID, REVOKED_HR_ID, JUNIOR_ID]

const adminActor: SessionUser = {
  id: SENIOR_ID, // any non-null actorId distinct from the removed member
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'tmrv-admin@test.spec',
  avatarUrl: null,
  seniorSharePercent: 26,
}

const revokedHrActor: SessionUser = {
  id: REVOKED_HR_ID,
  role: 'HR',
  displayName: 'Revoked HR',
  email: 'tmrv-hr-revoked@test.spec',
  avatarUrl: null,
  seniorSharePercent: 0,
}

const activeHrActor: SessionUser = {
  id: HR1_ID,
  role: 'HR',
  displayName: 'Active HR',
  email: 'tmrv-hr-active@test.spec',
  avatarUrl: null,
  seniorSharePercent: 0,
}

const revokedJuniorActor: SessionUser = {
  id: JUNIOR_ID,
  role: 'JUNIOR',
  displayName: 'Revoked Junior',
  email: 'tmrv-junior-revoked@test.spec',
  avatarUrl: null,
  seniorSharePercent: 0,
}

let pool: Pool | null = null
let service: TeamsService

describe.skipIf(!hasDatabaseUrl())(
  'TeamsService — HIGH-1: revoked membership must not keep access (real DB)',
  () => {
    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        await probe.end()
      } catch {
        throw new Error('[teams-membership-revocation] FAILED — no DB at DATABASE_URL')
      }

      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      const db = drizzle(pool, { schema })
      const dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
      Object.assign(dbSvc, { pool, db })

      const auditLog = new TeamAuditLogService(dbSvc)
      // usersService is not exercised by the methods under test — stub.
      service = new TeamsService(dbSvc, {} as never, auditLog)

      await db
        .insert(users)
        .values([
          {
            id: SENIOR_ID,
            email: 'tmrv-senior@test.spec',
            displayName: 'TMRV Senior',
            role: 'SENIOR',
            googleId: `g-${SENIOR_ID}`,
          },
          {
            id: HR1_ID,
            email: 'tmrv-hr1@test.spec',
            displayName: 'TMRV HR Active',
            role: 'HR',
            googleId: `g-${HR1_ID}`,
          },
          {
            id: REVOKED_HR_ID,
            email: 'tmrv-hr-revoked@test.spec',
            displayName: 'TMRV HR Revoked',
            role: 'HR',
            googleId: `g-${REVOKED_HR_ID}`,
          },
          {
            id: JUNIOR_ID,
            email: 'tmrv-junior@test.spec',
            displayName: 'TMRV Junior',
            role: 'JUNIOR',
            googleId: `g-${JUNIOR_ID}`,
          },
        ])
        .onConflictDoNothing()

      await db
        .insert(teams)
        .values([{ id: TEAM_ID, name: 'TMRV Team', type: 'SENIOR' }])
        .onConflictDoNothing()
    }, 30_000)

    beforeEach(async () => {
      if (!pool)
        throw new Error(
          '[require-real-db] pool not initialized — beforeAll should have thrown already',
        )
      const db = drizzle(pool, { schema })
      // Reset to a known baseline before each test: senior + 2 HR + 1 junior, all active.
      await db.delete(teamAuditLog).where(eq(teamAuditLog.targetId, TEAM_ID))
      await db.delete(teamMembers).where(eq(teamMembers.teamId, TEAM_ID))
      await db.insert(teamMembers).values([
        { teamId: TEAM_ID, userId: SENIOR_ID },
        { teamId: TEAM_ID, userId: HR1_ID },
        { teamId: TEAM_ID, userId: REVOKED_HR_ID },
        { teamId: TEAM_ID, userId: JUNIOR_ID },
      ])
    })

    afterAll(async () => {
      if (!pool)
        throw new Error(
          '[require-real-db] pool not initialized — beforeAll should have thrown already',
        )
      try {
        const db = drizzle(pool, { schema })
        await db.delete(teamAuditLog).where(eq(teamAuditLog.targetId, TEAM_ID))
        await db.delete(teamMembers).where(eq(teamMembers.teamId, TEAM_ID))
        await db.delete(teams).where(eq(teams.id, TEAM_ID))
        for (const id of TEST_USER_IDS) await db.delete(users).where(eq(users.id, id))
      } finally {
        await pool.end()
      }
    }, 30_000)

    it('AC1: revoked HR gets 403 on findOne (assertAccess) after removeMember', async () => {
      await service.removeMember(TEAM_ID, REVOKED_HR_ID, adminActor)

      await expect(service.findOne(TEAM_ID, revokedHrActor)).rejects.toThrow(ForbiddenException)
    })

    it('AC2: revoked HR gets 403 on update (isHrOfTeam) after removeMember', async () => {
      await service.removeMember(TEAM_ID, REVOKED_HR_ID, adminActor)

      await expect(
        service.update(TEAM_ID, 'Renamed by revoked HR', undefined, undefined, revokedHrActor),
      ).rejects.toThrow(ForbiddenException)
    })

    it('AC3: revoked HR gets 403 re-adding themselves via addMember (isHrOfTeam)', async () => {
      await service.removeMember(TEAM_ID, REVOKED_HR_ID, adminActor)

      // The attack chain from the finding: the removed HR calls
      // POST /api/teams/:id/members {userId: <self>} to reactivate their own
      // soft-deleted row and restore access.
      await expect(service.addMember(TEAM_ID, REVOKED_HR_ID, revokedHrActor)).rejects.toThrow(
        ForbiddenException,
      )

      // The row must stay soft-deleted — no silent reactivation happened.
      const db = drizzle(pool!, { schema })
      const rows = await db.select().from(teamMembers).where(eq(teamMembers.teamId, TEAM_ID))
      const revokedRow = rows.find((r) => r.userId === REVOKED_HR_ID)
      expect(revokedRow?.leftAt).not.toBeNull()
    })

    it('AC4: revoked HR gets 403 removing another member (isHrOfTeam) after removeMember', async () => {
      await service.removeMember(TEAM_ID, REVOKED_HR_ID, adminActor)

      await expect(service.removeMember(TEAM_ID, JUNIOR_ID, revokedHrActor)).rejects.toThrow(
        ForbiddenException,
      )
    })

    it('AC5: revoked HR no longer sees the team in findAll (isHrOfTeam)', async () => {
      await service.removeMember(TEAM_ID, REVOKED_HR_ID, adminActor)

      const result = await service.findAll(revokedHrActor)
      expect(result.map((t) => t.id)).not.toContain(TEAM_ID)
    })

    it('AC6: revoked JUNIOR gets 403 on findOne (assertAccess general branch)', async () => {
      await service.removeMember(TEAM_ID, JUNIOR_ID, adminActor)

      await expect(service.findOne(TEAM_ID, revokedJuniorActor)).rejects.toThrow(ForbiddenException)
    })

    it('AC7: revoked JUNIOR no longer sees the team in findAll (SENIOR/JUNIOR branch)', async () => {
      await service.removeMember(TEAM_ID, JUNIOR_ID, adminActor)

      const result = await service.findAll(revokedJuniorActor)
      expect(result.map((t) => t.id)).not.toContain(TEAM_ID)
    })

    it('REGRESSION: an ACTIVE HR retains full access (findOne/update/addMember/removeMember/findAll)', async () => {
      // HR1 was never removed — must keep working exactly as before the fix.
      await expect(service.findOne(TEAM_ID, activeHrActor)).resolves.toBeDefined()
      await expect(
        service.update(TEAM_ID, 'Renamed by active HR', undefined, undefined, activeHrActor),
      ).resolves.toBeDefined()

      const listResult = await service.findAll(activeHrActor)
      expect(listResult.map((t) => t.id)).toContain(TEAM_ID)

      // Active HR removing then re-adding the junior — full round trip still works.
      await service.removeMember(TEAM_ID, JUNIOR_ID, activeHrActor)
      await expect(service.addMember(TEAM_ID, JUNIOR_ID, activeHrActor)).resolves.toBeUndefined()
    })
  },
)
