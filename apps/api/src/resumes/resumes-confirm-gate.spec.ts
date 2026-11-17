/**
 * Unit spec of the confirm role gate in SeniorResumesService (spec Q-C): confirm asks
 * `canConfirmResume` on its own, not only the write access that follows. Today both share the
 * same roles, so the gate is pinned by making it refuse a viewer the write check would admit.
 * The DB double throws when touched: a 403 here means no query and no verification call ran.
 */
import { HttpException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { canConfirmResume } from './resume-access'
import { SeniorResumesService } from './resumes.service'

vi.mock('./resume-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./resume-access')>()
  return { ...actual, canConfirmResume: vi.fn(actual.canConfirmResume) }
})

const OWNER_ID = 'a15e0000-0000-4000-8000-0000000000a1'
const RUN = 'a15e0000-0000-4000-8000-000000000001'

const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error('touched')
    },
  },
)
const service = new SeniorResumesService(
  { db: untouchable } as never,
  untouchable as never,
  untouchable as never,
  untouchable as never,
  untouchable as never,
  untouchable as never,
)

describe('SeniorResumesService.confirm — the confirm role gate', () => {
  it('refuses with 403 before any query when the confirm gate says no, even for a viewer with write access', async () => {
    const admin = {
      id: 'a15e0000-0000-4000-8000-0000000000d1',
      email: 'x@unit.spec',
      role: 'ADMIN',
    }
    vi.mocked(canConfirmResume).mockReturnValueOnce(false)
    const err = await service
      .confirm(admin as SessionUser, OWNER_ID, { runId: RUN, version: 1 })
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(canConfirmResume).toHaveBeenCalledWith(admin)
    expect((err as HttpException).getStatus()).toBe(403)
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'RESUME_NO_ACCESS' })
  })
})
