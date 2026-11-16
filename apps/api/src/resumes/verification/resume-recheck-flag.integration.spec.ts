/**
 * Backlog 442 on a real Postgres: a VERIFIED resume is flagged "re-check needed" when the owner's
 * display name, legal name or Telegram really changes, through both writers (the self profile
 * update and the admin edit), and the flag rides into the resume DTO. The clear on confirm is in
 * `resume-verification-confirm.integration.spec.ts` (it needs the run harness).
 *
 * NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run resume-recheck-flag.integration.spec
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../../database/schema'
import { seniorResumes, users } from '../../database/schema'
import { DatabaseService } from '../../database/database.service'
import { assertRealDbSchema, hasDatabaseUrl } from '../../test/require-real-db'
import { makeNotificationsStub } from '../../notifications/__test-helpers__/notifications-stub'
import { AuditLogService } from '../../users/audit-log.service'
import { UsersService } from '../../users/users.service'
import { TeamAuditLogService } from '../../teams/team-audit-log.service'
import { ProjectAuditLogService } from '../../projects/project-audit-log.service'
import { TeamsService } from '../../teams/teams.service'
import { scanContacts } from './contact-scan'
import { ResumeVerificationService } from './resume-verification.service'
import { loadOwnerContacts } from './verification-runner'

const OWNER_ID = 'b4420000-0000-4000-8000-000000000001'
const ADMIN_ID = 'b4420000-0000-4000-8000-000000000002'
const IDS = [OWNER_ID, ADMIN_ID]
const OWNER = {
  displayName: 'Olena Koval',
  legalFullName: 'Коваль Олена Петрівна',
  telegram: '@olena_k',
}

describe.skipIf(!hasDatabaseUrl())('resume re-check flag — real DB (backlog 442)', () => {
  let pool: Pool
  let dbSvc: DatabaseService
  let usersService: UsersService

  const resumeRow = async () => {
    const [row] = await dbSvc.db
      .select()
      .from(seniorResumes)
      .where(eq(seniorResumes.userId, OWNER_ID))
    if (!row) throw new Error('fixture resume vanished')
    return row
  }
  const flagOf = async () => (await resumeRow()).recheckNeededAt
  const setResume = (set: Partial<typeof seniorResumes.$inferInsert>) =>
    dbSvc.db.update(seniorResumes).set(set).where(eq(seniorResumes.userId, OWNER_ID))

  beforeAll(async () => {
    await assertRealDbSchema([{ table: 'senior_resumes', column: 'recheck_needed_at' }])
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const { rows } = await pool.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    const db = drizzle(pool, { schema })
    dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, { pool, db })
    const teamAuditLog = new TeamAuditLogService(dbSvc)
    const teamsService = new TeamsService(dbSvc, {} as never, teamAuditLog, makeNotificationsStub())
    usersService = new UsersService(
      dbSvc,
      {} as never,
      new AuditLogService(dbSvc),
      {} as never,
      teamAuditLog,
      new ProjectAuditLogService(dbSvc),
      teamsService,
      {} as never,
      { getStatus: async () => 'NONE' as const } as never,
      makeNotificationsStub(),
    )
    ;(teamsService as unknown as { usersService: UsersService }).usersService = usersService
    await db.delete(seniorResumes).where(inArray(seniorResumes.userId, IDS))
    await db.delete(users).where(inArray(users.id, IDS))
    await db.insert(users).values([
      {
        id: OWNER_ID,
        email: 'b442-owner@recheck.spec',
        role: 'SENIOR',
        googleId: `g-${OWNER_ID}`,
        ...OWNER,
      },
      {
        id: ADMIN_ID,
        email: 'b442-admin@recheck.spec',
        displayName: 'B442 Admin',
        role: 'ADMIN',
        googleId: `g-${ADMIN_ID}`,
      },
    ])
    await db.insert(seniorResumes).values({ userId: OWNER_ID, templateName: 'classic' })
  }, 30_000)

  beforeEach(async () => {
    await dbSvc.db.update(users).set(OWNER).where(eq(users.id, OWNER_ID))
    await setResume({ verificationStatus: 'VERIFIED', recheckNeededAt: null })
  })

  afterAll(async () => {
    try {
      await dbSvc.db.delete(seniorResumes).where(inArray(seniorResumes.userId, IDS))
      await dbSvc.db.delete(users).where(inArray(users.id, IDS))
    } finally {
      await pool?.end()
    }
  })

  it('a rename of a VERIFIED senior sets the flag (self profile update)', async () => {
    const before = Date.now()
    await usersService.updateProfile(OWNER_ID, { displayName: 'Olena Moroz' })
    const flag = await flagOf()
    expect(flag).toBeInstanceOf(Date)
    expect(flag!.getTime()).toBeGreaterThanOrEqual(before - 1_000)
  })

  it('the same name again does not set it', async () => {
    await usersService.updateProfile(OWNER_ID, {
      displayName: OWNER.displayName,
      telegram: OWNER.telegram,
    })
    expect(await flagOf()).toBeNull()
  })

  it('a non-VERIFIED resume is not flagged', async () => {
    for (const status of ['DRAFT', 'AWAITING_CONFIRM', 'FAILED'] as const) {
      await setResume({ verificationStatus: status, recheckNeededAt: null })
      await usersService.updateProfile(OWNER_ID, { displayName: `Renamed ${status}` })
      expect(await flagOf()).toBeNull()
    }
  })

  it('a Telegram change sets it (self profile update)', async () => {
    await usersService.updateProfile(OWNER_ID, { telegram: '@olena_new' })
    expect(await flagOf()).toBeInstanceOf(Date)
  })

  it('a legal name change sets it (admin edit); the same legal name does not', async () => {
    await usersService.adminUpdateUser(
      OWNER_ID,
      { legalFullName: `  ${OWNER.legalFullName}  ` },
      ADMIN_ID,
    )
    expect(await flagOf()).toBeNull()
    await usersService.adminUpdateUser(
      OWNER_ID,
      { legalFullName: 'Мороз Олена Петрівна' },
      ADMIN_ID,
    )
    expect(await flagOf()).toBeInstanceOf(Date)
  })

  it('an admin rename and an admin Telegram change set it', async () => {
    await usersService.adminUpdateUser(OWNER_ID, { displayName: 'Olena A' }, ADMIN_ID)
    expect(await flagOf()).toBeInstanceOf(Date)
    await setResume({ recheckNeededAt: null })
    await usersService.adminUpdateUser(OWNER_ID, { telegram: '@olena_admin' }, ADMIN_ID)
    expect(await flagOf()).toBeInstanceOf(Date)
  })

  it('a failed write rolls the flag back with it', async () => {
    await expect(
      usersService.adminUpdateUser(
        OWNER_ID,
        { displayName: 'Olena Rollback', avatarDocumentId: 'b4420000-0000-4000-8000-0000000000ff' },
        ADMIN_ID,
      ),
    ).rejects.toBeDefined()
    expect(await flagOf()).toBeNull()
  })

  it('backlog Verify: the flag reaches the resume read, and the contact scan with the new name finds it in the facts', async () => {
    await usersService.updateProfile(OWNER_ID, { displayName: 'Olena Moroz' })
    const verification = new ResumeVerificationService(dbSvc, {} as never, {} as never)
    const dto = await verification.toDtoFields(await resumeRow())
    expect(dto.recheckNeededAt).toEqual((await flagOf())!.toISOString())

    const owner = await loadOwnerContacts(dbSvc, OWNER_ID)
    const seededFact = 'Led a team of five; contact Olena Moroz for references.'
    const hits = owner!.contacts.flatMap((ctx) => scanContacts(seededFact, ctx))
    expect(hits.map((h) => h.kind)).toContain('name')
  })
})
