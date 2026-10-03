import { describe, expect, it } from 'vitest'
import { createI18n } from '../i18n'
import { renderMessage } from './notification-registry'
import { EMAIL_INVITE_MESSAGES as M } from './invite-email-registry'

/**
 * Expected values below are HAND-WRITTEN literals, never derived from the registry (a
 * tautological test passes by construction). The compiled catalog wins at render time, so a
 * mutated `message` is invisible through i18n — the first table reads `.id` / `.message` directly.
 */

const SOURCE_ROWS: ReadonlyArray<readonly [keyof typeof M, string, string]> = [
  ['subject', 'email.invite.subject', 'Доступ до CRM CheekyCheeseIT'],
  [
    'greeting',
    'email.invite.greeting',
    '{firstName}: цю адресу додали до CRM CheekyCheeseIT як вашу особисту.',
  ],
  [
    'confirmLine1',
    'email.invite.confirm.line1',
    'Підтвердіть її — тоді входити можна буде і з робочої адреси, і з цієї.',
  ],
  [
    'confirmLine2',
    'email.invite.confirm.line2',
    'Доки не підтвердите, вхід працює лише за робочою адресою.',
  ],
  ['button', 'email.invite.button', 'Підтвердити адресу'],
  ['footer', 'email.invite.footer', 'Якщо лист прийшов помилково, {warning}.'],
  ['footerWarning', 'email.invite.footer.warning', 'не переходьте за посиланням'],
]

describe('EMAIL_INVITE_MESSAGES — direct pins (the compiled catalog wins at render time, so a mutated `message` is invisible through i18n; read the fields directly)', () => {
  it.each(SOURCE_ROWS)('%s: id and uk source', (key, id, uk) => {
    expect(M[key].id).toBe(id)
    expect(M[key].message).toBe(uk)
  })

  it('has exactly the seven keys of the table', () => {
    expect(Object.keys(M).sort()).toEqual(SOURCE_ROWS.map((r) => r[0]).sort())
  })
})

describe('uk / en golden renders (hand-written expectations)', () => {
  const uk = createI18n('uk')
  const en = createI18n('en')

  it('uk: subject, button, confirm lines', () => {
    expect(renderMessage(uk, M.subject)).toBe('Доступ до CRM CheekyCheeseIT')
    expect(renderMessage(uk, M.button)).toBe('Підтвердити адресу')
    expect(renderMessage(uk, M.confirmLine1)).toBe(
      'Підтвердіть її — тоді входити можна буде і з робочої адреси, і з цієї.',
    )
    expect(renderMessage(uk, M.confirmLine2)).toBe(
      'Доки не підтвердите, вхід працює лише за робочою адресою.',
    )
  })

  it('en: subject, button, confirm lines', () => {
    expect(renderMessage(en, M.subject)).toBe('Access to CheekyCheeseIT CRM')
    expect(renderMessage(en, M.button)).toBe('Confirm address')
    expect(renderMessage(en, M.confirmLine1)).toBe(
      'Confirm it — then you will be able to sign in with either your work address or this one.',
    )
    expect(renderMessage(en, M.confirmLine2)).toBe(
      'Until you confirm, sign-in works only with your work address.',
    )
  })

  it('uk: greeting with a Latin and with a Cyrillic first name', () => {
    expect(renderMessage(uk, M.greeting, { firstName: 'Oleksiy' })).toBe(
      'Oleksiy: цю адресу додали до CRM CheekyCheeseIT як вашу особисту.',
    )
    expect(renderMessage(uk, M.greeting, { firstName: 'Олексій' })).toBe(
      'Олексій: цю адресу додали до CRM CheekyCheeseIT як вашу особисту.',
    )
  })

  it('en: greeting with a Latin and with a Cyrillic first name', () => {
    expect(renderMessage(en, M.greeting, { firstName: 'Oleksiy' })).toBe(
      'Oleksiy, this address was added to CheekyCheeseIT CRM as your personal one.',
    )
    expect(renderMessage(en, M.greeting, { firstName: 'Олексій' })).toBe(
      'Олексій, this address was added to CheekyCheeseIT CRM as your personal one.',
    )
  })

  it('uk / en: footer sentence embeds the warning phrase', () => {
    expect(renderMessage(uk, M.footerWarning)).toBe('не переходьте за посиланням')
    expect(renderMessage(uk, M.footer, { warning: 'не переходьте за посиланням' })).toBe(
      'Якщо лист прийшов помилково, не переходьте за посиланням.',
    )
    expect(renderMessage(en, M.footerWarning)).toBe('do not follow the link')
    expect(renderMessage(en, M.footer, { warning: 'do not follow the link' })).toBe(
      'If this email reached you by mistake, do not follow the link.',
    )
  })

  it('a name that itself looks like a placeholder renders literally (ICU params are not parsed)', () => {
    expect(renderMessage(en, M.greeting, { firstName: '{firstName}' })).toBe(
      '{firstName}, this address was added to CheekyCheeseIT CRM as your personal one.',
    )
    expect(renderMessage(uk, M.greeting, { firstName: '{warning}' })).toBe(
      '{warning}: цю адресу додали до CRM CheekyCheeseIT як вашу особисту.',
    )
  })
})

describe('catalog hygiene', () => {
  const keys = Object.keys(M) as (keyof typeof M)[]

  it('every id is unique and under email.invite.', () => {
    const ids = keys.map((k) => M[k].id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.startsWith('email.invite.'))).toBe(true)
  })

  it.each(['uk', 'en'] as const)(
    '%s: no ASCII apostrophe artifact in any rendered message',
    (loc) => {
      const i18n = createI18n(loc)
      for (const k of keys) {
        const out = renderMessage(i18n, M[k], { firstName: 'N', warning: 'W' })
        expect(out).not.toMatch(/'/)
      }
    },
  )

  it.each(['uk', 'en'] as const)('%s: no digits (privacy: no amounts/percentages)', (loc) => {
    const i18n = createI18n(loc)
    for (const k of keys) {
      expect(renderMessage(i18n, M[k], { firstName: 'N', warning: 'W' })).not.toMatch(/[0-9]/)
    }
  })

  it('en renders contain no Cyrillic (a second original, not a leftover of the uk source)', () => {
    const i18n = createI18n('en')
    for (const k of keys) {
      expect(renderMessage(i18n, M[k], { firstName: 'N', warning: 'W' })).not.toMatch(
        /[А-Яа-яЁёІіЇїЄєҐґ]/,
      )
    }
  })
})
