/**
 * Shared classification of dictionary leaves into PROSE and HEADING.
 *
 * Extracted from `heading-punctuation.spec.ts` so the punctuation rule and
 * the claim-coverage rule judge the same set of keys. Two copies of this
 * classification would drift, and the whole point of both tests is that a
 * new key cannot slip past either of them.
 *
 * Classification is INVERTED on purpose: prose is listed explicitly, and
 * everything else is a heading. A new key is therefore strict by default —
 * adding prose is the act that has to be declared.
 *
 * Array indices are normalised (`home.caseStudies[0].challenge` ->
 * `home.caseStudies[].challenge`) so the lists stay index-independent.
 */

export interface Leaf {
  /** Full path with concrete indices — used in failure messages. */
  path: string
  /** Path with array indices collapsed to `[]` — used for classification. */
  key: string
  value: string
}

export function collectLeaves(value: unknown, path: string, key: string, out: Leaf[]): void {
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

/** Every string leaf of a dictionary, with both concrete and normalised paths. */
export function leavesOf(dict: unknown): Leaf[] {
  const out: Leaf[] = []
  collectLeaves(dict, '', '', out)
  return out
}

/**
 * Prose — full sentences where a final full stop is CORRECT punctuation:
 * paragraphs, descriptions, form errors, hints, success bodies. Everything
 * not listed here is a heading/label/CTA.
 */
export const PROSE_KEYS: ReadonlySet<string> = new Set([
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
  // Sentence fragment CONCATENATED after the vacancy title, so it both
  // starts and ends mid-sentence — punctuation is load-bearing here.
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
 * Narrow exception to the `…` half of the punctuation rule ONLY (a trailing
 * `.` stays forbidden): an ellipsis in a pending-state button or in a
 * URL-shape placeholder is an established UI convention.
 */
export const ELLIPSIS_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'home.contactForm.submitting',
  'vacancy.apply.submitting',
  // task-upload-freeze-and-progress.md — same pending-state convention as
  // `submitting` above (100% sent ≠ done; this is the distinct label shown
  // while the server is still writing the CV to storage).
  'vacancy.apply.processing',
  'vacancy.apply.linkedinPlaceholder',
  'vacancy.apply.githubPlaceholder',
])

/** Normalised keys of every heading-class leaf (i.e. everything not prose). */
export function headingKeysOf(dict: unknown): Set<string> {
  return new Set(
    leavesOf(dict)
      .filter((leaf) => !PROSE_KEYS.has(leaf.key))
      .map((leaf) => leaf.key),
  )
}

/**
 * Normalised keys of every PROSE leaf actually present in the dictionary —
 * the other half of `headingKeysOf`, added by task-domains-expansion review
 * round 2 (HIGH-1).
 *
 * Why it exists: the claim registry only ever governed headings, so a claim
 * living in a paragraph had nothing watching it. `home.heroParagraph` said
 * "Three domains we know cold" — a hard boundary claim, above the fold — and
 * survived a whole PR that existed to remove exactly that framing, because
 * being prose put it structurally out of the registry's reach. Claims do not
 * respect the heading/prose split, so the registry no longer does either.
 */
export function proseKeysOf(dict: unknown): Set<string> {
  return new Set(
    leavesOf(dict)
      .filter((leaf) => PROSE_KEYS.has(leaf.key))
      .map((leaf) => leaf.key),
  )
}
