import { describe, expect, it } from 'vitest'
import { classifyRoles } from '../../funnel/role-classifier'
import { DISPLAY_TITLE_CHARS } from '../../normalize/build-posting'
import { isNonItTitle } from './non-it-title'

const NON_IT_TITLE = 'Exclusive Mandate: Strategic Sales Director Telco'
const ONE_MB = 1_000_000

describe('isNonItTitle', () => {
  it('classifies the display title the funnel classifies: a NON_IT signal past its cap does not count', () => {
    // The funnel classifies the first DISPLAY_TITLE_CHARS characters; the bare "sales" signal lies
    // beyond them. That prefix has no engineering noun, so it is not excluded: the verdict is false,
    // although the whole title would be NON_IT. Removing the cap fails this row deterministically.
    const longTitle = `Coordinator ${'x '.repeat(DISPLAY_TITLE_CHARS)}Sales`
    expect(classifyRoles({ title: longTitle, tags: [] }).kind).toBe('NON_IT')

    expect(isNonItTitle(longTitle)).toBe(false)
  })

  it('strips NUL before the cut, as the stored title does: NULs cannot push the signal past the cap', () => {
    // Cut first, the prefix would be all NUL (no verdict); stripped first, it is the excluded phrase.
    expect(isNonItTitle(`${'\u0000'.repeat(DISPLAY_TITLE_CHARS * 5)}${NON_IT_TITLE}`)).toBe(true)
  })

  it('calls no non-string title NON_IT, so a malformed record is left to validation', () => {
    for (const title of [7, null, undefined, { name: NON_IT_TITLE }, [NON_IT_TITLE]]) {
      expect(isNonItTitle(title)).toBe(false)
    }
  })

  it('keeps the NON_IT verdict when the signal is inside the classified prefix', () => {
    expect(isNonItTitle(`${NON_IT_TITLE} ${'x'.repeat(ONE_MB)}`)).toBe(true)
  })
})
