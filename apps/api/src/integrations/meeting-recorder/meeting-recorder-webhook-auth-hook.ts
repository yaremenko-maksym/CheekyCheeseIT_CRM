import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import type { FastifyReply, FastifyRequest } from 'fastify'

export const MEETING_RECORDER_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60

const WEBHOOK_ROUTE = '/api/integrations/meeting-recorder/:connectionId/webhook'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type RequiredWebhookHeader = 'webhook-id' | 'webhook-timestamp' | 'webhook-signature'

function rawHeaderCount(request: FastifyRequest, target: string): number {
  let count = 0
  const rawHeaders = request.raw.rawHeaders
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]!.toLowerCase() === target) count += 1
  }
  return count
}

function singleHeader(request: FastifyRequest, name: RequiredWebhookHeader): string | null {
  if (rawHeaderCount(request, name) !== 1) return null
  const value = request.headers[name]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function rejectUnauthorized(reply: FastifyReply): void {
  void reply.status(401).send({ code: 'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED' })
}

export function isMeetingRecorderConnectionId(value: string): boolean {
  return UUID_RE.test(value)
}

export function registerMeetingRecorderWebhookOnRequestHook(app: NestFastifyApplication): void {
  const fastify = app.getHttpAdapter().getInstance()

  fastify.addHook('onRequest', (request, reply, done) => {
    if (request.routeOptions.url !== WEBHOOK_ROUTE) {
      done()
      return
    }

    const params = request.params as { connectionId?: unknown }
    const connectionId = params.connectionId
    if (typeof connectionId !== 'string' || !isMeetingRecorderConnectionId(connectionId)) {
      rejectUnauthorized(reply)
      return
    }

    const webhookId = singleHeader(request, 'webhook-id')
    const timestamp = singleHeader(request, 'webhook-timestamp')
    const signature = singleHeader(request, 'webhook-signature')
    if (
      webhookId === null ||
      // Stryker disable next-line ConditionalExpression: if this null check is forced false, RegExp.test(null) coerces to "null" and the following digits-only check still rejects the request; the explicit branch is kept for type narrowing and clarity
      timestamp === null ||
      signature === null ||
      !/^-?\d+$/.test(timestamp)
    ) {
      rejectUnauthorized(reply)
      return
    }

    const timestampSeconds = Number(timestamp)
    const nowSeconds = Math.floor(Date.now() / 1000)
    if (
      !Number.isSafeInteger(timestampSeconds) ||
      Math.abs(nowSeconds - timestampSeconds) > MEETING_RECORDER_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
    ) {
      rejectUnauthorized(reply)
      return
    }

    done()
  })
}
