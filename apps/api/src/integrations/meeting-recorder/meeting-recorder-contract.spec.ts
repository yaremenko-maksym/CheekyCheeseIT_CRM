import {
  MEETING_RECORDER_READY_EVENT_TYPE,
  meetingRecorderSigningSecretSchema,
  meetingRecorderWebhookEventSchema,
  sanitizeMeetingRecorderRecording,
} from '@crm/shared'
import { describe, expect, it } from 'vitest'

const BASE_RECORDING = {
  id: 'recording_5d8938da-0470-48ce-b985-5cfbb478e825',
  title: 'Backend contract fixture',
  startedAt: '2026-10-07T12:00:00.000Z',
  source: {
    kind: 'meeting' as const,
    provider: 'google-meet',
    meetingId: 'abc-defg-hij',
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
  },
}

function snapshotEvent(recording: Record<string, unknown> = BASE_RECORDING) {
  return {
    specversion: '1.0' as const,
    id: 'event_5f074ea3-b0dc-4fcf-8d06-aeb27ed98521',
    source: 'urn:meeting-recorder:destination:producer_123',
    type: MEETING_RECORDER_READY_EVENT_TYPE,
    subject: `recording/${String(recording['id'])}`,
    time: '2026-10-07T12:01:00.000Z',
    datacontenttype: 'application/json' as const,
    data: {
      revision: 1,
      readiness: { complete: true, release: 'complete' as const, pending: [] },
      recording,
    },
  }
}

describe('meeting recorder backend V1 contract boundary', () => {
  it('accepts sender-valid fractional durationMs and preserves it through sanitization', () => {
    const parsed = meetingRecorderWebhookEventSchema.parse(
      snapshotEvent({ ...BASE_RECORDING, durationMs: 1234.5 }),
    )
    if (!('recording' in parsed.data)) throw new Error('expected snapshot event')

    const stored = sanitizeMeetingRecorderRecording(parsed.data.recording)
    expect(stored.durationMs).toBe(1234.5)
  })

  it('accepts artifact viewUrl as signed V1 input but removes it from the stored snapshot', () => {
    const parsed = meetingRecorderWebhookEventSchema.parse(
      snapshotEvent({
        ...BASE_RECORDING,
        artifacts: [
          {
            type: 'tab-recording',
            mimeType: 'video/webm',
            bytes: 42,
            delivery: 'uploaded',
            viewUrl: 'https://extension.invalid/private-object-url',
          },
        ],
      }),
    )
    if (!('recording' in parsed.data)) throw new Error('expected snapshot event')

    const stored = sanitizeMeetingRecorderRecording(parsed.data.recording)
    expect(stored.artifacts?.[0]).toEqual({
      type: 'tab-recording',
      mimeType: 'video/webm',
      bytes: 42,
      delivery: 'uploaded',
    })
    expect(stored.artifacts?.[0]).not.toHaveProperty('viewUrl')
  })

  it('rejects an unknown field at nested V1 object levels', () => {
    const invalid = snapshotEvent({
      ...BASE_RECORDING,
      source: { ...BASE_RECORDING.source, receiverOnlyField: true },
    })

    const result = meetingRecorderWebhookEventSchema.safeParse(invalid)
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected strict V1 schema rejection')
    expect(result.error.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true)
  })

  it('rejects unsupported event types rather than prefix-matching them', () => {
    const invalid = {
      ...snapshotEvent(),
      type: `${MEETING_RECORDER_READY_EVENT_TYPE}.future`,
    }

    expect(meetingRecorderWebhookEventSchema.safeParse(invalid).success).toBe(false)
  })

  it('rejects invalid CloudEvent timestamps at the contract boundary', () => {
    const invalid = { ...snapshotEvent(), time: '2026-10-07 12:01:00' }
    expect(meetingRecorderWebhookEventSchema.safeParse(invalid).success).toBe(false)
  })

  it('does not invent receiver-only maxLength limits for sender strings', () => {
    const longValue = 'x'.repeat(128 * 1024)
    const event = snapshotEvent({
      ...BASE_RECORDING,
      title: longValue,
      source: {
        kind: 'meeting',
        provider: longValue,
        meetingId: longValue,
        meetingUrl: `https://example.test/${longValue}`,
      },
    })

    expect(meetingRecorderWebhookEventSchema.safeParse(event).success).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(event), 'utf8')).toBeLessThan(2 * 1024 * 1024)
  })

  it('accepts signing secrets only at the published 24-64 decoded-byte boundary', () => {
    const secret = (bytes: number) => `whsec_${Buffer.alloc(bytes).toString('base64')}`

    expect(meetingRecorderSigningSecretSchema.safeParse(secret(24)).success).toBe(true)
    expect(meetingRecorderSigningSecretSchema.safeParse(secret(64)).success).toBe(true)
    expect(meetingRecorderSigningSecretSchema.safeParse(secret(23)).success).toBe(false)
    expect(meetingRecorderSigningSecretSchema.safeParse(secret(65)).success).toBe(false)
    expect(meetingRecorderSigningSecretSchema.safeParse('not_whsec').success).toBe(false)
  })
})
