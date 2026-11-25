import { describe, expect, it } from 'vitest'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import { isNonItTitle } from './non-it-title'

const NON_IT_TITLE = 'Exclusive Mandate: Strategic Sales Director Telco'
const ONE_MB = 1_000_000

describe('isNonItTitle', () => {
  it('classifies the stored prefix of a long title: a NON_IT signal past the cap does not count', () => {
    // The stored title is the first ORIGINAL_LIMITS.title characters; the bare "sales" signal lies beyond
    // them. The prefix has no engineering noun, so it is not excluded: the verdict must be false.
    const longTitle = `Coordinator ${'x '.repeat(ORIGINAL_LIMITS.title)}Sales`

    expect(isNonItTitle(longTitle.slice(0, ORIGINAL_LIMITS.title))).toBe(false)
    expect(isNonItTitle(longTitle)).toBe(false)
  })

  it('keeps the NON_IT verdict when the signal is inside the stored prefix', () => {
    expect(isNonItTitle(`${NON_IT_TITLE} ${'x'.repeat(ONE_MB)}`)).toBe(true)
  })

  it('returns fast on a 1 MB title whose cost the classifier would otherwise scale quadratically', () => {
    // "інженер" reaches the quadratic lookahead pattern in role-classifier (unfixed: 40k chars = 3 s).
    const title = `інженер ${'a'.repeat(ONE_MB)}`
    // The classifier's first call pays a one-off setup cost (about 1.5 s, measured); time the steady state.
    isNonItTitle(`інженер ${'a'.repeat(100)}`)
    const started = performance.now()

    isNonItTitle(title)

    expect(performance.now() - started).toBeLessThan(1000)
  })
})
