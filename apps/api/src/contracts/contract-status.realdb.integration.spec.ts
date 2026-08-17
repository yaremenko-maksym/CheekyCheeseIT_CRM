/**
 * Real-DB integration test — GET /api/contracts/me/status (AC2 gap-fill)
 *
 * WHY this exists (feedback_mocked_e2e_guards lesson, lessons.md 2026-06-09):
 *   contract-status.integration.spec.ts proves routing/auth with a sentinel
 *   controller but uses NO real DB. This spec uses the real
 *   EmployeeContractsService + real PostgreSQL to verify:
 *
 *   AC2a: JUNIOR with employee_contracts.status=SIGNED → getMyStatus returns SIGNED
 *   AC2b: User with no active contract → getMyStatus returns null
 *   AC2c: Self-only: getMyStatus(userA.id) never returns userB's contract
 *
 * SEED: inserts isolated test rows in beforeAll, deletes in afterAll.
 * IDs namespaced to this spec run — no collision with other integration specs.
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable (CI unit job).
 * Every test does `if (!dbAvailable) return` and stays green.
 */

import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DatabaseService } from '../database/database.service'
import { EmployeeContractsService } from './employee-contracts.service'
import { ContractTemplatesService } from './contract-templates.service'
import { employeeContracts, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

// ---------------------------------------------------------------------------
// Template IDs are resolved dynamically from the target DB in beforeAll.
// ADMIN ID from seed (stable across both crm_db and crm_scratch_m6)
const SEED_ADMIN_ID = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
let TEMPLATE_JUNIOR_ID: string
let TEMPLATE_SENIOR_ID: string

// Test IDs — stable namespace c5db- (contract-status-realdb), valid hex UUIDs
// ---------------------------------------------------------------------------
const J_SIGNED_ID = 'c5db0001-0000-4000-aa00-000000000001'
const J_SIGNED_EMAIL = 'cs2-junior-signed@test.spec'
const J_NOSIGNED_ID = 'c5db0001-0000-4000-aa00-000000000002'
const J_NOSIGNED_EMAIL = 'cs2-junior-nosigned@test.spec'
const SENIOR_ID = 'c5db0001-0000-4000-aa00-000000000003'
const SENIOR_EMAIL = 'cs2-senior@test.spec'

const EC_SIGNED_ID = 'c5db0001-0000-4000-bb00-000000000010'
const EC_SENIOR_ID = 'c5db0001-0000-4000-bb00-000000000011'

const TEST_USER_IDS = [J_SIGNED_ID, J_NOSIGNED_ID, SENIOR_ID]
const TEST_EC_IDS = [EC_SIGNED_ID, EC_SENIOR_ID]

// ---------------------------------------------------------------------------
// DB availability probe
// ---------------------------------------------------------------------------
let _pool: Pool | null = null
let ecSvc: EmployeeContractsService

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe.skipIf(!hasDatabaseUrl())('EmployeeContractsService.getMyStatus — real DB (AC2)', () => {
  beforeAll(async () => {
    // DB availability probe + resolve dynamic template IDs
    try {
      const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probePool.query('SELECT 1')
      // Resolve template IDs dynamically — they differ between crm_db and crm_scratch_m6
      const juniorRow = await probePool.query<{ id: string }>(
        `SELECT id FROM contract_templates WHERE target_role = 'JUNIOR' LIMIT 1`,
      )
      const seniorRow = await probePool.query<{ id: string }>(
        `SELECT id FROM contract_templates WHERE target_role = 'SENIOR' LIMIT 1`,
      )
      await probePool.end()
      if (!juniorRow.rows[0] || !seniorRow.rows[0]) {
        throw new Error('[contract-status-realdb] FAILED — no contract templates found in DB')
      }
      TEMPLATE_JUNIOR_ID = juniorRow.rows[0].id
      TEMPLATE_SENIOR_ID = seniorRow.rows[0].id
    } catch {
      throw new Error(
        '[contract-status-realdb] FAILED — no DB at DATABASE_URL (expected in CI unit job)',
      )
    }

    // Build minimal service directly (getMyStatus only needs DatabaseService)
    _pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(_pool, { schema })
    const dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
    Object.assign(dbSvc, { pool: _pool, db })

    // ContractTemplatesService is injected but NOT called by getMyStatus — pass a stub
    const stubTemplatesSvc = {} as ContractTemplatesService
    ecSvc = new EmployeeContractsService(dbSvc, stubTemplatesSvc)

    // Seed
    await db
      .insert(users)
      .values([
        {
          id: J_SIGNED_ID,
          email: J_SIGNED_EMAIL,
          displayName: 'CS2 Junior Signed',
          role: 'JUNIOR',
          googleId: `test-google-${J_SIGNED_ID}`,
        },
        {
          id: J_NOSIGNED_ID,
          email: J_NOSIGNED_EMAIL,
          displayName: 'CS2 Junior No Contract',
          role: 'JUNIOR',
          googleId: `test-google-${J_NOSIGNED_ID}`,
        },
        {
          id: SENIOR_ID,
          email: SENIOR_EMAIL,
          displayName: 'CS2 Senior',
          role: 'SENIOR',
          googleId: `test-google-${SENIOR_ID}`,
        },
      ])
      .onConflictDoNothing()

    // Insert contracts using real template IDs (source_template_id NOT NULL).
    // Trigger blocks ADMIN users but JUNIOR and SENIOR are allowed.
    await db
      .insert(employeeContracts)
      .values([
        {
          id: EC_SIGNED_ID,
          userId: J_SIGNED_ID,
          sourceTemplateId: TEMPLATE_JUNIOR_ID,
          bodyMarkdown: '<p>Test contract body</p>',
          createdByUserId: SEED_ADMIN_ID,
          status: 'SIGNED',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: EC_SENIOR_ID,
          userId: SENIOR_ID,
          sourceTemplateId: TEMPLATE_SENIOR_ID,
          bodyMarkdown: '<p>Senior contract body</p>',
          createdByUserId: SEED_ADMIN_ID,
          status: 'SIGNED',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ])
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!_pool)
      throw new Error(
        '[require-real-db] _pool not initialized — beforeAll should have thrown already',
      )
    try {
      const db = drizzle(_pool, { schema })
      // Delete in FK-safe order: contracts first, then users
      await db.delete(employeeContracts).where(eq(employeeContracts.id, EC_SIGNED_ID))
      await db.delete(employeeContracts).where(eq(employeeContracts.id, EC_SENIOR_ID))
      for (const id of TEST_USER_IDS) {
        await db.delete(users).where(eq(users.id, id))
      }
    } finally {
      await _pool.end()
    }
  }, 30_000)

  it('AC2a: JUNIOR with SIGNED contract → getMyStatus returns {id, status:"SIGNED"}', async () => {
    const result = await ecSvc.getMyStatus(J_SIGNED_ID)
    expect(result).not.toBeNull()
    expect(result!.status).toBe('SIGNED')
    expect(result!.id).toBe(EC_SIGNED_ID)
  })

  it('AC2b: user without any active contract → getMyStatus returns null', async () => {
    const result = await ecSvc.getMyStatus(J_NOSIGNED_ID)
    expect(result).toBeNull()
  })

  it('AC2c: self-only — getMyStatus(userA) never returns userB contract', async () => {
    // J_NOSIGNED has no contract → null (does NOT return J_SIGNED or SENIOR contract)
    const resultForNoSigned = await ecSvc.getMyStatus(J_NOSIGNED_ID)
    expect(resultForNoSigned).toBeNull()

    // J_SIGNED returns only their own contract, not SENIOR's
    const resultForSigned = await ecSvc.getMyStatus(J_SIGNED_ID)
    expect(resultForSigned).not.toBeNull()
    expect(resultForSigned!.id).toBe(EC_SIGNED_ID)
    expect(resultForSigned!.id).not.toBe(EC_SENIOR_ID)
  })

  it('AC2d: SENIOR with SIGNED contract → also returns correctly (any auth user self-only)', async () => {
    const result = await ecSvc.getMyStatus(SENIOR_ID)
    expect(result).not.toBeNull()
    expect(result!.status).toBe('SIGNED')
    expect(result!.id).toBe(EC_SENIOR_ID)
  })
})
