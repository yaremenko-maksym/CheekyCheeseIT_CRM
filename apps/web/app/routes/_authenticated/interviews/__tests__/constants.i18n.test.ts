import { i18n } from '@lingui/core'
import type { MeetingRecorderMediaArtifactDto } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { loadCatalog } from '@/test/i18n'
import { RECORDING_MEDIA_ROLE_LABEL_MESSAGES, STAGE_LABEL_MESSAGES } from '../constants'

const ROLE_LABELS: Record<MeetingRecorderMediaArtifactDto['role'], [uk: string, en: string]> = {
  'tab-recording': ['Запис вкладки', 'Tab recording'],
  'microphone-recording': ['Запис мікрофона', 'Microphone recording'],
  'self-video': ['Відео з камери', 'Camera video'],
}

describe('RECORDING_MEDIA_ROLE_LABEL_MESSAGES', () => {
  it.each([
    ['uk', 0],
    ['en', 1],
  ] as const)('%s: localizes every recording media role', async (locale, labelIndex) => {
    await loadCatalog(locale)
    for (const [role, labels] of Object.entries(ROLE_LABELS) as [
      MeetingRecorderMediaArtifactDto['role'],
      [string, string],
    ][]) {
      expect(i18n._(RECORDING_MEDIA_ROLE_LABEL_MESSAGES[role])).toBe(labels[labelIndex])
    }
  })
})

describe('STAGE_LABEL_MESSAGES', () => {
  // task-sources-07c added the SUBMITTED column. Its label is the only text HR and the senior see
  // for a card that came out of the sourcing queue, and it must be a real catalog hit in both
  // locales — an untranslated or blank `msg` renders as an empty Kanban column header.
  it.each([
    ['uk', 'Надіслано'],
    ['en', 'Submitted'],
  ] as const)('%s: labels the SUBMITTED stage', async (locale, label) => {
    await loadCatalog(locale)
    expect(i18n._(STAGE_LABEL_MESSAGES.SUBMITTED)).toBe(label)
  })
})
