/**
 * Direct coverage for ProjectInterviewSeedService (extracted verbatim from
 * ProjectsService.createFromInterview). Pins the seam: the facade delegates
 * to the injected collaborator and forwards (interview, user, tx) untouched;
 * the collaborator, used on its own, mints a DRAFT with the senior as the
 * sole invited approver.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { ProjectInterviewSeedService } from './project-interview-seed.service'
import { ProjectsService } from './projects.service'
import { projects } from '../database/schema'
import { makeNotificationsStub } from '../notifications/__test-helpers__/notifications-stub'
import { makeProposeInTxStub } from '../approvals/__test-helpers__/approvals-stub'

const ACTOR = { id: 'actor-1', role: 'ADMIN' } as unknown as SessionUser
const SENIOR_ID = 'senior-1'
const interview = {
  seniorId: SENIOR_ID,
  companyName: 'Seed Co',
  notesDomain: null,
  senior: null,
} as unknown as Parameters<ProjectInterviewSeedService['createFromInterview']>[0]

function makeSeed() {
  const inserted: Record<string, unknown>[] = []
  const db = {
    db: {
      query: { teamMembers: { findMany: vi.fn(async () => []) } },
      insert: vi.fn((table: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          if (table === projects) inserted.push(vals)
          return Object.assign(Promise.resolve(undefined), {
            returning: () => Promise.resolve([{ id: 'p-1', companyName: 'Seed Co' }]),
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
  return { seed, inserted, proposeInTx }
}

describe('ProjectInterviewSeedService', () => {
  it('defaults the domain to "Other", mints DRAFT, proposes to the senior only', async () => {
    const { seed, inserted, proposeInTx } = makeSeed()

    const result = await seed.createFromInterview(interview, ACTOR)

    expect(result?.id).toBe('p-1')
    expect(inserted[0]).toMatchObject({ domain: 'Other', status: 'DRAFT', rate: 0 })
    expect(proposeInTx).toHaveBeenCalledWith(expect.anything(), {
      subjectType: 'PROJECT',
      subjectId: 'p-1',
      approverUserIds: [SENIOR_ID],
      proposedByUserId: 'actor-1',
    })
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
