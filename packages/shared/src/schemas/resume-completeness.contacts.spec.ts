/**
 * Resume completeness: contact patterns (phone, email, Telegram, URLs, NFC redaction).
 * Split out of resume-completeness.spec.ts (at the size cap).
 */
import { describe, expect, it } from 'vitest'
import type { ResumeFacts, ResumeFactsExperience } from './resume-facts'
import {
  RESUME_EMAIL_PATTERN,
  RESUME_PHONE_PATTERN,
  RESUME_TELEGRAM_LABEL_PATTERN,
  RESUME_URL_PATTERN,
  checkResumeCompleteness,
  findPhoneSpans,
  isLatinScript,
  normaliseTelegramHandle,
} from './resume-completeness'

const NOW = new Date('2026-11-10T00:00:00Z')
const CTX = { displayName: 'José Müller', now: NOW }

/** The URL hit: group 1 for the bare form (its pattern consumes one boundary character), else the match. */
const urlHit = (text: string): string | undefined => {
  const m = RESUME_URL_PATTERN.exec(text)
  return m?.[1] ?? m?.[0]
}
const emailHit = (text: string): string | undefined => RESUME_EMAIL_PATTERN.exec(text)?.[1]

const BASE_EXPERIENCE: ResumeFactsExperience = {
  company: 'Acme',
  role: 'Engineer',
  location: 'Kyiv',
  start: '2020-01',
  end: '2023-06',
  current: false,
  technologies: ['React'],
  notes: ['Built the design system'],
}

const BASE_FACTS: ResumeFacts = {
  headline: 'Senior Frontend Engineer',
  location: { city: 'Kyiv', country: 'Ukraine' },
  workFormat: 'remote',
  skills: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'PostgreSQL'],
  experience: [BASE_EXPERIENCE],
  education: [{ institution: 'KPI', degree: 'BSc', startYear: 2015, endYear: 2019 }],
  languages: [{ name: 'English', level: 'C1' }],
  links: [],
}

function makeFacts(overrides: Partial<ResumeFacts> = {}): ResumeFacts {
  return { ...BASE_FACTS, ...overrides }
}

function makeExperience(overrides: Partial<ResumeFactsExperience> = {}): ResumeFactsExperience {
  return { ...BASE_EXPERIENCE, ...overrides }
}

describe('findPhoneSpans', () => {
  it.each([
    'Released 2015-01-01 - 2019-12-31',
    'Promoted 10.05.2020 - 15.06.2023',
    'From 2015/01/01 to 2019.12.31',
    'Shipped 31-12-2019 – 01-02-2020',
  ])('does not read a run of full dates as a phone: %s', (text) => {
    expect(findPhoneSpans(text)).toEqual([])
  })

  it('finds exactly the phone after a date range', () => {
    const text = '2015-01-01 - 2019-12-31, call +380 67 123 4567'
    expect(findPhoneSpans(text).map(({ start, end }) => text.slice(start, end))).toEqual([
      '+380 67 123 4567',
    ])
  })

  it('finds every phone, with its offsets', () => {
    expect(findPhoneSpans('a +380671234567 b 0671234567')).toEqual([
      { start: 2, end: 15 },
      { start: 18, end: 28 },
    ])
  })

  it('keeps a bare ten-digit run as a phone (a UA mobile has the same shape)', () => {
    expect(findPhoneSpans('order 9876543210 shipped')).toEqual([{ start: 6, end: 16 }])
  })

  it('keeps a run that mixes a date with more digits as a phone', () => {
    expect(findPhoneSpans('2015-01-01 0671234567')).toEqual([{ start: 0, end: 21 }])
  })

  it('CONTACT_IN_TEXT uses the same rule: a date-range note passes', () => {
    const facts = makeFacts({
      experience: [makeExperience({ notes: ['Promoted 10.05.2020 - 15.06.2023'] })],
    })
    expect(checkResumeCompleteness(facts, CTX)).toEqual([])
  })
})

describe('RESUME_PHONE_PATTERN', () => {
  it.each(['+380 67 123 45 67', '(067) 123-45-67', '+1 415 555 2671', '123456789'])(
    'flags %s',
    (phone) => {
      expect(RESUME_PHONE_PATTERN.test(phone)).toBe(true)
    },
  )

  it.each([
    '2015 – 2019',
    'Mar 2021 – May 2023',
    'C++ 17',
    '1,000,000 requests',
    'Node.js 18',
    '2020-01-15',
    // Nine digits are present, but split by separators a phone does not use.
    '1,000,000,000 requests',
    '2019/2020/2021',
  ])('does not flag %s', (text) => {
    expect(RESUME_PHONE_PATTERN.test(text)).toBe(false)
  })

  it('matches the whole number, the leading + or ( included', () => {
    expect('call +380 67 123 45 67 now'.match(RESUME_PHONE_PATTERN)?.[0]).toBe('+380 67 123 45 67')
    expect('(067) 123-45-67'.match(RESUME_PHONE_PATTERN)?.[0]).toBe('(067) 123-45-67')
  })

  it('accepts an en-dash as a separator', () => {
    expect('call +38 067 123–45–67 now'.match(RESUME_PHONE_PATTERN)?.[0]).toBe('+38 067 123–45–67')
  })

  it('is stateless: repeated tests give the same answer without a g flag', () => {
    expect(RESUME_PHONE_PATTERN.flags).not.toContain('g')
    expect(RESUME_PHONE_PATTERN.test('+380 67 123 45 67')).toBe(true)
    expect(RESUME_PHONE_PATTERN.test('+380 67 123 45 67')).toBe(true)
  })
})

describe('RESUME_EMAIL_PATTERN', () => {
  it.each(['jane.doe@example.com', 'a+b@sub.example.co.uk', '123@example.com', 'jane@123.com'])(
    'flags %s',
    (email) => {
      expect(RESUME_EMAIL_PATTERN.test(email)).toBe(true)
    },
  )

  it('matches the whole local part, not its last character', () => {
    expect(emailHit('mail jane.doe@example.com today')).toBe('jane.doe@example.com')
  })

  it.each(['jane at example dot com', 'no-address-here', 'a@b.c'])('does not flag %s', (text) => {
    expect(RESUME_EMAIL_PATTERN.test(text)).toBe(false)
  })

  it('is stateless: repeated tests give the same answer without a g flag', () => {
    expect(RESUME_EMAIL_PATTERN.flags).not.toContain('g')
    expect(RESUME_EMAIL_PATTERN.test('jane@example.com')).toBe(true)
    expect(RESUME_EMAIL_PATTERN.test('jane@example.com')).toBe(true)
  })
})

describe('isLatinScript', () => {
  it.each(['', 'José Müller', 'C++ 17', 'Node.js 18', '1,000,000 requests', 'Kyiv'])(
    'accepts %s',
    (text) => {
      expect(isLatinScript(text)).toBe(true)
    },
  )

  it.each(['Інженер', 'Київ', '日本語', 'hello Іван'])('rejects %s', (text) => {
    expect(isLatinScript(text)).toBe(false)
  })

  it('accepts the U+02BC and U+2019 apostrophes, still rejects a Cyrillic letter (QF3-1)', () => {
    expect(isLatinScript('Dʼangelo')).toBe(true)
    expect(isLatinScript('O’Neil')).toBe(true)
    expect(isLatinScript('Dʼаngelo')).toBe(false) // Cyrillic а
  })
})

describe('checkResumeCompleteness — the Telegram handle of the senior', () => {
  const noteWith = (note: string) => makeFacts({ experience: [makeExperience({ notes: [note] })] })
  const flagged = [{ path: 'experience.0.notes.0', code: 'CONTACT_IN_TEXT' }]

  it.each(['ping @jose_dev', 'ping JOSE_DEV', 'see t.me/jose_dev.'])(
    'flags the handle with or without its @, any case: %s',
    (note) => {
      const ctx = { ...CTX, telegram: '@Jose_Dev' }
      expect(checkResumeCompleteness(noteWith(note), ctx)).toEqual(flagged)
    },
  )

  it('flags the handle when it is stored with surrounding spaces', () => {
    const ctx = { ...CTX, telegram: '  @jose_dev ' }
    expect(checkResumeCompleteness(noteWith('ping @jose_dev'), ctx)).toEqual(flagged)
  })

  it('flags the @ form when the handle is stored without it', () => {
    const ctx = { ...CTX, telegram: 'jose_dev' }
    expect(checkResumeCompleteness(noteWith('ping @jose_dev'), ctx)).toEqual(flagged)
  })

  it.each(['jose_dev2 shipped', 'xjose_dev shipped', 'jose_devx shipped'])(
    'does not flag a longer token: %s',
    (note) => {
      const ctx = { ...CTX, telegram: 'jose_dev' }
      expect(checkResumeCompleteness(noteWith(note), ctx)).toEqual([])
    },
  )

  it.each(['ping @@jose_dev', 'ping x@jose_dev', 'ping @jose_dev!'])(
    'flags the handle behind extra @s or a glued word (SR-L-1): %s',
    (note) => {
      const ctx = { ...CTX, telegram: 'jose_dev' }
      expect(checkResumeCompleteness(noteWith(note), ctx)).toEqual(flagged)
    },
  )

  it.each([
    't.me/jose_dev',
    'https://t.me/jose_dev',
    'telegram.me/@jose_dev',
    '@@jose_dev',
    'tg:jose_dev',
    'www.t.me/jose_dev',
  ])('normalises a stored %j to the bare handle (CR-L-3)', (telegram) => {
    // `@jose_dev` alone is no URL and no labelled handle, so only the stored handle can flag it
    expect(checkResumeCompleteness(noteWith('ping @jose_dev'), { ...CTX, telegram })).toEqual(
      flagged,
    )
  })

  it('a stored mark@dev is no Telegram username, so it adds no handle check (SR3-L-2, was CR-L-4)', () => {
    const ctx = { ...CTX, telegram: 'mark@dev' }
    expect(checkResumeCompleteness(noteWith('ping mark@dev'), ctx)).toEqual([])
    expect(checkResumeCompleteness(noteWith('ping markdev'), ctx)).toEqual([])
  })

  it('matches the stored handle literally, not as a pattern', () => {
    const ctx = { ...CTX, telegram: 'jose.dev' }
    expect(checkResumeCompleteness(noteWith('josexdev shipped'), ctx)).toEqual([])
  })

  it.each([null, undefined, '', '  ', '@'])('a telegram of %j changes nothing', (telegram) => {
    expect(checkResumeCompleteness(noteWith('ping @jose_dev'), { ...CTX, telegram })).toEqual([])
  })
})

describe('normaliseTelegramHandle', () => {
  it.each([
    ['  @mark_dev ', 'mark_dev'],
    ['@@mark_dev', 'mark_dev'],
    ['t.me/mark_dev', 'mark_dev'],
    ['T.ME/mark_dev', 'mark_dev'],
    ['https://t.me/mark_dev', 'mark_dev'],
    ['http://telegram.me/@mark_dev', 'mark_dev'],
    // SR3-L-2: not a Telegram username (a letter, then 4+ of [A-Za-z0-9_]) gives no handle
    ['mark@dev', undefined],
    ['mark_t.me/dev', undefined],
    ['@', undefined],
    ['tg:mark_dev', 'mark_dev'],
    ['TG : @mark_dev', 'mark_dev'],
    ['telegram: mark_dev', 'mark_dev'],
    ['www.t.me/mark_dev', 'mark_dev'],
    ['https://www.telegram.me/@mark_dev', 'mark_dev'],
  ])('%j becomes %j', (stored, handle) => {
    expect(normaliseTelegramHandle(stored)).toBe(handle)
  })

  it.each([null, undefined])('%j stays absent', (stored) => {
    expect(normaliseTelegramHandle(stored)).toBeUndefined()
  })
})

describe('checkResumeCompleteness — URLs and labelled handles (SR-H-1, SR-M-1)', () => {
  const noteWith = (note: string) => makeFacts({ experience: [makeExperience({ notes: [note] })] })
  const flagged = [{ path: 'experience.0.notes.0', code: 'CONTACT_IN_TEXT' }]

  it.each([
    'see https://gitlab.com/jose',
    'see ftp://files.example/cv',
    'see www.jose-portfolio.site',
    'see WWW.example.org',
    'ping t.me/jose',
    ...['com', 'net', 'org', 'io', 'dev', 'me', 'ua', 'co', 'app', 'ai', 'in'].map(
      (tld) => `see jose.${tld}/work`,
    ),
    'see sub.domain.io/',
    'see bit.ly/x',
    'see johndoe.tech/cv',
    'see GITHUB.COM/X',
    'see GitHub.Com/x',
    'see foo_github.com/x',
  ])('flags a URL: %s', (note) => {
    expect(checkResumeCompleteness(noteWith(note), CTX)).toEqual(flagged)
  })

  it.each([
    'Built on Node.js and Next.js',
    'Vue.js, Socket.IO, ASP.NET and .NET',
    'Charts in D3.js and Three.js',
    'Express.js/Nest backend',
    'used @angular/core and @nestjs/common',
    'Telegram bots: a pager',
    'jose.dev without a path',
    'Node.js/Express and Express.JS/Nest',
    'typed in x.Ts/y',
    'Debug tg:12345',
    'see xtg: jose_dev',
  ])('does not flag a tech name or a package: %s', (note) => {
    expect(checkResumeCompleteness(noteWith(note), CTX)).toEqual([])
  })

  it.each([
    'tg: jose_x',
    'TG:@jose_x',
    'telegram : @@jose_x',
    'Телеграм: jose_x',
    'ТЕЛЕГРАМ:jose_x',
  ])('flags a labelled handle that is not the stored one: %s', (note) => {
    // a Cyrillic label also fails the Latin-script check, so only the contact code is asserted
    expect(checkResumeCompleteness(noteWith(note), CTX)).toContainEqual(flagged[0])
  })

  it('the shared patterns are stateless: repeated tests give the same answer', () => {
    expect(RESUME_URL_PATTERN.flags).not.toContain('g')
    expect(RESUME_TELEGRAM_LABEL_PATTERN.flags).not.toContain('g')
    expect([1, 2].map(() => RESUME_URL_PATTERN.test('t.me/jose'))).toEqual([true, true])
  })

  it.each([
    ['see https://gitlab.com/jose now', 'https://gitlab.com/jose'],
    ['see www.jose-portfolio.site now', 'www.jose-portfolio.site'],
    ['see sub.domain.io/a now', 'sub.domain.io/a'],
    ['see web3.io/x now', 'web3.io/x'],
    ['see jose.com/work now', 'jose.com/work'],
  ])('the URL match in %j is exactly %j, the span redaction replaces', (text, url) => {
    expect(urlHit(text)).toBe(url)
  })

  it.each([
    ['see foo_github.com/x', 'github.com/x'],
    ['a://b', 'a://b'],
    [`a${'b'.repeat(30)}://x`, `a${'b'.repeat(30)}://x`],
    [`${'a'.repeat(63)}.com/x`, `${'a'.repeat(63)}.com/x`],
    [`${'a.'.repeat(10)}com/x`, `${'a.'.repeat(10)}com/x`],
    [`b.${'a.'.repeat(20)}com/x`, `${'a.'.repeat(20)}com/x`],
    ['a.bc/x', 'a.bc/x'],
    [`a.${'b'.repeat(24)}/x`, `a.${'b'.repeat(24)}/x`],
    ['foo.jsx/x', 'foo.jsx/x'],
  ])('the URL match in %j is exactly %j (bounds, SR-L-3, SR-L-4)', (text, url) => {
    expect(urlHit(text)).toBe(url)
  })

  it.each([
    `a${'b'.repeat(31)}://x`,
    // SR3-M-1: a match starts at a label boundary, so a 64-letter label is no tail of 63
    `${'a'.repeat(64)}.com/x`,
    'a.b/x',
    `a.${'b'.repeat(25)}/x`,
    'johndoe.dev',
    'github.com',
  ])('no URL in %j (bounds; a bare domain with no path is not one)', (text) => {
    expect(urlHit(text)).toBeUndefined()
  })

  it.each(['package.json/scripts', 'React.memo/useMemo', 'Vue.config/x', 'ASP.NET/Core'])(
    'reads %s as a URL: an accepted false positive of the any-TLD path form',
    (text) => {
      expect(urlHit(text)).toBe(text)
    },
  )

  it.each([
    [`${'a'.repeat(64)}@b.co`, `${'a'.repeat(64)}@b.co`],
    // A local part matches whole, however long: it has no bound since its left boundary (SR3-M-1).
    [`${'a'.repeat(65)}@b.co`, `${'a'.repeat(65)}@b.co`],
    [`x@${'a'.repeat(63)}.co`, `x@${'a'.repeat(63)}.co`],
    [`x@${'a.'.repeat(10)}co`, `x@${'a.'.repeat(10)}co`],
  ])('the email match in %j is exactly %j (bounds, SR-L-3)', (text, email) => {
    expect(emailHit(text)).toBe(email)
  })

  it.each([`x@${'a'.repeat(64)}.co`, `x@${'a.'.repeat(21)}co`])(
    'no email in %j (bounds)',
    (text) => {
      expect(emailHit(text)).toBeUndefined()
    },
  )

  it.each([
    ['a.', 'a.'.repeat(25_000)],
    ['a-.', 'a-.'.repeat(16_667)],
  ])('a 50k-character %j repeat is checked in under 500 ms (SR-L-3, R91)', (_, note) => {
    const started = performance.now()
    checkResumeCompleteness(noteWith(note), CTX)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('a label hit starts at the label, not at the boundary character (SR-L-5)', () => {
    expect(RESUME_TELEGRAM_LABEL_PATTERN.exec('(tg:jose_dev)')?.[1]).toBe('tg:jose_dev')
    expect(RESUME_TELEGRAM_LABEL_PATTERN.exec('tg: @mark_dev')?.[1]).toBe('tg: @mark_dev')
  })

  it.each([
    ['MyTelegram: mark_dev', 'Telegram: mark_dev'],
    ['PersonalTG: mark_dev', 'TG: mark_dev'],
    ['PersonalTg: mark_dev', 'Tg: mark_dev'],
    ['моїТелеграм: mark_dev', 'Телеграм: mark_dev'],
  ])('a label glued to a word still hits: %j gives %j (SR-L-5b)', (text, hit) => {
    const m = RESUME_TELEGRAM_LABEL_PATTERN.exec(text)
    expect(m?.[1] ?? m?.[0]).toBe(hit)
  })

  it.each(['personaltg: mark_dev', 'xtg: mark_dev', 'Debug tg:12345', 'SomeTG:12345'])(
    'no label in %j: a lowercase join or a handle starting with a digit (SR-L-5b)',
    (text) => {
      expect(RESUME_TELEGRAM_LABEL_PATTERN.exec(text)).toBeNull()
    },
  )

  it('a label followed by a plain word is flagged: ambiguous, accepted (SR-L-5)', () => {
    expect(checkResumeCompleteness(noteWith('Telegram: payments'), CTX)).toEqual(flagged)
  })

  it('a label needs a handle of at least five characters', () => {
    expect(RESUME_TELEGRAM_LABEL_PATTERN.test('tg: abcd')).toBe(false)
    expect(RESUME_TELEGRAM_LABEL_PATTERN.test('tg: abcde')).toBe(true)
  })
})

describe('checkResumeCompleteness — NFC, as the API redacts (SR7-L-1)', () => {
  // Decomposed (NFD) forms: the combining acute U+0301 follows a plain `e`.
  const DECOMPOSED = ['x@y.é', 'see a.é/x now', 'Aétg: mark_dev']

  it.each(DECOMPOSED)('flags %j exactly as its NFC form', (text) => {
    const flagged = (headline: string) =>
      checkResumeCompleteness(makeFacts({ headline }), CTX).some(
        (issue) => issue.code === 'CONTACT_IN_TEXT',
      )
    expect(flagged(text)).toBe(flagged(text.normalize('NFC')))
  })

  it('does not flag the decomposed email whose NFC TLD is one letter', () => {
    expect(checkResumeCompleteness(makeFacts({ headline: 'x@y.é' }), CTX)).toEqual([])
  })
})
