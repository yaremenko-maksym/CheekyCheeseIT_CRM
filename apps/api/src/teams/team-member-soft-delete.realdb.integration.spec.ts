/**
 * Real-DB integration test — TeamsService.removeMember soft-delete (pre-deploy MEDIUM #2)
 *
 * WHY this exists:
 *   removeMember previously physically DELETEd the team_member row, breaking the
 *   soft-delete/audit contract that every other exit path (archiveDropTeam,
 *   rotateSenior) follows. This spec proves on real PostgreSQL that:
 *
 *   AC2a: after removeMember the row still EXISTS with leftAt != null (soft-delete)
 *   AC2b: a team_audit_log `team_member_removed` row is created (actor + target)
 *   AC2c: re-adding the same member reactivates the row (leftAt -> null), no dup
 *   AC2d: a soft-deleted member cannot be removed again (404) / counted as active
 *
 * SEED: isolated rows in beforeAll, deleted in afterAll. IDs namespaced tmsd-.
 * DB-SKIP-GUARD: describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is
 * unset (reports SKIPPED). A DATABASE_URL that IS set but unreachable
 * throws in beforeAll (reports FAILED) — neither case can look like
 * "passed" with zero assertions.
 */

import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TeamsService } from './teams.service'
import { TeamAuditLogService } from './team-audit-log.service'
import { teamAuditLog, teamMembers, teams, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

// ── Test IDs — stable namespace tmsd- ──────────────────────────────────────
const TEAM_ID = '5a100002-0000-4000-aa00-000000000001'
const SENIOR_ID = '5a100002-0000-4000-bb00-000000000001'
const HR1_ID = '5a100002-0000-4000-bb00-000000000002'
const HR2_ID = '5a100002-0000-4000-bb00-000000000003'
const JUNIOR_ID = '5a100002-0000-4000-bb00-000000000004'
const TEST_USER_IDS = [SENIOR_ID, HR1_ID, HR2_ID, JUNIOR_ID]

const adminActor: SessionUser = {
  id: SENIOR_ID, // any non-null actorId; not the removed member
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'tmsd-admin@test.spec',
  avatar: null,
  seniorSharePercent: 26,
}

let pool: Pool | null = null
let service: TeamsService

describe.skipIf(!hasDatabaseUrl())(
  'TeamsService.removeMember — soft-delete + audit + re-add (real DB)',
  () => {
    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        await probe.end()
      } catch {
        throw new Error('[team-member-soft-delete] FAILED — no DB at DATABASE_URL')
      }

      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      const db = drizzle(pool, { schema })
      const dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
      Object.assign(dbSvc, { pool, db })

      const auditLog = new TeamAuditLogService(dbSvc)
      // usersService is not used by add/removeMember — pass a stub.
      service = new TeamsService(dbSvc, {} as never, auditLog)

      await db
        .insert(users)
        .values([
          {
            id: SENIOR_ID,
            email: 'tmsd-senior@test.spec',
            displayName: 'TMSD Senior',
            role: 'SENIOR',
            googleId: `g-${SENIOR_ID}`,
          },
          {
            id: HR1_ID,
            email: 'tmsd-hr1@test.spec',
            displayName: 'TMSD HR1',
            role: 'HR',
            googleId: `g-${HR1_ID}`,
          },
          {
            id: HR2_ID,
            email: 'tmsd-hr2@test.spec',
            displayName: 'TMSD HR2',
            role: 'HR',
            googleId: `g-${HR2_ID}`,
          },
          {
            id: JUNIOR_ID,
            email: 'tmsd-junior@test.spec',
            displayName: 'TMSD Junior',
            role: 'JUNIOR',
            googleId: `g-${JUNIOR_ID}`,
          },
        ])
        .onConflictDoNothing()

      await db
        .insert(teams)
        .values([{ id: TEAM_ID, name: 'TMSD Team', type: 'SENIOR' }])
        .onConflictDoNothing()
    }, 30_000)

    beforeEach(async () => {
      if (!pool)
        throw new Error(
          '[require-real-db] pool not initialized — beforeAll should have thrown already',
        )
      const db = drizzle(pool, { schema })
      // Reset membership state to a known baseline: senior + 2 HR + 1 junior, all active.
      await db.delete(teamAuditLog).where(eq(teamAuditLog.targetId, TEAM_ID))
      await db.delete(teamMembers).where(eq(teamMembers.teamId, TEAM_ID))
      await db.insert(teamMembers).values([
        { teamId: TEAM_ID, userId: SENIOR_ID },
        { teamId: TEAM_ID, userId: HR1_ID },
        { teamId: TEAM_ID, userId: HR2_ID },
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

    it('AC2a: removeMember soft-deletes — the row persists with leftAt != null (no physical delete)', async () => {
      if (!pool)
        throw new Error(
          '[require-real-db] pool not initialized — beforeAll should have thrown already',
        )
      const db = drizzle(pool, { schema })

      await service.removeMember(TEAM_ID, JUNIOR_ID, adminActor)

      const rows = await db
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, TEAM_ID), eq(teamMembers.userId, JUNIOR_ID)))
      // The row was NOT deleted — it survives for history…
      expect(rows).toHaveLength(1)
      // …with leftAt stamped (soft-delete).
      expect(rows[0]!.leftAt).not.toBeNull()
    })

    it('AC2b: removeMember records a team_member_removed audit row (actor + target)', async () => {
      if (!pool)
        throw new Error(
          '[require-real-db] pool not initialized — beforeAll should have thrown already',
        )
      const db = drizzle(pool, { schema })

      await service.removeMember(TEAM_ID, JUNIOR_ID, adminActor)

      const audit = await db.select().from(teamAuditLog).where(eq(teamAuditLog.targetId, TEAM_ID))
      const removed = audit.filter((a) => a.action === 'team_member_removed')
      expect(removed).toHaveLength(1)
      expect(removed[0]!.actorId).toBe(adminActor.id)
      const changes = removed[0]!.changes as Record<string, { before: unknown; after: unknown }>
      expect(changes.userId?.before).toBe(JUNIOR_ID)
      expect(changes.role?.before).toBe('JUNIOR')
    })

    it('AC2c: re-adding a removed member reactivates the row (leftAt -> null), no duplicate', async () => {
      if (!pool)
        throw new Error(
          '[require-real-db] pool not initialized — beforeAll should have thrown already',
        )
      const db = drizzle(pool, { schema })

      await service.removeMember(TEAM_ID, JUNIOR_ID, adminActor)
      // Re-add the same member — must succeed (the soft-delete must not block it).
      await expect(service.addMember(TEAM_ID, JUNIOR_ID, adminActor)).resolves.toBeUndefined()

      const rows = await db
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, TEAM_ID), eq(teamMembers.userId, JUNIOR_ID)))
      // Exactly ONE row (reactivated, not a second insert) and it is active again.
      expect(rows).toHaveLength(1)
      expect(rows[0]!.leftAt).toBeNull()
    })

    it('AC2d: a soft-deleted member cannot be removed again (404 — not an active member)', async () => {
      await service.removeMember(TEAM_ID, JUNIOR_ID, adminActor)
      // Second removal of the already-removed member: it is no longer ACTIVE.
      await expect(service.removeMember(TEAM_ID, JUNIOR_ID, adminActor)).rejects.toThrow()
    })

    it('AC2d: last ACTIVE HR guard counts only active rows (soft-deleted HR ignored)', async () => {
      // Remove HR2 (soft-delete). HR1 is now the last ACTIVE HR.
      await service.removeMember(TEAM_ID, HR2_ID, adminActor)
      // Removing HR1 must 400 — team must keep at least one HR.
      await expect(service.removeMember(TEAM_ID, HR1_ID, adminActor)).rejects.toThrow()
    })
  },
)
