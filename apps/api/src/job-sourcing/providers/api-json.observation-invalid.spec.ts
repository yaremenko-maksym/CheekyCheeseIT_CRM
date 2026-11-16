import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeCollectionContext } from '../../test/fake-collection-context'
import { sourceFixture } from '../../test/source-fixtures'
import type { SourceObservation } from '../normalize/observation'
import { arbeitnowProvider } from './sources/arbeitnow.provider'

/**
 * The api-json loop asks the store's own observation check before it hands a page over, so ONE
 * record the store would refuse is one `invalid` item, not a PERSISTENCE failure of the whole run
 * (prod ARBEITNOW 2026-11-16). The builder already satisfies the check for every input this repo
 * knows, so the refusal is forced here: the seam is the store gate itself.
 */

const REFUSED = 'inside-solutions-engineer-454685'

// Mutable so one test can make the gate throw something that is NOT the per-record refusal.
const gateOverride: { error: Error | null } = { error: null }

vi.mock('../store/record-payload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/record-payload')>()
  return {
    ...actual,
    validateObservation: (o: SourceObservation) => {
      if (gateOverride.error !== null) throw gateOverride.error
      if (o.identity.nativeId === REFUSED)
        throw new RangeError('validateObservation: description over the display limit')
      actual.validateObservation(o)
    },
  }
})

const NOW = new Date('2026-10-24T03:00:00Z')

afterEach(() => {
  gateOverride.error = null
})

describe('a non-RangeError from the store gate', () => {
  it('propagates instead of being counted as one invalid record', async () => {
    gateOverride.error = new Error('boom: not a per-record refusal')
    const authentic = sourceFixture('arbeitnow', 'page-1') as Record<string, unknown>
    const body = { ...authentic, links: { ...(authentic['links'] as object), next: null } }
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ status: 200, bodyText: JSON.stringify(body) }],
    })
    await expect(
      arbeitnowProvider.collectReport(arbeitnowProvider.parseConfig({ configVersion: 1 }), f.ctx),
    ).rejects.toThrow('boom: not a per-record refusal')
  })
})

describe('a record the store gate refuses', () => {
  it('is counted invalid and skipped with a sample; the other six persist and the run succeeds', async () => {
    const authentic = sourceFixture('arbeitnow', 'page-1') as Record<string, unknown>
    const body = { ...authentic, links: { ...(authentic['links'] as object), next: null } }
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ status: 200, bodyText: JSON.stringify(body) }],
    })
    const batch = await arbeitnowProvider.collectReport(
      arbeitnowProvider.parseConfig({ configVersion: 1 }),
      f.ctx,
    )
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts).toEqual({
      raw: 7,
      normalized: 6,
      invalid: 1,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.observations.map((o) => o.identity.nativeId)).not.toContain(REFUSED)
    expect(batch.invalidSamples.map((s) => s.reason)).toEqual([
      'OBSERVATION_INVALID: validateObservation: description over the display limit',
    ])
  })
})
