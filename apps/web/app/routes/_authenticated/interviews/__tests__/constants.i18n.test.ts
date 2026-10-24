import { i18n } from '@lingui/core'
import type { MeetingRecorderMediaArtifactDto } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { loadCatalog } from '@/test/i18n'
import { RECORDING_MEDIA_ROLE_LABEL_MESSAGES } from '../constants'

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
