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
 * task-drop-profile-rbac-r2 — DROP profile RBAC, real-Postgres integration.
 *
 * WHY this exists (security-critical, OWASP A01):
 *   DROP gained the ability to open the "card" of a teammate. A mocked-service
 *   test cannot prove that the masked DTO emitted by buildProfileView actually
 *   nulls out the teammate's real contacts / PII / finance — the exact class of
 *   data-leak that bit us 3× (feedback_mocked_e2e_guards). This spec drives the
 *   REAL UsersAccessService.getViewPermissions + UsersService.buildProfileView
 *   against a real DB row so a regression in flag-wiring OR field-projection fails.
 *
 * COVERED:
 *   B-INT-1  DROP → teammate (same active team)  → 200, tabs=['overview'],
 *            real email/phone/telegram/legalFullName/salary/requisites ABSENT (null)
 *   B-INT-2  DROP → outsider (different team)     → 403 ForbiddenException
 *   B-INT-3  DROP self                            → 200, tabs=['overview','requisites']
 *   B-INT-4  DROP → former teammate (leftAt set)  → 403 (active membership required)
 *
 * SEED namespace: d40b1c2e-7a3f-4f10-** (distinct from existing groups)
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable (CI unit job) →
 *   every test returns early, suite stays green in no-DB environments.
 */

// ── Personas ─────────────────────────────────────────────────────────────────
const DROP: User = makeRow({
  id: 'd40b1c2e-7a3f-4f10-aa00-000000000001',
  email: 'drop-rbac-drop@test.spec',
  displayName: 'Drop RBAC Drop',
  role: 'DROP',
})

/** SENIOR teammate sharing DROP's team — has real contacts/PII/finance to mask */
const TEAMMATE: User = makeRow({
  id: 'd40b1c2e-7a3f-4f10-aa00-000000000002',
  email: 'drop-rbac-teammate@test.spec',
  displayName: 'Drop RBAC Teammate (persona name)',
  role: 'SENIOR',
  phone: '+380501234567',
  telegram: '@teammate_secret',
  legalFullName: 'Тарас Реальне-Прізвище',
  monthlySalary: '4200',
  salaryCurrency: 'USD',
  registrationAddress: 'м. Київ, вул. Секретна 1',
  usrRecord: 'USR-99887766',
  paymentMethod: 'BANK_UAH_FOP',
  bankUahIban: 'UA123456789012345678901234567',
  bankUahRecipient: 'Тарас Реальне-Прізвище',
})

/** SENIOR outsider — member of a DIFFERENT team, DROP must get 403 */
const OUTSIDER: User = makeRow({
  id: 'd40b1c2e-7a3f-4f10-aa00-000000000003',
  email: 'drop-rbac-outsider@test.spec',
  displayName: 'Drop RBAC Outsider',
  role: 'SENIOR',
  phone: '+380677654321',
})

const DROP_TEAM_ID = 'd40b1c2e-7a3f-4f10-bb00-000000000010'
const OTHER_TEAM_ID = 'd40b1c2e-7a3f-4f10-bb00-000000000011'

const TEST_USER_IDS = [DROP.id, TEAMMATE.id, OUTSIDER.id]
const TEST_TEAM_IDS = [DROP_TEAM_ID, OTHER_TEAM_ID]

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

describe('DROP profile RBAC — real DB integration (task-drop-profile-rbac-r2)', () => {
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
      console.warn('[drop-profile-rbac integration] SKIPPED — no DB at DATABASE_URL (CI unit job)')
      dbAvailable = false
      return
    }

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(pool, { schema })
    dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, { pool, db })

    const accessService = new UsersAccessService(dbSvc)
    // buildProfileView only uses db + accessService + tosService (tosService is
    // called only for ADMIN/self viewers — not on the DROP→teammate path).
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
        { ...DROP, googleId: `test-drop-rbac-${DROP.id}` },
        { ...TEAMMATE, googleId: `test-drop-rbac-${TEAMMATE.id}` },
        { ...OUTSIDER, googleId: `test-drop-rbac-${OUTSIDER.id}` },
      ])
      .onConflictDoNothing()

    await db
      .insert(teams)
      .values([
        { id: DROP_TEAM_ID, name: 'Drop RBAC Team' },
        { id: OTHER_TEAM_ID, name: 'Drop RBAC Other Team' },
      ])
      .onConflictDoNothing()

    // DROP + TEAMMATE active in DROP_TEAM; OUTSIDER active in OTHER_TEAM
    await db
      .insert(teamMembers)
      .values([
        { teamId: DROP_TEAM_ID, userId: DROP.id, joinedAt: new Date() },
        { teamId: DROP_TEAM_ID, userId: TEAMMATE.id, joinedAt: new Date() },
        { teamId: OTHER_TEAM_ID, userId: OUTSIDER.id, joinedAt: new Date() },
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

  // ── B-INT-1: DROP → teammate open card, masked ───────────────────────────────

  it('B-INT-1. DROP viewing OWN-TEAM member → 200, tabs=["overview"], real contacts/PII/finance ABSENT', async () => {
    if (!dbAvailable) return
    const view = await usersService.buildProfileView(DROP, TEAMMATE.id)

    // Open card = overview ONLY
    expect(view.permissions.tabs).toEqual(['overview'])

    // ── Identity / contacts — MUST be null (real values were seeded) ──────────
    expect(view.user.email, 'real email must be masked').toBeNull()
    expect(view.user.phone, 'real phone must be masked').toBeNull()
    expect(view.user.telegram, 'real telegram must be masked').toBeNull()
    expect(view.user.legalFullName, 'passport legalFullName must be masked').toBeNull()

    // ── FOP PII — MUST be null ────────────────────────────────────────────────
    expect(view.user.registrationAddress, 'FOP address must be masked').toBeNull()
    expect(view.user.usrRecord, 'USR record must be masked').toBeNull()

    // ── Finance — MUST be null ────────────────────────────────────────────────
    expect(view.user.monthlySalary, 'salary must be masked').toBeNull()
    expect(view.user.salaryCurrency, 'salary currency must be masked').toBeNull()

    // ── Requisites — MUST be null ─────────────────────────────────────────────
    expect(view.user.paymentMethod, 'paymentMethod must be masked').toBeNull()
    expect(view.user.bankUahIban, 'IBAN must be masked').toBeNull()
    expect(view.user.bankUahRecipient, 'bank recipient must be masked').toBeNull()

    // ── adminNote — MUST be null ──────────────────────────────────────────────
    expect(view.user.adminNote, 'adminNote must be masked').toBeNull()

    // ── Persona display name is allowed (client-facing identity) ──────────────
    expect(view.user.displayName).toBe(TEAMMATE.displayName)
    expect(view.user.role).toBe('SENIOR')

    // ── Raw payload must not leak the real secret values anywhere ─────────────
    const raw = JSON.stringify(view)
    expect(raw, 'raw response must not contain real phone').not.toContain('+380501234567')
    expect(raw, 'raw response must not contain real telegram').not.toContain('@teammate_secret')
    expect(raw, 'raw response must not contain real IBAN').not.toContain(
      'UA123456789012345678901234567',
    )
    expect(raw, 'raw response must not contain real email').not.toContain(TEAMMATE.email)
    expect(raw, 'raw response must not contain passport name').not.toContain(
      'Тарас Реальне-Прізвище',
    )
  })

  // ── B-INT-2: DROP → outsider, 403 ────────────────────────────────────────────

  it('B-INT-2. DROP viewing a NON-teammate (different team) → 403 ForbiddenException (no leak)', async () => {
    if (!dbAvailable) return
    await expect(usersService.buildProfileView(DROP, OUTSIDER.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  // ── B-INT-3: DROP self → minimal allow-list ──────────────────────────────────

  it('B-INT-3. DROP self-view → 200, tabs=["overview","requisites"] (Finding A)', async () => {
    if (!dbAvailable) return
    const view = await usersService.buildProfileView(DROP, DROP.id)
    expect(view.permissions.tabs).toEqual(['overview', 'requisites'])
    // self sees own real email (not masked for self)
    expect(view.user.email).toBe(DROP.email)
  })

  // ── B-INT-4: former teammate (leftAt set) → 403 ──────────────────────────────

  it('B-INT-4. DROP viewing a FORMER teammate (leftAt set) → 403 (active membership required)', async () => {
    if (!dbAvailable) return
    const db = dbSvc.db
    // Temporarily mark TEAMMATE as having left the shared team
    await db
      .update(teamMembers)
      .set({ leftAt: new Date() })
      .where(inArray(teamMembers.userId, [TEAMMATE.id]))

    try {
      await expect(usersService.buildProfileView(DROP, TEAMMATE.id)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    } finally {
      // Restore active membership for any subsequent runs / re-seed idempotency
      await db
        .update(teamMembers)
        .set({ leftAt: null })
        .where(inArray(teamMembers.userId, [TEAMMATE.id]))
    }
  })
})
