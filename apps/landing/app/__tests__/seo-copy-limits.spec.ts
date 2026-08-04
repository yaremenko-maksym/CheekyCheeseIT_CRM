/**
 * task-landing-copy-refactor.md §4 — the copy refactor may touch SEO fields,
 * but only within the limits that already earn these pages their search
 * results (#421–#425, #459): title ≤ 60 chars, description ≤ 155, and the
 * domain keywords stay in place.
 *
 * Encoded as a test rather than checked once by hand, for the same reason as
 * the heading rule: a limit that lives in a task file is a limit that the
 * next copy edit silently breaks. Vacancy structured data (`baseSalary` etc.)
 * is out of scope here and is covered by `prerender-seo.spec.ts`.
 */
import { describe, expect, it } from 'vitest'
import { LOCALES } from '@/i18n/locale'
import { DICTIONARIES } from '@/i18n/dictionaries'

const TITLE_MAX = 60
const DESCRIPTION_MAX = 155

/** Every `seoTitle`/`seoDescription` pair the landing renders. */
function seoFields(locale: (typeof LOCALES)[number]) {
  const dict = DICTIONARIES[locale]
  return [
    { page: 'home', title: dict.home.seoTitle, description: dict.home.seoDescription },
    { page: 'careers', title: dict.careers.seoTitle, description: dict.careers.seoDescription },
    {
      page: 'vacancy-not-found',
      title: dict.vacancy.notFoundSeoTitle,
      description: dict.vacancy.notFoundSeoDescription,
    },
    {
      page: 'not-found',
      title: dict.notFoundPage.seoTitle,
      description: dict.notFoundPage.seoDescription,
    },
  ]
}

describe('SEO copy limits (task-landing-copy-refactor.md §4)', () => {
  it.each(LOCALES)(`%s — titles fit in ${TITLE_MAX} chars`, (locale) => {
    const tooLong = seoFields(locale)
      .filter((field) => field.title.length > TITLE_MAX)
      .map((field) => `${field.page}: ${field.title.length} chars — ${field.title}`)

    expect(tooLong, `${locale}: seoTitle must be <= ${TITLE_MAX} chars`).toEqual([])
  })

  it.each(LOCALES)(`%s — descriptions fit in ${DESCRIPTION_MAX} chars`, (locale) => {
    const tooLong = seoFields(locale)
      .filter((field) => field.description.length > DESCRIPTION_MAX)
      .map((field) => `${field.page}: ${field.description.length} chars — ${field.description}`)

    expect(tooLong, `${locale}: seoDescription must be <= ${DESCRIPTION_MAX} chars`).toEqual([])
  })

  it.each(LOCALES)('%s — home SEO keeps the three domain keywords', (locale) => {
    // The domains are brand terms and stay untranslated in every locale, so
    // the same check works across all five.
    const haystack = `${DICTIONARIES[locale].home.seoTitle} ${DICTIONARIES[locale].home.seoDescription}`
    for (const keyword of ['AI', 'EdTech', 'E-Commerce']) {
      expect(haystack, `${locale}: home SEO lost the "${keyword}" keyword`).toContain(keyword)
    }
  })
})
