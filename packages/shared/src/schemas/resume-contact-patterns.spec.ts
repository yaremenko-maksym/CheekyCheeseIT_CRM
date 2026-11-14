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
    expect(RESUME_URL_PATTERN.exec(`see ${url} now`)?.[0]).toBe(url)
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
    expect(RESUME_URL_PATTERN.exec(text)).toBeNull()
  })
})

describe('RESUME_EMAIL_PATTERN — punycode TLD (SO23-1)', () => {
  it.each(['ivan@example.xn--p1ai', 'ivan@EXAMPLE.XN--P1AI', 'іван@приклад.укр'])(
    'matches %s whole',
    (email) => {
      expect(RESUME_EMAIL_PATTERN.exec(`mail ${email} now`)?.[0]).toBe(email)
    },
  )
})

describe('host label count (SR-L-8)', () => {
  const host15 = `${'a.'.repeat(14)}co`

  it('a 15-label host is a whole email and a whole URL', () => {
    expect(RESUME_EMAIL_PATTERN.exec(`x@${host15}`)?.[0]).toBe(`x@${host15}`)
    expect(RESUME_URL_PATTERN.exec(`${host15}/x`)?.[0]).toBe(`${host15}/x`)
  })

  it('20 labels is the bound, so a URL match starts at the 20th label from the TLD', () => {
    expect(RESUME_EMAIL_PATTERN.exec(`x@${'a.'.repeat(20)}co`)?.[0]).toBe(`x@${'a.'.repeat(20)}co`)
    expect(RESUME_EMAIL_PATTERN.exec(`x@${'a.'.repeat(21)}co`)).toBeNull()
    expect(RESUME_URL_PATTERN.exec(`b.${'a.'.repeat(20)}com/x`)?.[0]).toBe(
      `${'a.'.repeat(20)}com/x`,
    )
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
    ['mark_t.me/dev', 'mark_t.me'],
    ['mark@dev', 'mark@dev'],
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
    ['пример.', 'пример.'.repeat(7_143)],
    ['тг - ', 'тг - '.repeat(10_000)],
  ])('a 50k-character %s input is checked in under 500 ms', (_, note) => {
    const started = performance.now()
    issuesOf(note)
    expect(performance.now() - started).toBeLessThan(500)
  })

  // The label pattern alone: a 50k separator run is slow in the phone lookahead on Node 22, which
  // this branch does not touch; field limits keep every real input far shorter.
  it.each([
    ['tg + spaces', `tg${' '.repeat(50_000)}`],
    ['Telegram + spaces', `Telegram${' '.repeat(50_000)}`],
    ['тг + spaces and a hyphen', `тг${' '.repeat(25_000)}-${' '.repeat(25_000)}`],
  ])('the label pattern scans a 50k-character %s input in under 500 ms', (_, text) => {
    const started = performance.now()
    RESUME_TELEGRAM_LABEL_PATTERN.test(text)
    expect(performance.now() - started).toBeLessThan(500)
  })
})
