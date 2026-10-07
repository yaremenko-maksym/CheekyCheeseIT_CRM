import { HttpException, type HttpStatus } from '@nestjs/common'
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
  status: HttpStatus,
): HttpException {
  return new HttpException({ code }, status)
}
