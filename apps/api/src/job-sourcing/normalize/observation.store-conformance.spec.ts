import { jobSourceIdentitySchema, jobSourceRevisionSchema } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { MAX_IDENTITY_KEY_CHARS } from './identity-key'
import { MAX_LINK_CHARS } from './url-policy'
import {
  buildSourceObservation,
  MAX_VERSION_CHARS,
  type RawObservationFields,
  type SourceObservation,
  toStoredIdentity,
  toStoredRevisionFields,
} from './observation'

/**
 * The test this PR was missing. Phase 1's store schemas shipped and are in production; task 2.1
 * produces the values they consume. Nothing crossed the boundary, so the producer emitted an
 * identity kind the consumer's enum rejects, an identity key past its 2048 cap and an
 * `adapterVersion` the empty string satisfied — three defects, each invisible to a test that only
 * ever looked at one side.
 *
 * So: build observations through `buildSourceObservation` and run the results through the REAL
 * phase-1 schemas with `.parse()`. The store is the authority here — it has rows — so conformance
 * means task 2.1 moves, never the schema.
 *
 * The ids, arrival order and blob keys below are the collector's to supply and are literals on
 * purpose: this file pins the fields an observation OWNS, and faking the rest is how the row
 * becomes parseable at all.
 */

const COLLECTOR_SUPPLIED = {
  id: '11111111-1111-4111-8111-111111111111',
  sourceRecordId: '22222222-2222-4222-8222-222222222222',
  descriptionSha256: null,
  publishedAtRaw: null,
  fieldProvenance: {},
  receivedSeq: 1,
  receivedAt: '2026-10-20T10:00:00.000Z',
} as const

function raw(overrides: Partial<RawObservationFields> = {}): RawObservationFields {
  return {
    // Not cast to `JobSourceType`: an `as` here would hide exactly the kind of mismatch this file
    // exists to catch (the first draft said `'DOU'`, which is not a member, and only vitest noticed).
    provider: 'DOU_RSS',
    namespace: 'dou.ua',
    url: 'https://jobs.dou.ua/companies/acme/vacancies/12345/',
    title: 'Senior TypeScript Engineer',
    companyName: 'Acme',
    adapterVersion: 'dou-1.0.0',
    ...overrides,
  }
}

function built(overrides: Partial<RawObservationFields> = {}): SourceObservation {
  const result = buildSourceObservation(raw(overrides))
  if (!result.ok) throw new Error(`expected an observation, got quarantine: ${result.reason}`)
  return result.observation
}

/** Parses both projections of one observation through the store's own schemas. */
function parseThroughStore(observation: SourceObservation) {
  const identity = jobSourceIdentitySchema.parse(toStoredIdentity(observation.identity))
  const revision = jobSourceRevisionSchema.parse({
    ...COLLECTOR_SUPPLIED,
    ...toStoredRevisionFields(observation),
  })
  return { identity, revision }
}

describe('a built observation is accepted by the phase-1 store schemas', () => {
  it('parses an ordinary observation through both schemas', () => {
    const { identity, revision } = parseThroughStore(built())
    expect(identity.identityKind).toBe('URL_FALLBACK')
    expect(revision.adapterVersion).toBe('dou-1.0.0')
  })

  it('parses the native-id variant, whose identity kind is the OTHER enum member', () => {
    const { identity } = parseThroughStore(built({ nativeId: '12345' }))
    // The whole class of defect: a local `'NATIVE' | 'URL'` vocabulary parsed here as nothing.
    expect(identity.identityKind).toBe('NATIVE_ID')
  })

  it('every identity kind the builder can emit is a member of the store enum', () => {
    // Stated over the enum rather than over two examples, so adding a third kind on either side
    // without the other fails here.
    const kinds = new Set(
      [built(), built({ nativeId: '12345' })].map((o) => o.identity.identityKind),
    )
    expect([...kinds].sort()).toEqual(['NATIVE_ID', 'URL_FALLBACK'])
    for (const kind of kinds) {
      expect(() =>
        jobSourceIdentitySchema.parse({
          ...toStoredIdentity(built().identity),
          identityKind: kind,
        }),
      ).not.toThrow()
    }
  })

  it('parses an observation carrying every optional field the store holds', () => {
    const { revision } = parseThroughStore(
      built({
        location: 'Kyiv',
        description: '<p>Build things.</p>',
        descriptionKind: 'html',
        applicationUrl: 'https://apply.example/j/1',
        tags: ['typescript', 'nestjs'],
        dates: [{ semantics: 'PUBLISHED', raw: '2026-10-01T00:00:00.000Z' }],
      }),
    )
    expect(revision.location).toBe('Kyiv')
    expect(revision.applicationUrl).toBe('https://apply.example/j/1')
    expect(revision.publishedAt).toBe('2026-10-01T00:00:00.000Z')
  })
})

describe('at each boundary the store imposes (every one of these once produced an unstorable row)', () => {
  it('CR-H-1: a maximal URL-fallback identity key is at or under the store cap', () => {
    // The measured defect: a 2040-character URL under a 100-character namespace encoded to a
    // 2171-character key, and the observation reported ok: true. Nothing may now report success
    // with a key the store refuses, so the builder either produces a storable key or quarantines.
    const namespace = 'n'.repeat(100)
    // Per input: the quarantine reason, or the key length of a row the store then parses. Collected
    // and asserted in one shot, so neither outcome can slip through as an un-run branch.
    const outcomes = [1900, 1980, 2000, 2020, MAX_LINK_CHARS - 22].map((pathLength) => {
      const url = `https://jobs.example/${'p'.repeat(pathLength)}`
      const result = buildSourceObservation(raw({ namespace, url }))
      if (!result.ok) return { pathLength, reason: result.reason }
      parseThroughStore(result.observation)
      return { pathLength, keyLength: result.observation.identity.identityKey.length }
    })
    expect(outcomes.filter((o) => 'reason' in o && o.reason !== 'IDENTITY_TOO_LONG')).toEqual([])
    expect(
      outcomes.filter((o) => 'keyLength' in o && o.keyLength > MAX_IDENTITY_KEY_CHARS),
    ).toEqual([])
    // Both outcomes must actually occur in this range, or the test would pass vacuously.
    expect(outcomes.some((o) => 'reason' in o)).toBe(true)
    expect(outcomes.some((o) => 'keyLength' in o)).toBe(true)
  })

  it('CR-H-1: the longest key the builder will emit still parses, one character longer does not', () => {
    // Binds MAX_IDENTITY_KEY_CHARS to the schema instead of trusting two literals to match: a key
    // of exactly the cap parses and a key one longer is refused, both decided by the schema itself.
    const atCap = 'k'.repeat(MAX_IDENTITY_KEY_CHARS)
    const base = toStoredIdentity(built())
    expect(() => jobSourceIdentitySchema.parse({ ...base, identityKey: atCap })).not.toThrow()
    expect(() => jobSourceIdentitySchema.parse({ ...base, identityKey: `${atCap}x` })).toThrow()
  })

  it('CR-H-1: a maximal NATIVE_ID key is storable, which is why that branch has no length check', () => {
    const { identity } = parseThroughStore(
      built({ namespace: 'n'.repeat(128), nativeId: 'i'.repeat(256) }),
    )
    expect(identity.identityKey.length).toBeLessThanOrEqual(MAX_IDENTITY_KEY_CHARS)
  })

  it('CR-M-4: an adapterVersion at the store bound parses, and empty or over-long is quarantined', () => {
    const { revision } = parseThroughStore(built({ adapterVersion: 'v'.repeat(MAX_VERSION_CHARS) }))
    expect(revision.adapterVersion).toHaveLength(MAX_VERSION_CHARS)
    for (const bad of ['', '   ', 'v'.repeat(MAX_VERSION_CHARS + 1)]) {
      const result = buildSourceObservation(raw({ adapterVersion: bad }))
      expect(result.ok ? 'ACCEPTED' : result.reason, JSON.stringify(bad.slice(0, 8))).toBe(
        'INVALID_ADAPTER_VERSION',
      )
    }
  })

  it('CR-M-4: normalizerVersion is within the same bound the store applies to it', () => {
    const { revision } = parseThroughStore(built())
    expect(revision.normalizerVersion.length).toBeGreaterThan(0)
    expect(revision.normalizerVersion.length).toBeLessThanOrEqual(MAX_VERSION_CHARS)
  })

  it('SR-M-1: an applicationUrl that would serialise past the store cap is never stored', () => {
    // `externalHttpsUrlSchema` caps at 2048. The raw text was 2014 characters and the stored
    // `href` 12014, so this row was built ok and refused at persistence.
    const observation = built({
      applicationUrl: `https://apply.example/${'й'.repeat(2000)}`,
    })
    expect(observation.applicationUrl).toBeNull()
    expect(observation.evidence).toEqual([
      { field: 'applicationUrl', kind: 'REJECTED_LINK', detail: 'TOO_LONG' },
    ])
    parseThroughStore(observation)
  })

  it('SR-M-1: an applicationUrl just inside the cap is kept and parses', () => {
    const url = `https://apply.example/${'a'.repeat(MAX_LINK_CHARS - 'https://apply.example/'.length)}`
    expect(url).toHaveLength(MAX_LINK_CHARS)
    const { revision } = parseThroughStore(built({ applicationUrl: url }))
    expect(revision.applicationUrl).toBe(url)
  })

  it('SR-H-1: a posting URL that folds into an address never reaches the store', () => {
    for (const url of ['https://2852039166../x', 'https://0xa9fea9fe../x', 'https://127.1../x']) {
      const result = buildSourceObservation(raw({ url }))
      expect(result.ok ? 'ACCEPTED' : result.reason, url).toBe('NO_IDENTITY')
    }
  })

  it('the display fields sit inside the store column widths at their own maxima', () => {
    const { revision } = parseThroughStore(
      built({
        title: 'T'.repeat(5_000),
        companyName: 'C'.repeat(5_000),
        location: 'L'.repeat(5_000),
      }),
    )
    expect(revision.title).toHaveLength(500)
    expect(revision.companyName).toHaveLength(255)
    expect(revision.location).toHaveLength(500)
  })

  it('the content hash is the 64 lowercase hex characters the store demands', () => {
    const { revision } = parseThroughStore(built())
    expect(revision.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })
})
