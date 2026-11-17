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

// Mutable so a test can make the gate throw something that is NOT the per-record refusal, or refuse
// every record. Both default off, so the other tests see the real gate.
const gateOverride: { error: Error | null; refuseAll: boolean } = { error: null, refuseAll: false }

vi.mock('../store/record-payload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/record-payload')>()
  return {
    ...actual,
    validateObservation: (o: SourceObservation) => {
      if (gateOverride.error !== null) throw gateOverride.error
      if (gateOverride.refuseAll || o.identity.nativeId === REFUSED)
        throw new RangeError('validateObservation: description over the display limit')
      actual.validateObservation(o)
    },
  }
})

const NOW = new Date('2026-10-24T03:00:00Z')

afterEach(() => {
  gateOverride.error = null
  gateOverride.refuseAll = false
})

describe('a run whose every record the store refuses', () => {
  it('ends PARTIAL with a PERSISTENCE report, never SUCCEEDED, and stores no validator', async () => {
    gateOverride.refuseAll = true
    const authentic = sourceFixture('arbeitnow', 'page-1') as Record<string, unknown>
    const body = { ...authentic, links: { ...(authentic['links'] as object), next: null } }
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ status: 200, bodyText: JSON.stringify(body) }],
    })
    const observeSinglePage = vi.fn()
    const batch = await arbeitnowProvider.collectReport(
      arbeitnowProvider.parseConfig({ configVersion: 1 }),
      { ...f.ctx, observeSinglePage },
    )
    expect(batch.outcome).not.toBe('SUCCEEDED')
    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.observations).toHaveLength(0)
    expect(batch.counts.normalized).toBe(0)
    expect(batch.counts.invalid).toBe(7)
    expect(batch.requests.at(-1)?.error?.code).toBe('PERSISTENCE')
    expect(batch.requests.at(-1)?.error?.message).toBe(
      'the store refused 7 observation(s), the last on page 1; none was stored',
    )
    expect(observeSinglePage).not.toHaveBeenCalled()
  })

  it('a run that stored nothing and then failed keeps its own failure, with no added PERSISTENCE report', async () => {
    gateOverride.refuseAll = true
    const authentic = sourceFixture('arbeitnow', 'page-1') as Record<string, unknown>
    const f = fakeCollectionContext({
      now: NOW,
      responses: [
        { status: 200, bodyText: JSON.stringify(authentic) },
        { status: 503, bodyText: '' },
      ],
    })
    const batch = await arbeitnowProvider.collectReport(
      arbeitnowProvider.parseConfig({ configVersion: 1 }),
      f.ctx,
    )
    expect(batch.observations).toHaveLength(0)
    expect(batch.requests.some((r) => r.error?.code === 'PERSISTENCE')).toBe(false)
    expect(batch.requests.at(-1)?.status).toBe(503)
  })

  it('a clean page that carries no items at all is still SUCCEEDED, not a refusal', async () => {
    const authentic = sourceFixture('arbeitnow', 'page-1') as Record<string, unknown>
    const body = {
      ...authentic,
      data: [],
      links: { ...(authentic['links'] as object), next: null },
    }
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ status: 200, bodyText: JSON.stringify(body) }],
    })
    const batch = await arbeitnowProvider.collectReport(
      arbeitnowProvider.parseConfig({ configVersion: 1 }),
      f.ctx,
    )
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts.invalid).toBe(0)
    expect(batch.requests.some((r) => r.error?.code === 'PERSISTENCE')).toBe(false)
  })
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
