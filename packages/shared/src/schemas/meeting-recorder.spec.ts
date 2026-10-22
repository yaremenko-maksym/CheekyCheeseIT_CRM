import { describe, expect, it } from 'vitest'
import {
  type MeetingRecorderRecordingInput,
  createMeetingRecorderConnectionSchema,
  linkMeetingRecorderRecordingSchema,
  MEETING_RECORDER_INDEXED_IDENTIFIER_MAX_CHARS,
  MEETING_RECORDER_LABEL_MAX_CHARS,
  MEETING_RECORDER_NOTE_MAX_CHARS,
  MEETING_RECORDER_SEGMENT_TEXT_MAX_CHARS,
  MEETING_RECORDER_TITLE_MAX_CHARS,
  meetingRecorderArtifactInputSchema,
  meetingRecorderArtifactStoredSchema,
  meetingRecorderConnectionSchema,
  meetingRecorderIntegrationTestEventSchema,
  meetingRecorderReadyEventSchema,
  meetingRecorderReadinessSchema,
  meetingRecorderRecordingDetailSchema,
  meetingRecorderRecordingInputSchema,
  meetingRecorderRecordingStoredSchema,
  meetingRecorderRecordingSummarySchema,
  meetingRecorderSigningSecretSchema,
  meetingRecorderSnapshotDataSchema,
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

  // CR-865-M-7: the extension and the CRM ship independently. A new optional field from
  // the provider must not turn every event into a permanent 422, so provider payloads
  // drop unknown keys instead of rejecting them. CRM-owned DTOs stay strict (below).
  it('strips unknown provider keys recursively instead of rejecting the event', () => {
    const parsed = meetingRecorderWebhookEventSchema.parse({
      ...snapshotEvent({
        ...BASE_RECORDING,
        futureField: 'x',
        source: { ...BASE_RECORDING.source, unexpected: true },
        artifacts: [
          {
            type: 'notes',
            mimeType: 'text/plain',
            delivery: 'downloaded',
            unexpected: true,
          },
        ],
      }),
      traceparent: '00-abc-def-01',
    })

    expect(parsed).not.toHaveProperty('traceparent')
    if (parsed.type === 'io.github.kstroevsky.meeting-recorder.integration.test.v1') {
      throw new Error('expected a snapshot event')
    }
    expect(parsed.data.recording).not.toHaveProperty('futureField')
    expect(parsed.data.recording.source).toEqual(BASE_RECORDING.source)
    expect(parsed.data.recording.artifacts).toEqual([
      { type: 'notes', mimeType: 'text/plain', delivery: 'downloaded' },
    ])
  })

  it.each([
    ['title', MEETING_RECORDER_TITLE_MAX_CHARS, (v: string) => ({ ...BASE_RECORDING, title: v })],
    ['note', MEETING_RECORDER_NOTE_MAX_CHARS, (v: string) => ({ ...BASE_RECORDING, note: v })],
    [
      'transcript text',
      MEETING_RECORDER_SEGMENT_TEXT_MAX_CHARS,
      (v: string) => ({
        ...BASE_RECORDING,
        transcript: { source: 'stt', segments: [{ tStartMs: 0, tEndMs: 1, text: v }] },
      }),
    ],
    [
      'transcript speaker',
      MEETING_RECORDER_LABEL_MAX_CHARS,
      (v: string) => ({
        ...BASE_RECORDING,
        transcript: {
          source: 'stt',
          segments: [{ tStartMs: 0, tEndMs: 1, speaker: v, text: 'x' }],
        },
      }),
    ],
    [
      'notation text',
      MEETING_RECORDER_SEGMENT_TEXT_MAX_CHARS,
      (v: string) => ({ ...BASE_RECORDING, notations: [{ tStartMs: 0, text: v }] }),
    ],
    [
      'provider',
      MEETING_RECORDER_LABEL_MAX_CHARS,
      (v: string) => ({ ...BASE_RECORDING, source: { kind: 'meeting', provider: v } }),
    ],
    [
      'topic keyword',
      MEETING_RECORDER_LABEL_MAX_CHARS,
      (v: string) => ({
        ...BASE_RECORDING,
        analysis: { status: 'completed', topics: [{ keywords: [v], importance: 1, spans: [] }] },
      }),
    ],
  ])('bounds the displayed %s at its limit', (_label, max, build) => {
    expect(meetingRecorderRecordingInputSchema.safeParse(build('x'.repeat(max))).success).toBe(true)
    expect(meetingRecorderRecordingInputSchema.safeParse(build('x'.repeat(max + 1))).success).toBe(
      false,
    )
  })

  it('pins the displayed-field limits', () => {
    expect(MEETING_RECORDER_TITLE_MAX_CHARS).toBe(1_000)
    expect(MEETING_RECORDER_NOTE_MAX_CHARS).toBe(100_000)
    expect(MEETING_RECORDER_SEGMENT_TEXT_MAX_CHARS).toBe(20_000)
    expect(MEETING_RECORDER_LABEL_MAX_CHARS).toBe(256)
  })

  // SR-865-M-1: Postgres refuses a NUL character in text (22021) and in jsonb (22P05), and
  // refuses an unpaired UTF-16 surrogate in jsonb. Such a value passed the schema, then
  // failed in the database on every retry — and the failure carried the transcript into
  // logs. It is refused here instead, as a 422 the provider does not retry.
  it.each([
    ['NUL', 'before\u0000after'],
    ['lone high surrogate', 'before\ud800after'],
    ['lone low surrogate', 'before\udc00after'],
  ])('refuses a %s in every provider string field', (_label, bad) => {
    const cases: Array<[string, unknown]> = [
      ['event id', { ...snapshotEvent(), id: bad }],
      ['source', { ...snapshotEvent(), source: `urn:meeting-recorder:destination:${bad}` }],
      [
        'recording id',
        { ...snapshotEvent({ ...BASE_RECORDING, id: bad }), subject: `recording/${bad}` },
      ],
      ['title', snapshotEvent({ ...BASE_RECORDING, title: bad })],
      ['note', snapshotEvent({ ...BASE_RECORDING, note: bad })],
      ['provider', snapshotEvent({ ...BASE_RECORDING, source: { kind: 'tab', provider: bad } })],
      ['meetingId', snapshotEvent({ ...BASE_RECORDING, source: { kind: 'tab', meetingId: bad } })],
      [
        'meetingUrl',
        snapshotEvent({
          ...BASE_RECORDING,
          source: { kind: 'tab', meetingUrl: `https://meet.google.com/${bad}` },
        }),
      ],
      ['notation', snapshotEvent({ ...BASE_RECORDING, notations: [{ tStartMs: 0, text: bad }] })],
      [
        'segment text',
        snapshotEvent({
          ...BASE_RECORDING,
          transcript: { source: 'stt', segments: [{ tStartMs: 0, tEndMs: 1, text: bad }] },
        }),
      ],
      [
        'segment speaker',
        snapshotEvent({
          ...BASE_RECORDING,
          transcript: {
            source: 'stt',
            segments: [{ tStartMs: 0, tEndMs: 1, speaker: bad, text: 'x' }],
          },
        }),
      ],
      [
        'analysis error',
        snapshotEvent({ ...BASE_RECORDING, analysis: { status: 'failed', error: bad } }),
      ],
      [
        'keyword',
        snapshotEvent({
          ...BASE_RECORDING,
          analysis: {
            status: 'completed',
            topics: [{ keywords: [bad], importance: 1, spans: [] }],
          },
        }),
      ],
      [
        'artifact mimeType',
        snapshotEvent({
          ...BASE_RECORDING,
          artifacts: [{ type: 'notes', mimeType: bad, delivery: 'uploaded' }],
        }),
      ],
    ]
    for (const [field, event] of cases) {
      expect(meetingRecorderWebhookEventSchema.safeParse(event).success, field).toBe(false)
    }
  })

  it('keeps the stored snapshot strict: an unknown key can never be persisted or served', () => {
    expect(
      meetingRecorderRecordingStoredSchema.safeParse({ ...BASE_RECORDING, unexpected: true })
        .success,
    ).toBe(false)
    expect(meetingRecorderRecordingStoredSchema.safeParse(BASE_RECORDING).success).toBe(true)
  })

  it('accepts a correctly paired surrogate (an emoji) in transcript text', () => {
    const parsed = meetingRecorderRecordingInputSchema.safeParse({
      ...BASE_RECORDING,
      title: 'Interview \u{1F600}',
    })
    expect(parsed.success).toBe(true)
  })

  it('bounds identifiers that are persisted in PostgreSQL B-tree indexes', () => {
    const atLimit = 'x'.repeat(MEETING_RECORDER_INDEXED_IDENTIFIER_MAX_CHARS)
    const overLimit = `${atLimit}x`
    const recordingAtLimit = {
      ...BASE_RECORDING,
      id: atLimit,
      source: { ...BASE_RECORDING.source, meetingId: atLimit },
    }

    expect(
      meetingRecorderWebhookEventSchema.safeParse({
        ...snapshotEvent(recordingAtLimit),
        id: atLimit,
        subject: `recording/${atLimit}`,
      }).success,
    ).toBe(true)
    expect(
      meetingRecorderWebhookEventSchema.safeParse({ ...snapshotEvent(), id: overLimit }).success,
    ).toBe(false)
    expect(
      meetingRecorderWebhookEventSchema.safeParse({
        ...snapshotEvent({ ...BASE_RECORDING, id: overLimit }),
        subject: `recording/${overLimit}`,
      }).success,
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

  it('requires snapshot subject to match recording.id', () => {
    const parsed = meetingRecorderReadyEventSchema.safeParse({
      ...snapshotEvent(),
      subject: 'recording/a-different-recording',
    })
    expect(parsed.success).toBe(false)
    const issues = parsed.success ? [] : parsed.error.issues
    expect(issues[0]).toMatchObject({
      code: 'custom',
      path: ['subject'],
      message: 'subject must match data.recording.id',
    })
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
    expect(
      meetingRecorderWebhookEventSchema.parse({
        ...event,
        data: { test: true, unexpected: true },
      }).data,
    ).toEqual({ test: true })
  })

  it('exports exact ready and updated V1 event schemas', () => {
    expect(() => meetingRecorderReadyEventSchema.parse(snapshotEvent())).not.toThrow()
    expect(() =>
      meetingRecorderUpdatedEventSchema.parse({
        ...snapshotEvent(),
        type: 'io.github.kstroevsky.meeting-recorder.recording.updated.v1',
      }),
    ).not.toThrow()

    const mismatchedUpdated = meetingRecorderUpdatedEventSchema.safeParse({
      ...snapshotEvent(),
      type: 'io.github.kstroevsky.meeting-recorder.recording.updated.v1',
      subject: 'recording/a-different-recording',
    })
    expect(mismatchedUpdated.success).toBe(false)
    const issues = mismatchedUpdated.success ? [] : mismatchedUpdated.error.issues
    expect(issues[0]).toMatchObject({
      code: 'custom',
      path: ['subject'],
      message: 'subject must match data.recording.id',
    })
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

describe('meeting recorder schema boundaries', () => {
  const richRecording: MeetingRecorderRecordingInput = {
    ...BASE_RECORDING,
    endedAt: '2026-10-07T12:42:00.000Z',
    durationMs: 2_520_000,
    note: 'Recruiter note',
    notations: [{ tStartMs: 1_000, tEndMs: 2_000, text: 'Strong answer' }],
    transcript: {
      source: 'meet-captions',
      segments: [{ tStartMs: 1_000, tEndMs: 2_000, speaker: 'Candidate', text: 'Hello' }],
    },
    analysis: {
      status: 'completed',
      topics: [
        {
          keywords: ['React', 'TypeScript'],
          importance: 0.9,
          spans: [{ tStartMs: 1_000, tEndMs: 2_000 }],
        },
      ],
    },
    artifacts: [
      {
        type: 'transcript',
        mimeType: 'text/vtt',
        bytes: 123,
        delivery: 'uploaded',
        viewUrl: 'https://example.test/private/transcript',
      },
    ],
  }

  const validConnection = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Recruiting recorder',
    enabled: true,
    secretSet: true,
    expectedSource: 'urn:meeting-recorder:destination:producer_123',
    signingSecretUpdatedAt: '2026-10-07T12:00:00.000Z',
    lastVerifiedAt: '2026-10-07T12:01:00.000Z',
    lastEventAt: '2026-10-07T12:02:00.000Z',
    createdAt: '2026-10-07T11:00:00.000Z',
    updatedAt: '2026-10-07T12:02:00.000Z',
    webhookPath:
      '/api/public/integrations/meeting-recorder/11111111-1111-4111-8111-111111111111/events',
  }

  const validSummary = {
    id: '22222222-2222-4222-8222-222222222222',
    interviewId: '33333333-3333-4333-8333-333333333333',
    connectionId: validConnection.id,
    externalRecordingId: 'recording_123',
    revision: 2,
    title: 'Interview',
    startedAt: '2026-10-07T12:00:00.000Z',
    endedAt: '2026-10-07T12:42:00.000Z',
    durationMs: 2_520_000,
    provider: 'google-meet',
    meetingId: 'abc-defg-hij',
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
    stageAtLink: 'HR_SCREEN',
    matchedBy: 'meeting-id',
    readiness: { complete: true, release: 'complete', pending: [] },
    linkedByUserId: '44444444-4444-4444-8444-444444444444',
    linkedAt: '2026-10-07T12:43:00.000Z',
    lastEventAt: '2026-10-07T12:43:00.000Z',
    createdAt: '2026-10-07T12:43:00.000Z',
    updatedAt: '2026-10-07T12:43:00.000Z',
  }

  it('preserves every supported optional recording field', () => {
    expect(meetingRecorderRecordingInputSchema.parse(richRecording)).toEqual(richRecording)
  })

  it('accepts offset datetimes and the alternate source/transcript enum members', () => {
    const recording = {
      ...BASE_RECORDING,
      startedAt: '2026-10-07T14:00:00+02:00',
      source: { kind: 'tab' },
      transcript: { source: 'stt', segments: [] },
    }
    expect(meetingRecorderRecordingInputSchema.parse(recording)).toEqual(recording)
  })

  it.each([
    ['source.kind', { ...richRecording, source: { ...richRecording.source, kind: 'screen' } }],
    [
      'source.meetingUrl protocol',
      { ...richRecording, source: { ...richRecording.source, meetingUrl: 'http://example.test' } },
    ],
    [
      'negative notation start',
      { ...richRecording, notations: [{ tStartMs: -1, tEndMs: 2_000, text: 'x' }] },
    ],
    [
      'negative notation end',
      { ...richRecording, notations: [{ tStartMs: 0, tEndMs: -1, text: 'x' }] },
    ],
    [
      'transcript source',
      { ...richRecording, transcript: { ...richRecording.transcript, source: 'manual' } },
    ],
    [
      'negative transcript start',
      {
        ...richRecording,
        transcript: {
          source: 'stt',
          segments: [{ tStartMs: -1, tEndMs: 2_000, text: 'x' }],
        },
      },
    ],
    [
      'negative transcript end',
      {
        ...richRecording,
        transcript: {
          source: 'stt',
          segments: [{ tStartMs: 0, tEndMs: -1, text: 'x' }],
        },
      },
    ],
    [
      'analysis status',
      { ...richRecording, analysis: { ...richRecording.analysis, status: 'done' } },
    ],
    [
      'negative analysis span start',
      {
        ...richRecording,
        analysis: {
          status: 'completed',
          topics: [{ keywords: ['x'], importance: 1, spans: [{ tStartMs: -1, tEndMs: 1 }] }],
        },
      },
    ],
    [
      'negative analysis span end',
      {
        ...richRecording,
        analysis: {
          status: 'completed',
          topics: [{ keywords: ['x'], importance: 1, spans: [{ tStartMs: 0, tEndMs: -1 }] }],
        },
      },
    ],
    [
      'artifact type',
      {
        ...richRecording,
        artifacts: [{ type: 'audio', mimeType: 'audio/webm', delivery: 'uploaded' }],
      },
    ],
    [
      'negative artifact bytes',
      {
        ...richRecording,
        artifacts: [{ type: 'notes', mimeType: 'text/plain', bytes: -1, delivery: 'uploaded' }],
      },
    ],
    [
      'artifact delivery',
      {
        ...richRecording,
        artifacts: [{ type: 'notes', mimeType: 'text/plain', delivery: 'done' }],
      },
    ],
    [
      'artifact viewUrl',
      {
        ...richRecording,
        artifacts: [
          { type: 'notes', mimeType: 'text/plain', delivery: 'uploaded', viewUrl: 'not-a-url' },
        ],
      },
    ],
    ['negative duration', { ...richRecording, durationMs: -1 }],
  ])('rejects invalid %s values', (_label, recording) => {
    expect(meetingRecorderRecordingInputSchema.safeParse(recording).success).toBe(false)
  })

  it.each([
    ['recording', { ...richRecording, unexpected: true }],
    ['notation', { ...richRecording, notations: [{ tStartMs: 0, text: 'x', unexpected: true }] }],
    [
      'transcript',
      { ...richRecording, transcript: { source: 'stt', segments: [], unexpected: true } },
    ],
    [
      'transcript segment',
      {
        ...richRecording,
        transcript: {
          source: 'stt',
          segments: [{ tStartMs: 0, tEndMs: 1, text: 'x', unexpected: true }],
        },
      },
    ],
    ['analysis', { ...richRecording, analysis: { status: 'completed', unexpected: true } }],
    [
      'analysis topic',
      {
        ...richRecording,
        analysis: {
          status: 'completed',
          topics: [{ keywords: [], importance: 1, spans: [], unexpected: true }],
        },
      },
    ],
    [
      'analysis span',
      {
        ...richRecording,
        analysis: {
          status: 'completed',
          topics: [
            { keywords: [], importance: 1, spans: [{ tStartMs: 0, tEndMs: 1, unexpected: true }] },
          ],
        },
      },
    ],
  ])('strips unknown keys from the nested %s object', (_label, recording) => {
    const parsed = meetingRecorderRecordingInputSchema.safeParse(recording)
    expect(parsed.success).toBe(true)
    expect(JSON.stringify(parsed.data)).not.toContain('unexpected')
  })

  it('requires a positive integer revision and exact readiness vocabulary', () => {
    const valid = {
      revision: 1,
      readiness: { complete: false, release: 'timeout', pending: ['analysis'] },
      recording: BASE_RECORDING,
    }
    expect(meetingRecorderSnapshotDataSchema.parse(valid)).toEqual(valid)
    expect(meetingRecorderSnapshotDataSchema.safeParse({ ...valid, revision: 0 }).success).toBe(
      false,
    )
    expect(meetingRecorderSnapshotDataSchema.safeParse({ ...valid, revision: 1.5 }).success).toBe(
      false,
    )
    expect(
      meetingRecorderReadinessSchema.safeParse({
        complete: false,
        release: 'later',
        pending: ['analysis'],
      }).success,
    ).toBe(false)
    expect(
      meetingRecorderReadinessSchema.safeParse({
        complete: false,
        release: 'manual',
        pending: ['media'],
      }).success,
    ).toBe(false)
    expect(
      meetingRecorderReadinessSchema.parse({
        complete: false,
        release: 'manual',
        pending: [],
        unexpected: true,
      }),
    ).toEqual({ complete: false, release: 'manual', pending: [] })

    expect(
      meetingRecorderReadinessSchema.parse({
        complete: false,
        release: 'manual',
        pending: ['transcript', 'artifact-delivery'],
      }),
    ).toEqual({
      complete: false,
      release: 'manual',
      pending: ['transcript', 'artifact-delivery'],
    })
  })

  it('enforces the CloudEvent envelope and source namespace', () => {
    const valid = snapshotEvent()
    expect(meetingRecorderReadyEventSchema.safeParse(valid).success).toBe(true)

    for (const invalid of [
      { ...valid, specversion: '0.3' },
      { ...valid, id: '' },
      { ...valid, source: 'https://example.test/producer' },
      { ...valid, time: '2026-10-07' },
      { ...valid, datacontenttype: 'application/cloudevents+json' },
      { ...valid, type: 'io.github.kstroevsky.meeting-recorder.recording.deleted.v1' },
      { ...valid, subject: 'recording/' },
    ]) {
      expect(meetingRecorderReadyEventSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it('requires HTTPS at the beginning of meeting URLs and preserves the validation message', () => {
    const embeddedHttps = meetingRecorderRecordingInputSchema.safeParse({
      ...BASE_RECORDING,
      source: {
        ...BASE_RECORDING.source,
        meetingUrl: 'http://example.test/https://meet.google.com/abc-defg-hij',
      },
    })
    expect(embeddedHttps.success).toBe(false)

    const plainHttp = meetingRecorderRecordingInputSchema.safeParse({
      ...BASE_RECORDING,
      source: { ...BASE_RECORDING.source, meetingUrl: 'http://meet.google.com/abc-defg-hij' },
    })
    expect(plainHttp.success).toBe(false)
    const issues = plainHttp.success ? [] : plainHttp.error.issues
    expect(issues.some((issue) => issue.message === 'URL must use HTTPS')).toBe(true)
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
  ])('rejects non-http(s) meetingUrl %s at ingest', (meetingUrl) => {
    const result = meetingRecorderRecordingInputSchema.safeParse({
      ...BASE_RECORDING,
      source: { ...BASE_RECORDING.source, meetingUrl },
    })
    expect(result.success).toBe(false)
    const issues = result.success ? [] : result.error.issues
    expect(issues.some((issue) => issue.message === 'URL must use HTTPS')).toBe(true)
  })

  it('accepts each analysis status and artifact vocabulary member', () => {
    for (const status of ['analyzing', 'completed', 'failed', 'canceled', 'unsupported']) {
      expect(
        meetingRecorderRecordingInputSchema.safeParse({
          ...BASE_RECORDING,
          analysis: { status },
        }).success,
      ).toBe(true)
    }

    for (const type of [
      'tab-recording',
      'microphone-recording',
      'self-video',
      'notes',
      'transcript',
    ]) {
      for (const delivery of ['pending', 'downloaded', 'uploaded', 'local-fallback', 'failed']) {
        expect(
          meetingRecorderArtifactInputSchema.safeParse({
            type,
            mimeType: 'application/octet-stream',
            delivery,
          }).success,
        ).toBe(true)
      }
    }
  })

  it('sanitizes every artifact while preserving recordings without artifacts', () => {
    expect(sanitizeMeetingRecorderRecording(BASE_RECORDING)).toEqual(BASE_RECORDING)

    const sanitized = sanitizeMeetingRecorderRecording({
      ...richRecording,
      artifacts: [
        {
          type: 'notes',
          mimeType: 'text/plain',
          bytes: 10,
          delivery: 'downloaded',
          viewUrl: 'https://example.test/private/note',
        },
        {
          type: 'transcript',
          mimeType: 'text/vtt',
          delivery: 'uploaded',
          viewUrl: 'https://example.test/private/transcript',
        },
      ],
    })
    expect(sanitized.artifacts).toEqual([
      { type: 'notes', mimeType: 'text/plain', bytes: 10, delivery: 'downloaded' },
      { type: 'transcript', mimeType: 'text/vtt', delivery: 'uploaded' },
    ])
  })

  it('validates connection create/update DTO boundaries', () => {
    expect(createMeetingRecorderConnectionSchema.parse({ name: '  Recorder A  ' })).toEqual({
      name: 'Recorder A',
    })
    expect(createMeetingRecorderConnectionSchema.safeParse({ name: '   ' }).success).toBe(false)
    expect(updateMeetingRecorderConnectionSchema.parse({ name: '  Renamed  ' })).toEqual({
      name: 'Renamed',
    })
    expect(updateMeetingRecorderConnectionSchema.parse({ enabled: true })).toEqual({
      enabled: true,
    })
    expect(updateMeetingRecorderConnectionSchema.parse({ name: 'A', enabled: false })).toEqual({
      name: 'A',
      enabled: false,
    })
    expect(updateMeetingRecorderConnectionSchema.safeParse({ name: '   ' }).success).toBe(false)
    const emptyUpdate = updateMeetingRecorderConnectionSchema.safeParse({})
    expect(emptyUpdate.success).toBe(false)
    const emptyUpdateIssues = emptyUpdate.success ? [] : emptyUpdate.error.issues
    expect(emptyUpdateIssues[0]?.message).toBe('At least one field is required')
    expect(
      updateMeetingRecorderConnectionSchema.safeParse({ enabled: true, unexpected: true }).success,
    ).toBe(false)
  })

  it('rejects non-canonical base64 secret encodings across padding branches', () => {
    const valid24 = `whsec_${Buffer.alloc(24).toString('base64')}`
    expect(meetingRecorderSigningSecretSchema.safeParse(valid24).success).toBe(true)
    expect(
      meetingRecorderSigningSecretSchema.safeParse(
        `whsec_${Buffer.alloc(24, 0xff).toString('base64')}`,
      ).success,
    ).toBe(true)

    for (const invalid of [
      'whsec_',
      Buffer.alloc(32).toString('base64'),
      `xxxxxx${Buffer.alloc(24).toString('base64')}`,
      `whsec_${'A'.repeat(33)}`,
      `whsec_${'A'.repeat(32)}=`,
      `whsec_${'A'.repeat(34)}B`,
      `whsec_${'A'.repeat(33)}B==`,
      `whsec_${'A'.repeat(34)}B=`,
      `whsec_${'A'.repeat(32)}===`,
      `whsec_${'A'.repeat(16)}!${'A'.repeat(15)}`,
    ]) {
      expect(meetingRecorderSigningSecretSchema.safeParse(invalid).success).toBe(false)
    }

    const tooShort = meetingRecorderSigningSecretSchema.safeParse('whsec_AA==')
    expect(tooShort.success).toBe(false)
    const tooShortIssues = tooShort.success ? [] : tooShort.error.issues
    expect(tooShortIssues.some((issue) => issue.message.includes('24-64'))).toBe(true)
  })

  it('validates the complete connection response shape', () => {
    expect(meetingRecorderConnectionSchema.parse(validConnection)).toEqual(validConnection)
    expect(
      meetingRecorderConnectionSchema.parse({
        ...validConnection,
        expectedSource: null,
        signingSecretUpdatedAt: null,
        lastVerifiedAt: null,
        lastEventAt: null,
      }),
    ).toEqual({
      ...validConnection,
      expectedSource: null,
      signingSecretUpdatedAt: null,
      lastVerifiedAt: null,
      lastEventAt: null,
    })
    expect(
      meetingRecorderConnectionSchema.safeParse({ ...validConnection, id: 'not-a-uuid' }).success,
    ).toBe(false)
    expect(
      meetingRecorderConnectionSchema.safeParse({
        ...validConnection,
        expectedSource: 'producer_123',
      }).success,
    ).toBe(false)
    expect(
      meetingRecorderConnectionSchema.safeParse({ ...validConnection, unexpected: true }).success,
    ).toBe(false)
  })

  it('validates recording summaries, matching states, and nullable fields', () => {
    for (const matchedBy of ['meeting-id', 'meeting-url', 'manual', 'unmatched']) {
      expect(
        meetingRecorderRecordingSummarySchema.safeParse({ ...validSummary, matchedBy }).success,
      ).toBe(true)
    }

    const nullable = {
      ...validSummary,
      interviewId: null,
      endedAt: null,
      durationMs: null,
      provider: null,
      meetingId: null,
      meetingUrl: null,
      stageAtLink: null,
      linkedByUserId: null,
      linkedAt: null,
      matchedBy: 'unmatched',
    }
    expect(meetingRecorderRecordingSummarySchema.parse(nullable)).toEqual(nullable)

    for (const invalid of [
      { ...validSummary, id: 'bad-id' },
      { ...validSummary, connectionId: 'bad-id' },
      { ...validSummary, interviewId: 'bad-id' },
      { ...validSummary, revision: 0 },
      { ...validSummary, durationMs: -1 },
      { ...validSummary, meetingUrl: 'http://meet.google.com/abc-defg-hij' },
      { ...validSummary, matchedBy: 'automatic' },
      { ...validSummary, linkedByUserId: 'bad-id' },
      { ...validSummary, unexpected: true },
    ]) {
      expect(meetingRecorderRecordingSummarySchema.safeParse(invalid).success).toBe(false)
    }
  })

  it('keeps unmatched/detail/link DTO contracts exact', () => {
    const unmatched = { ...validSummary, interviewId: null, matchedBy: 'unmatched' }
    expect(meetingRecorderUnmatchedRecordingSchema.safeParse(unmatched).success).toBe(true)
    expect(meetingRecorderUnmatchedRecordingSchema.safeParse(validSummary).success).toBe(false)

    expect(
      meetingRecorderRecordingDetailSchema.safeParse({
        ...validSummary,
        snapshot: sanitizeMeetingRecorderRecording(richRecording as never),
      }).success,
    ).toBe(true)

    const interviewId = '33333333-3333-4333-8333-333333333333'
    expect(linkMeetingRecorderRecordingSchema.parse({ interviewId })).toEqual({ interviewId })
    expect(linkMeetingRecorderRecordingSchema.parse({ interviewId: null })).toEqual({
      interviewId: null,
    })
    expect(linkMeetingRecorderRecordingSchema.safeParse({ interviewId: 'bad-id' }).success).toBe(
      false,
    )
    expect(linkMeetingRecorderRecordingSchema.safeParse({}).success).toBe(false)
  })
})
