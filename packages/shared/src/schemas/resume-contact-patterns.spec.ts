/**
 * Contact patterns, fix round 3 (Unicode and punycode hosts, unlabelled Telegram handles, stored
 * handle links, label bounds). The patterns are shared with the API redaction, so a contact the
 * completeness check flags here is one the redaction removes.
 */
import { describe, expect, it } from 'vitest'
import type { ResumeFacts, ResumeFactsExperience } from './resume-facts'
import {
  RESUME_EMAIL_PATTERN,
  RESUME_TELEGRAM_LABEL_PATTERN,
  RESUME_URL_PATTERN,
  checkResumeCompleteness,
  normaliseTelegramHandle,
} from './resume-completeness'

const CTX = { displayName: 'José Müller', now: new Date('2026-11-10T00:00:00Z') }

/** The URL hit: group 1 for the bare form (its pattern consumes one boundary character), else the match. */
const urlHit = (text: string): string | undefined => {
  const m = RESUME_URL_PATTERN.exec(text)
  return m?.[1] ?? m?.[0]
}
const emailHit = (text: string): string | undefined => RESUME_EMAIL_PATTERN.exec(text)?.[1]

const EXPERIENCE: ResumeFactsExperience = {
  company: 'Acme',
  role: 'Engineer',
  location: 'Kyiv',
  start: '2020-01',
  end: '2023-06',
  current: false,
  technologies: ['React'],
  notes: ['Built the design system'],
}

const noteWith = (note: string): ResumeFacts => ({
  headline: 'Senior Frontend Engineer',
  location: { city: 'Kyiv', country: 'Ukraine' },
  workFormat: 'remote',
  skills: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'PostgreSQL'],
  experience: [{ ...EXPERIENCE, notes: [note] }],
  education: [{ institution: 'KPI', degree: 'BSc', startYear: 2015, endYear: 2019 }],
  languages: [{ name: 'English', level: 'C1' }],
  links: [],
})
const contactIssue = { path: 'experience.0.notes.0', code: 'CONTACT_IN_TEXT' }
const issuesOf = (note: string) => checkResumeCompleteness(noteWith(note), CTX)

describe('RESUME_URL_PATTERN — Unicode and punycode hosts (SO23-1)', () => {
  it.each([
    'пример.укр/резюме',
    'иван.рф/cv',
    'münchen.de/x',
    'иван.xn--p1ai/x',
    'example.xn--p1ai/cv',
    'EXAMPLE.XN--P1AI/cv',
  ])('matches %s whole', (url) => {
    expect(urlHit(`see ${url} now`)).toBe(url)
  })

  it.each(['münchen.de/x', 'example.xn--p1ai/cv'])('a note with %s is flagged', (url) => {
    expect(issuesOf(`see ${url}`)).toEqual([contactIssue])
  })

  it.each([
    'Node.js/Express and Express.JS/Nest',
    'Express.js/Nest backend',
    'typed in x.Ts/y',
    'Vue.js, Socket.IO, ASP.NET and .NET',
  ])('keeps the js / ts exclusion and the tech names: %s', (text) => {
    expect(urlHit(text)).toBeUndefined()
  })
})

describe('RESUME_EMAIL_PATTERN — punycode TLD (SO23-1)', () => {
  it.each(['ivan@example.xn--p1ai', 'ivan@EXAMPLE.XN--P1AI', 'іван@приклад.укр'])(
    'matches %s whole',
    (email) => {
      expect(emailHit(`mail ${email} now`)).toBe(email)
    },
  )
})

describe('host label count (SR-L-8)', () => {
  const host15 = `${'a.'.repeat(14)}co`

  it('a 15-label host is a whole email and a whole URL', () => {
    expect(emailHit(`x@${host15}`)).toBe(`x@${host15}`)
    expect(urlHit(`${host15}/x`)).toBe(`${host15}/x`)
  })

  it('20 labels is the bound, so a URL match starts at the 20th label from the TLD', () => {
    expect(emailHit(`x@${'a.'.repeat(20)}co`)).toBe(`x@${'a.'.repeat(20)}co`)
    expect(emailHit(`x@${'a.'.repeat(21)}co`)).toBeUndefined()
    expect(urlHit(`b.${'a.'.repeat(20)}com/x`)).toBe(`${'a.'.repeat(20)}com/x`)
  })

  it('an email with a local part over 64 characters is flagged and matched whole (SR-L-7, SR3-M-1)', () => {
    const email = `${'a'.repeat(40)}.${'b'.repeat(39)}@example.io`
    expect(issuesOf(`mail ${email}`)).toEqual([contactIssue])
    expect(emailHit(email)).toBe(email)
  })

  it('a note with a 15-label URL is flagged', () => {
    expect(issuesOf(`see ${host15}/x`)).toEqual([contactIssue])
  })
})

describe('RESUME_TELEGRAM_LABEL_PATTERN — no colon, a dash, the Cyrillic short label (SO23-2)', () => {
  const hitOf = (text: string) => {
    const m = RESUME_TELEGRAM_LABEL_PATTERN.exec(text)
    return m?.[1] ?? m?.[0]
  }

  it.each([
    ['TG @mark_dev', 'TG @mark_dev'],
    ['Telegram - @mark_dev', 'Telegram - @mark_dev'],
    ['Telegram @mark_dev', 'Telegram @mark_dev'],
    ['Telegram — @mark_dev', 'Telegram — @mark_dev'],
    ['tg—mark_dev', 'tg—mark_dev'],
    ['tg – mark_dev', 'tg – mark_dev'],
    ['tg@mark_dev', 'tg@mark_dev'],
    ['ping (тг: mark_dev)', 'тг: mark_dev'],
    ['ТГ @mark_dev', 'ТГ @mark_dev'],
    ['Тг—mark_dev', 'Тг—mark_dev'],
    ['моїТГ: mark_dev', 'ТГ: mark_dev'],
  ])('%j hits as %j', (text, hit) => {
    expect(hitOf(text)).toBe(hit)
  })

  it.each([
    'Telegram bots',
    'TG integration',
    'Telegram-integration service',
    'TG-integration',
    'Debug tg:12345',
    'xтг: mark_dev',
    'мітг: mark_dev',
    'ТГ 12345',
  ])('no label in %j: no separator and no @, or no word boundary', (text) => {
    expect(RESUME_TELEGRAM_LABEL_PATTERN.exec(text)).toBeNull()
  })

  it.each([
    ['MyTelegram: mark_dev', 'Telegram: mark_dev'],
    ['PersonalTG: mark_dev', 'TG: mark_dev'],
  ])('the glued labels keep their hits: %j gives %j', (text, hit) => {
    expect(hitOf(text)).toBe(hit)
  })

  it.each(['TG @mark_dev', 'Telegram - @mark_dev', 'тг: mark_dev', 'tg—mark_dev'])(
    'a note with %j is flagged',
    (note) => {
      expect(issuesOf(`ping ${note}`)).toContainEqual(contactIssue)
    },
  )

  it.each(['Telegram bots', 'TG integration', 'Debug tg:12345'])(
    'a note with %j is not flagged',
    (note) => {
      expect(issuesOf(note)).toEqual([])
    },
  )
})

describe('normaliseTelegramHandle — links to the handle (SO23-4)', () => {
  it.each([
    ['t.me/mark_dev?start=1', 'mark_dev'],
    ['t.me/mark_dev/', 'mark_dev'],
    ['https://t.me/mark_dev#top', 'mark_dev'],
    ['tg://resolve?domain=mark_dev', 'mark_dev'],
    ['TG://RESOLVE?DOMAIN=mark_dev&start=1', 'mark_dev'],
    ['mark_t.me/dev', undefined],
    ['mark@dev', undefined],
  ])('%j becomes %j', (stored, handle) => {
    expect(normaliseTelegramHandle(stored)).toBe(handle)
  })

  it('a stored tg:// link flags the handle in a note', () => {
    const facts = noteWith('ask mark_dev')
    expect(
      checkResumeCompleteness(facts, { ...CTX, telegram: 'tg://resolve?domain=mark_dev' }),
    ).toEqual([contactIssue])
  })
})

describe('linear time on the new branches (R91)', () => {
  it.each([
    ['a.', 'a.'.repeat(25_000)],
    ['a-.', 'a-.'.repeat(16_667)],
    ['тг - ', 'тг - '.repeat(10_000)],
  ])('a 50k-character %s input is checked in under 500 ms', (_, note) => {
    const started = performance.now()
    issuesOf(note)
    expect(performance.now() - started).toBeLessThan(500)
  })

  // Linear, but Unicode classes cost ~10x ASCII on Node 22 (50k Cyrillic ≈ 300 ms for the URL
  // pattern alone), so the Cyrillic case runs at 10k: five times the longest field (2000).
  it('a 10k-character Cyrillic host repeat is checked in under 500 ms', () => {
    const started = performance.now()
    issuesOf('пример.'.repeat(1_429))
    expect(performance.now() - started).toBeLessThan(500)
  })

  // SR3-L-3: the phone lookahead runs only where a phone can start, so a long separator run
  // goes through the full check (round 3 timed the label pattern alone here).
  it.each([
    ['spaces', ' '.repeat(50_000)],
    ['tg + spaces', `tg${' '.repeat(50_000)}`],
    ['Telegram + spaces', `Telegram${' '.repeat(50_000)}`],
    ['тг + spaces and a hyphen', `тг${' '.repeat(25_000)}-${' '.repeat(25_000)}`],
    ['tg: + spaces', `tg:${' '.repeat(50_000)}`],
    ['Telegram:@ + spaces', `Telegram:@${' '.repeat(50_000)}`],
  ])('a 50k-character %s input is checked in under 500 ms (SR3-L-3)', (_, note) => {
    const started = performance.now()
    issuesOf(note)
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('fix round 4', () => {
  describe('the bare URL starts at a label boundary (SR3-M-1)', () => {
    it.each([
      ['see foo_github.com/x', 'github.com/x'],
      // The `(` is the consumed boundary, not the hit; the path `\S*` keeps the `)`, as before.
      ['(sub.domain.io/a)', 'sub.domain.io/a)'],
      ['see пример.укр/резюме now', 'пример.укр/резюме'],
      ['пример.укр/x', 'пример.укр/x'],
    ])('the hit in %j is group 1, %j', (text, hit) => {
      expect(urlHit(text)).toBe(hit)
    })

    it('test() still answers for the bare form', () => {
      expect(RESUME_URL_PATTERN.test('see sub.domain.io/a')).toBe(true)
      expect(RESUME_URL_PATTERN.test(`${'a'.repeat(64)}.com/x`)).toBe(false)
    })

    it('600 notes of 500 Cyrillic characters in 63-letter labels are checked in under 500 ms', () => {
      const note = `${'п'.repeat(63)}.`.repeat(8).slice(0, 500)
      const facts: ResumeFacts = {
        ...noteWith(note),
        experience: Array.from({ length: 30 }, () => ({
          ...EXPERIENCE,
          notes: Array<string>(20).fill(note),
        })),
      }
      const started = performance.now()
      checkResumeCompleteness(facts, CTX)
      expect(performance.now() - started).toBeLessThan(500)
    })
  })

  describe('more label separators and spellings (SR3-L-1)', () => {
    const hitOf = (text: string) => {
      const m = RESUME_TELEGRAM_LABEL_PATTERN.exec(text)
      return m?.[1] ?? m?.[0]
    }

    it.each([
      'Telegram\uFF1Amark_dev',
      'tg\u2010mark_dev',
      'tg\u2012mark_dev',
      'tg \u2015 mark_dev',
      'Telegram \u2212 @mark_dev',
      'Telegram:@ mark_dev',
      'TG @ mark_dev',
      'Телеграмм: mark_dev',
      'ТЕЛЕГРАММ @mark_dev',
    ])('%j hits whole', (text) => {
      expect(hitOf(text)).toBe(text)
    })

    it.each(['Telegram (@mark_dev)', 'Telegram | @mark_dev', 'Telegram.@mark_dev', 'tg/@mark_dev'])(
      'a punctuation-wrapped label is not caught: %j (accepted shortcut)',
      (text) => {
        expect(RESUME_TELEGRAM_LABEL_PATTERN.exec(text)).toBeNull()
      },
    )

    it.each(['Telegram\uFF1Amark_dev', 'Telegram:@ mark_dev', 'Телеграмм: mark_dev'])(
      'a note with %j is flagged',
      (note) => {
        expect(issuesOf(`ping ${note}`)).toContainEqual(contactIssue)
      },
    )
  })

  describe('a stored t.me/s/ or invite link (SR3-L-2)', () => {
    it.each([
      ['t.me/s/mark_dev', 'mark_dev'],
      ['https://t.me/s/mark_dev', 'mark_dev'],
      ['t.me/joinchat/AbCdEf', undefined],
      ['t.me/joinchat', undefined],
      ['t.me/s', undefined],
      ['t.me/+AbCdEf', undefined],
      ['mark', undefined],
    ])('%j becomes %j', (stored, handle) => {
      expect(normaliseTelegramHandle(stored)).toBe(handle)
    })

    it('a stored t.me/s/mark_dev flags the handle but not the word s', () => {
      const ctx = { ...CTX, telegram: 't.me/s/mark_dev' }
      expect(checkResumeCompleteness(noteWith('ask mark_dev'), ctx)).toEqual([contactIssue])
      expect(checkResumeCompleteness(noteWith('Built 5 s services'), ctx)).toEqual([])
    })
  })
})

describe('fix round 5', () => {
  it('50k characters of "1," are checked in under 500 ms (SR4-L-1)', () => {
    const started = performance.now()
    issuesOf('1,'.repeat(25_000))
    expect(performance.now() - started).toBeLessThan(500)
  })
})
