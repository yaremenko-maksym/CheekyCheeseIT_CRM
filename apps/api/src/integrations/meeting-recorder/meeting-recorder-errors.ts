import { randomUUID } from 'node:crypto'
import { HttpException, HttpStatus, type HttpStatus as HttpStatusCode } from '@nestjs/common'
import type { MeetingRecorderErrorCode } from '@crm/shared'

type WebhookErrorCode = Extract<
  MeetingRecorderErrorCode,
  | 'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED'
  | 'MEETING_RECORDER_SOURCE_MISMATCH'
  | 'MEETING_RECORDER_CONNECTION_DISABLED'
  | 'MEETING_RECORDER_CONTENT_TYPE_UNSUPPORTED'
  | 'MEETING_RECORDER_EVENT_INVALID'
>

/** Webhook responses intentionally expose only the stable machine code. */
export function meetingRecorderWebhookError(
  code: WebhookErrorCode,
  status: HttpStatusCode,
): HttpException {
  return new HttpException({ code }, status)
}

const EXPECTED_WEBHOOK_ERROR_CODES = new Set<WebhookErrorCode>([
  'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED',
  'MEETING_RECORDER_SOURCE_MISMATCH',
  'MEETING_RECORDER_CONNECTION_DISABLED',
  'MEETING_RECORDER_CONTENT_TYPE_UNSUPPORTED',
  'MEETING_RECORDER_EVENT_INVALID',
])

function isExpectedWebhookError(error: unknown): error is HttpException {
  if (!(error instanceof HttpException)) return false
  const status = error.getStatus()
  if (status < 400 || status >= 500) return false
  const response = error.getResponse()
  if (typeof response !== 'object' || response === null || !('code' in response)) return false
  return EXPECTED_WEBHOOK_ERROR_CODES.has((response as { code: WebhookErrorCode }).code)
}

/**
 * The webhook payload contains transcript/note material. Drizzle/Postgres
 * failures may embed SQL parameters in Error.message/stack, so unexpected
 * ingestion failures must be replaced before the global telemetry filter sees
 * them. The replacement contains only bounded, allow-listed operational data.
 */
export function normalizeMeetingRecorderWebhookIngestionError(
  error: unknown,
  connectionId: string,
): HttpException {
  if (isExpectedWebhookError(error)) return error

  const requestId = randomUUID()
  const operation = 'meeting-recorder-webhook-ingest'
  const diagnosticCode = 'UNEXPECTED_INGESTION_FAILURE'
  const message = `${operation} failed; requestId=${requestId}; connectionId=${connectionId}; diagnosticCode=${diagnosticCode}`

  return new HttpException(
    {
      code: 'MEETING_RECORDER_WEBHOOK_INGESTION_FAILED',
      message,
      requestId,
      operation,
      diagnosticCode,
      connectionId,
    },
    HttpStatus.SERVICE_UNAVAILABLE,
  )
}
