import { describe, expect, it } from 'vitest'
import {
  meetingRecorderWebhookEventSchema,
  sanitizeMeetingRecorderRecording,
} from './meeting-recorder'

const BASE_RECORDING = {
  id: 'recording_123',
  title: 'Interview',
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
    specversion: '1.0',
    id: 'event_123',
    source: 'urn:meeting-recorder:destination:producer_123',
    type: 'io.github.kstroevsky.meeting-recorder.recording.ready.v1',
    subject: 'recording/recording_123',
    time: '2026-10-07T12:01:00.000Z',
    datacontenttype: 'application/json',
    data: {
      revision: 1,
      readiness: {
        complete: true,
        release: 'complete',
        pending: [],
      },
      recording,
    },
  }
}

describe('meeting recorder webhook contract', () => {
  it('accepts the exact snapshot contract including artifact viewUrl', () => {
    const parsed = meetingRecorderWebhookEventSchema.parse(
      snapshotEvent({
        ...BASE_RECORDING,
        artifacts: [
          {
            type: 'tab-recording',
            mimeType: 'video/webm',
            bytes: 123,
            delivery: 'uploaded',
            viewUrl: 'https://example.test/view/123',
          },
        ],
      }),
    )

    expect(parsed.type).toBe('io.github.kstroevsky.meeting-recorder.recording.ready.v1')
  })

  it('rejects unknown keys recursively', () => {
    expect(() =>
      meetingRecorderWebhookEventSchema.parse({
        ...snapshotEvent(),
        unexpected: true,
      }),
    ).toThrow()

    expect(() =>
      meetingRecorderWebhookEventSchema.parse(
        snapshotEvent({
          ...BASE_RECORDING,
          source: { ...BASE_RECORDING.source, unexpected: true },
        }),
      ),
    ).toThrow()

    expect(() =>
      meetingRecorderWebhookEventSchema.parse(
        snapshotEvent({
          ...BASE_RECORDING,
          artifacts: [
            {
              type: 'notes',
              mimeType: 'text/plain',
              delivery: 'downloaded',
              unexpected: true,
            },
          ],
        }),
      ),
    ).toThrow()
  })

  it('does not impose artificial sender length limits', () => {
    const longValue = 'x'.repeat(10_000)
    expect(() =>
      meetingRecorderWebhookEventSchema.parse(
        snapshotEvent({
          ...BASE_RECORDING,
          title: longValue,
          source: {
            kind: 'meeting',
            provider: longValue,
            meetingId: longValue,
            meetingUrl: `https://example.test/${longValue}`,
          },
        }),
      ),
    ).not.toThrow()
  })

  it('requires snapshot subject to match recording.id', () => {
    expect(() =>
      meetingRecorderWebhookEventSchema.parse({
        ...snapshotEvent(),
        subject: 'recording/a-different-recording',
      }),
    ).toThrow()
  })

  it('accepts the exact integration test event and rejects extra test data', () => {
    const event = {
      specversion: '1.0',
      id: 'event_test',
      source: 'urn:meeting-recorder:destination:producer_123',
      type: 'io.github.kstroevsky.meeting-recorder.integration.test.v1',
      subject: 'integration/test',
      time: '2026-10-07T12:01:00.000Z',
      datacontenttype: 'application/json',
      data: { test: true },
    }
    expect(() => meetingRecorderWebhookEventSchema.parse(event)).not.toThrow()
    expect(() =>
      meetingRecorderWebhookEventSchema.parse({
        ...event,
        data: { test: true, unexpected: true },
      }),
    ).toThrow()
  })

  it('drops artifact viewUrl from the persisted/output recording snapshot', () => {
    const sanitized = sanitizeMeetingRecorderRecording({
      ...BASE_RECORDING,
      artifacts: [
        {
          type: 'tab-recording',
          mimeType: 'video/webm',
          delivery: 'uploaded',
          viewUrl: 'https://example.test/private',
        },
      ],
    })

    expect(sanitized.artifacts?.[0]).toEqual({
      type: 'tab-recording',
      mimeType: 'video/webm',
      delivery: 'uploaded',
    })
  })
})
