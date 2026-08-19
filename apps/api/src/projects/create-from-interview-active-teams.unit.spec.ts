/**
 * Backlog #136 — `createFromInterview` must inherit HR/ACCOUNTANT only from the
 * senior's CURRENTLY active team(s), not every team they have ever belonged to.
 *
 * `apps/api/src/projects/projects.service.ts:1326` (`createFromInterview`) ran
 * two queries to seed a fresh project's members from the hiring senior's team:
 *
 *   1. `seniorTeamMemberships` — every `team_members` row for `interview.seniorId`,
 *      unfiltered by `left_at`. A senior who left team A six months ago and is now
 *      only in team B still had team A's id come back in `teamIds`.
 *   2. `teammates` — every HR/ACCOUNTANT in those `teamIds`.
 *
 * Query 2 already carries `isNull(teamMembers.leftAt)` (added by
 * task-archived-user-completeness, MED-3 — see `add-member-archived.unit.spec.ts`),
 * so an HR who left team B themselves was already excluded. Query 1 did not, so a
 * team the SENIOR had left kept contributing its HR/ACCOUNTANT to every new
 * project the senior's next interview produced — a stale team membership
 * outliving the membership itself.
 *
 * This file is the mock-DB unit twin (same reason as the sibling specs in this
 * directory: the mutation gate and the unit-only CI job run vitest WITHOUT the
 * `integration.spec` filter, so a real-DB-only proof is invisible to both).
 *
 * A plain mocked `findMany` that ignores its own `where` argument and just
 * returns canned rows cannot go red for a WHERE-clause regression — it would
 * return the same rows whether or not the code asks for `left_at is null`. So
 * the fixture below does the opposite: it compiles the REAL Drizzle `where` AST
 * each call receives (via `compileWhere`, `drizzle-where-introspection.ts`) and
 * only returns the closed-membership rows when that compiled SQL actually
 * carries `"left_at" is null`. That ties the mock's answer to the production
 * code's own predicate, not to a hand-authored expectation — delete the
 * `isNull(...)` this task added and the outcome test below fails for real.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { ProjectsService } from './projects.service'
import { projectMembers } from '../database/schema'
import { compileWhere } from '../finance/__test-helpers__/drizzle-where-introspection'

const ADMIN: SessionUser = {
  id: '22222222-0000-4000-aa00-000000000001',
  email: 'create-from-interview-active-teams-admin@test.spec',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}

const SENIOR_ID = '22222222-0000-4000-aa00-000000000020'
const TEAM_A = '22222222-0000-4000-cc00-000000000101' // senior LEFT this one
const TEAM_B = '22222222-0000-4000-cc00-000000000102' // senior is CURRENTLY in this one
const HR_1 = '22222222-0000-4000-aa00-000000000021' // active in team A (senior already gone)
const HR_2 = '22222222-0000-4000-aa00-000000000022' // active in team B — the ONE expected hire
const HR_2_GONE = '22222222-0000-4000-aa00-000000000023' // was in team B, left it themselves
const NEW_PROJECT_ID = '22222222-0000-4000-dd00-000000000090'

type SeniorMembership = { teamId: string; userId: string; leftAt: Date | null }
type Teammate = {
  teamId: string
  userId: string
  leftAt: Date | null
  user: { id: string; role: string; archivedAt: Date | null } | null
}

const LEFT = new Date('2026-01-31T00:00:00.000Z')

/**
 * Builds a mocked `DatabaseService` whose `teamMembers.findMany` actually
 * consults the compiled SQL of the `where` it was called with, so the two
 * `left_at` filters this task adds/keeps are provable by OUTCOME, not just by
 * inspecting the captured `where` object.
 */
function makeInterviewDb(fixture: {
  seniorMemberships: SeniorMembership[]
  teammates: Teammate[]
}) {
  const findManyArgs: Record<string, unknown>[] = []
  const seatedUserIds: string[] = []
  let lastSeniorTeamIds: string[] = []

  const findMany = vi.fn((args: Record<string, unknown>) => {
    findManyArgs.push(args)
    const onlyOpenMemberships = compileWhere(args['where']).sql.includes('"left_at" is null')

    if (findManyArgs.length === 1) {
      // Call 1: `seniorTeamMemberships` — every team_members row for this senior.
      const rows = fixture.seniorMemberships.filter((m) =>
        onlyOpenMemberships ? m.leftAt === null : true,
      )
      lastSeniorTeamIds = rows.map((r) => r.teamId)
      return Promise.resolve(rows)
    }

    // Call 2: `teammates` — every team_members row for the teamIds call 1 produced.
    const rows = fixture.teammates
      .filter((t) => lastSeniorTeamIds.includes(t.teamId))
      .filter((t) => (onlyOpenMemberships ? t.leftAt === null : true))
    return Promise.resolve(rows)
  })

  const insert = vi.fn((table: unknown) => ({
    values: (vals: Record<string, unknown>) => {
      if (table === projectMembers) seatedUserIds.push(String(vals['userId']))
      return Object.assign(Promise.resolve(undefined), {
        returning: () => Promise.resolve([{ id: NEW_PROJECT_ID }]),
      })
    },
  }))

  const db = { db: { query: { teamMembers: { findMany } }, insert } } as never
  return { db, findManyArgs, seatedUserIds }
}

function makeService(db: never): ProjectsService {
  return new ProjectsService(db, {} as never, {} as never, {} as never)
}

const interview = {
  id: '22222222-0000-4000-ee00-000000000002',
  seniorId: SENIOR_ID,
  companyName: 'Backlog 136 Co',
  notesDomain: 'ai',
  senior: null,
} as unknown as Parameters<ProjectsService['createFromInterview']>[0]

describe('backlog #136 — createFromInterview inherits HR only from ACTIVE teams', () => {
  // The exact scenario from the task file: senior left team A (HR-1 there),
  // is now only active in team B (HR-2 active there, HR-2-GONE left team B
  // themselves). Only HR-2 may end up on the new project.
  const fixture = {
    seniorMemberships: [
      { teamId: TEAM_A, userId: SENIOR_ID, leftAt: LEFT },
      { teamId: TEAM_B, userId: SENIOR_ID, leftAt: null },
    ],
    teammates: [
      {
        teamId: TEAM_A,
        userId: HR_1,
        leftAt: null,
        user: { id: HR_1, role: 'HR', archivedAt: null },
      },
      {
        teamId: TEAM_B,
        userId: HR_2,
        leftAt: null,
        user: { id: HR_2, role: 'HR', archivedAt: null },
      },
      {
        teamId: TEAM_B,
        userId: HR_2_GONE,
        leftAt: LEFT,
        user: { id: HR_2_GONE, role: 'HR', archivedAt: null },
      },
    ],
  }

  it('AC3 — seats ONLY the HR of the team the senior is currently in', async () => {
    const { db, seatedUserIds } = makeInterviewDb(fixture)

    await makeService(db).createFromInterview(interview, ADMIN)

    // Neither HR-1 (senior already left that team) nor HR-2-GONE (left team B
    // themselves) may appear — exactly HR-2, exactly once.
    expect(seatedUserIds).toEqual([HR_2])
  })

  it('AC1 — the senior-membership query asks for OPEN memberships only (`left_at is null`)', async () => {
    const { db, findManyArgs } = makeInterviewDb(fixture)

    await makeService(db).createFromInterview(interview, ADMIN)

    const seniorQuery = findManyArgs[0] as { where?: unknown } | undefined
    expect(compileWhere(seniorQuery?.where).sql).toContain('"left_at" is null')
  })

  it('AC4 — regression: one active team, one active HR still seats that HR', async () => {
    const singleTeamFixture = {
      seniorMemberships: [{ teamId: TEAM_B, userId: SENIOR_ID, leftAt: null }],
      teammates: [
        {
          teamId: TEAM_B,
          userId: HR_2,
          leftAt: null,
          user: { id: HR_2, role: 'HR', archivedAt: null },
        },
      ],
    }
    const { db, seatedUserIds } = makeInterviewDb(singleTeamFixture)

    await makeService(db).createFromInterview(interview, ADMIN)

    expect(seatedUserIds).toEqual([HR_2])
  })
})
