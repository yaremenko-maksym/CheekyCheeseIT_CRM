import { describe, expect, it, vi } from 'vitest'

import { recordingMediaArtifacts, recordingMediaUploads } from '../../../database/schema'
import { RecordingMediaReconciliationService } from './recording-media-reconciliation.service'

const now = new Date('2026-10-08T20:00:00Z')
const old = new Date('2026-09-29T20:00:00Z')
const fresh = new Date('2026-10-08T19:00:00Z')

type AttemptRow = {
  id: string
  storageKey: string
  storageUploadId: string
  status: string
  expiresAt: Date
  updatedAt: Date
}

function defaultUploads() {
  return [
    { key: 'meeting-recordings/a/live', uploadId: 'live', initiatedAt: old },
    { key: 'meeting-recordings/a/completing', uploadId: 'completing', initiatedAt: old },
    { key: 'meeting-recordings/a/expired', uploadId: 'expired', initiatedAt: old },
    { key: 'meeting-recordings/a/orphan', uploadId: 'orphan', initiatedAt: old },
    { key: 'meeting-recordings/a/new', uploadId: 'new', initiatedAt: fresh },
  ]
}

function fixture(
  options: {
    attempts?: AttemptRow[]
    uploads?: ReturnType<typeof defaultUploads>
    objects?: Array<{ key: string; bytes: number; lastModified: Date }>
    artifactRefs?: string[]
    liveAttemptRefs?: string[]
    claim?: boolean
  } = {},
) {
  const attempts = options.attempts ?? []
  const uploads = options.uploads ?? defaultUploads()
  const objects = options.objects ?? []
  const abort = vi.fn().mockResolvedValue(undefined)
  const storage = {
    listOpenMediaUploads: vi.fn().mockResolvedValue(uploads),
    listMediaObjects: vi.fn().mockResolvedValue(objects),
    abort,
  }

  const select = vi.fn((selection: Record<string, unknown>) => ({
    from: (table: unknown) => ({
      where: vi.fn().mockImplementation(() => {
        if (table === recordingMediaArtifacts) {
          return Promise.resolve((options.artifactRefs ?? []).map((storageKey) => ({ storageKey })))
        }
        if (table === recordingMediaUploads && 'id' in selection) return Promise.resolve(attempts)
        if (table === recordingMediaUploads) {
          return Promise.resolve(
            (options.liveAttemptRefs ?? []).map((storageKey) => ({ storageKey })),
          )
        }
        throw new Error('Unexpected reconciliation table')
      }),
    }),
  }))
  const returning = vi
    .fn()
    .mockResolvedValue(options.claim === false ? [] : [{ id: 'claimed-attempt' }])
  const updateWhere = vi.fn(() => ({ returning }))
  const set = vi.fn(() => ({ where: updateWhere }))
  const update = vi.fn(() => ({ set }))
  const db = { db: { select, update } }
  const service = new RecordingMediaReconciliationService(db as never, storage as never)
  return { service, abort, storage, update, set, returning }
}

describe('dedicated media multipart reconciliation', () => {
  it('preserves live work, tombstones stale DB attempts, and aborts stale provider sessions', async () => {
    const { service, abort, set, update } = fixture({
      attempts: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          storageKey: 'meeting-recordings/a/live',
          storageUploadId: 'live',
          status: 'uploading',
          expiresAt: new Date('2026-10-09T20:00:00Z'),
          updatedAt: old,
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          storageKey: 'meeting-recordings/a/completing',
          storageUploadId: 'completing',
          status: 'completing',
          expiresAt: old,
          updatedAt: fresh,
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          storageKey: 'meeting-recordings/a/expired',
          storageUploadId: 'expired',
          status: 'uploading',
          expiresAt: old,
          updatedAt: old,
        },
      ],
    })

    expect(await service.reconcile(now)).toEqual({
      scanned: 5,
      stale: 2,
      aborted: 2,
      databaseAborted: 1,
      objectsScanned: 0,
      orphanObjects: 0,
      orphanSample: [],
    })
    expect(set).toHaveBeenCalledWith({ status: 'aborted', updatedAt: now })
    expect(update).toHaveBeenCalledWith(recordingMediaUploads)
    expect(abort.mock.calls).toEqual([
      ['meeting-recordings/a/expired', 'expired'],
      ['meeting-recordings/a/orphan', 'orphan'],
    ])
    expect(set.mock.invocationCallOrder[0]).toBeLessThan(abort.mock.invocationCallOrder[0]!)
  })

  it('supports a safe dry run without changing DB rows or provider sessions', async () => {
    const { service, abort, update } = fixture()
    expect(await service.reconcile(now, true)).toEqual({
      scanned: 5,
      stale: 4,
      aborted: 0,
      databaseAborted: 0,
      objectsScanned: 0,
      orphanObjects: 0,
      orphanSample: [],
    })
    expect(abort).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('does not abort a provider upload when a concurrent transition wins the stale-row claim', async () => {
    const uploads = [{ key: 'meeting-recordings/a/race', uploadId: 'race', initiatedAt: old }]
    const attempts: AttemptRow[] = [
      {
        id: '44444444-4444-4444-8444-444444444444',
        storageKey: uploads[0]!.key,
        storageUploadId: uploads[0]!.uploadId,
        status: 'uploading',
        expiresAt: old,
        updatedAt: old,
      },
    ]
    const { service, abort } = fixture({ uploads, attempts, claim: false })

    expect(await service.reconcile(now)).toMatchObject({
      scanned: 1,
      stale: 1,
      aborted: 0,
      databaseAborted: 0,
    })
    expect(abort).not.toHaveBeenCalled()
  })

  it('leaves a durable aborted tombstone when provider abort fails so a later pass can retry', async () => {
    const uploads = [{ key: 'meeting-recordings/a/stale', uploadId: 'stale', initiatedAt: old }]
    const attempts: AttemptRow[] = [
      {
        id: '55555555-5555-4555-8555-555555555555',
        storageKey: uploads[0]!.key,
        storageUploadId: uploads[0]!.uploadId,
        status: 'expired',
        expiresAt: old,
        updatedAt: old,
      },
    ]
    const { service, abort, set } = fixture({ uploads, attempts })
    abort.mockRejectedValueOnce(new Error('provider unavailable'))

    await expect(service.reconcile(now)).rejects.toThrow('provider unavailable')
    expect(set).toHaveBeenCalledWith({ status: 'aborted', updatedAt: now })
  })

  it('reports only old unreferenced completed objects and never exposes raw storage keys', async () => {
    const currentKey = 'meeting-recordings/connection/current'
    const activeKey = 'meeting-recordings/connection/active-attempt'
    const orphanKey = 'meeting-recordings/connection/obsolete-attempt'
    const freshKey = 'meeting-recordings/connection/fresh-uncommitted'
    const { service, abort } = fixture({
      uploads: [],
      objects: [
        { key: currentKey, bytes: 10, lastModified: old },
        { key: activeKey, bytes: 20, lastModified: old },
        { key: orphanKey, bytes: 30, lastModified: old },
        { key: freshKey, bytes: 40, lastModified: fresh },
      ],
      artifactRefs: [currentKey],
      liveAttemptRefs: [activeKey],
    })

    const result = await service.reconcile(now, true)
    expect(result).toMatchObject({
      objectsScanned: 4,
      orphanObjects: 1,
    })
    expect(result.orphanSample).toHaveLength(1)
    expect(result.orphanSample[0]).toMatchObject({
      bytes: 30,
      lastModified: old.toISOString(),
    })
    expect(result.orphanSample[0]!.ref).toMatch(/^sha256:[0-9a-f]{16}$/)
    expect(JSON.stringify(result)).not.toContain(orphanKey)
    expect(abort).not.toHaveBeenCalled()
  })
})
