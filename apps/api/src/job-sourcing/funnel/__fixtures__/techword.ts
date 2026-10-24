import type { SeniorTechProfile } from '../tech-match'

/**
 * The "techword" fixture — the open r4 case (plan r5 C-25), now named in the repo.
 *
 * Three profiles of 50 distinct keywords each (`techword0`..`techword149`). Every
 * profile is under the per-profile cap of 60, yet the roster union is 150, so a
 * union that was re-capped at 60 would lose `techword75` and `techword149`.
 * The posting mentions exactly `techword149`, `techword0` and `techword75`, one
 * per profile.
 */
export const TECHWORD_COUNT = 150
export const TECHWORD_PER_PROFILE = 50

export const TECHWORD_SENIOR_IDS = [
  '00000000-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-0000000000a2',
  '00000000-0000-4000-8000-0000000000a3',
] as const

export const TECHWORD_TEAM_ID = '00000000-0000-4000-8000-0000000000f1'

export function techwordProfiles(): SeniorTechProfile[] {
  return TECHWORD_SENIOR_IDS.map((seniorId, p) => ({
    seniorId,
    teamIds: [TECHWORD_TEAM_ID],
    techStack: Array.from(
      { length: TECHWORD_PER_PROFILE },
      (_, i) => `techword${p * TECHWORD_PER_PROFILE + i}`,
    ),
  }))
}

export const TECHWORD_POSTING_BODY =
  'Requirements:\nWe use techword149 every day.\nAlso techword0 and techword75.'
