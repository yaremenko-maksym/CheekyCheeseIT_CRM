import { describe, expect, it, vi } from 'vitest'
import { HttpException } from '@nestjs/common'
import type { Logger } from '@nestjs/common'
import type { DatabaseService } from '../database/database.service'
import type { S3Service } from './s3.service'
import { deleteS3Keys, executeHardDelete, hardDeleteById } from './document-hard-delete.util'

function makeHarness(opts: { row?: unknown; s3Reject?: (key: string) => boolean } = {}) {
  const calls: string[] = []
  const where = vi.fn(async () => {
    calls.push('db.delete')
  })
  const del = vi.fn(() => ({ where }))
  const findFirst = vi.fn(async (_args?: unknown) => opts.row)
  const db = {
    db: { delete: del, query: { documents: { findFirst } } },
  } as unknown as DatabaseService
  const s3 = {
    delete: vi.fn(async (key: string) => {
      calls.push(`s3:${key}`)
      if (opts.s3Reject?.(key)) throw new Error(`boom ${key}`)
    }),
  } as unknown as S3Service
  const logger = { warn: vi.fn() } as unknown as Logger
  return { calls, where, del, findFirst, db, s3, logger }
}

describe('executeHardDelete', () => {
  it('deletes main S3 key, then thumbnail key, then the DB row (in that order)', async () => {
    const h = makeHarness()
    await executeHardDelete(h.db, h.s3, { id: 'd1', s3Key: 'main/k', thumbnailS3Key: 'thumb/k' })
    expect(h.calls).toEqual(['s3:main/k', 's3:thumb/k', 'db.delete'])
    expect(h.s3.delete).toHaveBeenCalledTimes(2)
    expect(h.where).toHaveBeenCalledTimes(1)
  })

  it('skips the thumbnail S3 delete when thumbnailS3Key is null', async () => {
    const h = makeHarness()
    await executeHardDelete(h.db, h.s3, { id: 'd1', s3Key: 'main/k', thumbnailS3Key: null })
    expect(h.calls).toEqual(['s3:main/k', 'db.delete'])
    expect(h.s3.delete).toHaveBeenCalledTimes(1)
  })

  it('does NOT delete the DB row when the S3 delete throws (S3 first)', async () => {
    const h = makeHarness({ s3Reject: () => true })
    await expect(
      executeHardDelete(h.db, h.s3, { id: 'd1', s3Key: 'main/k', thumbnailS3Key: 't' }),
    ).rejects.toThrow('boom main/k')
    expect(h.where).not.toHaveBeenCalled()
    expect(h.s3.delete).toHaveBeenCalledTimes(1)
  })

  it('targets the DB row via delete(documents).where(...)', async () => {
    const h = makeHarness()
    await executeHardDelete(h.db, h.s3, { id: 'd1', s3Key: 'k', thumbnailS3Key: null })
    expect(h.del).toHaveBeenCalledTimes(1)
    expect(h.where).toHaveBeenCalledTimes(1)
  })
})

describe('hardDeleteById', () => {
  it('throws 404 DOCUMENT_NOT_FOUND and touches neither S3 nor the DB when the row is missing', async () => {
    const h = makeHarness({ row: undefined })
    let caught: unknown
    try {
      await hardDeleteById(h.db, h.s3, 'missing')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HttpException)
    expect((caught as HttpException).getStatus()).toBe(404)
    expect(JSON.stringify((caught as HttpException).getResponse())).toContain('DOCUMENT_NOT_FOUND')
    expect(h.s3.delete).not.toHaveBeenCalled()
    expect(h.del).not.toHaveBeenCalled()
  })

  it('looks the row up then deletes S3 keys and the row (no soft-delete requirement)', async () => {
    const h = makeHarness({
      row: { id: 'd9', s3Key: 'm9', thumbnailS3Key: 't9', deletedAt: null },
    })
    await hardDeleteById(h.db, h.s3, 'd9')
    expect(h.findFirst).toHaveBeenCalledTimes(1)
    expect(h.findFirst).toHaveBeenCalledWith({ where: expect.anything() })
    expect(h.calls).toEqual(['s3:m9', 's3:t9', 'db.delete'])
  })
})

describe('deleteS3Keys', () => {
  it('deletes main then thumb with no warnings on success', async () => {
    const h = makeHarness()
    await deleteS3Keys(h.s3, h.logger, 'm', 't')
    expect(h.calls).toEqual(['s3:m', 's3:t'])
    expect(h.logger.warn).not.toHaveBeenCalled()
  })

  it('skips thumb when null/undefined/empty', async () => {
    const h = makeHarness()
    await deleteS3Keys(h.s3, h.logger, 'm', null)
    await deleteS3Keys(h.s3, h.logger, 'm', undefined)
    await deleteS3Keys(h.s3, h.logger, 'm', '')
    expect(h.calls).toEqual(['s3:m', 's3:m', 's3:m'])
  })

  it('swallows a main-key failure with an exact warning and still attempts the thumb', async () => {
    const h = makeHarness({ s3Reject: (k) => k === 'm' })
    await deleteS3Keys(h.s3, h.logger, 'm', 't')
    expect(h.calls).toEqual(['s3:m', 's3:t'])
    expect(h.logger.warn).toHaveBeenCalledTimes(1)
    expect(h.logger.warn).toHaveBeenCalledWith(
      'deleteS3Keys: failed to delete main key="m": boom m',
    )
  })

  it('swallows a thumb-key failure with an exact warning', async () => {
    const h = makeHarness({ s3Reject: (k) => k === 't' })
    await deleteS3Keys(h.s3, h.logger, 'm', 't')
    expect(h.logger.warn).toHaveBeenCalledTimes(1)
    expect(h.logger.warn).toHaveBeenCalledWith(
      'deleteS3Keys: failed to delete thumb key="t": boom t',
    )
  })

  it('warns for both when both fail', async () => {
    const h = makeHarness({ s3Reject: () => true })
    await deleteS3Keys(h.s3, h.logger, 'm', 't')
    expect(h.logger.warn).toHaveBeenCalledTimes(2)
  })
})
