import { GoneException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'

import type { DatabaseService } from '../../../database/database.service'
import {
  meetingRecorderAuditLog,
  recordingMediaArtifacts,
  recordingMediaUploads,
} from '../../../database/schema'
import { RecordingMediaPurgeService } from './recording-media-purge.service'

const artifact = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  connectionId: '11111111-1111-4111-8111-111111111111',
  externalRecordingId: 'recording_22222222-2222-4222-8222-222222222222',
  storageKey:
    'meeting-recordings/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/current',
}
const recordingId = '33333333-3333-4333-8333-333333333333'

function cleanupFixture(
  attempts: Array<{
    id: string
    storageKey: string
    storageUploadId: string
    status: string
    updatedAt: Date
  }>,
) {
  const where = vi.fn().mockResolvedValue(attempts)
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({ where }),
  })
  const updates: Array<{ table: unknown; values: unknown }> = []
  const update = vi.fn((table: unknown) => ({
    set: (values: unknown) => {
      updates.push({ table, values })
      return {
        where: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockResolvedValue(table === recordingMediaArtifacts ? [{ id: artifact.id }] : []),
        }),
      }
    },
  }))
  const auditValues = vi.fn().mockResolvedValue(undefined)
  const insert = vi.fn((table: unknown) => {
    expect(table).toBe(meetingRecorderAuditLog)
    return { values: auditValues }
  })
  const tx = { update, insert }
  const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) =>
    callback(tx),
  )
  const db = { db: { select, transaction } } as unknown as DatabaseService
  const storage = {
    abort: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  }
  return { db, storage, updates, auditValues, transaction }
}

describe('recording media purge', () => {
  it('SR-M-2: deletes every owned attempt key idempotently and audits the durable transition', async () => {
    const attemptKey = `${artifact.storageKey}-old`
    const ctx = cleanupFixture([
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        storageKey: attemptKey,
        storageUploadId: 'provider-upload',
        status: 'uploading',
        updatedAt: new Date('2026-10-24T10:00:00.000Z'),
      },
    ])
    const service = new RecordingMediaPurgeService(ctx.db, ctx.storage as never)

    await expect(
      service.cleanupArtifact(artifact, recordingId, new Date('2026-10-24T12:10:00.000Z')),
    ).resolves.toBe(true)

    expect(ctx.storage.abort).toHaveBeenCalledWith(attemptKey, 'provider-upload')
    expect(ctx.storage.delete.mock.calls.map(([key]) => key).sort()).toEqual(
      [artifact.storageKey, attemptKey].sort(),
    )
    expect(ctx.storage.abort.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.storage.delete.mock.invocationCallOrder[0]!,
    )
    expect(ctx.updates).toEqual(
      expect.arrayContaining([
        { table: recordingMediaUploads, values: expect.objectContaining({ status: 'aborted' }) },
        { table: recordingMediaArtifacts, values: { status: 'purged' } },
      ]),
    )
    expect(ctx.auditValues).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'media-purged',
        actorUserId: null,
        connectionId: artifact.connectionId,
        interviewRecordingId: recordingId,
      }),
    )
  })

  it('SR-M-2: leaves the durable purging state untouched on provider failure so retry can finish', async () => {
    const ctx = cleanupFixture([])
    ctx.storage.delete.mockRejectedValueOnce(new Error('provider unavailable'))
    const service = new RecordingMediaPurgeService(ctx.db, ctx.storage as never)

    await expect(
      service.cleanupArtifact(artifact, recordingId, new Date('2026-10-24T12:10:00.000Z')),
    ).rejects.toThrow('provider unavailable')
    expect(ctx.transaction).not.toHaveBeenCalled()

    await expect(
      service.cleanupArtifact(artifact, recordingId, new Date('2026-10-24T12:15:00.000Z')),
    ).resolves.toBe(true)
    expect(ctx.transaction).toHaveBeenCalledOnce()
  })

  it('SR-M-2: does not delete while an already-issued UploadPart capability may still target an open multipart session', async () => {
    const ctx = cleanupFixture([
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        storageKey: artifact.storageKey,
        storageUploadId: 'provider-upload',
        status: 'uploading',
        updatedAt: new Date('2026-10-24T10:00:00.000Z'),
      },
    ])
    ctx.storage.abort.mockRejectedValueOnce(new Error('abort unavailable'))
    const service = new RecordingMediaPurgeService(ctx.db, ctx.storage as never)

    await expect(
      service.cleanupArtifact(artifact, recordingId, new Date('2026-10-24T12:10:00.000Z')),
    ).rejects.toThrow('abort unavailable')
    expect(ctx.storage.delete).not.toHaveBeenCalled()
    expect(ctx.transaction).not.toHaveBeenCalled()
  })

  it('SR-M-2: refuses to touch a key outside the owned recording artifact prefix', async () => {
    const ctx = cleanupFixture([
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        storageKey: 'documents/do-not-delete',
        storageUploadId: 'provider-upload',
        status: 'expired',
        updatedAt: new Date('2026-10-24T10:00:00.000Z'),
      },
    ])
    const service = new RecordingMediaPurgeService(ctx.db, ctx.storage as never)

    await expect(
      service.cleanupArtifact(artifact, recordingId, new Date('2026-10-24T12:10:00.000Z')),
    ).rejects.toThrow('Unsafe media purge key')
    expect(ctx.storage.abort).not.toHaveBeenCalled()
    expect(ctx.storage.delete).not.toHaveBeenCalled()
  })

  it('SR-M-2: refuses a sibling artifact key under the same connection prefix', async () => {
    const siblingKey =
      'meeting-recordings/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab/attempt'
    const ctx = cleanupFixture([
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        storageKey: siblingKey,
        storageUploadId: 'provider-upload',
        status: 'expired',
        updatedAt: new Date('2026-10-24T10:00:00.000Z'),
      },
    ])
    const service = new RecordingMediaPurgeService(ctx.db, ctx.storage as never)

    await expect(
      service.cleanupArtifact(artifact, recordingId, new Date('2026-10-24T12:10:00.000Z')),
    ).rejects.toThrow('Unsafe media purge key')
    expect(ctx.storage.abort).not.toHaveBeenCalled()
    expect(ctx.storage.delete).not.toHaveBeenCalled()
  })

  it('SR-M-2: defers a fresh completion lease so provider completion cannot recreate a deleted object', async () => {
    const ctx = cleanupFixture([
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        storageKey: artifact.storageKey,
        storageUploadId: 'provider-upload',
        status: 'completing',
        updatedAt: new Date('2026-10-24T12:09:00.001Z'),
      },
    ])
    const service = new RecordingMediaPurgeService(ctx.db, ctx.storage as never)

    await expect(
      service.cleanupArtifact(artifact, recordingId, new Date('2026-10-24T12:10:00.000Z')),
    ).resolves.toBe(false)
    expect(ctx.storage.abort).not.toHaveBeenCalled()
    expect(ctx.storage.delete).not.toHaveBeenCalled()
    expect(ctx.transaction).not.toHaveBeenCalled()
  })

  it('SR-M-2: treats an already-missing multipart session as an idempotent abort', async () => {
    const ctx = cleanupFixture([
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        storageKey: artifact.storageKey,
        storageUploadId: 'missing-upload',
        status: 'expired',
        updatedAt: new Date('2026-10-24T10:00:00.000Z'),
      },
    ])
    ctx.storage.abort.mockRejectedValueOnce(new GoneException({ code: 'MEDIA_UPLOAD_EXPIRED' }))
    const service = new RecordingMediaPurgeService(ctx.db, ctx.storage as never)

    await expect(
      service.cleanupArtifact(artifact, recordingId, new Date('2026-10-24T12:10:00.000Z')),
    ).resolves.toBe(true)
    expect(ctx.storage.delete).toHaveBeenCalled()
  })
})
