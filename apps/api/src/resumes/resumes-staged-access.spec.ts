/**
 * Unit spec of the Task 15 access refusals in SeniorResumesService that happen before any query:
 * confirm is ADMIN/HR only (403), and the staged PDF answers a viewer without read access with the
 * live PDF's 404. The DB double throws when touched. The allowed paths run over a query double up
 * to the call under test (the owner's staged PDF; the fingerprint handed to the confirm CAS). The
 * real-DB flows are in
 * verification/resume-verification-confirm.integration.spec.ts.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_RESUME_LAYOUT, type SessionUser } from '@crm/shared'
import type { ResumeRenderInput } from './resume-typst.service'
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

describe('SeniorResumesService — Task 15 allowed paths', () => {
  const content = (summary: string) => ({
    summary,
    skills: [],
    experience: [],
    education: [],
    languages: [],
    links: [],
  })
  const OWNER = { id: OWNER_ID, role: 'SENIOR', displayName: 'Jane Doe', email: 'jane@unit.spec' }
  const layout = (hidden: string[]) => ({ ...DEFAULT_RESUME_LAYOUT, hiddenSections: hidden })
  const ROW = {
    id: 'r-1',
    userId: OWNER_ID,
    content: content('Live.'),
    layout: layout([]),
    templateName: 'classic',
    templateSource: null,
    stagedContent: content('Staged.'),
    stagedLayout: layout(['languages']),
    stagedTemplateName: 'modern',
    stagedPdfS3Key: 'resumes/r-1/staged/run.pdf',
  }
  const BAIL = new Error('stop after the call under test')

  function build(row: object | undefined) {
    const db = {
      db: {
        query: {
          users: { findFirst: vi.fn(async () => OWNER) },
          seniorResumes: { findFirst: vi.fn(async () => row) },
        },
      },
    }
    const s3 = { getObject: vi.fn(async (_key: string) => Buffer.from('%PDF staged')) }
    const typst = { fingerprint: vi.fn((_input: ResumeRenderInput) => 'fp-staged') }
    const verification = { confirm: vi.fn(async (..._args: unknown[]) => Promise.reject(BAIL)) }
    const svc = new SeniorResumesService(
      db as never,
      s3 as never,
      {} as never,
      {} as never,
      typst as never,
      verification as never,
    )
    return { svc, s3, typst, verification }
  }

  it('the owner reads their own staged PDF, under their display name', async () => {
    const { svc, s3 } = build(ROW)
    const out = await svc.getStagedPdf(viewer(OWNER_ID, 'SENIOR'), OWNER_ID)
    expect(out.displayName).toBe('Jane Doe')
    expect(out.pdfBuffer.toString()).toBe('%PDF staged')
    expect(s3.getObject).toHaveBeenCalledWith('resumes/r-1/staged/run.pdf')
  })

  it('no row, or a row without a staged PDF, answers the owner with the live 404', async () => {
    for (const row of [undefined, { ...ROW, stagedPdfS3Key: null }]) {
      const { svc, s3 } = build(row)
      const err = await refusal(svc.getStagedPdf(viewer(OWNER_ID, 'SENIOR'), OWNER_ID))
      expect(err).toBeInstanceOf(NotFoundException)
      expect((err as NotFoundException).message).toBe('Резюме ещё не создано')
      expect(s3.getObject).not.toHaveBeenCalled()
    }
  })

  it('confirm on a senior with no resume row is the live 404, no fingerprint', async () => {
    const { svc, typst, verification } = build(undefined)
    const hr = viewer('a15e0000-0000-4000-8000-0000000000a3', 'HR')
    const err = await refusal(svc.confirm(hr, OWNER_ID, { runId: RUN, version: 1 }))
    expect(err).toBeInstanceOf(NotFoundException)
    expect((err as NotFoundException).message).toBe('Резюме ещё не создано')
    expect(typst.fingerprint).not.toHaveBeenCalled()
    expect(verification.confirm).not.toHaveBeenCalled()
  })

  it('HR confirm fingerprints the staged look and hands it to the CAS', async () => {
    const { svc, typst, verification } = build(ROW)
    const hr = viewer('a15e0000-0000-4000-8000-0000000000a3', 'HR')
    const input = { runId: RUN, version: 1 }
    await expect(svc.confirm(hr, OWNER_ID, input)).rejects.toBe(BAIL)
    const rendered = typst.fingerprint.mock.calls[0]?.[0]
    expect(rendered?.content.summary).toBe('Staged.')
    expect(rendered?.layout.hiddenSections).toEqual(['languages'])
    expect(rendered?.templateName).toBe('modern')
    expect(rendered?.displayName).toBe('Jane Doe')
    expect(verification.confirm).toHaveBeenCalledWith(ROW, input, hr.id, 'fp-staged')
  })

  it('a row without staged look fields fingerprints the live ones', async () => {
    const live = { ...ROW, stagedContent: null, stagedLayout: null, stagedTemplateName: null }
    const { svc, typst } = build(live)
    const admin = viewer('a15e0000-0000-4000-8000-0000000000a4', 'ADMIN')
    await expect(svc.confirm(admin, OWNER_ID, { runId: RUN, version: 1 })).rejects.toBe(BAIL)
    const rendered = typst.fingerprint.mock.calls[0]?.[0]
    expect(rendered?.content.summary).toBe('Live.')
    expect(rendered?.layout.hiddenSections).toEqual([])
    expect(rendered?.templateName).toBe('classic')
  })
})
