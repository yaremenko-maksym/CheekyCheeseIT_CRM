/**
 * task-landing-copy-refactor.md §1 — "правило про точки — тестом, а не
 * дисциплиной".
 *
 * Owner's rule: a heading is a label for a section, not a sentence, so it
 * does NOT end in a full stop. `?` and `!` are allowed (they change the
 * intonation); a trailing `.` adds nothing, and `…` is mannered — both are
 * rejected.
 *
 * The PROSE/HEADING classification lives in `support/heading-keys.ts` and is
 * shared with `heading-claims.spec.ts`, so the punctuation rule and the claim
 * registry judge the same set of keys and cannot drift apart.
 */
import { describe, expect, it } from 'vitest'
import { LOCALES } from '@/i18n/locale'
import { DICTIONARIES } from '@/i18n/dictionaries'
import { ELLIPSIS_ALLOWED_KEYS, leavesOf, PROSE_KEYS, type Leaf } from './support/heading-keys'

describe('copy — headings do not end in a full stop (task-landing-copy-refactor.md §1)', () => {
  const leavesByLocale = new Map<string, Leaf[]>(
    LOCALES.map((locale) => [locale, leavesOf(DICTIONARIES[locale])] as const),
  )

  it.each(LOCALES)('%s — no heading key ends with "." or "…"', (locale) => {
    const offenders = leavesByLocale
      .get(locale)!
      .filter((leaf) => !PROSE_KEYS.has(leaf.key))
      .filter((leaf) => {
        const trimmed = leaf.value.trimEnd()
        if (trimmed.endsWith('…')) return !ELLIPSIS_ALLOWED_KEYS.has(leaf.key)
        // `...` spelled with three dots is the same offence as `…`.
        if (trimmed.endsWith('...')) return true
        return trimmed.endsWith('.')
      })
      .map((leaf) => `${leaf.path}: ${JSON.stringify(leaf.value)}`)

    expect(offenders, `${locale}: heading-class keys must not end in a full stop`).toEqual([])
  })

  it('every prose/ellipsis exemption refers to a key that actually exists', () => {
    // Guards the inverted classification: a renamed or deleted key must not
    // leave a silent hole in the allow-list that quietly exempts nothing —
    // or, worse, that a future key accidentally lands in.
    const enKeys = new Set(leavesByLocale.get('en')!.map((leaf) => leaf.key))
    const staleProse = [...PROSE_KEYS].filter((key) => !enKeys.has(key))
    const staleEllipsis = [...ELLIPSIS_ALLOWED_KEYS].filter((key) => !enKeys.has(key))

    expect(staleProse, 'PROSE_KEYS lists keys that no longer exist in `en`').toEqual([])
    expect(staleEllipsis, 'ELLIPSIS_ALLOWED_KEYS lists keys that no longer exist in `en`').toEqual(
      [],
    )
  })

  it('prose keys are exempt on purpose — at least one of them really is a sentence', () => {
    // Sanity check on the exemption itself: if the prose list stopped
    // matching real sentences (e.g. someone shortened every paragraph into a
    // label), the strict rule would be silently doing nothing for them.
    const en = leavesByLocale.get('en')!
    const proseEndingInStop = en.filter(
      (leaf) => PROSE_KEYS.has(leaf.key) && leaf.value.trimEnd().endsWith('.'),
    )
    expect(proseEndingInStop.length).toBeGreaterThan(0)
  })
})
