/**
 * task-landing-copy-refactor.md §1 — "правило про точки — тестом, а не
 * дисциплиной".
 *
 * Owner's rule: a heading is a label for a section, not a sentence, so it
 * does NOT end in a full stop. `?` and `!` are allowed (they change the
 * intonation); a trailing `.` adds nothing, and `…` is mannered — both are
 * rejected.
 *
 * Classification is deliberately INVERTED: there is an explicit allow-list
 * of prose keys (paragraphs, form errors, hints — places where a full stop
 * is correct punctuation), and EVERYTHING ELSE is treated as a heading. A
 * newly added key therefore falls under the strict rule by default: adding
 * prose is the act that has to be made explicit, which is the safe
 * direction — the rule cannot silently rot as the dictionary grows.
 *
 * Array indices are normalised (`home.caseStudies[0].challenge` ->
 * `home.caseStudies[].challenge`) so the lists below stay index-independent
 * and a new case study is covered without touching this file.
 */
import { describe, expect, it } from 'vitest'
import { LOCALES } from '@/i18n/locale'
import { DICTIONARIES } from '@/i18n/dictionaries'

interface Leaf {
  /** Full path with concrete indices — used in failure messages. */
  path: string
  /** Path with array indices collapsed to `[]` — used for classification. */
  key: string
  value: string
}

function collectLeaves(value: unknown, path: string, key: string, out: Leaf[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectLeaves(item, `${path}[${i}]`, `${key}[]`, out))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      collectLeaves(
        child,
        path ? `${path}.${childKey}` : childKey,
        key ? `${key}.${childKey}` : childKey,
        out,
      )
    }
    return
  }
  if (typeof value === 'string') out.push({ path, key, value })
}

/**
 * Prose — full sentences where a final full stop is CORRECT punctuation:
 * paragraphs, descriptions, form errors, hints, success bodies. Everything
 * not listed here is a heading/label/CTA and is held to the strict rule.
 */
const PROSE_KEYS: ReadonlySet<string> = new Set([
  // Footer
  'footer.rights',

  // Home — body copy
  'home.seoDescription',
  'home.heroParagraph',
  'home.aboutP1',
  'home.aboutP2',
  'home.workP',
  'home.caseStudies[].challenge',
  'home.caseStudies[].solution',
  'home.servicesP',
  'home.services[].description',
  'home.processSteps[].description',
  'home.careersP',
  'home.contactP',

  // Home — contact form prose
  'home.contactForm.messagePlaceholder',
  'home.contactForm.protectedBy',
  'home.contactForm.errorName',
  'home.contactForm.errorEmail',
  'home.contactForm.errorMessage',
  'home.contactForm.successBody',
  'home.contactForm.apiErrorValidation',
  'home.contactForm.apiErrorTurnstile',
  'home.contactForm.apiErrorTurnstileRepeat',
  'home.contactForm.apiErrorRateLimited',
  'home.contactForm.apiErrorUnavailable',
  'home.contactForm.apiErrorNetwork',

  // Careers index
  'careers.seoDescription',
  'careers.p1',
  'careers.p2',
  'careers.emptyBody',

  // Vacancy detail
  'vacancy.notFoundSeoDescription',
  'vacancy.notFoundBody',
  'vacancy.apply.subheading',
  'vacancy.apply.coverPlaceholder',
  'vacancy.apply.protectedBy',
  'vacancy.apply.errorName',
  'vacancy.apply.errorEmail',
  'vacancy.apply.errorLinkedin',
  'vacancy.apply.errorGithub',
  'vacancy.apply.errorFile',
  'vacancy.apply.cvInvalidType',
  'vacancy.apply.cvTooLarge',
  // Sentence fragment that is CONCATENATED after the vacancy title, so it
  // both starts and ends mid-sentence — punctuation is load-bearing here.
  'vacancy.apply.successBodyAfter',
  'vacancy.apply.apiErrorValidation',
  'vacancy.apply.apiErrorTooLarge',
  'vacancy.apply.apiErrorUnsupportedMedia',
  'vacancy.apply.apiErrorDuplicate',
  'vacancy.apply.apiErrorNetwork',

  // 404
  'notFoundPage.seoDescription',
  'notFoundPage.body',
])

/**
 * Narrow exception to the `…` half of the rule ONLY (a trailing `.` stays
 * forbidden here too): an ellipsis in a pending-state button or in a
 * URL-shape placeholder is an established UI convention, not the mannered
 * trailing "…" the rule targets.
 */
const ELLIPSIS_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'home.contactForm.submitting',
  'vacancy.apply.submitting',
  'vacancy.apply.linkedinPlaceholder',
  'vacancy.apply.githubPlaceholder',
])

describe('copy — headings do not end in a full stop (task-landing-copy-refactor.md §1)', () => {
  const leavesByLocale = new Map(
    LOCALES.map((locale) => {
      const out: Leaf[] = []
      collectLeaves(DICTIONARIES[locale], '', '', out)
      return [locale, out] as const
    }),
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
