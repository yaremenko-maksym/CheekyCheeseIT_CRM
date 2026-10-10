import { HttpException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import {
  MEETING_RECORDER_TEST_EVENT_TYPE,
  MEETING_RECORDER_UPDATED_EVENT_TYPE,
  type MeetingRecorderSnapshotEvent,
  type MeetingRecorderWebhookEvent,
} from '@crm/shared'

import type { DatabaseService } from '../../database/database.service'
import {
  interviews,
  interviewRecordings,
  meetingRecorderWebhookReceipts,
} from '../../database/schema'
import type { DrizzleTx } from '../../database/types'
import type { InterviewAccessPolicyService } from '../../interviews/interview-access-policy.service'
import type { MeetingRecorderMatcher } from './meeting-recorder-matcher'
import type { MeetingRecorderSecretCryptoService } from './meeting-recorder-secret-crypto.service'
import { MeetingRecorderService } from './meeting-recorder.service'

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'

const testEvent: MeetingRecorderWebhookEvent = {
  specversion: '1.0',
  id: 'event_11111111-1111-4111-8111-111111111111',
  source: 'urn:meeting-recorder:destination:producer_test',
  type: MEETING_RECORDER_TEST_EVENT_TYPE,
  subject: 'integration/test',
  time: '2026-10-07T19:00:00.000Z',
  datacontenttype: 'application/json',
  data: { test: true },
}

function updatedEvent(revision: number): MeetingRecorderSnapshotEvent {
  return {
    specversion: '1.0',
    id: `event_revision_${revision}`,
    source: 'urn:meeting-recorder:destination:producer_test',
    type: MEETING_RECORDER_UPDATED_EVENT_TYPE,
    subject: 'recording/recording-external-1',
    time: `2026-10-07T19:0${revision}:00.000Z`,
    datacontenttype: 'application/json',
    data: {
      revision,
      readiness: { complete: true, release: 'complete', pending: [] },
      recording: {
        id: 'recording-external-1',
        title: `Revision ${revision}`,
        startedAt: '2026-10-07T18:00:00.000Z',
        durationMs: 2_520_000,
        source: {
          kind: 'meeting',
          provider: 'google-meet',
          meetingId: 'abc-defg-hij',
          meetingUrl: 'https://meet.google.com/abc-defg-hij',
        },
      },
    },
  }
}

type SnapshotIngestor = {
  ingestSnapshot(
    tx: DrizzleTx,
    connectionId: string,
    event: MeetingRecorderSnapshotEvent,
  ): Promise<void>
}

function snapshotTx(
  existingRows: unknown[],
  writtenRows: unknown[] = [{ id: 'recording-row-id' }],
) {
  const limit = vi.fn().mockResolvedValue(existingRows)
  const forUpdate = vi.fn().mockReturnValue({ limit })
  const selectWhere = vi.fn().mockReturnValue({ for: forUpdate })
  const from = vi.fn().mockReturnValue({ where: selectWhere })
  const select = vi.fn().mockReturnValue({ from })

  const insertReturning = vi.fn().mockResolvedValue(writtenRows)
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning: insertReturning })
  const insertValues = vi.fn().mockReturnValue({ onConflictDoUpdate })
  const insert = vi.fn().mockReturnValue({ values: insertValues })

  const updateWhere = vi.fn().mockResolvedValue([])
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere })
  const update = vi.fn().mockReturnValue({ set: updateSet })

  return {
    tx: { select, insert, update } as unknown as DrizzleTx,
    forUpdate,
    insert,
    insertValues,
    onConflictDoUpdate,
    insertReturning,
    update,
    updateSet,
    updateWhere,
  }
}

function webhookTx(connectionRows: unknown[]) {
  const receiptReturning = vi.fn().mockResolvedValue([{ id: 'receipt-id' }])
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning: receiptReturning })
  const receiptValues = vi.fn().mockReturnValue({ onConflictDoNothing })
  const insert = vi.fn().mockReturnValue({ values: receiptValues })

  const connectionLimit = vi.fn().mockResolvedValue(connectionRows)
  const connectionForUpdate = vi.fn().mockReturnValue({ limit: connectionLimit })
  const connectionWhere = vi.fn().mockReturnValue({ for: connectionForUpdate })
  const from = vi.fn().mockReturnValue({ where: connectionWhere })
  const select = vi.fn().mockReturnValue({ from })

  const updateWhere = vi.fn().mockResolvedValue([])
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere })
  const update = vi.fn().mockReturnValue({ set: updateSet })
  const tx = { insert, select, update }
  const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<void>) => callback(tx))

  return {
    db: { db: { transaction } } as unknown as DatabaseService,
    receiptValues,
    onConflictDoNothing,
    receiptReturning,
    connectionForUpdate,
    updateSet,
  }
}

describe('MeetingRecorderService webhook idempotency', () => {
  it('returns immediately for an already-claimed webhook before reading mutable connection state', async () => {
    const returning = vi.fn().mockResolvedValue([])
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning })
    const values = vi.fn().mockReturnValue({ onConflictDoNothing })
    const insert = vi.fn().mockReturnValue({ values })
    const select = vi.fn(() => {
      throw new Error('duplicate webhook must not read connection state')
    })
    const tx = { insert, select }
    const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<void>) => callback(tx))
    const db = { db: { transaction } } as unknown as DatabaseService

    const service = new MeetingRecorderService(
      db,
      {} as MeetingRecorderSecretCryptoService,
      {} as MeetingRecorderMatcher,
      {} as InterviewAccessPolicyService,
    )

    await expect(
      service.ingestWebhookEvent(CONNECTION_ID, testEvent, 'v1:authenticated-secret-token'),
    ).resolves.toBeUndefined()

    expect(insert).toHaveBeenCalledOnce()
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: CONNECTION_ID,
        webhookId: testEvent.id,
        eventType: testEvent.type,
        receivedAt: expect.any(Date),
      }),
    )
    expect(onConflictDoNothing).toHaveBeenCalledOnce()
    expect(onConflictDoNothing).toHaveBeenCalledWith({
      target: [
        meetingRecorderWebhookReceipts.connectionId,
        meetingRecorderWebhookReceipts.webhookId,
      ],
    })
    expect(returning).toHaveBeenCalledOnce()
    expect(returning).toHaveBeenCalledWith({ id: meetingRecorderWebhookReceipts.id })
    expect(select).not.toHaveBeenCalled()
  })

  it('rejects a claimed webhook when its connection disappeared before the locked read', async () => {
    const ctx = webhookTx([])
    const service = new MeetingRecorderService(
      ctx.db,
      {} as MeetingRecorderSecretCryptoService,
      {} as MeetingRecorderMatcher,
      {} as InterviewAccessPolicyService,
    )

    const error = await service
      .ingestWebhookEvent(CONNECTION_ID, testEvent, 'v1:authenticated-secret-token')
      .then(
        () => null,
        (reason: unknown) => reason,
      )

    expect(error).toBeInstanceOf(HttpException)
    expect((error as HttpException).getStatus()).toBe(401)
    expect((error as HttpException).getResponse()).toEqual({
      code: 'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED',
    })
    expect(ctx.connectionForUpdate).toHaveBeenCalledWith('no key update')
  })

  it('accepts a claimed test event when the locked connection still has the authenticated secret', async () => {
    const ctx = webhookTx([
      {
        id: CONNECTION_ID,
        enabled: true,
        expectedSource: testEvent.source,
        signingSecretCiphertext: 'v1:authenticated-secret-token',
      },
    ])
    const service = new MeetingRecorderService(
      ctx.db,
      {} as MeetingRecorderSecretCryptoService,
      {} as MeetingRecorderMatcher,
      {} as InterviewAccessPolicyService,
    )

    await expect(
      service.ingestWebhookEvent(CONNECTION_ID, testEvent, 'v1:authenticated-secret-token'),
    ).resolves.toBeUndefined()

    expect(ctx.connectionForUpdate).toHaveBeenCalledWith('no key update')
    expect(ctx.updateSet).toHaveBeenCalledOnce()
    expect(ctx.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ lastVerifiedAt: expect.any(Date), updatedAt: expect.any(Date) }),
    )
    expect(ctx.updateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ expectedSource: expect.any(String) }),
    )
  })

  it('rejects a claimed webhook when the connection is disabled', async () => {
    const ctx = webhookTx([
      {
        id: CONNECTION_ID,
        enabled: false,
        expectedSource: testEvent.source,
        signingSecretCiphertext: 'v1:authenticated-secret-token',
      },
    ])
    const service = new MeetingRecorderService(
      ctx.db,
      {} as MeetingRecorderSecretCryptoService,
      {} as MeetingRecorderMatcher,
      {} as InterviewAccessPolicyService,
    )

    const error = await service
      .ingestWebhookEvent(CONNECTION_ID, testEvent, 'v1:authenticated-secret-token')
      .then(
        () => null,
        (reason: unknown) => reason,
      )

    expect(error).toBeInstanceOf(HttpException)
    expect((error as HttpException).getStatus()).toBe(410)
    expect((error as HttpException).getResponse()).toEqual({
      code: 'MEETING_RECORDER_CONNECTION_DISABLED',
    })
    expect(ctx.updateSet).not.toHaveBeenCalled()
  })

  it('rejects a claimed webhook when the pinned source changes', async () => {
    const ctx = webhookTx([
      {
        id: CONNECTION_ID,
        enabled: true,
        expectedSource: 'urn:meeting-recorder:destination:another-producer',
        signingSecretCiphertext: 'v1:authenticated-secret-token',
      },
    ])
    const service = new MeetingRecorderService(
      ctx.db,
      {} as MeetingRecorderSecretCryptoService,
      {} as MeetingRecorderMatcher,
      {} as InterviewAccessPolicyService,
    )

    const error = await service
      .ingestWebhookEvent(CONNECTION_ID, testEvent, 'v1:authenticated-secret-token')
      .then(
        () => null,
        (reason: unknown) => reason,
      )

    expect(error).toBeInstanceOf(HttpException)
    expect((error as HttpException).getStatus()).toBe(403)
    expect((error as HttpException).getResponse()).toEqual({
      code: 'MEETING_RECORDER_SOURCE_MISMATCH',
    })
    expect(ctx.updateSet).not.toHaveBeenCalled()
  })

  it('pins the source before accepting the first authenticated test event', async () => {
    const ctx = webhookTx([
      {
        id: CONNECTION_ID,
        enabled: true,
        expectedSource: null,
        signingSecretCiphertext: 'v1:authenticated-secret-token',
      },
    ])
    const service = new MeetingRecorderService(
      ctx.db,
      {} as MeetingRecorderSecretCryptoService,
      {} as MeetingRecorderMatcher,
      {} as InterviewAccessPolicyService,
    )

    await expect(
      service.ingestWebhookEvent(CONNECTION_ID, testEvent, 'v1:authenticated-secret-token'),
    ).resolves.toBeUndefined()

    expect(ctx.updateSet).toHaveBeenCalledTimes(2)
    expect(ctx.updateSet).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        expectedSource: testEvent.source,
        updatedAt: expect.any(Date),
      }),
    )
    expect(ctx.updateSet).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        lastVerifiedAt: expect.any(Date),
        updatedAt: expect.any(Date),
      }),
    )
  })

  it('dispatches authenticated snapshot events instead of marking them as test verification', async () => {
    const ctx = webhookTx([
      {
        id: CONNECTION_ID,
        enabled: true,
        expectedSource: testEvent.source,
        signingSecretCiphertext: 'v1:authenticated-secret-token',
      },
    ])
    const service = new MeetingRecorderService(
      ctx.db,
      {} as MeetingRecorderSecretCryptoService,
      {} as MeetingRecorderMatcher,
      {} as InterviewAccessPolicyService,
    )
    const snapshotSpy = vi
      .spyOn(service as unknown as SnapshotIngestor, 'ingestSnapshot')
      .mockResolvedValue(undefined)
    const event = updatedEvent(1)

    await expect(
      service.ingestWebhookEvent(CONNECTION_ID, event, 'v1:authenticated-secret-token'),
    ).resolves.toBeUndefined()

    expect(snapshotSpy).toHaveBeenCalledOnce()
    expect(snapshotSpy).toHaveBeenCalledWith(expect.anything(), CONNECTION_ID, event)
    expect(ctx.updateSet).not.toHaveBeenCalled()
  })

  it('rejects a non-duplicate webhook if the signing secret changed after authentication', async () => {
    const receiptReturning = vi.fn().mockResolvedValue([{ id: 'receipt-id' }])
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning: receiptReturning })
    const values = vi.fn().mockReturnValue({ onConflictDoNothing })
    const insert = vi.fn().mockReturnValue({ values })

    const limit = vi.fn().mockResolvedValue([
      {
        id: CONNECTION_ID,
        enabled: true,
        expectedSource: null,
        signingSecretCiphertext: 'v1:new-secret-token',
      },
    ])
    const forUpdate = vi.fn().mockReturnValue({ limit })
    const where = vi.fn().mockReturnValue({ for: forUpdate })
    const from = vi.fn().mockReturnValue({ where })
    const select = vi.fn().mockReturnValue({ from })
    const tx = { insert, select }
    const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<void>) => callback(tx))
    const db = { db: { transaction } } as unknown as DatabaseService

    const service = new MeetingRecorderService(
      db,
      {} as MeetingRecorderSecretCryptoService,
      {} as MeetingRecorderMatcher,
      {} as InterviewAccessPolicyService,
    )

    const error = await service
      .ingestWebhookEvent(CONNECTION_ID, testEvent, 'v1:old-secret-token')
      .then(
        () => null,
        (reason: unknown) => reason,
      )

    expect(error).toBeInstanceOf(HttpException)
    expect((error as HttpException).getStatus()).toBe(401)
    expect((error as HttpException).getResponse()).toEqual({
      code: 'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED',
    })
    expect(forUpdate).toHaveBeenCalledWith('no key update')
  })
})

describe('MeetingRecorderService manual linking lock order', () => {
  const targetInterviewId = '22222222-2222-4222-8222-222222222222'
  const recordingId = '33333333-3333-4333-8333-333333333333'
  const actor = {
    id: '44444444-4444-4444-8444-444444444444',
    role: 'ADMIN',
  } as never
  const target = { id: targetInterviewId, seniorId: 'senior-1', stage: 'TECH_INTERVIEW' }
  const recording = {
    id: recordingId,
    interviewId: null,
    connectionId: CONNECTION_ID,
    externalRecordingId: 'recording-external-1',
    revision: 1,
    source: testEvent.source,
    title: 'Recording',
    startedAt: new Date('2026-10-07T18:00:00.000Z'),
    endedAt: null,
    durationMs: null,
    provider: null,
    meetingId: null,
    meetingUrl: null,
    stageAtLink: null,
    matchedBy: 'unmatched',
    autoMatchSuppressed: false,
    readiness: { complete: true, release: 'complete', pending: [] },
    snapshot: {
      id: 'recording-external-1',
      title: 'Recording',
      startedAt: '2026-10-07T18:00:00.000Z',
      source: {
        kind: 'meeting',
        provider: 'google-meet',
        meetingId: 'abc-defg-hij',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
      },
    },
    linkedByUserId: null,
    linkedAt: null,
    lastEventAt: new Date('2026-10-07T19:00:00.000Z'),
    createdAt: new Date('2026-10-07T19:00:00.000Z'),
    updatedAt: new Date('2026-10-07T19:00:00.000Z'),
  }

  function makeLinkHarness(options: { targetRows?: (typeof target)[] } = {}) {
    const lockOrder: string[] = []
    const lockModes: Array<[string, string]> = []
    const selectProjections: unknown[] = []

    const tx = {
      select: vi.fn((projection?: unknown) => {
        selectProjections.push(projection)
        return {
          from: (table: unknown) => ({
            where: () => ({
              for: (mode: string) => {
                const kind = table === interviewRecordings ? 'recording' : 'interview'
                lockOrder.push(kind)
                lockModes.push([kind, mode])
                return {
                  limit: async () =>
                    kind === 'recording' ? [recording] : (options.targetRows ?? [target]),
                }
              },
            }),
          }),
        }
      }),
      update: vi.fn(() => ({
        set: (patch: Record<string, unknown>) => ({
          where: () => ({ returning: async () => [{ ...recording, ...patch }] }),
        }),
      })),
      insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    }
    const db = {
      db: { transaction: (cb: (value: typeof tx) => Promise<unknown>) => cb(tx) },
    } as unknown as DatabaseService
    const access = {
      assertUpdateAccess: vi.fn().mockResolvedValue(undefined),
    } as unknown as InterviewAccessPolicyService
    const service = new MeetingRecorderService(
      db,
      {} as MeetingRecorderSecretCryptoService,
      {} as MeetingRecorderMatcher,
      access,
    )

    return { service, access, tx, lockOrder, lockModes, selectProjections }
  }

  it('locks the target interview with NO KEY UPDATE before locking the recording', async () => {
    const { service, access, lockOrder, lockModes, selectProjections } = makeLinkHarness()

    await service.linkRecording(recordingId, { interviewId: targetInterviewId }, actor)

    expect(lockOrder).toEqual(['interview', 'recording'])
    expect(lockModes).toEqual([
      ['interview', 'no key update'],
      ['recording', 'update'],
    ])
    expect(selectProjections[0]).toEqual({
      id: interviews.id,
      seniorId: interviews.seniorId,
      stage: interviews.stage,
    })
    expect(access.assertUpdateAccess).toHaveBeenCalledWith(target, actor)
  })

  it('does not lock or authorize an interview when manually unlinking', async () => {
    const { service, access, lockOrder, lockModes } = makeLinkHarness()

    await service.linkRecording(recordingId, { interviewId: null }, actor)

    expect(lockOrder).toEqual(['recording'])
    expect(lockModes).toEqual([['recording', 'update']])
    expect(access.assertUpdateAccess).not.toHaveBeenCalled()
  })

  it('fails before locking the recording when the target interview does not exist', async () => {
    const { service, access, tx, lockOrder } = makeLinkHarness({ targetRows: [] })

    await expect(
      service.linkRecording(recordingId, { interviewId: targetInterviewId }, actor),
    ).rejects.toMatchObject({
      response: { code: 'INTERVIEW_NOT_FOUND' },
    })

    expect(lockOrder).toEqual(['interview'])
    expect(access.assertUpdateAccess).not.toHaveBeenCalled()
    expect(tx.update).not.toHaveBeenCalled()
  })
})

describe('MeetingRecorderService snapshot revision semantics', () => {
  it('ignores an older revision before matching or writing recording state', async () => {
    const matcher = { findExactMatch: vi.fn() } as unknown as MeetingRecorderMatcher
    const service = new MeetingRecorderService(
      {} as DatabaseService,
      {} as MeetingRecorderSecretCryptoService,
      matcher,
      {} as InterviewAccessPolicyService,
    )
    const ctx = snapshotTx([
      {
        revision: 2,
        interviewId: '22222222-2222-4222-8222-222222222222',
        stageAtLink: 'TECH_INTERVIEW',
        matchedBy: 'meeting-id',
        linkedByUserId: null,
        linkedAt: null,
      },
    ])

    await expect(
      (service as unknown as SnapshotIngestor).ingestSnapshot(
        ctx.tx,
        CONNECTION_ID,
        updatedEvent(1),
      ),
    ).resolves.toBeUndefined()

    expect(matcher.findExactMatch).not.toHaveBeenCalled()
    expect(ctx.insert).not.toHaveBeenCalled()
    expect(ctx.update).not.toHaveBeenCalled()
    expect(ctx.forUpdate).toHaveBeenCalledWith('update')
  })

  it('ignores an equal revision before matching or writing recording state', async () => {
    const matcher = { findExactMatch: vi.fn() } as unknown as MeetingRecorderMatcher
    const service = new MeetingRecorderService(
      {} as DatabaseService,
      {} as MeetingRecorderSecretCryptoService,
      matcher,
      {} as InterviewAccessPolicyService,
    )
    const ctx = snapshotTx([
      {
        revision: 2,
        interviewId: null,
        stageAtLink: null,
        matchedBy: 'unmatched',
        autoMatchSuppressed: false,
        linkedByUserId: null,
        linkedAt: null,
      },
    ])

    await expect(
      (service as unknown as SnapshotIngestor).ingestSnapshot(
        ctx.tx,
        CONNECTION_ID,
        updatedEvent(2),
      ),
    ).resolves.toBeUndefined()

    expect(matcher.findExactMatch).not.toHaveBeenCalled()
    expect(ctx.insert).not.toHaveBeenCalled()
    expect(ctx.update).not.toHaveBeenCalled()
  })

  it('matches a new recording and persists its source metadata', async () => {
    const matcher = {
      findExactMatch: vi.fn().mockResolvedValue({
        interviewId: '22222222-2222-4222-8222-222222222222',
        stageAtLink: 'TECH_INTERVIEW',
        matchedBy: 'meeting-id',
      }),
    } as unknown as MeetingRecorderMatcher
    const service = new MeetingRecorderService(
      {} as DatabaseService,
      {} as MeetingRecorderSecretCryptoService,
      matcher,
      {} as InterviewAccessPolicyService,
    )
    const ctx = snapshotTx([])

    await expect(
      (service as unknown as SnapshotIngestor).ingestSnapshot(
        ctx.tx,
        CONNECTION_ID,
        updatedEvent(1),
      ),
    ).resolves.toBeUndefined()

    expect(matcher.findExactMatch).toHaveBeenCalledOnce()
    expect(ctx.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: 2_520_000,
        provider: 'google-meet',
        meetingId: 'abc-defg-hij',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        interviewId: '22222222-2222-4222-8222-222222222222',
        matchedBy: 'meeting-id',
        autoMatchSuppressed: false,
      }),
    )
    expect(ctx.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: [interviewRecordings.connectionId, interviewRecordings.externalRecordingId],
      }),
    )
    expect(ctx.insertReturning).toHaveBeenCalledWith({ id: interviewRecordings.id })
    expect(ctx.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        lastEventAt: new Date('2026-10-07T19:01:00.000Z'),
        updatedAt: expect.any(Date),
      }),
    )
  })

  it('retries exact matching for an unmatched recording that was not manually suppressed', async () => {
    const matcher = {
      findExactMatch: vi.fn().mockResolvedValue({
        interviewId: '22222222-2222-4222-8222-222222222222',
        stageAtLink: 'TECH_INTERVIEW',
        matchedBy: 'meeting-id',
      }),
    } as unknown as MeetingRecorderMatcher
    const service = new MeetingRecorderService(
      {} as DatabaseService,
      {} as MeetingRecorderSecretCryptoService,
      matcher,
      {} as InterviewAccessPolicyService,
    )
    const ctx = snapshotTx([
      {
        revision: 1,
        interviewId: null,
        stageAtLink: null,
        matchedBy: 'unmatched',
        autoMatchSuppressed: false,
        linkedByUserId: null,
        linkedAt: null,
      },
    ])

    await expect(
      (service as unknown as SnapshotIngestor).ingestSnapshot(
        ctx.tx,
        CONNECTION_ID,
        updatedEvent(2),
      ),
    ).resolves.toBeUndefined()

    expect(matcher.findExactMatch).toHaveBeenCalledOnce()
    expect(ctx.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 2,
        interviewId: '22222222-2222-4222-8222-222222222222',
        stageAtLink: 'TECH_INTERVIEW',
        matchedBy: 'meeting-id',
        autoMatchSuppressed: false,
      }),
    )
  })

  it('keeps a new recording unmatched when no exact interview match exists', async () => {
    const matcher = {
      findExactMatch: vi.fn().mockResolvedValue(null),
    } as unknown as MeetingRecorderMatcher
    const service = new MeetingRecorderService(
      {} as DatabaseService,
      {} as MeetingRecorderSecretCryptoService,
      matcher,
      {} as InterviewAccessPolicyService,
    )
    const ctx = snapshotTx([])

    await expect(
      (service as unknown as SnapshotIngestor).ingestSnapshot(
        ctx.tx,
        CONNECTION_ID,
        updatedEvent(1),
      ),
    ).resolves.toBeUndefined()

    expect(matcher.findExactMatch).toHaveBeenCalledOnce()
    expect(ctx.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        interviewId: null,
        stageAtLink: null,
        matchedBy: 'unmatched',
        autoMatchSuppressed: false,
      }),
    )
  })

  it('advances a manually linked recording in place without re-matching it', async () => {
    const linkedAt = new Date('2026-10-07T18:30:00.000Z')
    const matcher = { findExactMatch: vi.fn() } as unknown as MeetingRecorderMatcher
    const service = new MeetingRecorderService(
      {} as DatabaseService,
      {} as MeetingRecorderSecretCryptoService,
      matcher,
      {} as InterviewAccessPolicyService,
    )
    const ctx = snapshotTx([
      {
        revision: 1,
        interviewId: '22222222-2222-4222-8222-222222222222',
        stageAtLink: 'TECH_INTERVIEW',
        matchedBy: 'manual',
        autoMatchSuppressed: false,
        linkedByUserId: '33333333-3333-4333-8333-333333333333',
        linkedAt,
      },
    ])

    await expect(
      (service as unknown as SnapshotIngestor).ingestSnapshot(
        ctx.tx,
        CONNECTION_ID,
        updatedEvent(2),
      ),
    ).resolves.toBeUndefined()

    expect(matcher.findExactMatch).not.toHaveBeenCalled()
    expect(ctx.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: CONNECTION_ID,
        externalRecordingId: 'recording-external-1',
        revision: 2,
        title: 'Revision 2',
        interviewId: '22222222-2222-4222-8222-222222222222',
        stageAtLink: 'TECH_INTERVIEW',
        matchedBy: 'manual',
        autoMatchSuppressed: false,
        linkedByUserId: '33333333-3333-4333-8333-333333333333',
        linkedAt,
      }),
    )
    expect(ctx.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          revision: 2,
          title: 'Revision 2',
          interviewId: '22222222-2222-4222-8222-222222222222',
          stageAtLink: 'TECH_INTERVIEW',
          matchedBy: 'manual',
          autoMatchSuppressed: false,
          linkedByUserId: '33333333-3333-4333-8333-333333333333',
          linkedAt,
        }),
      }),
    )
    expect(ctx.update).toHaveBeenCalledOnce()
  })

  it('keeps an administrator-unlinked recording unmatched on later revisions', async () => {
    const matcher = { findExactMatch: vi.fn() } as unknown as MeetingRecorderMatcher
    const service = new MeetingRecorderService(
      {} as DatabaseService,
      {} as MeetingRecorderSecretCryptoService,
      matcher,
      {} as InterviewAccessPolicyService,
    )
    const ctx = snapshotTx([
      {
        revision: 1,
        interviewId: null,
        stageAtLink: null,
        matchedBy: 'unmatched',
        autoMatchSuppressed: true,
        linkedByUserId: null,
        linkedAt: null,
      },
    ])

    await expect(
      (service as unknown as SnapshotIngestor).ingestSnapshot(
        ctx.tx,
        CONNECTION_ID,
        updatedEvent(2),
      ),
    ).resolves.toBeUndefined()

    expect(matcher.findExactMatch).not.toHaveBeenCalled()
    expect(ctx.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 2,
        interviewId: null,
        matchedBy: 'unmatched',
        autoMatchSuppressed: true,
      }),
    )
  })

  it('does not advance connection activity when a concurrent newer revision wins the upsert', async () => {
    const matcher = { findExactMatch: vi.fn() } as unknown as MeetingRecorderMatcher
    const service = new MeetingRecorderService(
      {} as DatabaseService,
      {} as MeetingRecorderSecretCryptoService,
      matcher,
      {} as InterviewAccessPolicyService,
    )
    const ctx = snapshotTx(
      [
        {
          revision: 1,
          interviewId: '22222222-2222-4222-8222-222222222222',
          stageAtLink: 'TECH_INTERVIEW',
          matchedBy: 'manual',
          autoMatchSuppressed: false,
          linkedByUserId: null,
          linkedAt: null,
        },
      ],
      [],
    )

    await expect(
      (service as unknown as SnapshotIngestor).ingestSnapshot(
        ctx.tx,
        CONNECTION_ID,
        updatedEvent(2),
      ),
    ).resolves.toBeUndefined()

    expect(ctx.insert).toHaveBeenCalledOnce()
    expect(ctx.update).not.toHaveBeenCalled()
  })
})
