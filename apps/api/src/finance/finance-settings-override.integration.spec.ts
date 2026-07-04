import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { ProjectsService } from '../projects/projects.service'
import { TeamAuditLogService } from '../teams/team-audit-log.service'
import { ProjectAuditLogService } from '../projects/project-audit-log.service'
import {
  projects,
  projectFinanceSettings,
  teamMembers,
  teams,
  users,
  transactions,
} from '../database/schema'
import * as schema from '../database/schema'

/**
 * BIZ-22 — upsertProjectFinanceSettings must mirror seniorSharePercentOverride
 * back into projects.senior_share_percent_override so that subsequent
 * SENIOR_INCOME transactions pick up the correct value.
 *
 * Root cause: upsertProjectFinanceSettings() wrote ONLY to project_finance_settings
 * but createSeniorIncome() read from project.seniorSharePercentOverride (in the
 * projects table) via the hierarchy resolver. Since syncFinanceSettingsOverride()
 * only ran from projects.service.ts create/update, a PATCH /projects/:id/finance-settings
 * silently had no effect on SENIOR_INCOME attribution.
 *
 * Fix: upsertProjectFinanceSettings() must now also UPDATE projects.senior_share_percent_override
 * in the same transaction.
 *
 * Seed namespace: a5b6c7d8-0e1f-4a5b-** (distinct from other integration specs).
 *
 * DB-SKIP-GUARD: skips when DATABASE_URL is not reachable.
 */

const ADMIN: SessionUser = {
  id: 'a5b6c7d8-0e1f-4a5b-aa00-000000000001',
  email: 'fso-admin@test.spec',
  displayName: 'FSO Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}

const SENIOR: SessionUser = {
  id: 'a5b6c7d8-0e1f-4a5b-aa00-000000000002',
  email: 'fso-senior@test.spec',
  displayName: 'FSO Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

const TEAM_ID = 'a5b6c7d8-0e1f-4a5b-bb00-000000000010'
const PROJECT_ID = 'a5b6c7d8-0e1f-4a5b-cc00-000000000020'

const TEST_USER_IDS = [ADMIN.id, SENIOR.id]

describe('BIZ-22 — upsertProjectFinanceSettings syncs to projects table (real DB)', () => {
  let pool: Pool
  let dbSvc: DatabaseService
  let txSvc: TransactionsService
  let dbAvailable = true

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      await probe.end()
    } catch {
      console.warn(
        '[finance-settings-override integration] SKIPPED — no DB reachable at DATABASE_URL',
      )
      dbAvailable = false
      return
    }

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(pool, { schema })
    dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
    Object.assign(dbSvc, { pool, db })

    // Build minimal service stubs — only upsertProjectFinanceSettings path tested
    const teamAuditSvc = { record: async () => {} } as unknown as TeamAuditLogService
    const projectAuditSvc = { record: async () => {} } as unknown as ProjectAuditLogService
    const projectsSvc = Object.create(ProjectsService.prototype) as ProjectsService
    Object.assign(projectsSvc, {
      db: dbSvc,
      teamAuditLogService: teamAuditSvc,
      projectAuditLogService: projectAuditSvc,
    })
    txSvc = Object.create(TransactionsService.prototype) as TransactionsService
    Object.assign(txSvc, { db: dbSvc })

    // Seed users + team + project
    await db
      .insert(users)
      .values([
        {
          id: ADMIN.id,
          email: ADMIN.email,
          displayName: ADMIN.displayName,
          role: 'ADMIN',
          googleId: `test-fso-${ADMIN.id}`,
        },
        {
          id: SENIOR.id,
          email: SENIOR.email,
          displayName: SENIOR.displayName,
          role: 'SENIOR',
          googleId: `test-fso-${SENIOR.id}`,
        },
      ])
      .onConflictDoNothing()

    await db
      .insert(teams)
      .values([{ id: TEAM_ID, name: 'FSO Team' }])
      .onConflictDoNothing()
    await db
      .insert(teamMembers)
      .values([{ teamId: TEAM_ID, userId: SENIOR.id }])
      .onConflictDoNothing()

    await db
      .insert(projects)
      .values({
        id: PROJECT_ID,
        name: 'FSO Project',
        companyName: 'FSO Corp',
        domain: 'Other',
        startDate: new Date('2024-01-01'),
        seniorId: SENIOR.id,
        rate: 100,
        currency: 'USDT' as never,
        seniorSharePercentOverride: null,
      })
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      await dbSvc.db.delete(transactions).where(eq(transactions.projectId, PROJECT_ID))
      await dbSvc.db
        .delete(projectFinanceSettings)
        .where(eq(projectFinanceSettings.projectId, PROJECT_ID))
      await dbSvc.db.delete(projects).where(eq(projects.id, PROJECT_ID))
      await dbSvc.db.delete(teamMembers).where(eq(teamMembers.teamId, TEAM_ID))
      await dbSvc.db.delete(teams).where(eq(teams.id, TEAM_ID))
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal
    }
    await pool.end()
  }, 15_000)

  beforeEach(async () => {
    if (!dbAvailable) return
    // Reset both tables to null override
    await dbSvc.db
      .update(projects)
      .set({ seniorSharePercentOverride: null })
      .where(eq(projects.id, PROJECT_ID))
    await dbSvc.db
      .delete(projectFinanceSettings)
      .where(eq(projectFinanceSettings.projectId, PROJECT_ID))
  })

  it('upsertProjectFinanceSettings mirrors seniorSharePercentOverride into projects table', async () => {
    if (!dbAvailable) return

    await txSvc.upsertProjectFinanceSettings(PROJECT_ID, { seniorSharePercentOverride: 30 }, ADMIN)

    // BOTH tables must have the updated value
    const fsRow = await dbSvc.db.query.projectFinanceSettings.findFirst({
      where: eq(projectFinanceSettings.projectId, PROJECT_ID),
    })
    expect(fsRow?.seniorSharePercentOverride).toBe(30)

    const projectRow = await dbSvc.db.query.projects.findFirst({
      where: eq(projects.id, PROJECT_ID),
    })
    expect(projectRow?.seniorSharePercentOverride).toBe(30)
  })

  it('upsertProjectFinanceSettings clears override in BOTH tables when set to null', async () => {
    if (!dbAvailable) return

    // First set a value
    await txSvc.upsertProjectFinanceSettings(PROJECT_ID, { seniorSharePercentOverride: 35 }, ADMIN)

    // Then clear it
    await txSvc.upsertProjectFinanceSettings(
      PROJECT_ID,
      { seniorSharePercentOverride: null },
      ADMIN,
    )

    const fsRow = await dbSvc.db.query.projectFinanceSettings.findFirst({
      where: eq(projectFinanceSettings.projectId, PROJECT_ID),
    })
    expect(fsRow?.seniorSharePercentOverride).toBeNull()

    const projectRow = await dbSvc.db.query.projects.findFirst({
      where: eq(projects.id, PROJECT_ID),
    })
    expect(projectRow?.seniorSharePercentOverride).toBeNull()
  })

  it('upsertProjectFinanceSettings in senior-share resolver path: override set via finance-settings endpoint is picked up by createSeniorIncome resolver', async () => {
    if (!dbAvailable) return

    // Set override to 40% via the finance-settings path
    await txSvc.upsertProjectFinanceSettings(PROJECT_ID, { seniorSharePercentOverride: 40 }, ADMIN)

    // The resolver reads from project.seniorSharePercentOverride — verify it is 40
    const projectRow = await dbSvc.db.query.projects.findFirst({
      where: eq(projects.id, PROJECT_ID),
      with: { financeSettings: true },
    })
    // After the fix, projects.senior_share_percent_override must equal 40
    expect(projectRow?.seniorSharePercentOverride).toBe(40)
    // And the finance settings mirror must also be 40
    expect(projectRow?.financeSettings?.seniorSharePercentOverride).toBe(40)
  })
})
