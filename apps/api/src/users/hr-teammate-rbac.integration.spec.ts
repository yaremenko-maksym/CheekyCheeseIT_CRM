import { ForbiddenException } from '@nestjs/common'
import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { User } from '../database/schema'
import * as schema from '../database/schema'
import { teamMembers, teams, users } from '../database/schema'
import { DatabaseService } from '../database/database.service'
import { UsersAccessService } from './users-access.service'
import { UsersService } from './users.service'

/**
 * task-hr-rbac-teammate-access — HR teammate RBAC, real-Postgres integration.
 *
 * WHY this exists (security-critical, OWASP A01 + RBAC widening):
 *   This PR WIDENS access: HR may now open the profile of an ACCOUNTANT or
 *   another HR in their own team. A mocked-service test cannot prove that the
 *   real getViewPermissions + buildProfileView (a) return 200 with exactly
 *   overview/team tabs for a same-team teammate, (b) MASK every financial /
 *   requisites / PII field (the leak class that bit us 3×, feedback_mocked_e2e_
 *   guards), and (c) still throw 403 for a different-team teammate. This spec
 *   drives the REAL services against real DB rows so a regression that
 *   over-grants (extra tab / un-masked salary) or under-grants (403 for a
 *   teammate) fails loudly.
 *
 * COVERED:
 *   HR-INT-1  HR → ACCOUNTANT same team   → 200, tabs=['overview','team'], finance/PII masked
 *   HR-INT-2  HR → HR same team           → 200, tabs=['overview','team'], finance/PII masked
 *   HR-INT-3  HR → ACCOUNTANT other team  → 403 ForbiddenException
 *   HR-INT-4  HR → SENIOR same team       → 200, tabs include projects/team/interviews (regression)
 *   HR-INT-5  HR → ADMIN                  → 403 (never opened to HR via teammate branch)
 *
 * SEED namespace: e51c2d3f-8b4a-** (distinct from drop-profile-rbac group)
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable (CI unit job) →
 *   every test returns early, suite stays green in no-DB environments.
 */

// ── Personas ─────────────────────────────────────────────────────────────────
const HR: User = makeRow({
  id: 'e51c2d3f-8b4a-4f10-aa00-000000000001',
  email: 'hr-teammate-hr@test.spec',
  displayName: 'HR Teammate Viewer',
  role: 'HR',
})

/** ACCOUNTANT teammate in HR's team — has finance/PII to mask */
const ACCOUNTANT_MATE: User = makeRow({
  id: 'e51c2d3f-8b4a-4f10-aa00-000000000002',
  email: 'hr-teammate-acc@test.spec',
  displayName: 'Accountant Teammate',
  role: 'ACCOUNTANT',
  phone: '+380501112233',
  telegram: '@acc_mate',
  legalFullName: 'Олена Бухгалтер-Прізвище',
  monthlySalary: '3100',
  salaryCurrency: 'USD',
  registrationAddress: 'м. Львів, вул. Прихована 5',
  usrRecord: 'USR-11223344',
  paymentMethod: 'BANK_UAH_FOP',
  bankUahIban: 'UA987654321098765432109876543',
  bankUahRecipient: 'Олена Бухгалтер-Прізвище',
})

/** Another HR teammate in HR's team — has finance/PII to mask */
const HR_MATE: User = makeRow({
  id: 'e51c2d3f-8b4a-4f10-aa00-000000000003',
  email: 'hr-teammate-hr2@test.spec',
  displayName: 'HR Teammate Two',
  role: 'HR',
  phone: '+380504445566',
  legalFullName: 'Ірина Кадровик-Прізвище',
  monthlySalary: '2800',
  salaryCurrency: 'USD',
  registrationAddress: 'м. Одеса, вул. Закрита 9',
  paymentMethod: 'USDT_ERC20',
  walletUsdtErc20: '0xDEADBEEF00000000000000000000000000000001',
})

/** ACCOUNTANT in a DIFFERENT team — HR must get 403 */
const ACCOUNTANT_OUTSIDER: User = makeRow({
  id: 'e51c2d3f-8b4a-4f10-aa00-000000000004',
  email: 'hr-teammate-acc-out@test.spec',
  displayName: 'Accountant Outsider',
  role: 'ACCOUNTANT',
  phone: '+380506667788',
})

/** SENIOR teammate in HR's team — regression: full senior surface preserved */
const SENIOR_MATE: User = makeRow({
  id: 'e51c2d3f-8b4a-4f10-aa00-000000000005',
  email: 'hr-teammate-senior@test.spec',
  displayName: 'Senior Teammate',
  role: 'SENIOR',
  phone: '+380507778899',
})

/** ADMIN — never opened to HR via the teammate branch */
const ADMIN_USER: User = makeRow({
  id: 'e51c2d3f-8b4a-4f10-aa00-000000000006',
  email: 'hr-teammate-admin@test.spec',
  displayName: 'Admin User',
  role: 'ADMIN',
})

const HR_TEAM_ID = 'e51c2d3f-8b4a-4f10-bb00-000000000010'
const OTHER_TEAM_ID = 'e51c2d3f-8b4a-4f10-bb00-000000000011'

const TEST_USER_IDS = [
  HR.id,
  ACCOUNTANT_MATE.id,
  HR_MATE.id,
  ACCOUNTANT_OUTSIDER.id,
  SENIOR_MATE.id,
  ADMIN_USER.id,
]
const TEST_TEAM_IDS = [HR_TEAM_ID, OTHER_TEAM_ID]

/** Build a full User row with safe defaults; override only the fields under test. */
function makeRow(overrides: Partial<User>): User {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    email: 'x@y.z',
    displayName: 'X',
    role: 'JUNIOR',
    googleId: null,
    avatarUrl: null,
    avatarDocumentId: null,
    telegram: null,
    phone: null,
    techStack: null,
    legalFullName: null,
    registrationAddress: null,
    usrRecord: null,
    adminNote: null,
    monthlySalary: null,
    salaryCurrency: null,
    seniorSharePercent: 0,
    dropSharePercent: null,
    paymentMethod: null,
    walletUsdtErc20: null,
    walletUsdtLabel: null,
    bankUahRecipient: null,
    bankUahIban: null,
    bankUahRnokpp: null,
    bankUahBankName: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as User
}

describe('HR teammate profile RBAC — real DB integration (task-hr-rbac-teammate-access)', () => {
  let dbAvailable = true
  let pool: Pool
  let dbSvc: DatabaseService
  let usersService: UsersService

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      await probe.end()
    } catch {
      console.warn('[hr-teammate-rbac integration] SKIPPED — no DB at DATABASE_URL (CI unit job)')
      dbAvailable = false
      return
    }

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(pool, { schema })
    dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, { pool, db })

    const accessService = new UsersAccessService(dbSvc)
    // buildProfileView only uses db + accessService + tosService (tosService is
    // called only for ADMIN/self viewers — not on the HR→teammate path).
    const tosService = {
      getLatestAcceptanceForUser: () => Promise.resolve(null),
    } as never
    usersService = Object.assign(Object.create(UsersService.prototype) as UsersService, {
      db: dbSvc,
      accessService,
      tosService,
    })

    // ── Seed ──────────────────────────────────────────────────────────────────
    await db
      .insert(users)
      .values([
        { ...HR, googleId: `test-hr-rbac-${HR.id}` },
        { ...ACCOUNTANT_MATE, googleId: `test-hr-rbac-${ACCOUNTANT_MATE.id}` },
        { ...HR_MATE, googleId: `test-hr-rbac-${HR_MATE.id}` },
        { ...ACCOUNTANT_OUTSIDER, googleId: `test-hr-rbac-${ACCOUNTANT_OUTSIDER.id}` },
        { ...SENIOR_MATE, googleId: `test-hr-rbac-${SENIOR_MATE.id}` },
        { ...ADMIN_USER, googleId: `test-hr-rbac-${ADMIN_USER.id}` },
      ])
      .onConflictDoNothing()

    await db
      .insert(teams)
      .values([
        { id: HR_TEAM_ID, name: 'HR RBAC Team' },
        { id: OTHER_TEAM_ID, name: 'HR RBAC Other Team' },
      ])
      .onConflictDoNothing()

    // HR + ACCOUNTANT_MATE + HR_MATE + SENIOR_MATE active in HR_TEAM;
    // ACCOUNTANT_OUTSIDER active in OTHER_TEAM. ADMIN is in no team.
    await db
      .insert(teamMembers)
      .values([
        { teamId: HR_TEAM_ID, userId: HR.id, joinedAt: new Date() },
        { teamId: HR_TEAM_ID, userId: ACCOUNTANT_MATE.id, joinedAt: new Date() },
        { teamId: HR_TEAM_ID, userId: HR_MATE.id, joinedAt: new Date() },
        { teamId: HR_TEAM_ID, userId: SENIOR_MATE.id, joinedAt: new Date() },
        { teamId: OTHER_TEAM_ID, userId: ACCOUNTANT_OUTSIDER.id, joinedAt: new Date() },
      ])
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      const db = dbSvc.db
      await db.delete(teamMembers).where(inArray(teamMembers.teamId, TEST_TEAM_IDS))
      await db.delete(teams).where(inArray(teams.id, TEST_TEAM_IDS))
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // Non-fatal cleanup failure — do not mask test results
    }
    await pool?.end()
  }, 15_000)

  // ── HR-INT-1: HR → ACCOUNTANT same team → 200, overview/team, masked ──────────

  it('HR-INT-1. HR viewing ACCOUNTANT teammate → 200, tabs=["overview","team"], finance/PII masked, contacts visible', async () => {
    if (!dbAvailable) return
    const view = await usersService.buildProfileView(HR, ACCOUNTANT_MATE.id)
    // Exactly overview + team — no projects/interviews/finance/requisites.
    expect(view.permissions.tabs).toEqual(['overview', 'team'])

    // Financial / PII fields MUST be masked (null) — no new leak from widening.
    expect(view.user.monthlySalary).toBeNull()
    expect(view.user.salaryCurrency).toBeNull()
    expect(view.user.paymentMethod).toBeNull()
    expect(view.user.walletUsdtErc20).toBeNull()
    expect(view.user.bankUahIban).toBeNull()
    expect(view.user.bankUahRecipient).toBeNull()
    expect(view.user.registrationAddress).toBeNull()
    expect(view.user.usrRecord).toBeNull()
    expect(view.user.legalFullName).toBeNull()
    expect(view.user.adminNote).toBeNull()

    // Contacts of a teammate ARE visible (same as SENIOR HR path).
    expect(view.user.email).toBe(ACCOUNTANT_MATE.email)
    expect(view.user.phone).toBe(ACCOUNTANT_MATE.phone)
    expect(view.user.telegram).toBe(ACCOUNTANT_MATE.telegram)
  })

  // ── HR-INT-2: HR → HR same team → 200, overview/team, masked ──────────────────

  it('HR-INT-2. HR viewing another HR teammate → 200, tabs=["overview","team"], finance/PII masked', async () => {
    if (!dbAvailable) return
    const view = await usersService.buildProfileView(HR, HR_MATE.id)
    expect(view.permissions.tabs).toEqual(['overview', 'team'])
    expect(view.user.monthlySalary).toBeNull()
    expect(view.user.paymentMethod).toBeNull()
    expect(view.user.walletUsdtErc20).toBeNull()
    expect(view.user.registrationAddress).toBeNull()
    expect(view.user.legalFullName).toBeNull()
    // Contacts visible
    expect(view.user.email).toBe(HR_MATE.email)
    expect(view.user.phone).toBe(HR_MATE.phone)
  })

  // ── HR-INT-3: HR → ACCOUNTANT other team → 403 ────────────────────────────────

  it('HR-INT-3. HR viewing ACCOUNTANT in a DIFFERENT team → 403 ForbiddenException (no leak)', async () => {
    if (!dbAvailable) return
    await expect(usersService.buildProfileView(HR, ACCOUNTANT_OUTSIDER.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  // ── HR-INT-4: HR → SENIOR same team → 200, full senior surface (regression) ───

  it('HR-INT-4. HR viewing SENIOR teammate → 200, tabs=["overview","projects","team","interviews"] (regression)', async () => {
    if (!dbAvailable) return
    const view = await usersService.buildProfileView(HR, SENIOR_MATE.id)
    expect(view.permissions.tabs).toEqual(['overview', 'projects', 'team', 'interviews'])
    // SENIOR contacts visible, finance still masked for HR.
    expect(view.user.email).toBe(SENIOR_MATE.email)
    expect(view.user.monthlySalary).toBeNull()
  })

  // ── HR-INT-5: HR → ADMIN → 403 ────────────────────────────────────────────────

  it('HR-INT-5. HR viewing an ADMIN → 403 ForbiddenException (ADMIN never opened to HR)', async () => {
    if (!dbAvailable) return
    await expect(usersService.buildProfileView(HR, ADMIN_USER.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })
})
