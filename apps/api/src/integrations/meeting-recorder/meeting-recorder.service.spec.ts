import { HttpException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import {
  MEETING_RECORDER_TEST_EVENT_TYPE,
  MEETING_RECORDER_UPDATED_EVENT_TYPE,
  type MeetingRecorderSnapshotEvent,
  type MeetingRecorderWebhookEvent,
} from '@crm/shared'

import type { DatabaseService } from '../../database/database.service'
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

function snapshotTx(existingRows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(existingRows)
  const forUpdate = vi.fn().mockReturnValue({ limit })
  const selectWhere = vi.fn().mockReturnValue({ for: forUpdate })
  const from = vi.fn().mockReturnValue({ where: selectWhere })
  const select = vi.fn().mockReturnValue({ from })

  const insertReturning = vi.fn().mockResolvedValue([{ id: 'recording-row-id' }])
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning: insertReturning })
  const insertValues = vi.fn().mockReturnValue({ onConflictDoUpdate })
  const insert = vi.fn().mockReturnValue({ values: insertValues })

  const updateWhere = vi.fn().mockResolvedValue([])
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere })
  const update = vi.fn().mockReturnValue({ set: updateSet })

  return {
    tx: { select, insert, update } as unknown as DrizzleTx,
    insert,
    insertValues,
    onConflictDoUpdate,
    update,
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
    expect(onConflictDoNothing).toHaveBeenCalledOnce()
    expect(returning).toHaveBeenCalledOnce()
    expect(select).not.toHaveBeenCalled()
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
          linkedByUserId: '33333333-3333-4333-8333-333333333333',
          linkedAt,
        }),
      }),
    )
    expect(ctx.update).toHaveBeenCalledOnce()
  })
})
