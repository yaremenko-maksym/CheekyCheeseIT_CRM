/**
 * Real-DB integration test — LOW (security-review round 3, follow-up to
 * #436): `UsersService.rejoinTeam`'s self-service `teamMode='JOIN_DROP_TEAM'`
 * path was the SECOND, unscoped call site of `TeamsService.addSeniorToDropTeam`
 * — #436 only closed the FIRST (HR-driven `createUser`, see
 * hr-join-drop-team-scope.realdb.integration.spec.ts). A teamless SENIOR
 * could self-attach to ANY drop-team with a free senior slot, not just one
 * they used to belong to.
 *
 * Fix: `TeamsService.wasFormerMemberOfTeam` — the caller must have a PAST
 * (non-active) `team_members` row for the EXACT target team, i.e. they are
 * genuinely REjoining a team they were previously detached from
 * (`archiveDropTeam`'s senior-detach or `rotateSenior`), not attaching to an
 * arbitrary team for the first time.
 *
 * COVERED:
 *   AC-A: SENIOR has NO past membership of the target drop-team →
 *         ForbiddenException, no attach happens.
 *   AC-B: SENIOR HAS a past (leftAt-set) membership of the target drop-team
 *         → succeeds, new active team_members row created.
 *
 * SEED: isolated rows in beforeAll, deleted in afterAll. IDs namespaced
 * rejoin-. DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable.
 */

import { ForbiddenException } from '@nestjs/common'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DatabaseService } from '../database/database.service'
import { UsersService } from './users.service'
import { AuditLogService } from './audit-log.service'
import { TeamsService } from '../teams/teams.service'
import { TeamAuditLogService } from '../teams/team-audit-log.service'
import { teamMembers, teams, users } from '../database/schema'
import * as schema from '../database/schema'

// ── Test IDs — stable namespace rejoin- ────────────────────────────────────
const FOREIGN_TEAM_ID = '5a100006-0000-4000-aa00-000000000001' // SENIOR never belonged here
const FORMER_TEAM_ID = '5a100006-0000-4000-aa00-000000000002' // SENIOR used to belong here
const SENIOR_ID = '5a100006-0000-4000-bb00-000000000001'
const OTHER_HR_ID = '5a100006-0000-4000-bb00-000000000002' // member of FOREIGN_TEAM_ID

const ALL_TEAM_IDS = [FOREIGN_TEAM_ID, FORMER_TEAM_ID]
const ALL_USER_IDS = [SENIOR_ID, OTHER_HR_ID]

let dbAvailable = true
let pool: Pool | null = null
let usersService: UsersService

describe('LOW (security-review round 3): rejoinTeam JOIN_DROP_TEAM scope (real DB)', () => {
  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      await probe.end()
    } catch {
      console.warn('[rejoin-team-scope] SKIPPED — no DB at DATABASE_URL')
      dbAvailable = false
      return
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
    ;(teamsService as unknown as { usersService: UsersService }).usersService = usersService

    await db
      .insert(users)
      .values([
        {
          id: SENIOR_ID,
          email: 'rejoin-senior@test.spec',
          displayName: 'REJOIN Senior',
          role: 'SENIOR',
          googleId: `g-${SENIOR_ID}`,
        },
        {
          id: OTHER_HR_ID,
          email: 'rejoin-hr@test.spec',
          displayName: 'REJOIN HR',
          role: 'HR',
          googleId: `g-${OTHER_HR_ID}`,
        },
      ])
      .onConflictDoNothing()

    await db
      .insert(teams)
      .values([
        { id: FOREIGN_TEAM_ID, name: 'REJOIN Foreign Drop Team', type: 'DROP' },
        { id: FORMER_TEAM_ID, name: 'REJOIN Former Drop Team', type: 'DROP' },
      ])
      .onConflictDoNothing()

    // FOREIGN_TEAM_ID: SENIOR never had any membership row — only an
    // unrelated HR is a member.
    await db
      .insert(teamMembers)
      .values([{ teamId: FOREIGN_TEAM_ID, userId: OTHER_HR_ID }])
      .onConflictDoNothing()

    // FORMER_TEAM_ID: SENIOR had an active membership that was later
    // detached (leftAt set) — mirrors TeamsService.rotateSenior's own
    // detach step, leaving the team vacant (no other active SENIOR) so the
    // scope check (not the "team already has an active senior" check) is
    // what's being exercised.
    await db
      .insert(teamMembers)
      .values([
        {
          teamId: FORMER_TEAM_ID,
          userId: SENIOR_ID,
          leftAt: new Date('2026-01-01T00:00:00Z'),
        },
      ])
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable || !pool) return
    try {
      const db = drizzle(pool, { schema })
      await db.delete(teamMembers).where(
        // narrow via teamId — covers both the seed row and anything a test
        // successfully inserted during the run.
        eq(teamMembers.teamId, FORMER_TEAM_ID),
      )
      await db.delete(teamMembers).where(eq(teamMembers.teamId, FOREIGN_TEAM_ID))
      await db.delete(teams).where(inArray(teams.id, ALL_TEAM_IDS))
      await db.delete(users).where(inArray(users.id, ALL_USER_IDS))
    } finally {
      await pool.end()
    }
  }, 30_000)

  it('AC-A: SENIOR has no past membership of the target drop-team → ForbiddenException', async () => {
    if (!dbAvailable) return

    await expect(
      usersService.rejoinTeam(SENIOR_ID, {
        teamMode: 'JOIN_DROP_TEAM',
        dropTeamId: FOREIGN_TEAM_ID,
      }),
    ).rejects.toThrow(ForbiddenException)

    // The attach must never have happened — FOREIGN_TEAM_ID must still have
    // exactly its original member (OTHER_HR_ID), no SENIOR attached.
    const db = drizzle(pool!, { schema })
    const members = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.teamId, FOREIGN_TEAM_ID))
    expect(members.map((m) => m.userId)).toEqual([OTHER_HR_ID])
  })

  it('AC-B: SENIOR has a past (leftAt-set) membership of the target drop-team → succeeds', async () => {
    if (!dbAvailable) return

    const result = await usersService.rejoinTeam(SENIOR_ID, {
      teamMode: 'JOIN_DROP_TEAM',
      dropTeamId: FORMER_TEAM_ID,
    })
    expect(result.teamId).toBe(FORMER_TEAM_ID)

    const db = drizzle(pool!, { schema })
    const activeMembership = await db
      .select()
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, FORMER_TEAM_ID),
          eq(teamMembers.userId, SENIOR_ID),
          isNull(teamMembers.leftAt),
        ),
      )
    // A NEW active membership row was created (the seed row's leftAt is
    // still set — this is a distinct row, not a resurrection of the old one).
    expect(activeMembership).toHaveLength(1)
  })
})
