/**
 * Filename reduction on both directions of travel.
 *
 * A resume filename crosses this module twice: INWARD as the uploaded file's
 * name (`sanitizeFileName`, stored and later echoed in a presigned download)
 * and OUTWARD as the rendered PDF's name, built from the user's display name
 * (`resumeContentDisposition`). Those were two different reductions — the
 * inward one dropped path separators and capped the length, the outward one
 * only stripped quotes and newlines — so the very same string was defused going
 * in and passed through intact coming out. Now there is one definition, and
 * these tests hold both ends to it.
 *
 * The Task 15 routes are thin: they parse the body, pass the viewer through, and the staged PDF
 * goes out as a PDF attachment named by `resumeContentDisposition`.
 */
import { describe, expect, it, vi } from 'vitest'
import { RESUME_SOURCE_MAX_BYTES, type SessionUser } from '@crm/shared'
import {
  pendingPdfBody,
  resumeContentDisposition,
  SeniorResumesController,
} from './resumes.controller'
import { sanitizeFileName } from './resumes.service'

describe('sanitizeFileName', () => {
  it('keeps an ordinary name, Cyrillic included', () => {
    expect(sanitizeFileName('резюме-иванова.pdf')).toBe('резюме-иванова.pdf')
  })

  it.each([
    ['../../etc/passwd.pdf', 'passwd.pdf'],
    ['..\\..\\windows\\system32\\config.pdf', 'config.pdf'],
    ['/absolute/path/cv.docx', 'cv.docx'],
  ])('reduces %s to its bare filename', (raw, expected) => {
    expect(sanitizeFileName(raw)).toBe(expected)
  })

  it('drops control characters', () => {
    const withControls = `cv${String.fromCharCode(0x00)}${String.fromCharCode(0x0d)}.pdf`
    expect(sanitizeFileName(withControls)).toBe('cv.pdf')
  })

  it('caps the length', () => {
    expect(sanitizeFileName(`${'x'.repeat(500)}.pdf`)).toHaveLength(180)
  })

  it('falls back to a name rather than returning nothing', () => {
    expect(sanitizeFileName('')).toBe('resume')
    expect(sanitizeFileName('   ')).toBe('resume')
    expect(sanitizeFileName('/')).toBe('resume')
  })
})

describe('resumeContentDisposition', () => {
  it('carries the real Cyrillic name in the UTF-8 slot and an ASCII fallback', () => {
    const header = resumeContentDisposition('Иван Петров', 'uk')
    expect(header).toMatch(/^attachment; filename="[^"]*\.pdf"; filename\*=UTF-8''/)
    expect(decodeURIComponent(header.split("UTF-8''")[1] ?? '')).toBe('Резюме — Иван Петров.pdf')
  })

  // Backlog 451: the file word follows the viewer's locale; the ASCII slot stays ASCII in both.
  it.each([
    ['uk', 'Резюме — Jane Doe.pdf'],
    ['en', 'Resume — Jane Doe.pdf'],
  ] as const)('names the download by the %s locale', (locale, name) => {
    const header = resumeContentDisposition('Jane Doe', locale)
    expect(header).toBe(
      `attachment; filename="Jane Doe.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
    )
    expect(header.split('"')[1]).toMatch(/^[\x20-\x7E]+$/)
  })

  /**
   * MUTATION: point this back at its own inline `replace(/["\\\r\n]/g, '')` —
   * this goes red, because `../../etc/passwd.pdf` reaches the header untouched
   * while the identical string is defused on the upload path.
   */
  it('applies the SAME reduction as the upload path to a path-shaped display name', () => {
    const header = resumeContentDisposition('../../etc/passwd.pdf', 'uk')
    expect(header).not.toContain('..')
    expect(header).not.toContain('/etc/')
    expect(header).toContain('passwd.pdf')
  })

  /**
   * The order of the two steps matters. Stripping the backslash FIRST removed
   * the very character `sanitizeFileName` uses to find the last path segment,
   * so a Windows-shaped name collapsed into one run of text instead of
   * reducing to its bare filename the way the upload path does.
   *
   * MUTATION: swap the order back (`sanitizeFileName(name.replace(/["\\]/g, ''))`)
   * and this goes red.
   */
  it('reduces a WINDOWS path the same way the upload path does', () => {
    const header = resumeContentDisposition('..\\..\\windows\\system32\\config.pdf', 'uk')
    expect(header).toContain('config.pdf')
    expect(header).not.toContain('windows')
    expect(header).not.toContain('system32')
  })

  it('cannot break out of the quoted ASCII parameter', () => {
    const header = resumeContentDisposition('evil" ; attachment; filename="pwned', 'uk')
    // Exactly one quoted filename parameter, and no stray quote inside it.
    const ascii = /filename="([^"]*)"/.exec(header)?.[1] ?? ''
    expect(ascii).not.toContain('"')
    expect(header.match(/filename="/g)).toHaveLength(1)
  })

  it('never emits a raw newline (header splitting)', () => {
    const header = resumeContentDisposition('Иван\r\nX-Injected: 1', 'uk')
    expect(header).not.toMatch(/[\r\n]/)
  })

  it('falls back for a display name that reduces to nothing', () => {
    expect(resumeContentDisposition('   ', 'uk')).toContain('resume.pdf')
  })
})

describe('SeniorResumesController — Task 15 routes', () => {
  const USER = 'a15e0000-0000-4000-8000-0000000000a1'
  const RUN = 'a15e0000-0000-4000-8000-000000000001'
  const viewer = { id: 'v', email: 'v@unit.spec', role: 'HR' } as SessionUser
  const service = {
    confirm: vi.fn(async (..._args: unknown[]) => 'confirmed'),
    editStagedField: vi.fn(async (..._args: unknown[]) => 'edited'),
    regenerateStagedField: vi.fn(async (..._args: unknown[]) => 'regenerated'),
    getStagedPdf: vi.fn(async (..._args: unknown[]) => ({
      pdfBuffer: Buffer.from('%PDF'),
      displayName: 'Jane Doe',
    })),
  }
  const controller = new SeniorResumesController(service as never)

  it('confirm, edit and regenerate parse the body and pass the viewer through', async () => {
    await expect(controller.confirm(USER, { runId: RUN, version: 3 }, viewer)).resolves.toBe(
      'confirmed',
    )
    expect(service.confirm).toHaveBeenCalledWith(viewer, USER, { runId: RUN, version: 3 })
    const edit = { runId: RUN, path: 'summary', text: 'New.' }
    await expect(controller.editStaged(USER, edit, viewer)).resolves.toBe('edited')
    expect(service.editStagedField).toHaveBeenCalledWith(viewer, USER, edit)
    const regen = { runId: RUN, path: 'summary' }
    await expect(controller.regenerateStaged(USER, regen, viewer)).resolves.toBe('regenerated')
    expect(service.regenerateStagedField).toHaveBeenCalledWith(viewer, USER, regen)
    expect(() => controller.confirm(USER, { runId: 'nope', version: 3 }, viewer)).toThrow()
  })

  it('staged-pdf is sent as a PDF attachment under the owner name', async () => {
    const headers: Record<string, string> = {}
    const reply = {
      header(name: string, value: string) {
        headers[name] = value
        return reply
      },
      send: vi.fn(async (_body: Buffer) => undefined),
    }
    await controller.getStagedPdf(USER, viewer, reply as never, 'en')
    expect(service.getStagedPdf).toHaveBeenCalledWith(viewer, USER)
    expect(headers).toEqual({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="Jane Doe.pdf"; filename*=UTF-8''Resume%20%E2%80%94%20Jane%20Doe.pdf`,
    })
    expect(reply.send.mock.calls[0]?.[0]?.toString()).toBe('%PDF')
  })

  it('the live pdf is named by the request locale too (backlog 451)', async () => {
    const headers: Record<string, string> = {}
    const reply = {
      header(name: string, value: string) {
        headers[name] = value
        return reply
      },
      send: vi.fn(async (_body: Buffer) => undefined),
    }
    const live = {
      getRenderedPdf: vi.fn(async () => ({
        ready: true,
        pdfBuffer: Buffer.from('%PDF'),
        displayName: 'Jane Doe',
      })),
    }
    await new SeniorResumesController(live as never).getPdf(USER, viewer, reply as never, 'uk')
    expect(headers['Content-Disposition']).toBe(
      `attachment; filename="Jane Doe.pdf"; filename*=UTF-8''%D0%A0%D0%B5%D0%B7%D1%8E%D0%BC%D0%B5%20%E2%80%94%20Jane%20Doe.pdf`,
    )
  })
})

/**
 * SR-L-4. `uploadSource` used to drain the whole multipart body before the service said 403, so a
 * caller with no write right (a SENIOR on their own resume, a JUNIOR) could stream up to the size
 * limit for nothing. The write check now runs before the body is touched; the service keeps its own.
 *
 * MUTATION: move the `canAccessResume(..., 'write')` check below the `req.parts()` loop — the SENIOR
 * and JUNIOR cases go red, because the reader spy is called.
 */
describe('uploadSource refuses a caller without write rights BEFORE reading the body (SR-L-4)', () => {
  const OWNER = 'a15e0000-0000-4000-8000-0000000000b2'
  const filePart = {
    type: 'file' as const,
    fieldname: 'file',
    mimetype: 'application/pdf',
    filename: 'cv.pdf',
    toBuffer: async () => Buffer.from('%PDF-1.4 x'),
  }
  const setup = () => {
    const service = { uploadSource: vi.fn(async (..._args: unknown[]) => 'queued') }
    const parts = vi.fn(async function* () {
      yield filePart
    })
    const isMultipart = vi.fn(() => true)
    const req = { isMultipart, parts }
    return {
      service,
      parts,
      isMultipart,
      req,
      controller: new SeniorResumesController(service as never),
    }
  }

  it.each([
    ['a SENIOR on their own resume', { id: OWNER, email: 's@unit.spec', role: 'SENIOR' }],
    [
      'a JUNIOR',
      { id: 'a15e0000-0000-4000-8000-0000000000c3', email: 'j@unit.spec', role: 'JUNIOR' },
    ],
  ])('%s gets 403 and the multipart reader is never called', async (_name, user) => {
    const { service, parts, isMultipart, req, controller } = setup()
    await expect(
      controller.uploadSource(OWNER, req as never, user as SessionUser),
    ).rejects.toMatchObject({ status: 403, response: { code: 'RESUME_NO_ACCESS' } })
    expect(parts).not.toHaveBeenCalled()
    expect(isMultipart).not.toHaveBeenCalled()
    expect(service.uploadSource).not.toHaveBeenCalled()
  })

  it('an HR reads the file and hands it to the service, which keeps its own check', async () => {
    const { service, parts, req, controller } = setup()
    const hr = { id: 'h', email: 'h@unit.spec', role: 'HR' } as SessionUser
    await expect(controller.uploadSource(OWNER, req as never, hr)).resolves.toBe('queued')
    expect(parts).toHaveBeenCalledOnce()
    expect(parts).toHaveBeenCalledWith({
      limits: { fileSize: RESUME_SOURCE_MAX_BYTES, files: 1 },
    })
    expect(service.uploadSource).toHaveBeenCalledWith(hr, OWNER, {
      buffer: Buffer.from('%PDF-1.4 x'),
      mimetype: 'application/pdf',
      originalname: 'cv.pdf',
    })
  })
})

describe('look writes on VERIFIED start a model run: throttled like the other run starts (CD-5)', () => {
  it.each(['updateLayout', 'updateTemplate'] as const)(
    '%s is throttled at 10 per minute',
    (name) => {
      const handler = SeniorResumesController.prototype[name]
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(10)
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000)
    },
  )
})

describe('pendingPdfBody — the 202 body while the PDF is not ready (backlog 443)', () => {
  it('a row with no render error says the PDF is being prepared, by code', () => {
    expect(pendingPdfBody('QUEUED', null)).toEqual({
      status: 'QUEUED',
      code: 'RESUME_PDF_PREPARING',
      message:
        'The PDF is being built from the resume template. Refresh the page in a few seconds.',
    })
  })

  it('a stored code carries its params and the English fallback', () => {
    expect(
      pendingPdfBody('FAILED', '{"code":"RESUME_RENDER_TIMEOUT","params":{"seconds":20}}'),
    ).toEqual({
      status: 'FAILED',
      code: 'RESUME_RENDER_TIMEOUT',
      params: { seconds: 20 },
      message: 'The PDF could not be built: the layout did not finish within 20 s.',
    })
  })

  it('a legacy free-text error passes through verbatim, with no code', () => {
    expect(pendingPdfBody('FAILED', 'Не удалось собрать PDF резюме.')).toEqual({
      status: 'FAILED',
      message: 'Не удалось собрать PDF резюме.',
    })
  })

  it('a stored code this build cannot render falls back to the details-unavailable line', () => {
    const generic = {
      status: 'FAILED',
      code: 'RESUME_ERROR_DETAILS_UNAVAILABLE',
      message: 'No details are available for this error.',
    }
    expect(pendingPdfBody('FAILED', '{"code":"RESUME_FROM_THE_FUTURE"}')).toEqual(generic)
    expect(pendingPdfBody('FAILED', '{"code":"RESUME_RENDER_TIMEOUT"}')).toEqual(generic)
  })
})

describe('uploadSource refuses a malformed upload by code (backlog 443)', () => {
  const OWNER = 'a15e0000-0000-4000-8000-0000000000b2'
  const hr = { id: 'a15e0000-0000-4000-8000-0000000000c4', email: 'hr@unit.spec', role: 'HR' }
  const upload = (parts: unknown[], multipart = true) => {
    const service = { uploadSource: vi.fn(async (..._args: unknown[]) => 'queued') }
    const partsSpy = vi.fn(async function* () {
      yield* parts
    })
    const req = {
      isMultipart: () => multipart,
      parts: partsSpy,
    }
    const controller = new SeniorResumesController(service as never)
    return {
      service,
      parts: partsSpy,
      run: () => controller.uploadSource(OWNER, req as never, hr as SessionUser),
    }
  }

  it('a body that is not multipart is 400 RESUME_UPLOAD_NOT_MULTIPART', async () => {
    await expect(upload([], false).run()).rejects.toMatchObject({
      status: 400,
      response: { code: 'RESUME_UPLOAD_NOT_MULTIPART' },
    })
  })

  it('a file part that cannot be read is 400 RESUME_UPLOAD_UNREADABLE', async () => {
    const { service, run } = upload([{ type: 'file', fieldname: 'file' }])
    await expect(run()).rejects.toMatchObject({
      status: 400,
      response: { code: 'RESUME_UPLOAD_UNREADABLE' },
    })
    expect(service.uploadSource).not.toHaveBeenCalled()
  })

  it('a file part under another field name is skipped, so no resume file is 400 RESUME_UPLOAD_NO_FILE', async () => {
    const { service, run } = upload([
      { type: 'file', fieldname: 'avatar', toBuffer: () => Promise.resolve(Buffer.from('x')) },
    ])
    await expect(run()).rejects.toMatchObject({
      status: 400,
      response: { code: 'RESUME_UPLOAD_NO_FILE' },
    })
    expect(service.uploadSource).not.toHaveBeenCalled()
  })

  it('a text field named "file" is skipped, not read as the file (NO_FILE, not UNREADABLE)', async () => {
    const { service, run } = upload([{ type: 'field', fieldname: 'file' }])
    await expect(run()).rejects.toMatchObject({
      status: 400,
      response: { code: 'RESUME_UPLOAD_NO_FILE' },
    })
    expect(service.uploadSource).not.toHaveBeenCalled()
  })

  // Backlog 450 fix 1: req.parts() waits for each file stream, so an unread skipped file hangs the request.
  it('drains every skipped file part and stores the real file', async () => {
    const skippedOther = { resume: vi.fn() }
    const skippedSecond = { resume: vi.fn() }
    const real = { resume: vi.fn() }
    const { service, run } = upload([
      { type: 'field', fieldname: 'note' },
      {
        type: 'file',
        fieldname: 'other',
        file: skippedOther,
        toBuffer: () => Promise.resolve(Buffer.from('x')),
      },
      {
        type: 'file',
        fieldname: 'file',
        file: real,
        toBuffer: () => Promise.resolve(Buffer.from('real')),
      },
      {
        type: 'file',
        fieldname: 'file',
        file: skippedSecond,
        toBuffer: () => Promise.resolve(Buffer.from('y')),
      },
    ])
    await run()
    expect(skippedOther.resume).toHaveBeenCalledTimes(1)
    expect(skippedSecond.resume).toHaveBeenCalledTimes(1)
    expect(real.resume).not.toHaveBeenCalled()
    expect(service.uploadSource).toHaveBeenCalledWith(
      hr,
      OWNER,
      expect.objectContaining({ buffer: Buffer.from('real') }),
    )
  })

  it('a second file part is ignored: the first file wins', async () => {
    const { service, run } = upload([
      { type: 'file', fieldname: 'file', toBuffer: () => Promise.resolve(Buffer.from('first')) },
      { type: 'file', fieldname: 'file', toBuffer: () => Promise.resolve(Buffer.from('second')) },
    ])
    await run()
    expect(service.uploadSource).toHaveBeenCalledWith(
      hr,
      OWNER,
      expect.objectContaining({ buffer: Buffer.from('first') }),
    )
  })

  it('a file with no mimetype or filename gets application/octet-stream and "resume"', async () => {
    const { service, run } = upload([
      { type: 'file', fieldname: 'file', toBuffer: () => Promise.resolve(Buffer.from('x')) },
    ])
    await run()
    expect(service.uploadSource).toHaveBeenCalledWith(hr, OWNER, {
      buffer: Buffer.from('x'),
      mimetype: 'application/octet-stream',
      originalname: 'resume',
    })
  })

  // QA-LOW-4: @fastify/multipart's toBuffer throws FST_REQ_FILE_TOO_LARGE (413, no code) past the 10 MB limit.
  it('a file over the multipart size limit is 413 RESUME_FILE_TOO_LARGE with its MB cap', async () => {
    const tooLarge = Object.assign(new Error('request file too large'), {
      code: 'FST_REQ_FILE_TOO_LARGE',
      statusCode: 413,
    })
    const { service, run } = upload([
      { type: 'file', fieldname: 'file', toBuffer: () => Promise.reject(tooLarge) },
    ])
    await expect(run()).rejects.toMatchObject({
      status: 413,
      response: { code: 'RESUME_FILE_TOO_LARGE', params: { mb: 10 } },
    })
    expect(service.uploadSource).not.toHaveBeenCalled()
  })

  // Round 4: the iterator can reject too (an oversize part skipped while reading the stream).
  it('the multipart iterator rejecting with FST_REQ_FILE_TOO_LARGE is the same coded 413', async () => {
    const tooLarge = Object.assign(new Error('request file too large'), {
      code: 'FST_REQ_FILE_TOO_LARGE',
      statusCode: 413,
    })
    const service = { uploadSource: vi.fn(async (..._args: unknown[]) => 'queued') }
    const req = {
      isMultipart: () => true,
      parts: vi.fn(async function* () {
        yield {
          type: 'file',
          fieldname: 'skipped',
          toBuffer: () => Promise.resolve(Buffer.alloc(0)),
        }
        throw tooLarge
      }),
    }
    const controller = new SeniorResumesController(service as never)
    await expect(
      controller.uploadSource(OWNER, req as never, hr as SessionUser),
    ).rejects.toMatchObject({
      status: 413,
      response: { code: 'RESUME_FILE_TOO_LARGE', params: { mb: 10 } },
    })
    expect(service.uploadSource).not.toHaveBeenCalled()
  })

  // Backlog 450: a second file part / too many parts is the plugin's own 413 with no code.
  it.each(['FST_FILES_LIMIT', 'FST_PARTS_LIMIT'])(
    'the multipart iterator rejecting with %s is 413 RESUME_UPLOAD_TOO_MANY_PARTS',
    async (code) => {
      const limit = Object.assign(new Error('reach limit'), { code, statusCode: 413 })
      const service = { uploadSource: vi.fn(async (..._args: unknown[]) => 'queued') }
      const req = {
        isMultipart: () => true,
        parts: vi.fn(async function* () {
          yield { type: 'field', fieldname: 'x' }
          throw limit
        }),
      }
      const controller = new SeniorResumesController(service as never)
      const err = await controller
        .uploadSource(OWNER, req as never, hr as SessionUser)
        .catch((e: unknown) => e)
      expect(err).toMatchObject({
        status: 413,
        response: { code: 'RESUME_UPLOAD_TOO_MANY_PARTS' },
      })
      expect((err as { response: { params?: unknown } }).response.params).toBeUndefined()
      expect(service.uploadSource).not.toHaveBeenCalled()
    },
  )

  it('any other read failure of the file part is rethrown as it is', async () => {
    const broken = new Error('socket hang up')
    const { run } = upload([
      { type: 'file', fieldname: 'file', toBuffer: () => Promise.reject(broken) },
    ])
    await expect(run()).rejects.toBe(broken)
  })

  it('a non-object rejection is rethrown as it is, not turned into a TypeError', async () => {
    const { run } = upload([
      { type: 'file', fieldname: 'file', toBuffer: () => Promise.reject(null) },
    ])
    await expect(run()).rejects.toBeNull()
  })

  it('a body without a "file" field is 400 RESUME_UPLOAD_NO_FILE', async () => {
    const { service, run } = upload([{ type: 'field', fieldname: 'note' }])
    await expect(run()).rejects.toMatchObject({
      status: 400,
      response: { code: 'RESUME_UPLOAD_NO_FILE' },
    })
    expect(service.uploadSource).not.toHaveBeenCalled()
  })

  it('passes RESUME_SOURCE_MAX_BYTES and single-file limit to req.parts (finding 1)', async () => {
    const { parts, run } = upload([
      { type: 'file', fieldname: 'file', toBuffer: async () => Buffer.from('%PDF') },
    ])
    await run()
    expect(parts).toHaveBeenCalledWith({
      limits: { fileSize: RESUME_SOURCE_MAX_BYTES, files: 1 },
    })
  })
})
