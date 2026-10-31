import { describe, expect, it, vi } from 'vitest'
import type { NormalizedPosting } from '../job-source.provider'
import { LEGACY_RUN_ADAPTER_VERSION } from '../ownership/legacy-run-claim'
import type { BridgeRun } from './bridge-delivery'
import { douCheckpoint, mapDouObservations, storeObservations } from './dou-store'

function douPosting(over: Partial<NormalizedPosting> = {}): NormalizedPosting {
  return {
    sourceType: 'DOU_RSS',
    externalId: 'https://jobs.dou.ua/x/',
    url: 'https://jobs.dou.ua/x/',
    title: 'Senior Engineer',
    companyName: 'Acme',
    companyNameNormalized: 'acme',
    location: 'Kyiv',
    descriptionMd: 'desc',
    publishedAt: new Date('2026-10-30T08:00:00.000Z'),
    fingerprint: 'fp-x',
    ...over,
  }
}

const RUN = {
  handle: { runId: 'r', ownerToken: 't', fencingEpoch: 1 },
  sourceId: 's',
  sourceType: 'DOU_RSS',
} as unknown as BridgeRun

describe('douCheckpoint', () => {
  it('is the fixed DOU full-feed marker', () => {
    expect(douCheckpoint()).toEqual({
      configVersion: 1,
      policyVersion: 1,
      adapterVersion: LEGACY_RUN_ADAPTER_VERSION,
      position: { kind: 'CURSOR', page: 1, cursor: 'dou-full-feed' },
      completedAt: expect.any(Date),
    })
  })
})

describe('mapDouObservations', () => {
  it('maps a valid posting to one observation, counting none refused', () => {
    const { observations, refused } = mapDouObservations([douPosting()])
    expect(observations).toHaveLength(1)
    expect(refused).toBe(0)
    expect(observations[0]!.identity.provider).toBe('DOU_RSS')
  })

  it('skips an item the validator refuses and counts it in refused', () => {
    const { observations, refused } = mapDouObservations([douPosting({ title: '' })])
    expect(observations).toHaveLength(0)
    expect(refused).toBe(1)
  })

  it('separates valid and refused in a mixed batch', () => {
    const { observations, refused } = mapDouObservations([
      douPosting(),
      douPosting({ title: '', url: 'https://jobs.dou.ua/y/', fingerprint: 'fp-y' }),
    ])
    expect(observations).toHaveLength(1)
    expect(refused).toBe(1)
  })
})

describe('storeObservations (DB-free paths)', () => {
  it('an empty page writes nothing and logs nothing', async () => {
    const log = vi.fn()
    const db = {} as never // never touched: observations are empty, so it returns before the store
    await storeObservations(db, RUN, [], log)
    expect(log).not.toHaveBeenCalled()
  })

  it('a batch where every item is refused logs the skip count and does not reach the store', async () => {
    const log = vi.fn()
    const db = {} as never
    await storeObservations(db, RUN, [douPosting({ title: '' })], log)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![0]).toContain('skipped 1')
  })
})
