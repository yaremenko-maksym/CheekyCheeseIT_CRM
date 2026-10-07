import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MEETING_RECORDER_ERROR_CODES,
  MEETING_RECORDER_ERROR_FALLBACK_EN,
  MEETING_RECORDER_ERROR_MESSAGES,
  MEETING_RECORDER_ERROR_PARAMS,
} from './meeting-recorder'

const EXPECTED_COPY = {
  MEETING_RECORDER_CONNECTION_NOT_FOUND: {
    uk: 'Підключення Meeting Recorder не знайдено',
    en: 'Meeting Recorder connection not found',
  },
  MEETING_RECORDER_WEBHOOK_UNAUTHORIZED: {
    uk: 'Не вдалося автентифікувати webhook Meeting Recorder',
    en: 'Meeting Recorder webhook authentication failed',
  },
  MEETING_RECORDER_SOURCE_MISMATCH: {
    uk: 'Джерело Meeting Recorder не відповідає підключеному джерелу',
    en: 'Meeting Recorder source does not match the paired source',
  },
  MEETING_RECORDER_CONNECTION_DISABLED: {
    uk: 'Підключення Meeting Recorder вимкнено',
    en: 'Meeting Recorder connection is disabled',
  },
  MEETING_RECORDER_CONTENT_TYPE_UNSUPPORTED: {
    uk: 'Тип вмісту webhook Meeting Recorder не підтримується',
    en: 'Meeting Recorder webhook content type is not supported',
  },
  MEETING_RECORDER_EVENT_INVALID: {
    uk: 'Подія Meeting Recorder не відповідає підтримуваному контракту V1',
    en: 'Meeting Recorder event does not match the supported V1 contract',
  },
  MEETING_RECORDER_RECORDING_NOT_FOUND: {
    uk: 'Запис зустрічі не знайдено',
    en: 'Meeting recording not found',
  },
  MEETING_RECORDER_RECORDING_ACCESS_DENIED: {
    uk: 'Немає доступу до цього запису зустрічі',
    en: "You don't have access to this meeting recording",
  },
} as const

function catalogMessage(locale: 'en' | 'uk', code: string): string | null {
  const po = readFileSync(
    join(__dirname, '..', '..', 'i18n', 'locales', locale, 'messages.po'),
    'utf8',
  )
  const match = po.match(new RegExp(`msgid "api-error\\.${code}"\\nmsgstr "((?:[^"\\\\]|\\\\.)*)"`))
  return match?.[1] ?? null
}

describe('meeting recorder API errors', () => {
  it('pins the dedicated V1 error registry', () => {
    expect(MEETING_RECORDER_ERROR_CODES).toEqual([
      'MEETING_RECORDER_CONNECTION_NOT_FOUND',
      'MEETING_RECORDER_WEBHOOK_UNAUTHORIZED',
      'MEETING_RECORDER_SOURCE_MISMATCH',
      'MEETING_RECORDER_CONNECTION_DISABLED',
      'MEETING_RECORDER_CONTENT_TYPE_UNSUPPORTED',
      'MEETING_RECORDER_EVENT_INVALID',
      'MEETING_RECORDER_RECORDING_NOT_FOUND',
      'MEETING_RECORDER_RECORDING_ACCESS_DENIED',
    ])
  })

  it('uses parameter-free exact ids and non-empty uk/en copy for every code', () => {
    for (const code of MEETING_RECORDER_ERROR_CODES) {
      expect(MEETING_RECORDER_ERROR_PARAMS[code]).toEqual([])
      expect(MEETING_RECORDER_ERROR_MESSAGES[code].id).toBe(`api-error.${code}`)
      expect(MEETING_RECORDER_ERROR_MESSAGES[code].message).toBe(EXPECTED_COPY[code].uk)
      expect(MEETING_RECORDER_ERROR_FALLBACK_EN[code]).toBe(EXPECTED_COPY[code].en)
      expect(catalogMessage('uk', code)).toBe(EXPECTED_COPY[code].uk)
      expect(catalogMessage('en', code)).toBe(EXPECTED_COPY[code].en)
    }
  })
})
