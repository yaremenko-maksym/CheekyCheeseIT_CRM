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

  it('any other read failure is rethrown as it is', async () => {
    const broken = Object.assign(new Error('reach files limit'), { code: 'FST_FILES_LIMIT' })
    const { run } = upload(async function* () {
      yield { type: 'file', fieldname: 'file', toBuffer: () => Promise.reject(broken) }
    })
    await expect(run()).rejects.toBe(broken)
  })

  it('a null rejection is rethrown as it is', async () => {
    const { run } = upload(async function* () {
      yield { type: 'file', fieldname: 'file', toBuffer: () => Promise.reject(null) }
    })
    await expect(run()).rejects.toBeNull()
  })
})
