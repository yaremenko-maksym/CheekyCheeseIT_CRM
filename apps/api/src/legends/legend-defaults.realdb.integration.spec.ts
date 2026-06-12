/**
 * Real-DB integration test — legend.defaults RBAC (AC8 gap-fill)
 *
 * WHY this exists (feedback_mocked_e2e_guards lesson, lessons.md 2026-06-09,
 * bug class #157/#158 — real data-leaks found post-merge):
 *   legends.rbac.integration.spec.ts covers canAccess (200/403 matrix) but
 *   does NOT explicitly assert that the `defaults` field in the response
 *   is null for JUNIOR viewers and non-null for ADMIN/HR viewers.
 *
 *   This spec directly tests LegendsService.getLegend() with the real DB and
 *   verifies the data-isolation invariant:
 *
 *   AC8a: JUNIOR viewer (active project member) → getLegend() → defaults === null
 *         (legal_full_name / registration_address of subject NOT leaked)
 *   AC8b: ADMIN viewer → getLegend() → defaults.fullName === subject legal_full_name
 *   AC8c: HR viewer (same-team scoped) → getLegend() → defaults.fullName non-null
 *
 * SEED: inserts isolated test rows in beforeAll, deletes in afterAll.
 * IDs namespaced ld8- (legend-defaults-realdb) — no collision with other specs.
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable.
 */

import { Global, Module } from '@nestjs/common'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { HrAccessService } from '../common/hr-access.service'
import { DatabaseService } from '../database/database.service'
import { LegendsService } from './legends.service'
import {
  legends,
  legendEntries,
  projects,
  projectMembers,
  teamMembers,
  teams,
  users,
} from '../database/schema'
import * as schema from '../database/schema'

// ---------------------------------------------------------------------------
// Test IDs — stable namespace ld8-
// ---------------------------------------------------------------------------
const SUBJECT_SENIOR_ID = '1d800001-0000-4000-aa00-000000000001'
const SUBJECT_SENIOR_EMAIL = 'ld8-senior@test.spec'
const SUBJECT_SENIOR_LEGAL_NAME = 'LD8 Тестовий Синьор Олексійович'
const SUBJECT_SENIOR_ADDRESS = 'м. Київ, вул. Тестова, 1'

const JUNIOR_MEMBER_ID = '1d800001-0000-4000-aa00-000000000002'
const JUNIOR_MEMBER_EMAIL = 'ld8-junior@test.spec'

const HR_MEMBER_ID = '1d800001-0000-4000-aa00-000000000003'
const HR_MEMBER_EMAIL = 'ld8-hr@test.spec'

// ADMIN from seed — always exists in the DB
const ADMIN_ID = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
const ADMIN_SESSION: SessionUser = {
  id: ADMIN_ID,
  email: 'yaremenkomaksym99@gmail.com',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
}

const PROJECT_ID = '1d800001-0000-4000-bb00-000000000010'
const LEGEND_ID = '1d800001-0000-4000-bb00-000000000020'
const TEAM_ID = '1d800001-0000-4000-bb00-000000000030'
const PROJECT_MEMBER_ID = '1d800001-0000-4000-bb00-000000000040'

const TEST_USER_IDS = [SUBJECT_SENIOR_ID, JUNIOR_MEMBER_ID, HR_MEMBER_ID]

// ---------------------------------------------------------------------------
// DB availability flag
// ---------------------------------------------------------------------------
let dbAvailable = true
let _pool: Pool | null = null
let legendsSvc: LegendsService

const JUNIOR_SESSION: SessionUser = {
  id: JUNIOR_MEMBER_ID,
  email: JUNIOR_MEMBER_EMAIL,
  displayName: 'LD8 Junior',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
}

const HR_SESSION: SessionUser = {
  id: HR_MEMBER_ID,
  email: HR_MEMBER_EMAIL,
  displayName: 'LD8 HR',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe('LegendsService.getLegend — defaults RBAC, real DB (AC8)', () => {
  beforeAll(async () => {
    // DB availability probe
    try {
      const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probePool.query('SELECT 1')
      // Also verify legends.project_id column exists (migration check from legends.rbac spec)
      const schemaCheck = await probePool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name='legends' AND column_name='project_id' LIMIT 1`,
      )
      await probePool.end()
      if (schemaCheck.rowCount === 0) {
        console.warn(
          '[legend-defaults-realdb] SKIPPED — legends.project_id column not found (run migration against this DB)',
        )
        dbAvailable = false
        return
      }
    } catch {
      console.warn(
        '[legend-defaults-realdb] SKIPPED — no DB at DATABASE_URL (expected in CI unit job)',
      )
      dbAvailable = false
      return
    }

    _pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(_pool, { schema })
    const dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
    Object.assign(dbSvc, { pool: _pool, db })

    legendsSvc = new LegendsService(dbSvc, new HrAccessService(dbSvc))

    // ── Seed users
    await db
      .insert(users)
      .values([
        {
          id: SUBJECT_SENIOR_ID,
          email: SUBJECT_SENIOR_EMAIL,
          displayName: 'LD8 Senior Subject',
          role: 'SENIOR',
          googleId: `test-google-${SUBJECT_SENIOR_ID}`,
          legalFullName: SUBJECT_SENIOR_LEGAL_NAME,
          registrationAddress: SUBJECT_SENIOR_ADDRESS,
        },
        {
          id: JUNIOR_MEMBER_ID,
          email: JUNIOR_MEMBER_EMAIL,
          displayName: 'LD8 Junior Member',
          role: 'JUNIOR',
          googleId: `test-google-${JUNIOR_MEMBER_ID}`,
        },
        {
          id: HR_MEMBER_ID,
          email: HR_MEMBER_EMAIL,
          displayName: 'LD8 HR Member',
          role: 'HR',
          googleId: `test-google-${HR_MEMBER_ID}`,
        },
      ])
      .onConflictDoNothing()

    // ── Seed project (seniorId = SUBJECT_SENIOR, no drop)
    await db
      .insert(projects)
      .values([
        {
          id: PROJECT_ID,
          name: 'LD8 Defaults Test Project',
          companyName: 'LD8 Test Corp',
          domain: 'e-commerce',
          startDate: new Date('2025-01-01'),
          seniorId: SUBJECT_SENIOR_ID,
          dropId: null,
          currency: 'USDT',
          rate: '100',
        },
      ])
      .onConflictDoNothing()

    // ── Seed legend for the project
    await db
      .insert(legends)
      .values([
        {
          id: LEGEND_ID,
          projectId: PROJECT_ID,
          fullName: 'LD8 Test Persona',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ])
      .onConflictDoNothing()

    // ── Seed project_member: JUNIOR is active member
    await db
      .insert(projectMembers)
      .values([
        {
          id: PROJECT_MEMBER_ID,
          projectId: PROJECT_ID,
          userId: JUNIOR_MEMBER_ID,
          joinedAt: new Date(),
        },
      ])
      .onConflictDoNothing()

    // ── Seed team: HR + SENIOR in same team → HR can access
    await db
      .insert(teams)
      .values([{ id: TEAM_ID, name: 'LD8 Test Team' }])
      .onConflictDoNothing()

    await db
      .insert(teamMembers)
      .values([
        { teamId: TEAM_ID, userId: HR_MEMBER_ID, joinedAt: new Date() },
        { teamId: TEAM_ID, userId: SUBJECT_SENIOR_ID, joinedAt: new Date() },
      ])
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable || !_pool) return
    try {
      const db = drizzle(_pool, { schema })
      // Clean up FK-safe order
      await db.delete(legendEntries).where(eq(legendEntries.legendId, LEGEND_ID))
      await db.delete(legends).where(eq(legends.id, LEGEND_ID))
      await db.delete(projectMembers).where(eq(projectMembers.id, PROJECT_MEMBER_ID))
      await db.delete(teamMembers).where(eq(teamMembers.teamId, TEAM_ID))
      await db.delete(projects).where(eq(projects.id, PROJECT_ID))
      await db.delete(teams).where(eq(teams.id, TEAM_ID))
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } finally {
      await _pool.end()
    }
  }, 15_000)

  it('AC8a: JUNIOR viewer (active member) → defaults === null (identity NOT leaked)', async () => {
    if (!dbAvailable) return
    /**
     * CRITICAL assertion (bug class #157/#158):
     * JUNIOR can see the legend (200) but MUST NOT receive
     * the real legal_full_name / registration_address of the subject.
     * defaults field must be null for JUNIOR viewers.
     */
    const legend = await legendsSvc.getLegend(JUNIOR_SESSION, PROJECT_ID)
    expect(legend.defaults).toBeNull()
  })

  it('AC8b: ADMIN viewer → defaults.fullName = subject legal_full_name', async () => {
    if (!dbAvailable) return
    const legend = await legendsSvc.getLegend(ADMIN_SESSION, PROJECT_ID)
    expect(legend.defaults).not.toBeNull()
    expect(legend.defaults!.fullName).toBe(SUBJECT_SENIOR_LEGAL_NAME)
    expect(legend.defaults!.address).toBe(SUBJECT_SENIOR_ADDRESS)
  })

  it('AC8c: HR viewer (same-team scoped) → defaults.fullName non-null (same as ADMIN)', async () => {
    if (!dbAvailable) return
    const legend = await legendsSvc.getLegend(HR_SESSION, PROJECT_ID)
    expect(legend.defaults).not.toBeNull()
    expect(legend.defaults!.fullName).toBe(SUBJECT_SENIOR_LEGAL_NAME)
  })

  it('AC8d: subject (SENIOR = seniorId) → getLegend throws 403 (subject excluded)', async () => {
    if (!dbAvailable) return
    const subjectSession: SessionUser = {
      id: SUBJECT_SENIOR_ID,
      email: SUBJECT_SENIOR_EMAIL,
      displayName: 'LD8 Senior Subject',
      avatarUrl: null,
      role: 'SENIOR',
      seniorSharePercent: 26,
    }
    await expect(legendsSvc.getLegend(subjectSession, PROJECT_ID)).rejects.toThrow()
  })
})
