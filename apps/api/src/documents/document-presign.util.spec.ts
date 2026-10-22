import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { documentAccessLog } from '../database/schema'
import { logDocumentAccess, presignDocument, presignThumbnail } from './document-presign.util'
import { DEFAULT_PRESIGN_TTL_SEC, SENSITIVE_PRESIGN_TTL_SEC } from './s3.service'

const actor = { id: 'actor-1', role: 'ADMIN' } as unknown as SessionUser
const impersonated = { id: 'victim-1', impersonatorId: 'admin-9', role: 'JUNIOR' } as SessionUser
const PRESIGNED = { url: 'https://s3/x', expiresAt: '2030-01-01T00:00:00.000Z' }

function setup(insertImpl?: () => Promise<unknown>) {
  const values = vi.fn(insertImpl ?? (() => Promise.resolve()))
  const insert = vi.fn(() => ({ values }))
  const db = { db: { insert } } as never
  const s3 = { getPresignedDownloadUrl: vi.fn().mockResolvedValue(PRESIGNED) }
  const logger = { warn: vi.fn() }
  return {
    values,
    insert,
    db,
    s3: s3 as never,
    s3Mock: s3,
    logger: logger as never,
    loggerMock: logger,
  }
}

function doc(category: string, over: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    name: 'ascii.pdf',
    originalName: 'ориг.pdf',
    category,
    s3Key: 'k/main',
    thumbnailS3Key: 'k/thumb',
    ...over,
  } as never
}

describe('logDocumentAccess', () => {
  it.each(['CONTRACT', 'RECEIPT', 'INVOICE', 'RESUME', 'SCAN'] as const)(
    'writes a row for sensitive %s',
    async (category) => {
      const t = setup()
      await logDocumentAccess(t.db, t.logger, actor, 'doc-1', category, 'DOWNLOAD')
      expect(t.insert).toHaveBeenCalledWith(documentAccessLog)
      expect(t.values).toHaveBeenCalledWith({
        actorId: 'actor-1',
        targetId: 'doc-1',
        action: 'DOWNLOAD',
        metadata: { category },
      })
    },
  )

  it.each(['AVATAR', 'LOGO'] as const)('does not log non-sensitive %s', async (category) => {
    const t = setup()
    await logDocumentAccess(t.db, t.logger, actor, 'doc-1', category, 'PREVIEW')
    expect(t.insert).not.toHaveBeenCalled()
  })

  it('attributes to the real human under impersonation', async () => {
    const t = setup()
    await logDocumentAccess(t.db, t.logger, impersonated, 'doc-1', 'SCAN', 'THUMBNAIL')
    expect(t.values).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'admin-9', action: 'THUMBNAIL' }),
    )
  })

  it('swallows a DB error and warns with the exact message', async () => {
    const t = setup(() => Promise.reject(new Error('db down')))
    await expect(
      logDocumentAccess(t.db, t.logger, actor, 'doc-1', 'CONTRACT', 'DOWNLOAD'),
    ).resolves.toBeUndefined()
    expect(t.loggerMock.warn).toHaveBeenCalledTimes(1)
    expect(t.loggerMock.warn).toHaveBeenCalledWith(
      'logAccess: failed to write access-log row for docId=doc-1: db down',
    )
  })
})

describe('presignDocument', () => {
  it('DOWNLOAD: sensitive category -> 30 min TTL, attachment, original name, category flows', async () => {
    const t = setup()
    const r = await presignDocument(t.s3, t.db, t.logger, actor, doc('CONTRACT'), 'DOWNLOAD')
    expect(r).toBe(PRESIGNED)
    expect(t.s3Mock.getPresignedDownloadUrl).toHaveBeenCalledWith(
      'k/main',
      SENSITIVE_PRESIGN_TTL_SEC,
      'ориг.pdf',
      'attachment',
      'CONTRACT',
    )
    expect(t.values).toHaveBeenCalledWith(expect.objectContaining({ action: 'DOWNLOAD' }))
  })

  it('PREVIEW: non-sensitive category -> default TTL, inline, no access log', async () => {
    const t = setup()
    await presignDocument(t.s3, t.db, t.logger, actor, doc('AVATAR'), 'PREVIEW')
    expect(t.s3Mock.getPresignedDownloadUrl).toHaveBeenCalledWith(
      'k/main',
      DEFAULT_PRESIGN_TTL_SEC,
      'ориг.pdf',
      'inline',
      'AVATAR',
    )
    expect(t.insert).not.toHaveBeenCalled()
  })

  it('falls back to name when originalName is null', async () => {
    const t = setup()
    await presignDocument(
      t.s3,
      t.db,
      t.logger,
      actor,
      doc('LOGO', { originalName: null }),
      'PREVIEW',
    )
    expect(t.s3Mock.getPresignedDownloadUrl.mock.calls[0]?.[2]).toBe('ascii.pdf')
  })

  it('logs access BEFORE presigning (order preserved)', async () => {
    const order: string[] = []
    const t = setup(() => {
      order.push('log')
      return Promise.resolve()
    })
    t.s3Mock.getPresignedDownloadUrl.mockImplementation(() => {
      order.push('presign')
      return Promise.resolve(PRESIGNED)
    })
    await presignDocument(t.s3, t.db, t.logger, actor, doc('RESUME'), 'PREVIEW')
    expect(order).toEqual(['log', 'presign'])
  })

  it('still presigns when the access-log write fails', async () => {
    const t = setup(() => Promise.reject(new Error('boom')))
    const r = await presignDocument(t.s3, t.db, t.logger, actor, doc('SCAN'), 'DOWNLOAD')
    expect(r).toBe(PRESIGNED)
  })
})

describe('presignThumbnail', () => {
  it('returns null and does nothing when no thumbnail exists', async () => {
    const t = setup()
    const r = await presignThumbnail(
      t.s3,
      t.db,
      t.logger,
      actor,
      doc('SCAN', { thumbnailS3Key: null }),
    )
    expect(r).toBeNull()
    expect(t.s3Mock.getPresignedDownloadUrl).not.toHaveBeenCalled()
    expect(t.insert).not.toHaveBeenCalled()
  })

  it('inherits the main document category: sensitive -> 30 min TTL, inline, no downloadAs, logged THUMBNAIL', async () => {
    const t = setup()
    const r = await presignThumbnail(t.s3, t.db, t.logger, actor, doc('RESUME'))
    expect(r).toBe(PRESIGNED)
    expect(t.s3Mock.getPresignedDownloadUrl).toHaveBeenCalledWith(
      'k/thumb',
      SENSITIVE_PRESIGN_TTL_SEC,
      undefined,
      'inline',
      'RESUME',
    )
    expect(t.values).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'THUMBNAIL', metadata: { category: 'RESUME' } }),
    )
  })

  it('non-sensitive category -> default TTL and not logged', async () => {
    const t = setup()
    await presignThumbnail(t.s3, t.db, t.logger, actor, doc('AVATAR'))
    expect(t.s3Mock.getPresignedDownloadUrl).toHaveBeenCalledWith(
      'k/thumb',
      DEFAULT_PRESIGN_TTL_SEC,
      undefined,
      'inline',
      'AVATAR',
    )
    expect(t.insert).not.toHaveBeenCalled()
  })
})
