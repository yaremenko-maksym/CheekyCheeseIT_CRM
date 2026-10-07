import { describe, expect, it } from 'vitest'
import {
  createMeetingRecorderConnectionSchema,
  linkMeetingRecorderRecordingSchema,
  meetingRecorderArtifactStoredSchema,
  meetingRecorderIntegrationTestEventSchema,
  meetingRecorderReadyEventSchema,
  meetingRecorderRecordingDetailSchema,
  meetingRecorderSigningSecretSchema,
  meetingRecorderUnmatchedRecordingSchema,
  meetingRecorderUpdatedEventSchema,
  setMeetingRecorderSecretSchema,
  updateMeetingRecorderConnectionSchema,
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
    expect(() => meetingRecorderIntegrationTestEventSchema.parse(event)).not.toThrow()
    expect(() => meetingRecorderWebhookEventSchema.parse(event)).not.toThrow()
    expect(() =>
      meetingRecorderWebhookEventSchema.parse({
        ...event,
        data: { test: true, unexpected: true },
      }),
    ).toThrow()
  })

  it('exports exact ready and updated V1 event schemas', () => {
    expect(() => meetingRecorderReadyEventSchema.parse(snapshotEvent())).not.toThrow()
    expect(() =>
      meetingRecorderUpdatedEventSchema.parse({
        ...snapshotEvent(),
        type: 'io.github.kstroevsky.meeting-recorder.recording.updated.v1',
      }),
    ).not.toThrow()
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
    expect(() =>
      meetingRecorderArtifactStoredSchema.parse({
        type: 'tab-recording',
        mimeType: 'video/webm',
        delivery: 'uploaded',
        viewUrl: 'https://example.test/private',
      }),
    ).toThrow()
  })

  it('validates whsec_ secrets by canonical base64 decoded size, including unpadded input', () => {
    const secret = (bytes: number) => `whsec_${Buffer.alloc(bytes).toString('base64')}`

    expect(meetingRecorderSigningSecretSchema.parse(secret(24))).toBe(secret(24))
    expect(meetingRecorderSigningSecretSchema.parse(secret(64))).toBe(secret(64))
    const unpadded25 = secret(25).replace(/=+$/, '')
    const unpadded26 = secret(26).replace(/=+$/, '')
    expect(meetingRecorderSigningSecretSchema.parse(unpadded25)).toBe(unpadded25)
    expect(meetingRecorderSigningSecretSchema.parse(unpadded26)).toBe(unpadded26)
    expect(() => meetingRecorderSigningSecretSchema.parse(secret(23))).toThrow()
    expect(() => meetingRecorderSigningSecretSchema.parse(secret(65))).toThrow()
    expect(() => meetingRecorderSigningSecretSchema.parse('not-a-webhook-secret')).toThrow()
    expect(() => meetingRecorderSigningSecretSchema.parse('whsec_not-base64!')).toThrow()

    // 25 zero bytes canonically end in `AA==`. Changing the final data sextet
    // to `B` keeps the decoded length but makes the base64 representation non-canonical.
    expect(() => meetingRecorderSigningSecretSchema.parse(`whsec_${'A'.repeat(33)}B==`)).toThrow()
  })

  it('keeps connection and link write DTOs strict', () => {
    expect(createMeetingRecorderConnectionSchema.parse({ name: 'Recorder A' })).toEqual({
      name: 'Recorder A',
    })
    expect(updateMeetingRecorderConnectionSchema.parse({ enabled: false })).toEqual({
      enabled: false,
    })
    expect(() => updateMeetingRecorderConnectionSchema.parse({})).toThrow()
    expect(() =>
      createMeetingRecorderConnectionSchema.parse({ name: 'Recorder A', unexpected: true }),
    ).toThrow()
    expect(() =>
      linkMeetingRecorderRecordingSchema.parse({
        interviewId: '5d8938da-0470-48ce-b985-5cfbb478e825',
        unexpected: true,
      }),
    ).toThrow()
  })

  it('uses interviewId, not matchedBy, as the unmatched-recording source of truth', () => {
    expect(() =>
      meetingRecorderUnmatchedRecordingSchema.parse({
        id: '5d8938da-0470-48ce-b985-5cfbb478e825',
        interviewId: null,
        connectionId: '5f074ea3-b0dc-4fcf-8d06-aeb27ed98521',
        externalRecordingId: 'recording_123',
        revision: 1,
        title: 'Interview',
        startedAt: '2026-10-07T12:00:00.000Z',
        endedAt: null,
        durationMs: null,
        provider: 'google-meet',
        meetingId: 'abc-defg-hij',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        stageAtLink: 'TECH_INTERVIEW',
        matchedBy: 'manual',
        readiness: { complete: true, release: 'complete', pending: [] },
        linkedByUserId: null,
        linkedAt: null,
        lastEventAt: '2026-10-07T12:01:00.000Z',
        createdAt: '2026-10-07T12:01:00.000Z',
        updatedAt: '2026-10-07T12:01:00.000Z',
      }),
    ).not.toThrow()
  })

  it('keeps the signing secret write-only and recording detail snapshot sanitized', () => {
    const validSecret = `whsec_${Buffer.alloc(32).toString('base64')}`
    expect(setMeetingRecorderSecretSchema.parse({ secret: validSecret })).toEqual({
      secret: validSecret,
    })

    expect(() =>
      meetingRecorderRecordingDetailSchema.parse({
        id: '5d8938da-0470-48ce-b985-5cfbb478e825',
        interviewId: null,
        connectionId: '5f074ea3-b0dc-4fcf-8d06-aeb27ed98521',
        externalRecordingId: 'recording_123',
        revision: 1,
        title: 'Interview',
        startedAt: '2026-10-07T12:00:00.000Z',
        endedAt: null,
        durationMs: null,
        provider: 'google-meet',
        meetingId: 'abc-defg-hij',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        stageAtLink: null,
        matchedBy: 'unmatched',
        readiness: { complete: true, release: 'complete', pending: [] },
        linkedByUserId: null,
        linkedAt: null,
        lastEventAt: '2026-10-07T12:01:00.000Z',
        createdAt: '2026-10-07T12:01:00.000Z',
        updatedAt: '2026-10-07T12:01:00.000Z',
        snapshot: {
          ...BASE_RECORDING,
          artifacts: [
            {
              type: 'tab-recording',
              mimeType: 'video/webm',
              delivery: 'uploaded',
              viewUrl: 'https://example.test/private',
            },
          ],
        },
      }),
    ).toThrow()
  })
})
