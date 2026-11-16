/**
 * PR #1351 fix round 5: a Cyrillic stress mark is folded off before the name match (CR-H-1), and a
 * stored name split only by an invisible is read both ways (finding 3).
 */
import { describe, expect, it } from 'vitest'
import { redactContacts, type ContactContext } from './contact-scan'

describe('a Cyrillic stress mark is folded off (CR-H-1)', () => {
  const ivan: ContactContext = { fullName: 'Иван Петренко', emails: [] }

  it.each([
    ['Senior Ива\u0301н Петре\u0301нко here', 'Senior [REDACTED] here'],
    ['Senior Петре\u0301нко here', 'Senior [REDACTED] here'],
    ['Senior Петренко\u0301 here', 'Senior [REDACTED] here'],
  ])('redacts %j as %j', (text, redacted) => {
    expect(redactContacts(text, ivan)).toBe(redacted)
  })
})

describe('a stored name split only by an invisible (finding 3)', () => {
  it.each(['\u200B', '\u2060', '\uFEFF', '\u00AD'])(
    'redacts the name written with a space when it is stored with %j between the parts',
    (c) => {
      const stored: ContactContext = { fullName: `Ivan${c}Petrenko`, emails: [] }
      expect(redactContacts('by Ivan Petrenko today', stored)).toBe('by [REDACTED] today')
      expect(redactContacts('by Petrenko today', stored)).toBe('by [REDACTED] today')
      // the joined reading still holds: glued, the name is one surname-like token
      expect(redactContacts('by IvanPetrenko today', stored)).toBe('by [REDACTED] today')
      expect(redactContacts('by Ivan today', stored)).toBe('by Ivan today')
    },
  )

  it('an invisible inside a stored part still matches the part written whole', () => {
    const stored: ContactContext = { fullName: 'Iv\u200Can Petrenko', emails: [] }
    expect(redactContacts('by Ivan Petrenko today', stored)).toBe('by [REDACTED] today')
    // round 7: the split reading is redacted whole, fail-closed, so its fragments pair too
    expect(redactContacts('by Iv an today', stored)).toBe('by [REDACTED] today')
  })
})
