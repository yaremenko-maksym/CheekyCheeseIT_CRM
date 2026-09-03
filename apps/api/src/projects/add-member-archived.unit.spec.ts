/**
 * task-archived-user-completeness — AC1, unit-level.
 *
 * The behaviour is proven end-to-end in
 * `users/archived-entitlement.realdb.integration.spec.ts` (real services, real
 * Postgres, membership row read back). This file adds the unit-level twin for
 * the same reason as `finance/archived-money-out.unit.spec.ts`: integration
 * specs are excluded from discovery on any vitest run without the
 * `integration.spec` filter, which is every run the mutation gate and the
 * unit-only CI job make — so without this, deleting the guard is a change no
 * gate rejects.
 *
 * WHY THE GUARD IS HERE AT ALL. A `project_members` row with `left_at IS NULL`
 * is an accrual subscription: `createMonthlySalaries` walks exactly that set
 * and mints a fresh PENDING salary for the junior on it every month. Adding a
 * dismissed junior back is therefore not a bookkeeping detail, it is a standing
 * order to pay them.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { ProjectsService } from './projects.service'
import { projectMembers } from '../database/schema'
import { compileWhere } from '../finance/__test-helpers__/drizzle-where-introspection'

const ADMIN: SessionUser = {
  id: '22222222-0000-4000-aa00-000000000001',
  email: 'add-member-archived-admin@test.spec',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
const PROJECT_ID = '22222222-0000-4000-dd00-000000000001'
const USER_ID = '22222222-0000-4000-aa00-000000000002'

const juniorRow = {
  id: USER_ID,
  role: 'JUNIOR' as const,
  archivedAt: null as Date | null,
}

/**
 * Answers the project + user lookups `addMember` makes before the guard, and
 * throws on the INSERT. A permissive insert stub would let a removed guard look
 * like a pass; a loud one keeps the refusal assertion meaningful and doubles as
 * the control's expected outcome.
 */
function makeDb(userRow: unknown) {
  return {
    db: {
      query: {
        projects: {
          findFirst: vi.fn().mockResolvedValue({
            id: PROJECT_ID,
            seniorId: '22222222-0000-4000-aa00-000000000003',
            senior: null,
            drop: null,
            members: [],
          }),
        },
        users: { findFirst: vi.fn().mockResolvedValue(userRow) },
        projectMembers: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
      insert: vi.fn(() => {
        throw new Error('INSERT REACHED — guard did not fire')
      }),
    },
  } as never
}

function makeService(userRow: unknown): ProjectsService {
  return new ProjectsService(makeDb(userRow), {} as never, {} as never, {} as never)
}

describe('AC1 — addMember refuses an archived user', () => {
  it('refuses, and never reaches the INSERT that opens the accrual subscription', async () => {
    const svc = makeService({ ...juniorRow, archivedAt: new Date('2026-01-31T00:00:00.000Z') })

    await expect(svc.addMember(PROJECT_ID, USER_ID, ADMIN)).rejects.toThrow(/добавить в проект/)
  })

  it('CONTROL: the identical call for an ACTIVE user reaches the INSERT', async () => {
    // Same fixture with one flag cleared — so the refusal above is attributable
    // to `archivedAt` and not to any other precondition of this endpoint.
    const svc = makeService(juniorRow)

    await expect(svc.addMember(PROJECT_ID, USER_ID, ADMIN)).rejects.toThrow(/INSERT REACHED/)
  })
})

/**
 * task-archived-user-completeness — security-review MED-3, unit-level.
 *
 * The behaviour is proven end-to-end in
 * `users/archived-entitlement.realdb.integration.spec.ts` (real Postgres, three
 * teammate states, both filters knocked out one at a time). This is the unit
 * twin, for the same reason as the `addMember` one above: Stryker runs the UNIT
 * suite, so without it the mutation gate reported the two guard lines as
 * `NoCoverage` — i.e. "no test would notice if these were deleted", which is
 * the exact property this PR exists to stop asserting without proof.
 *
 * It pins the two things that survive only as long as someone keeps them:
 *   • the `archivedAt: true` COLUMN PROJECTION — drop it and `u.archivedAt` is
 *     `undefined` for every teammate, so the guard below silently never fires;
 *   • the `if (u.archivedAt) continue` guard itself.
 */
describe('MED-3 — createFromInterview does not seat dismissed teammates', () => {
  const SENIOR_ID = '22222222-0000-4000-aa00-000000000010'
  const TEAM_ID = '22222222-0000-4000-cc00-000000000001'
  const ACTIVE_HR = '22222222-0000-4000-aa00-000000000011'
  const ARCHIVED_HR = '22222222-0000-4000-aa00-000000000012'
  const NEW_PROJECT_ID = '22222222-0000-4000-dd00-000000000009'

  type Teammate = {
    teamId: string
    userId: string
    user: { id: string; role: string; archivedAt: Date | null } | null
  }

  function makeInterviewDb(teammates: Teammate[]) {
    const findManyArgs: Record<string, unknown>[] = []
    const seatedUserIds: string[] = []

    const findMany = vi.fn((args: Record<string, unknown>) => {
      findManyArgs.push(args)
      // 1st call: the senior's own team memberships. 2nd: their teammates.
      return Promise.resolve(
        findManyArgs.length === 1 ? [{ teamId: TEAM_ID, userId: SENIOR_ID }] : teammates,
      )
    })

    const insert = vi.fn((table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        if (table === projectMembers) seatedUserIds.push(String(vals['userId']))
        // `projects` is awaited via `.returning()`; `projectMembers` is awaited
        // directly — so hand back a thenable that also carries `.returning`.
        return Object.assign(Promise.resolve(undefined), {
          returning: () => Promise.resolve([{ id: NEW_PROJECT_ID }]),
        })
      },
    }))

    const db = { db: { query: { teamMembers: { findMany } }, insert } } as never
    return { db, findManyArgs, seatedUserIds }
  }

  const interview = {
    id: '22222222-0000-4000-ee00-000000000001',
    seniorId: SENIOR_ID,
    companyName: 'MED3 Co',
    notesDomain: 'ai',
    senior: null,
  } as unknown as Parameters<ProjectsService['createFromInterview']>[0]

  const teammate = (userId: string, archivedAt: Date | null): Teammate => ({
    teamId: TEAM_ID,
    userId,
    user: { id: userId, role: 'HR', archivedAt },
  })

  // security-review round 2 (SR-H-6): `createFromInterview` now opens an
  // approval proposal after the insert — a real `ApprovalsService`
  // constructor arg, not `undefined` (the 4-arg call this file used before
  // SR-H-6 shipped left it unset, and `this.approvals.proposeInTx(...)`
  // throws on `undefined`). This double only needs to not throw; the
  // proposal itself is proven separately (create-from-interview-draft-status
  // .unit.spec.ts).
  function makeService(db: never): ProjectsService {
    const approvals = { proposeInTx: vi.fn(async () => []) }
    return new ProjectsService(db, {} as never, {} as never, {} as never, approvals as never)
  }

  it('seats the active teammate and skips the archived one', async () => {
    const { db, seatedUserIds } = makeInterviewDb([
      teammate(ACTIVE_HR, null),
      teammate(ARCHIVED_HR, new Date('2026-01-31T00:00:00.000Z')),
    ])

    await makeService(db).createFromInterview(interview, ADMIN)

    expect(seatedUserIds).toEqual([ACTIVE_HR])
  })

  it('asks the DB for exactly the three columns the loop consumes', async () => {
    // Dropping `archivedAt` from the projection leaves the guard syntactically
    // intact and semantically dead: `u.archivedAt` would be `undefined` for
    // everyone. `id` and `role` are load-bearing for the same reason — the loop
    // filters on `role` and inserts `id`. So the WHOLE projection is pinned,
    // not just the column this task added: each of the three is a silent
    // failure of a different kind if it goes missing.
    const { db, findManyArgs } = makeInterviewDb([teammate(ACTIVE_HR, null)])

    await makeService(db).createFromInterview(interview, ADMIN)

    const teammateQuery = findManyArgs[1] as
      | { with?: { user?: { columns?: Record<string, boolean> } } }
      | undefined
    expect(teammateQuery?.with?.user?.columns).toEqual({
      id: true,
      role: true,
      archivedAt: true,
    })
  })

  it('asks the DB only for OPEN memberships (`left_at is null`)', async () => {
    // The other half of the fix, and the one an outcome assertion cannot see:
    // a closed membership is filtered in SQL, so it never reaches the loop.
    const { db, findManyArgs } = makeInterviewDb([teammate(ACTIVE_HR, null)])

    await makeService(db).createFromInterview(interview, ADMIN)

    const teammateQuery = findManyArgs[1] as { where?: unknown } | undefined
    expect(compileWhere(teammateQuery?.where).sql).toContain('"left_at" is null')
  })
})
