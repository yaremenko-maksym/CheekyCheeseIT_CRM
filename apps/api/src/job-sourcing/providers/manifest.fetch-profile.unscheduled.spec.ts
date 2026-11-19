import { describe, expect, it, vi } from 'vitest'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import type { FetchProfile } from '../scheduling/next-slot'
import { buildManifest, ManifestError, type TypeDefinition } from './manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from './manifest.adapters'
import { MANIFEST_DEFINITIONS } from './manifest.definitions'

/**
 * The `UNSCHEDULED_TYPES` guard (owner, Q8), kept observable after task sources-04 emptied the list.
 *
 * SmartRecruiters was its last member, and connecting it left the production manifest with no
 * unscheduled type at all — so the three rules below have nothing to fire on in the sibling spec,
 * and a rule nothing can fire on reads exactly like a rule that works. The list is mocked to hold
 * one type here, which is the only thing this file does differently: everything else is the real
 * definitions, the real adapters and the real fixtures.
 *
 * The type is named once, below. When the next accepted-risk type is held back, it goes into the
 * production list and this file needs no change.
 */
vi.mock('./manifest.fetch-profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./manifest.fetch-profile')>()),
  UNSCHEDULED_TYPES: ['SMARTRECRUITERS_ATS'],
}))

const UNSCHEDULED = 'SMARTRECRUITERS_ATS'
const build = (type?: string, edit: (d: TypeDefinition) => TypeDefinition = (d) => d) =>
  buildManifest({
    definitions: MANIFEST_DEFINITIONS.map((d) => (d.type === type ? edit(d) : d)),
    adapters: MANIFEST_VALIDATION_ADAPTERS,
    fixtureRoot: FIXTURE_ROOT,
  })
/** Replaces the type default with `p` and drops every entry's own profile. */
const withProfile = (p: unknown) =>
  build(UNSCHEDULED, (d) => ({
    ...d,
    fetchProfile: p as FetchProfile,
    entries: d.entries.map((e) => ({ ...e, fetchProfile: undefined })),
  }))
const thrown = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return e instanceof ManifestError ? e.message : `OTHER: ${String(e)}`
  }
  return null
}

describe('an unscheduled type (owner, Q8) takes a null profile, and nothing else', () => {
  it('an entry of it may not carry a profile — not even the one its own board file gives it', () => {
    // The real entries of the mocked-unscheduled type, untouched: `boardEntries` gives each board
    // the working-hours profile, which is exactly what this guard refuses.
    expect(thrown(() => build())).toBe(
      'FETCH_PROFILE_INVALID: smartrecruiters.board.ubisoft2: an unscheduled type (owner, Q8) takes a null profile',
    )
  })
  it('its type default may not be non-null either', () => {
    const daily = { intervalMinutes: 1440, offIntervalMinutes: null, window: null }
    expect(thrown(() => withProfile(daily))).toBe(
      'FETCH_PROFILE_INVALID: SMARTRECRUITERS_ATS: its default profile',
    )
  })
  it('with a null default and no entry profile the build passes, and every entry resolves to null', () => {
    const m = withProfile(null)
    const entries = m.entries.filter((e) => e.type === UNSCHEDULED)
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.map((e) => e.fetchProfile)).toEqual(entries.map(() => null))
  })
})
