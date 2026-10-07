import type { MessageDescriptor } from '@lingui/core'

export const MEETING_RECORDER_ERROR_CODES = [
  'MEETING_RECORDER_CONNECTION_NOT_FOUND',
  'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED',
  'MEETING_RECORDER_SOURCE_MISMATCH',
  'MEETING_RECORDER_CONNECTION_DISABLED',
  'MEETING_RECORDER_CONTENT_TYPE_UNSUPPORTED',
  'MEETING_RECORDER_EVENT_INVALID',
  'MEETING_RECORDER_RECORDING_NOT_FOUND',
  'MEETING_RECORDER_RECORDING_ACCESS_DENIED',
] as const
export type MeetingRecorderErrorCode = (typeof MEETING_RECORDER_ERROR_CODES)[number]

export const MEETING_RECORDER_ERROR_PARAMS = {
  MEETING_RECORDER_CONNECTION_NOT_FOUND: [],
  MEETING_RECORDER_WEBHOOK_UNAUTHORIZED: [],
  MEETING_RECORDER_SOURCE_MISMATCH: [],
  MEETING_RECORDER_CONNECTION_DISABLED: [],
  MEETING_RECORDER_CONTENT_TYPE_UNSUPPORTED: [],
  MEETING_RECORDER_EVENT_INVALID: [],
  MEETING_RECORDER_RECORDING_NOT_FOUND: [],
  MEETING_RECORDER_RECORDING_ACCESS_DENIED: [],
} as const satisfies Record<MeetingRecorderErrorCode, readonly string[]>

export const MEETING_RECORDER_ERROR_MESSAGES: Record<MeetingRecorderErrorCode, MessageDescriptor> =
  {
    MEETING_RECORDER_CONNECTION_NOT_FOUND: /* i18n */ {
      id: 'api-error.MEETING_RECORDER_CONNECTION_NOT_FOUND',
      message: 'Підключення Meeting Recorder не знайдено',
    },
    MEETING_RECORDER_WEBHOOK_UNAUTHORIZED: /* i18n */ {
      id: 'api-error.MEETING_RECORDER_WEBHOOK_UNAUTHORIZED',
      message: 'Не вдалося автентифікувати webhook Meeting Recorder',
    },
    MEETING_RECORDER_SOURCE_MISMATCH: /* i18n */ {
      id: 'api-error.MEETING_RECORDER_SOURCE_MISMATCH',
      message: 'Джерело Meeting Recorder не відповідає підключеному джерелу',
    },
    MEETING_RECORDER_CONNECTION_DISABLED: /* i18n */ {
      id: 'api-error.MEETING_RECORDER_CONNECTION_DISABLED',
      message: 'Підключення Meeting Recorder вимкнено',
    },
    MEETING_RECORDER_CONTENT_TYPE_UNSUPPORTED: /* i18n */ {
      id: 'api-error.MEETING_RECORDER_CONTENT_TYPE_UNSUPPORTED',
      message: 'Тип вмісту webhook Meeting Recorder не підтримується',
    },
    MEETING_RECORDER_EVENT_INVALID: /* i18n */ {
      id: 'api-error.MEETING_RECORDER_EVENT_INVALID',
      message: 'Подія Meeting Recorder не відповідає підтримуваному контракту V1',
    },
    MEETING_RECORDER_RECORDING_NOT_FOUND: /* i18n */ {
      id: 'api-error.MEETING_RECORDER_RECORDING_NOT_FOUND',
      message: 'Запис зустрічі не знайдено',
    },
    MEETING_RECORDER_RECORDING_ACCESS_DENIED: /* i18n */ {
      id: 'api-error.MEETING_RECORDER_RECORDING_ACCESS_DENIED',
      message: 'Немає доступу до цього запису зустрічі',
    },
  }

export const MEETING_RECORDER_ERROR_FALLBACK_EN: Record<MeetingRecorderErrorCode, string> = {
  MEETING_RECORDER_CONNECTION_NOT_FOUND: 'Meeting Recorder connection not found',
  MEETING_RECORDER_WEBHOOK_UNAUTHORIZED: 'Meeting Recorder webhook authentication failed',
  MEETING_RECORDER_SOURCE_MISMATCH: 'Meeting Recorder source does not match the paired source',
  MEETING_RECORDER_CONNECTION_DISABLED: 'Meeting Recorder connection is disabled',
  MEETING_RECORDER_CONTENT_TYPE_UNSUPPORTED:
    'Meeting Recorder webhook content type is not supported',
  MEETING_RECORDER_EVENT_INVALID: 'Meeting Recorder event does not match the supported V1 contract',
  MEETING_RECORDER_RECORDING_NOT_FOUND: 'Meeting recording not found',
  MEETING_RECORDER_RECORDING_ACCESS_DENIED: "You don't have access to this meeting recording",
}
