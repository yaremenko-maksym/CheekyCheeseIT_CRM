/**
 * Real-DB integration test — MED-3 (security-review round 2, authz-hardening):
 * HR provisioning scope was closed for finance/PII fields on POST /api/users
 * (see users.create-hr-scope.spec.ts) but NOT for `teamMode='JOIN_DROP_TEAM'`
 * + `dropTeamId` — `TeamsService.addSeniorToDropTeam` explicitly delegates
 * RBAC to its caller (see that method's own docblock), so an HR actor could
 * attach the SENIOR they are provisioning to ANY drop-team with a free
 * senior slot, not just one they belong to, reaching into another team's
 * payment routing.
 *
 * COVERED:
 *   AC-A: HR NOT a member of the target drop-team → ForbiddenException,
 *         no user/team-membership row created (transaction-safe: the user
 *         row IS created by createUser before the team-attach step runs —
 *         see note below — but the ATTACH itself never happens).
 *   AC-B: HR IS an active member of the target drop-team → succeeds.
 *   AC-C: REGRESSION — ADMIN is exempt from the check (attaches to ANY
 *         drop-team, matching pre-fix behavior for ADMIN).
 *
 * SEED: isolated rows in beforeAll, deleted in afterAll. IDs namespaced
 * hrjoin-. DB-SKIP-GUARD: describe.skipIf(!hasDatabaseUrl()) when
 * DATABASE_URL is unset (reports SKIPPED). A DATABASE_URL that IS set but
 * unreachable throws in beforeAll (reports FAILED) — neither case can look
 * like "passed" with zero assertions.
 */

import { ForbiddenException } from '@nestjs/common'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { DatabaseService } from '../database/database.service'
import { UsersService } from './users.service'
import { AuditLogService } from './audit-log.service'
import { TeamsService } from '../teams/teams.service'
import { TeamAuditLogService } from '../teams/team-audit-log.service'
import { teamMembers, teams, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

// ── Test IDs — stable namespace hrjoin- ────────────────────────────────────
const HR_OWN_TEAM_ID = '5a100005-0000-4000-aa00-000000000001' // HR_A belongs here
const HR_FOREIGN_TEAM_ID = '5a100005-0000-4000-aa00-000000000002' // HR_A does NOT belong here
const HR_A_ID = '5a100005-0000-4000-bb00-000000000001'
const HR_B_ID = '5a100005-0000-4000-bb00-000000000002' // owns HR_FOREIGN_TEAM_ID
const ADMIN_ID = '5a100005-0000-4000-bb00-000000000003'

const ALL_TEAM_IDS = [HR_OWN_TEAM_ID, HR_FOREIGN_TEAM_ID]
const ALL_USER_IDS = [HR_A_ID, HR_B_ID, ADMIN_ID]

let pool: Pool | null = null
let usersService: UsersService
// Track SENIOR users created by each test so afterEach can clean them up
// (createUser generates a fresh row per call — not part of the fixed seed).
const createdSeniorEmails: string[] = []

describe.skipIf(!hasDatabaseUrl())(
  'MED-3 (security-review round 2): HR createUser teamMode=JOIN_DROP_TEAM scope (real DB)',
  () => {
    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        await probe.end()
      } catch {
        throw new Error('[hr-join-drop-team-scope] FAILED — no DB at DATABASE_URL')
      }

      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      const db = drizzle(pool, { schema })
      const dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
      Object.assign(dbSvc, { pool, db })

      const teamAuditLog = new TeamAuditLogService(dbSvc)
      const auditLog = new AuditLogService(dbSvc)
      const teamsService = new TeamsService(dbSvc, {} as never, teamAuditLog)
      usersService = new UsersService(
        dbSvc,
        {} as never,
        auditLog,
        {} as never,
        teamAuditLog,
        {} as never,
        teamsService,
      )
      // TeamsService needs UsersService back for OTHER methods (not exercised
      // here) — forwardRef in prod DI, plain field assignment is enough here.
      ;(teamsService as unknown as { usersService: UsersService }).usersService = usersService

      await db
        .insert(users)
        .values([
          {
            id: HR_A_ID,
            email: 'hrjoin-hr-a@test.spec',
            displayName: 'HRJOIN HR A',
            role: 'HR',
            googleId: `g-${HR_A_ID}`,
          },
          {
            id: HR_B_ID,
            email: 'hrjoin-hr-b@test.spec',
            displayName: 'HRJOIN HR B',
            role: 'HR',
            googleId: `g-${HR_B_ID}`,
          },
          {
            id: ADMIN_ID,
            email: 'hrjoin-admin@test.spec',
            displayName: 'HRJOIN Admin',
            role: 'ADMIN',
            googleId: `g-${ADMIN_ID}`,
          },
        ])
        .onConflictDoNothing()

      await db
        .insert(teams)
        .values([
          { id: HR_OWN_TEAM_ID, name: 'HRJOIN Own Drop Team', type: 'DROP' },
          { id: HR_FOREIGN_TEAM_ID, name: 'HRJOIN Foreign Drop Team', type: 'DROP' },
        ])
        .onConflictDoNothing()

      await db
        .insert(teamMembers)
        .values([
          { teamId: HR_OWN_TEAM_ID, userId: HR_A_ID },
          { teamId: HR_FOREIGN_TEAM_ID, userId: HR_B_ID },
        ])
        .onConflictDoNothing()
    }, 30_000)

    afterEach(async () => {
      if (!pool)
        throw new Error(
          '[require-real-db] pool not initialized — beforeAll should have thrown already',
        )
      // Clean up any SENIOR user rows createUser() inserted this test — their
      // team_members rows cascade-delete with them (users.id FK, ON DELETE CASCADE).
      if (createdSeniorEmails.length === 0) return
      const db = drizzle(pool, { schema })
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.email, createdSeniorEmails))
      if (rows.length > 0) {
        await db.delete(teamMembers).where(
          inArray(
            teamMembers.userId,
            rows.map((r) => r.id),
          ),
        )
        await db.delete(users).where(
          inArray(
            users.id,
            rows.map((r) => r.id),
          ),
        )
      }
      createdSeniorEmails.length = 0
    })

    afterAll(async () => {
      if (!pool)
        throw new Error(
          '[require-real-db] pool not initialized — beforeAll should have thrown already',
        )
      try {
        const db = drizzle(pool, { schema })
        await db.delete(teamMembers).where(inArray(teamMembers.teamId, ALL_TEAM_IDS))
        await db.delete(teams).where(inArray(teams.id, ALL_TEAM_IDS))
        await db.delete(users).where(inArray(users.id, ALL_USER_IDS))
      } finally {
        await pool.end()
      }
    }, 30_000)

    it('AC-A: HR NOT a member of the target drop-team → ForbiddenException', async () => {
      const email = 'hrjoin-attempt-a@test.spec'
      createdSeniorEmails.push(email)

      await expect(
        usersService.createUser({
          email,
          displayName: 'Attempted Senior A',
          role: 'SENIOR',
          teamMode: 'JOIN_DROP_TEAM',
          dropTeamId: HR_FOREIGN_TEAM_ID, // HR_A is NOT a member of this one
          actorRole: 'HR',
          actorId: HR_A_ID,
        }),
      ).rejects.toThrow(ForbiddenException)

      // The attach must never have happened — HR_FOREIGN_TEAM_ID must still
      // have exactly its original member (HR_B), no new senior attached.
      const db = drizzle(pool!, { schema })
      const members = await db
        .select()
        .from(teamMembers)
        .where(eq(teamMembers.teamId, HR_FOREIGN_TEAM_ID))
      expect(members.map((m) => m.userId)).toEqual([HR_B_ID])
    })

    it('AC-B: HR IS an active member of the target drop-team → succeeds', async () => {
      const email = 'hrjoin-attempt-b@test.spec'
      createdSeniorEmails.push(email)

      const created = await usersService.createUser({
        email,
        displayName: 'Attempted Senior B',
        role: 'SENIOR',
        teamMode: 'JOIN_DROP_TEAM',
        dropTeamId: HR_OWN_TEAM_ID, // HR_A IS a member of this one
        actorRole: 'HR',
        actorId: HR_A_ID,
      })
      expect(created.email).toBe(email)

      const db = drizzle(pool!, { schema })
      const members = await db
        .select()
        .from(teamMembers)
        .where(eq(teamMembers.teamId, HR_OWN_TEAM_ID))
      expect(members.map((m) => m.userId)).toContain(created.id)
    })

    it('AC-C: REGRESSION — ADMIN is exempt from the check (attaches to any drop-team)', async () => {
      const email = 'hrjoin-attempt-c@test.spec'
      createdSeniorEmails.push(email)

      const created = await usersService.createUser({
        email,
        displayName: 'Attempted Senior C',
        role: 'SENIOR',
        teamMode: 'JOIN_DROP_TEAM',
        dropTeamId: HR_FOREIGN_TEAM_ID, // ADMIN is not a member of ANY team — must still work
        actorRole: 'ADMIN',
        actorId: ADMIN_ID,
      })
      expect(created.email).toBe(email)
    })
  },
)
