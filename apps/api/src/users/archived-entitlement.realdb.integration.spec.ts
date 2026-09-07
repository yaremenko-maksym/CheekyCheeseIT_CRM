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
// security-review round 2 (SR-H-6): `createFromInterview` now opens a real
// approval proposal, so `ProjectsService` needs a real `ApprovalsService`
// wired below — and the `approvals` rows it inserts (approverUserId /
// proposedByUserId FK → users.id) must be cleaned in `wipe()` BEFORE the
// `users` delete, or that delete throws a live FK violation on the very
// next `beforeEach`.
import { ApprovalsService } from '../approvals/approvals.service'
import {
  approvals,
  projectAuditLog,
  projectMembers,
  projects,
  teamMembers,
  teams,
  userAuditLog,
  users,
} from '../database/schema'
import * as schema from '../database/schema'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'

// ── Stable id namespace ae88- (archived-entitlement, backlog 88) ────────────
const ADMIN_ID = 'ae880000-0000-4000-aa00-000000000001'
const ARCHIVED_JUNIOR_ID = 'ae880000-0000-4000-aa00-000000000002'
const ACTIVE_JUNIOR_ID = 'ae880000-0000-4000-aa00-000000000003'
const SENIOR_ID = 'ae880000-0000-4000-aa00-000000000004'
const CHAIN_USER_ID = 'ae880000-0000-4000-aa00-000000000005'
// MED-3 fixtures — the senior's teammates, one per arrival route (see the
// createFromInterview describe for what each route is).
const ACTIVE_HR_ID = 'ae880000-0000-4000-aa00-000000000006'
const CLOSED_HR_ID = 'ae880000-0000-4000-aa00-000000000007' // archived, membership CLOSED
const OPEN_HR_ID = 'ae880000-0000-4000-aa00-000000000008' // archived, membership still OPEN
const TEAM_ID = 'ae880000-0000-4000-cc00-000000000001'
const PROJECT_ID = 'ae880000-0000-4000-dd00-000000000001'
const CHAIN_PROJECT_ID = 'ae880000-0000-4000-dd00-000000000002'

const ALL_USER_IDS = [
  ADMIN_ID,
  ARCHIVED_JUNIOR_ID,
  ACTIVE_JUNIOR_ID,
  SENIOR_ID,
  CHAIN_USER_ID,
  ACTIVE_HR_ID,
  CLOSED_HR_ID,
  OPEN_HR_ID,
] as const
const ALL_PROJECT_IDS = [PROJECT_ID, CHAIN_PROJECT_ID] as const

/**
 * Projects `createFromInterview` creates with a server-generated id. Collected
 * per test so `wipe()` can remove them — they are not in ALL_PROJECT_IDS.
 */
const createdProjectIds: string[] = []

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
  const projectIds = [...ALL_PROJECT_IDS, ...createdProjectIds]
  createdProjectIds.length = 0
  await db.delete(projectMembers).where(inArray(projectMembers.userId, [...ALL_USER_IDS]))
  await db.delete(projectMembers).where(inArray(projectMembers.projectId, projectIds))
  await db.delete(projectAuditLog).where(inArray(projectAuditLog.targetId, projectIds))
  // security-review round 2 (SR-H-6): `createFromInterview` now calls
  // `ApprovalsService.proposeInTx`, which inserts `approvals` rows whose
  // `approverUserId`/`proposedByUserId` FK → `users.id` (NOT NULL, no
  // cascade). Must be deleted BEFORE `users` below, or that delete throws a
  // live FK violation the moment this file's MED-3 `createFromInterview`
  // tests have run once.
  await db.delete(approvals).where(inArray(approvals.subjectId, projectIds))
  await db.delete(projects).where(inArray(projects.id, projectIds))
  await db.delete(teamMembers).where(inArray(teamMembers.userId, [...ALL_USER_IDS]))
  await db.delete(teams).where(eq(teams.id, TEAM_ID))
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
      {} as never,
      // task-pending-share fix-round-1 (CR-H-1): buildProfileView calls
      // `this.approvals.getStatus(...)` whenever `permissions.fields.share`
      // is true — a working stub, not a placeholder, so a future
      // share-visible-viewer scenario here doesn't reproduce this round's CI
      // failure.
      { getStatus: async () => 'NONE' as const } as never,
    )
    ;(teamsService as unknown as { usersService: UsersService }).usersService = usersService
    projectsService = new ProjectsService(
      dbSvc,
      projectAuditLogService,
      usersService,
      {} as never, // HrAccessService — only consulted for HR callers; every call here is ADMIN
      // security-review round 2 (SR-H-6): real `ApprovalsService`, not a
      // mock — `createFromInterview` now proposes an approval, and this is a
      // real-DB spec; the double would just hide whether the real write
      // actually lands.
      new ApprovalsService(dbSvc),
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
      {
        id: ACTIVE_HR_ID,
        email: 'ae88-hr-active@test.spec',
        displayName: 'AE88 HR Active',
        role: 'HR',
        googleId: `g-${ACTIVE_HR_ID}`,
      },
      {
        id: CLOSED_HR_ID,
        email: 'ae88-hr-closed@test.spec',
        displayName: 'AE88 HR Dismissed (membership closed)',
        role: 'HR',
        googleId: `g-${CLOSED_HR_ID}`,
        archivedAt: new Date('2026-01-31T00:00:00.000Z'),
      },
      {
        id: OPEN_HR_ID,
        email: 'ae88-hr-open@test.spec',
        displayName: 'AE88 HR Dismissed (membership still open)',
        role: 'HR',
        googleId: `g-${OPEN_HR_ID}`,
        archivedAt: new Date('2026-01-31T00:00:00.000Z'),
      },
    ])

    // The senior's team, and the three teammates in their three states. Only
    // `leftAt` differs between CLOSED_HR and OPEN_HR — that is the whole point
    // of having both.
    await db.insert(teams).values({ id: TEAM_ID, name: 'AE88 Team' })
    await db.insert(teamMembers).values([
      { teamId: TEAM_ID, userId: SENIOR_ID },
      { teamId: TEAM_ID, userId: ACTIVE_HR_ID },
      { teamId: TEAM_ID, userId: CLOSED_HR_ID, leftAt: new Date('2026-01-31T00:00:00.000Z') },
      { teamId: TEAM_ID, userId: OPEN_HR_ID },
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

  // ── AC2, layer 2 — the predicate that lives INSIDE the UPDATE ────────────
  describe('AC2 — layer 2: `archived_at IS NULL` in the write statement', () => {
    // WHY WHITE-BOX. `updateUserRow` is deliberately two layers: an in-JS
    // pre-check against a snapshot read earlier, and the same refusal repeated
    // as SQL so an archive committing in the TOCTOU window still loses. Every
    // public caller reads that snapshot immediately before the write, so from
    // the outside the second layer is unreachable — and, measured: deleting
    // EITHER layer alone leaves all the black-box tests above green. Reaching
    // the private method with a deliberately stale snapshot is the only way to
    // execute the predicate, and executing it is the only way this assertion
    // means anything (a mocked DB would replay a queued answer no matter what
    // the WHERE clause said).
    type PrivateWriter = {
      updateUserRow: (
        db: DatabaseService['db'],
        id: string,
        existing: { archivedAt: Date | null },
        set: Record<string, unknown>,
      ) => Promise<unknown>
    }

    it('refuses even when the snapshot says the user is active — and the row does not move', async () => {
      const stale = { ...(await rowOf(ARCHIVED_JUNIOR_ID)), archivedAt: null }
      const priv = usersService as unknown as PrivateWriter

      await expect(
        priv.updateUserRow(dbSvc.db, ARCHIVED_JUNIOR_ID, stale, {
          role: 'HR',
          updatedAt: new Date(),
        }),
      ).rejects.toThrow(ENTITLEMENT_REFUSAL)

      expect((await rowOf(ARCHIVED_JUNIOR_ID)).role).toBe('JUNIOR')
    })

    it('CONTROL: the same stale-snapshot call succeeds against a user who really is active', async () => {
      const stale = { ...(await rowOf(ACTIVE_JUNIOR_ID)), archivedAt: null }
      const priv = usersService as unknown as PrivateWriter

      await priv.updateUserRow(dbSvc.db, ACTIVE_JUNIOR_ID, stale, {
        role: 'HR',
        updatedAt: new Date(),
      })

      expect((await rowOf(ACTIVE_JUNIOR_ID)).role).toBe('HR')
    })
  })

  // ── MED-3 — the SECOND door into project_members ─────────────────────────
  describe('AC1 (security-review MED-3) — ProjectsService.createFromInterview', () => {
    // `addMember` was the door the task named. `createFromInterview` is the
    // other one: moving an interview to HIRED creates the project AND seats the
    // senior's HR / ACCOUNTANT teammates on it. It consulted neither `leftAt`
    // nor `archivedAt`, so a dismissed HR was seated on a brand-new project
    // — the exact thing `addMember`'s comment declares this endpoint must not
    // be able to express.
    //
    // Two dismissed fixtures, because a dismissed teammate can arrive by two
    // different routes and only one of them is closed by each filter:
    //   • CLOSED_HR — archived the normal way, so `UsersService.archive`
    //     stamped `leftAt` on the team membership. Caught by `isNull(leftAt)`.
    //   • OPEN_HR — archived with the membership still open (a cascade that
    //     missed, a hand-edited row). Caught only by `archivedAt`.
    const makeInterview = (companyName: string) =>
      ({
        id: '00000000-0000-4000-ee00-000000000001',
        seniorId: SENIOR_ID,
        hrId: null,
        companyName,
        vacancyUrl: null,
        callUrl: null,
        stage: 'HIRED',
        notesDomain: 'ai',
        notesTechStack: null,
        notesTeamSize: null,
        notesBenefits: null,
        notesPaymentType: null,
        notesSalaryReview: null,
        notesCorpTech: null,
        notesGeneral: null,
        position: 0,
        createdProjectId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        senior: null,
      }) as unknown as Parameters<ProjectsService['createFromInterview']>[0]

    async function seatedUserIds(projectId: string): Promise<string[]> {
      const rows = await dbSvc.db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), isNull(projectMembers.leftAt)))
      return rows.map((r) => r.userId).sort()
    }

    it('seats the active teammate and neither dismissed one', async () => {
      const project = await projectsService.createFromInterview(makeInterview('AE88 Hired Co'), {
        ...ADMIN,
      })
      expect(project).toBeDefined()
      createdProjectIds.push(project!.id)

      // The whole assertion in one line: exactly the active HR, nobody else.
      expect(await seatedUserIds(project!.id)).toEqual([ACTIVE_HR_ID])
    })

    it('CONTROL: un-archiving the closed-membership HR is NOT enough — `leftAt` still governs', async () => {
      // Documents which filter does what, so a future reader does not delete
      // one of them believing the other covers it. CLOSED_HR is no longer
      // archived, but they genuinely left the team; a new project of that team
      // is not a reason to re-seat them.
      await dbSvc.db.update(users).set({ archivedAt: null }).where(eq(users.id, CLOSED_HR_ID))

      const project = await projectsService.createFromInterview(makeInterview('AE88 Hired Co 2'), {
        ...ADMIN,
      })
      createdProjectIds.push(project!.id)

      expect(await seatedUserIds(project!.id)).toEqual([ACTIVE_HR_ID])
    })

    it('CONTROL: an active teammate whose membership is open IS seated', async () => {
      // Proves the two refusals above are attributable to `leftAt`/`archivedAt`
      // and not to the endpoint having quietly stopped seating anyone.
      await dbSvc.db.update(users).set({ archivedAt: null }).where(eq(users.id, OPEN_HR_ID))

      const project = await projectsService.createFromInterview(makeInterview('AE88 Hired Co 3'), {
        ...ADMIN,
      })
      createdProjectIds.push(project!.id)

      expect(await seatedUserIds(project!.id)).toEqual([ACTIVE_HR_ID, OPEN_HR_ID].sort())
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
