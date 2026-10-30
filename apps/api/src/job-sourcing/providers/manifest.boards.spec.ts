import { describe, expect, it } from 'vitest'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import { buildManifest, ManifestError, readinessAt } from './manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from './manifest.adapters'
import { boardEntries } from './manifest.boards'
import { MANIFEST_DEFINITIONS } from './manifest.definitions'
import { buildLedgerCatalogSnapshot } from './manifest.ledger-catalog'

/**
 * U8a (source fetch strategy ADR, section 8a): board lines are data; the generator turns them into
 * manifest entries. Every refusal below is asserted on its code, and every test that expects a
 * refusal has a twin that builds the same line when it is valid.
 */

const PROFILE = (timeZone: string) => ({
  intervalMinutes: 60,
  offIntervalMinutes: 180,
  window: { timeZone, days: ['MON', 'TUE', 'WED', 'THU', 'FRI'], from: '08:00', to: '19:00' },
})
const generate = (lines: unknown, prefix = 'greenhouse') =>
  boardEntries({ prefix, lines, profileFor: PROFILE })

const stripe = {
  token: 'stripe',
  employer: 'Stripe',
  domain: 'stripe.com',
  timeZone: 'America/Los_Angeles',
  addedBy: 'manual',
  evidence: ['stripe-board.json'],
}

/** The whole manifest, with the Greenhouse entries replaced by what `lines` generate. */
function buildWith(lines: unknown) {
  const defs = MANIFEST_DEFINITIONS.map((d) =>
    d.type === 'GREENHOUSE_ATS' ? { ...d, entries: generate(lines) } : d,
  )
  return buildManifest({
    definitions: defs,
    adapters: MANIFEST_VALIDATION_ADAPTERS,
    fixtureRoot: FIXTURE_ROOT,
  })
}
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    return e instanceof ManifestError ? e.code : `not a ManifestError: ${String(e)}`
  }
  return undefined
}

describe('the board generator', () => {
  it('turns a line into an entry: id, config, ownership and the profile in the board zone', () => {
    expect(generate([stripe])).toEqual([
      {
        id: 'greenhouse.board.stripe',
        config: { board: 'stripe' },
        ownership: { fixtures: ['stripe-board.json'], name: 'Stripe', domain: 'stripe.com' },
        fetchProfile: PROFILE('America/Los_Angeles'),
      },
    ])
  })

  it('puts a Lever region in the id and the config, and a Personio language in the config', () => {
    const [eu] = generate([{ ...stripe, token: 'siteimprove', region: 'eu' }], 'lever')
    expect(eu!.id).toBe('lever.board.eu.siteimprove')
    expect(eu!.config).toStrictEqual({ board: 'siteimprove', region: 'eu' })
    const [de] = generate([{ ...stripe, token: 'westwing', language: 'en' }], 'personio')
    expect(de!.id).toBe('personio.board.westwing')
    expect(de!.config).toStrictEqual({ board: 'westwing', language: 'en' })
  })

  it('a line with evidence null has no ownership and is flagged as awaiting evidence', () => {
    const [e] = generate([{ ...stripe, evidence: null }])
    expect(e!.ownership).toBeUndefined()
    expect(e!.awaitingEvidence).toBe(true)
    expect(generate([stripe])[0]!.awaitingEvidence).toBeUndefined()
  })

  it.each([
    ['an unknown key (a file can never enable a board)', { ...stripe, enabled: true }],
    ['a missing evidence key', { ...stripe, evidence: undefined }],
    ['an empty evidence list', { ...stripe, evidence: [] }],
    ['a missing time zone', { ...stripe, timeZone: undefined }],
    ['an upper-case token', { ...stripe, token: 'Stripe' }],
    ['a token with a slash', { ...stripe, token: 'a/b' }],
    ['an empty token', { ...stripe, token: '' }],
    ['an unknown addedBy', { ...stripe, addedBy: 'somebody' }],
    ['a missing employer', { ...stripe, employer: undefined }],
    ['a missing domain key', { ...stripe, domain: undefined }],
  ])('refuses %s', (_name, line) => {
    expect(codeOf(() => generate([line]))).toBe('BOARD_LINE_INVALID')
    expect(codeOf(() => generate([stripe]))).toBeUndefined()
  })

  it('refuses a list that is not an array, saying which provider', () => {
    expect(() => generate(stripe)).toThrow(
      'BOARD_LINE_INVALID: greenhouse: a board file holds an array of lines',
    )
  })

  it('names the provider, the line number and the field of a refused line', () => {
    expect(() => generate([stripe, { ...stripe, timeZone: undefined }])).toThrow(
      /^BOARD_LINE_INVALID: greenhouse line 2: timeZone: /,
    )
    expect(() => generate([{ ...stripe, enabled: true }])).toThrow(
      /^BOARD_LINE_INVALID: greenhouse line 1: line: Unrecognized key/,
    )
  })

  it('writes a nested field path with dots', () => {
    expect(() => generate([{ ...stripe, evidence: [''] }])).toThrow(/line 1: evidence\.0: /)
  })

  it('reports every problem of a line, separated by a semicolon', () => {
    expect(() => generate([{ ...stripe, timeZone: undefined, employer: undefined }])).toThrow(
      /: (timeZone|employer): [^;]*; (timeZone|employer): /,
    )
  })

  it.each(['en1', '1en', 'EN', 'eng', 'e'])('refuses the Personio language %s', (language) => {
    expect(codeOf(() => generate([{ ...stripe, language }], 'personio'))).toBe('BOARD_LINE_INVALID')
    expect(codeOf(() => generate([{ ...stripe, language: 'de' }], 'personio'))).toBeUndefined()
  })

  it('says which board is listed twice', () => {
    expect(() => generate([stripe, stripe])).toThrow(
      'DUPLICATE_BOARD: greenhouse.board.stripe is listed twice',
    )
  })

  it('a plain line has a config of the token alone (no empty region or language)', () => {
    expect(generate([stripe])[0]!.config).toStrictEqual({ board: 'stripe' })
  })

  it('refuses a duplicate token, but not the same token in another Lever region', () => {
    expect(codeOf(() => generate([stripe, { ...stripe }]))).toBe('DUPLICATE_BOARD')
    const lever = (lines: unknown) => () => generate(lines, 'lever')
    expect(codeOf(lever([stripe, { ...stripe, region: 'eu' }]))).toBeUndefined()
    expect(
      codeOf(
        lever([
          { ...stripe, region: 'eu' },
          { ...stripe, region: 'eu' },
        ]),
      ),
    ).toBe('DUPLICATE_BOARD')
  })
})

describe('board lines through the manifest build', () => {
  it('a valid line builds (twin of every refusal below)', () => {
    const m = buildWith([stripe])
    expect(m.entries.filter((e) => e.type === 'GREENHOUSE_ATS').map((e) => e.id)).toEqual([
      'greenhouse.board.stripe',
    ])
  })

  it.each(['Mars/Olympus', 'UTC', 'America/Los_Angelez'])('refuses the time zone %s', (zone) => {
    expect(codeOf(() => buildWith([{ ...stripe, timeZone: zone }]))).toBe('FETCH_PROFILE_INVALID')
  })

  it('refuses an evidence file that is not a committed capture', () => {
    expect(codeOf(() => buildWith([{ ...stripe, evidence: ['nothing.json'] }]))).toBe(
      'FIXTURE_MISSING',
    )
  })

  it('refuses an employer the evidence does not name', () => {
    expect(codeOf(() => buildWith([{ ...stripe, employer: 'Initech' }]))).toBe(
      'OWNER_NOT_IN_EVIDENCE',
    )
  })

  it('refuses a token the adapter would not accept (the token charset stays the adapter’s)', () => {
    expect(codeOf(() => buildWith([{ ...stripe, token: 'a_b' }]))).toBe('CONFIG_REJECTED')
  })

  it('AC 3: a line with evidence null is BLOCKED for its entry and for the ledger, never due', () => {
    const m = buildWith([
      stripe,
      { ...stripe, token: 'airbnb', employer: 'Airbnb', evidence: null },
    ])
    const [withEvidence, without] = m.entries.filter((e) => e.type === 'GREENHOUSE_ATS')
    expect(readinessAt(withEvidence!, new Date()).status).toBe('CANDIDATE')
    const r = readinessAt(without!, new Date())
    expect(r.status).toBe('BLOCKED')
    expect(r.blockers.map((b) => b.code)).toEqual(['NO_BOARD_EVIDENCE'])
    expect(r.blockers[0]!.detail).toBe(
      'no capture of this board is committed; its first request is a supervised smoke',
    )
    expect(without!.ownership).toBeNull()
    const snap = buildLedgerCatalogSnapshot(m)
    expect(snap.entries.find((e) => e.id === 'greenhouse.board.airbnb')!.blockerCodes).toEqual([
      'NO_BOARD_EVIDENCE',
    ])
    expect(snap.entries.find((e) => e.id === 'greenhouse.board.stripe')!.blockerCodes).toEqual([])
  })
})

describe('AC 1: the 13 migrated boards are the 13 hand-written ones', () => {
  // An independent table: id, config, zone, host key. Not read from the board files.
  const GH = 'boards-api.greenhouse.io'
  const LA = 'America/Los_Angeles'
  const EXPECTED: ReadonlyArray<readonly [string, object, string, string]> = [
    ['greenhouse.board.stripe', { board: 'stripe' }, LA, GH],
    ['greenhouse.board.airbnb', { board: 'airbnb' }, LA, GH],
    ['greenhouse.board.cloudflare', { board: 'cloudflare' }, LA, GH],
    ['lever.board.spotify', { board: 'spotify' }, 'Europe/Stockholm', 'api.lever.co'],
    [
      'lever.board.eu.siteimprove',
      { board: 'siteimprove', region: 'eu' },
      'Europe/Copenhagen',
      'api.eu.lever.co',
    ],
    ['lever.board.quantco-', { board: 'quantco-' }, 'Europe/Berlin', 'api.lever.co'],
    ['ashby.board.linear', { board: 'linear' }, LA, 'api.ashbyhq.com'],
    ['ashby.board.supabase', { board: 'supabase' }, LA, 'api.ashbyhq.com'],
    [
      'workable.board.huggingface',
      { board: 'huggingface' },
      'America/New_York',
      'apply.workable.com',
    ],
    ['workable.board.hirefellows', { board: 'hirefellows' }, 'Asia/Bahrain', 'apply.workable.com'],
    ['recruitee.board.bunq', { board: 'bunq' }, 'Europe/Amsterdam', 'recruitee.com'],
    [
      'personio.board.westwing',
      { board: 'westwing', language: 'en' },
      'Europe/Berlin',
      'personio.de',
    ],
    [
      'personio.board.personio',
      { board: 'personio', language: 'en' },
      'Europe/Berlin',
      'personio.de',
    ],
  ]
  const entries = () =>
    buildManifest({
      definitions: MANIFEST_DEFINITIONS,
      adapters: MANIFEST_VALIDATION_ADAPTERS,
      fixtureRoot: FIXTURE_ROOT,
    }).entries.filter((e) => e.id.includes('.board.'))

  it('has exactly these ids, in this order, with this zone and host', () => {
    const got = entries().map((e) => [e.id, e.fetchProfile!.window!.timeZone, e.hostKey])
    expect(got).toEqual(EXPECTED.map(([id, , tz, host]) => [id, tz, host]))
  })

  it('keeps each config (less the derived employer) and the 60 / 180 profile', () => {
    for (const e of entries()) {
      const { employer: _employer, ...rest } = e.config as Record<string, unknown>
      expect(rest).toEqual(EXPECTED.find(([id]) => id === e.id)![1])
      expect(e.fetchProfile!.intervalMinutes).toBe(60)
      expect(e.fetchProfile!.offIntervalMinutes).toBe(180)
      expect(e.blockers.map((b) => b.code)).not.toContain('NO_BOARD_EVIDENCE')
    }
  })
})

describe('ADR 8a watchlist arithmetic (documentation, not a production constant)', () => {
  // Owner Q11's 2 requests a minute is a starting value that U11's request-counting host budget owns.
  // Nothing enforces a per-host rate today (no `hostRate` on the board types); this table only pins
  // the ADR's numbers: a sweep takes boards / perMinute minutes.
  it.each([
    [200, 100, 1.7],
    [1000, 500, 8.3],
    [13, 6.5, 0.11],
  ])('%i boards at 2 a minute: a sweep of %f minutes (%f hours)', (boards, minutes, hours) => {
    expect(boards / 2).toBe(minutes)
    expect(minutes / 60).toBeCloseTo(hours, 1)
  })
})

describe('AC 1: ownership of the 13 boards (employer, domain, fixtures)', () => {
  const EXPECTED_OWNERSHIP: ReadonlyArray<readonly [string, string, string | null, string[]]> = [
    ['greenhouse.board.stripe', 'Stripe', 'stripe.com', ['stripe-board.json']],
    ['greenhouse.board.airbnb', 'Airbnb', null, ['airbnb-board.json']],
    ['greenhouse.board.cloudflare', 'Cloudflare', null, ['cloudflare-board.json']],
    ['lever.board.spotify', 'Spotify', null, ['spotify-page1.json', 'spotify-page2.json']],
    ['lever.board.eu.siteimprove', 'Siteimprove', null, ['siteimprove-eu-board.json']],
    ['lever.board.quantco-', 'QuantCo', null, ['quantco-trailing-hyphen-board.json']],
    ['ashby.board.linear', 'Linear', null, ['linear-board.json']],
    ['ashby.board.supabase', 'Supabase', null, ['supabase-board.json']],
    ['workable.board.huggingface', 'Hugging Face', null, ['huggingface-account.json']],
    ['workable.board.hirefellows', 'Hire Fellows', null, ['hirefellows-account.json']],
    ['recruitee.board.bunq', 'bunq', null, ['bunq-offers.json']],
    ['personio.board.westwing', 'Westwing', null, ['westwing-en.xml']],
    ['personio.board.personio', 'Personio', null, ['personio-en.xml']],
  ]
  it('names these employers, domains and captures', () => {
    const got = MANIFEST_DEFINITIONS.flatMap((d) => d.entries)
      .filter((e) => e.id.includes('.board.'))
      .map((e) => [e.id, e.ownership?.name, e.ownership?.domain, e.ownership?.fixtures])
    expect(got).toEqual(EXPECTED_OWNERSHIP.map((r) => [...r]))
  })
})

describe('one employer, one board', () => {
  const claimedGen = (prefix: string, lines: unknown, claimed: Map<string, string>) =>
    boardEntries({ prefix, lines, profileFor: PROFILE, claimed })
  it('refuses the same employer name (any case) under a second provider; a distinct one is fine', () => {
    const claimed = new Map<string, string>()
    claimedGen('greenhouse', [stripe], claimed)
    expect(
      codeOf(() =>
        claimedGen('lever', [{ ...stripe, token: 'x', domain: null, employer: 'STRIPE' }], claimed),
      ),
    ).toBe('DUPLICATE_EMPLOYER')
    expect(
      codeOf(() =>
        claimedGen(
          'lever',
          [{ ...stripe, token: 'x', domain: null, employer: 'Initech' }],
          claimed,
        ),
      ),
    ).toBeUndefined()
  })

  it('says which key repeats and which board holds it', () => {
    const claimed = new Map<string, string>()
    claimedGen('greenhouse', [stripe], claimed)
    expect(() =>
      claimedGen('lever', [{ ...stripe, token: 'x', domain: null, employer: 'STRIPE' }], claimed),
    ).toThrow(
      'DUPLICATE_EMPLOYER: lever.board.x repeats employer:stripe already listed as greenhouse.board.stripe',
    )
  })

  it('refuses the same domain under a second provider; a distinct one is fine', () => {
    const claimed = new Map<string, string>()
    claimedGen('greenhouse', [stripe], claimed)
    expect(
      codeOf(() => claimedGen('ashby', [{ ...stripe, token: 'x', employer: 'Other Co' }], claimed)),
    ).toBe('DUPLICATE_EMPLOYER')
    expect(
      codeOf(() =>
        claimedGen(
          'ashby',
          [{ ...stripe, token: 'x', employer: 'Other Co', domain: 'other.com' }],
          claimed,
        ),
      ),
    ).toBeUndefined()
  })

  it('the 13 current boards trip nothing (the manifest builds)', () => {
    expect(
      codeOf(() =>
        buildManifest({
          definitions: MANIFEST_DEFINITIONS,
          adapters: MANIFEST_VALIDATION_ADAPTERS,
          fixtureRoot: FIXTURE_ROOT,
        }),
      ),
    ).toBeUndefined()
  })
})

describe('stronger evidence rules', () => {
  it.each([
    ['a scheme', 'https://stripe.com'],
    ['a path', 'stripe.com/jobs'],
    ['a port', 'stripe.com:443'],
    ['upper case', 'Stripe.com'],
    ['a single label', 'stripe'],
    ['a leading dot', '.stripe.com'],
  ])('refuses a domain with %s', (_n, domain) => {
    expect(codeOf(() => generate([{ ...stripe, domain }]))).toBe('BOARD_LINE_INVALID')
    expect(codeOf(() => generate([{ ...stripe, domain: 'api.stripe.com' }]))).toBeUndefined()
  })

  it('accepts a one-letter label and refuses a name over 253 characters', () => {
    expect(codeOf(() => generate([{ ...stripe, domain: 'x.io' }]))).toBeUndefined()
    const long = `${`${'a'.repeat(60)}.`.repeat(5)}com`
    expect(long.length).toBeGreaterThan(253)
    expect(codeOf(() => generate([{ ...stripe, domain: long }]))).toBe('BOARD_LINE_INVALID')
  })

  it('refuses an employer shorter than 3 characters; 3 is fine', () => {
    expect(codeOf(() => generate([{ ...stripe, employer: 'ab' }]))).toBe('BOARD_LINE_INVALID')
    expect(codeOf(() => generate([{ ...stripe, employer: 'abc' }]))).toBeUndefined()
  })

  // stripe-board.json's notes name "Stripe" and stripe.com; whole-token matching is what these pin.
  it('an employer that is only part of a word in the notes is refused; the whole word passes', () => {
    expect(codeOf(() => buildWith([{ ...stripe, employer: 'Strip' }]))).toBe(
      'OWNER_NOT_IN_EVIDENCE',
    )
    expect(codeOf(() => buildWith([stripe]))).toBeUndefined()
  })

  it('a domain that is only the tail of another host is refused; the real host passes', () => {
    expect(codeOf(() => buildWith([{ ...stripe, domain: 'ripe.com' }]))).toBe(
      'OWNER_NOT_IN_EVIDENCE',
    )
    expect(codeOf(() => buildWith([stripe]))).toBeUndefined()
  })
})
