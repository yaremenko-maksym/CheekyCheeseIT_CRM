import { describe, expect, it } from 'vitest'
import { createI18n } from '../i18n'
import { PENDING_TITLE_MESSAGES } from './pending-title-registry'
import { pendingTitleKindSchema } from './pending'
import { renderMessage } from './notification-registry'

const UK = createI18n('uk')
const EN = createI18n('en')

const params = { projectName: 'TechFlow Solutions', seniorName: 'Олексій Коваль' }

describe('PENDING_TITLE_MESSAGES', () => {
  it('has exactly one descriptor per PendingTitleKind, each with a non-empty message and a namespaced id', () => {
    expect(Object.keys(PENDING_TITLE_MESSAGES).sort()).toEqual(
      [...pendingTitleKindSchema.options].sort(),
    )
    for (const kind of pendingTitleKindSchema.options) {
      const d = PENDING_TITLE_MESSAGES[kind]
      expect(d.id).toBe(`pending.title.${kind}`)
      expect((d.message ?? '').length).toBeGreaterThan(0)
    }
  })

  it('renders every kind in uk (nominative params substituted untouched)', () => {
    expect(renderMessage(UK, PENDING_TITLE_MESSAGES.CONTRACT)).toBe('Ваш контракт')
    expect(renderMessage(UK, PENDING_TITLE_MESSAGES.SHARE_PROJECT, params)).toBe(
      'Частка за проєктом «TechFlow Solutions»',
    )
    expect(renderMessage(UK, PENDING_TITLE_MESSAGES.SHARE_BASE_MINE)).toBe(
      'Частка за замовчуванням',
    )
    expect(renderMessage(UK, PENDING_TITLE_MESSAGES.SHARE_BASE_OTHER, params)).toBe(
      'Частка за замовчуванням — Олексій Коваль',
    )
    expect(renderMessage(UK, PENDING_TITLE_MESSAGES.PROJECT_APPROVAL, params)).toBe(
      'TechFlow Solutions',
    )
  })

  it('renders every kind in en as a second original (not the uk text)', () => {
    expect(renderMessage(EN, PENDING_TITLE_MESSAGES.CONTRACT)).toBe('Your contract')
    expect(renderMessage(EN, PENDING_TITLE_MESSAGES.SHARE_PROJECT, params)).toBe(
      'Share in project “TechFlow Solutions”',
    )
    expect(renderMessage(EN, PENDING_TITLE_MESSAGES.SHARE_BASE_MINE)).toBe('Default share')
    expect(renderMessage(EN, PENDING_TITLE_MESSAGES.SHARE_BASE_OTHER, params)).toBe(
      'Default share — Олексій Коваль',
    )
    expect(renderMessage(EN, PENDING_TITLE_MESSAGES.PROJECT_APPROVAL, params)).toBe(
      'TechFlow Solutions',
    )
  })
})
