import { describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'

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
    artifactFailureCandidates?: string[]
    artifactLiveOnRecheck?: boolean
    lockedArtifactStatus?: string | null
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

  let artifactCandidateFilter: unknown
  let artifactReferenceFilter: unknown
  let uploadReferenceFilter: unknown
  const artifactReferenceFilters: unknown[] = []
  const uploadReferenceFilters: unknown[] = []
  const artifactReferenceSelections: Record<string, unknown>[] = []
  const uploadReferenceSelections: Record<string, unknown>[] = []
  const attemptFilters: unknown[] = []
  const attemptSelections: Record<string, unknown>[] = []
  const select = vi.fn((selection: Record<string, unknown>) => ({
    from: (table: unknown) => ({
      where: vi.fn().mockImplementation((filter: unknown) => {
        if (table === recordingMediaArtifacts) {
          if ('id' in selection) {
            artifactCandidateFilter = filter
            return Promise.resolve(
              (options.artifactFailureCandidates ?? ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']).map(
                (id) => ({ id }),
              ),
            )
          }
          artifactReferenceFilter = filter
          artifactReferenceFilters.push(filter)
          artifactReferenceSelections.push(selection)
          return Promise.resolve((options.artifactRefs ?? []).map((storageKey) => ({ storageKey })))
        }
        if (table === recordingMediaUploads && 'id' in selection) {
          attemptFilters.push(filter)
          attemptSelections.push(selection)
          return Promise.resolve(attempts)
        }
        if (table === recordingMediaUploads) {
          uploadReferenceFilter = filter
          uploadReferenceFilters.push(filter)
          uploadReferenceSelections.push(selection)
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
  const updateWhere = vi.fn()
  const set = vi.fn()
  const updateRecords: Array<{ table: unknown; values: Record<string, unknown>; filter: unknown }> =
    []
  const update = vi.fn((table: unknown) => ({
    set: (values: Record<string, unknown>) => {
      set(values)
      return {
        where: (filter: unknown) => {
          updateWhere(filter)
          updateRecords.push({ table, values, filter })
          return { returning }
        },
      }
    },
  }))
  const lockedArtifact =
    options.lockedArtifactStatus === null
      ? []
      : [
          {
            id: (options.artifactFailureCandidates ?? ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])[0],
            status: options.lockedArtifactStatus ?? 'uploading',
          },
        ]
  const lockArtifact = vi.fn(() => ({
    limit: async () => lockedArtifact,
  }))
  const txArtifactSelections: Record<string, unknown>[] = []
  const txUploadSelections: Record<string, unknown>[] = []
  const txArtifactFilters: unknown[] = []
  const txUploadFilters: unknown[] = []
  const tx = {
    select: vi.fn((selection: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (filter: unknown) => {
          if (table === recordingMediaArtifacts) {
            txArtifactSelections.push(selection)
            txArtifactFilters.push(filter)
            return { for: lockArtifact }
          }
          if (table === recordingMediaUploads) {
            txUploadSelections.push(selection)
            txUploadFilters.push(filter)
            return {
              limit: async () => (options.artifactLiveOnRecheck ? [{ id: 'live-attempt' }] : []),
            }
          }
          throw new Error('Unexpected reconciliation transaction table')
        },
      }),
    })),
    update,
  }
  const db = {
    db: {
      select,
      update,
      transaction: vi.fn((callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    },
  }
  const service = new RecordingMediaReconciliationService(db as never, storage as never)
  return {
    service,
    abort,
    storage,
    update,
    set,
    updateWhere,
    returning,
    artifactCandidateFilter: () => artifactCandidateFilter,
    artifactReferenceFilter: () => artifactReferenceFilter,
    uploadReferenceFilter: () => uploadReferenceFilter,
    artifactReferenceFilters,
    uploadReferenceFilters,
    artifactReferenceSelections,
    uploadReferenceSelections,
    attemptFilters,
    attemptSelections,
    lockArtifact,
    updateRecords,
    txArtifactSelections,
    txUploadSelections,
    txArtifactFilters,
    txUploadFilters,
  }
}

describe('dedicated media multipart reconciliation', () => {
  it('preserves live work, tombstones stale DB attempts, and aborts stale provider sessions', async () => {
    const {
      service,
      abort,
      set,
      update,
      artifactCandidateFilter,
      lockArtifact,
      updateRecords,
      returning,
    } = fixture({
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
    expect(set).toHaveBeenCalledWith({ status: 'failed' })
    expect(update).toHaveBeenCalledWith(recordingMediaUploads)
    expect(update).toHaveBeenCalledWith(recordingMediaArtifacts)
    const query = new PgDialect().sqlToQuery(artifactCandidateFilter() as never)
    expect(query.params).toEqual(expect.arrayContaining(['uploading', 'completing', 'ready']))
    expect(lockArtifact).toHaveBeenCalledWith('update')
    expect(query.params.filter((param) => param === 'uploading')).toHaveLength(2)
    expect(query.params.filter((param) => param === 'completing')).toHaveLength(2)
    expect(query.params.filter((param) => param === 'ready')).toHaveLength(1)
    expect(query.sql).toContain('select "id" from "recording_media_uploads"')
    const claim = updateRecords.find(
      (record) => record.table === recordingMediaUploads && record.values.status === 'aborted',
    )
    expect(claim).toBeDefined()
    const claimQuery = new PgDialect().sqlToQuery(claim!.filter as never)
    expect(claimQuery.params).toEqual(
      expect.arrayContaining([
        '33333333-3333-4333-8333-333333333333',
        'uploading',
        'completing',
        'expired',
        'aborted',
      ]),
    )
    expect(Object.keys(returning.mock.calls[0]?.[0] as Record<string, unknown>)).toEqual(['id'])
    expect(abort.mock.calls).toEqual([
      ['meeting-recordings/a/expired', 'expired'],
      ['meeting-recordings/a/orphan', 'orphan'],
    ])
    expect(set.mock.invocationCallOrder[0]).toBeLessThan(abort.mock.invocationCallOrder[0]!)
  })

  it('releases artifact quota even when the provider session has already disappeared', async () => {
    const {
      service,
      abort,
      set,
      update,
      artifactCandidateFilter,
      lockArtifact,
      updateRecords,
      txArtifactSelections,
      txUploadSelections,
      txUploadFilters,
    } = fixture({
      uploads: [],
    })

    expect(await service.reconcile(now)).toMatchObject({
      scanned: 0,
      stale: 0,
      aborted: 0,
      databaseAborted: 0,
    })
    expect(abort).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith(recordingMediaArtifacts)
    expect(set).toHaveBeenCalledWith({ status: 'failed' })
    expect(set).toHaveBeenCalledWith({ status: 'expired', updatedAt: now })
    const query = new PgDialect().sqlToQuery(artifactCandidateFilter() as never)
    expect(query.params).toEqual(
      expect.arrayContaining(['uploading', 'completing', 'ready', now.toISOString()]),
    )
    expect(query.params.filter((param) => param === 'uploading')).toHaveLength(2)
    expect(query.params.filter((param) => param === 'completing')).toHaveLength(2)
    expect(query.params.filter((param) => param === 'ready')).toHaveLength(1)
    expect(query.sql).toContain('select "id" from "recording_media_uploads"')
    expect(Object.keys(txArtifactSelections[0]!)).toEqual(['id', 'status'])
    expect(Object.keys(txUploadSelections[0]!)).toEqual(['id'])
    const liveAttemptQuery = new PgDialect().sqlToQuery(txUploadFilters[0] as never)
    expect(liveAttemptQuery.params).toEqual(
      expect.arrayContaining(['ready', 'uploading', 'completing', now.toISOString()]),
    )
    const expireAttempts = updateRecords.find(
      (record) => record.table === recordingMediaUploads && record.values.status === 'expired',
    )
    expect(expireAttempts).toBeDefined()
    const expireQuery = new PgDialect().sqlToQuery(expireAttempts!.filter as never)
    expect(expireQuery.params).toEqual(
      expect.arrayContaining(['uploading', 'completing', now.toISOString()]),
    )
    const failArtifact = updateRecords.find(
      (record) => record.table === recordingMediaArtifacts && record.values.status === 'failed',
    )
    expect(failArtifact).toBeDefined()
    const failQuery = new PgDialect().sqlToQuery(failArtifact!.filter as never)
    expect(failQuery.params.filter((param) => param === 'uploading')).toHaveLength(1)
    expect(failQuery.params.filter((param) => param === 'completing')).toHaveLength(1)
    expect(lockArtifact).toHaveBeenCalledWith('update')
  })

  it.each([
    [null, 'missing'],
    ['ready', 'terminal'],
  ] as const)('preserves a %s artifact after taking the lifecycle lock (%s)', async (status) => {
    const { service, set } = fixture({
      uploads: [],
      lockedArtifactStatus: status,
    })
    await expect(service.reconcile(now)).resolves.toMatchObject({ scanned: 0 })
    expect(set).not.toHaveBeenCalledWith({ status: 'failed' })
  })

  it('converges a completing artifact when no live attempt remains after the lock', async () => {
    const { service, set } = fixture({
      uploads: [],
      lockedArtifactStatus: 'completing',
    })
    await expect(service.reconcile(now)).resolves.toMatchObject({ scanned: 0 })
    expect(set).toHaveBeenCalledWith({ status: 'expired', updatedAt: now })
    expect(set).toHaveBeenCalledWith({ status: 'failed' })
  })

  it('rechecks after locking and preserves an artifact when a live attempt appears', async () => {
    const { service, abort, set, lockArtifact } = fixture({
      uploads: [],
      artifactLiveOnRecheck: true,
    })

    expect(await service.reconcile(now)).toMatchObject({ scanned: 0, stale: 0, aborted: 0 })
    expect(lockArtifact).toHaveBeenCalledWith('update')
    expect(set).not.toHaveBeenCalledWith({ status: 'failed' })
    expect(abort).not.toHaveBeenCalled()
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

  it('pins the exact stale/live time boundaries for provider multipart work', async () => {
    const graceCutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000)
    const uploads = [
      { key: 'meeting-recordings/a/at-grace', uploadId: 'at-grace', initiatedAt: graceCutoff },
      {
        key: 'meeting-recordings/a/before-grace',
        uploadId: 'before-grace',
        initiatedAt: new Date(graceCutoff.getTime() - 1),
      },
      { key: 'meeting-recordings/a/expires-now', uploadId: 'expires-now', initiatedAt: old },
      {
        key: 'meeting-recordings/a/expires-later',
        uploadId: 'expires-later',
        initiatedAt: old,
      },
      {
        key: 'meeting-recordings/a/completing-at-grace',
        uploadId: 'completing-at-grace',
        initiatedAt: old,
      },
      {
        key: 'meeting-recordings/a/completing-after-grace',
        uploadId: 'completing-after-grace',
        initiatedAt: old,
      },
      { key: 'meeting-recordings/a/ready', uploadId: 'ready', initiatedAt: old },
    ]
    const attempts: AttemptRow[] = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        storageKey: uploads[2]!.key,
        storageUploadId: uploads[2]!.uploadId,
        status: 'uploading',
        expiresAt: now,
        updatedAt: old,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        storageKey: uploads[3]!.key,
        storageUploadId: uploads[3]!.uploadId,
        status: 'uploading',
        expiresAt: new Date(now.getTime() + 1),
        updatedAt: old,
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        storageKey: uploads[4]!.key,
        storageUploadId: uploads[4]!.uploadId,
        status: 'completing',
        expiresAt: old,
        updatedAt: graceCutoff,
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        storageKey: uploads[5]!.key,
        storageUploadId: uploads[5]!.uploadId,
        status: 'completing',
        expiresAt: old,
        updatedAt: new Date(graceCutoff.getTime() + 1),
      },
      {
        id: '55555555-5555-4555-8555-555555555555',
        storageKey: uploads[6]!.key,
        storageUploadId: uploads[6]!.uploadId,
        status: 'ready',
        expiresAt: old,
        updatedAt: old,
      },
    ]
    const { service } = fixture({ uploads, attempts })

    await expect(service.reconcile(now, true)).resolves.toMatchObject({
      scanned: 7,
      stale: 3,
      aborted: 0,
      databaseAborted: 0,
    })
  })

  it('batches provider upload IDs at exactly 400 rows', async () => {
    const uploads = Array.from({ length: 401 }, (_, index) => ({
      key: `meeting-recordings/a/fresh-${index}`,
      uploadId: `upload-${index}`,
      initiatedAt: fresh,
    }))
    const { service, attemptFilters } = fixture({ uploads })

    await expect(service.reconcile(now, true)).resolves.toMatchObject({ scanned: 401, stale: 0 })
    expect(attemptFilters).toHaveLength(2)
    const first = new PgDialect().sqlToQuery(attemptFilters[0] as never)
    const second = new PgDialect().sqlToQuery(attemptFilters[1] as never)
    expect(first.params).toHaveLength(400)
    expect(first.params[0]).toBe('upload-0')
    expect(first.params[399]).toBe('upload-399')
    expect(second.params).toEqual(['upload-400'])
  })

  it('does not issue an empty provider-attempt batch at an exact 400-row boundary', async () => {
    const uploads = Array.from({ length: 400 }, (_, index) => ({
      key: `meeting-recordings/a/fresh-exact-${index}`,
      uploadId: `upload-exact-${index}`,
      initiatedAt: fresh,
    }))
    const { service, attemptFilters } = fixture({ uploads })
    await expect(service.reconcile(now, true)).resolves.toMatchObject({ scanned: 400, stale: 0 })
    expect(attemptFilters).toHaveLength(1)
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
    const { service, abort, artifactReferenceFilter, uploadReferenceFilter } = fixture({
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
    const artifactQuery = new PgDialect().sqlToQuery(artifactReferenceFilter() as never)
    expect(artifactQuery.params).toEqual(expect.arrayContaining(['ready']))
    const uploadQuery = new PgDialect().sqlToQuery(uploadReferenceFilter() as never)
    expect(uploadQuery.params).toEqual(
      expect.arrayContaining(['ready', 'uploading', 'completing', now.toISOString()]),
    )
  })

  it('batches completed-object reference lookups without dropping or duplicating keys', async () => {
    const objects = Array.from({ length: 800 }, (_, index) => ({
      key: `meeting-recordings/a/orphan-batch-${index}`,
      bytes: index + 1,
      lastModified: old,
    }))
    const {
      service,
      artifactReferenceFilters,
      uploadReferenceFilters,
      artifactReferenceSelections,
      uploadReferenceSelections,
    } = fixture({ uploads: [], objects })

    const result = await service.reconcile(now, true)
    expect(result.orphanObjects).toBe(800)
    expect(artifactReferenceFilters).toHaveLength(2)
    expect(uploadReferenceFilters).toHaveLength(2)
    expect(Object.keys(artifactReferenceSelections[0]!)).toEqual(['storageKey'])
    expect(Object.keys(uploadReferenceSelections[0]!)).toEqual(['storageKey'])

    for (const [index, filter] of artifactReferenceFilters.entries()) {
      const query = new PgDialect().sqlToQuery(filter as never)
      const keys = query.params.filter(
        (param): param is string =>
          typeof param === 'string' && param.startsWith('meeting-recordings/a/orphan-batch-'),
      )
      expect(keys).toHaveLength(400)
      expect(keys[0]).toBe(`meeting-recordings/a/orphan-batch-${index * 400}`)
      expect(keys.at(-1)).toBe(`meeting-recordings/a/orphan-batch-${index * 400 + 399}`)
      expect(query.params).toContain('ready')
    }

    for (const [index, filter] of uploadReferenceFilters.entries()) {
      const query = new PgDialect().sqlToQuery(filter as never)
      const keys = query.params.filter(
        (param): param is string =>
          typeof param === 'string' && param.startsWith('meeting-recordings/a/orphan-batch-'),
      )
      expect(keys).toHaveLength(400)
      expect(keys[0]).toBe(`meeting-recordings/a/orphan-batch-${index * 400}`)
      expect(keys.at(-1)).toBe(`meeting-recordings/a/orphan-batch-${index * 400 + 399}`)
      expect(query.params).toEqual(
        expect.arrayContaining(['ready', 'uploading', 'completing', now.toISOString()]),
      )
    }
  })

  it('treats an object exactly on the grace cutoff as fresh', async () => {
    const graceCutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000)
    const { service } = fixture({
      uploads: [],
      objects: [
        { key: 'meeting-recordings/a/at-cutoff', bytes: 1, lastModified: graceCutoff },
        {
          key: 'meeting-recordings/a/before-cutoff',
          bytes: 2,
          lastModified: new Date(graceCutoff.getTime() - 1),
        },
      ],
    })

    await expect(service.reconcile(now, true)).resolves.toMatchObject({
      objectsScanned: 2,
      orphanObjects: 1,
      orphanSample: [expect.objectContaining({ bytes: 2 })],
    })
  })

  it('caps orphan samples at 20 while preserving the full orphan count', async () => {
    const objects = Array.from({ length: 21 }, (_, index) => ({
      key: `meeting-recordings/a/orphan-${index}`,
      bytes: index + 1,
      lastModified: old,
    }))
    const { service } = fixture({ uploads: [], objects })

    const result = await service.reconcile(now, true)
    expect(result.orphanObjects).toBe(21)
    expect(result.orphanSample).toHaveLength(20)
    expect(result.orphanSample[0]).toEqual({
      ref: 'sha256:be293e7da0074e3f',
      bytes: 1,
      lastModified: old.toISOString(),
    })
    expect(result.orphanSample.at(-1)?.bytes).toBe(20)
  })
})
