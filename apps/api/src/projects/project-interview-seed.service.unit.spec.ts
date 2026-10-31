/**
 * Direct coverage for ProjectInterviewSeedService (extracted verbatim from
 * ProjectsService.createFromInterview). Pins the seam: the facade delegates
 * to the injected collaborator and forwards (interview, user, tx) untouched;
 * the collaborator, used on its own, maps interview notes onto the DRAFT
 * project, proposes to the senior only, and seats only eligible teammates.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { ProjectInterviewSeedService } from './project-interview-seed.service'
import { ProjectsService } from './projects.service'
import { projectMembers, projects } from '../database/schema'
import { compileWhere } from '../finance/__test-helpers__/drizzle-where-introspection'
import { makeNotificationsStub } from '../notifications/__test-helpers__/notifications-stub'
import { makeProposeInTxStub } from '../approvals/__test-helpers__/approvals-stub'
// r5 4.6 S5: the roster dirty producers are proven in job-sourcing; here they are inert.
vi.mock('../job-sourcing/dirty-producers')

const ACTOR = { id: 'actor-1', role: 'ADMIN' } as unknown as SessionUser
const SENIOR_ID = 'senior-1'

type Interview = Parameters<ProjectInterviewSeedService['createFromInterview']>[0]
const interview = {
  seniorId: SENIOR_ID,
  companyName: 'Seed Co',
  notesDomain: null,
  senior: null,
} as unknown as Interview

type Teammate = {
  user: { id: string; role: string; archivedAt: Date | null } | null
}

function makeSeed(
  opts: { returned?: unknown[]; memberships?: unknown[]; teammates?: Teammate[] } = {},
) {
  const inserted: Record<string, unknown>[] = []
  const seated: Record<string, unknown>[] = []
  const findManyArgs: Record<string, unknown>[] = []
  const findMany = vi.fn(async (args: Record<string, unknown>) => {
    findManyArgs.push(args)
    return findManyArgs.length === 1 ? (opts.memberships ?? []) : (opts.teammates ?? [])
  })
  const db = {
    db: {
      query: { teamMembers: { findMany } },
      insert: vi.fn((table: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          if (table === projects) inserted.push(vals)
          if (table === projectMembers) seated.push(vals)
          return Object.assign(Promise.resolve(undefined), {
            returning: () =>
              Promise.resolve(opts.returned ?? [{ id: 'p-1', companyName: 'Seed Co' }]),
          })
        },
      })),
    },
  }
  const proposeInTx = makeProposeInTxStub()
  const seed = new ProjectInterviewSeedService(
    db as never,
    { proposeInTx } as never,
    makeNotificationsStub(),
  )
  return { seed, inserted, seated, proposeInTx, findManyArgs }
}

describe('ProjectInterviewSeedService', () => {
  it('defaults the domain to "Other", mints DRAFT, proposes to the senior only', async () => {
    const { seed, inserted, proposeInTx } = makeSeed()

    const result = await seed.createFromInterview(interview, ACTOR)

    expect(result?.id).toBe('p-1')
    expect(inserted[0]).toMatchObject({
      domain: 'Other',
      status: 'DRAFT',
      rate: 0,
      currency: 'USDT',
      techStack: null,
      teamSize: null,
      benefits: null,
      salaryReview: null,
      corpTech: null,
      notesGeneral: null,
    })
    expect(proposeInTx).toHaveBeenCalledWith(expect.anything(), {
      subjectType: 'PROJECT',
      subjectId: 'p-1',
      approverUserIds: [SENIOR_ID],
      proposedByUserId: 'actor-1',
    })
  })

  it('copies every interview note onto the project', async () => {
    const { seed, inserted } = makeSeed()
    const full = {
      ...interview,
      notesDomain: 'ai',
      notesTechStack: 'ts',
      notesTeamSize: '5',
      notesBenefits: 'b',
      notesSalaryReview: 'sr',
      notesCorpTech: 'ct',
      notesGeneral: 'g',
    } as unknown as Interview

    await seed.createFromInterview(full, ACTOR)

    expect(inserted[0]).toMatchObject({
      name: 'Seed Co',
      companyName: 'Seed Co',
      domain: 'ai',
      techStack: 'ts',
      teamSize: '5',
      benefits: 'b',
      salaryReview: 'sr',
      corpTech: 'ct',
      notesGeneral: 'g',
    })
  })

  it('returns early without proposing when the insert yields no row', async () => {
    const { seed, proposeInTx, findManyArgs } = makeSeed({ returned: [] })

    const result = await seed.createFromInterview(interview, ACTOR)

    expect(result).toBeUndefined()
    expect(proposeInTx).not.toHaveBeenCalled()
    expect(findManyArgs).toHaveLength(0)
  })

  it('seats only active HR/ACCOUNTANT teammates, once each, of the senior team ids', async () => {
    const { seed, seated, findManyArgs } = makeSeed({
      memberships: [{ teamId: 'team-1' }, { teamId: 'team-2' }],
      teammates: [
        { user: null },
        { user: { id: 'u-archived', role: 'HR', archivedAt: new Date() } },
        { user: { id: 'u-junior', role: 'JUNIOR', archivedAt: null } },
        { user: { id: 'u-hr', role: 'HR', archivedAt: null } },
        { user: { id: 'u-hr', role: 'HR', archivedAt: null } },
        { user: { id: 'u-acc', role: 'ACCOUNTANT', archivedAt: null } },
      ],
    })

    await seed.createFromInterview(interview, ACTOR)

    expect(seated).toEqual([
      { projectId: 'p-1', userId: 'u-hr' },
      { projectId: 'p-1', userId: 'u-acc' },
    ])
    const teammatesWhere = compileWhere((findManyArgs[1] as { where?: unknown }).where)
    expect(teammatesWhere.params).toEqual(expect.arrayContaining(['team-1', 'team-2']))
  })

  it('facade delegates to the injected collaborator with all three arguments', async () => {
    const createFromInterview = vi.fn(async () => ({ id: 'x' }))
    const facade = new ProjectsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { createFromInterview } as never,
    )
    const tx = {} as never

    await facade.createFromInterview(interview, ACTOR, tx)

    expect(createFromInterview).toHaveBeenCalledWith(interview, ACTOR, tx)
  })
})
