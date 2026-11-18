/**
 * Backlog 447: the live PDF's object is gone from the bucket while the row still says it is ready.
 *
 * The bucket is an in-memory map and the DB a one-row double whose updates apply in place, so the
 * real `runRender` re-uploads the deterministic key and the next request serves it.
 */
import { Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RESUME_LAYOUT, encodeResumeMessage, type SessionUser } from '@crm/shared'
import { ResumeRenderError } from './resume-typst.service'
import { markSeniorResumeDirty } from '../job-sourcing/dirty-producers'
import { SeniorResumesService, STUCK_RENDER_TIMEOUT_MS } from './resumes.service'

// Senior roles PR 4: the roster dirty mark is covered by resume-dirty.integration.spec.ts.
vi.mock('../job-sourcing/dirty-producers')

const OWNER_ID = 'a4470000-0000-4000-8000-0000000000a1'
const OWNER = { id: OWNER_ID, role: 'SENIOR', displayName: 'Jane Doe', email: 'jane@unit.spec' }
const FP = 'fp0123456789abcdef-rest'
const KEY = `senior-resumes/${OWNER_ID}/pdf/r-1-fp0123456789abcd.pdf`
const viewer = { id: OWNER_ID, email: OWNER.email, role: 'SENIOR' } as SessionUser
/** Deleting is an HR / ADMIN action: a senior only reads their own resume. */
const hr = {
  id: 'a4470000-0000-4000-8000-0000000000b2',
  email: 'hr@unit.spec',
  role: 'HR',
} as SessionUser

const noSuchKey = () =>
  Object.assign(new Error('The specified key does not exist.'), {
    name: 'NoSuchKey',
    $metadata: { httpStatusCode: 404 },
  })

function build(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: 'r-1',
    userId: OWNER_ID,
    content: {
      summary: 'Live.',
      skills: [],
      experience: [],
      education: [],
      languages: [],
      links: [],
    },
    layout: DEFAULT_RESUME_LAYOUT,
    templateName: 'classic',
    templateSource: null,
    pdfS3Key: KEY,
    pdfFingerprint: FP,
    pdfRenderStatus: 'READY',
    pdfRenderError: null,
    ...overrides,
  }
  const updates: Record<string, unknown>[] = []
  /**
   * `rejectNext`: the next update matches no row (a run disowned before its terminal write).
   * `gone`: the row was deleted; reads find nothing, updates match nothing.
   */
  const control = { rejectNext: false, gone: false, deleteMisses: false }
  const db = {
    db: {
      query: {
        users: { findFirst: vi.fn(async () => OWNER) },
        seniorResumes: { findFirst: vi.fn(async () => (control.gone ? undefined : { ...row })) },
      },
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            if (control.rejectNext || control.gone) {
              control.rejectNext = false
              return Object.assign(Promise.resolve(), { returning: async () => [] })
            }
            updates.push(values)
            Object.assign(row, values)
            return Object.assign(Promise.resolve(), { returning: async () => [{ ...row }] })
          },
        }),
      }),
      delete: () => ({
        where: () => ({
          returning: async () => {
            // `deleteMisses`: the guarded DELETE matches no row (the source key moved mid-delete).
            if (control.deleteMisses) return []
            control.gone = true
            return [{ id: row.id }]
          },
        }),
      }),
      transaction: (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => work(db.db),
    },
  }
  const objects = new Map<string, Buffer>()
  const s3 = {
    getObject: vi.fn(async (key: string) => {
      const body = objects.get(key)
      if (!body) throw noSuchKey()
      return body
    }),
    upload: vi.fn(async (key: string, body: Buffer) => void objects.set(key, body)),
    delete: vi.fn(async (key: string) => void objects.delete(key)),
    listObjects: vi.fn(async (_token: string | undefined, prefix: string) => ({
      objects: [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, sizeBytes: 1, lastModified: new Date(0) })),
      nextContinuationToken: undefined,
    })),
  }
  const typst = {
    fingerprint: vi.fn(() => FP),
    render: vi.fn(async (_input: unknown, onStart: () => void) => {
      onStart()
      return Buffer.from('%PDF re-rendered')
    }),
  }
  const svc = new SeniorResumesService(
    db as never,
    s3 as never,
    {} as never,
    {} as never,
    typst as never,
    {} as never,
  )
  return { svc, row, updates, objects, s3, typst, control }
}

describe('getRenderedPdf — the current PDF object is missing (backlog 447)', () => {
  it('answers not-ready QUEUED instead of a 500, and serves the PDF once the re-render lands', async () => {
    const { svc, row, s3, typst } = build()

    const first = await svc.getRenderedPdf(viewer, OWNER_ID)
    expect(first).toEqual({ ready: false, status: 'QUEUED', message: null })

    await vi.waitFor(() => expect(row.pdfRenderStatus).toBe('READY'))
    expect(typst.render).toHaveBeenCalledTimes(1)
    expect(s3.upload).toHaveBeenCalledWith(KEY, expect.any(Buffer), 'application/pdf', 'RESUME')
    // Same key as before: the row's old key is not deleted out from under the new object.
    expect(s3.delete).not.toHaveBeenCalled()

    const second = await svc.getRenderedPdf(viewer, OWNER_ID)
    expect(second).toMatchObject({ ready: true, displayName: 'Jane Doe' })
    expect((second as { pdfBuffer: Buffer }).pdfBuffer.toString()).toBe('%PDF re-rendered')
  })

  it('a NoSuchKey carried in `Code` (not `name`) is re-queued the same way', async () => {
    const { svc, s3, updates } = build()
    s3.getObject.mockRejectedValueOnce(
      Object.assign(new Error('missing'), { name: 'S3ServiceException', Code: 'NoSuchKey' }),
    )
    expect(await svc.getRenderedPdf(viewer, OWNER_ID)).toEqual({
      ready: false,
      status: 'QUEUED',
      message: null,
    })
    expect(updates[0]).toMatchObject({ pdfRenderStatus: 'QUEUED', pdfRenderRunId: null })
  })

  it('a QUEUED render is reported, not re-queued (polling must not disown it)', async () => {
    const { svc, updates, typst } = build({ pdfRenderStatus: 'QUEUED' })
    expect(await svc.getRenderedPdf(viewer, OWNER_ID)).toEqual({
      ready: false,
      status: 'QUEUED',
      message: null,
    })
    expect(updates).toEqual([])
    expect(typst.render).not.toHaveBeenCalled()
  })

  describe('a RUNNING render is trusted only while it is younger than the stuck-render cutoff', () => {
    const NOW = new Date('2026-11-16T12:00:00.000Z')
    const at = (ms: number) => new Date(NOW.getTime() - ms)
    afterEach(() => vi.useRealTimers())

    it('started exactly at the cutoff: reported RUNNING, not re-queued', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW })
      const { svc, updates } = build({
        pdfRenderStatus: 'RUNNING',
        pdfRenderStartedAt: at(STUCK_RENDER_TIMEOUT_MS),
      })
      expect(await svc.getRenderedPdf(viewer, OWNER_ID)).toEqual({
        ready: false,
        status: 'RUNNING',
        message: null,
      })
      expect(updates).toEqual([])
    })

    it.each([
      ['started a millisecond past the cutoff', at(STUCK_RENDER_TIMEOUT_MS + 1)],
      ['claimed but not started (NULL)', null],
    ])('%s: re-queued', async (_name, startedAt) => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW })
      const { svc, updates } = build({ pdfRenderStatus: 'RUNNING', pdfRenderStartedAt: startedAt })
      expect(await svc.getRenderedPdf(viewer, OWNER_ID)).toEqual({
        ready: false,
        status: 'QUEUED',
        message: null,
      })
      expect(updates[0]).toMatchObject({ pdfRenderStatus: 'QUEUED', pdfRenderRunId: null })
    })

    it('a fresh start time on a row that is not RUNNING does not hold the re-render back', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW })
      const { svc, updates } = build({ pdfRenderStatus: 'READY', pdfRenderStartedAt: NOW })
      expect(await svc.getRenderedPdf(viewer, OWNER_ID)).toMatchObject({ status: 'QUEUED' })
      expect(updates[0]).toMatchObject({ pdfRenderStatus: 'QUEUED' })
    })
  })

  it('a recovery render whose upload failed is re-queued on the next poll, then served (CR-M-1)', async () => {
    const { svc, row, s3 } = build()
    s3.upload.mockRejectedValueOnce(new Error('R2 unavailable'))

    expect(await svc.getRenderedPdf(viewer, OWNER_ID)).toMatchObject({ status: 'QUEUED' })
    await vi.waitFor(() => expect(row.pdfRenderStatus).toBe('FAILED'))
    expect(row.pdfRenderError).toBe(encodeResumeMessage('RESUME_RENDER_STORAGE_FAILED'))
    expect(row.pdfFingerprint).toBe(FP)

    expect(await svc.getRenderedPdf(viewer, OWNER_ID)).toMatchObject({ status: 'QUEUED' })
    await vi.waitFor(() => expect(row.pdfRenderStatus).toBe('READY'))
    const out = await svc.getRenderedPdf(viewer, OWNER_ID)
    expect((out as { pdfBuffer: Buffer }).pdfBuffer.toString()).toBe('%PDF re-rendered')
  })

  it('a stored PDF behind a failed upload is still served: a storage failure changes neither key nor fingerprint', async () => {
    const { svc, objects } = build({
      pdfRenderStatus: 'FAILED',
      pdfRenderError: encodeResumeMessage('RESUME_RENDER_STORAGE_FAILED'),
    })
    objects.set(KEY, Buffer.from('%PDF stored'))
    expect(await svc.getRenderedPdf(viewer, OWNER_ID)).toMatchObject({ ready: true })
  })

  it('a Typst failure of the current input is reported even though an older PDF object exists', async () => {
    const { svc, objects, s3 } = build({ pdfRenderStatus: 'FAILED', pdfRenderError: 'RESUME_X' })
    objects.set(KEY, Buffer.from('%PDF of the previous content'))
    expect(await svc.getRenderedPdf(viewer, OWNER_ID)).toEqual({
      ready: false,
      status: 'FAILED',
      message: 'RESUME_X',
    })
    expect(s3.getObject).not.toHaveBeenCalled()
  })

  it('a confirmed staged key (no fingerprint in its name) is served as the live PDF', async () => {
    const staged = 'resumes/r-1/staged/run-1.pdf'
    const { svc, objects } = build({ pdfS3Key: staged })
    objects.set(staged, Buffer.from('%PDF verified'))
    const out = await svc.getRenderedPdf(viewer, OWNER_ID)
    expect((out as { pdfBuffer: Buffer }).pdfBuffer.toString()).toBe('%PDF verified')
  })

  describe('a superseded render of the same input', () => {
    const OLD_KEY = `senior-resumes/${OWNER_ID}/pdf/r-1-0000000000000000.pdf`

    async function racedRuns(afterNewer: (row: Record<string, unknown>) => void) {
      const built = build({ pdfRenderStatus: 'QUEUED', pdfS3Key: OLD_KEY, pdfFingerprint: 'old' })
      const { svc, row, typst, control } = built
      let release!: () => void
      typst.render.mockImplementationOnce(
        (_input: unknown, onStart: () => void) =>
          new Promise<Buffer>((resolve) => {
            onStart()
            release = () => resolve(Buffer.from('%PDF older run'))
          }),
      )
      const older = svc.runRender('r-1', OWNER as never)
      await vi.waitFor(() => expect(release).toBeDefined())
      // A newer run of the same input claims, uploads the SAME key (same fingerprint) and lands first.
      row.pdfRenderStatus = 'QUEUED'
      await svc.runRender('r-1', OWNER as never)
      expect(row.pdfS3Key).toBe(KEY)
      afterNewer(row)
      control.rejectNext = true // the older run's terminal write finds the run token gone
      release()
      await older
      return built
    }

    it('leaves its upload to the orphan sweep even when the row has moved on to another key', async () => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
      const { s3 } = await racedRuns((row) => {
        row.pdfS3Key = 'senior-resumes/elsewhere.pdf'
      })
      expect(s3.delete.mock.calls).toEqual([[OLD_KEY]])
      expect(log).toHaveBeenCalledWith(
        `Resume r-1: render superseded — leaving ${KEY} to the orphan sweep`,
      )
      log.mockRestore()
    })
  })

  it('a render whose resume was deleted mid-render deletes its own upload at once', async () => {
    const { svc, typst, s3, objects, control } = build({ pdfRenderStatus: 'QUEUED' })
    let release!: () => void
    typst.render.mockImplementationOnce(
      (_input: unknown, onStart: () => void) =>
        new Promise<Buffer>((resolve) => {
          onStart()
          release = () => resolve(Buffer.from('%PDF late'))
        }),
    )
    const run = svc.runRender('r-1', OWNER as never)
    await vi.waitFor(() => expect(release).toBeDefined())
    control.gone = true
    release()
    await run
    expect(s3.delete.mock.calls).toEqual([[KEY]])
    expect(objects.has(KEY)).toBe(false)
  })

  describe('a Typst failure leaves no stale key behind it (SPEC-1)', () => {
    const OLD_KEY = `senior-resumes/${OWNER_ID}/pdf/r-1-0000000000000000.pdf`
    const content = (summary: string) => ({
      summary,
      skills: [],
      experience: [],
      education: [],
      languages: [],
      links: [],
    })

    /** Content X fails in Typst over an older PDF (content W) whose object is still in the bucket. */
    async function typstFailsOnX() {
      const built = build({
        pdfRenderStatus: 'QUEUED',
        pdfS3Key: OLD_KEY,
        pdfFingerprint: 'fp-w',
        content: content('X'),
      })
      const { svc, row, typst, objects } = built
      objects.set(OLD_KEY, Buffer.from('%PDF of content W'))
      typst.fingerprint.mockImplementation(
        (input: unknown) => `fp-${(input as { content: { summary: string } }).content.summary}`,
      )
      typst.render.mockRejectedValueOnce(new ResumeRenderError('RESUME_X'))
      await svc.runRender('r-1', OWNER as never)
      expect(row).toMatchObject({
        pdfRenderStatus: 'FAILED',
        pdfFingerprint: 'fp-X',
        pdfS3Key: null,
      })
      return built
    }

    it('X fails, Y fails to upload, revert to X: the PDF of W is not served', async () => {
      const { svc, row, s3 } = await typstFailsOnX()
      row.content = content('Y')
      row.pdfRenderStatus = 'QUEUED'
      s3.upload.mockRejectedValueOnce(new Error('R2 unavailable'))
      await svc.runRender('r-1', OWNER as never)
      expect(row.pdfRenderError).toBe(encodeResumeMessage('RESUME_RENDER_STORAGE_FAILED'))

      row.content = content('X')
      s3.getObject.mockClear()
      expect(await svc.getRenderedPdf(viewer, OWNER_ID)).toMatchObject({ ready: false })
      expect(s3.getObject).not.toHaveBeenCalledWith(OLD_KEY)
    })

    it('deleting the resume afterwards erases the older PDF and staged copies the row no longer cites', async () => {
      const { svc, objects } = await typstFailsOnX()
      const staged = 'resumes/r-1/staged/run-0.pdf'
      const otherRow = `senior-resumes/${OWNER_ID}/pdf/r-10-0000000000000000.pdf`
      objects.set(staged, Buffer.from('%PDF confirmed earlier'))
      objects.set(otherRow, Buffer.from('%PDF not this row'))
      objects.set('resumes/r-10/staged/run-0.pdf', Buffer.from('%PDF not this row'))
      vi.mocked(markSeniorResumeDirty).mockClear()
      await svc.deleteResume(hr, OWNER_ID)
      expect([...objects.keys()].sort()).toEqual([otherRow, 'resumes/r-10/staged/run-0.pdf'].sort())
      // Senior roles PR 4: the delete drops the resume skills, so the senior is dirty.
      // SR-L-1: the change it reports is "no resume after", which is never an unchanged skill set.
      expect(markSeniorResumeDirty).toHaveBeenCalledWith(expect.anything(), OWNER_ID, {
        before: expect.anything(),
        after: {},
      })
    })

    it('a guarded DELETE that matches no row marks nothing dirty', async () => {
      const { svc, control } = await typstFailsOnX()
      control.deleteMisses = true
      vi.mocked(markSeniorResumeDirty).mockClear()
      await expect(svc.deleteResume(hr, OWNER_ID)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'RESUME_DELETE_BUSY' }),
      })
      expect(markSeniorResumeDirty).not.toHaveBeenCalled()
    })

    it('every listing page is deleted, not only the first', async () => {
      const { svc, s3, objects } = await typstFailsOnX()
      const page2 = `senior-resumes/${OWNER_ID}/pdf/r-1-2222222222222222.pdf`
      objects.set(page2, Buffer.from('%PDF page two'))
      s3.listObjects.mockResolvedValueOnce({
        objects: [{ key: OLD_KEY, sizeBytes: 1, lastModified: new Date(0) }],
        nextContinuationToken: 'page-2',
      })
      await svc.deleteResume(hr, OWNER_ID)
      expect(s3.listObjects).toHaveBeenCalledWith('page-2', `senior-resumes/${OWNER_ID}/pdf/r-1-`)
      expect(objects.has(OLD_KEY)).toBe(false)
      expect(objects.has(page2)).toBe(false)
    })

    it('a non-Error listing failure is logged as unknown', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      const { svc, s3 } = await typstFailsOnX()
      s3.listObjects.mockRejectedValue('boom')
      await svc.deleteResume(hr, OWNER_ID)
      expect(warn).toHaveBeenCalledWith(
        'Resume r-1: could not list resumes/r-1/staged/ for deletion: unknown',
      )
      warn.mockRestore()
    })

    it('a listing failure does not fail the delete: logged, like a failed object delete', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      const { svc, s3, control } = await typstFailsOnX()
      s3.listObjects.mockRejectedValue(new Error('R2 unavailable'))
      expect(await svc.deleteResume(hr, OWNER_ID)).toMatchObject({ resume: null })
      expect(control.gone).toBe(true)
      expect(warn).toHaveBeenCalledWith(
        `Resume r-1: could not list senior-resumes/${OWNER_ID}/pdf/r-1- for deletion: R2 unavailable`,
      )
      expect(warn).toHaveBeenCalledWith(
        'Resume r-1: could not list resumes/r-1/staged/ for deletion: R2 unavailable',
      )
      warn.mockRestore()
    })

    it.each(['QUEUED', 'RUNNING'] as const)(
      'X fails, then the same X is %s again: the PDF of W is not served',
      async (status) => {
        const { svc, row, s3 } = await typstFailsOnX()
        row.pdfRenderStatus = status
        row.pdfRenderStartedAt = new Date()
        s3.getObject.mockClear()
        expect(await svc.getRenderedPdf(viewer, OWNER_ID)).toMatchObject({ ready: false })
        expect(s3.getObject).not.toHaveBeenCalledWith(OLD_KEY)
      },
    )
  })

  it('a FAILED render of the same input reports the failure instead of re-rendering', async () => {
    const { svc, updates } = build({ pdfRenderStatus: 'FAILED', pdfRenderError: 'RESUME_X' })
    expect(await svc.getRenderedPdf(viewer, OWNER_ID)).toEqual({
      ready: false,
      status: 'FAILED',
      message: 'RESUME_X',
    })
    expect(updates).toEqual([])
  })

  it('a stale fingerprint is never served even though its object exists: it is re-queued', async () => {
    const { svc, objects, s3, updates } = build({ pdfFingerprint: 'fp-of-older-content' })
    objects.set(KEY, Buffer.from('%PDF stale'))
    expect(await svc.getRenderedPdf(viewer, OWNER_ID)).toMatchObject({ status: 'QUEUED' })
    expect(s3.getObject).not.toHaveBeenCalled()
    expect(updates[0]).toMatchObject({ pdfRenderStatus: 'QUEUED' })
  })

  it('a row with no stored PDF key is queued without a storage read', async () => {
    const { svc, s3 } = build({ pdfS3Key: null })
    expect(await svc.getRenderedPdf(viewer, OWNER_ID)).toMatchObject({ status: 'QUEUED' })
    expect(s3.getObject).not.toHaveBeenCalled()
  })

  it('a Typst failure of OLDER content does not block a render of the current content', async () => {
    const { svc, updates } = build({
      pdfRenderStatus: 'FAILED',
      pdfRenderError: 'RESUME_X',
      pdfFingerprint: 'fp-of-older-content',
    })
    expect(await svc.getRenderedPdf(viewer, OWNER_ID)).toMatchObject({ status: 'QUEUED' })
    expect(updates[0]).toMatchObject({ pdfRenderStatus: 'QUEUED' })
  })

  it('a present object is served as before, nothing queued', async () => {
    const { svc, objects, updates } = build()
    objects.set(KEY, Buffer.from('%PDF stored'))
    const out = await svc.getRenderedPdf(viewer, OWNER_ID)
    expect((out as { pdfBuffer: Buffer }).pdfBuffer.toString()).toBe('%PDF stored')
    expect(updates).toEqual([])
  })

  it.each([
    ['an outage', Object.assign(new Error('socket hang up'), { name: 'TimeoutError' })],
    [
      'NoSuchBucket (HTTP 404)',
      Object.assign(new Error('The specified bucket does not exist'), {
        name: 'NoSuchBucket',
        $metadata: { httpStatusCode: 404 },
      }),
    ],
  ])('any other storage error (%s) goes on unchanged, nothing queued', async (_name, error) => {
    const { svc, s3, updates } = build()
    s3.getObject.mockRejectedValueOnce(error)
    await expect(svc.getRenderedPdf(viewer, OWNER_ID)).rejects.toBe(error)
    expect(updates).toEqual([])
  })
})
