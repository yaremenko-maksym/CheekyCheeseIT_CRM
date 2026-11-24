import type { ExternalFieldStatus, ExternalVacancyPrefill } from '@crm/shared'

import { COMPANY_MAX, DESCRIPTION_MAX, PAGE_TEXT_MAX, TITLE_MAX, URL_MAX } from './limits'
import { readProfile, type ProfileFields } from './profiles'
import { htmlText, nodeText, type Visible } from './text'

/** A selection shorter than this is a stray click, not the vacancy text. */
export const SELECTION_MIN = 200

/** Words that mark a text as a vacancy when only the generic path read the page. */
const VACANCY_CUES =
  /requirements|responsibilit|qualifications|what you.ll do|вимоги|обов.язки|досвід|требования|обязанности|опыт работы/i

const PAGE_CHROME = 'nav, header, footer, aside, script, style, noscript, template'
/** Skipped whatever the layout says: a parsed document has no layout to ask. */
const NOT_SHOWN = `${PAGE_CHROME}, [hidden]`

/**
 * Whether the browser shows an element. A document without a window (parsed, detached) has no
 * layout, and `checkVisibility()` is false for all of it there, so everything counts as shown.
 */
export function isVisible(el: Element): boolean {
  const view = el.ownerDocument.defaultView
  if (!view) return true
  return (
    (el.checkVisibility?.({ checkVisibilityCSS: true }) ?? true) ||
    // A display:contents wrapper has no box of its own, yet its children show.
    view.getComputedStyle(el).display === 'contents'
  )
}

const shown =
  (visible: Visible): Visible =>
  (el) =>
    !el.matches(NOT_SHOWN) && visible(el)

type Field = 'title' | 'company' | 'description'
type Read = { value: string; status: ExternalFieldStatus }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Every node of every JSON-LD block, `@graph` and arrays flattened; a broken block is skipped. */
function jsonLdNodes(doc: Document): Record<string, unknown>[] {
  // Stryker disable next-line ArrayDeclaration: a seeded string entry is never a JobPosting
  const nodes: Record<string, unknown>[] = []
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit)
    // Stryker disable next-line ConditionalExpression,LogicalOperator: a primitive node has no @type, so it never matches
    if (!v || typeof v !== 'object') return
    nodes.push(v as Record<string, unknown>)
    visit((v as Record<string, unknown>)['@graph'])
  }
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
    try {
      visit(JSON.parse(String(script.textContent)))
    } catch {
      // A page's broken JSON-LD is its problem, not a reason to stop reading it.
    }
  })
  return nodes
}

/**
 * The page's JSON-LD `JobPosting`, as a board lists related jobs too: the one whose title and a
 * page name (h1, og:title, tab title) hold one another with the largest overlap, else the first.
 */
function readJsonLd(doc: Document): ProfileFields | null {
  const jobs = jsonLdNodes(doc).filter((n) => {
    const type = n['@type']
    return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))
  })
  const names = [
    str(doc.querySelector('meta[property="og:title"]')?.getAttribute('content')),
    nodeText(doc.querySelector('h1')),
    doc.title,
  ]
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
  // An exact title beats any containment; a containment counts from half the longer string, so a
  // tab title of just the company picks nothing. An empty title scores 0 and never wins.
  const overlap = (n: Record<string, unknown>): number => {
    const title = htmlText(str(n.title)).toLowerCase()
    if (names.includes(title)) return Infinity
    return names.reduce((best, name) => {
      const short = Math.min(title.length, name.length)
      const held = name.includes(title) || title.includes(name)
      return held && short * 2 >= Math.max(title.length, name.length) ? Math.max(best, short) : best
    }, 0)
  }
  let job = jobs[0]
  let best = 0
  for (const n of jobs) {
    const o = overlap(n)
    if (o > best) [job, best] = [n, o]
  }
  if (!job) return null
  const org = job.hiringOrganization
  const company = typeof org === 'string' ? org : str((org as { name?: unknown } | null)?.name)
  return {
    title: htmlText(str(job.title)),
    company: htmlText(company),
    description: htmlText(str(job.description)),
  }
}

/**
 * Whether a page no profile or JSON-LD read still looks like a vacancy: it has a name (og:title,
 * h1 or the tab title) and a main/article block carries a vacancy cue. Nothing it sees is
 * prefilled: a tab title, og:title or og:site_name names the site ("… | LinkedIn", "Djinni") as
 * often as the job, and the CRM's parse of the page text fills only fields still empty.
 */
function looksLikeVacancy(doc: Document): boolean {
  const named =
    doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() ||
    nodeText(doc.querySelector('h1')) ||
    doc.title
  const blocks = Array.from(doc.querySelectorAll('main, article, [role="main"]')).map((b) =>
    nodeText(b),
  )
  return named !== '' && blocks.some((block) => VACANCY_CUES.test(block))
}

const https = (href: string | null | undefined, base: string): string | undefined => {
  if (!href) return undefined
  let url: URL | undefined
  try {
    url = new URL(href, base)
  } catch {
    // not a URL: no link
  }
  return url?.protocol === 'https:' ? url.href : undefined
}

/**
 * The page text sent for the CRM's own parse when the page could not be read in full: the live
 * body's shown text without chrome, so a hidden blob does not eat the limit.
 */
export function pageText(doc: Document, visible: Visible = isVisible): string {
  return nodeText(doc.body, shown(visible)).slice(0, PAGE_TEXT_MAX)
}

/**
 * Reads a vacancy off the open page, first hit per field: the HR's selection (description only),
 * JSON-LD `JobPosting`, then a known site's selectors; a field none of them gives stays empty for the
 * CRM's parse of the page text. It never throws on an odd page and always returns an answer;
 * `recognition` says how sure it is, and only a fully read page goes without its page text.
 */
export function extractVacancy(
  doc: Document,
  href: string,
  selection: string,
): ExternalVacancyPrefill {
  let host = ''
  try {
    host = new URL(href).hostname
  } catch {
    // An opaque page URL: site profiles and canonical checks then have no host to match.
  }
  const picked = selection.trim()
  const selected = picked.length >= SELECTION_MIN
  const strong = [readJsonLd(doc), readProfile(doc, host)].filter(
    (f): f is ProfileFields => f !== null,
  )
  const read = (field: Field): Read => {
    if (field === 'description' && selected) return { value: picked, status: 'found' }
    const hit = strong.find((f) => f[field])
    return hit ? { value: hit[field], status: 'found' } : { value: '', status: 'missing' }
  }
  const title = read('title')
  const company = read('company')
  const description = read('description')

  const recognized = selected || strong.length > 0 || looksLikeVacancy(doc)
  const complete = title.value !== '' && company.value !== '' && description.value !== ''
  const recognition = !recognized ? 'none' : complete ? 'recognized' : 'partial'

  const canonical = https(doc.querySelector('link[rel="canonical"]')?.getAttribute('href'), href)
  // A canonical link on another host would name a site the HR was not on: the page's own link wins.
  const sameHost = canonical && new URL(canonical).hostname === host ? canonical : undefined
  const url = [sameHost, https(href, href)].find((u) => u && u.length <= URL_MAX)
  const urlStatus: ExternalFieldStatus = !url ? 'missing' : recognized ? 'found' : 'guessed'

  // Not recognized: nothing guessed is worth pre-filling; the CRM parses the page text instead.
  const keep = (r: Read, max: number): string | undefined =>
    recognized && r.value ? r.value.slice(0, max) : undefined
  const status = (r: Read): ExternalFieldStatus => (recognized ? r.status : 'missing')

  return {
    v: 1,
    recognition,
    url,
    title: keep(title, TITLE_MAX),
    company: keep(company, COMPANY_MAX),
    description: keep(description, DESCRIPTION_MAX),
    pageText: recognition === 'recognized' ? undefined : pageText(doc),
    status: {
      url: urlStatus,
      title: status(title),
      company: status(company),
      description: status(description),
    },
  }
}
