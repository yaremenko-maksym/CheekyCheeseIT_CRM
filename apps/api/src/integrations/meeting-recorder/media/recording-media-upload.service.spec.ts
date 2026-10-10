import { createHash } from 'node:crypto'
import { GoneException, HttpException } from '@nestjs/common'
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

function fixture(
  overrides: {
    status?: string
    updatedAt?: Date
    artifactStatus?: string
    quotaBytes?: string | null
    connectionEnabled?: boolean
    connectionPresent?: boolean
    currentArtifactPresent?: boolean
    claim?: boolean
    expiresAt?: Date
    artifactOverrides?: Partial<typeof artifact>
    rowPresent?: boolean
    latestAttempt?: { id: string; status: string } | null
  } = {},
) {
  const resolvedArtifact = { ...artifact, ...overrides.artifactOverrides }
  const attempt = { ...upload, ...overrides }
  const provider = {
    head: vi.fn().mockResolvedValue(null),
    listParts: vi.fn().mockResolvedValue([{ partNumber: 1, etag: 'etag-1', bytes: 5 }]),
    complete: vi.fn().mockResolvedValue(undefined),
    signPart: vi.fn().mockResolvedValue({ method: 'PUT', url: 'https://upload.example.test' }),
    playback: vi.fn().mockResolvedValue({ url: 'https://play.example.test' }),
  }
  const returning = vi.fn().mockResolvedValue(overrides.claim === false ? [] : [{ id: attempt.id }])
  const dbUpdateRecords: Array<{
    table: unknown
    values: Record<string, unknown>
    filter: unknown
  }> = []
  const set = vi.fn()
  const update = vi.fn((table: unknown) => ({
    set: (values: Record<string, unknown>) => {
      set(values)
      return {
        where: (filter: unknown) => {
          dbUpdateRecords.push({ table, values, filter })
          return { returning }
        },
      }
    },
  }))
  const txSelections: Array<{ table: unknown; selection: Record<string, unknown> }> = []
  const txFilters: Array<{ table: unknown; filter: unknown }> = []
  const txFor = vi.fn((mode: string) => {
    expect(mode).toBe('update')
    return {
      limit: async () =>
        overrides.connectionPresent === false
          ? []
          : [
              {
                id: resolvedArtifact.connectionId,
                enabled: overrides.connectionEnabled ?? true,
              },
            ],
    }
  })
  const txUpdateRecords: Array<{
    table: unknown
    values: Record<string, unknown>
    filter: unknown
  }> = []
  const txSet = vi.fn()
  const tx = {
    select: vi.fn((selection: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (filter: unknown) => {
          txSelections.push({ table, selection })
          txFilters.push({ table, filter })
          if (table === meetingRecorderConnections) {
            return {
              for: txFor,
            }
          }
          if (table === recordingMediaArtifacts) {
            if ('status' in selection) {
              return {
                limit: async () =>
                  overrides.currentArtifactPresent === false
                    ? []
                    : [{ status: overrides.artifactStatus ?? resolvedArtifact.status }],
              }
            }
            return Promise.resolve(
              overrides.quotaBytes === null ? [] : [{ bytes: overrides.quotaBytes ?? '0' }],
            )
          }
          return {
            orderBy: () => ({
              limit: async () =>
                overrides.latestAttempt === null
                  ? []
                  : [overrides.latestAttempt ?? { id: attempt.id, status: attempt.status }],
            }),
          }
        },
      }),
    })),
    update: vi.fn((table: unknown) => {
      const setForTable = vi.fn((values: Record<string, unknown>) => {
        txSet(values)
        return {
          where: (filter: unknown) => {
            txUpdateRecords.push({ table, values, filter })
            return Promise.resolve(undefined)
          },
        }
      })
      return { set: setForTable }
    }),
  }
  const dbSelections: Array<Record<string, unknown> | undefined> = []
  const dbFilters: unknown[] = []
  const joinFilters: unknown[] = []
  const db = {
    db: {
      select: vi.fn((selection?: Record<string, unknown>) => {
        dbSelections.push(selection)
        return {
          from: () => ({
            innerJoin: (_table: unknown, joinFilter: unknown) => {
              joinFilters.push(joinFilter)
              return {
                where: (filter: unknown) => {
                  dbFilters.push(filter)
                  return {
                    limit: async () =>
                      overrides.rowPresent === false
                        ? []
                        : [{ artifact: resolvedArtifact, upload: attempt }],
                  }
                },
              }
            },
          }),
        }
      }),
      update,
      transaction: vi.fn((callback: (tx: typeof tx) => Promise<unknown>) => callback(tx)),
    },
  }
  return {
    service: new RecordingMediaUploadService(db as never, provider as never),
    provider,
    db,
    tx,
    returning,
    set,
    dbUpdateRecords,
    txSet,
    txUpdateRecords,
    txSelections,
    txFilters,
    txFor,
    dbSelections,
    dbFilters,
    joinFilters,
  }
}

const validCreateInput = {
  clientTransferId: 'transfer_1',
  recordingId: artifact.externalRecordingId,
  artifact: {
    role: 'tab-recording' as const,
    filename: 'meeting.webm',
    mimeType: 'video/webm',
    bytes: 5,
  },
}

function createFixture(
  options: {
    connection?: { enabled: boolean } | null
    existing?: Record<string, unknown> | null
    latest?: Record<string, unknown> | null
    quotaBytes?: string
    activeCount?: number | null
    providerUploadId?: string
    attemptReturned?: boolean
    uploadLifetimeMs?: number
    head?: { bytes: number; mimeType: string } | null
    abortFails?: boolean
  } = {},
) {
  const selections: Array<{ table: unknown; selection: Record<string, unknown> | undefined }> = []
  const filters: Array<{ table: unknown; filter: unknown }> = []
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = []
  const updates: Array<{ table: unknown; values: Record<string, unknown>; filter: unknown }> = []
  const connection = options.connection === undefined ? { enabled: true } : options.connection
  const connectionLock = vi.fn((mode: string) => {
    expect(mode).toBe('update')
    return { limit: async () => (connection ? [connection] : []) }
  })
  const begin = vi.fn().mockResolvedValue(options.providerUploadId ?? 'provider-upload-id')
  const abort = vi.fn().mockImplementation(async () => {
    if (options.abortFails) throw new Error('abort failed')
  })
  const head = vi.fn().mockResolvedValue(options.head ?? null)
  const storage = { begin, abort, head }
  let artifactSelectCount = 0

  const tx = {
    select: vi.fn((selection?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        selections.push({ table, selection })
        if (table === meetingRecorderConnections) {
          return {
            where: (filter: unknown) => {
              filters.push({ table, filter })
              return { for: connectionLock }
            },
          }
        }
        if (table === recordingMediaArtifacts) {
          artifactSelectCount++
          if (!selection) {
            return {
              where: (filter: unknown) => {
                filters.push({ table, filter })
                return { limit: async () => (options.existing ? [options.existing] : []) }
              },
            }
          }
          return {
            where: (filter: unknown) => {
              filters.push({ table, filter })
              return Promise.resolve([{ bytes: options.quotaBytes ?? '0' }])
            },
          }
        }
        if (table === recordingMediaUploads) {
          if (!selection) {
            return {
              where: (filter: unknown) => {
                filters.push({ table, filter })
                return {
                  orderBy: () => ({
                    limit: async () => (options.latest ? [options.latest] : []),
                  }),
                }
              },
            }
          }
          return {
            innerJoin: (_joinTable: unknown, _joinFilter: unknown) => ({
              where: (filter: unknown) => {
                filters.push({ table, filter })
                return Promise.resolve(
                  options.activeCount === null ? [] : [{ value: options.activeCount ?? 0 }],
                )
              },
            }),
          }
        }
        throw new Error('Unexpected create table')
      },
    })),
    insert: vi.fn((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values })
        if (table === recordingMediaArtifacts) return Promise.resolve(undefined)
        if (table === recordingMediaUploads) {
          return {
            returning: async () =>
              options.attemptReturned === false
                ? []
                : [
                    {
                      ...values,
                      status: 'uploading',
                      createdAt: new Date(),
                      updatedAt: new Date(),
                    },
                  ],
          }
        }
        throw new Error('Unexpected insert table')
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (filter: unknown) => {
          updates.push({ table, values, filter })
          return Promise.resolve(undefined)
        },
      }),
    })),
  }
  const db = {
    db: {
      transaction: vi.fn((callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    },
  }
  const config =
    options.uploadLifetimeMs === undefined
      ? undefined
      : {
          get: vi.fn().mockReturnValue(options.uploadLifetimeMs),
        }
  return {
    service: new RecordingMediaUploadService(db as never, storage as never, config as never),
    begin,
    abort,
    head,
    tx,
    selections,
    filters,
    inserts,
    updates,
    artifactSelectCount: () => artifactSelectCount,
    config,
    connectionLock,
  }
}

describe('CRM media upload create contract', () => {
  it.each([
    [{}, 'missing fields'],
    [{ ...validCreateInput, clientTransferId: '!transfer' }, 'invalid transfer prefix'],
    [{ ...validCreateInput, clientTransferId: 'transfer!' }, 'invalid transfer suffix'],
    [{ ...validCreateInput, recordingId: `x${artifact.externalRecordingId}` }, 'recording prefix'],
    [{ ...validCreateInput, recordingId: `${artifact.externalRecordingId}x` }, 'recording suffix'],
    [
      { ...validCreateInput, artifact: { ...validCreateInput.artifact, role: 'unknown' } },
      'invalid role',
    ],
  ])('rejects an invalid create request (%s: %s)', async (body) => {
    const { service, begin } = createFixture()
    await expect(service.create(artifact.connectionId, body)).rejects.toMatchObject({
      status: 422,
      response: { code: 'MEDIA_UPLOAD_INVALID' },
    })
    expect(begin).not.toHaveBeenCalled()
  })

  it.each(['tab-recording', 'microphone-recording', 'self-video'] as const)(
    'accepts the supported %s artifact role',
    async (role) => {
      const { service } = createFixture()
      await expect(
        service.create(artifact.connectionId, {
          ...validCreateInput,
          artifact: { ...validCreateInput.artifact, role },
        }),
      ).resolves.toMatchObject({ state: 'uploading', maxConcurrency: 3 })
    },
  )

  it.each(['video/webm', 'video/mp4', 'audio/webm', 'audio/mp4'])(
    'accepts supported MIME %s',
    async (mimeType) => {
      const { service, begin } = createFixture()
      await service.create(artifact.connectionId, {
        ...validCreateInput,
        artifact: { ...validCreateInput.artifact, mimeType },
      })
      expect(begin).toHaveBeenCalledWith(expect.stringMatching(/^meeting-recordings\//), mimeType)
    },
  )

  it('normalizes MIME parameters, whitespace and casing before persistence/provider use', async () => {
    const { service, begin, inserts } = createFixture()
    await service.create(artifact.connectionId, {
      ...validCreateInput,
      artifact: { ...validCreateInput.artifact, mimeType: '  Video/WebM ; codecs=opus' },
    })
    expect(begin).toHaveBeenCalledWith(expect.any(String), 'video/webm')
    const artifactInsert = inserts.find((entry) => entry.table === recordingMediaArtifacts)
    expect(artifactInsert?.values.mimeType).toBe('video/webm')
  })

  it('rejects unsupported MIME and a filename that becomes empty after control stripping', async () => {
    const unsupported = createFixture()
    await expect(
      unsupported.service.create(artifact.connectionId, {
        ...validCreateInput,
        artifact: { ...validCreateInput.artifact, mimeType: 'application/octet-stream' },
      }),
    ).rejects.toMatchObject({ status: 422, response: { code: 'MEDIA_UPLOAD_INVALID' } })

    const emptyFilename = createFixture()
    await expect(
      emptyFilename.service.create(artifact.connectionId, {
        ...validCreateInput,
        artifact: { ...validCreateInput.artifact, filename: '\u0000\u001f\u007f' },
      }),
    ).rejects.toMatchObject({ status: 422, response: { code: 'MEDIA_UPLOAD_INVALID' } })
  })

  it('pins the exact 8 GiB artifact boundary', async () => {
    const max = 8 * 1024 * 1024 * 1024
    const allowed = createFixture()
    await expect(
      allowed.service.create(artifact.connectionId, {
        ...validCreateInput,
        artifact: { ...validCreateInput.artifact, bytes: max },
      }),
    ).resolves.toMatchObject({ state: 'uploading', partSize: 32 * 1024 * 1024 })

    const rejected = createFixture()
    await expect(
      rejected.service.create(artifact.connectionId, {
        ...validCreateInput,
        artifact: { ...validCreateInput.artifact, bytes: max + 1 },
      }),
    ).rejects.toMatchObject({
      status: 413,
      response: { code: 'MEDIA_UPLOAD_TOO_LARGE' },
    })
  })

  it('pins the exact 64 GiB connection quota boundary', async () => {
    const quota = 64 * 1024 * 1024 * 1024
    const exact = createFixture({ quotaBytes: String(quota - 5) })
    await expect(
      exact.service.create(artifact.connectionId, validCreateInput),
    ).resolves.toMatchObject({
      state: 'uploading',
    })

    const over = createFixture({ quotaBytes: String(quota - 4) })
    await expect(
      over.service.create(artifact.connectionId, validCreateInput),
    ).rejects.toMatchObject({
      status: 413,
      response: { code: 'MEDIA_QUOTA_EXCEEDED' },
    })
  })

  it.each([
    [null, 'missing'],
    [{ enabled: false }, 'disabled'],
  ] as const)('rejects a %s connection under the create lifecycle lock', async (connection) => {
    const { service, begin } = createFixture({ connection })
    await expect(service.create(artifact.connectionId, validCreateInput)).rejects.toMatchObject({
      status: 410,
      response: { code: 'MEDIA_CONNECTION_DISABLED' },
    })
    expect(begin).not.toHaveBeenCalled()
  })

  it('creates a new multipart attempt with exact persisted/provider contract and default lifetime', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T10:00:00Z'))
    try {
      const { service, begin, selections, filters, inserts, updates, connectionLock } =
        createFixture()
      const result = await service.create(artifact.connectionId, {
        ...validCreateInput,
        artifact: {
          ...validCreateInput.artifact,
          filename: 'meet\u0000ing.webm',
          mimeType: 'Video/WebM;codecs=opus',
        },
      })
      expect(result).toMatchObject({
        state: 'uploading',
        strategy: 'multipart-put-v1',
        partSize: 32 * 1024 * 1024,
        maxConcurrency: 3,
      })
      expect(result.artifactId).toMatch(/^media_[0-9a-f-]{36}$/)
      expect(result.uploadId).toMatch(/^upload_[0-9a-f-]{36}$/)

      expect(
        selections.find((entry) => entry.table === meetingRecorderConnections)?.selection,
      ).toEqual({
        enabled: meetingRecorderConnections.enabled,
      })
      expect(
        selections
          .filter((entry) => entry.table === recordingMediaArtifacts && entry.selection)
          .map((entry) => Object.keys(entry.selection!)),
      ).toContainEqual(['bytes'])
      const quotaSelection = selections.find(
        (entry) =>
          entry.table === recordingMediaArtifacts && entry.selection && 'bytes' in entry.selection,
      )!.selection!
      expect(new PgDialect().sqlToQuery(quotaSelection.bytes as never).sql).toContain(
        'coalesce(sum(',
      )
      expect(
        selections
          .filter((entry) => entry.table === recordingMediaUploads && entry.selection)
          .map((entry) => Object.keys(entry.selection!)),
      ).toContainEqual(['value'])
      const connectionFilter = filters.find((entry) => entry.table === meetingRecorderConnections)
      expect(new PgDialect().sqlToQuery(connectionFilter!.filter as never).params).toContain(
        artifact.connectionId,
      )
      const artifactFilters = filters.filter((entry) => entry.table === recordingMediaArtifacts)
      const quotaQuery = new PgDialect().sqlToQuery(artifactFilters.at(-1)!.filter as never)
      expect(quotaQuery.params).toContain(artifact.connectionId)
      expect(quotaQuery.sql).toContain('"status" != \'failed\'')

      const artifactInsert = inserts.find((entry) => entry.table === recordingMediaArtifacts)!
      expect(artifactInsert.values).toMatchObject({
        connectionId: artifact.connectionId,
        clientTransferId: validCreateInput.clientTransferId,
        externalRecordingId: artifact.externalRecordingId,
        role: 'tab-recording',
        filename: 'meeting.webm',
        mimeType: 'video/webm',
        bytes: 5,
      })
      const key = artifactInsert.values.storageKey as string
      expect(key).toMatch(
        new RegExp(`^meeting-recordings/${artifact.connectionId}/[0-9a-f-]{36}/[0-9a-f-]{36}$`),
      )
      expect(begin).toHaveBeenCalledWith(key, 'video/webm')
      expect(connectionLock).toHaveBeenCalledWith('update')
      expect(updates).toEqual([])
      const expectedFingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            artifact.externalRecordingId,
            'tab-recording',
            'meet\u0000ing.webm',
            'video/webm',
            5,
          ]),
        )
        .digest('hex')
      expect(artifactInsert.values.requestFingerprint).toBe(expectedFingerprint)

      const attemptInsert = inserts.find((entry) => entry.table === recordingMediaUploads)!
      expect(attemptInsert.values).toMatchObject({
        artifactId: artifactInsert.values.id,
        storageKey: key,
        storageUploadId: 'provider-upload-id',
        partSize: 32 * 1024 * 1024,
        expiresAt: new Date('2026-10-16T10:00:00Z'),
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the configured upload lifetime with the exact inferred config key', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T10:00:00Z'))
    try {
      const { service, inserts, config } = createFixture({ uploadLifetimeMs: 12_345 })
      await service.create(artifact.connectionId, validCreateInput)
      expect(config?.get).toHaveBeenCalledWith('MEETING_RECORDER_MEDIA_UPLOAD_LIFETIME_MS', {
        infer: true,
      })
      const attemptInsert = inserts.find((entry) => entry.table === recordingMediaUploads)!
      expect(attemptInsert.values.expiresAt).toEqual(new Date('2026-10-10T10:00:12.345Z'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an idempotency fingerprint conflict and returns an already-ready artifact', async () => {
    const conflict = createFixture({
      existing: { ...artifact, requestFingerprint: 'different', status: 'uploading' },
    })
    await expect(
      conflict.service.create(artifact.connectionId, validCreateInput),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'MEDIA_TRANSFER_CONFLICT' },
    })

    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          validCreateInput.recordingId,
          validCreateInput.artifact.role,
          validCreateInput.artifact.filename,
          validCreateInput.artifact.mimeType,
          validCreateInput.artifact.bytes,
        ]),
      )
      .digest('hex')
    const ready = createFixture({
      existing: { ...artifact, requestFingerprint: fingerprint, status: 'ready' },
    })
    await expect(ready.service.create(artifact.connectionId, validCreateInput)).resolves.toEqual({
      artifactId: `media_${artifact.id}`,
      state: 'ready',
    })
    expect(ready.begin).not.toHaveBeenCalled()
  })

  it('pins four active attempts as the concurrency limit and includes the exact lifecycle filter', async () => {
    const { service, filters, begin, selections } = createFixture({ activeCount: 4 })
    await expect(service.create(artifact.connectionId, validCreateInput)).rejects.toMatchObject({
      status: 429,
      response: { code: 'MEDIA_UPLOAD_LIMIT' },
    })
    expect(begin).not.toHaveBeenCalled()
    const activeFilter = filters.find((entry) => entry.table === recordingMediaUploads)?.filter
    const query = new PgDialect().sqlToQuery(activeFilter as never)
    expect(query.params).toEqual(expect.arrayContaining(['uploading', 'completing']))
    expect(
      selections.find((entry) => entry.table === recordingMediaUploads && entry.selection)
        ?.selection,
    ).toEqual({ value: expect.anything() })
  })

  it('pins the active completing-attempt lease cutoff in the concurrency query', async () => {
    vi.useFakeTimers()
    const clock = new Date('2026-10-10T10:00:00Z')
    vi.setSystemTime(clock)
    try {
      const { service, filters } = createFixture({ activeCount: 4 })
      await expect(service.create(artifact.connectionId, validCreateInput)).rejects.toMatchObject({
        status: 429,
      })
      const activeFilter = filters.find((entry) => entry.table === recordingMediaUploads)?.filter
      const query = new PgDialect().sqlToQuery(activeFilter as never)
      expect(query.params).toContain(new Date(clock.getTime() - 2 * 60 * 1000).toISOString())
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a missing aggregate row and a count below four as zero/available capacity', async () => {
    const missingQuota = createFixture({ quotaBytes: null, activeCount: null })
    await expect(
      missingQuota.service.create(artifact.connectionId, validCreateInput),
    ).resolves.toMatchObject({ state: 'uploading' })

    const three = createFixture({ activeCount: 3 })
    await expect(
      three.service.create(artifact.connectionId, validCreateInput),
    ).resolves.toMatchObject({
      state: 'uploading',
    })
  })

  it('aborts a provider upload when attempt persistence fails and preserves the original error', async () => {
    const failed = createFixture({ attemptReturned: false })
    await expect(
      failed.service.create(artifact.connectionId, validCreateInput),
    ).rejects.toMatchObject({
      status: 503,
      response: { code: 'MEDIA_UPLOAD_UNAVAILABLE' },
    })
    expect(failed.abort).toHaveBeenCalledWith(
      expect.stringMatching(/^meeting-recordings\//),
      'provider-upload-id',
    )

    const failedAbort = createFixture({ attemptReturned: false, abortFails: true })
    await expect(
      failedAbort.service.create(artifact.connectionId, validCreateInput),
    ).rejects.toMatchObject({
      status: 503,
      response: { code: 'MEDIA_UPLOAD_UNAVAILABLE' },
    })
    expect(failedAbort.abort).toHaveBeenCalledOnce()
  })

  it('recovers an existing completing attempt from HEAD and does not allocate another provider upload', async () => {
    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          validCreateInput.recordingId,
          validCreateInput.artifact.role,
          validCreateInput.artifact.filename,
          validCreateInput.artifact.mimeType,
          validCreateInput.artifact.bytes,
        ]),
      )
      .digest('hex')
    const latest = { ...upload, status: 'completing' }
    const recovered = createFixture({
      existing: { ...artifact, requestFingerprint, status: 'completing' },
      latest,
      head: { bytes: artifact.bytes, mimeType: 'VIDEO/WEBM; charset=utf-8' },
    })
    await expect(
      recovered.service.create(artifact.connectionId, validCreateInput),
    ).resolves.toEqual({
      artifactId: `media_${artifact.id}`,
      state: 'ready',
    })
    expect(recovered.begin).not.toHaveBeenCalled()
    expect(recovered.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: recordingMediaArtifacts,
          values: expect.objectContaining({ status: 'ready', storageKey: latest.storageKey }),
        }),
        expect.objectContaining({
          table: recordingMediaUploads,
          values: { status: 'ready' },
        }),
      ]),
    )
  })

  it('pins create-time completion and upload expiry boundaries', async () => {
    vi.useFakeTimers()
    const clock = new Date('2026-10-10T10:00:00Z')
    vi.setSystemTime(clock)
    try {
      const requestFingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            validCreateInput.recordingId,
            validCreateInput.artifact.role,
            validCreateInput.artifact.filename,
            validCreateInput.artifact.mimeType,
            validCreateInput.artifact.bytes,
          ]),
        )
        .digest('hex')
      const existing = { ...artifact, requestFingerprint, status: 'uploading' }

      const freshCompletion = createFixture({
        existing,
        latest: {
          ...upload,
          status: 'completing',
          updatedAt: new Date(clock.getTime() - 2 * 60 * 1000 + 1),
        },
      })
      await expect(
        freshCompletion.service.create(artifact.connectionId, validCreateInput),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'MEDIA_UPLOAD_COMPLETING' },
      })

      const staleCompletion = createFixture({
        existing,
        latest: {
          ...upload,
          status: 'completing',
          updatedAt: new Date(clock.getTime() - 2 * 60 * 1000),
        },
      })
      await expect(
        staleCompletion.service.create(artifact.connectionId, validCreateInput),
      ).resolves.toMatchObject({ state: 'uploading' })
      expect(staleCompletion.updates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: recordingMediaUploads,
            values: expect.objectContaining({ status: 'expired' }),
          }),
        ]),
      )

      const liveUpload = createFixture({
        existing,
        latest: { ...upload, status: 'uploading', expiresAt: new Date(clock.getTime() + 1) },
      })
      await expect(
        liveUpload.service.create(artifact.connectionId, validCreateInput),
      ).resolves.toMatchObject({
        uploadId: `upload_${upload.id}`,
      })
      expect(liveUpload.begin).not.toHaveBeenCalled()

      const expiredAtBoundary = createFixture({
        existing,
        latest: { ...upload, status: 'uploading', expiresAt: clock },
      })
      await expect(
        expiredAtBoundary.service.create(artifact.connectionId, validCreateInput),
      ).resolves.toMatchObject({ state: 'uploading' })
      expect(expiredAtBoundary.begin).toHaveBeenCalledOnce()
      expect(expiredAtBoundary.updates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: recordingMediaUploads,
            values: expect.objectContaining({ status: 'expired' }),
          }),
        ]),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('creates a replacement for an existing artifact with no previous attempt without re-inserting it', async () => {
    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          validCreateInput.recordingId,
          validCreateInput.artifact.role,
          validCreateInput.artifact.filename,
          validCreateInput.artifact.mimeType,
          validCreateInput.artifact.bytes,
        ]),
      )
      .digest('hex')
    const existing = { ...artifact, requestFingerprint, status: 'uploading' }
    const { service, inserts, updates, begin } = createFixture({ existing, latest: null })
    await expect(service.create(artifact.connectionId, validCreateInput)).resolves.toMatchObject({
      artifactId: `media_${artifact.id}`,
      state: 'uploading',
    })
    expect(begin).toHaveBeenCalledOnce()
    expect(inserts.filter((entry) => entry.table === recordingMediaArtifacts)).toHaveLength(0)
    expect(updates).toEqual([
      expect.objectContaining({
        table: recordingMediaArtifacts,
        values: { status: 'uploading' },
      }),
    ])
  })

  it('does not restore an already-uploading artifact when reusing its live attempt', async () => {
    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          validCreateInput.recordingId,
          validCreateInput.artifact.role,
          validCreateInput.artifact.filename,
          validCreateInput.artifact.mimeType,
          validCreateInput.artifact.bytes,
        ]),
      )
      .digest('hex')
    const existing = { ...artifact, requestFingerprint, status: 'uploading' }
    const live = { ...upload, status: 'uploading', expiresAt: new Date(Date.now() + 60_000) }
    const { service, updates, begin } = createFixture({ existing, latest: live })
    await expect(service.create(artifact.connectionId, validCreateInput)).resolves.toMatchObject({
      uploadId: `upload_${upload.id}`,
    })
    expect(updates).toEqual([])
    expect(begin).not.toHaveBeenCalled()
  })

  it('does not quota-check an existing non-failed artifact before replacing a terminal attempt', async () => {
    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          validCreateInput.recordingId,
          validCreateInput.artifact.role,
          validCreateInput.artifact.filename,
          validCreateInput.artifact.mimeType,
          validCreateInput.artifact.bytes,
        ]),
      )
      .digest('hex')
    const existing = { ...artifact, requestFingerprint, status: 'uploading' }
    const terminal = { ...upload, status: 'expired' }
    const { service, begin, artifactSelectCount } = createFixture({
      existing,
      latest: terminal,
      quotaBytes: String(64 * 1024 * 1024 * 1024),
    })
    await expect(service.create(artifact.connectionId, validCreateInput)).resolves.toMatchObject({
      state: 'uploading',
    })
    expect(begin).toHaveBeenCalledOnce()
    expect(artifactSelectCount()).toBe(1)
  })
})

describe('CRM media upload lifecycle contract', () => {
  it.each([
    ['not-an-upload-id', 'missing prefix'],
    [`badbad_${upload.id}`, 'wrong same-length prefix'],
    [`upload_${upload.id}x`, 'invalid UUID suffix'],
    [`xupload_${upload.id}`, 'invalid UUID prefix'],
  ])('rejects malformed external upload ids (%s: %s)', async (externalId) => {
    const { service } = fixture()
    await expect(service.status(artifact.connectionId, externalId)).rejects.toMatchObject({
      status: 404,
      response: { code: 'MEDIA_NOT_FOUND' },
    })
  })

  it('rejects a missing attempt and an attempt owned by another connection', async () => {
    const missing = fixture({ rowPresent: false })
    await expect(
      missing.service.status(artifact.connectionId, `upload_${upload.id}`),
    ).rejects.toMatchObject({ status: 404, response: { code: 'MEDIA_NOT_FOUND' } })

    const otherConnection = '55555555-5555-4555-8555-555555555555'
    const forbidden = fixture({ artifactOverrides: { connectionId: otherConnection } })
    await expect(
      forbidden.service.status(artifact.connectionId, `upload_${upload.id}`),
    ).rejects.toMatchObject({ status: 403, response: { code: 'MEDIA_FORBIDDEN' } })
  })

  it('selects the exact artifact/upload attempt projection and join/filter identity', async () => {
    const { service, dbSelections, dbFilters, joinFilters } = fixture()
    await service.status(artifact.connectionId, `upload_${upload.id}`)
    expect(Object.keys(dbSelections[0]!)).toEqual(['artifact', 'upload'])
    const joinQuery = new PgDialect().sqlToQuery(joinFilters[0] as never)
    expect(joinQuery.sql).toContain('"recording_media_uploads"."artifact_id"')
    const attemptQuery = new PgDialect().sqlToQuery(dbFilters[0] as never)
    expect(attemptQuery.params).toEqual([upload.id])
  })

  it.each(['expired', 'aborted'] as const)('treats a %s attempt as expired', async (status) => {
    const { service } = fixture({ status })
    await expect(
      service.status(artifact.connectionId, `upload_${upload.id}`),
    ).rejects.toMatchObject({
      status: 410,
      response: { code: 'MEDIA_UPLOAD_EXPIRED' },
    })
  })

  it('pins the uploading expiry boundary and completion lease boundary', async () => {
    vi.useFakeTimers()
    const clock = new Date('2026-10-10T10:00:00Z')
    vi.setSystemTime(clock)
    try {
      const expired = fixture({ status: 'uploading', expiresAt: clock })
      await expect(
        expired.service.status(artifact.connectionId, `upload_${upload.id}`),
      ).rejects.toMatchObject({ status: 410, response: { code: 'MEDIA_UPLOAD_EXPIRED' } })

      const leaseBoundary = fixture({
        status: 'completing',
        updatedAt: new Date(clock.getTime() - 2 * 60 * 1000),
      })
      await expect(
        leaseBoundary.service.status(artifact.connectionId, `upload_${upload.id}`),
      ).rejects.toMatchObject({ status: 410, response: { code: 'MEDIA_UPLOAD_EXPIRED' } })

      const leaseFresh = fixture({
        status: 'completing',
        updatedAt: new Date(clock.getTime() - 2 * 60 * 1000 + 1),
      })
      await expect(
        leaseFresh.service.status(artifact.connectionId, `upload_${upload.id}`),
      ).rejects.toMatchObject({ status: 409, response: { code: 'MEDIA_UPLOAD_COMPLETING' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns a ready artifact without listing provider parts', async () => {
    const { service, provider } = fixture({ artifactOverrides: { status: 'ready' } })
    await expect(service.status(artifact.connectionId, `upload_${upload.id}`)).resolves.toEqual({
      artifactId: `media_${artifact.id}`,
      state: 'ready',
    })
    expect(provider.listParts).not.toHaveBeenCalled()
  })

  it('maps provider part inventory to the public resume shape without leaking byte metadata', async () => {
    const { service, provider } = fixture()
    provider.listParts.mockResolvedValue([
      { partNumber: 2, etag: 'etag-2', bytes: 4 },
      { partNumber: 1, etag: 'etag-1', bytes: 5 },
    ])
    await expect(service.status(artifact.connectionId, `upload_${upload.id}`)).resolves.toEqual({
      state: 'uploading',
      artifactId: `media_${artifact.id}`,
      uploadedParts: [
        { partNumber: 2, etag: 'etag-2' },
        { partNumber: 1, etag: 'etag-1' },
      ],
    })
  })

  it('accepts a matching HEAD with MIME parameters/casing while a completion lease is active', async () => {
    const { service, provider } = fixture({ status: 'completing' })
    provider.head.mockResolvedValue({
      bytes: artifact.bytes,
      mimeType: 'VIDEO/WEBM; charset=utf-8',
    })
    await expect(service.status(artifact.connectionId, `upload_${upload.id}`)).resolves.toEqual({
      artifactId: `media_${artifact.id}`,
      state: 'ready',
    })
  })

  it('signs only safe in-range parts for an active uploading artifact', async () => {
    const { service, provider } = fixture({
      artifactOverrides: { bytes: 32 * 1024 * 1024 + 1 },
    })
    await expect(
      service.signPart(artifact.connectionId, `upload_${upload.id}`, 2),
    ).resolves.toEqual({ method: 'PUT', url: 'https://upload.example.test' })
    expect(provider.signPart).toHaveBeenCalledWith(artifact.storageKey, upload.storageUploadId, 2)
    await expect(
      service.signPart(artifact.connectionId, `upload_${upload.id}`, 1),
    ).resolves.toEqual({ method: 'PUT', url: 'https://upload.example.test' })

    for (const invalid of [0, 3, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        service.signPart(artifact.connectionId, `upload_${upload.id}`, invalid),
      ).rejects.toMatchObject({ status: 422, response: { code: 'MEDIA_PART_INVALID' } })
    }
  })

  it('refuses signing while the logical artifact or attempt is no longer uploadable', async () => {
    const completingArtifact = fixture({ artifactOverrides: { status: 'completing' } })
    await expect(
      completingArtifact.service.signPart(artifact.connectionId, `upload_${upload.id}`, 1),
    ).rejects.toMatchObject({ status: 409, response: { code: 'MEDIA_UPLOAD_COMPLETING' } })

    const completingAttempt = fixture({ status: 'completing' })
    await expect(
      completingAttempt.service.signPart(artifact.connectionId, `upload_${upload.id}`, 1),
    ).rejects.toMatchObject({ status: 409, response: { code: 'MEDIA_UPLOAD_COMPLETING' } })
  })

  it('ignores non-Gone provider failures but retires only the same latest attempt for Gone', async () => {
    const ordinary = fixture()
    ordinary.provider.listParts.mockRejectedValue(new TypeError('network'))
    await expect(
      ordinary.service.status(artifact.connectionId, `upload_${upload.id}`),
    ).rejects.toThrow('network')
    expect(ordinary.tx.update).not.toHaveBeenCalled()

    for (const latestAttempt of [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'uploading' },
      { id: upload.id, status: 'ready' },
    ]) {
      const stale = fixture({ latestAttempt })
      stale.provider.listParts.mockRejectedValue(
        new GoneException({ code: 'MEDIA_UPLOAD_EXPIRED' }),
      )
      await expect(
        stale.service.status(artifact.connectionId, `upload_${upload.id}`),
      ).rejects.toMatchObject({ status: 410 })
      expect(stale.tx.update).not.toHaveBeenCalled()
    }

    const noLatest = fixture({ latestAttempt: null })
    noLatest.provider.listParts.mockRejectedValue(
      new GoneException({ code: 'MEDIA_UPLOAD_EXPIRED' }),
    )
    await expect(
      noLatest.service.status(artifact.connectionId, `upload_${upload.id}`),
    ).rejects.toMatchObject({ status: 410, response: { code: 'MEDIA_UPLOAD_EXPIRED' } })
    expect(noLatest.tx.update).not.toHaveBeenCalled()
  })

  it('uses exact recovery lock/latest projections before expiring a missing provider session', async () => {
    const { service, provider, txSelections, txFilters, txUpdateRecords } = fixture()
    provider.listParts.mockRejectedValue(new GoneException({ code: 'MEDIA_UPLOAD_EXPIRED' }))
    await expect(
      service.status(artifact.connectionId, `upload_${upload.id}`),
    ).rejects.toMatchObject({ status: 410 })
    expect(txSelections.map((entry) => [entry.table, Object.keys(entry.selection)])).toEqual(
      expect.arrayContaining([
        [meetingRecorderConnections, ['id']],
        [recordingMediaUploads, ['id', 'status']],
      ]),
    )
    const connectionFilter = txFilters.find((entry) => entry.table === meetingRecorderConnections)
    expect(new PgDialect().sqlToQuery(connectionFilter!.filter as never).params).toContain(
      artifact.connectionId,
    )
    expect(txUpdateRecords).toEqual([
      expect.objectContaining({
        table: recordingMediaUploads,
        values: expect.objectContaining({ status: 'expired' }),
      }),
    ])
  })

  it('does not apply uploading expiry to a completing attempt', async () => {
    vi.useFakeTimers()
    const clock = new Date('2026-10-10T10:00:00Z')
    vi.setSystemTime(clock)
    try {
      const { service } = fixture({
        status: 'completing',
        expiresAt: new Date(clock.getTime() - 1),
        updatedAt: new Date(clock.getTime() - 1),
      })
      await expect(
        service.status(artifact.connectionId, `upload_${upload.id}`),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'MEDIA_UPLOAD_COMPLETING' },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('confirms provider object metadata only when both bytes and normalized MIME match', async () => {
    const { service, provider } = fixture()
    const confirmObject = (
      service as unknown as {
        confirmObject: (artifactRow: typeof artifact, uploadRow: typeof upload) => Promise<boolean>
      }
    ).confirmObject.bind(service)

    provider.head.mockResolvedValue({
      bytes: artifact.bytes,
      mimeType: 'VIDEO/WEBM; charset=utf-8',
    })
    await expect(confirmObject(artifact, upload)).resolves.toBe(true)

    provider.head.mockResolvedValue({ bytes: artifact.bytes, mimeType: 'audio/webm' })
    await expect(confirmObject(artifact, upload)).resolves.toBe(false)

    provider.head.mockResolvedValue({ bytes: artifact.bytes + 1, mimeType: artifact.mimeType })
    await expect(confirmObject(artifact, upload)).resolves.toBe(false)

    provider.head.mockResolvedValue(null)
    await expect(confirmObject(artifact, upload)).resolves.toBe(false)
  })
})

describe('CRM media multipart completion contract', () => {
  const onePartBody = { parts: [{ partNumber: 1, etag: 'etag-1' }] }

  it('returns an already-ready artifact before parsing or touching provider completion', async () => {
    const { service, provider } = fixture({ artifactOverrides: { status: 'ready' } })
    await expect(
      service.complete(artifact.connectionId, `upload_${upload.id}`, { invalid: true }),
    ).resolves.toEqual({ artifactId: `media_${artifact.id}`, state: 'ready' })
    expect(provider.listParts).not.toHaveBeenCalled()
    expect(provider.complete).not.toHaveBeenCalled()
  })

  it.each([
    [undefined, 'missing body'],
    [{}, 'missing parts'],
    [{ parts: [] }, 'empty parts'],
    [{ parts: [{ partNumber: 2, etag: 'etag-1' }] }, 'non-sequential first part'],
    [
      {
        parts: [
          { partNumber: 1, etag: 'etag-1' },
          { partNumber: 2, etag: 'etag-2' },
        ],
      },
      'wrong part count',
    ],
  ])('rejects invalid completion manifests (%s: %s)', async (body) => {
    const { service, provider } = fixture()
    await expect(
      service.complete(artifact.connectionId, `upload_${upload.id}`, body),
    ).rejects.toMatchObject({
      status: 422,
      response: { code: 'MEDIA_PARTS_INVALID' },
    })
    expect(provider.listParts).not.toHaveBeenCalled()
  })

  it('completes a valid two-part object and pins exact per-part byte geometry', async () => {
    const partSize = 32 * 1024 * 1024
    const totalBytes = partSize + 5
    const { service, provider } = fixture({ artifactOverrides: { bytes: totalBytes } })
    const parts = [
      { partNumber: 1, etag: 'etag-1' },
      { partNumber: 2, etag: 'etag-2' },
    ]
    provider.listParts.mockResolvedValue([
      { ...parts[0]!, bytes: partSize },
      { ...parts[1]!, bytes: 5 },
    ])
    provider.head
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ bytes: totalBytes, mimeType: artifact.mimeType })

    await expect(
      service.complete(artifact.connectionId, `upload_${upload.id}`, { parts }),
    ).resolves.toEqual({ artifactId: `media_${artifact.id}`, state: 'ready' })
    expect(provider.complete).toHaveBeenCalledWith(
      artifact.storageKey,
      upload.storageUploadId,
      parts,
    )
  })

  it.each([
    [[{ partNumber: 1, etag: 'etag-1', bytes: 32 * 1024 * 1024 }], 'missing final part'],
    [
      [
        { partNumber: 1, etag: 'etag-1', bytes: 32 * 1024 * 1024 },
        { partNumber: 3, etag: 'etag-2', bytes: 5 },
      ],
      'wrong part number',
    ],
    [
      [
        { partNumber: 1, etag: 'etag-1', bytes: 32 * 1024 * 1024 },
        { partNumber: 2, etag: 'wrong', bytes: 5 },
      ],
      'wrong etag',
    ],
    [
      [
        { partNumber: 1, etag: 'etag-1', bytes: 32 * 1024 * 1024 - 1 },
        { partNumber: 2, etag: 'etag-2', bytes: 5 },
      ],
      'wrong full-part bytes',
    ],
    [
      [
        { partNumber: 1, etag: 'etag-1', bytes: 32 * 1024 * 1024 },
        { partNumber: 2, etag: 'etag-2', bytes: 6 },
      ],
      'wrong final-part bytes',
    ],
    [
      [
        { partNumber: 1, etag: 'etag-1', bytes: 32 * 1024 * 1024 },
        { partNumber: 2, etag: 'etag-2', bytes: 5 },
        { partNumber: 3, etag: 'etag-3', bytes: 1 },
      ],
      'extra provider part',
    ],
  ])('rejects provider manifests with %s (%s)', async (actual) => {
    const partSize = 32 * 1024 * 1024
    const totalBytes = partSize + 5
    const { service, provider, txUpdateRecords } = fixture({
      artifactOverrides: { bytes: totalBytes },
    })
    const parts = [
      { partNumber: 1, etag: 'etag-1' },
      { partNumber: 2, etag: 'etag-2' },
    ]
    provider.listParts.mockResolvedValue(actual)
    await expect(
      service.complete(artifact.connectionId, `upload_${upload.id}`, { parts }),
    ).rejects.toMatchObject({
      status: 422,
      response: { code: 'MEDIA_PARTS_MISMATCH' },
    })
    expect(provider.complete).not.toHaveBeenCalled()
    expect(txUpdateRecords).toHaveLength(2)
    expect(txUpdateRecords.map((record) => [record.table, record.values.status])).toEqual([
      [recordingMediaUploads, 'uploading'],
      [recordingMediaArtifacts, 'uploading'],
    ])
    for (const record of txUpdateRecords) {
      const query = new PgDialect().sqlToQuery(record.filter as never)
      expect(query.params).toContain('completing')
    }
  })

  it('claims completion with an exact two-minute lease and exact projections/state transitions', async () => {
    vi.useFakeTimers()
    const clock = new Date('2026-10-10T10:00:00Z')
    vi.setSystemTime(clock)
    try {
      const {
        service,
        provider,
        dbUpdateRecords,
        returning,
        txSelections,
        txUpdateRecords,
        txFor,
      } = fixture()
      provider.head
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ bytes: artifact.bytes, mimeType: artifact.mimeType })

      await expect(
        service.complete(artifact.connectionId, `upload_${upload.id}`, onePartBody),
      ).resolves.toEqual({ artifactId: `media_${artifact.id}`, state: 'ready' })

      const claim = dbUpdateRecords[0]!
      expect(claim.table).toBe(recordingMediaUploads)
      expect(claim.values).toEqual({ status: 'completing', updatedAt: clock })
      const claimQuery = new PgDialect().sqlToQuery(claim.filter as never)
      expect(claimQuery.params).toContain(upload.id)
      expect(claimQuery.params).toContainEqual(clock)
      expect(claimQuery.params).toContainEqual(new Date(clock.getTime() - 2 * 60 * 1000))
      expect(claimQuery.sql).toContain('"status" = \'uploading\'')
      expect(claimQuery.sql).toContain('"status" = \'completing\'')
      expect(returning).toHaveBeenCalledWith({ id: recordingMediaUploads.id })

      expect(dbUpdateRecords[1]).toMatchObject({
        table: recordingMediaArtifacts,
        values: { status: 'completing' },
      })
      expect(txFor).toHaveBeenCalledWith('update')
      expect(txSelections.map((entry) => [entry.table, Object.keys(entry.selection)])).toEqual(
        expect.arrayContaining([
          [meetingRecorderConnections, ['id', 'enabled']],
          [recordingMediaUploads, ['id', 'status']],
          [recordingMediaArtifacts, ['status']],
        ]),
      )
      expect(txUpdateRecords).toEqual([
        expect.objectContaining({
          table: recordingMediaArtifacts,
          values: expect.objectContaining({
            status: 'ready',
            storageKey: artifact.storageKey,
            completedAt: clock,
          }),
        }),
        expect.objectContaining({
          table: recordingMediaUploads,
          values: { status: 'ready', updatedAt: clock },
        }),
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects completion when the lease claim loses the race', async () => {
    const { service, provider } = fixture({ claim: false })
    await expect(
      service.complete(artifact.connectionId, `upload_${upload.id}`, onePartBody),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'MEDIA_UPLOAD_COMPLETING' },
    })
    expect(provider.listParts).not.toHaveBeenCalled()
  })

  it('does not roll state back for a non-422 provider failure and preserves the original error', async () => {
    const { service, provider, txUpdateRecords, db } = fixture()
    const error = new TypeError('provider failed')
    provider.listParts.mockRejectedValue(error)
    await expect(
      service.complete(artifact.connectionId, `upload_${upload.id}`, onePartBody),
    ).rejects.toBe(error)
    expect(txUpdateRecords).toEqual([])
    expect(db.db.transaction).not.toHaveBeenCalled()
  })

  it('retires a missing provider session during completion without applying the 422 rollback', async () => {
    const { service, provider, txUpdateRecords } = fixture()
    const error = new GoneException({ code: 'MEDIA_UPLOAD_EXPIRED' })
    provider.listParts.mockRejectedValue(error)
    await expect(
      service.complete(artifact.connectionId, `upload_${upload.id}`, onePartBody),
    ).rejects.toBe(error)
    expect(txUpdateRecords).toHaveLength(1)
    expect(txUpdateRecords[0]).toMatchObject({
      table: recordingMediaUploads,
      values: expect.objectContaining({ status: 'expired' }),
    })
  })

  it('rejects a completed provider response when final HEAD metadata is still absent', async () => {
    const { service, provider } = fixture()
    provider.head.mockResolvedValue(null)
    await expect(
      service.complete(artifact.connectionId, `upload_${upload.id}`, onePartBody),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'MEDIA_OBJECT_MISMATCH' },
    })
    expect(provider.complete).toHaveBeenCalledOnce()
  })

  it.each([
    [null, 'missing latest attempt'],
    [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'completing' }, 'newer attempt'],
    [{ id: upload.id, status: 'expired' }, 'expired latest attempt'],
    [{ id: upload.id, status: 'aborted' }, 'aborted latest attempt'],
  ] as const)(
    'refuses late readiness when lifecycle has moved on (%s: %s)',
    async (latestAttempt) => {
      const { service, provider, txUpdateRecords } = fixture({ latestAttempt })
      provider.head.mockResolvedValue({ bytes: artifact.bytes, mimeType: artifact.mimeType })
      await expect(
        service.complete(artifact.connectionId, `upload_${upload.id}`, onePartBody),
      ).rejects.toMatchObject({
        status: 410,
        response: { code: 'MEDIA_UPLOAD_EXPIRED' },
      })
      expect(txUpdateRecords).toEqual([])
    },
  )

  it('refuses late readiness when the connection vanished or the artifact row disappeared', async () => {
    const missingConnection = fixture({ connectionPresent: false })
    missingConnection.provider.head.mockResolvedValue({
      bytes: artifact.bytes,
      mimeType: artifact.mimeType,
    })
    await expect(
      missingConnection.service.complete(artifact.connectionId, `upload_${upload.id}`, onePartBody),
    ).rejects.toMatchObject({
      status: 410,
      response: { code: 'MEDIA_CONNECTION_DISABLED' },
    })

    const missingArtifact = fixture({ currentArtifactPresent: false })
    missingArtifact.provider.head.mockResolvedValue({
      bytes: artifact.bytes,
      mimeType: artifact.mimeType,
    })
    await expect(
      missingArtifact.service.complete(artifact.connectionId, `upload_${upload.id}`, onePartBody),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'MEDIA_NOT_FOUND' },
    })
  })

  it('rechecks failed-artifact quota at the exact boundary and skips that query for non-failed artifacts', async () => {
    const quota = 64 * 1024 * 1024 * 1024
    const exact = fixture({ artifactStatus: 'failed', quotaBytes: String(quota - artifact.bytes) })
    exact.provider.head.mockResolvedValue({ bytes: artifact.bytes, mimeType: artifact.mimeType })
    await expect(
      exact.service.complete(artifact.connectionId, `upload_${upload.id}`, onePartBody),
    ).resolves.toEqual({ artifactId: `media_${artifact.id}`, state: 'ready' })
    const quotaSelection = exact.txSelections.find(
      (entry) => entry.table === recordingMediaArtifacts && 'bytes' in entry.selection,
    )
    expect(Object.keys(quotaSelection!.selection)).toEqual(['bytes'])
    const quotaSql = new PgDialect().sqlToQuery(quotaSelection!.selection.bytes as never)
    expect(quotaSql.sql).toContain('coalesce(sum(')
    const quotaFilter = exact.txFilters
      .filter((entry) => entry.table === recordingMediaArtifacts)
      .at(-1)!
    expect(new PgDialect().sqlToQuery(quotaFilter.filter as never).sql).toContain(
      '"status" != \'failed\'',
    )

    const missingAggregate = fixture({ artifactStatus: 'failed', quotaBytes: null })
    missingAggregate.provider.head.mockResolvedValue({
      bytes: artifact.bytes,
      mimeType: artifact.mimeType,
    })
    await expect(
      missingAggregate.service.complete(artifact.connectionId, `upload_${upload.id}`, onePartBody),
    ).resolves.toMatchObject({ state: 'ready' })

    const nonFailed = fixture({
      artifactStatus: 'uploading',
      quotaBytes: String(quota),
    })
    nonFailed.provider.head.mockResolvedValue({
      bytes: artifact.bytes,
      mimeType: artifact.mimeType,
    })
    await expect(
      nonFailed.service.complete(artifact.connectionId, `upload_${upload.id}`, onePartBody),
    ).resolves.toMatchObject({ state: 'ready' })
  })
})

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

  it('rechecks quota before a late completion revives a reconciled failed artifact', async () => {
    const { service, provider } = fixture({
      artifactStatus: 'failed',
      quotaBytes: String(64 * 1024 * 1024 * 1024),
    })
    provider.head.mockResolvedValue({ bytes: artifact.bytes, mimeType: artifact.mimeType })

    await expect(
      service.complete(artifact.connectionId, `upload_${upload.id}`, {
        parts: [{ partNumber: 1, etag: 'etag-1' }],
      }),
    ).rejects.toMatchObject({
      status: 413,
      response: { code: 'MEDIA_QUOTA_EXCEEDED' },
    })
  })

  it('does not finalize an in-flight completion after the connection is disabled', async () => {
    const { service, provider, tx } = fixture({ connectionEnabled: false })
    provider.head.mockResolvedValue({ bytes: artifact.bytes, mimeType: artifact.mimeType })

    await expect(
      service.complete(artifact.connectionId, `upload_${upload.id}`, {
        parts: [{ partNumber: 1, etag: 'etag-1' }],
      }),
    ).rejects.toMatchObject({
      status: 410,
      response: { code: 'MEDIA_CONNECTION_DISABLED' },
    })
    expect(tx.update).not.toHaveBeenCalled()
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

  it('rechecks connection quota before reviving a failed logical artifact', async () => {
    const input = {
      clientTransferId: 'transfer_1',
      recordingId: artifact.externalRecordingId,
      artifact: {
        role: 'tab-recording' as const,
        filename: 'a.webm',
        mimeType: 'video/webm',
        bytes: 5,
      },
    }
    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          input.recordingId,
          input.artifact.role,
          input.artifact.filename,
          input.artifact.mimeType,
          input.artifact.bytes,
        ]),
      )
      .digest('hex')
    const failedArtifact = {
      ...artifact,
      clientTransferId: input.clientTransferId,
      filename: input.artifact.filename,
      requestFingerprint,
      status: 'failed',
    }
    const terminalAttempt = { ...upload, status: 'expired' }
    let artifactSelects = 0
    const tx = {
      select: vi.fn(() => ({
        from: (table: unknown) => {
          if (table === meetingRecorderConnections) {
            return { where: () => ({ for: () => ({ limit: async () => [{ enabled: true }] }) }) }
          }
          if (table === recordingMediaArtifacts) {
            artifactSelects++
            if (artifactSelects === 1) {
              return { where: () => ({ limit: async () => [failedArtifact] }) }
            }
            return { where: async () => [{ bytes: String(64 * 1024 * 1024 * 1024) }] }
          }
          if (table === recordingMediaUploads) {
            return {
              where: () => ({ orderBy: () => ({ limit: async () => [terminalAttempt] }) }),
              innerJoin: () => ({ where: async () => [{ value: 0 }] }),
            }
          }
          throw new Error('Unexpected table')
        },
      })),
    }
    const db = { db: { transaction: (f: (t: typeof tx) => Promise<unknown>) => f(tx) } }
    const storage = { begin: vi.fn() }
    const service = new RecordingMediaUploadService(db as never, storage as never)

    await expect(service.create(artifact.connectionId, input)).rejects.toMatchObject({
      status: 413,
    })
    expect(storage.begin).not.toHaveBeenCalled()
    expect(artifactSelects).toBe(2)
  })

  it('restores a failed artifact before reusing its still-live upload attempt', async () => {
    const input = {
      clientTransferId: 'transfer_1',
      recordingId: artifact.externalRecordingId,
      artifact: {
        role: 'tab-recording' as const,
        filename: 'a.webm',
        mimeType: 'video/webm',
        bytes: 5,
      },
    }
    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          input.recordingId,
          input.artifact.role,
          input.artifact.filename,
          input.artifact.mimeType,
          input.artifact.bytes,
        ]),
      )
      .digest('hex')
    const failedArtifact = {
      ...artifact,
      clientTransferId: input.clientTransferId,
      filename: input.artifact.filename,
      requestFingerprint,
      status: 'failed',
    }
    let artifactSelects = 0
    const artifactSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    const tx = {
      select: vi.fn(() => ({
        from: (table: unknown) => {
          if (table === meetingRecorderConnections) {
            return { where: () => ({ for: () => ({ limit: async () => [{ enabled: true }] }) }) }
          }
          if (table === recordingMediaArtifacts) {
            artifactSelects++
            if (artifactSelects === 1) {
              return { where: () => ({ limit: async () => [failedArtifact] }) }
            }
            return { where: async () => [{ bytes: '0' }] }
          }
          if (table === recordingMediaUploads) {
            return { where: () => ({ orderBy: () => ({ limit: async () => [upload] }) }) }
          }
          throw new Error('Unexpected table')
        },
      })),
      update: vi.fn((table: unknown) => {
        expect(table).toBe(recordingMediaArtifacts)
        return { set: artifactSet }
      }),
    }
    const db = { db: { transaction: (f: (t: typeof tx) => Promise<unknown>) => f(tx) } }
    const storage = { begin: vi.fn() }
    const service = new RecordingMediaUploadService(db as never, storage as never)

    await expect(service.create(artifact.connectionId, input)).resolves.toMatchObject({
      state: 'uploading',
      uploadId: `upload_${upload.id}`,
      artifactId: `media_${artifact.id}`,
    })
    expect(artifactSet).toHaveBeenCalledWith({ status: 'uploading' })
    expect(storage.begin).not.toHaveBeenCalled()
  })
})

describe('CRM media descriptors', () => {
  it('returns only recording-scoped ready artifact metadata', async () => {
    let whereFilter: unknown
    let projection: Record<string, unknown> | undefined
    const row = {
      id: artifact.id,
      role: 'tab-recording',
      filename: 'meeting.webm',
      mimeType: 'video/webm',
      bytes: 5,
    }
    const db = {
      db: {
        select: vi.fn((selection?: Record<string, unknown>) => {
          projection = selection
          return {
            from: (table: unknown) => {
              expect(table).toBe(recordingMediaArtifacts)
              return {
                where: (filter: unknown) => {
                  whereFilter = filter
                  return { orderBy: async () => [row] }
                },
              }
            },
          }
        }),
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
    expect(Object.keys(projection!)).toEqual(['id', 'role', 'filename', 'mimeType', 'bytes'])
  })
})
