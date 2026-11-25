/**
 * Unit spec of the Task 15 access refusals in SeniorResumesService that happen before any query:
 * confirm is ADMIN/HR only (403), and the staged PDF answers a viewer without read access with the
 * live PDF's 404. The DB double throws when touched. The allowed paths run over a query double up
 * to the call under test (the owner's staged PDF; the fingerprint handed to the confirm CAS). The
 * real-DB flows are in
 * verification/resume-verification-confirm.integration.spec.ts.
 */
import { HttpException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_RESUME_LAYOUT, EMPTY_RESUME_HEADER, type SessionUser } from '@crm/shared'
import type { ResumeRenderInput } from './resume-typst.service'
import { SeniorResumesService } from './resumes.service'

// Senior roles PR 4: the roster dirty mark is covered by resume-dirty.integration.spec.ts.
vi.mock('../job-sourcing/dirty-producers')

const OWNER_ID = 'a15e0000-0000-4000-8000-0000000000a1'
const RUN = 'a15e0000-0000-4000-8000-000000000001'
// [owner 2026-11-14] only ADMIN and HR write a resume, so the delete runs as HR.
const HR_ID = 'a15e0000-0000-4000-8000-0000000000b1'

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
    expect((err as HttpException).getStatus()).toBe(403)
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'RESUME_NO_ACCESS' })
  })

  it('a JUNIOR is refused confirm, edit and regenerate with the same 403', async () => {
    const junior = viewer('a15e0000-0000-4000-8000-0000000000c1', 'JUNIOR')
    for (const p of [
      service.confirm(junior, OWNER_ID, { runId: RUN, version: 1 }),
      service.editStagedField(junior, OWNER_ID, { runId: RUN, path: 'summary', text: 'x' }),
      service.regenerateStagedField(junior, OWNER_ID, { runId: RUN, path: 'summary' }),
    ]) {
      const err = await refusal(p)
      expect((err as HttpException).getStatus()).toBe(403)
      expect((err as HttpException).getResponse()).toMatchObject({ code: 'RESUME_NO_ACCESS' })
    }
  })

  it('the staged PDF answers a foreign SENIOR and a JUNIOR with the live PDF 404', async () => {
    for (const who of [
      viewer('a15e0000-0000-4000-8000-0000000000a2', 'SENIOR'),
      viewer('a15e0000-0000-4000-8000-0000000000c1', 'JUNIOR'),
    ]) {
      const err = await refusal(service.getStagedPdf(who, OWNER_ID))
      expect((err as HttpException).getStatus()).toBe(404)
      expect((err as HttpException).getResponse()).toMatchObject({ code: 'RESUME_NOT_CREATED' })
    }
  })
})

// [owner 2026-11-14] A SENIOR only VIEWS their resume: every write endpoint refuses the owner
// with 403 before any query (the DB double throws when touched). Reads stay open to the owner.
describe('SeniorResumesService — a SENIOR cannot write their own resume', () => {
  const owner = viewer(OWNER_ID, 'SENIOR')
  const writes: Array<[string, () => Promise<unknown>]> = [
    ['PUT /', () => service.updateContent(owner, OWNER_ID, {} as never)],
    ['POST source', () => service.uploadSource(owner, OWNER_ID, {} as never)],
    ['POST text', () => service.ingestText(owner, OWNER_ID, 'text')],
    ['DELETE', () => service.deleteResume(owner, OWNER_ID)],
    ['PUT layout', () => service.updateLayout(owner, OWNER_ID, DEFAULT_RESUME_LAYOUT)],
    ['PUT header', () => service.updateHeader(owner, OWNER_ID, EMPTY_RESUME_HEADER)],
    ['PUT facts', () => service.saveFacts(owner, OWNER_ID, {} as never)],
    ['POST submit', () => service.submit(owner, OWNER_ID)],
    [
      'PUT staged',
      () => service.editStagedField(owner, OWNER_ID, { runId: RUN, path: 'summary', text: 'x' }),
    ],
    [
      'POST staged/regenerate',
      () => service.regenerateStagedField(owner, OWNER_ID, { runId: RUN, path: 'summary' }),
    ],
    ['PUT template', () => service.setTemplate(owner, OWNER_ID, 'modern')],
  ]
  it.each(writes)('%s answers the owner 403 with the access message', async (_name, call) => {
    const err = await refusal(call())
    expect((err as HttpException).getStatus()).toBe(403)
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'RESUME_NO_ACCESS' })
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
      expect((err as HttpException).getStatus()).toBe(404)
      expect((err as HttpException).getResponse()).toMatchObject({ code: 'RESUME_NOT_CREATED' })
      expect(s3.getObject).not.toHaveBeenCalled()
    }
  })

  it('a staged key whose object is gone is 404 DOCUMENT_NOT_FOUND, not a 500 (QA-12)', async () => {
    const { svc, s3 } = build(ROW)
    s3.getObject.mockRejectedValueOnce(
      Object.assign(new Error('The specified key does not exist.'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      }),
    )
    const err = await refusal(svc.getStagedPdf(viewer(OWNER_ID, 'SENIOR'), OWNER_ID))
    expect(err).toBeInstanceOf(HttpException)
    expect((err as HttpException).getStatus()).toBe(404)
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'DOCUMENT_NOT_FOUND' })
  })

  it('any other storage failure of the staged PDF is rethrown as is', async () => {
    const { svc, s3 } = build(ROW)
    const outage = Object.assign(new Error('socket hang up'), { name: 'TimeoutError' })
    s3.getObject.mockRejectedValueOnce(outage)
    expect(await refusal(svc.getStagedPdf(viewer(OWNER_ID, 'SENIOR'), OWNER_ID))).toBe(outage)
  })

  it('a missing bucket is not a missing file: NoSuchBucket (HTTP 404) is rethrown (CR-M-2)', async () => {
    const { svc, s3 } = build(ROW)
    const noBucket = Object.assign(new Error('The specified bucket does not exist'), {
      name: 'NoSuchBucket',
      $metadata: { httpStatusCode: 404 },
    })
    s3.getObject.mockRejectedValueOnce(noBucket)
    expect(await refusal(svc.getStagedPdf(viewer(OWNER_ID, 'SENIOR'), OWNER_ID))).toBe(noBucket)
  })

  it('a NoSuchKey carried in `Code` (not `name`) is still 404 DOCUMENT_NOT_FOUND', async () => {
    const { svc, s3 } = build(ROW)
    s3.getObject.mockRejectedValueOnce(
      Object.assign(new Error('missing'), { name: 'S3ServiceException', Code: 'NoSuchKey' }),
    )
    const err = await refusal(svc.getStagedPdf(viewer(OWNER_ID, 'SENIOR'), OWNER_ID))
    expect((err as HttpException).getStatus()).toBe(404)
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'DOCUMENT_NOT_FOUND' })
  })

  it('the live PDF of a senior with no resume row is the same 404', async () => {
    const { svc, typst } = build(undefined)
    const err = await refusal(svc.getRenderedPdf(viewer(OWNER_ID, 'SENIOR'), OWNER_ID))
    expect((err as HttpException).getStatus()).toBe(404)
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'RESUME_NOT_CREATED' })
    expect(typst.fingerprint).not.toHaveBeenCalled()
  })

  it('a row whose live PDF matches the render input streams it', async () => {
    const live = { ...ROW, pdfS3Key: 'resumes/r-1/live.pdf', pdfFingerprint: 'fp-staged' }
    const { svc, s3 } = build(live)
    const out = await svc.getRenderedPdf(viewer(OWNER_ID, 'SENIOR'), OWNER_ID)
    expect(out).toMatchObject({ ready: true, displayName: 'Jane Doe' })
    expect(s3.getObject).toHaveBeenCalledWith('resumes/r-1/live.pdf')
  })

  it('confirm on a senior with no resume row is the live 404, no fingerprint', async () => {
    const { svc, typst, verification } = build(undefined)
    const hr = viewer('a15e0000-0000-4000-8000-0000000000a3', 'HR')
    const err = await refusal(svc.confirm(hr, OWNER_ID, { runId: RUN, version: 1 }))
    expect((err as HttpException).getStatus()).toBe(404)
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'RESUME_NOT_CREATED' })
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
    // The owner the fingerprint was taken with goes to the CAS too: its name and email (B10).
    expect(verification.confirm).toHaveBeenCalledWith(
      ROW,
      input,
      hr.id,
      'fp-staged',
      expect.objectContaining({
        displayName: 'Jane Doe',
        email: rendered?.email,
        // the profile the run redacted, so a profile edit under a header override is stale
        profile: expect.objectContaining({ displayName: 'Jane Doe', email: rendered?.email }),
      }),
    )
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

describe('SeniorResumesService — a delete while a run owns the row (CD-4)', () => {
  const OWNER = { id: OWNER_ID, role: 'SENIOR', displayName: 'Jane Doe', email: 'jane@unit.spec' }
  const ROW = { id: 'r-1', userId: OWNER_ID, sourceS3Key: 'src', pdfS3Key: 'live.pdf' }

  it.each([
    ['QUEUED', { verificationStatus: 'QUEUED', verificationRunId: RUN }],
    ['CHECKING', { verificationStatus: 'CHECKING', verificationRunId: RUN }],
    ['a VERIFIED template run', { verificationStatus: 'VERIFIED', verificationRunId: RUN }],
  ])('%s: 409 RESUME_VERIFICATION_BUSY, no object and no row deleted', async (_label, over) => {
    const s3 = { delete: vi.fn() }
    const remove = vi.fn()
    const db = {
      db: {
        query: {
          users: { findFirst: vi.fn(async () => OWNER) },
          seniorResumes: { findFirst: vi.fn(async () => ({ ...ROW, ...over })) },
        },
        delete: remove,
      },
    }
    const svc = new SeniorResumesService(
      db as never,
      s3 as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
    const err = await refusal(svc.deleteResume(viewer(HR_ID, 'HR'), OWNER_ID))
    expect(err).toBeInstanceOf(HttpException)
    expect((err as HttpException).getStatus()).toBe(409)
    expect((err as HttpException).getResponse()).toMatchObject({
      code: 'RESUME_VERIFICATION_BUSY',
    })
    expect(s3.delete).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it.each([
    ['AWAITING_CONFIRM (its run id waits for the owner)', 'AWAITING_CONFIRM', RUN],
    ['VERIFIED with no run', 'VERIFIED', null],
    ['FAILED', 'FAILED', null],
  ])('%s: the delete goes ahead', async (_label, status, runId) => {
    const s3 = {
      delete: vi.fn(),
      deleteOrThrow: vi.fn(),
      listObjects: vi.fn(async () => ({ objects: [], nextContinuationToken: undefined })),
    }
    const remove = vi.fn(() => ({ where: () => ({ returning: async () => [{ id: ROW.id }] }) }))
    // P5: a waiting staged PDF is a third copy of the CV and goes with the other two.
    const stagedPdfS3Key = status === 'AWAITING_CONFIRM' ? 'staged.pdf' : null
    const row = { ...ROW, verificationStatus: status, verificationRunId: runId, stagedPdfS3Key }
    const db = {
      db: {
        query: {
          users: { findFirst: vi.fn(async () => OWNER) },
          seniorResumes: { findFirst: vi.fn(async () => row) },
        },
        delete: remove,
        // C3: no tailored run or render active; the tailored row lock reads nothing.
        execute: vi.fn(async () => ({ rows: [] })),
        transaction: (work: (tx: unknown) => Promise<unknown>) =>
          work({ delete: remove, execute: vi.fn(async () => ({ rows: [] })) }),
      },
    }
    const svc = new SeniorResumesService(
      db as never,
      s3 as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
    expect(await svc.deleteResume(viewer(HR_ID, 'HR'), OWNER_ID)).toMatchObject({ resume: null })
    expect(remove).toHaveBeenCalledTimes(1)
    // The base objects fail closed (deleteOrThrow): a storage failure keeps the row.
    expect(s3.deleteOrThrow.mock.calls.map((c) => c[0])).toEqual(
      stagedPdfS3Key ? ['src', 'live.pdf', stagedPdfS3Key] : ['src', 'live.pdf'],
    )
    expect(s3.delete).not.toHaveBeenCalled()
  })
})

describe('SeniorResumesService — the target lookup refuses by code (backlog 443)', () => {
  const withTarget = (target: { role: string } | undefined) =>
    new SeniorResumesService(
      { db: { query: { users: { findFirst: async () => target } } } } as never,
      untouchable as never,
      {} as never,
      {} as never,
      untouchable as never,
      untouchable as never,
    )

  it('no such user is 404 USER_NOT_FOUND', async () => {
    const err = await refusal(withTarget(undefined).getForUser(viewer(HR_ID, 'HR'), OWNER_ID))
    expect((err as HttpException).getStatus()).toBe(404)
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'USER_NOT_FOUND' })
  })

  it('a target who is not a SENIOR is 404 RESUME_SENIOR_ONLY', async () => {
    const err = await refusal(
      withTarget({ role: 'JUNIOR' }).getForUser(viewer(HR_ID, 'HR'), OWNER_ID),
    )
    expect((err as HttpException).getStatus()).toBe(404)
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'RESUME_SENIOR_ONLY' })
  })
})

describe('SeniorResumesService — updateHeader (PUT header)', () => {
  const PROFILE = {
    id: OWNER_ID,
    role: 'SENIOR',
    displayName: 'Jane Doe',
    email: 'jane@unit.spec',
    phone: '+380 67 000 0000',
    telegram: 'jane_doe',
  }

  function build(existing: object, returned: object[], profile: object = PROFILE) {
    const set = vi.fn(() => ({ where: () => ({ returning: async () => returned }) }))
    const db = { db: { update: vi.fn(() => ({ set })) } }
    const verification = {
      resolveMiss: vi.fn(async () => 'miss'),
      deleteStagedObject: vi.fn(async () => undefined),
    }
    const svc = new SeniorResumesService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      verification as never,
    )
    const inner = svc as unknown as Record<string, unknown>
    inner['assertAccess'] = vi.fn(async () => profile)
    inner['ensureRow'] = vi.fn(async () => existing)
    const enqueueRender = vi.fn(async () => undefined)
    inner['enqueueRender'] = enqueueRender
    inner['toResponse'] = vi.fn(async (row: unknown) => row)
    return { svc, set, verification, enqueueRender }
  }

  const ROW = { id: 'r-1', verificationStatus: 'DRAFT', stagedPdfS3Key: null }

  it('stores a value equal to the profile one as null; a different value stays', async () => {
    const { svc, set, enqueueRender } = build(ROW, [ROW])
    await svc.updateHeader(viewer(HR_ID, 'HR'), OWNER_ID, {
      displayName: 'Jane Doe',
      email: 'other@unit.spec',
      phone: '+380 67 000 0000',
      telegram: '@jane_doe',
    })
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        header: { displayName: null, email: 'other@unit.spec', phone: null, telegram: null },
      }),
    )
    expect(enqueueRender).toHaveBeenCalledWith('r-1', PROFILE)
  })

  it('keeps each override that differs from the profile', async () => {
    const { svc, set } = build(ROW, [ROW])
    const header = {
      displayName: 'Jane Override',
      email: null,
      phone: '+380 50 000 0000',
      telegram: '@jane_cv',
    }
    await svc.updateHeader(viewer(HR_ID, 'HR'), OWNER_ID, header)
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ header }))
  })

  it('an email equal to the profile one is stored as null', async () => {
    const { svc, set } = build(ROW, [ROW])
    await svc.updateHeader(viewer(HR_ID, 'HR'), OWNER_ID, {
      ...EMPTY_RESUME_HEADER,
      email: 'jane@unit.spec',
    })
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ header: EMPTY_RESUME_HEADER }))
  })

  it('only a leading @ is ignored: an @ inside the profile value still differs', async () => {
    const { svc, set } = build(ROW, [ROW], { ...PROFILE, telegram: 'jane_@doe' })
    const header = { ...EMPTY_RESUME_HEADER, telegram: 'jane_doe' }
    await svc.updateHeader(viewer(HR_ID, 'HR'), OWNER_ID, header)
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ header }))
  })

  it('an AWAITING_CONFIRM result is discarded: DRAFT reset and its staged PDF deleted', async () => {
    const awaiting = {
      ...ROW,
      verificationStatus: 'AWAITING_CONFIRM',
      stagedPdfS3Key: 'staged.pdf',
    }
    const { svc, set, verification } = build(awaiting, [awaiting])
    await svc.updateHeader(viewer(HR_ID, 'HR'), OWNER_ID, EMPTY_RESUME_HEADER)
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ verificationStatus: 'DRAFT' }))
    expect(verification.deleteStagedObject).toHaveBeenCalledWith('staged.pdf')
  })

  it('a DRAFT row keeps its status and deletes nothing', async () => {
    const { svc, set, verification } = build(ROW, [ROW])
    await svc.updateHeader(viewer(HR_ID, 'HR'), OWNER_ID, EMPTY_RESUME_HEADER)
    expect(set).toHaveBeenCalledWith(
      expect.not.objectContaining({ verificationStatus: expect.anything() }),
    )
    expect(verification.deleteStagedObject).not.toHaveBeenCalled()
  })

  it('a row that moved since the read is a miss: no render, no staged delete', async () => {
    const awaiting = {
      ...ROW,
      verificationStatus: 'AWAITING_CONFIRM',
      stagedPdfS3Key: 'staged.pdf',
    }
    const { svc, verification, enqueueRender } = build(awaiting, [])
    expect(await svc.updateHeader(viewer(HR_ID, 'HR'), OWNER_ID, EMPTY_RESUME_HEADER)).toBe('miss')
    expect(verification.resolveMiss).toHaveBeenCalledWith('r-1')
    expect(verification.deleteStagedObject).not.toHaveBeenCalled()
    expect(enqueueRender).not.toHaveBeenCalled()
  })
})
