import { describe, expect, it } from 'vitest'
import { SMARTRECRUITERS_BOARDS } from './smartrecruiters.boards'

/**
 * The SmartRecruiters watchlist, pinned where it can actually be READ.
 *
 * `manifest.boards.spec.ts` asserts what the generator makes of these lines, and that is the
 * behavioural check - but it cannot report a change to the lines themselves. Board lines are
 * validated at module load (`manifest.definitions.ts` calls `boardEntries` at module scope), so a
 * line that is no longer valid throws while that spec is still being COLLECTED, and a spec that
 * never collected reports no failing test. Measured on this file: the mutation gate recorded 14 of
 * its 15 mutants `Survived` with `testsCompleted: 0`, and the one exception was the only mutant
 * whose result is still a valid board list (the whole array emptied), which collected and died.
 *
 * This spec imports the board lines and NOTHING else, so it collects whatever value they take and
 * fails as a test instead of as a crash.
 */
describe('SMARTRECRUITERS_BOARDS', () => {
  it('is exactly these two boards, field for field', () => {
    expect(SMARTRECRUITERS_BOARDS).toEqual([
      {
        token: 'ubisoft2',
        employer: 'Ubisoft',
        domain: null,
        timeZone: 'Europe/Paris',
        addedBy: 'manual',
        evidence: ['ubisoft2-postings-list.json'],
      },
      {
        token: 'smartrecruiters',
        employer: 'SmartRecruiters Inc',
        domain: null,
        timeZone: 'America/Los_Angeles',
        addedBy: 'manual',
        evidence: ['postings-list.json'],
      },
    ])
  })
})
