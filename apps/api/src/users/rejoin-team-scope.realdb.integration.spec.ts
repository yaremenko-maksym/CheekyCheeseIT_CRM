/**
 * Real-DB integration test — LOW (security-review round 3, follow-up to
 * #436): `UsersService.rejoinTeam`'s self-service `teamMode='JOIN_DROP_TEAM'`
 * path was the SECOND, unscoped call site of `TeamsService.addSeniorToDropTeam`
 * — #436 only closed the FIRST (HR-driven `createUser`, see
 * hr-join-drop-team-scope.realdb.integration.spec.ts). A teamless SENIOR
 * could self-attach to ANY drop-team with a free senior slot, not just one
 * they used to belong to.
 *
 * Fix: `TeamsService.wasFormerMemberOfTeam` — the caller must have POSITIVE
 * evidence (a `team_audit_log` row) that they were previously detached from
 * this EXACT team WHILE HOLDING THE SENIOR ROLE — i.e. they are genuinely
 * REjoining a team they were previously detached from as senior
 * (`archiveDropTeam`'s senior-detach or `rotateSenior`), not attaching to an
 * arbitrary team for the first time, and not riding a `team_members` row
 * left over from a DIFFERENT role they used to hold on the same team.
 *
 * COVERED:
 *   AC-A: SENIOR has NO past membership/evidence for the target drop-team →
 *         ForbiddenException, no attach happens.
 *   AC-B: SENIOR has a past detach WITH matching positive evidence (a
 *         `team_member_removed` row, role='SENIOR', role='SENIOR' —
 *         mirrors what `rotateSenior`/`archiveDropTeam` write today) →
 *         succeeds, new active team_members row created.
 *   AC-C (MED-1, round 3): a user who was formerly HR of the target
 *         drop-team (routine addMember/removeMember — far easier than the
 *         two SENIOR-only detach paths) and was LATER promoted to SENIOR
 *         (ADMIN-only role change) must NOT pass on the strength of that
 *         HR-era evidence — the audit row's role is 'HR', not 'SENIOR'.
 *   AC-D (MED-1, round 4 — explicit "no evidence → reject" pin): a SENIOR
 *         with a `team_members` row (leftAt set) for the target team but NO
 *         `team_audit_log` evidence at all — e.g. a detach that predates
 *         this fix, or a row that reached the table through some other,
 *         untracked path — must be rejected. This is the accepted cost the
 *         positive-evidence flip introduces (see
 *         `TeamsService.wasFormerMemberOfTeam`'s docblock): pre-existing
 *         detached seniors need ADMIN/HR to reattach them via
 *         `rotateSenior` instead of self-service rejoin.
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
import { teamAuditLog, teamMembers, teams, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

// ── Test IDs — stable namespace rejoin- ────────────────────────────────────
const FOREIGN_TEAM_ID = '5a100006-0000-4000-aa00-000000000001' // SENIOR never belonged here
const FORMER_TEAM_ID = '5a100006-0000-4000-aa00-000000000002' // SENIOR used to belong here, WITH evidence
const PROMOTED_TEAM_ID = '5a100006-0000-4000-aa00-000000000003' // was HR here, later promoted
const LEGACY_TEAM_ID = '5a100006-0000-4000-aa00-000000000004' // pre-fix detach, NO evidence
const SENIOR_ID = '5a100006-0000-4000-bb00-000000000001'
const OTHER_HR_ID = '5a100006-0000-4000-bb00-000000000002' // member of FOREIGN_TEAM_ID
const PROMOTED_USER_ID = '5a100006-0000-4000-bb00-000000000003' // ex-HR, now SENIOR
const LEGACY_SENIOR_ID = '5a100006-0000-4000-bb00-000000000004' // detached before this fix shipped

const ALL_TEAM_IDS = [FOREIGN_TEAM_ID, FORMER_TEAM_ID, PROMOTED_TEAM_ID, LEGACY_TEAM_ID]
const ALL_USER_IDS = [SENIOR_ID, OTHER_HR_ID, PROMOTED_USER_ID, LEGACY_SENIOR_ID]

let pool: Pool | null = null
let usersService: UsersService

describe.skipIf(!hasDatabaseUrl())(
  'LOW (security-review round 3): rejoinTeam JOIN_DROP_TEAM scope (real DB)',
  () => {
    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        await probe.end()
      } catch {
        throw new Error('[rejoin-team-scope] FAILED — no DB at DATABASE_URL')
      }

      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      const db = drizzle(pool, { schema })
      const dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
      Object.assign(dbSvc, { pool, db })

      // Named `teamAuditLogService` (not `teamAuditLog`) to avoid shadowing
      // the imported `teamAuditLog` Drizzle table used for the seed rows below.
      const teamAuditLogService = new TeamAuditLogService(dbSvc)
      const auditLog = new AuditLogService(dbSvc)
      const teamsService = new TeamsService(dbSvc, {} as never, teamAuditLogService)
      usersService = new UsersService(
        dbSvc,
        {} as never,
        auditLog,
        {} as never,
        teamAuditLogService,
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
          {
            // Current role is SENIOR — the promotion already happened.
            id: PROMOTED_USER_ID,
            email: 'rejoin-promoted@test.spec',
            displayName: 'REJOIN Promoted (ex-HR)',
            role: 'SENIOR',
            googleId: `g-${PROMOTED_USER_ID}`,
          },
          {
            id: LEGACY_SENIOR_ID,
            email: 'rejoin-legacy@test.spec',
            displayName: 'REJOIN Legacy Senior',
            role: 'SENIOR',
            googleId: `g-${LEGACY_SENIOR_ID}`,
          },
        ])
        .onConflictDoNothing()

      await db
        .insert(teams)
        .values([
          { id: FOREIGN_TEAM_ID, name: 'REJOIN Foreign Drop Team', type: 'DROP' },
          { id: FORMER_TEAM_ID, name: 'REJOIN Former Drop Team', type: 'DROP' },
          { id: PROMOTED_TEAM_ID, name: 'REJOIN Promoted Drop Team', type: 'DROP' },
          { id: LEGACY_TEAM_ID, name: 'REJOIN Legacy Drop Team', type: 'DROP' },
        ])
        .onConflictDoNothing()

      // FOREIGN_TEAM_ID: SENIOR never had any membership row — only an
      // unrelated HR is a member.
      await db
        .insert(teamMembers)
        .values([{ teamId: FOREIGN_TEAM_ID, userId: OTHER_HR_ID }])
        .onConflictDoNothing()

      // FORMER_TEAM_ID: SENIOR had an active membership that was later
      // detached (leftAt set) WITH matching positive evidence — mirrors what
      // `TeamsService.rotateSenior`/`archiveDropTeam` write as of round 4
      // (team_member_removed, role.before='SENIOR'). Team left vacant (no
      // other active SENIOR) so the scope check (not the "team already has an
      // active senior" check) is what's being exercised.
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
      await db.insert(teamAuditLog).values([
        {
          actorId: null,
          targetId: FORMER_TEAM_ID,
          action: 'team_member_removed',
          changes: {
            userId: { before: SENIOR_ID, after: null },
            role: { before: 'SENIOR', after: null },
          },
        },
      ])

      // AC-C (MED-1): PROMOTED_USER_ID was HR of PROMOTED_TEAM_ID, then
      // removed via the routine addMember/removeMember flow (leftAt set +
      // team_member_removed audit row with role.before='HR' — exactly what
      // TeamsController.removeMember writes today). Role was changed to
      // SENIOR only afterward (not modeled here — the users row above already
      // reflects the post-promotion state, which is all wasFormerMemberOfTeam
      // can ever observe).
      await db
        .insert(teamMembers)
        .values([
          {
            teamId: PROMOTED_TEAM_ID,
            userId: PROMOTED_USER_ID,
            leftAt: new Date('2026-01-01T00:00:00Z'),
          },
        ])
        .onConflictDoNothing()
      await db.insert(teamAuditLog).values([
        {
          actorId: null,
          targetId: PROMOTED_TEAM_ID,
          action: 'team_member_removed',
          changes: {
            userId: { before: PROMOTED_USER_ID, after: null },
            role: { before: 'HR', after: null },
          },
        },
      ])

      // AC-D (MED-1, round 4): LEGACY_SENIOR_ID was detached from
      // LEGACY_TEAM_ID as SENIOR, but BEFORE round 4 shipped — no
      // team_audit_log row was ever written for it (that's exactly the gap
      // round 4 closed: archiveDropTeam/rotateSenior didn't audit-log their
      // senior-detach before this PR). No evidence exists at all for this
      // (team, user) pair — deliberately NOT inserting into teamAuditLog here.
      await db
        .insert(teamMembers)
        .values([
          {
            teamId: LEGACY_TEAM_ID,
            userId: LEGACY_SENIOR_ID,
            leftAt: new Date('2026-01-01T00:00:00Z'),
          },
        ])
        .onConflictDoNothing()
    }, 30_000)

    afterAll(async () => {
      if (!pool)
        throw new Error(
          '[require-real-db] pool not initialized — beforeAll should have thrown already',
        )
      try {
        const db = drizzle(pool, { schema })
        await db.delete(teamAuditLog).where(inArray(teamAuditLog.targetId, ALL_TEAM_IDS))
        await db.delete(teamMembers).where(inArray(teamMembers.teamId, ALL_TEAM_IDS))
        await db.delete(teams).where(inArray(teams.id, ALL_TEAM_IDS))
        await db.delete(users).where(inArray(users.id, ALL_USER_IDS))
      } finally {
        await pool.end()
      }
    }, 30_000)

    it('AC-A: SENIOR has no past membership/evidence for the target drop-team → ForbiddenException', async () => {
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

    it('AC-B: SENIOR has positive evidence (team_member_removed, role=SENIOR) → succeeds', async () => {
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

    it('AC-C (MED-1): ex-HR promoted to SENIOR cannot ride HR-role evidence → ForbiddenException', async () => {
      await expect(
        usersService.rejoinTeam(PROMOTED_USER_ID, {
          teamMode: 'JOIN_DROP_TEAM',
          dropTeamId: PROMOTED_TEAM_ID,
        }),
      ).rejects.toThrow(ForbiddenException)

      // No new active membership was created.
      const db = drizzle(pool!, { schema })
      const activeMembership = await db
        .select()
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, PROMOTED_TEAM_ID),
            eq(teamMembers.userId, PROMOTED_USER_ID),
            isNull(teamMembers.leftAt),
          ),
        )
      expect(activeMembership).toHaveLength(0)
    })

    it('AC-D (MED-1, round 4): leftAt row with NO team_audit_log evidence → ForbiddenException', async () => {
      await expect(
        usersService.rejoinTeam(LEGACY_SENIOR_ID, {
          teamMode: 'JOIN_DROP_TEAM',
          dropTeamId: LEGACY_TEAM_ID,
        }),
      ).rejects.toThrow(ForbiddenException)

      const db = drizzle(pool!, { schema })
      const activeMembership = await db
        .select()
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, LEGACY_TEAM_ID),
            eq(teamMembers.userId, LEGACY_SENIOR_ID),
            isNull(teamMembers.leftAt),
          ),
        )
      expect(activeMembership).toHaveLength(0)
    })
  },
)
