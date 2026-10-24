import { describe, expect, it } from 'vitest'
import {
  HN_OWNER_DECISION,
  JOBGETHER_OWNER_DECISION,
  REMOTIVE_OWNER_DECISION,
  SMARTRECRUITERS_OWNER_DECISION,
  WORKABLE_OWNER_DECISION,
  type OwnerDecision,
} from './owner-decisions'

/**
 * Task 2.5 T2 / PR #1139 delta LOW 1: an adapter armed by an owner decision must not be re-armed
 * or disarmed by mutating the shared object at runtime. The file is an ES module, so the
 * assignments below run in strict mode and a write to a frozen object THROWS instead of being
 * silently ignored.
 */
const DECISIONS: readonly (readonly [string, OwnerDecision])[] = [
  ['HN_OWNER_DECISION', HN_OWNER_DECISION],
  ['REMOTIVE_OWNER_DECISION', REMOTIVE_OWNER_DECISION],
  ['JOBGETHER_OWNER_DECISION', JOBGETHER_OWNER_DECISION],
  ['SMARTRECRUITERS_OWNER_DECISION', SMARTRECRUITERS_OWNER_DECISION],
  ['WORKABLE_OWNER_DECISION', WORKABLE_OWNER_DECISION],
]

describe('owner decisions are frozen', () => {
  it.each(DECISIONS)('%s is frozen', (_name, decision) => {
    expect(Object.isFrozen(decision)).toBe(true)
  })

  it.each(DECISIONS)(
    '%s: writing a field throws in strict mode and leaves it unchanged',
    (_name, d) => {
      const before = { ...d }
      expect(() => {
        ;(d as { decision: string }).decision = 'INFORMATIONAL'
      }).toThrow(TypeError)
      expect(() => {
        ;(d as { endpointVariant: string }).endpointVariant = 'somewhere-else'
      }).toThrow(TypeError)
      expect({ ...d }).toEqual(before)
    },
  )

  it('adding a property throws too', () => {
    expect(() => {
      ;(SMARTRECRUITERS_OWNER_DECISION as unknown as { extra: string }).extra = 'x'
    }).toThrow(TypeError)
  })
})
