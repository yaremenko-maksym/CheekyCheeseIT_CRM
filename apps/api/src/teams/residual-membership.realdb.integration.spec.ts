/**
 * Real-DB integration test — MED-2 (security-review round 2, authz-hardening):
 * residual places where a soft-deleted / detached `team_members` row still
 * influenced access, after the HIGH-1 fix closed the main cases
 * (isHrOfTeam / assertAccess / findAll static-membership branch).
 *
 * COVERED:
 *   AC-A: UsersService.getTeamMembersForUser — a removed HR viewing their
 *         OWN profile's "Команда" tab must get an EMPTY roster, not the
 *         team they were just removed from (users.service.ts memberships
 *         query, HR/ACCOUNTANT branch).
 *   AC-B: UsersService.getTeamMembersForUser — an ACTIVE HR's roster must
 *         NOT leak a previously-departed member (users.service.ts
 *         seniorMemberships + tmRows queries, Step 2).
 *   AC-C: TeamsService.findAll — after a DROP-team senior rotation, a
 *         JUNIOR whose active project still points at the OLD (now
 *         detached) senior must lose the team from their list (the "old
 *         senior keeps handing out access to their old juniors" class).
 *   AC-D: TeamsService.findOne (assertAccess) — same rotation scenario,
 *         403 instead of 200.
 *   AC-E: REGRESSION — a JUNIOR whose project points at the CURRENT
 *         (post-rotation) senior still sees/accesses the team normally.
 *   AC-F: TeamsService.unarchive — picks the row with `leftAt IS NULL`
 *         when a team has BOTH a detached ex-senior row and an active
 *         senior row (defensive: no legitimate flow can produce this state
 *         today — rotateSenior is DROP-only and unarchive targets
 *         SENIOR-type pair-archive — but the query itself must be correct
 *         if that ever changes; seeded directly to pin the SQL).
 *   AC-G (security-review round 3, follow-up to #436): after a DROP-team
 *         senior rotation, the team's ACTIVE HR must NOT see the
 *         rotated-out (now teamless) senior in their `getTeamMembersForUser`
 *         roster (Step 1's `seniorsInTeams` query, HR/ACCOUNTANT branch —
 *         the actual leak the round-3 `isNull(leftAt)` fix closes).
 *   AC-H (security-review round 3, MED-3, follow-up to #436): a rotated-out
 *         (teamless) senior viewing their OWN "Команда" tab must STILL see
 *         the JUNIOR of their still-active (non-archived — rotation does
 *         not archive projects) project. An earlier round of the AC-G fix
 *         over-tightened Step 3 to also require an ACTIVE team_members row,
 *         which silently emptied this self-view during the teamless gap;
 *         reverted to pin the restored behavior.
 *   AC-I (security-review round 4, MED-1, follow-up to #436): `rotateSenior`
 *         itself (not a hand-seeded fixture) writes the `team_member_removed`
 *         / `role.before='SENIOR'` audit row that
 *         `TeamsService.wasFormerMemberOfTeam` now requires as POSITIVE
 *         evidence before a self-service rejoin is allowed (see that
 *         method's docblock for why round 3's negative-evidence version was
 *         wrong).
 *
 * SEED: isolated rows in beforeAll, deleted in afterAll. IDs namespaced
 * rmed2-. DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable.
 */

import { ForbiddenException } from '@nestjs/common'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TeamsService } from './teams.service'
import { TeamAuditLogService } from './team-audit-log.service'
import { UsersService } from '../users/users.service'
import { AuditLogService } from '../users/audit-log.service'
import {
  projectMembers,
  projects,
  teamAuditLog,
  teamMembers,
  teams,
  userAuditLog,
  users,
} from '../database/schema'
import * as schema from '../database/schema'

// ── Test IDs — stable namespace rmed2- ─────────────────────────────────────
const TEAM_ID = '5a100004-0000-4000-aa00-000000000001'
const HR1_ID = '5a100004-0000-4000-bb00-000000000001' // stays active
const REVOKED_HR_ID = '5a100004-0000-4000-bb00-000000000002' // removed mid-suite (AC-A)
const DEPARTED_JUNIOR_ID = '5a100004-0000-4000-bb00-000000000003' // static team member, removed (AC-B leak check)
const SENIOR_ID = '5a100004-0000-4000-bb00-000000000004' // this team's senior (SENIOR-type team, HIGH-1/AC-A/AC-B fixture)

// DROP-team rotation fixture (AC-C/D/E)
const DROP_TEAM_ID = '5a100004-0000-4000-aa00-000000000002'
const OLD_SENIOR_ID = '5a100004-0000-4000-bb00-000000000005'
const NEW_SENIOR_ID = '5a100004-0000-4000-bb00-000000000006'
const JUNIOR_OF_OLD_ID = '5a100004-0000-4000-bb00-000000000007'
const JUNIOR_OF_NEW_ID = '5a100004-0000-4000-bb00-000000000008'
const DROP_HR_ID = '5a100004-0000-4000-bb00-000000000009'
const PROJECT_OLD_ID = '5a100004-0000-4000-cc00-000000000001'
const PROJECT_NEW_ID = '5a100004-0000-4000-cc00-000000000002'

// Unarchive edge-case fixture (AC-F, direct-seed only — no legitimate flow
// produces this state today; see file docblock)
const UNARCHIVE_TEAM_ID = '5a100004-0000-4000-aa00-000000000003'
const UNARCHIVE_STALE_SENIOR_ID = '5a100004-0000-4000-bb00-000000000010'
const UNARCHIVE_ACTIVE_SENIOR_ID = '5a100004-0000-4000-bb00-000000000011'

const ALL_TEAM_IDS = [TEAM_ID, DROP_TEAM_ID, UNARCHIVE_TEAM_ID]
const ALL_USER_IDS = [
  HR1_ID,
  REVOKED_HR_ID,
  DEPARTED_JUNIOR_ID,
  SENIOR_ID,
  OLD_SENIOR_ID,
  NEW_SENIOR_ID,
  JUNIOR_OF_OLD_ID,
  JUNIOR_OF_NEW_ID,
  DROP_HR_ID,
  UNARCHIVE_STALE_SENIOR_ID,
  UNARCHIVE_ACTIVE_SENIOR_ID,
]
const ALL_PROJECT_IDS = [PROJECT_OLD_ID, PROJECT_NEW_ID]

const adminActor: SessionUser = {
  id: SENIOR_ID, // any non-null actorId
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'rmed2-admin@test.spec',
  avatarUrl: null,
  seniorSharePercent: 26,
}

const juniorOfOldActor: SessionUser = {
  id: JUNIOR_OF_OLD_ID,
  role: 'JUNIOR',
  displayName: 'Junior of Old Senior',
  email: 'rmed2-junior-old@test.spec',
  avatarUrl: null,
  seniorSharePercent: 0,
}

const juniorOfNewActor: SessionUser = {
  id: JUNIOR_OF_NEW_ID,
  role: 'JUNIOR',
  displayName: 'Junior of New Senior',
  email: 'rmed2-junior-new@test.spec',
  avatarUrl: null,
  seniorSharePercent: 0,
}

let dbAvailable = true
let pool: Pool | null = null
let teamsService: TeamsService
let usersService: UsersService

describe('MED-2 (security-review round 2): residual leftAt-filter gaps (real DB)', () => {
  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      await probe.end()
    } catch {
      console.warn('[residual-membership] SKIPPED — no DB at DATABASE_URL')
      dbAvailable = false
      return
    }

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(pool, { schema })
    const dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
    Object.assign(dbSvc, { pool, db })

    const teamAuditLog = new TeamAuditLogService(dbSvc)
    const auditLog = new AuditLogService(dbSvc)
    // AC-F (unarchive) exercises UsersService.unarchive -> unarchivePairTx,
    // which writes real audit rows via `auditLogService`/`teamAuditLogService`
    // — both are real instances bound to the same DB (not stubs) so that
    // path runs end-to-end. accessService/tosService are unused by any
    // method under test here.
    usersService = new UsersService(
      dbSvc,
      {} as never,
      auditLog,
      {} as never,
      teamAuditLog,
      {} as never,
      {} as never,
    )
    teamsService = new TeamsService(dbSvc, usersService, teamAuditLog)

    await db
      .insert(users)
      .values([
        {
          id: HR1_ID,
          email: 'rmed2-hr1@test.spec',
          displayName: 'RMED2 HR Active',
          role: 'HR',
          googleId: `g-${HR1_ID}`,
        },
        {
          id: REVOKED_HR_ID,
          email: 'rmed2-hr-revoked@test.spec',
          displayName: 'RMED2 HR Revoked',
          role: 'HR',
          googleId: `g-${REVOKED_HR_ID}`,
        },
        {
          id: DEPARTED_JUNIOR_ID,
          email: 'rmed2-departed-junior@test.spec',
          displayName: 'RMED2 Departed Junior',
          role: 'JUNIOR',
          googleId: `g-${DEPARTED_JUNIOR_ID}`,
        },
        {
          id: SENIOR_ID,
          email: 'rmed2-senior@test.spec',
          displayName: 'RMED2 Senior',
          role: 'SENIOR',
          googleId: `g-${SENIOR_ID}`,
        },
        {
          id: OLD_SENIOR_ID,
          email: 'rmed2-old-senior@test.spec',
          displayName: 'RMED2 Old Senior',
          role: 'SENIOR',
          googleId: `g-${OLD_SENIOR_ID}`,
        },
        {
          id: NEW_SENIOR_ID,
          email: 'rmed2-new-senior@test.spec',
          displayName: 'RMED2 New Senior',
          role: 'SENIOR',
          googleId: `g-${NEW_SENIOR_ID}`,
        },
        {
          id: JUNIOR_OF_OLD_ID,
          email: 'rmed2-junior-old@test.spec',
          displayName: 'RMED2 Junior of Old',
          role: 'JUNIOR',
          googleId: `g-${JUNIOR_OF_OLD_ID}`,
        },
        {
          id: JUNIOR_OF_NEW_ID,
          email: 'rmed2-junior-new@test.spec',
          displayName: 'RMED2 Junior of New',
          role: 'JUNIOR',
          googleId: `g-${JUNIOR_OF_NEW_ID}`,
        },
        {
          id: DROP_HR_ID,
          email: 'rmed2-drop-hr@test.spec',
          displayName: 'RMED2 Drop HR',
          role: 'HR',
          googleId: `g-${DROP_HR_ID}`,
        },
        {
          id: UNARCHIVE_STALE_SENIOR_ID,
          email: 'rmed2-unarchive-stale@test.spec',
          displayName: 'RMED2 Unarchive Stale Senior',
          role: 'SENIOR',
          googleId: `g-${UNARCHIVE_STALE_SENIOR_ID}`,
        },
        {
          id: UNARCHIVE_ACTIVE_SENIOR_ID,
          email: 'rmed2-unarchive-active@test.spec',
          displayName: 'RMED2 Unarchive Active Senior',
          role: 'SENIOR',
          googleId: `g-${UNARCHIVE_ACTIVE_SENIOR_ID}`,
        },
      ])
      .onConflictDoNothing()

    await db
      .insert(teams)
      .values([
        { id: TEAM_ID, name: 'RMED2 Senior Team', type: 'SENIOR' },
        { id: DROP_TEAM_ID, name: 'RMED2 Drop Team', type: 'DROP' },
        { id: UNARCHIVE_TEAM_ID, name: 'RMED2 Unarchive Team', type: 'SENIOR' },
      ])
      .onConflictDoNothing()

    await db
      .insert(projects)
      .values([
        {
          id: PROJECT_OLD_ID,
          name: 'RMED2 Project (old senior)',
          companyName: 'RMED2 Co',
          domain: 'FinTech',
          startDate: new Date(),
          seniorId: OLD_SENIOR_ID,
          rate: 1000,
        },
        {
          id: PROJECT_NEW_ID,
          name: 'RMED2 Project (new senior)',
          companyName: 'RMED2 Co',
          domain: 'FinTech',
          startDate: new Date(),
          seniorId: NEW_SENIOR_ID,
          rate: 1000,
        },
      ])
      .onConflictDoNothing()
  }, 30_000)

  beforeEach(async () => {
    if (!dbAvailable || !pool) return
    const db = drizzle(pool, { schema })

    // ── TEAM_ID: senior + 2 HR + 1 departed junior (soft-removed) ──────────
    await db.delete(teamAuditLog).where(eq(teamAuditLog.targetId, TEAM_ID))
    await db.delete(teamMembers).where(eq(teamMembers.teamId, TEAM_ID))
    await db.insert(teamMembers).values([
      { teamId: TEAM_ID, userId: SENIOR_ID },
      { teamId: TEAM_ID, userId: HR1_ID },
      { teamId: TEAM_ID, userId: REVOKED_HR_ID },
      // DEPARTED_JUNIOR_ID is inserted ALREADY soft-removed — simulates a
      // member who left before this test run (AC-B roster-leak check).
      { teamId: TEAM_ID, userId: DEPARTED_JUNIOR_ID, leftAt: new Date('2026-01-01') },
    ])

    // ── DROP_TEAM_ID: HR + OLD_SENIOR (active, pre-rotation) ────────────────
    await db.delete(teamAuditLog).where(eq(teamAuditLog.targetId, DROP_TEAM_ID))
    await db.delete(teamMembers).where(eq(teamMembers.teamId, DROP_TEAM_ID))
    await db.insert(teamMembers).values([
      { teamId: DROP_TEAM_ID, userId: DROP_HR_ID },
      { teamId: DROP_TEAM_ID, userId: OLD_SENIOR_ID },
    ])
    await db.update(teams).set({ archivedAt: null }).where(eq(teams.id, DROP_TEAM_ID))

    // Both juniors active on their respective projects.
    await db.delete(projectMembers).where(inArray(projectMembers.projectId, ALL_PROJECT_IDS))
    await db.insert(projectMembers).values([
      { projectId: PROJECT_OLD_ID, userId: JUNIOR_OF_OLD_ID },
      { projectId: PROJECT_NEW_ID, userId: JUNIOR_OF_NEW_ID },
    ])

    // ── UNARCHIVE_TEAM_ID: stale detached senior + active senior, archived ─
    await db.delete(teamMembers).where(eq(teamMembers.teamId, UNARCHIVE_TEAM_ID))
    await db.insert(teamMembers).values([
      {
        teamId: UNARCHIVE_TEAM_ID,
        userId: UNARCHIVE_STALE_SENIOR_ID,
        leftAt: new Date('2026-01-01'),
      },
      { teamId: UNARCHIVE_TEAM_ID, userId: UNARCHIVE_ACTIVE_SENIOR_ID },
    ])
    await db.update(teams).set({ archivedAt: new Date() }).where(eq(teams.id, UNARCHIVE_TEAM_ID))
    // BOTH users start archived (mirrors the real pair-archive invariant:
    // archiving a SENIOR-type team archives its senior's user row). If the
    // query under test picks the WRONG (stale/detached) row, unarchive()
    // will restore the WRONG person and the active senior stays archived —
    // that mismatch is exactly what AC-F asserts against below.
    await db
      .update(users)
      .set({ archivedAt: new Date() })
      .where(inArray(users.id, [UNARCHIVE_ACTIVE_SENIOR_ID, UNARCHIVE_STALE_SENIOR_ID]))
  })

  afterAll(async () => {
    if (!dbAvailable || !pool) return
    try {
      const db = drizzle(pool, { schema })
      await db.delete(teamAuditLog).where(inArray(teamAuditLog.targetId, ALL_TEAM_IDS))
      await db.delete(userAuditLog).where(inArray(userAuditLog.targetId, ALL_USER_IDS))
      await db.delete(projectMembers).where(inArray(projectMembers.projectId, ALL_PROJECT_IDS))
      await db.delete(projects).where(inArray(projects.id, ALL_PROJECT_IDS))
      await db.delete(teamMembers).where(inArray(teamMembers.teamId, ALL_TEAM_IDS))
      await db.delete(teams).where(inArray(teams.id, ALL_TEAM_IDS))
      await db.delete(users).where(inArray(users.id, ALL_USER_IDS))
    } finally {
      await pool.end()
    }
  }, 30_000)

  it('AC-A: removed HR viewing their own team roster gets an EMPTY list, not the old team', async () => {
    if (!dbAvailable) return
    await teamsService.removeMember(TEAM_ID, REVOKED_HR_ID, adminActor)

    const roster = await usersService.getTeamMembersForUser(REVOKED_HR_ID)
    expect(roster).toEqual([])
  })

  it('AC-B: an active HR roster does NOT leak a previously-departed member', async () => {
    if (!dbAvailable) return
    const roster = await usersService.getTeamMembersForUser(HR1_ID)
    const ids = roster.map((m) => m.id)
    expect(ids).not.toContain(DEPARTED_JUNIOR_ID)
    // Sanity: the active senior IS present (the query still works normally).
    expect(ids).toContain(SENIOR_ID)
  })

  it('AC-C: after DROP-team senior rotation, JUNIOR of the OLD senior loses findAll-derived access', async () => {
    if (!dbAvailable) return
    await teamsService.rotateSenior(DROP_TEAM_ID, NEW_SENIOR_ID, adminActor)

    const result = await teamsService.findAll(juniorOfOldActor)
    expect(result.map((t) => t.id)).not.toContain(DROP_TEAM_ID)
  })

  it('AC-D: after DROP-team senior rotation, JUNIOR of the OLD senior gets 403 on findOne', async () => {
    if (!dbAvailable) return
    await teamsService.rotateSenior(DROP_TEAM_ID, NEW_SENIOR_ID, adminActor)

    await expect(teamsService.findOne(DROP_TEAM_ID, juniorOfOldActor)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('AC-E: REGRESSION — JUNIOR of the NEW (current) senior sees/accesses the team fine after rotation', async () => {
    if (!dbAvailable) return
    await teamsService.rotateSenior(DROP_TEAM_ID, NEW_SENIOR_ID, adminActor)

    const result = await teamsService.findAll(juniorOfNewActor)
    expect(result.map((t) => t.id)).toContain(DROP_TEAM_ID)
    await expect(teamsService.findOne(DROP_TEAM_ID, juniorOfNewActor)).resolves.toBeDefined()
  })

  it('AC-F: unarchive restores the ACTIVE senior, not a stale detached row with the same role', async () => {
    if (!dbAvailable) return
    const restored = await teamsService.unarchive(UNARCHIVE_TEAM_ID, adminActor)
    void restored

    const db = drizzle(pool!, { schema })
    const activeUser = await db
      .select()
      .from(users)
      .where(eq(users.id, UNARCHIVE_ACTIVE_SENIOR_ID))
      .then((rows) => rows[0])
    const staleUser = await db
      .select()
      .from(users)
      .where(eq(users.id, UNARCHIVE_STALE_SENIOR_ID))
      .then((rows) => rows[0])

    // The ACTIVE senior (leftAt IS NULL on their team_members row) must be
    // the one whose user record got un-archived...
    expect(activeUser?.archivedAt).toBeNull()
    // ...and the stale/detached senior must be untouched — still archived,
    // never even considered by the query.
    expect(staleUser?.archivedAt).not.toBeNull()
  })

  it('AC-G: after DROP-team senior rotation, the team HR does NOT see the rotated-out senior', async () => {
    if (!dbAvailable) return
    await teamsService.rotateSenior(DROP_TEAM_ID, NEW_SENIOR_ID, adminActor)

    const roster = await usersService.getTeamMembersForUser(DROP_HR_ID)
    const ids = roster.map((m) => m.id)
    expect(ids).not.toContain(OLD_SENIOR_ID)
    // Sanity: the NEW (current) senior IS present.
    expect(ids).toContain(NEW_SENIOR_ID)
  })

  it('AC-H: a rotated-out (teamless) senior still sees the JUNIOR of their own active project', async () => {
    if (!dbAvailable) return
    await teamsService.rotateSenior(DROP_TEAM_ID, NEW_SENIOR_ID, adminActor)

    const roster = await usersService.getTeamMembersForUser(OLD_SENIOR_ID)
    const ids = roster.map((m) => m.id)
    expect(ids).toContain(JUNIOR_OF_OLD_ID)
  })

  it('AC-I (MED-1, round 4): rotateSenior itself writes the positive team_member_removed/SENIOR evidence wasFormerMemberOfTeam now requires', async () => {
    if (!dbAvailable) return
    await teamsService.rotateSenior(DROP_TEAM_ID, NEW_SENIOR_ID, adminActor)

    // Real production code path (not a hand-seeded fixture) must satisfy
    // the same predicate rejoin-team-scope.realdb.integration.spec.ts pins
    // against direct seeds.
    const wasFormerMember = await teamsService.wasFormerMemberOfTeam(DROP_TEAM_ID, OLD_SENIOR_ID)
    expect(wasFormerMember).toBe(true)

    const db = drizzle(pool!, { schema })
    const rows = await db.select().from(teamAuditLog).where(eq(teamAuditLog.targetId, DROP_TEAM_ID))
    const seniorRemoval = rows.find(
      (r) =>
        r.action === 'team_member_removed' &&
        (r.changes as Record<string, { before: unknown }>)['userId']?.before === OLD_SENIOR_ID,
    )
    expect(seniorRemoval).toBeDefined()
    expect((seniorRemoval?.changes as Record<string, { before: unknown }>)['role']?.before).toBe(
      'SENIOR',
    )
  })
})
