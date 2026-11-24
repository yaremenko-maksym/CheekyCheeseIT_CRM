import { nodeText } from './text'

export interface ProfileFields {
  title: string
  company: string
  description: string
}

interface Profile {
  /** The page's host, or a parent domain of it. */
  hosts: readonly string[]
  read: (doc: Document) => ProfileFields
}

const text = (doc: Document, selector: string): string => nodeText(doc.querySelector(selector))

/**
 * Selector sets for job sites whose markup was checked against a saved page (`__fixtures__`).
 * Other boards (LinkedIn, Lever, Workable, Ashby, Djinni) are read through JSON-LD or the generic
 * path until a real page of theirs is captured: a selector guessed from memory fails silently.
 */
const PROFILES: readonly Profile[] = [
  {
    hosts: ['jobs.dou.ua'],
    read: (doc) => ({
      title: text(doc, 'h1.g-h2'),
      company: text(doc, '.b-compinfo .l-n a:not(.all-v)'),
      description: text(doc, '.b-typo.vacancy-section'),
    }),
  },
  {
    hosts: ['greenhouse.io'],
    read: (doc) => ({
      title: text(doc, '.job__title h1'),
      company:
        / at (.+)$/.exec(doc.title.trim())?.[1]?.trim() ??
        (doc.querySelector('img[alt$=" Logo"]')?.getAttribute('alt') ?? '').replace(/ Logo$/, ''),
      description: text(doc, '.job__description'),
    }),
  },
]

/** The fields a known site gives, or `null` when the page is not on one or has none of them. */
export function readProfile(doc: Document, host: string): ProfileFields | null {
  const profile = PROFILES.find((p) => p.hosts.some((h) => host === h || host.endsWith(`.${h}`)))
  if (!profile) return null
  const fields = profile.read(doc)
  return fields.title || fields.description ? fields : null
}
