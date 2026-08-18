/**
 * task-archived-user-completeness — AC4/AC5, REAL DB.
 *
 * WHAT THIS PROVES, AND WHY IT IS NOT MOCKED
 * ------------------------------------------
 * The defect under test is a *state* defect: a dismissed employee ends up back
 * in a shape that mints money every month. A mock cannot hold that state — it
 * can only be told to report it. So every assertion here runs the real
 * `UsersService` / `ProjectsService` against a real Postgres and then READS THE
 * ROW BACK: the refusal is proven by the row not having moved, not by an
 * exception type alone.
 *
 * The suite is deliberately symmetric. For every door that must be shut there
 * is a control that must stay OPEN, because the expensive way to fail this task
 * is not "missed a door" — it is "froze the whole archived user and stopped
 * paying people what they earned". Concretely:
 *
 *   REFUSED (new entitlement — a right to money not yet earned)
 *     • addMember for an archived user            (AC1)
 *     • changeRole / adminUpdateUser(role)        (AC2)
 *     • changeSalary / adminUpdateUser(salary)    (AC2)
 *
 *   ALLOWED (settlement — money already earned, or nothing entitlement-bearing)
 *     • adminUpdateUser changing ONLY requisites of an archived user
 *     • adminUpdateUser resubmitting the SAME role/salary of an archived user
 *       (`UserDialog` posts the whole form; refusing on presence rather than on
 *       an actual change would 400 the very edit that lets a departed employee
 *       be paid)
 *     • every one of the above on a NON-archived user
 *
 * AC5 is the reason a point fix in `addMember` would not have closed this: the
 * chain JUNIOR-on-a-project → HR → archive → JUNIOR reaches the same paying
 * state without calling `addMember` even once. The test walks it and asserts
 * both halves — the role flip is refused AND the project membership the chain
 * relies on is genuinely still open after the archive (i.e. the chain was real,
 * not hypothetical).
 *
 * RUN (never against crm_db — the globalSetup guard blocks that name, and
 * additionally rejects any server whose Postgres major is not 16):
 *   DATABASE_URL=postgresql://crm_user:password@127.0.0.1:5432/crm_scratch_x \
 *     pnpm --filter @crm/api exec vitest run archived-entitlement.realdb.integration
 */
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { AuditLogService } from './audit-log.service'
import { UsersService } from './users.service'
import { ProjectsService } from '../projects/projects.service'
import { ProjectAuditLogService } from '../projects/project-audit-log.service'
import { TeamAuditLogService } from '../teams/team-audit-log.service'
import { TeamsService } from '../teams/teams.service'
import { projectAuditLog, projectMembers, projects, userAuditLog, users } from '../database/schema'
import * as schema from '../database/schema'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'

// ── Stable id namespace ae88- (archived-entitlement, backlog 88) ────────────
const ADMIN_ID = 'ae880000-0000-4000-aa00-000000000001'
const ARCHIVED_JUNIOR_ID = 'ae880000-0000-4000-aa00-000000000002'
const ACTIVE_JUNIOR_ID = 'ae880000-0000-4000-aa00-000000000003'
const SENIOR_ID = 'ae880000-0000-4000-aa00-000000000004'
const CHAIN_USER_ID = 'ae880000-0000-4000-aa00-000000000005'
const PROJECT_ID = 'ae880000-0000-4000-dd00-000000000001'
const CHAIN_PROJECT_ID = 'ae880000-0000-4000-dd00-000000000002'

const ALL_USER_IDS = [
  ADMIN_ID,
  ARCHIVED_JUNIOR_ID,
  ACTIVE_JUNIOR_ID,
  SENIOR_ID,
  CHAIN_USER_ID,
] as const
const ALL_PROJECT_IDS = [PROJECT_ID, CHAIN_PROJECT_ID] as const

const ADMIN: SessionUser = {
  id: ADMIN_ID,
  email: 'ae88-admin@test.spec',
  displayName: 'AE88 Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** Refusal text of the shared users-row guard (`archived-entitlement.ts`). */
const ENTITLEMENT_REFUSAL = /архивирован/

let pool: Pool | null = null
let dbSvc: DatabaseService
let usersService: UsersService
let projectsService: ProjectsService

async function rowOf(id: string) {
  const row = await dbSvc.db.query.users.findFirst({ where: eq(users.id, id) })
  if (!row) throw new Error(`[ae88] user ${id} vanished — the fixture is wrong, not the assertion`)
  return row
}

async function activeMembershipCount(projectId: string, userId: string): Promise<number> {
  const rows = await dbSvc.db
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
        isNull(projectMembers.leftAt),
      ),
    )
  return rows.length
}

/** Wipe everything this spec owns, in FK-safe order. */
async function wipe(): Promise<void> {
  const db = dbSvc.db
  await db.delete(projectMembers).where(inArray(projectMembers.userId, [...ALL_USER_IDS]))
  await db.delete(projectAuditLog).where(inArray(projectAuditLog.projectId, [...ALL_PROJECT_IDS]))
  await db.delete(projects).where(inArray(projects.id, [...ALL_PROJECT_IDS]))
  await db.delete(userAuditLog).where(inArray(userAuditLog.targetId, [...ALL_USER_IDS]))
  await db.delete(users).where(inArray(users.id, [...ALL_USER_IDS]))
}

describe.skipIf(!hasDatabaseUrl())('archived user — entitlement freeze (real DB)', () => {
  beforeAll(async () => {
    // The instance-and-connectivity check is the global guard's job
    // (src/test/integration-db-guard.ts). What IT cannot know is whether this
    // spec's own columns exist on an otherwise-valid database.
    await assertRealDbSchema([
      { table: 'users', column: 'archived_at' },
      { table: 'users', column: 'monthly_salary' },
      { table: 'project_members', column: 'left_at' },
    ])

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(pool, { schema })
    dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
    Object.assign(dbSvc, { pool, db })

    const auditLog = new AuditLogService(dbSvc)
    const teamAuditLogService = new TeamAuditLogService(dbSvc)
    const projectAuditLogService = new ProjectAuditLogService(dbSvc)
    const teamsService = new TeamsService(dbSvc, {} as never, teamAuditLogService)
    usersService = new UsersService(
      dbSvc,
      {} as never,
      auditLog,
      {} as never,
      teamAuditLogService,
      projectAuditLogService,
      teamsService,
    )
    ;(teamsService as unknown as { usersService: UsersService }).usersService = usersService
    projectsService = new ProjectsService(
      dbSvc,
      projectAuditLogService,
      usersService,
      {} as never, // HrAccessService — only consulted for HR callers; every call here is ADMIN
    )
  })

  beforeEach(async () => {
    await wipe()
    const db = dbSvc.db
    await db.insert(users).values([
      {
        id: ADMIN_ID,
        email: 'ae88-admin@test.spec',
        displayName: 'AE88 Admin',
        role: 'ADMIN',
        googleId: `g-${ADMIN_ID}`,
      },
      {
        id: SENIOR_ID,
        email: 'ae88-senior@test.spec',
        displayName: 'AE88 Senior',
        role: 'SENIOR',
        googleId: `g-${SENIOR_ID}`,
      },
      {
        id: ARCHIVED_JUNIOR_ID,
        email: 'ae88-archived-junior@test.spec',
        displayName: 'AE88 Archived Junior',
        role: 'JUNIOR',
        monthlySalary: '1500.00',
        salaryCurrency: 'USDT',
        googleId: `g-${ARCHIVED_JUNIOR_ID}`,
        archivedAt: new Date('2026-01-31T00:00:00.000Z'),
      },
      {
        id: ACTIVE_JUNIOR_ID,
        email: 'ae88-active-junior@test.spec',
        displayName: 'AE88 Active Junior',
        role: 'JUNIOR',
        monthlySalary: '1500.00',
        salaryCurrency: 'USDT',
        googleId: `g-${ACTIVE_JUNIOR_ID}`,
      },
      {
        id: CHAIN_USER_ID,
        email: 'ae88-chain@test.spec',
        displayName: 'AE88 Chain',
        role: 'JUNIOR',
        monthlySalary: '900.00',
        salaryCurrency: 'USDT',
        googleId: `g-${CHAIN_USER_ID}`,
      },
    ])
    await db.insert(projects).values([
      {
        id: PROJECT_ID,
        name: 'AE88 Project',
        companyName: 'AE88 Corp',
        domain: 'ai',
        startDate: new Date('2025-01-01'),
        seniorId: SENIOR_ID,
        currency: 'USDT',
        rate: 1000,
      },
      {
        id: CHAIN_PROJECT_ID,
        name: 'AE88 Chain Project',
        companyName: 'AE88 Corp',
        domain: 'ai',
        startDate: new Date('2025-01-01'),
        seniorId: SENIOR_ID,
        currency: 'USDT',
        rate: 1000,
      },
    ])
  })

  afterAll(async () => {
    if (dbSvc) await wipe()
    if (pool) await pool.end()
  })

  // ── AC1 — the membership subscription ────────────────────────────────────
  describe('AC1 — ProjectsService.addMember', () => {
    it('refuses an archived user, and inserts no membership row', async () => {
      await expect(
        projectsService.addMember(PROJECT_ID, ARCHIVED_JUNIOR_ID, ADMIN),
      ).rejects.toThrow(ENTITLEMENT_REFUSAL)

      // The refusal is only worth anything if nothing was written. `leftAt IS
      // NULL` is precisely what `createMonthlySalaries` walks.
      expect(await activeMembershipCount(PROJECT_ID, ARCHIVED_JUNIOR_ID)).toBe(0)
    })

    it('CONTROL: an active user of the same role is still added', async () => {
      await projectsService.addMember(PROJECT_ID, ACTIVE_JUNIOR_ID, ADMIN)
      expect(await activeMembershipCount(PROJECT_ID, ACTIVE_JUNIOR_ID)).toBe(1)
    })
  })

  // ── AC2 — the frozen columns ─────────────────────────────────────────────
  describe('AC2 — role and pay terms are frozen while archived', () => {
    it('changeRole refuses, and the stored role does not move', async () => {
      await expect(usersService.changeRole(ARCHIVED_JUNIOR_ID, 'HR', ADMIN_ID)).rejects.toThrow(
        ENTITLEMENT_REFUSAL,
      )
      expect((await rowOf(ARCHIVED_JUNIOR_ID)).role).toBe('JUNIOR')
    })

    it('CONTROL: changeRole on a non-archived user still works', async () => {
      const updated = await usersService.changeRole(ACTIVE_JUNIOR_ID, 'HR', ADMIN_ID)
      expect(updated.role).toBe('HR')
      expect((await rowOf(ACTIVE_JUNIOR_ID)).role).toBe('HR')
    })

    it('changeSalary refuses, and monthlySalary does not move', async () => {
      await expect(
        usersService.changeSalary(ARCHIVED_JUNIOR_ID, { monthlySalary: 9000 }),
      ).rejects.toThrow(ENTITLEMENT_REFUSAL)
      expect(Number((await rowOf(ARCHIVED_JUNIOR_ID)).monthlySalary)).toBe(1500)
    })

    it('CONTROL: changeSalary re-submitting the SAME figure is not a change, so it passes', async () => {
      // `UserDialog` posts the whole form. If the guard fired on the mere
      // PRESENCE of `monthlySalary` this would 400 — and an admin could no
      // longer touch an archived employee's row at all.
      const updated = await usersService.changeSalary(ARCHIVED_JUNIOR_ID, { monthlySalary: 1500 })
      expect(Number(updated.monthlySalary)).toBe(1500)
    })

    it('adminUpdateUser refuses a role change on an archived user', async () => {
      await expect(
        usersService.adminUpdateUser(ARCHIVED_JUNIOR_ID, { role: 'HR' }, ADMIN_ID),
      ).rejects.toThrow(ENTITLEMENT_REFUSAL)
      expect((await rowOf(ARCHIVED_JUNIOR_ID)).role).toBe('JUNIOR')
    })

    it('adminUpdateUser refuses a salary change on an archived user', async () => {
      await expect(
        usersService.adminUpdateUser(ARCHIVED_JUNIOR_ID, { monthlySalary: 4200 }, ADMIN_ID),
      ).rejects.toThrow(ENTITLEMENT_REFUSAL)
      expect(Number((await rowOf(ARCHIVED_JUNIOR_ID)).monthlySalary)).toBe(1500)
    })

    it('CONTROL: settlement edit — requisites of an archived user are still editable', async () => {
      // This is the "do not make it worse" case. A dismissed employee whose
      // IBAN changed must still be payable for what they earned; a guard keyed
      // on "receiver is archived" instead of "this creates a new entitlement"
      // would break exactly this.
      const updated = await usersService.adminUpdateUser(
        ARCHIVED_JUNIOR_ID,
        {
          paymentMethod: 'BANK_UAH_FOP',
          bankUahRecipient: 'AE88 Archived Junior',
          bankUahIban: 'UA903052990000026007233566001',
          bankUahRnokpp: '1234567890',
        },
        ADMIN_ID,
      )
      expect(updated.bankUahIban).toBe('UA903052990000026007233566001')
      expect(updated.role).toBe('JUNIOR')
    })

    it('CONTROL: whole-form resubmit with UNCHANGED role and salary passes', async () => {
      const updated = await usersService.adminUpdateUser(
        ARCHIVED_JUNIOR_ID,
        {
          role: 'JUNIOR', // unchanged
          monthlySalary: 1500, // unchanged — string '1500.00' in the DB, number here
          salaryCurrency: 'USDT', // unchanged
          displayName: 'AE88 Archived Junior (corrected)',
        },
        ADMIN_ID,
      )
      expect(updated.displayName).toBe('AE88 Archived Junior (corrected)')
    })
  })

  // ── AC5 — the chain that bypasses addMember entirely ─────────────────────
  describe('AC5 — JUNIOR on a project → HR → archive → JUNIOR', () => {
    it('is refused at the last step, and `addMember` is never involved', async () => {
      // 1. JUNIOR, on a project — the accrual subscription is open.
      await projectsService.addMember(CHAIN_PROJECT_ID, CHAIN_USER_ID, ADMIN)
      expect(await activeMembershipCount(CHAIN_PROJECT_ID, CHAIN_USER_ID)).toBe(1)

      // 2. Promote to HR. Allowed — the user is active.
      await usersService.changeRole(CHAIN_USER_ID, 'HR', ADMIN_ID)
      expect((await rowOf(CHAIN_USER_ID)).role).toBe('HR')

      // 3. Archive. The HR branch of `UsersService.archive` closes TEAM
      //    memberships, not PROJECT ones — this assertion is what makes the
      //    chain real rather than theoretical, and is why a guard in
      //    `addMember` alone could never have closed it: at this point the
      //    membership row is already open and nobody needs to add it again.
      await usersService.archive(CHAIN_USER_ID, ADMIN_ID)
      expect((await rowOf(CHAIN_USER_ID)).archivedAt).not.toBeNull()
      expect(await activeMembershipCount(CHAIN_PROJECT_ID, CHAIN_USER_ID)).toBe(1)

      // 4. Flip back to JUNIOR — the only remaining step, and the one that
      //    would resume monthly accrual on the still-open membership.
      await expect(usersService.changeRole(CHAIN_USER_ID, 'JUNIOR', ADMIN_ID)).rejects.toThrow(
        ENTITLEMENT_REFUSAL,
      )
      expect((await rowOf(CHAIN_USER_ID)).role).toBe('HR')

      // 4b. …and the same step through the OTHER door (`PATCH /:id`), because
      //     two doors into one state is what made this defect possible.
      await expect(
        usersService.adminUpdateUser(CHAIN_USER_ID, { role: 'JUNIOR' }, ADMIN_ID),
      ).rejects.toThrow(ENTITLEMENT_REFUSAL)
      expect((await rowOf(CHAIN_USER_ID)).role).toBe('HR')
    })

    it('CONTROL: unarchive first, then the same flip succeeds', async () => {
      // The refusal must be a freeze, not a one-way door: the documented way
      // out ("разархивируйте") has to actually work.
      await projectsService.addMember(CHAIN_PROJECT_ID, CHAIN_USER_ID, ADMIN)
      await usersService.changeRole(CHAIN_USER_ID, 'HR', ADMIN_ID)
      await usersService.archive(CHAIN_USER_ID, ADMIN_ID)

      await usersService.unarchive(CHAIN_USER_ID, ADMIN_ID)
      const updated = await usersService.changeRole(CHAIN_USER_ID, 'JUNIOR', ADMIN_ID)
      expect(updated.role).toBe('JUNIOR')
    })
  })
})
