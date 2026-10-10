import { z } from 'zod'

export const MEETING_RECORDER_EVENT_NAMESPACE = 'io.github.kstroevsky.meeting-recorder' as const
export const MEETING_RECORDER_TEST_EVENT_TYPE =
  `${MEETING_RECORDER_EVENT_NAMESPACE}.integration.test.v1` as const
export const MEETING_RECORDER_READY_EVENT_TYPE =
  `${MEETING_RECORDER_EVENT_NAMESPACE}.recording.ready.v1` as const
export const MEETING_RECORDER_UPDATED_EVENT_TYPE =
  `${MEETING_RECORDER_EVENT_NAMESPACE}.recording.updated.v1` as const
export const MEETING_RECORDER_INDEXED_IDENTIFIER_MAX_CHARS = 512

const isoDateTimeSchema = z.string().datetime({ offset: true })
const httpsUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https:\/\//i.test(value), 'URL must use HTTPS')

const meetingRecorderSourceSchema = z.string().startsWith('urn:meeting-recorder:destination:')

const recordingSourceSchema = z
  .object({
    kind: z.enum(['meeting', 'tab']),
    provider: z.string().optional(),
    meetingId: z.string().max(MEETING_RECORDER_INDEXED_IDENTIFIER_MAX_CHARS).optional(),
    meetingUrl: httpsUrlSchema.optional(),
  })
  .strict()

const notationSchema = z
  .object({
    tStartMs: z.number().min(0),
    tEndMs: z.number().min(0).optional(),
    text: z.string(),
  })
  .strict()

const transcriptSegmentSchema = z
  .object({
    tStartMs: z.number().min(0),
    tEndMs: z.number().min(0),
    speaker: z.string().optional(),
    text: z.string(),
  })
  .strict()

const transcriptSchema = z
  .object({
    source: z.enum(['meet-captions', 'stt']),
    segments: z.array(transcriptSegmentSchema),
  })
  .strict()

const analysisSpanSchema = z
  .object({
    tStartMs: z.number().min(0),
    tEndMs: z.number().min(0),
  })
  .strict()

const analysisTopicSchema = z
  .object({
    keywords: z.array(z.string()),
    importance: z.number(),
    spans: z.array(analysisSpanSchema),
  })
  .strict()

const analysisSchema = z
  .object({
    status: z.enum(['analyzing', 'completed', 'failed', 'canceled', 'unsupported']),
    error: z.string().optional(),
    topics: z.array(analysisTopicSchema).optional(),
  })
  .strict()

export const meetingRecorderArtifactInputSchema = z
  // Stryker disable next-line ObjectLiteral: this Zod shape is constructed once at module import, so the Vitest per-test mutator reports this construction-time mutant with coveredBy=[] and cannot activate it inside a test. The schema-boundary tests directly require valid artifact fields/vocabulary and reject malformed artifacts; replacing the shape with {} would therefore be a module-load/static-mutant tool blind spot, not equivalent behavior.
  .object({
    type: z.enum(['tab-recording', 'microphone-recording', 'self-video', 'notes', 'transcript']),
    mimeType: z.string(),
    bytes: z.number().min(0).optional(),
    delivery: z.enum(['pending', 'downloaded', 'uploaded', 'local-fallback', 'failed']),
    viewUrl: z.string().url().optional(),
  })
  .strict()

export const meetingRecorderArtifactStoredSchema = meetingRecorderArtifactInputSchema.omit({
  viewUrl: true,
})

export const meetingRecorderRecordingInputSchema = z
  .object({
    id: z.string().min(1).max(MEETING_RECORDER_INDEXED_IDENTIFIER_MAX_CHARS),
    title: z.string(),
    startedAt: isoDateTimeSchema,
    endedAt: isoDateTimeSchema.optional(),
    durationMs: z.number().min(0).optional(),
    source: recordingSourceSchema,
    note: z.string().optional(),
    notations: z.array(notationSchema).optional(),
    transcript: transcriptSchema.optional(),
    analysis: analysisSchema.optional(),
    artifacts: z.array(meetingRecorderArtifactInputSchema).optional(),
  })
  .strict()

export const meetingRecorderRecordingStoredSchema = meetingRecorderRecordingInputSchema.extend({
  artifacts: z.array(meetingRecorderArtifactStoredSchema).optional(),
})

export type MeetingRecorderRecordingInput = z.infer<typeof meetingRecorderRecordingInputSchema>
export type MeetingRecorderRecordingStored = z.infer<typeof meetingRecorderRecordingStoredSchema>

export function sanitizeMeetingRecorderRecording(
  recording: MeetingRecorderRecordingInput,
): MeetingRecorderRecordingStored {
  const sanitized = {
    ...recording,
    artifacts: recording.artifacts?.map(({ viewUrl: _viewUrl, ...artifact }) => artifact),
  }
  return meetingRecorderRecordingStoredSchema.parse(sanitized)
}

export const meetingRecorderReadinessSchema = z
  .object({
    complete: z.boolean(),
    release: z.enum(['complete', 'timeout', 'manual']),
    pending: z.array(z.enum(['transcript', 'analysis', 'artifact-delivery'])),
  })
  .strict()

export const meetingRecorderSnapshotDataSchema = z
  .object({
    revision: z.number().int().positive(),
    readiness: meetingRecorderReadinessSchema,
    recording: meetingRecorderRecordingInputSchema,
  })
  .strict()

const commonCloudEventShape = {
  specversion: z.literal('1.0'),
  id: z.string().min(1).max(MEETING_RECORDER_INDEXED_IDENTIFIER_MAX_CHARS),
  source: meetingRecorderSourceSchema,
  time: isoDateTimeSchema,
  datacontenttype: z.literal('application/json'),
}

export const meetingRecorderReadyEventSchema = z
  .object({
    ...commonCloudEventShape,
    type: z.literal(MEETING_RECORDER_READY_EVENT_TYPE),
    subject: z.string(),
    data: meetingRecorderSnapshotDataSchema,
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.subject !== `recording/${event.data.recording.id}`) {
      ctx.addIssue({
        code: 'custom',
        path: ['subject'],
        message: 'subject must match data.recording.id',
      })
    }
  })

export const meetingRecorderUpdatedEventSchema = z
  .object({
    ...commonCloudEventShape,
    type: z.literal(MEETING_RECORDER_UPDATED_EVENT_TYPE),
    subject: z.string(),
    data: meetingRecorderSnapshotDataSchema,
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.subject !== `recording/${event.data.recording.id}`) {
      ctx.addIssue({
        code: 'custom',
        path: ['subject'],
        message: 'subject must match data.recording.id',
      })
    }
  })

export const meetingRecorderIntegrationTestEventSchema = z
  .object({
    ...commonCloudEventShape,
    type: z.literal(MEETING_RECORDER_TEST_EVENT_TYPE),
    subject: z.literal('integration/test'),
    data: z.object({ test: z.literal(true) }).strict(),
  })
  .strict()

export const meetingRecorderWebhookEventSchema = z.union([
  meetingRecorderReadyEventSchema,
  meetingRecorderUpdatedEventSchema,
  meetingRecorderIntegrationTestEventSchema,
])

export type MeetingRecorderWebhookEvent = z.infer<typeof meetingRecorderWebhookEventSchema>
export type MeetingRecorderSnapshotEvent = Extract<
  MeetingRecorderWebhookEvent,
  { type: typeof MEETING_RECORDER_READY_EVENT_TYPE | typeof MEETING_RECORDER_UPDATED_EVENT_TYPE }
>

export const createMeetingRecorderConnectionSchema = z
  .object({
    name: z.string().trim().min(1),
  })
  .strict()
export type CreateMeetingRecorderConnectionDto = z.infer<
  typeof createMeetingRecorderConnectionSchema
>

export const updateMeetingRecorderConnectionSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.enabled !== undefined, {
    message: 'At least one field is required',
  })
export type UpdateMeetingRecorderConnectionDto = z.infer<
  typeof updateMeetingRecorderConnectionSchema
>

function base64DecodedLength(value: string): number | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const dataLength = value.length - padding
  const remainder = dataLength % 4
  if (remainder === 1) return null

  // With at most two trailing `=` characters, valid padded base64 is exactly
  // the spelling whose total encoded length is divisible by four. Unpadded
  // base64 remains valid for remainders 0, 2 and 3.
  if (padding > 0 && value.length % 4 !== 0) return null

  // The anchored `+` regex above guarantees at least one data character and
  // restricts every data character to this alphabet.
  const lastDataChar = value[dataLength - 1]!
  const sextet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(
    lastDataChar,
  )

  // Canonical base64 requires all unused low bits in the final sextet to be 0.
  // This applies equally to padded and unpadded spellings.
  if (remainder === 2 && (sextet & 0x0f) !== 0) return null
  if (remainder === 3 && (sextet & 0x03) !== 0) return null

  return Math.floor((dataLength * 3) / 4)
}

export const meetingRecorderSigningSecretSchema = z
  .string()
  .startsWith('whsec_')
  .refine((value) => {
    // `Number(null) === 0`, which is outside the accepted byte range. This
    // keeps parse failure and out-of-range failure on one observable path.
    const decodedLength = Number(base64DecodedLength(value.slice('whsec_'.length)))
    return decodedLength >= 24 && decodedLength <= 64
  }, 'Signing secret must contain 24-64 base64-decoded bytes')

export const setMeetingRecorderSecretSchema = z
  .object({
    secret: meetingRecorderSigningSecretSchema,
  })
  .strict()
export type SetMeetingRecorderSecretDto = z.infer<typeof setMeetingRecorderSecretSchema>

export const meetingRecorderConnectionSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    enabled: z.boolean(),
    secretSet: z.boolean(),
    mediaProvisioned: z.boolean(),
    mediaTokenUpdatedAt: isoDateTimeSchema.nullable(),
    expectedSource: meetingRecorderSourceSchema.nullable(),
    signingSecretUpdatedAt: isoDateTimeSchema.nullable(),
    lastVerifiedAt: isoDateTimeSchema.nullable(),
    lastEventAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    webhookPath: z.string(),
  })
  .strict()
export type MeetingRecorderConnectionDto = z.infer<typeof meetingRecorderConnectionSchema>

export const meetingRecorderMediaTokenResponseSchema = z
  .object({
    token: z.string().regex(/^mrmt_[A-Za-z0-9_-]{43}$/),
  })
  .strict()
export type MeetingRecorderMediaTokenResponseDto = z.infer<
  typeof meetingRecorderMediaTokenResponseSchema
>

export const meetingRecorderMediaArtifactSchema = z
  .object({
    artifactId: z.string().regex(/^media_[0-9a-f-]{36}$/i),
    role: z.enum(['tab-recording', 'microphone-recording', 'self-video']),
    filename: z.string(),
    mimeType: z.enum(['video/webm', 'video/mp4', 'audio/webm', 'audio/mp4']),
    bytes: z.number().int().positive().safe(),
  })
  .strict()
export type MeetingRecorderMediaArtifactDto = z.infer<typeof meetingRecorderMediaArtifactSchema>

export const meetingRecorderMediaPlaybackSchema = z
  .object({
    url: httpsUrlSchema,
    expiresAt: isoDateTimeSchema,
  })
  .strict()
export type MeetingRecorderMediaPlaybackDto = z.infer<typeof meetingRecorderMediaPlaybackSchema>

export const meetingRecorderRecordingSummarySchema = z
  .object({
    id: z.string().uuid(),
    interviewId: z.string().uuid().nullable(),
    connectionId: z.string().uuid(),
    externalRecordingId: z.string(),
    revision: z.number().int().positive(),
    title: z.string(),
    startedAt: isoDateTimeSchema,
    endedAt: isoDateTimeSchema.nullable(),
    durationMs: z.number().min(0).nullable(),
    provider: z.string().nullable(),
    meetingId: z.string().nullable(),
    meetingUrl: httpsUrlSchema.nullable(),
    stageAtLink: z.string().nullable(),
    matchedBy: z.enum(['meeting-id', 'meeting-url', 'manual', 'unmatched']),
    readiness: meetingRecorderReadinessSchema,
    linkedByUserId: z.string().uuid().nullable(),
    linkedAt: isoDateTimeSchema.nullable(),
    lastEventAt: isoDateTimeSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict()
export type MeetingRecorderRecordingSummaryDto = z.infer<
  typeof meetingRecorderRecordingSummarySchema
>

export const meetingRecorderRecordingDetailSchema = meetingRecorderRecordingSummarySchema
  .extend({
    snapshot: meetingRecorderRecordingStoredSchema,
  })
  .strict()
export type MeetingRecorderRecordingDetailDto = z.infer<typeof meetingRecorderRecordingDetailSchema>

export const meetingRecorderUnmatchedRecordingSchema = meetingRecorderRecordingSummarySchema
  .extend({
    interviewId: z.null(),
  })
  .strict()
export type MeetingRecorderUnmatchedRecordingDto = z.infer<
  typeof meetingRecorderUnmatchedRecordingSchema
>

export const linkMeetingRecorderRecordingSchema = z
  .object({
    interviewId: z.string().uuid().nullable(),
  })
  .strict()
export type LinkMeetingRecorderRecordingDto = z.infer<typeof linkMeetingRecorderRecordingSchema>
