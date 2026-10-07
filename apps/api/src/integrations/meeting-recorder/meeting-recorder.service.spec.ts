import { HttpException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { MEETING_RECORDER_TEST_EVENT_TYPE, type MeetingRecorderWebhookEvent } from '@crm/shared'

import type { DatabaseService } from '../../database/database.service'
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
