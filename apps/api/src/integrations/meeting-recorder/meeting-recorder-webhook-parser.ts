import type { NestFastifyApplication } from '@nestjs/platform-fastify'

export const MEETING_RECORDER_WEBHOOK_BODY_LIMIT_BYTES = 2 * 1024 * 1024

export const MEETING_RECORDER_CLOUDEVENTS_CONTENT_TYPE =
  /^application\/cloudevents\+json\s*(;.*)?$/i

/** Preserve the exact signed payload string for Standard Webhooks verification. */
export function registerMeetingRecorderContentTypeParser(app: NestFastifyApplication): void {
  const fastify = app.getHttpAdapter().getInstance()

  fastify.addContentTypeParser(
    MEETING_RECORDER_CLOUDEVENTS_CONTENT_TYPE,
    {
      parseAs: 'string',
      bodyLimit: MEETING_RECORDER_WEBHOOK_BODY_LIMIT_BYTES,
    },
    (_request, body, done) => done(null, body),
  )
}

export function isMeetingRecorderCloudEventsContentType(value: unknown): value is string {
  return typeof value === 'string' && MEETING_RECORDER_CLOUDEVENTS_CONTENT_TYPE.test(value)
}
