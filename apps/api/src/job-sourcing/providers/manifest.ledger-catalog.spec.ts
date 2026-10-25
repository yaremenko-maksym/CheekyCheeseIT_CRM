import { describe, expect, it } from 'vitest'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import { buildManifest } from './manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from './manifest.adapters'
import { MANIFEST_DEFINITIONS } from './manifest.definitions'
import { buildLedgerCatalog } from './manifest.ledger-catalog'

/**
 * r5 Task 2.5 T3 — the run ledger's catalog over the REAL manifest. Every expected value is a fact
 * read off the manifest definitions (Remotive's documented rate and 6 h floor, JSearch's quota,
 * Jooble's weekly interval, Recruitee's employer-token deadline), written out here as a literal.
 */
const catalog = buildLedgerCatalog(
  buildManifest({
    definitions: MANIFEST_DEFINITIONS,
    adapters: MANIFEST_VALIDATION_ADAPTERS,
    fixtureRoot: FIXTURE_ROOT,
  }),
)
const NOW = new Date('2026-10-25T00:00:00Z')

describe('buildLedgerCatalog', () => {
  it('resolves an entry by its manifest id, with its type, cadence and floor', () => {
    const e = catalog.entry('remotive.api.software-dev')
    expect(e).toMatchObject({
      type: 'REMOTIVE_API',
      quotaDeclared: false,
      intervalHours: 24,
      floorHours: 6,
    })
    expect(e?.activationFacts(NOW)).toEqual({
      readiness: 'CANDIDATE',
      blockerCodes: [],
      payloadVerified: true,
    })
    expect(e?.entryReadiness(NOW)).toBe('CANDIDATE')
  })

  it('an unknown manifest id resolves to nothing', () => {
    expect(catalog.entry('remotive.api.no-such-entry')).toBeUndefined()
  })

  it('a type that declares a quota is marked metered, with its own interval', () => {
    expect(catalog.entry('jsearch.rapidapi.backend')?.quotaDeclared).toBe(true)
    expect(catalog.entry('jooble.api.senior-developer-remote')).toMatchObject({
      quotaDeclared: true,
      intervalHours: 168,
    })
  })

  it('an unverified payload is reported, not hidden', () => {
    expect(catalog.entry('jsearch.rapidapi.backend')?.activationFacts(NOW).payloadVerified).toBe(
      false,
    )
  })

  it('readiness is evaluated at the clock it is given: Recruitee blocks at its 2027-02-10 deadline', () => {
    const e = catalog.entry('recruitee.board.bunq')
    expect(e?.entryReadiness(new Date('2027-02-09T23:59:59Z'))).toBe('CANDIDATE')
    expect(e?.entryReadiness(new Date('2027-02-10T00:00:00Z'))).toBe('BLOCKED')
    expect(e?.activationFacts(new Date('2027-02-10T00:00:00Z')).readiness).toBe('BLOCKED')
    expect(e?.activationFacts(new Date('2027-02-10T00:00:00Z')).blockerCodes).toEqual([
      'AUTH_DEADLINE_PASSED',
    ])
  })

  it('the host policy is the manifest`s merged policy of the key, never a caller`s', () => {
    expect(catalog.hostPolicy('remotive.com')).toEqual({
      rate: { perMinute: 2, perDay: 4 },
      floorHours: 6,
    })
    expect(catalog.hostPolicy('www.arbeitnow.com')).toEqual({ rate: null, floorHours: 0 })
    expect(catalog.hostPolicy('unknown.example')).toBeUndefined()
  })
})
