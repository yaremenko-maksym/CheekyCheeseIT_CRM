import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { errorCodes } from 'fastify'

export const MEETING_RECORDER_WEBHOOK_BODY_LIMIT_BYTES = 2 * 1024 * 1024

/** The Fastify route template of the webhook (global prefix included). */
export const MEETING_RECORDER_WEBHOOK_ROUTE =
  '/api/integrations/meeting-recorder/:connectionId/webhook'

export const MEETING_RECORDER_CLOUDEVENTS_CONTENT_TYPE =
  /^application\/cloudevents\+json\s*(;.*)?$/i

/**
 * Preserve the exact signed payload string for Standard Webhooks verification.
 *
 * SR-865-L-5: Nest registers every route on the root Fastify instance, so a parser cannot
 * be encapsulated with the webhook route alone. It is scoped instead: on every other route
 * an `onRequest` hook answers this content type with Fastify's own
 * `FST_ERR_CTP_INVALID_MEDIA_TYPE` (415) before the body is read — exactly what those
 * routes answered before this parser existed — so the 2 MiB string budget belongs to the
 * webhook only.
 */
export function registerMeetingRecorderContentTypeParser(app: NestFastifyApplication): void {
  const fastify = app.getHttpAdapter().getInstance()

  fastify.addHook('onRequest', (request, _reply, done) => {
    const contentType = request.headers['content-type']
    if (
      isMeetingRecorderCloudEventsContentType(contentType) &&
      request.routeOptions.url !== MEETING_RECORDER_WEBHOOK_ROUTE
    ) {
      done(new errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE(contentType))
      return
    }
    done()
  })

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
