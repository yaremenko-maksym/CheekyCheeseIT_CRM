/**
 * Contact scan (verified-base-resume Task 9): a senior's contact details never
 * reach a third-party AI writer. A missed contact is a leak, so the scan is
 * deliberately greedy and redaction is checked by re-scanning its own output.
 */
import { checkResumeCompleteness, type ResumeFacts } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { redactContacts, scanContacts, type ContactContext } from './contact-scan'
import { hasContact } from './content-gates'

/** CPU time this process spent, in ms. A ReDoS burns CPU; a loaded machine only stretches the
 * wall clock, so a wall-clock bound fails on load and says nothing about the pattern. */
const cpuMs = (): number => {
  const { user, system } = process.cpuUsage()
  return (user + system) / 1000
}

/** The time budget. Under Stryker it is unbounded: instrumenting every expression stretches the
 * clock with no change to a pattern, and a mutant that makes one super-linear is still caught
 * there by Stryker's own timeout. Every other run (unit, pre-push, CI) holds the 500 ms. */
const BUDGET_MS =
  process.env['STRYKER_MUTATOR_WORKER'] === undefined ? 500 : Number.POSITIVE_INFINITY

/** The shortest arm of a CPU-ratio test: under ~20 ms one scheduler tick or GC pause moves the
 * ratio past its limit (backlog 454: the part-count arms took 2-4 ms on CI). */
const MIN_ARM_MS = 20
/** Run-bound arm ratios (per scan, against one part): measured absent8 1.6-1.8x, present8 13.5-18x,
 * present16 2.2-2.7x; the in-text filter off makes absent8 as costly as present8, the 16-part bound
 * builds 2^15 subsets. */
const RATIO_ABSENT = 4
const RATIO_PRESENT = 64

/** The first of 1, 2, 4, \u{2026} 64 repeats at which `arm(repeats)` costs `MIN_ARM_MS` or more, so a fast
 * machine runs a longer window instead of a noisier ratio. The last one is returned unmeasured.
 * Each step takes the faster of two runs: one GC pause or JIT tier-up in a single run once read
 * 20 ms where the timed run then took 6.6 ms. */
const armRepeats = (arm: (repeats: number) => number): number => {
  let repeats = 1
  while (repeats < 64 && Math.min(arm(repeats), arm(repeats)) < MIN_ARM_MS) repeats *= 2
  return repeats
}

const ctx: ContactContext = { fullName: 'Mark Levin', emails: ['mark.levin@example.com'] }

describe('scanContacts \u{2014} names', () => {
  it('does not hit the first name alone', () => {
    expect(scanContacts('Mark built the pipeline', ctx)).toEqual([])
  })

  it('hits the full name and the surname alone', () => {
    expect(scanContacts('Mark Levin led it', ctx)).toEqual([{ kind: 'name', match: 'Mark Levin' }])
    expect(scanContacts('reviewed by Levin', ctx)).toEqual([{ kind: 'name', match: 'Levin' }])
  })

  it('matches case-insensitively, across any whitespace, and reports the text as written', () => {
    expect(scanContacts('MARK \n  levin', ctx)).toEqual([{ kind: 'name', match: 'MARK \n  levin' }])
  })

  it('does not hit a surname inside another word', () => {
    expect(scanContacts('Levine and Levins and SLevin', ctx)).toEqual([])
  })

  it('treats # and + as boundaries, as the completeness check does (PR #1351 round 3, SR-M-1)', () => {
    expect(redactContacts('Levin# Levin+ #Levin', ctx)).toBe('[REDACTED]# [REDACTED]+ #[REDACTED]')
    expect(redactContacts('Mark Levin#', ctx)).toBe('[REDACTED]#')
  })

  it('matches a diacritic surname whatever the Unicode normalisation of either side', () => {
    const muller = { fullName: 'Anna M\u{00FC}ller', emails: [] }
    expect(scanContacts('by M\u{00DC}LLER', muller)).toEqual([
      { kind: 'name', match: 'M\u{00DC}LLER' },
    ])
    // decomposed u + combining diaeresis in the text
    expect(scanContacts('by Mu\u0308ller', muller)).toEqual([
      { kind: 'name', match: 'M\u{00FC}ller' },
    ])
    // decomposed in the context, composed in the text
    expect(scanContacts('by M\u{00FC}ller', { fullName: 'Anna Mu\u0308ller', emails: [] })).toEqual(
      [{ kind: 'name', match: 'M\u{00FC}ller' }],
    )
  })

  it('accepts any whitespace between the parts of the context name', () => {
    expect(scanContacts('Mark Levin led it', { fullName: 'Mark \t Levin', emails: [] })).toEqual([
      { kind: 'name', match: 'Mark Levin' },
    ])
  })

  it('uses the last token as the surname', () => {
    const three = { fullName: 'Anna Maria Kowalska', emails: [] }
    expect(scanContacts('Maria wrote it', three)).toEqual([])
    expect(scanContacts('Kowalska wrote it', three)).toEqual([{ kind: 'name', match: 'Kowalska' }])
  })

  it('matches a single-token name as a whole token only', () => {
    const mono = { fullName: '  Prince ', emails: [] }
    expect(scanContacts('Prince sang', mono)).toEqual([{ kind: 'name', match: 'Prince' }])
    expect(scanContacts('Princess sang', mono)).toEqual([])
  })

  it('ignores a one-letter surname but still matches the full name', () => {
    const short = { fullName: 'Malcolm X', emails: [] }
    expect(scanContacts('version X shipped', short)).toEqual([])
    expect(scanContacts('Malcolm X spoke', short)).toEqual([{ kind: 'name', match: 'Malcolm X' }])
  })

  it('counts letters, not characters, for the surname minimum', () => {
    expect(scanContacts("x'' shipped", { fullName: "Ann x''", emails: [] })).toEqual([])
    expect(scanContacts('Li shipped', { fullName: 'Wei Li', emails: [] })).toEqual([
      { kind: 'name', match: 'Li' },
    ])
  })

  it('escapes regex metacharacters in the name', () => {
    expect(scanContacts('a.b and axb', { fullName: 'Jo a.b', emails: [] })).toEqual([
      { kind: 'name', match: 'a.b' },
    ])
  })

  it('finds nothing for a blank name', () => {
    const blank = { fullName: '   ', emails: [] }
    // separators in the text: an empty name pattern would match between them
    expect(scanContacts('nothing  here, at all.', blank)).toEqual([])
    expect(redactContacts('nothing  here, at all.', blank)).toBe('nothing  here, at all.')
  })
})

describe('scanContacts \u{2014} phones and emails', () => {
  it('does not read a run of full dates as a phone, but finds the phone after it', () => {
    expect(scanContacts('Released 2015-01-01 - 2019-12-31', ctx)).toEqual([])
    expect(scanContacts('Promoted 10.05.2020 - 15.06.2023', ctx)).toEqual([])
    expect(scanContacts('2015-01-01 - 2019-12-31, call +380 67 123 4567', ctx)).toEqual([
      { kind: 'phone', match: '+380 67 123 4567' },
    ])
    expect(redactContacts('order 9876543210 shipped', ctx)).toBe('order [REDACTED] shipped')
  })

  it('hits an international phone number', () => {
    expect(scanContacts('call +380671234567 now', ctx)).toEqual([
      { kind: 'phone', match: '+380671234567' },
    ])
  })

  it('hits every phone, not only the first', () => {
    expect(scanContacts('+380671234567 or (067) 123-45-67', ctx)).toEqual([
      { kind: 'phone', match: '+380671234567' },
      { kind: 'phone', match: '(067) 123-45-67' },
    ])
  })

  it('hits any email the pattern recognises, not only the senior\u{2019}s', () => {
    expect(scanContacts('write to a@b.io or c@d.dev', ctx)).toEqual([
      { kind: 'email', match: 'a@b.io' },
      { kind: 'email', match: 'c@d.dev' },
    ])
  })

  it('hits a context email the pattern misses, case-insensitively', () => {
    const odd = { fullName: 'Mark Levin', emails: ['ml@intranet'] }
    expect(scanContacts('ping ML@INTRANET today', odd)).toEqual([
      { kind: 'email', match: 'ML@INTRANET' },
    ])
  })

  it('reports an email once when the pattern and the context list both find it', () => {
    expect(scanContacts('mail mark.levin@example.com', ctx)).toEqual([
      { kind: 'email', match: 'mark.levin@example.com' },
    ])
  })

  it('normalises a context email before the literal match', () => {
    const nfd = { fullName: 'Mark Levin', emails: ['mu\u0308ller@intranet'] }
    expect(scanContacts('ping m\u{00FC}ller@intranet', nfd)).toEqual([
      { kind: 'email', match: 'm\u{00FC}ller@intranet' },
    ])
  })

  it('prefers the longer of two hits that start together', () => {
    // the pattern stops at `_`; the context address, found later, runs on
    const long = { fullName: 'Mark Levin', emails: ['ml@x.io_old'] }
    expect(scanContacts('ml@x.io_old', long)).toEqual([{ kind: 'email', match: 'ml@x.io_old' }])
    // the mirror: the pattern hit, found first, is the longer one; the context address inside it loses
    const short = { fullName: 'Jane Doe', emails: ['jane@site.com'] }
    expect(scanContacts('mail jane@site.com.ua', short)).toEqual([
      { kind: 'email', match: 'jane@site.com.ua' },
    ])
  })

  it('ignores blank context emails', () => {
    expect(scanContacts('plain  text', { fullName: 'Mark Levin', emails: ['', '  '] })).toEqual([])
  })

  it('trims a context email before the literal match', () => {
    const padded = { fullName: 'Mark Levin', emails: [' ml@intranet '] }
    expect(scanContacts('ping ml@intranet.', padded)).toEqual([
      { kind: 'email', match: 'ml@intranet' },
    ])
  })

  it('keeps the longer of two overlapping hits and reports hits in text order', () => {
    const named = { fullName: 'Mark Levin', emails: ['levin@x.io'] }
    expect(scanContacts('Levin then levin@x.io', named)).toEqual([
      { kind: 'name', match: 'Levin' },
      { kind: 'email', match: 'levin@x.io' },
    ])
  })
})

describe('redactContacts', () => {
  const sample =
    'Mark Levin (+380671234567, mark.levin@example.com) \u{2014} Levin led it; Mark reviewed.'

  it('replaces every hit with [REDACTED] and leaves the rest alone', () => {
    expect(redactContacts(sample, ctx)).toBe(
      '[REDACTED] ([REDACTED], [REDACTED]) \u{2014} [REDACTED] led it; Mark reviewed.',
    )
  })

  it('merges overlapping and adjacent spans into one replacement', () => {
    const named = { fullName: 'Mark Levin', emails: ['levin@x.io'] }
    expect(redactContacts('Levinlevin@x.io', named)).toBe('[REDACTED]')
    // the surname ends exactly where the phone begins
    expect(redactContacts('Levin(067) 123-45-67 ok', named)).toBe('[REDACTED] ok')
  })

  it('returns text without contacts unchanged', () => {
    expect(redactContacts('no contacts here', ctx)).toBe('no contacts here')
  })

  it('is idempotent', () => {
    const once = redactContacts(sample, ctx)
    expect(redactContacts(once, ctx)).toBe(once)
  })

  it('leaves nothing for a re-scan to find', () => {
    expect(scanContacts(redactContacts(sample, ctx), ctx)).toEqual([])
    const muller = { fullName: 'Anna M\u{00FC}ller', emails: [] }
    expect(scanContacts(redactContacts('by Mu\u0308ller', muller), muller)).toEqual([])
  })
})

describe('scanContacts \u{2014} serialized text and spelling variants (fix round 1)', () => {
  const name = (match: string) => ({ kind: 'name', match })

  it('treats a JSON escape before the surname as a boundary', () => {
    expect(scanContacts('\u{2026}it.\\nLevin reviewed', ctx)).toEqual([name('Levin')])
    expect(scanContacts('it\\tLevin, it\\rLevin, \\"Levin\\"', ctx)).toEqual([
      name('Levin'),
      name('Levin'),
      name('Levin'),
    ])
    expect(scanContacts('caf\\u00e9Levin and \\u00E9Levin', ctx)).toEqual([
      name('Levin'),
      name('Levin'),
    ])
  })

  it('matches a full name split by an escaped whitespace', () => {
    expect(scanContacts('Mark\\nLevin', ctx)).toEqual([name('Mark\\nLevin')])
    expect(scanContacts('Mark\\t \\r\\nLevin', ctx)).toEqual([name('Mark\\t \\r\\nLevin')])
  })

  it('needs the backslash: a plain letter or a short escape is no boundary', () => {
    expect(scanContacts('xnLevin tLevin', ctx)).toEqual([])
    expect(scanContacts('a\\u00eLevin a\\xLevin', ctx)).toEqual([])
  })

  it('matches curly apostrophes against a straight one, both ways', () => {
    const straight = { fullName: "Sean O'Brien", emails: [] }
    expect(scanContacts('by O\u{2019}Brien, O\u{02BC}brien and O\u{2018}Brien', straight)).toEqual([
      name('O\u{2019}Brien'),
      name('O\u{02BC}brien'),
      name('O\u{2018}Brien'),
    ])
    expect(scanContacts("by O'Brien", { fullName: 'Sean O\u{2019}Brien', emails: [] })).toEqual([
      name("O'Brien"),
    ])
  })

  it('hits a possessive surname', () => {
    expect(scanContacts("Levin's code and Levin\u{2019}s tests", ctx)).toEqual([
      name('Levin'),
      name('Levin'),
    ])
  })

  it('matches the accent-folded spelling of a name, both ways, and reports it as written', () => {
    const accented = { fullName: 'Anna M\u{00FC}ller', emails: [] }
    expect(scanContacts('by Muller', accented)).toEqual([name('Muller')])
    expect(scanContacts('by M\u{00FC}ller', { fullName: 'Anna Muller', emails: [] })).toEqual([
      name('M\u{00FC}ller'),
    ])
    // known limit: a transliteration is not a fold
    expect(scanContacts('by Mueller', accented)).toEqual([])
  })

  it.each([
    ['\u{0142}', 'l'],
    ['\u{0141}', 'L'],
    ['\u{00F8}', 'o'],
    ['\u{00D8}', 'O'],
    ['\u{0111}', 'd'],
    ['\u{0110}', 'D'],
    ['\u{00DF}', 'ss'],
    ['\u{1E9E}', 'SS'],
    ['\u{0131}', 'i'],
    ['\u{00E6}', 'ae'],
    ['\u{00C6}', 'AE'],
    ['\u{0153}', 'oe'],
    ['\u{0152}', 'OE'],
    ['\u{00FE}', 'th'],
    ['\u{00DE}', 'TH'],
    ['\u{0127}', 'h'],
    ['\u{0126}', 'H'],
  ])('folds %s to %s', (letter, folded) => {
    expect(
      redactContacts(`by Qu${folded}q, ok`, { fullName: `Ann Qu${letter}q`, emails: [] }),
    ).toBe('by [REDACTED], ok')
  })

  it('folds capital \u{1E9E}, which /iu does not case-fold to ss', () => {
    expect(
      redactContacts('by STRAU\u{1E9E}, ok', { fullName: 'Max Strau\u{00DF}', emails: [] }),
    ).toBe('by [REDACTED], ok')
  })

  it('folds dotless \u{0131}', () => {
    expect(
      redactContacts('by Yildiz, ok', { fullName: 'Ece Y\u{0131}ld\u{0131}z', emails: [] }),
    ).toBe('by [REDACTED], ok')
  })

  it('folds the ligatures \u{00E6} and \u{0153}', () => {
    expect(
      redactContacts('by Baekoe, ok', { fullName: 'Ann B\u{00E6}k\u{0153}', emails: [] }),
    ).toBe('by [REDACTED], ok')
  })

  it('folds letters without a Unicode decomposition: \u{0142} \u{00F8} \u{0111} \u{00DF}', () => {
    const polish = { fullName: 'Jan Wa\u{0142}\u{0119}sa', emails: [] }
    expect(scanContacts('by Walesa', polish)).toEqual([name('Walesa')])
    expect(scanContacts('by WA\u{0141}\u{0118}SA', { fullName: 'Jan Walesa', emails: [] })).toEqual(
      [name('WA\u{0141}\u{0118}SA')],
    )
    expect(scanContacts('by Sorensen', { fullName: 'Ib S\u{00F8}rensen', emails: [] })).toEqual([
      name('Sorensen'),
    ])
    expect(scanContacts('by Dorde', { fullName: 'Ana \u{0110}or\u{0111}e', emails: [] })).toEqual([
      name('Dorde'),
    ])
    expect(redactContacts('by Strasse, ok', { fullName: 'Max Stra\u{00DF}e', emails: [] })).toBe(
      'by [REDACTED], ok',
    )
    expect(redactContacts('by Stra\u{00DF}e, ok', { fullName: 'Max Strasse', emails: [] })).toBe(
      'by [REDACTED], ok',
    )
  })

  it('redacts a folded match on its original span', () => {
    const bronte = { fullName: 'Zo\u{00EB} Bront\u{00EB}', emails: [] }
    expect(redactContacts('Zoe Bronte and Bront\u{00EB}, then Bronte.', bronte)).toBe(
      '[REDACTED] and [REDACTED], then [REDACTED].',
    )
    // a mark NFC cannot compose stays inside the span it belongs to
    expect(redactContacts('by Leviq\u0303 ok', { fullName: 'Ann Leviq', emails: [] })).toBe(
      'by [REDACTED] ok',
    )
    // a character NFD expands to several code units, before the name, keeps the offsets right
    expect(redactContacts('\uD55C\uAD6D Levin x', ctx)).toBe('\uD55C\uAD6D [REDACTED] x')
  })

  it('hits a phone written with brackets or en-dashes', () => {
    expect(scanContacts('tel +38 (067) 123-45-67', ctx)).toEqual([
      { kind: 'phone', match: '+38 (067) 123-45-67' },
    ])
    expect(scanContacts('tel +38 067 123\u{2013}45\u{2013}67', ctx)).toEqual([
      { kind: 'phone', match: '+38 067 123\u{2013}45\u{2013}67' },
    ])
  })

  it('hits a +tag email and an uppercase email as written', () => {
    expect(scanContacts('mark+cv@example.com, MARK.LEVIN@EXAMPLE.COM', ctx)).toEqual([
      { kind: 'email', match: 'mark+cv@example.com' },
      { kind: 'email', match: 'MARK.LEVIN@EXAMPLE.COM' },
    ])
  })
})

describe('the Telegram handle of the senior', () => {
  const tg: ContactContext = { ...ctx, telegram: '@Mark_Dev' }

  it('no stored handle: the word null is not redacted (PR #1351 round 4, SPEC-M-1)', () => {
    expect(redactContacts('null pointer, null check', ctx)).toBe('null pointer, null check')
    expect(redactContacts('null pointer', { ...ctx, telegram: null })).toBe('null pointer')
  })

  it('hits the handle with and without its @, in any case', () => {
    expect(scanContacts('ping @mark_dev or MARK_DEV', tg)).toEqual([
      { kind: 'telegram', match: '@mark_dev' },
      { kind: 'telegram', match: 'MARK_DEV' },
    ])
  })

  it('a handle stored with surrounding spaces still hits', () => {
    expect(scanContacts('ping @mark_dev', { ...ctx, telegram: '  @mark_dev ' })).toEqual([
      { kind: 'telegram', match: '@mark_dev' },
    ])
  })

  it('a handle stored without its @ still hits the written @ form', () => {
    expect(scanContacts('ping @mark_dev', { ...ctx, telegram: 'mark_dev' })).toEqual([
      { kind: 'telegram', match: '@mark_dev' },
    ])
  })

  it('hits only the whole handle', () => {
    expect(scanContacts('mark_dev2, xmark_dev, mark_devx', tg)).toEqual([])
  })

  it('hits the handle behind extra @s or glued to a word (SR-L-1)', () => {
    expect(scanContacts('ping @@mark_dev or x@mark_dev', tg)).toEqual([
      { kind: 'telegram', match: '@@mark_dev' },
      // the @ after a word char is outside the lookbehind, so only the handle itself is the hit
      { kind: 'telegram', match: 'mark_dev' },
    ])
    expect(redactContacts('x@mark_dev', tg)).toBe('x@[REDACTED]')
  })

  it.each([
    't.me/mark_dev',
    'https://t.me/mark_dev',
    'telegram.me/@mark_dev',
    '@@mark_dev',
    'tg:mark_dev',
    'www.t.me/mark_dev',
  ])('a handle stored as %j still hits the written @ form (CR-L-3)', (telegram) => {
    expect(scanContacts('ping @mark_dev', { ...ctx, telegram })).toEqual([
      { kind: 'telegram', match: '@mark_dev' },
    ])
  })

  it('a stored mark@dev is no Telegram username, so it adds no handle hit (SR3-L-2, was CR-L-4)', () => {
    const stored = { ...ctx, telegram: 'mark@dev' }
    expect(scanContacts('ping mark@dev', stored)).toEqual([])
    expect(scanContacts('ping markdev', stored)).toEqual([])
  })

  it('matches the stored handle literally, not as a pattern', () => {
    expect(scanContacts('markxdev', { ...ctx, telegram: 'mark.dev' })).toEqual([])
  })

  it('is redacted in a company name and flagged in a note', () => {
    expect(redactContacts('Acme (ping @mark_dev)', tg)).toBe('Acme (ping [REDACTED])')
    expect(hasContact('Reach me at mark_dev', [tg])).toBe(true)
  })

  it.each([null, undefined, '', '  ', '@'])('a telegram of %j changes nothing', (telegram) => {
    const text = 'Acme (ping @mark_dev)'
    expect(scanContacts(text, { ...ctx, telegram })).toEqual([])
    expect(redactContacts(text, { ...ctx, telegram })).toBe(text)
  })
})

describe('URLs (SR-H-1)', () => {
  it.each([
    'https://gitlab.com/mark',
    'ftp://files.example/cv',
    'www.mark-portfolio.site',
    'WWW.example.org',
    't.me/mark',
    ...['com', 'net', 'org', 'io', 'dev', 'me', 'ua', 'co', 'app', 'ai', 'in'].map(
      (tld) => `mark.${tld}/work`,
    ),
    'bit.ly/x',
    'johndoe.tech/cv',
    'GITHUB.COM/X',
    'GitHub.Com/x',
  ])('redacts %s with no context of the senior', (url) => {
    expect(scanContacts(`see ${url} now`, ctx)).toEqual([{ kind: 'url', match: url }])
    expect(redactContacts(`see ${url} now`, [])).toBe('see [REDACTED] now')
    expect(hasContact(`see ${url}`, [])).toBe(true)
  })

  it.each([
    'Built on Node.js and Next.js',
    'Vue.js, Socket.IO, ASP.NET and .NET',
    'Charts in D3.js and Three.js',
    'Express.js/Nest backend',
    'mark.dev without a path',
    'Node.js/Express and Express.JS/Nest',
    'github.com',
  ])('leaves a tech name alone: %s', (text) => {
    expect(scanContacts(text, ctx)).toEqual([])
    expect(redactContacts(text, [])).toBe(text)
  })
})

describe('labelled Telegram handles (SR-M-1)', () => {
  it.each([
    'tg: other_one',
    'TG:@other_one',
    'telegram : @@other_one',
    '\u{0422}\u{0435}\u{043B}\u{0435}\u{0433}\u{0440}\u{0430}\u{043C}: other_one',
  ])('redacts %s though it is not the stored handle', (text) => {
    expect(scanContacts(text, ctx)).toEqual([{ kind: 'telegram', match: text }])
    expect(redactContacts(`Acme (${text})`, [])).toBe('Acme ([REDACTED])')
  })

  it('redacts only the label hit, not the character in front of it (SR-L-5)', () => {
    expect(scanContacts('(tg:mark_dev)', ctx)).toEqual([{ kind: 'telegram', match: 'tg:mark_dev' }])
    expect(redactContacts('Reach tg: @mark_dev now', [])).toBe('Reach [REDACTED] now')
  })

  it.each([
    ['MyTelegram: mark_dev', 'Telegram: mark_dev'],
    ['PersonalTG: mark_dev', 'TG: mark_dev'],
  ])('a label glued to a word still hits: %j gives %j (SR-L-5b)', (text, match) => {
    expect(scanContacts(text, ctx)).toEqual([{ kind: 'telegram', match }])
  })

  it.each(['Debug tg:12345', 'xtg: other_one'])('leaves %s alone (SR-L-5)', (text) => {
    expect(scanContacts(text, ctx)).toEqual([])
  })

  it('a URL glued to a word is still redacted (SR-L-4)', () => {
    expect(redactContacts('see foo_github.com/x', [])).toBe('see foo_[REDACTED]')
  })

  it.each([
    ['a.', 'a.'.repeat(25_000)],
    ['a-.', 'a-.'.repeat(16_667)],
  ])('a 50k-character %j repeat is redacted in under 500 ms (SR-L-3, R91)', (_, text) => {
    const started = cpuMs()
    redactContacts(text, ctx)
    expect(cpuMs() - started).toBeLessThan(BUDGET_MS)
  })

  it('leaves a bare @package alone', () => {
    const text = 'used @angular/core and @nestjs/common'
    expect(scanContacts(text, ctx)).toEqual([])
    expect(hasContact(text, [])).toBe(false)
  })
})

describe('no context of the senior', () => {
  it('redactContacts still redacts every email and phone', () => {
    expect(redactContacts('mail a@b.io or +380671234567', [])).toBe('mail [REDACTED] or [REDACTED]')
  })

  it('hasContact still flags every email and phone', () => {
    expect(hasContact('mail a@b.io', [])).toBe(true)
    expect(hasContact('call +380671234567', [])).toBe(true)
    expect(hasContact('no contacts here', [])).toBe(false)
  })
})

describe('fix round 3: Unicode hosts, unlabelled handles, handle links, bounds', () => {
  it.each([
    '\u{043F}\u{0440}\u{0438}\u{043C}\u{0435}\u{0440}.\u{0443}\u{043A}\u{0440}/\u{0440}\u{0435}\u{0437}\u{044E}\u{043C}\u{0435}',
    '\u{0438}\u{0432}\u{0430}\u{043D}.\u{0440}\u{0444}/cv',
    'm\u{00FC}nchen.de/x',
    '\u{0438}\u{0432}\u{0430}\u{043D}.xn--p1ai/x',
    'example.xn--p1ai/cv',
  ])('redacts the whole Unicode or punycode URL %s (SO23-1)', (url) => {
    expect(scanContacts(`see ${url} now`, ctx)).toEqual([{ kind: 'url', match: url }])
    expect(redactContacts(`see ${url} now`, [])).toBe('see [REDACTED] now')
  })

  it('redacts the whole email with a punycode TLD (SO23-1)', () => {
    expect(redactContacts('mail ivan@example.xn--p1ai now', [])).toBe('mail [REDACTED] now')
  })

  it.each([
    'TG @other_one',
    'Telegram - @other_one',
    'Telegram @other_one',
    'Telegram \u{2014} @other_one',
    'tg\u{2014}other_one',
    '\u{0442}\u{0433}: other_one',
    '\u{0422}\u{0413} @other_one',
  ])('redacts the unlabelled or Cyrillic-labelled handle %s (SO23-2)', (label) => {
    expect(scanContacts(label, ctx)).toEqual([{ kind: 'telegram', match: label }])
    expect(redactContacts(`Acme (${label})`, [])).toBe('Acme ([REDACTED])')
  })

  it.each(['Telegram bots', 'TG integration', 'Telegram-integration service', 'Debug tg:12345'])(
    'leaves %s alone (SO23-2)',
    (plain) => {
      expect(scanContacts(plain, ctx)).toEqual([])
      expect(redactContacts(plain, [])).toBe(plain)
    },
  )

  it.each([
    't.me/mark_dev?start=1',
    't.me/mark_dev/',
    'https://t.me/mark_dev#top',
    'tg://resolve?domain=mark_dev',
  ])('a stored telegram of %j redacts the bare handle (SO23-4)', (telegram) => {
    expect(redactContacts('Acme (ask mark_dev)', { ...ctx, telegram })).toBe(
      'Acme (ask [REDACTED])',
    )
  })

  it('an email local part longer than 64 characters is redacted whole (SR-L-7)', () => {
    const email = `${'a'.repeat(40)}.${'b'.repeat(39)}@example.io`
    expect(scanContacts(`mail ${email} now`, ctx)).toEqual([{ kind: 'email', match: email }])
    expect(redactContacts(`mail ${email} now`, [])).toBe('mail [REDACTED] now')
  })

  it('a 15-label host is redacted whole, as an email and as a URL (SR-L-8)', () => {
    const host = `${'a.'.repeat(14)}co`
    expect(redactContacts(`mail x@${host} now`, [])).toBe('mail [REDACTED] now')
    expect(redactContacts(`see ${host}/x now`, [])).toBe('see [REDACTED] now')
  })

  it.each([
    ['\u{0442}\u{0433} - ', '\u{0442}\u{0433} - '.repeat(10_000)],
    ['Telegram @', 'Telegram @'.repeat(5_000)],
  ])('a 50k-character %j repeat is redacted in under 500 ms (R91)', (_, input) => {
    const started = cpuMs()
    redactContacts(input, ctx)
    expect(cpuMs() - started).toBeLessThan(BUDGET_MS)
  })

  // Linear, but Unicode classes cost ~10x ASCII on Node 22, so the Cyrillic case runs at 10k:
  // five times the longest field (2000).
  it('a 10k-character Cyrillic host repeat is redacted in under 500 ms (R91)', () => {
    const started = cpuMs()
    redactContacts('\u{043F}\u{0440}\u{0438}\u{043C}\u{0435}\u{0440}.'.repeat(1_429), ctx)
    expect(cpuMs() - started).toBeLessThan(BUDGET_MS)
  })
})

describe('fix round 4: label-boundary URLs and emails, label separators, handle links', () => {
  it.each([
    ['see foo_github.com/x now', 'see foo_[REDACTED] now', 'github.com/x'],
    ['(sub.domain.io/a, b)', '([REDACTED] b)', 'sub.domain.io/a,'],
    ['mail:ivan@example.io now', 'mail:[REDACTED] now', 'ivan@example.io'],
  ])('redacts only the group-1 hit in %j (SR3-M-1)', (text, redacted, match) => {
    expect(redactContacts(text, [])).toBe(redacted)
    expect(scanContacts(text, ctx).map((h) => h.match)).toEqual([match])
  })

  it('notes of Cyrillic characters in 63-letter labels are redacted in time linear in their length (SR3-M-1)', () => {
    // A ratio within one run, not a fixed 500 ms: CI took 503 and 598 ms on a loaded runner. The
    // same 300k characters as 600 notes of 500 and as 75 notes of 4000: a linear scan costs the
    // same for both, backtracking that is quadratic in the note costs the long notes about 8x.
    const run = (count: number, length: number): number => {
      const note = `${'\u{043F}'.repeat(63)}.`.repeat(Math.ceil(length / 64)).slice(0, length)
      const started = cpuMs()
      for (let i = 0; i < count; i++) redactContacts(note, ctx)
      return cpuMs() - started
    }
    run(60, 500) // warm-up, so JIT compilation is not billed to the short notes
    const repeats = armRepeats((k) => run(600 * k, 500))
    const short = run(600 * repeats, 500)
    const long = run(75 * repeats, 4000)
    expect(short).toBeGreaterThanOrEqual(MIN_ARM_MS * 0.5)
    expect(long / short).toBeLessThan(3)
    // catastrophic backtracking costs seconds per note; a slow runner costs a fraction of this
    expect(short).toBeLessThan(BUDGET_MS * 10)
  })

  it('a stored name of many invisible-separated parts is scanned in time linear in its part count (PR #1351 round 9, Addendum A)', () => {
    // The gate's runs of split parts grow with the square of the part count; past 8 parts it takes
    // none. From 20 to 160 parts a linear scan costs at most 8x (measured 3.8x); without the bound
    // it measured 208x. The wide gap keeps the ratio stable on a loaded pre-push run.
    const parts = (count: number): string[] =>
      Array.from({ length: count }, (_, i) => ['Li', 'Yu', 'Bo'][i % 3] ?? '')
    const stored = (count: number): ContactContext => ({
      fullName: `Ivan ${parts(count).join('\u200B')}`,
      emails: [],
    })
    const text = 'Senior engineer in Kyiv since 2020, led an API migration. '.repeat(12)
    const run = (count: number, repeats = 1): number => {
      const started = cpuMs()
      for (let i = 0; i < 20 * repeats; i++) scanContacts(text, stored(count))
      return cpuMs() - started
    }
    run(20) // warm-up
    // 20 scans of 20 parts took 2-4 ms on CI: too short a window for a stable ratio (backlog 454)
    const repeats = armRepeats((k) => run(20, k))
    const short = run(20, repeats)
    const long = run(160, repeats)
    expect(short).toBeGreaterThanOrEqual(MIN_ARM_MS * 0.5)
    expect(long / short).toBeLessThan(16)
    // per scan of the window, so the absolute cap does not grow with `repeats` (fix item 2)
    expect(long / repeats).toBeLessThan(BUDGET_MS * 10)
    // still fail-closed: the full name refuses, and so does a lone short part (round 7's gate)
    const full = `Ivan ${parts(160).join(' ')}`
    expect(scanContacts(full, stored(160))).toEqual([{ kind: 'name', match: full }])
    expect(scanContacts('by Li today', stored(160))).toEqual([{ kind: 'name', match: 'Li' }])
  })

  it('the gate at its run bound stays bounded and the in-text filter keeps absent parts free (PR #1362 fix 1)', () => {
    // Parts no text holds (Qa, Jx, ...): the in-text filter leaves no run, so 8 of them cost like 1.
    // The same 8 appended to the text build the full run set (2^7 subsets, both orders). At
    // MAX_RUN_PARTS = 16 the present16 arm builds 2^15 subsets per scan. The scan is synchronous, so the
    // 90 s test timeout cannot stop it: it runs to completion and the test is then reported timed out,
    // not failed by an assertion. The plain 9-part row below is the fast guard and fails at once.
    const pool = [
      'Qa',
      'Jx',
      'Vq',
      'Zk',
      'Fj',
      'Pw',
      'Hv',
      'Mq',
      'Gx',
      'Tz',
      'Kq',
      'Wj',
      'Yq',
      'Xz',
      'Bq',
      'Dv',
    ]
    const base = 'Senior engineer in Kyiv since 2020, led an API migration. '.repeat(12)
    const timed = (text: string, name: string, repeats: number): number => {
      const started = cpuMs()
      for (let i = 0; i < 20 * repeats; i++) scanContacts(text, { fullName: name, emails: [] })
      return cpuMs() - started
    }
    // time per scan, each arm with its own window of at least MIN_ARM_MS
    const perScan = (text: string, name: string): number => {
      const repeats = armRepeats((k) => timed(text, name, k))
      return timed(text, name, repeats) / (20 * repeats)
    }
    const zwsp = String.fromCharCode(0x200b)
    // total parts = count: `Ivan` plus count - 1 pool entries, joined by ZWSP (the split reading)
    const name = (count: number): string => ['Ivan', ...pool.slice(0, count - 1)].join(zwsp)
    const withParts = (count: number): string => `${base} ${pool.slice(0, count - 1).join(' ')}`
    const ref = perScan(base, 'Ivan')
    const absent8 = perScan(base, name(8))
    const present8 = perScan(withParts(8), name(8))
    const present16 = perScan(withParts(16), name(16))
    expect(absent8 / ref).toBeLessThan(RATIO_ABSENT)
    expect(present8 / ref).toBeLessThan(RATIO_PRESENT)
    expect(present16 / ref).toBeLessThan(RATIO_PRESENT)
  })

  it('a 9-part split name builds no run at MAX_RUN_PARTS 8: the bound is pinned, and raising it fails at once (PR #1362 fix 2)', () => {
    // Split reading: Ivan, J, K, L, M, N, O, P, Q (nine parts). Past 8 parts every part of two letters
    // or more is a lone source, so only single letters can refuse through a run. At MAX_RUN_PARTS 8
    // no run is built and `J K L` is not refused; at 9 to 15, or 16, the run `JKL` is built and this
    // row fails at once, without a timing wait.
    const zwsp = String.fromCharCode(0x200b)
    const fullName = ['Ivan', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'].join(zwsp)
    expect(scanContacts('J K L', { fullName, emails: [] })).toEqual([])
  })

  // Live rows: each stored name has 4 split parts (MAX_RUN_PARTS 8 builds runs), and two short whole
  // tokens (1-2 letters, so no lone source) sit in the prose with a bracket in the gap between them:
  // ` (`, `. (` or `) `. The real RUN_GAP (whitespace and at most one joiner) does not match a bracket,
  // so the row passes; a wildcard gap matches and the row fails. The joiner rows (`.`, `_`, U+00B7,
  // `e.g.`) keep the joiner in the prose. Examples `v1.2.3` and `2024-05-01` stay green
  // under the wildcard too (no short whole token pair), so they are dropped (PR #1362 fix 4, fix 5).
  it.each([
    ['J (Mi) Smith', 'Ivan Kot\u{200B}J\u{200B}Mi'],
    ['ak (ca) name', 'Ivan Kot\u{200B}ak\u{200B}ca'],
    ['ol (ab) laboraci\u{00F3}', 'Ivan Kot\u{200B}ol\u{200B}ab'],
    ['J. (Mi) Smith', 'Ivan Kot\u{200B}J\u{200B}Mi'],
    ['see e.g. (Mi) this', 'Ivan Kot\u{200B}g\u{200B}Mi'],
    ['snake_ (ca) se', 'Ivan Kot\u{200B}ca\u{200B}se'],
    ['col\u{00B7}la (ab) boraci\u{00F3}', 'Ivan Kot\u{200B}la\u{200B}ab'],
  ])(
    'prose %j is not refused, with the short parts not adjacent (PR #1362 fix 4)',
    (text, fullName) => {
      expect(scanContacts(text, { fullName, emails: [] })).toEqual([])
    },
  )

  it('notes of one cluster full of invisibles are redacted in time linear in their length (PR #1351 round 4, CR-M-2)', () => {
    // A letter followed by (ZWSP, acute) pairs and a jamo run with a ZWSP between its jamo are
    // one cluster each, however long: re-normalising the cluster per invisible is quadratic.
    const shapes = ['\u200B\u0301', '\u1100\u200B\u1161']
    const run = (count: number, length: number): number => {
      const notes = shapes.map((shape) =>
        `q${shape.repeat(Math.ceil(length / shape.length))}`.slice(0, length),
      )
      const started = cpuMs()
      for (let i = 0; i < count; i++) for (const note of notes) redactContacts(note, ctx)
      return cpuMs() - started
    }
    run(60, 500) // warm-up
    const short = run(600, 500)
    const long = run(75, 4000)
    expect(long / short).toBeLessThan(3)
    expect(short).toBeLessThan(BUDGET_MS * 10)
  })

  it.each([
    'Telegram\u{FF1A}mark_dev',
    'tg\u{2010}mark_dev',
    'tg\u{2012}mark_dev',
    'tg \u{2015} mark_dev',
    'Telegram \u{2212} @mark_dev',
    'Telegram:@ mark_dev',
    '\u{0422}\u{0435}\u{043B}\u{0435}\u{0433}\u{0440}\u{0430}\u{043C}\u{043C}: mark_dev',
  ])('redacts the labelled handle %j (SR3-L-1)', (label) => {
    expect(redactContacts(`Acme (${label})`, [])).toBe('Acme ([REDACTED])')
  })

  it.each(['Telegram (@mark_dev)', 'Telegram | @mark_dev', 'Telegram.@mark_dev', 'tg/@mark_dev'])(
    'leaves the punctuation-wrapped label %j to the stored-handle check (SR3-L-1 shortcut)',
    (text) => {
      expect(redactContacts(text, [])).toBe(text)
    },
  )

  it('a stored t.me/s/ link redacts the handle, not the word s (SR3-L-2)', () => {
    const stored = { ...ctx, telegram: 't.me/s/mark_dev' }
    expect(redactContacts('Acme (ask mark_dev)', stored)).toBe('Acme (ask [REDACTED])')
    expect(redactContacts('Built 5 s services', stored)).toBe('Built 5 s services')
  })

  it.each(['t.me/joinchat/AbCdEf', 't.me/s'])(
    'a stored %j adds no handle hit (SR3-L-2)',
    (telegram) => {
      expect(scanContacts('ping AbCdEf joinchat s', { ...ctx, telegram })).toEqual([])
    },
  )

  it('50k spaces are redacted in under 500 ms (SR3-L-3)', () => {
    const started = cpuMs()
    redactContacts(' '.repeat(50_000), ctx)
    expect(cpuMs() - started).toBeLessThan(BUDGET_MS)
  })
})

describe('fix round 5: an email glued to the next one by a local-part character', () => {
  it.each(['a@b.com-c@d.com', 'a@b.com.c@d.com', 'x@y.ua1ivan@gmail.com'])(
    'redacts both addresses in %j (SR4-M-1)',
    (glued) => {
      expect(redactContacts(`mail ${glued} now`, [])).toBe('mail [REDACTED] now')
    },
  )

  it('a URL is still found once, not from inside its own hit (SR4-M-1)', () => {
    expect(scanContacts('see sub.domain.io/a now', ctx)).toEqual([
      { kind: 'url', match: 'sub.domain.io/a' },
    ])
  })

  it.each([
    ['a@b.co-', 'a@b.co-'.repeat(7_143)],
    ['a@', 'a@'.repeat(25_000)],
    ['a.a@b.', 'a.a@b.'.repeat(8_334)],
  ])('a 50k-character %j repeat is redacted in under 500 ms (SR4-M-1)', (_, input) => {
    const started = cpuMs()
    redactContacts(input, ctx)
    expect(cpuMs() - started).toBeLessThan(BUDGET_MS)
  })

  it.each([
    ['\u{1D41A}@b.com', '[REDACTED]'],
    ['\u{1D41A}@b.com-\u{1D41C}@d.com', '[REDACTED]'],
    ['x \u{1D41A}\u{1D41B}@b.com y', 'x [REDACTED] y'],
    // U+10000, the first astral code point, is a letter
    ['\u{10000}@b.com-\u{10000}@d.com', '[REDACTED]'],
  ])(
    'an email starting with an astral letter, %j, is redacted and the scan ends (SR5-H-1)',
    (text, redacted) => {
      const started = cpuMs()
      expect(redactContacts(text, [])).toBe(redacted)
      expect(scanContacts(text, ctx).map((h) => h.kind)).toEqual(['email'])
      expect(cpuMs() - started).toBeLessThan(BUDGET_MS)
    },
  )

  it('50k characters of "1," are redacted in under 500 ms (SR4-L-1)', () => {
    const started = cpuMs()
    redactContacts('1,'.repeat(25_000), ctx)
    expect(cpuMs() - started).toBeLessThan(BUDGET_MS)
  })
})

describe('fix round 7: separators, marks, atext, ports, label words', () => {
  it.each(['\u{2011}', '\u{2014}', '\u{00B7}'])(
    'redacts a phone separated by %j whole (SO7-1)',
    (sep) => {
      const phone = ['+380', '67', '123', '45', '67'].join(sep)
      expect(scanContacts(`call ${phone} now`, ctx)).toEqual([{ kind: 'phone', match: phone }])
      expect(redactContacts(`call ${phone} now`, [])).toBe('call [REDACTED] now')
    },
  )

  it('leaves an em-dash date range alone (SO7-1)', () => {
    expect(redactContacts('Acme 2015-01-01 \u{2014} 2019-12-31', [])).toBe(
      'Acme 2015-01-01 \u{2014} 2019-12-31',
    )
  })

  it.each([
    [
      'john@\u{092A}\u{0930}\u{0940}\u{0915}\u{094D}\u{0937}\u{093E}.\u{092D}\u{093E}\u{0930}\u{0924}',
      'email',
    ],
    [
      '\u{0E1C}\u{0E39}\u{0E49}\u{0E43}\u{0E0A}\u{0E49}@\u{0E15}\u{0E31}\u{0E27}\u{0E2D}\u{0E22}\u{0E48}\u{0E32}\u{0E07}.\u{0E44}\u{0E17}\u{0E22}',
      'email',
    ],
    ['x\u0301y@x.com', 'email'],
    ['\u{0909}\u{0926}\u{093E}\u{0939}\u{0930}\u{0923}.\u{092D}\u{093E}\u{0930}\u{0924}/x', 'url'],
    ['john&doe@x.com', 'email'],
    ["o'brien@x.com", 'email'],
    ['o\u{2019}brien@x.com', 'email'],
    ['example.com:8080/cv', 'url'],
    ['a.com:80/x', 'url'],
  ])('redacts %j whole as one %s (SO7-2, SO7-3, SO7-4)', (contact, kind) => {
    expect(scanContacts(`see ${contact} now`, ctx)).toEqual([{ kind, match: contact }])
    expect(redactContacts(`see ${contact} now`, [])).toBe('see [REDACTED] now')
  })

  it.each([
    'Telegram handle: other_one',
    'TG nick: other_one',
    'Telegram ID: other_one',
    '\u{0422}\u{0435}\u{043B}\u{0435}\u{0433}\u{0440}\u{0430}\u{043C} \u{043D}\u{0456}\u{043A}: other_one',
  ])('redacts the labelled handle %j with a word before the separator (SO7-5)', (label) => {
    expect(redactContacts(`Acme (${label})`, [])).toBe('Acme ([REDACTED])')
  })

  it.each(['Telegram bots', 'TG integration', 'Telegram user base'])(
    'leaves %j alone (SO7-5)',
    (plain) => {
      expect(redactContacts(plain, [])).toBe(plain)
    },
  )

  it('50k characters of "Telegram handle" are redacted in under 500 ms (SO7-5)', () => {
    const started = cpuMs()
    redactContacts('Telegram handle'.repeat(3_334), ctx)
    expect(cpuMs() - started).toBeLessThan(BUDGET_MS)
  })
})

describe('redactContacts agrees with the completeness contact check on NFD text (SR7-L-1)', () => {
  const FACTS: ResumeFacts = {
    headline: 'Senior Frontend Engineer',
    location: { city: 'Kyiv', country: 'Ukraine' },
    workFormat: 'remote',
    skills: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'PostgreSQL'],
    experience: [],
    education: [],
    languages: [],
    links: [],
  }
  const now = new Date('2026-11-10T00:00:00Z')

  it.each(['x@y.e\u0301', 'see a.e\u0301/x now', 'Ae\u0301tg: mark_dev'])(
    '%j is flagged and redacted, or neither',
    (text) => {
      const flagged = checkResumeCompleteness(
        { ...FACTS, headline: text },
        { displayName: ctx.fullName, now },
      ).some((issue) => issue.code === 'CONTACT_IN_TEXT')
      const redacted = redactContacts(text, ctx) !== text.normalize('NFC')
      expect(flagged).toBe(redacted)
    },
  )
})
