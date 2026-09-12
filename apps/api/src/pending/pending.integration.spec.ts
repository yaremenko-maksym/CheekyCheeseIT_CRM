import { randomUUID } from 'crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { ApprovalsService } from '../approvals/approvals.service'
import { DatabaseService } from '../database/database.service'
import {
  approvals,
  contractTemplates,
  employeeContracts,
  projects,
  users,
} from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'
import { PendingService } from './pending.service'
import { makeNotificationsStub } from '../notifications/__test-helpers__/notifications-stub'

/**
 * task-pending-screen (position 7c). `PendingService.getPending` against a
 * real Postgres — AC1 (aggregate by role), AC2 (the six filters), AC3
 * (disclosure) from the task file's "Критерии приёмки".
 *
 * Called DIRECTLY (`new PendingService(...)`), never through
 * `PendingController`/HTTP — task file AC1: "моки стражи не исполняют". The
 * viewer is a plain `{id, role}` object; RBAC guard behavior is NestJS's own
 * concern (`RolesGuard`/`JwtAuthGuard`), not this service's — see
 * `pending.service.ts`'s own header on why `PendingController` has no
 * `@Roles`.
 *
 * Run against a dedicated scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa_pos7c_api \
 *     pnpm --filter @crm/api exec vitest run pending.integration.spec
 */

const SENIOR_ID = 'b9000000-0000-4000-a000-000000000001'
const DROP_ID = 'b9000000-0000-4000-a000-000000000002'
const ADMIN_ID = 'b9000000-0000-4000-a000-000000000003'
const JUNIOR_ID = 'b9000000-0000-4000-a000-000000000004'
const HR_ID = 'b9000000-0000-4000-a000-000000000005'
const ACCOUNTANT_ID = 'b9000000-0000-4000-a000-000000000006'
const TEST_USER_IDS = [SENIOR_ID, DROP_ID, ADMIN_ID, JUNIOR_ID, HR_ID, ACCOUNTANT_ID]

const PROJECT_SUBJECT_TYPE = 'PROJECT'
const PROJECT_SHARE_SUBJECT_TYPE = 'PROJECT_SENIOR_SHARE'
const USER_SHARE_SUBJECT_TYPE = 'USER_SENIOR_SHARE'

let pool: Pool
let dbSvc: DatabaseService
let approvalsSvc: ApprovalsService
let pendingSvc: PendingService
let templateId: string
/** Ids handed out by `freshUser` — cleaned up in `afterAll` alongside the
 * fixed `TEST_USER_IDS` roster. */
const createdUserIds: string[] = []

function viewer(id: string, role: SessionUser['role']): SessionUser {
  return { id, role } as SessionUser
}

/** A one-off user, for the ONE test (AC2's CANCELLED-contract case) that
 * needs a user with NO prior `employee_contracts` row: BIZ-11's "one
 * non-CANCELLED contract per user" constraint means reusing a
 * `TEST_USER_IDS` id that the AC1 `it.each` block already gave a
 * READY_TO_SIGN contract would leave that leftover row still visible,
 * proving nothing about the CANCELLED one this test actually creates. */
async function freshUser(role: SessionUser['role']) {
  const id = randomUUID()
  await dbSvc.db.insert(users).values({
    id,
    email: `pending-screen-${id.slice(0, 8)}@test.spec`,
    displayName: `Pending screen test user ${id.slice(0, 8)}`,
    role,
  })
  createdUserIds.push(id)
  return id
}

/** Recursively collects every NUMBER value anywhere in a JSON-shaped object
 * graph. AC3's "глубокий поиск по JSON" done properly — walking the actual
 * structure and comparing NUMBERS, not `JSON.stringify(...).includes(...)`
 * on the flattened text: a raw substring search false-positives on any
 * UUID or ISO timestamp that happens to contain the same two digits (both
 * appear in this file's own fixture ids), which is not what "leaked" means. */
function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number') out.push(value)
  else if (Array.isArray(value)) for (const item of value) collectNumbers(item, out)
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectNumbers(item, out)
  }
  return out
}

/** A minimal active project — mirrors the fixture shape
 * `projects.hr-contact.integration.spec.ts` already settled on. */
async function freshProject(overrides: {
  seniorId: string
  dropId?: string
  archivedAt?: Date
  dropSharePercentOverride?: number
}) {
  const id = randomUUID()
  await dbSvc.db.insert(projects).values({
    id,
    name: `Pending screen test project ${id.slice(0, 8)}`,
    companyName: 'Pending Screen Test Co',
    domain: 'AI',
    startDate: new Date(),
    rate: '1000',
    seniorId: overrides.seniorId,
    dropId: overrides.dropId ?? null,
    archivedAt: overrides.archivedAt ?? null,
    dropSharePercentOverride: overrides.dropSharePercentOverride ?? null,
  })
  return id
}

async function freshContract(
  userId: string,
  status: 'READY_TO_SIGN' | 'CANCELLED' = 'READY_TO_SIGN',
) {
  const id = randomUUID()
  await dbSvc.db.insert(employeeContracts).values({
    id,
    userId,
    sourceTemplateId: templateId,
    bodyMarkdown: 'Pending screen test contract body',
    status,
    createdByUserId: ADMIN_ID,
  })
  return id
}

describe.skipIf(!hasDatabaseUrl())('PendingService.getPending — against real Postgres', () => {
  beforeAll(async () => {
    const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const which = await probe.query('SELECT current_database() AS db')
    if (which.rows[0]?.db === 'crm_db') {
      await probe.end()
      throw new Error('[pending] REFUSING to run against the live crm_db')
    }
    await probe.end()

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(pool, { schema })
    dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, {
      pool,
      db,
    })
    approvalsSvc = new ApprovalsService(dbSvc, makeNotificationsStub())
    pendingSvc = new PendingService(dbSvc, approvalsSvc)

    await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    await dbSvc.db.insert(users).values([
      { id: SENIOR_ID, email: 'pending-senior@test.spec', displayName: 'Senior', role: 'SENIOR' },
      { id: DROP_ID, email: 'pending-drop@test.spec', displayName: 'Drop', role: 'DROP' },
      { id: ADMIN_ID, email: 'pending-admin@test.spec', displayName: 'Admin', role: 'ADMIN' },
      { id: JUNIOR_ID, email: 'pending-junior@test.spec', displayName: 'Junior', role: 'JUNIOR' },
      { id: HR_ID, email: 'pending-hr@test.spec', displayName: 'Hr', role: 'HR' },
      {
        id: ACCOUNTANT_ID,
        email: 'pending-accountant@test.spec',
        displayName: 'Accountant',
        role: 'ACCOUNTANT',
      },
    ])

    const [tpl] = await dbSvc.db
      .select({ id: contractTemplates.id })
      .from(contractTemplates)
      .limit(1)
    if (!tpl) {
      throw new Error(
        '[pending] no contractTemplates row found — run `pnpm --filter @crm/api db:seed` against this DATABASE_URL first',
      )
    }
    templateId = tpl.id
  }, 30_000)

  afterAll(async () => {
    if (dbSvc) {
      const allUserIds = [...TEST_USER_IDS, ...createdUserIds]
      await dbSvc.db.delete(employeeContracts).where(inArray(employeeContracts.userId, allUserIds))
      await dbSvc.db.delete(approvals).where(inArray(approvals.approverUserId, allUserIds))
      await dbSvc.db.delete(projects).where(eq(projects.seniorId, SENIOR_ID))
      await dbSvc.db.delete(users).where(inArray(users.id, allUserIds))
    }
    await pool?.end()
  })

  // -------------------------------------------------------------------
  // AC1 — aggregate by role
  // -------------------------------------------------------------------
  describe('AC1 — aggregate by role', () => {
    it('SENIOR sees own project draft + own share, never the drop percent', async () => {
      const projectId = await freshProject({
        seniorId: SENIOR_ID,
        dropId: DROP_ID,
        dropSharePercentOverride: 77,
      })
      await approvalsSvc.propose({
        subjectType: PROJECT_SUBJECT_TYPE,
        subjectId: projectId,
        approverUserIds: [SENIOR_ID, DROP_ID],
        proposedByUserId: ADMIN_ID,
      })
      const shareProjectId = await freshProject({ seniorId: SENIOR_ID })
      await dbSvc.db
        .update(projects)
        .set({ seniorSharePercentOverride: 20, pendingSeniorSharePercentOverride: 32 })
        .where(eq(projects.id, shareProjectId))
      await approvalsSvc.propose({
        subjectType: PROJECT_SHARE_SUBJECT_TYPE,
        subjectId: shareProjectId,
        approverUserIds: [SENIOR_ID],
        proposedByUserId: ADMIN_ID,
      })

      const result = await pendingSvc.getPending(viewer(SENIOR_ID, 'SENIOR'))

      const projectItem = result.mine.find((i) => i.subjectId === projectId)
      expect(projectItem).toMatchObject({ kind: 'PROJECT_APPROVAL', title: expect.any(String) })
      expect(projectItem).not.toHaveProperty('currentPercent')
      expect(projectItem).not.toHaveProperty('pendingPercent')

      const shareItem = result.mine.find((i) => i.subjectId === shareProjectId)
      expect(shareItem).toMatchObject({
        kind: 'SHARE_APPROVAL',
        currentPercent: 20,
        pendingPercent: 32,
      })

      // AC3's deep-search half of the same fact: the DROP's 77% never
      // appears anywhere in the SENIOR's own response, as a NUMBER (not a
      // text-substring — see `collectNumbers`'s own doc).
      expect(collectNumbers(result)).not.toContain(77)
      expect(result.proposedByMe).toEqual([])
    })

    it('DROP mirrors SENIOR on the shared project draft, but never sees the SENIOR share proposal', async () => {
      const projectId = await freshProject({ seniorId: SENIOR_ID, dropId: DROP_ID })
      await approvalsSvc.propose({
        subjectType: PROJECT_SUBJECT_TYPE,
        subjectId: projectId,
        approverUserIds: [SENIOR_ID, DROP_ID],
        proposedByUserId: ADMIN_ID,
      })

      const result = await pendingSvc.getPending(viewer(DROP_ID, 'DROP'))

      expect(
        result.mine.some((i) => i.subjectId === projectId && i.kind === 'PROJECT_APPROVAL'),
      ).toBe(true)
      // No SHARE_APPROVAL kind can ever reach DROP's `mine` — there is no
      // drop-share approval flow in the codebase today (see this service's
      // header comment) — structurally proven, not just absent by luck.
      expect(result.mine.every((i) => i.kind !== 'SHARE_APPROVAL')).toBe(true)
      expect(result.proposedByMe).toEqual([])
    })

    it.each([
      ['JUNIOR', JUNIOR_ID] as const,
      ['HR', HR_ID] as const,
      ['ACCOUNTANT', ACCOUNTANT_ID] as const,
    ])('%s sees ONLY their READY_TO_SIGN contract, nothing else', async (role, userId) => {
      await freshContract(userId)

      const result = await pendingSvc.getPending(viewer(userId, role))

      expect(result.mine).toHaveLength(1)
      expect(result.mine[0]).toMatchObject({ kind: 'CONTRACT_TO_SIGN' })
      expect(result.proposedByMe).toEqual([])
    })

    it('ADMIN sees proposedByMe with the names of who has not answered yet', async () => {
      const projectId = await freshProject({ seniorId: SENIOR_ID, dropId: DROP_ID })
      await approvalsSvc.propose({
        subjectType: PROJECT_SUBJECT_TYPE,
        subjectId: projectId,
        approverUserIds: [SENIOR_ID, DROP_ID],
        proposedByUserId: ADMIN_ID,
      })
      // Partial agreement — SENIOR answers, DROP does not (§4.1).
      await approvalsSvc.approve({
        subjectType: PROJECT_SUBJECT_TYPE,
        subjectId: projectId,
        approverUserId: SENIOR_ID,
      })

      const result = await pendingSvc.getPending(viewer(ADMIN_ID, 'ADMIN'))

      const item = result.proposedByMe.find((i) => i.subjectId === projectId)
      expect(item).toBeDefined()
      expect(item?.waitingFor).toEqual(['Drop'])
    })

    it('non-ADMIN never calls listPendingProposedBy — proposedByMe is always [], not a 403', async () => {
      const result = await pendingSvc.getPending(viewer(SENIOR_ID, 'SENIOR'))
      expect(result.proposedByMe).toEqual([])
    })

    it('ADMIN sees a proposed base-share (USER_SENIOR_SHARE) change with cancel offered, resolved percent included', async () => {
      const seniorId = await freshUser('SENIOR')
      await dbSvc.db
        .update(users)
        .set({ pendingSeniorSharePercent: 45 })
        .where(eq(users.id, seniorId))
      await approvalsSvc.propose({
        subjectType: USER_SHARE_SUBJECT_TYPE,
        subjectId: seniorId,
        approverUserIds: [seniorId],
        proposedByUserId: ADMIN_ID,
      })

      const result = await pendingSvc.getPending(viewer(ADMIN_ID, 'ADMIN'))

      const item = result.proposedByMe.find((i) => i.subjectId === seniorId)
      expect(item).toMatchObject({
        kind: 'SHARE_APPROVAL',
        pendingPercent: 45,
        actions: ['cancel', 'open'],
      })
    })
  })

  // -------------------------------------------------------------------
  // AC2 — the six filters
  // -------------------------------------------------------------------
  describe('AC2 — filters', () => {
    it('a superseded (re-proposed) generation is invisible — only the live generation shows', async () => {
      const projectId = await freshProject({ seniorId: SENIOR_ID })
      await approvalsSvc.propose({
        subjectType: PROJECT_SUBJECT_TYPE,
        subjectId: projectId,
        approverUserIds: [SENIOR_ID],
        proposedByUserId: ADMIN_ID,
      })
      // Re-propose — supersedes the first generation (ApprovalsService header).
      await approvalsSvc.propose({
        subjectType: PROJECT_SUBJECT_TYPE,
        subjectId: projectId,
        approverUserIds: [SENIOR_ID],
        proposedByUserId: ADMIN_ID,
      })

      const result = await pendingSvc.getPending(viewer(SENIOR_ID, 'SENIOR'))

      expect(result.mine.filter((i) => i.subjectId === projectId)).toHaveLength(1)
    })

    it('an APPROVED row does not show', async () => {
      const projectId = await freshProject({ seniorId: SENIOR_ID })
      await approvalsSvc.propose({
        subjectType: PROJECT_SUBJECT_TYPE,
        subjectId: projectId,
        approverUserIds: [SENIOR_ID],
        proposedByUserId: ADMIN_ID,
      })
      await approvalsSvc.approve({
        subjectType: PROJECT_SUBJECT_TYPE,
        subjectId: projectId,
        approverUserId: SENIOR_ID,
      })

      const result = await pendingSvc.getPending(viewer(SENIOR_ID, 'SENIOR'))

      expect(result.mine.some((i) => i.subjectId === projectId)).toBe(false)
    })

    it('a REJECTED row does not show', async () => {
      const projectId = await freshProject({ seniorId: SENIOR_ID })
      await approvalsSvc.propose({
        subjectType: PROJECT_SUBJECT_TYPE,
        subjectId: projectId,
        approverUserIds: [SENIOR_ID],
        proposedByUserId: ADMIN_ID,
      })
      await approvalsSvc.reject({
        subjectType: PROJECT_SUBJECT_TYPE,
        subjectId: projectId,
        approverUserId: SENIOR_ID,
        reason: 'Не подходит',
      })

      const result = await pendingSvc.getPending(viewer(SENIOR_ID, 'SENIOR'))

      expect(result.mine.some((i) => i.subjectId === projectId)).toBe(false)
    })

    it('a CANCELLED row does not show', async () => {
      const projectId = await freshProject({ seniorId: SENIOR_ID })
      await approvalsSvc.propose({
        subjectType: PROJECT_SHARE_SUBJECT_TYPE,
        subjectId: projectId,
        approverUserIds: [SENIOR_ID],
        proposedByUserId: ADMIN_ID,
      })
      await approvalsSvc.cancel(PROJECT_SHARE_SUBJECT_TYPE, projectId)

      const result = await pendingSvc.getPending(viewer(SENIOR_ID, 'SENIOR'))

      expect(result.mine.some((i) => i.subjectId === projectId)).toBe(false)
    })

    it('a pending row on an ARCHIVED project does not show', async () => {
      const projectId = await freshProject({ seniorId: SENIOR_ID })
      await approvalsSvc.propose({
        subjectType: PROJECT_SUBJECT_TYPE,
        subjectId: projectId,
        approverUserIds: [SENIOR_ID],
        proposedByUserId: ADMIN_ID,
      })
      await dbSvc.db
        .update(projects)
        .set({ archivedAt: new Date() })
        .where(eq(projects.id, projectId))

      const result = await pendingSvc.getPending(viewer(SENIOR_ID, 'SENIOR'))

      expect(result.mine.some((i) => i.subjectId === projectId)).toBe(false)
    })

    it('a CANCELLED employee contract does not show', async () => {
      const userId = await freshUser('JUNIOR')
      await freshContract(userId, 'CANCELLED')

      const result = await pendingSvc.getPending(viewer(userId, 'JUNIOR'))

      expect(result.mine.some((i) => i.kind === 'CONTRACT_TO_SIGN')).toBe(false)
    })
  })

  // -------------------------------------------------------------------
  // AC3 — disclosure
  // -------------------------------------------------------------------
  describe('AC3 — disclosure', () => {
    /**
     * Was "a PROJECT_APPROVAL item never carries a percent field, for ANY
     * viewer". Integration decision 2 (2026-09-11) narrowed that: a project
     * row now carries `viewerSharePercent` — the viewer's OWN resolved
     * share, and only theirs. The invariant this test protects is therefore
     * the one that actually matters and always did: the COUNTERPARTY'S
     * figure never appears. The drop's 88% is still absent from the SENIOR's
     * response; for the DROP it is now present ON PURPOSE, because it is
     * their own number (it is what they are being asked to agree to).
     */
    it("a PROJECT_APPROVAL item carries only the viewer's OWN share — never the counterparty's", async () => {
      const projectId = await freshProject({
        seniorId: SENIOR_ID,
        dropId: DROP_ID,
        dropSharePercentOverride: 88,
      })
      await dbSvc.db
        .update(projects)
        .set({ seniorSharePercentOverride: 44 })
        .where(eq(projects.id, projectId))
      await approvalsSvc.propose({
        subjectType: PROJECT_SUBJECT_TYPE,
        subjectId: projectId,
        approverUserIds: [SENIOR_ID, DROP_ID],
        proposedByUserId: ADMIN_ID,
      })

      const seniorResult = await pendingSvc.getPending(viewer(SENIOR_ID, 'SENIOR'))
      const dropResult = await pendingSvc.getPending(viewer(DROP_ID, 'DROP'))

      const seniorItem = seniorResult.mine.find((i) => i.subjectId === projectId)
      expect(seniorItem).toMatchObject({ viewerSharePercent: 44, seniorName: null })
      // The drop's 88 is nowhere in the SENIOR's whole response...
      expect(collectNumbers(seniorResult)).not.toContain(88)

      const dropItem = dropResult.mine.find((i) => i.subjectId === projectId)
      // ...and symmetrically, the DROP gets their own 88 and the senior's
      // NAME (not their figure), never the senior's 44.
      expect(dropItem).toMatchObject({ viewerSharePercent: 88, seniorName: 'Senior' })
      expect(collectNumbers(dropResult)).not.toContain(44)
    })

    it('an ADMIN watching the same project from proposedByMe gets neither figure', async () => {
      const projectId = await freshProject({
        seniorId: SENIOR_ID,
        dropId: DROP_ID,
        dropSharePercentOverride: 66,
      })
      await dbSvc.db
        .update(projects)
        .set({ seniorSharePercentOverride: 55 })
        .where(eq(projects.id, projectId))
      await approvalsSvc.propose({
        subjectType: PROJECT_SUBJECT_TYPE,
        subjectId: projectId,
        approverUserIds: [SENIOR_ID, DROP_ID],
        proposedByUserId: ADMIN_ID,
      })

      const adminResult = await pendingSvc.getPending(viewer(ADMIN_ID, 'ADMIN'))

      const item = adminResult.proposedByMe.find((i) => i.subjectId === projectId)
      expect(item).toMatchObject({ viewerSharePercent: null, seniorName: null })
      expect(collectNumbers(adminResult)).not.toContain(66)
      expect(collectNumbers(adminResult)).not.toContain(55)
    })

    it('every item the aggregate emits carries a subjectType from the closed USER | PROJECT set', async () => {
      const projectId = await freshProject({ seniorId: SENIOR_ID, dropId: DROP_ID })
      await approvalsSvc.propose({
        subjectType: PROJECT_SUBJECT_TYPE,
        subjectId: projectId,
        approverUserIds: [SENIOR_ID],
        proposedByUserId: ADMIN_ID,
      })
      await approvalsSvc.propose({
        subjectType: USER_SHARE_SUBJECT_TYPE,
        subjectId: SENIOR_ID,
        approverUserIds: [SENIOR_ID],
        proposedByUserId: ADMIN_ID,
      })

      const result = await pendingSvc.getPending(viewer(SENIOR_ID, 'SENIOR'))

      expect(result.mine.length).toBeGreaterThan(1)
      for (const item of result.mine) {
        expect(['USER', 'PROJECT']).toContain(item.subjectType)
      }
      expect(result.mine.find((i) => i.subjectId === projectId)?.subjectType).toBe('PROJECT')
      expect(
        result.mine.find((i) => i.kind === 'SHARE_APPROVAL' && i.subjectId === SENIOR_ID)
          ?.subjectType,
      ).toBe('USER')
    })
  })
})
