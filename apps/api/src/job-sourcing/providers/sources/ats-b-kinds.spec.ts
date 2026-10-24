import { describe, expect, it } from 'vitest'
import { SLUG_PATTERN } from './as'
import {
  ATS_SLUG_MAX_CHARS,
  DNS_LABEL_PATTERN,
  PERSONIO_KIND,
  RECRUITEE_KIND,
  SMARTRECRUITERS_KIND,
  WORKABLE_KIND,
} from './ats-config'

/**
 * The four board kinds, asserted from `ats-config` ALONE. This file imports no provider on
 * purpose: a mutant that empties a kind makes every provider module fail to LOAD, and a spec that
 * imports a provider then reports "no tests" instead of a failing assertion, which the mutation
 * tool does not count as a kill. Here the kind is read directly and the assertion fails.
 */

describe('the kinds are exactly what their documentation says', () => {
  it.each([
    [
      'workable',
      WORKABLE_KIND,
      {
        label: 'workable',
        regions: ['global'],
        slugMaxChars: ATS_SLUG_MAX_CHARS,
        slugPattern: SLUG_PATTERN,
      },
    ],
    [
      'recruitee',
      RECRUITEE_KIND,
      { label: 'recruitee', regions: ['global'], slugMaxChars: 63, slugPattern: DNS_LABEL_PATTERN },
    ],
    [
      'personio',
      PERSONIO_KIND,
      { label: 'personio', regions: ['global'], slugMaxChars: 63, slugPattern: DNS_LABEL_PATTERN },
    ],
  ])('%s', (_name, kind, expected) => {
    expect(kind).toEqual(expected)
  })

  it('smartrecruiters: letters and digits in runs joined by one hyphen or underscore each', () => {
    expect(SMARTRECRUITERS_KIND.label).toBe('smartrecruiters')
    expect(SMARTRECRUITERS_KIND.regions).toEqual(['global'])
    expect(SMARTRECRUITERS_KIND.slugMaxChars).toBe(64)
    const accepted = ['a', 'ab', 'ab-cd', 'ab_cd', 'Ab-Cd_ef', 'a1-b22_c333']
    const refused = ['', 'ab--cd', 'ab-', '-ab', 'ab_', 'a-_b', 'a b', 'a.b']
    expect(accepted.filter((v) => !SMARTRECRUITERS_KIND.slugPattern.test(v))).toEqual([])
    expect(refused.filter((v) => SMARTRECRUITERS_KIND.slugPattern.test(v))).toEqual([])
  })
})
