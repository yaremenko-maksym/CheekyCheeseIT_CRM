import { describe, expect, it } from 'vitest'

/**
 * `manifest.definitions.ts` builds its board entries AT MODULE SCOPE - `boardEntries(...)` is called
 * inside the definition literal - and `boardEntries` refuses a malformed argument by throwing. A
 * change to that argument is therefore not a wrong value some spec can read: it is a module that no
 * longer imports, and every spec importing it statically fails while being COLLECTED. A spec that
 * never collected completes no test, and the mutation gate records that as a survivor nothing ran
 * (measured on this PR: `entries: boardEntries({})` ran zero tests across the whole suite, twice).
 *
 * This file imports the module INSIDE the test body instead. The same breakage then arrives as a
 * rejected import in a test that did run, and a failing test is a verdict the gate can read.
 * It must stay free of any STATIC import of `manifest.definitions`, directly or through a barrel.
 */
describe('manifest.definitions imports', () => {
  it('builds the SmartRecruiters board entries from its watchlist, prefix and board profile', async () => {
    const { MANIFEST_DEFINITIONS } = await import('./manifest.definitions')
    const sr = MANIFEST_DEFINITIONS.find((d) => d.type === 'SMARTRECRUITERS_ATS')!

    const profile = (timeZone: string) => ({
      intervalMinutes: 60,
      offIntervalMinutes: 180,
      window: {
        timeZone,
        days: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        from: '08:00',
        to: '19:00',
      },
    })
    expect(sr.entries).toEqual([
      {
        id: 'smartrecruiters.board.ubisoft2',
        config: { board: 'ubisoft2' },
        fetchProfile: profile('Europe/Paris'),
        ownership: { fixtures: ['ubisoft2-postings-list.json'], name: 'Ubisoft', domain: null },
      },
      {
        id: 'smartrecruiters.board.smartrecruiters',
        config: { board: 'smartrecruiters' },
        fetchProfile: profile('America/Los_Angeles'),
        ownership: {
          fixtures: ['postings-list.json'],
          name: 'SmartRecruiters Inc',
          domain: null,
        },
      },
    ])
  })
})
