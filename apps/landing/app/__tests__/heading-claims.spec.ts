/**
 * task-landing-copy-refactor.md — the claim registry is enforced, not
 * remembered.
 *
 * A test cannot check that five locales MEAN the same thing; that judgement
 * stays with the reviewer. What it CAN check is that no heading escapes the
 * registry, which is exactly how the previous, comment-based registry failed:
 * it covered 8 of ~13 headings, and the heading outside it (`careers.h1`) had
 * silently lost "senior" in ru/uk.
 *
 * So: every heading-class key must be declared either as claim-bearing (with
 * the claim all five locales carry) or as explicitly claim-free. Neither is
 * not an option, and a newly added heading is "neither" until its author
 * chooses.
 */
import { describe, expect, it } from 'vitest'
import { LOCALES } from '@/i18n/locale'
import { DICTIONARIES } from '@/i18n/dictionaries'
import { headingKeysOf, leavesOf, proseKeysOf, PROSE_KEYS } from './support/heading-keys'
import {
  CLAIMLESS_HEADING_KEYS,
  CLAIMLESS_PROSE_KEYS,
  HEADING_CLAIMS,
  PROSE_CLAIMS,
} from './heading-claims'

const claimKeys = new Set(Object.keys(HEADING_CLAIMS))
const headingKeys = headingKeysOf(DICTIONARIES.en)
const proseClaimKeys = new Set(Object.keys(PROSE_CLAIMS))
const proseKeys = proseKeysOf(DICTIONARIES.en)

describe('heading claims — registry covers every heading (task-landing-copy-refactor.md)', () => {
  it('every heading key is declared either claim-bearing or claim-free', () => {
    const undeclared = [...headingKeys]
      .filter((key) => !claimKeys.has(key) && !CLAIMLESS_HEADING_KEYS.has(key))
      .sort()

    expect(
      undeclared,
      'These heading keys are in no registry. Add each to HEADING_CLAIMS with the ' +
        'claim all five locales must carry, or to CLAIMLESS_HEADING_KEYS if it ' +
        'asserts nothing about the company (see heading-claims.ts)',
    ).toEqual([])
  })

  it('the registry declares nothing that is not a heading', () => {
    // Catches a key that was renamed, deleted, or reclassified as prose:
    // a stale entry would quietly "cover" a heading that no longer exists.
    const stale = [...claimKeys, ...CLAIMLESS_HEADING_KEYS]
      .filter((key) => !headingKeys.has(key))
      .sort()

    expect(
      stale,
      'Registry entries that are not heading keys in `en` (renamed, removed, or ' +
        'now prose — see PROSE_KEYS in support/heading-keys.ts)',
    ).toEqual([])
  })

  it('no key is declared both claim-bearing and claim-free', () => {
    const both = [...claimKeys].filter((key) => CLAIMLESS_HEADING_KEYS.has(key)).sort()
    expect(both, 'A key cannot both carry a claim and carry none').toEqual([])
  })

  it('every claim is a non-empty description', () => {
    const empty = Object.entries(HEADING_CLAIMS)
      .filter(([, claim]) => claim.trim().length === 0)
      .map(([key]) => key)
    expect(empty, 'A claim must say what the heading asserts').toEqual([])
  })

  it('every claim-bearing heading is actually present in all five locales', () => {
    // The claim is a cross-locale contract, so the key must exist and be
    // non-empty everywhere — not just in the source locale.
    for (const locale of LOCALES) {
      const leaves = new Map(leavesOf(DICTIONARIES[locale]).map((leaf) => [leaf.key, leaf.value]))
      const missing = [...claimKeys].filter((key) => !(leaves.get(key) ?? '').trim())
      expect(missing, `${locale} is missing copy for claim-bearing headings`).toEqual([])
    }
  })

  it('prose keys are never registered as headings', () => {
    const proseInClaims = [...claimKeys].filter((key) => PROSE_KEYS.has(key)).sort()
    expect(
      proseInClaims,
      'A paragraph belongs in PROSE_CLAIMS, not HEADING_CLAIMS (the punctuation rule differs)',
    ).toEqual([])
  })
})

/**
 * task-domains-expansion review round 2 (HIGH-1). `home.heroParagraph`
 * promised "Three domains we know cold" — above the fold, read before the
 * services section that says the opposite — and no test could have caught it:
 * prose was outside the registry BY CONSTRUCTION, so "the registry covers
 * every heading" quietly meant "half the copy is unguarded". These mirror the
 * heading tests one-for-one over the prose half.
 */
describe('prose claims — registry covers every paragraph too (review round 2)', () => {
  it('actually has prose to govern (guards against a vacuous pass)', () => {
    // If `PROSE_KEYS` ever drifts away from the dictionary shape, every
    // coverage assertion below would pass over an empty set while claiming
    // the copy is guarded — the precise illusion this whole file exists to
    // destroy. `home.heroParagraph` is pinned by name: it is the key that
    // escaped in round 2.
    expect(proseKeys.size).toBeGreaterThan(30)
    expect(proseKeys.has('home.heroParagraph')).toBe(true)
    expect(proseClaimKeys.has('home.heroParagraph')).toBe(true)
  })

  it('every prose key is declared either claim-bearing or claim-free', () => {
    const undeclared = [...proseKeys]
      .filter((key) => !proseClaimKeys.has(key) && !CLAIMLESS_PROSE_KEYS.has(key))
      .sort()

    expect(
      undeclared,
      'These prose keys are in no registry. Add each to PROSE_CLAIMS with the ' +
        'claim all five locales must carry, or to CLAIMLESS_PROSE_KEYS if it ' +
        'asserts nothing about the company (see heading-claims.ts)',
    ).toEqual([])
  })

  it('the prose registry declares nothing that is not a prose key', () => {
    const stale = [...proseClaimKeys, ...CLAIMLESS_PROSE_KEYS]
      .filter((key) => !proseKeys.has(key))
      .sort()

    expect(
      stale,
      'Prose registry entries that are not prose keys in `en` (renamed, removed, ' +
        'or reclassified as a heading — see PROSE_KEYS in support/heading-keys.ts)',
    ).toEqual([])
  })

  it('no prose key is declared both claim-bearing and claim-free', () => {
    const both = [...proseClaimKeys].filter((key) => CLAIMLESS_PROSE_KEYS.has(key)).sort()
    expect(both, 'A key cannot both carry a claim and carry none').toEqual([])
  })

  it('every prose claim is a non-empty description', () => {
    const empty = Object.entries(PROSE_CLAIMS)
      .filter(([, claim]) => claim.trim().length === 0)
      .map(([key]) => key)
    expect(empty, 'A claim must say what the paragraph asserts').toEqual([])
  })

  it('every claim-bearing paragraph is actually present in all five locales', () => {
    for (const locale of LOCALES) {
      const leaves = leavesOf(DICTIONARIES[locale])
      const missing = [...proseClaimKeys].filter(
        (key) => !leaves.some((leaf) => leaf.key === key && leaf.value.trim()),
      )
      expect(missing, `${locale} is missing copy for claim-bearing prose`).toEqual([])
    }
  })

  it('no heading key leaks into the prose registry', () => {
    const headingsInProse = [...proseClaimKeys, ...CLAIMLESS_PROSE_KEYS]
      .filter((key) => headingKeys.has(key))
      .sort()
    expect(headingsInProse, 'Headings belong in the heading registry').toEqual([])
  })
})
