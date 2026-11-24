import { nodeText } from './text'

export interface ProfileFields {
  title: string
  company: string
  description: string
}

interface Profile {
  /** The page's host, or a parent domain of it. */
  host: string
  read: (doc: Document) => ProfileFields
}

const text = (doc: Document, selector: string): string => nodeText(doc.querySelector(selector))

/**
 * Selector sets for job sites whose markup was checked against a saved page (`__fixtures__`).
 * Other boards (Lever, Workable, Ashby, Djinni) are read through JSON-LD or the generic
 * path until a real page of theirs is captured: a selector guessed from memory fails silently.
 */
const PROFILES: readonly Profile[] = [
  {
    host: 'jobs.dou.ua',
    read: (doc) => ({
      title: text(doc, 'h1.g-h2'),
      company: text(doc, '.b-compinfo .l-n a:not(.all-v)'),
      description: text(doc, '.b-typo.vacancy-section'),
    }),
  },
  {
    // the public job page; the signed-in layout has other classes and goes the generic way
    host: 'linkedin.com',
    read: (doc) => ({
      title: text(doc, 'h1.topcard__title'),
      company: text(doc, '.topcard__org-name-link'),
      description: text(doc, '.show-more-less-html__markup'),
    }),
  },
  {
    host: 'greenhouse.io',
    read: (doc) => ({
      title: text(doc, '.job__title h1'),
      company:
        // `document.title` is already stripped and collapsed
        / at (.+)/.exec(doc.title)?.[1] ??
        (doc.querySelector('img[alt$=" Logo"]')?.getAttribute('alt') ?? '').replace(/ Logo$/, ''),
      description: text(doc, '.job__description'),
    }),
  },
]

/** The fields a known site gives, or `null` when the page is not on one or has none of them. */
export function readProfile(doc: Document, host: string): ProfileFields | null {
  const profile = PROFILES.find((p) => host === p.host || host.endsWith(`.${p.host}`))
  if (!profile) return null
  const fields = profile.read(doc)
  return fields.title || fields.description ? fields : null
}
