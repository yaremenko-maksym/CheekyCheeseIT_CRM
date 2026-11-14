/**
 * Contact scan (verified-base-resume Task 9): a senior's contact details never
 * reach a third-party AI writer. A missed contact is a leak, so the scan is
 * deliberately greedy and redaction is checked by re-scanning its own output.
 */
import { checkResumeCompleteness, type ResumeFacts } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { redactContacts, scanContacts, type ContactContext } from './contact-scan'
import { hasContact } from './content-gates'

const ctx: ContactContext = { fullName: 'Mark Levin', emails: ['mark.levin@example.com'] }

describe('scanContacts — names', () => {
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

  it('treats # and + as word characters at the boundary', () => {
    expect(scanContacts('Levin# Levin+ #Levin', ctx)).toEqual([])
  })

  it('matches a diacritic surname whatever the Unicode normalisation of either side', () => {
    const muller = { fullName: 'Anna Müller', emails: [] }
    expect(scanContacts('by MÜLLER', muller)).toEqual([{ kind: 'name', match: 'MÜLLER' }])
    // decomposed u + combining diaeresis in the text
    expect(scanContacts('by Mu\u0308ller', muller)).toEqual([{ kind: 'name', match: 'Müller' }])
    // decomposed in the context, composed in the text
    expect(scanContacts('by Müller', { fullName: 'Anna Mu\u0308ller', emails: [] })).toEqual([
      { kind: 'name', match: 'Müller' },
    ])
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

describe('scanContacts — phones and emails', () => {
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

  it('hits any email the pattern recognises, not only the senior’s', () => {
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
    expect(scanContacts('ping müller@intranet', nfd)).toEqual([
      { kind: 'email', match: 'müller@intranet' },
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
  const sample = 'Mark Levin (+380671234567, mark.levin@example.com) — Levin led it; Mark reviewed.'

  it('replaces every hit with [REDACTED] and leaves the rest alone', () => {
    expect(redactContacts(sample, ctx)).toBe(
      '[REDACTED] ([REDACTED], [REDACTED]) — [REDACTED] led it; Mark reviewed.',
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
    const muller = { fullName: 'Anna Müller', emails: [] }
    expect(scanContacts(redactContacts('by Mu\u0308ller', muller), muller)).toEqual([])
  })
})

describe('scanContacts — serialized text and spelling variants (fix round 1)', () => {
  const name = (match: string) => ({ kind: 'name', match })

  it('treats a JSON escape before the surname as a boundary', () => {
    expect(scanContacts('…it.\\nLevin reviewed', ctx)).toEqual([name('Levin')])
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
    expect(scanContacts('by O’Brien, Oʼbrien and O‘Brien', straight)).toEqual([
      name('O’Brien'),
      name('Oʼbrien'),
      name('O‘Brien'),
    ])
    expect(scanContacts("by O'Brien", { fullName: 'Sean O’Brien', emails: [] })).toEqual([
      name("O'Brien"),
    ])
  })

  it('hits a possessive surname', () => {
    expect(scanContacts("Levin's code and Levin’s tests", ctx)).toEqual([
      name('Levin'),
      name('Levin'),
    ])
  })

  it('matches the accent-folded spelling of a name, both ways, and reports it as written', () => {
    const accented = { fullName: 'Anna Müller', emails: [] }
    expect(scanContacts('by Muller', accented)).toEqual([name('Muller')])
    expect(scanContacts('by Müller', { fullName: 'Anna Muller', emails: [] })).toEqual([
      name('Müller'),
    ])
    // known limit: a transliteration is not a fold
    expect(scanContacts('by Mueller', accented)).toEqual([])
  })

  it.each([
    ['ł', 'l'],
    ['Ł', 'L'],
    ['ø', 'o'],
    ['Ø', 'O'],
    ['đ', 'd'],
    ['Đ', 'D'],
    ['ß', 'ss'],
    ['ẞ', 'SS'],
    ['ı', 'i'],
    ['æ', 'ae'],
    ['Æ', 'AE'],
    ['œ', 'oe'],
    ['Œ', 'OE'],
    ['þ', 'th'],
    ['Þ', 'TH'],
    ['ħ', 'h'],
    ['Ħ', 'H'],
  ])('folds %s to %s', (letter, folded) => {
    expect(
      redactContacts(`by Qu${folded}q, ok`, { fullName: `Ann Qu${letter}q`, emails: [] }),
    ).toBe('by [REDACTED], ok')
  })

  it('folds capital ẞ, which /iu does not case-fold to ss', () => {
    expect(redactContacts('by STRAUẞ, ok', { fullName: 'Max Strauß', emails: [] })).toBe(
      'by [REDACTED], ok',
    )
  })

  it('folds dotless ı', () => {
    expect(redactContacts('by Yildiz, ok', { fullName: 'Ece Yıldız', emails: [] })).toBe(
      'by [REDACTED], ok',
    )
  })

  it('folds the ligatures æ and œ', () => {
    expect(redactContacts('by Baekoe, ok', { fullName: 'Ann Bækœ', emails: [] })).toBe(
      'by [REDACTED], ok',
    )
  })

  it('folds letters without a Unicode decomposition: ł ø đ ß', () => {
    const polish = { fullName: 'Jan Wałęsa', emails: [] }
    expect(scanContacts('by Walesa', polish)).toEqual([name('Walesa')])
    expect(scanContacts('by WAŁĘSA', { fullName: 'Jan Walesa', emails: [] })).toEqual([
      name('WAŁĘSA'),
    ])
    expect(scanContacts('by Sorensen', { fullName: 'Ib Sørensen', emails: [] })).toEqual([
      name('Sorensen'),
    ])
    expect(scanContacts('by Dorde', { fullName: 'Ana Đorđe', emails: [] })).toEqual([name('Dorde')])
    expect(redactContacts('by Strasse, ok', { fullName: 'Max Straße', emails: [] })).toBe(
      'by [REDACTED], ok',
    )
    expect(redactContacts('by Straße, ok', { fullName: 'Max Strasse', emails: [] })).toBe(
      'by [REDACTED], ok',
    )
  })

  it('redacts a folded match on its original span', () => {
    const bronte = { fullName: 'Zoë Brontë', emails: [] }
    expect(redactContacts('Zoe Bronte and Brontë, then Bronte.', bronte)).toBe(
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
    expect(scanContacts('tel +38 067 123–45–67', ctx)).toEqual([
      { kind: 'phone', match: '+38 067 123–45–67' },
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
  it.each(['tg: other_one', 'TG:@other_one', 'telegram : @@other_one', 'Телеграм: other_one'])(
    'redacts %s though it is not the stored handle',
    (text) => {
      expect(scanContacts(text, ctx)).toEqual([{ kind: 'telegram', match: text }])
      expect(redactContacts(`Acme (${text})`, [])).toBe('Acme ([REDACTED])')
    },
  )

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
    const started = performance.now()
    redactContacts(text, ctx)
    expect(performance.now() - started).toBeLessThan(500)
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
    'пример.укр/резюме',
    'иван.рф/cv',
    'münchen.de/x',
    'иван.xn--p1ai/x',
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
    'Telegram — @other_one',
    'tg—other_one',
    'тг: other_one',
    'ТГ @other_one',
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
    ['тг - ', 'тг - '.repeat(10_000)],
    ['Telegram @', 'Telegram @'.repeat(5_000)],
  ])('a 50k-character %j repeat is redacted in under 500 ms (R91)', (_, input) => {
    const started = performance.now()
    redactContacts(input, ctx)
    expect(performance.now() - started).toBeLessThan(500)
  })

  // Linear, but Unicode classes cost ~10x ASCII on Node 22, so the Cyrillic case runs at 10k:
  // five times the longest field (2000).
  it('a 10k-character Cyrillic host repeat is redacted in under 500 ms (R91)', () => {
    const started = performance.now()
    redactContacts('пример.'.repeat(1_429), ctx)
    expect(performance.now() - started).toBeLessThan(500)
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

  it('600 notes of 500 Cyrillic characters in 63-letter labels are redacted in under 500 ms (SR3-M-1)', () => {
    const note = `${'п'.repeat(63)}.`.repeat(8).slice(0, 500)
    const started = performance.now()
    for (let i = 0; i < 600; i++) redactContacts(note, ctx)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it.each([
    'Telegram：mark_dev',
    'tg‐mark_dev',
    'tg‒mark_dev',
    'tg ― mark_dev',
    'Telegram − @mark_dev',
    'Telegram:@ mark_dev',
    'Телеграмм: mark_dev',
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
    const started = performance.now()
    redactContacts(' '.repeat(50_000), ctx)
    expect(performance.now() - started).toBeLessThan(500)
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
    const started = performance.now()
    redactContacts(input, ctx)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it.each([
    ['𝐚@b.com', '[REDACTED]'],
    ['𝐚@b.com-𝐜@d.com', '[REDACTED]'],
    ['x 𝐚𝐛@b.com y', 'x [REDACTED] y'],
    // U+10000, the first astral code point, is a letter
    ['\u{10000}@b.com-\u{10000}@d.com', '[REDACTED]'],
  ])(
    'an email starting with an astral letter, %j, is redacted and the scan ends (SR5-H-1)',
    (text, redacted) => {
      const started = performance.now()
      expect(redactContacts(text, [])).toBe(redacted)
      expect(scanContacts(text, ctx).map((h) => h.kind)).toEqual(['email'])
      expect(performance.now() - started).toBeLessThan(500)
    },
  )

  it('50k characters of "1," are redacted in under 500 ms (SR4-L-1)', () => {
    const started = performance.now()
    redactContacts('1,'.repeat(25_000), ctx)
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('fix round 7: separators, marks, atext, ports, label words', () => {
  it.each(['‑', '—', '·'])('redacts a phone separated by %j whole (SO7-1)', (sep) => {
    const phone = ['+380', '67', '123', '45', '67'].join(sep)
    expect(scanContacts(`call ${phone} now`, ctx)).toEqual([{ kind: 'phone', match: phone }])
    expect(redactContacts(`call ${phone} now`, [])).toBe('call [REDACTED] now')
  })

  it('leaves an em-dash date range alone (SO7-1)', () => {
    expect(redactContacts('Acme 2015-01-01 — 2019-12-31', [])).toBe('Acme 2015-01-01 — 2019-12-31')
  })

  it.each([
    ['john@परीक्षा.भारत', 'email'],
    ['ผู้ใช้@ตัวอย่าง.ไทย', 'email'],
    ['x́y@x.com', 'email'],
    ['उदाहरण.भारत/x', 'url'],
    ['john&doe@x.com', 'email'],
    ["o'brien@x.com", 'email'],
    ['o’brien@x.com', 'email'],
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
    'Телеграм нік: other_one',
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
    const started = performance.now()
    redactContacts('Telegram handle'.repeat(3_334), ctx)
    expect(performance.now() - started).toBeLessThan(500)
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

  it.each(['x@y.é', 'see a.é/x now', 'Aétg: mark_dev'])(
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
