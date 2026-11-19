import { interviewStageSchema, type InterviewStage } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import {
  ACTIVE_STAGES,
  ALL_STAGES,
  COLUMN_BG,
  COLUMN_HEADER_BG,
  STAGE_BADGE_COLORS,
  STAGE_COLORS,
  TERMINAL_STAGES,
} from '../constants'

/**
 * The board renders one column per entry of `ACTIVE_STAGES`, in order, and paints every card and
 * column from the four class maps. All of it is plain data, so the failure mode is silent drift:
 * a stage the board never shows, a board order that no longer matches the Postgres
 * `interview_stage` enum (`getNextStage` / `getPrevStage` walk this array, so the order IS the
 * pipeline), or a stage whose hue disagrees between its card border, badge, column header and
 * column background. task-sources-07c added `SUBMITTED` to all five; these assertions are what
 * make that addition observable.
 */

// `border-l-teal-400` / `bg-teal-500/[0.03]` -> `teal`. A Tailwind colour family is always
// followed by its numeric shade — that is what tells it apart from a variant prefix (`border-l-`).
const huesOf = (classes: string): string[] => [
  ...new Set(
    [...classes.matchAll(/-([a-z]+)-\d/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]])),
  ),
]

describe('interview board stage order', () => {
  it('covers every stage of the shared enum, active ones first, in the enum order', () => {
    expect(ALL_STAGES).toEqual(interviewStageSchema.options)
  })

  it('opens the pipeline with SUBMITTED — the column HR fills from the sourcing queue', () => {
    expect(ACTIVE_STAGES[0]).toBe('SUBMITTED')
    expect(TERMINAL_STAGES).not.toContain('SUBMITTED')
  })
})

describe('interview board stage colors', () => {
  const MAPS = {
    STAGE_COLORS,
    STAGE_BADGE_COLORS,
    COLUMN_HEADER_BG,
    COLUMN_BG,
  } satisfies Record<string, Record<InterviewStage, string>>

  it.each(ALL_STAGES)('%s carries one consistent hue across all four maps', (stage) => {
    const hues = Object.entries(MAPS).map(([name, map]) => {
      const found = huesOf(map[stage])
      expect(found, `${name}.${stage} = ${JSON.stringify(map[stage])}`).toHaveLength(1)
      return found.join('+')
    })
    expect(new Set(hues).size, `hues: ${hues.join(', ')}`).toBe(1)
  })
})
