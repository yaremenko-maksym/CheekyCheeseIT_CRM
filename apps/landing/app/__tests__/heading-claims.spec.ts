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
import { headingKeysOf, leavesOf, PROSE_KEYS } from './support/heading-keys'
import { CLAIMLESS_HEADING_KEYS, HEADING_CLAIMS } from './heading-claims'

const claimKeys = new Set(Object.keys(HEADING_CLAIMS))
const headingKeys = headingKeysOf(DICTIONARIES.en)

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

  it('prose keys are never claim-bearing headings', () => {
    const proseInClaims = [...claimKeys].filter((key) => PROSE_KEYS.has(key)).sort()
    expect(
      proseInClaims,
      'Paragraphs are not headings — the registry governs headings only',
    ).toEqual([])
  })
})
