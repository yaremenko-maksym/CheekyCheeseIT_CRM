import { randomUUID } from 'node:crypto'
import {
  HttpException,
  HttpStatus,
  Logger,
  type HttpStatus as HttpStatusCode,
} from '@nestjs/common'
import type { MeetingRecorderErrorCode } from '@crm/shared'
import { dbErrorLogSuffix, strictErrorStack } from '../../database/pg-errors'

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

const logger = new Logger('MeetingRecorderWebhook')

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

  // CR-M-2: the 503 deliberately carries no detail, so without this line the
  // requestId it mints would correlate with nothing and a prod ingestion
  // failure would be unexplainable. The finding was about EGRESS of SQL
  // parameters, not about having no diagnostic — so log through the #1042
  // helpers, which drop drizzle's parameter values and a pg message that could
  // carry them while keeping the SQLSTATE, the table and the frames. Keyed by
  // the SAME requestId the caller receives.
  // SR-M-2: `strictErrorStack`, not `safeErrorStack` — on a path whose body is
  // candidate transcript, the message of an ARBITRARY error is untrusted, not just
  // that of a pg/drizzle node.
  logger.error(`${message}${dbErrorLogSuffix(error)}`, strictErrorStack(error))

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
