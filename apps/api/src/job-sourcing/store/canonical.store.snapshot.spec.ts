import { describe, expect, it } from 'vitest'
import { snapshotOf } from './canonical.store'

/**
 * `snapshotOf` is the only joint between a stored `normalized` payload and the canonical plan, and
 * the employer-withheld marker (backlog 309) crosses exactly here. The real round-trip is in
 * `./canonical.store.integration.spec.ts`; this spec is what the mutation gate can execute.
 */
const row = (normalized: Record<string, unknown>) => ({
  record_id: '11111111-1111-4111-8111-111111111111',
  revision_id: '22222222-2222-4222-8222-222222222222',
  received_seq: 7,
  received_at: new Date('2026-11-19T10:00:00.000Z'),
  source_type: 'DJINNI_RSS',
  namespace: 'djinni:rust',
  source_url: 'https://djinni.co/jobs/853129-rust-developer',
  application_url: null,
  description_sha256: null,
  original_identity: { nativeId: '853129' },
  normalized: { title: 'Rust Developer', companyName: '', ...normalized },
})

describe('snapshotOf: the employer-withheld marker (backlog 309)', () => {
  it('carries the marker when the payload says the employer is withheld at the source', () => {
    const s = snapshotOf(row({ employerDisclosure: 'WITHHELD_AT_SOURCE' }))
    expect(s.employerWithheldAtSource).toBe(true)
    expect(s.companyName).toBe('')
  })

  it('leaves the key off a payload with no disclosure marker', () => {
    const s = snapshotOf(row({ companyName: 'ZentixSoft' }))
    expect('employerWithheldAtSource' in s).toBe(false)
    expect(s.companyName).toBe('ZentixSoft')
  })

  it('leaves the key off any OTHER string in that field: only the one reason is the marker', () => {
    for (const value of ['', 'WITHHELD', 'NO_CLAIMS', 'withheld_at_source']) {
      expect('employerWithheldAtSource' in snapshotOf(row({ employerDisclosure: value }))).toBe(
        false,
      )
    }
  })
})

describe('snapshotOf: the stated salary (sources-17)', () => {
  const salary = { min: 4000, max: 5500, currency: 'EUR', period: 'MONTH' }

  it('reads a stored salary', () => {
    expect(snapshotOf(row({ salary })).salary).toEqual(salary)
  })

  it('reads no salary as null', () => {
    expect(snapshotOf(row({})).salary).toBeNull()
  })

  it('re-validates the stored value: a malformed one is null, never cast through', () => {
    for (const bad of [{ ...salary, min: 6000 }, { ...salary, currency: 'euro' }, 'EUR 4000', 42])
      expect(snapshotOf(row({ salary: bad })).salary).toBeNull()
  })
})

describe('snapshotOf: the observation interval (sources-18)', () => {
  it('carries first_seen_at and last_observed_at as instants', () => {
    const s = snapshotOf({
      ...row({}),
      first_seen_at: '2026-11-01T00:00:00.000Z',
      last_observed_at: new Date('2026-11-03T00:00:00.000Z'),
    })
    expect(s.firstSeenAt).toEqual(new Date('2026-11-01T00:00:00.000Z'))
    expect(s.lastObservedAt).toEqual(new Date('2026-11-03T00:00:00.000Z'))
  })

  it('leaves both keys off a row that does not carry them', () => {
    const s = snapshotOf({ ...row({}), first_seen_at: null })
    expect('firstSeenAt' in s).toBe(false)
    expect('lastObservedAt' in s).toBe(false)
  })
})
