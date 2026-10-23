import {
  MEETING_RECORDER_INDEXED_IDENTIFIER_MAX_CHARS,
  MEETING_RECORDER_LABEL_MAX_CHARS,
  MEETING_RECORDER_READY_EVENT_TYPE,
  MEETING_RECORDER_TITLE_MAX_CHARS,
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

  // CR-865-M-7: a field the extension adds later is dropped, not a permanent 422.
  it('drops an unknown field at nested V1 object levels instead of rejecting the event', () => {
    const extended = snapshotEvent({
      ...BASE_RECORDING,
      source: { ...BASE_RECORDING.source, receiverOnlyField: true },
    })

    const result = meetingRecorderWebhookEventSchema.safeParse(extended)
    expect(result.success).toBe(true)
    expect(JSON.stringify(result.data)).not.toContain('receiverOnlyField')
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

  it('rejects non-HTTPS meeting URLs before they can reach browser links', () => {
    for (const meetingUrl of [
      'http://meet.google.com/abc-defg-hij',
      'javascript:alert(1)',
      'data:text/html,<h1>unsafe</h1>',
    ]) {
      expect(
        meetingRecorderWebhookEventSchema.safeParse(
          snapshotEvent({
            ...BASE_RECORDING,
            source: { ...BASE_RECORDING.source, meetingUrl },
          }),
        ).success,
      ).toBe(false)
    }
  })

  // CR-865-M-7: displayed sender strings carry their own bound, not only the 2 MiB envelope.
  // CR-M-1 (fix round 1): that bound TRUNCATES free text instead of refusing it — a refusal on
  // provider-chosen text is a 422 the provider retries forever, the failure this task removed.
  it.each([
    ['title', { title: 'x'.repeat(MEETING_RECORDER_TITLE_MAX_CHARS + 1) }],
    [
      'provider',
      {
        source: {
          ...BASE_RECORDING.source,
          provider: 'x'.repeat(MEETING_RECORDER_LABEL_MAX_CHARS + 1),
        },
      },
    ],
  ])('truncates an over-length displayed sender %s rather than refusing it', (_label, override) => {
    const parsed = meetingRecorderWebhookEventSchema.safeParse(
      snapshotEvent({ ...BASE_RECORDING, ...override }),
    )

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(JSON.stringify(parsed.data)).toContain('…')
  })

  // The matching URL is NOT display text: a truncated URL would match the wrong interview (or
  // nothing), so this one still refuses.
  it('still refuses a meetingUrl above its bound, because the matcher compares it', () => {
    expect(
      meetingRecorderWebhookEventSchema.safeParse(
        snapshotEvent({
          ...BASE_RECORDING,
          source: {
            ...BASE_RECORDING.source,
            meetingUrl: `https://example.test/${'x'.repeat(2_048)}`,
          },
        }),
      ).success,
    ).toBe(false)
  })

  it('rejects indexed identifiers above the published V1 bound', () => {
    const overLimit = 'x'.repeat(MEETING_RECORDER_INDEXED_IDENTIFIER_MAX_CHARS + 1)

    expect(
      meetingRecorderWebhookEventSchema.safeParse({ ...snapshotEvent(), id: overLimit }).success,
    ).toBe(false)
    expect(
      meetingRecorderWebhookEventSchema.safeParse(
        snapshotEvent({
          ...BASE_RECORDING,
          source: { ...BASE_RECORDING.source, meetingId: overLimit },
        }),
      ).success,
    ).toBe(false)
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
