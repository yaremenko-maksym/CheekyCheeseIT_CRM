/**
 * security-review round 2 (SR-H-6, task-project-draft-status).
 * `ProjectsService.createFromInterview` is the SECOND door into
 * `insert(projects)` — `create()` (the ADMIN/HR form) is the first, and it
 * already carries the draft-status gate (`approval-aggregate.unit.spec.ts`
 * covers `approveDraft`/`rejectDraft`/`applyApprovalAggregate`). Round 1 of
 * this task built ONLY the first door: `createFromInterview` shipped with
 * neither half of the gate — no explicit `status: 'DRAFT'` (the column
 * DEFAULT is `'ACTIVE'`, meant to backfill EXISTING rows, not mint new ones
 * — see that column's own comment in schema.ts) and no `approvals`
 * proposal. A project hired straight out of an interview (BIZ-07,
 * `InterviewsService.move` on a transition to `HIRED`) was therefore born
 * fully confirmed with ZERO approval rows — unconfirmable by construction,
 * since `approveDraft`/`rejectDraft` 404 everyone when there is no live row
 * to respond to.
 *
 * This file pins BOTH halves of the fix at the unit level (the mutation
 * gate cannot see `*.integration.spec.ts` —
 * `.claude/rules/common/mutation-gate-integration-specs.md`):
 *   1. the `insert(projects)` values carry `status: 'DRAFT'`, not the
 *      column default;
 *   2. `ApprovalsService.proposeInTx` is called with the interview's senior
 *      as the SOLE invited approver — interview-sourced projects never
 *      carry a `dropId` (no such field exists on `Interview`; `create()`'s
 *      own `[seniorId, dropId]` branch has nothing to mirror here).
 *
 * Red-then-green, run by the coder (see the PR / final report for the
 * transcript): stripping either the `status: 'DRAFT'` value or the
 * `proposeInTx` call from `createFromInterview` fails exactly the test that
 * covers that half, nothing else.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { ProjectsService } from './projects.service'
import { projects } from '../database/schema'

const ADMIN: SessionUser = {
  id: '33333333-0000-4000-aa00-000000000001',
  email: 'sr-h6-admin@test.spec',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}

const SENIOR_ID = '33333333-0000-4000-aa00-000000000010'
const NEW_PROJECT_ID = '33333333-0000-4000-dd00-000000000001'

const interview = {
  id: '33333333-0000-4000-ee00-000000000001',
  seniorId: SENIOR_ID,
  companyName: 'SR-H-6 Co',
  notesDomain: 'ai',
  senior: null,
} as unknown as Parameters<ProjectsService['createFromInterview']>[0]

/**
 * `teamMembersFindMany` always returns `[]` — this fixture has no teams, so
 * the teammate-seeding loop below the insert never runs. That is
 * deliberate: it isolates the assertion to the insert + the proposal, the
 * two things SR-H-6 fixes, without the unrelated backlog #136 seeding logic
 * (already covered by `create-from-interview-active-teams.unit.spec.ts`)
 * in the way.
 */
function makeService() {
  const insertedProjectValues: Record<string, unknown>[] = []
  const teamMembersFindMany = vi.fn(async () => [])
  const insert = vi.fn((table: unknown) => ({
    values: (vals: Record<string, unknown>) => {
      if (table === projects) insertedProjectValues.push(vals)
      // `projects` is awaited via `.returning()`.
      return Object.assign(Promise.resolve(undefined), {
        returning: () => Promise.resolve([{ id: NEW_PROJECT_ID }]),
      })
    },
  }))
  const db = { db: { query: { teamMembers: { findMany: teamMembersFindMany } }, insert } }
  const proposeInTx = vi.fn(async () => [])
  const approvals = { proposeInTx }
  const service = new ProjectsService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    approvals as never,
  )
  return { service, insertedProjectValues, proposeInTx, teamMembersFindMany }
}

describe('ProjectsService.createFromInterview — draft status + approval proposal (SR-H-6)', () => {
  it('mints the project as DRAFT, not the column DEFAULT (ACTIVE)', async () => {
    const { service, insertedProjectValues } = makeService()

    await service.createFromInterview(interview, ADMIN)

    expect(insertedProjectValues).toHaveLength(1)
    expect(insertedProjectValues[0]?.['status']).toBe('DRAFT')
  })

  it('opens an approval proposal with the interview senior as the sole invited approver', async () => {
    const { service, proposeInTx } = makeService()

    await service.createFromInterview(interview, ADMIN)

    expect(proposeInTx).toHaveBeenCalledWith(expect.anything(), {
      subjectType: 'PROJECT',
      subjectId: NEW_PROJECT_ID,
      approverUserIds: [SENIOR_ID],
      proposedByUserId: ADMIN.id,
    })
  })

  it('CONTROL: both the insert and the proposal fire exactly once, even with no teams to seed', async () => {
    // Proves the assertions above are attributable to the fix, not to some
    // side effect of the (unrelated) teammate-seeding loop happening to run
    // twice or not at all.
    const { service, proposeInTx, insertedProjectValues, teamMembersFindMany } = makeService()

    const result = await service.createFromInterview(interview, ADMIN)

    expect(result?.id).toBe(NEW_PROJECT_ID)
    expect(insertedProjectValues).toHaveLength(1)
    expect(proposeInTx).toHaveBeenCalledTimes(1)
    // Called once (senior team memberships) — teamIds comes back empty, so
    // the second (teammates) call never happens.
    expect(teamMembersFindMany).toHaveBeenCalledTimes(1)
  })
})
