import { describe, expect, it, vi } from 'vitest'

const { normalizer } = vi.hoisted(() => ({ normalizer: vi.fn() }))
vi.mock('./build-posting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./build-posting')>()),
  buildNormalizedPosting: normalizer,
}))

import { buildSourceObservation, type RawObservationFields } from './observation'

const raw: RawObservationFields = {
  provider: 'REED_API',
  namespace: 'reed-uk',
  nativeId: '555',
  url: 'https://www.reed.co.uk/jobs/dev/555',
  title: 'Backend Developer',
  companyName: 'Acme Ltd',
  adapterVersion: 'reed@1',
}

/**
 * Every input that reaches `buildNormalizedPosting` has already passed the link, title and company
 * checks, so no real input makes it return null today. Its contract still is "null means skip", and
 * the builder must turn that into a quarantine rather than dereference it. The seam is the
 * normalizer's documented null return, so the test fakes exactly that.
 */
describe('INVALID_RECORD: the normalizer declines a record', () => {
  it('a null normalized posting is quarantined as INVALID_RECORD', () => {
    normalizer.mockReturnValue(null)
    expect(buildSourceObservation(raw, { now: new Date('2026-10-20T12:00:00Z') })).toEqual({
      ok: false,
      reason: 'INVALID_RECORD',
    })
  })
})
