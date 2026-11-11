/**
 * Unit spec of the Task 15 access refusals in SeniorResumesService that happen before any query:
 * confirm is ADMIN/HR only (403), and the staged PDF answers a viewer without read access with the
 * live PDF's 404. The DB double throws when touched. The real-DB flows are in
 * verification/resume-verification-confirm.integration.spec.ts.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { SeniorResumesService } from './resumes.service'

const OWNER_ID = 'a15e0000-0000-4000-8000-0000000000a1'
const RUN = 'a15e0000-0000-4000-8000-000000000001'

const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error('the DB was touched')
    },
  },
)
const service = new SeniorResumesService(
  { db: untouchable } as never,
  untouchable as never,
  {} as never,
  {} as never,
  untouchable as never,
  untouchable as never,
)
const viewer = (id: string, role: SessionUser['role']) =>
  ({ id, email: 'x@unit.spec', role }) as SessionUser

async function refusal(p: Promise<unknown>) {
  return p.then(
    () => null,
    (e: unknown) => e,
  )
}

describe('SeniorResumesService — Task 15 refusals before any query', () => {
  it('a SENIOR confirming their own resume gets 403 with the access message', async () => {
    const err = await refusal(
      service.confirm(viewer(OWNER_ID, 'SENIOR'), OWNER_ID, { runId: RUN, version: 1 }),
    )
    expect(err).toBeInstanceOf(ForbiddenException)
    expect((err as ForbiddenException).message).toBe('Нет доступа к резюме этого пользователя')
  })

  it('a JUNIOR is refused confirm, edit and regenerate with the same 403', async () => {
    const junior = viewer('a15e0000-0000-4000-8000-0000000000c1', 'JUNIOR')
    for (const p of [
      service.confirm(junior, OWNER_ID, { runId: RUN, version: 1 }),
      service.editStagedField(junior, OWNER_ID, { runId: RUN, path: 'summary', text: 'x' }),
      service.regenerateStagedField(junior, OWNER_ID, { runId: RUN, path: 'summary' }),
    ]) {
      const err = await refusal(p)
      expect(err).toBeInstanceOf(ForbiddenException)
      expect((err as ForbiddenException).message).toBe('Нет доступа к резюме этого пользователя')
    }
  })

  it('the staged PDF answers a foreign SENIOR and a JUNIOR with the live PDF 404', async () => {
    for (const who of [
      viewer('a15e0000-0000-4000-8000-0000000000a2', 'SENIOR'),
      viewer('a15e0000-0000-4000-8000-0000000000c1', 'JUNIOR'),
    ]) {
      const err = await refusal(service.getStagedPdf(who, OWNER_ID))
      expect(err).toBeInstanceOf(NotFoundException)
      expect((err as NotFoundException).message).toBe('Резюме ещё не создано')
    }
  })
})
