import { GoneException } from '@nestjs/common'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'

import {
  meetingRecorderConnections,
  recordingMediaArtifacts,
  recordingMediaUploads,
} from '../../../database/schema'
import { RecordingMediaUploadService } from './recording-media-upload.service'

const artifact = {
  id: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222',
  externalRecordingId: 'recording_33333333-3333-4333-8333-333333333333',
  status: 'uploading',
  storageKey: 'meeting-recordings/opaque',
  mimeType: 'video/webm',
  bytes: 5,
}
const upload = {
  id: '44444444-4444-4444-8444-444444444444',
  artifactId: artifact.id,
  status: 'uploading',
  storageKey: artifact.storageKey,
  storageUploadId: 'opaque-provider-id',
  partSize: 32 * 1024 * 1024,
  expiresAt: new Date(Date.now() + 3600_000),
  updatedAt: new Date(),
}

function fixture(overrides: { status?: string; updatedAt?: Date } = {}) {
  const attempt = { ...upload, ...overrides }
  const provider = {
    head: vi.fn().mockResolvedValue(null),
    listParts: vi.fn().mockResolvedValue([{ partNumber: 1, etag: 'etag-1', bytes: 5 }]),
    complete: vi.fn().mockResolvedValue(undefined),
  }
  const returning = vi.fn().mockResolvedValue([{ id: attempt.id }])
  const set = vi.fn(() => ({ where: vi.fn(() => ({ returning })) }))
  const update = vi.fn(() => ({ set }))
  const tx = {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () =>
          table === meetingRecorderConnections
            ? { for: () => ({ limit: async () => [{ id: artifact.connectionId }] }) }
            : {
                orderBy: () => ({
                  limit: async () => [{ id: attempt.id, status: attempt.status }],
                }),
              },
      }),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
  }
  const db = {
    db: {
      select: vi.fn(() => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({ limit: async () => [{ artifact, upload: attempt }] }),
          }),
        }),
      })),
      update,
      transaction: vi.fn((callback: (tx: typeof tx) => Promise<unknown>) => callback(tx)),
    },
  }
  return {
    service: new RecordingMediaUploadService(db as never, provider as never),
    provider,
    db,
    tx,
  }
}

describe('CRM media upload recovery', () => {
  it('distinguishes an active completion lease from an expired one', async () => {
    const active = fixture({ status: 'completing' })
    await expect(
      active.service.status(artifact.connectionId, `upload_${upload.id}`),
    ).rejects.toMatchObject({ status: 409 })

    const expired = fixture({ status: 'completing', updatedAt: new Date(Date.now() - 300_000) })
    await expect(
      expired.service.status(artifact.connectionId, `upload_${upload.id}`),
    ).rejects.toMatchObject({ status: 410 })
    expect(expired.provider.head).toHaveBeenCalledOnce()
  })

  it('checks actual provider part lengths before completing a multipart object', async () => {
    const { service, provider } = fixture()
    provider.listParts.mockResolvedValue([{ partNumber: 1, etag: 'etag-1', bytes: 4 }])
    await expect(
      service.complete(artifact.connectionId, `upload_${upload.id}`, {
        parts: [{ partNumber: 1, etag: 'etag-1' }],
      }),
    ).rejects.toMatchObject({ status: 422 })
    expect(provider.complete).not.toHaveBeenCalled()
  })

  it('recovers a lost provider completion response using object HEAD', async () => {
    const { service, provider, tx } = fixture()
    provider.head.mockResolvedValueOnce(null).mockResolvedValue({
      bytes: artifact.bytes,
      mimeType: artifact.mimeType,
    })
    provider.complete.mockRejectedValue(new TypeError('Provider response lost'))
    await expect(
      service.complete(artifact.connectionId, `upload_${upload.id}`, {
        parts: [{ partNumber: 1, etag: 'etag-1' }],
      }),
    ).resolves.toEqual({ artifactId: `media_${artifact.id}`, state: 'ready' })
    expect(provider.complete).toHaveBeenCalledOnce()
    expect(tx.update).toHaveBeenCalledTimes(2)
  })

  it('retires a missing provider session so create can issue another attempt', async () => {
    const { service, provider, tx } = fixture()
    provider.listParts.mockRejectedValue(new GoneException({ code: 'MEDIA_UPLOAD_EXPIRED' }))
    await expect(
      service.status(artifact.connectionId, `upload_${upload.id}`),
    ).rejects.toMatchObject({ status: 410 })
    expect(tx.update).toHaveBeenCalledOnce()
    expect(tx.update.mock.results[0]?.value.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'expired' }),
    )
  })

  it('includes active completing attempts in the four-upload connection limit', async () => {
    let activeFilter: unknown
    const tx = {
      select: vi.fn(() => ({
        from: (table: unknown) => {
          if (table === meetingRecorderConnections) {
            return { where: () => ({ for: () => ({ limit: async () => [{ enabled: true }] }) }) }
          }
          if (table === recordingMediaArtifacts) {
            return { where: () => ({ limit: async () => [] }) }
          }
          if (table === recordingMediaUploads) {
            return {
              innerJoin: () => ({
                where: (filter: unknown) => {
                  activeFilter = filter
                  return Promise.resolve([{ value: 4 }])
                },
              }),
            }
          }
          throw new Error('Unexpected table')
        },
      })),
    }
    const db = { db: { transaction: (f: (t: typeof tx) => Promise<unknown>) => f(tx) } }
    const storage = { begin: vi.fn() }
    const service = new RecordingMediaUploadService(db as never, storage as never)
    await expect(
      service.create(artifact.connectionId, {
        clientTransferId: 'transfer_1',
        recordingId: artifact.externalRecordingId,
        artifact: { role: 'tab-recording', filename: 'a.webm', mimeType: 'video/webm', bytes: 5 },
      }),
    ).rejects.toMatchObject({ status: 429 })
    expect(storage.begin).not.toHaveBeenCalled()
    const query = new PgDialect().sqlToQuery(activeFilter as never)
    expect(query.params).toEqual(expect.arrayContaining(['uploading', 'completing']))
  })
})

describe('CRM media descriptors', () => {
  it('returns only recording-scoped ready artifact metadata', async () => {
    let whereFilter: unknown
    const row = {
      id: artifact.id,
      role: 'tab-recording',
      filename: 'meeting.webm',
      mimeType: 'video/webm',
      bytes: 5,
    }
    const db = {
      db: {
        select: vi.fn(() => ({
          from: (table: unknown) => {
            expect(table).toBe(recordingMediaArtifacts)
            return {
              where: (filter: unknown) => {
                whereFilter = filter
                return { orderBy: async () => [row] }
              },
            }
          },
        })),
      },
    }
    const service = new RecordingMediaUploadService(db as never, {} as never)

    await expect(
      service.listReadyForCrm(artifact.connectionId, artifact.externalRecordingId),
    ).resolves.toEqual([
      {
        artifactId: `media_${artifact.id}`,
        role: row.role,
        filename: row.filename,
        mimeType: row.mimeType,
        bytes: row.bytes,
      },
    ])

    const query = new PgDialect().sqlToQuery(whereFilter as never)
    expect(query.params).toEqual(
      expect.arrayContaining([artifact.connectionId, artifact.externalRecordingId, 'ready']),
    )
  })
})
