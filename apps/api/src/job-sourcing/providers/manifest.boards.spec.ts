import { describe, expect, it } from 'vitest'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import { buildManifest, ManifestError, readinessAt } from './manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from './manifest.adapters'
import { boardEntries, HOST_REQUESTS_PER_MINUTE, hostSweep } from './manifest.boards'
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

describe('AC (e): the watchlist arithmetic at scale (owner, Q11: 2 requests a minute per host)', () => {
  it('the decided budget is 2 a minute', () => {
    expect(HOST_REQUESTS_PER_MINUTE).toBe(2)
  })

  it('200 boards: a sweep of 100 minutes, a board asked every 1.7 hours', () => {
    const s = hostSweep(200, HOST_REQUESTS_PER_MINUTE)
    expect(s.sweepMinutes).toBe(100)
    expect(s.intervalHours).toBeCloseTo(1.7, 1)
  })

  it('1,000 boards: a sweep of 500 minutes, a board asked every 8.3 hours', () => {
    const s = hostSweep(1000, HOST_REQUESTS_PER_MINUTE)
    expect(s.sweepMinutes).toBe(500)
    expect(s.intervalHours).toBeCloseTo(8.3, 1)
  })

  it('13 boards fit the hourly profile: the budget does not stretch the interval', () => {
    const s = hostSweep(13, HOST_REQUESTS_PER_MINUTE)
    expect(s.sweepMinutes).toBe(6.5)
    expect(s.effectiveIntervalMinutes(60)).toBe(60)
    expect(hostSweep(200, 2).effectiveIntervalMinutes(60)).toBe(100)
  })

  it('refuses a budget that is not positive', () => {
    expect(() => hostSweep(10, 0)).toThrow('hostSweep: the budget must be positive')
    expect(() => hostSweep(10, Number.NaN)).toThrow(RangeError)
  })
})
