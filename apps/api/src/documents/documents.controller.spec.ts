import { describe, expect, it, vi } from 'vitest'
import { DOCUMENT_MAX_BYTES, type SessionUser } from '@crm/shared'
import { DocumentsController } from './documents.controller'

const user = { id: 'u1', role: 'ADMIN' } as unknown as SessionUser

function upload(parts: () => AsyncGenerator<unknown>) {
  const service = { upload: vi.fn(async (..._args: unknown[]) => ({ id: 'd1' })) }
  const req = { isMultipart: () => true, parts: vi.fn(parts) }
  const controller = new DocumentsController(service as never, {} as never)
  return { service, req, run: () => controller.upload(req as never, user) }
}

const tooLarge = () =>
  Object.assign(new Error('request file too large'), {
    code: 'FST_REQ_FILE_TOO_LARGE',
    statusCode: 413,
  })

// Backlog 450: the documents upload owns its size limit and answers it with its own coded 413.
describe('DocumentsController.upload — multipart limits', () => {
  it('passes the per-route fileSize limit DOCUMENT_MAX_BYTES (10 MB) to req.parts', async () => {
    const { service, req, run } = upload(async function* () {
      yield { type: 'field', fieldname: 'category', value: 'SCAN' }
      yield { type: 'file', fieldname: 'file', toBuffer: () => Promise.resolve(Buffer.from('x')) }
    })
    await run()
    expect(req.parts).toHaveBeenCalledWith({ limits: { fileSize: DOCUMENT_MAX_BYTES } })
    expect(service.upload).toHaveBeenCalledTimes(1)
    expect(DOCUMENT_MAX_BYTES).toBe(10 * 1024 * 1024)
  })

  it('toBuffer rejecting with FST_REQ_FILE_TOO_LARGE is 413 DOCUMENT_TOO_LARGE with its MB cap', async () => {
    const { service, run } = upload(async function* () {
      yield { type: 'file', fieldname: 'file', toBuffer: () => Promise.reject(tooLarge()) }
    })
    await expect(run()).rejects.toMatchObject({
      status: 413,
      response: { code: 'DOCUMENT_TOO_LARGE', params: { maxMb: 10 } },
    })
    expect(service.upload).not.toHaveBeenCalled()
  })

  it('the iterator rejecting with FST_REQ_FILE_TOO_LARGE is the same coded 413', async () => {
    const { run } = upload(async function* () {
      yield { type: 'field', fieldname: 'category', value: 'OTHER' }
      throw tooLarge()
    })
    await expect(run()).rejects.toMatchObject({
      status: 413,
      response: { code: 'DOCUMENT_TOO_LARGE', params: { maxMb: 10 } },
    })
  })

  it.each(['FST_FILES_LIMIT', 'FST_PARTS_LIMIT'])(
    'the iterator rejecting with %s is 413 DOCUMENT_UPLOAD_TOO_MANY_PARTS',
    async (code) => {
      const { service, run } = upload(async function* () {
        yield { type: 'field', fieldname: 'category', value: 'SCAN' }
        throw Object.assign(new Error('reach limit'), { code, statusCode: 413 })
      })
      const err = await run().catch((e: unknown) => e)
      expect(err).toMatchObject({
        status: 413,
        response: { code: 'DOCUMENT_UPLOAD_TOO_MANY_PARTS' },
      })
      expect((err as { response: { params?: unknown } }).response.params).toBeUndefined()
      expect(service.upload).not.toHaveBeenCalled()
    },
  )

  it('any other read failure is rethrown as it is', async () => {
    const broken = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    const { run } = upload(async function* () {
      yield { type: 'file', fieldname: 'file', toBuffer: () => Promise.reject(broken) }
    })
    await expect(run()).rejects.toBe(broken)
  })

  it('a file part without toBuffer rejects as it is', async () => {
    const { run } = upload(async function* () {
      yield { type: 'file', fieldname: 'file' }
    })
    await expect(run()).rejects.toThrow('Multipart file has no toBuffer()')
  })

  it('a null rejection is rethrown as it is', async () => {
    const { run } = upload(async function* () {
      yield { type: 'file', fieldname: 'file', toBuffer: () => Promise.reject(null) }
    })
    await expect(run()).rejects.toBeNull()
  })
})

describe('DocumentsController.upload — part collection', () => {
  const buf = (s: string) => () => Promise.resolve(Buffer.from(s))

  it('takes the first `file` part, defaults its mimetype/name, and reads only string fields', async () => {
    const { service, run } = upload(async function* () {
      yield { type: 'file', fieldname: 'other', toBuffer: buf('ignored-field') }
      yield { type: 'field', fieldname: 'file', value: 'not-a-file' }
      yield { type: 'file', fieldname: 'name', value: 'from-a-file-part', toBuffer: buf('n') }
      yield { type: 'field', fieldname: 'category', value: 'SCAN' }
      yield { type: 'field', fieldname: 'name', value: 42 }
      yield { type: 'file', fieldname: 'file', toBuffer: buf('first') }
      yield { type: 'file', fieldname: 'file', toBuffer: buf('second') }
    })
    await run()
    expect(service.upload).toHaveBeenCalledWith(
      user,
      {
        buffer: Buffer.from('first'),
        mimetype: 'application/octet-stream',
        originalname: 'upload',
      },
      { category: 'SCAN', projectId: undefined, ownerId: undefined, name: undefined },
    )
  })

  // Backlog 450 fix 1: req.parts() waits for each file stream, so an unread skipped file hangs the request.
  it('drains every skipped file part and stores the real file', async () => {
    const skippedOther = { resume: vi.fn() }
    const skippedSecond = { resume: vi.fn() }
    const real = { resume: vi.fn() }
    const { service, run } = upload(async function* () {
      yield { type: 'field', fieldname: 'category', value: 'SCAN' }
      yield { type: 'file', fieldname: 'other', file: skippedOther, toBuffer: buf('x') }
      yield { type: 'file', fieldname: 'file', file: real, toBuffer: buf('real') }
      yield { type: 'file', fieldname: 'file', file: skippedSecond, toBuffer: buf('y') }
    })
    await run()
    expect(skippedOther.resume).toHaveBeenCalledTimes(1)
    expect(skippedSecond.resume).toHaveBeenCalledTimes(1)
    expect(real.resume).not.toHaveBeenCalled()
    expect(service.upload).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ buffer: Buffer.from('real') }),
      expect.anything(),
    )
  })

  it('keeps the declared mimetype, filename and the name field', async () => {
    const { service, run } = upload(async function* () {
      yield { type: 'field', fieldname: 'category', value: 'SCAN' }
      yield { type: 'field', fieldname: 'name', value: 'Passport' }
      yield {
        type: 'file',
        fieldname: 'file',
        mimetype: 'application/pdf',
        filename: 'p.pdf',
        toBuffer: buf('pdf'),
      }
    })
    await run()
    expect(service.upload).toHaveBeenCalledWith(
      user,
      { buffer: Buffer.from('pdf'), mimetype: 'application/pdf', originalname: 'p.pdf' },
      expect.objectContaining({ category: 'SCAN', name: 'Passport' }),
    )
  })

  it('no `file` part is 400 DOCUMENT_FILE_FIELD_MISSING', async () => {
    const { run } = upload(async function* () {
      yield { type: 'field', fieldname: 'category', value: 'SCAN' }
    })
    await expect(run()).rejects.toMatchObject({
      status: 400,
      response: { code: 'DOCUMENT_FILE_FIELD_MISSING' },
    })
  })
})
