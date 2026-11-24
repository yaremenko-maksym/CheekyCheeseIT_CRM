import type { ExternalFieldStatus, ExternalVacancyPrefill } from '@crm/shared'

import { COMPANY_MAX, DESCRIPTION_MAX, PAGE_TEXT_MAX, TITLE_MAX } from './limits'
import { readProfile, type ProfileFields } from './profiles'
import { htmlText, nodeText } from './text'

/** A selection shorter than this is a stray click, not the vacancy text. */
export const SELECTION_MIN = 200

/** Words that mark a text as a vacancy when only the generic path read the page. */
const VACANCY_CUES =
  /requirements|responsibilit|qualifications|what you.ll do|вимоги|обов.язки|досвід|требования|обязанности|опыт работы/i

const PAGE_CHROME = 'nav, header, footer, aside, script, style, noscript, template'

type Field = 'title' | 'company' | 'description'
type Read = { value: string; status: ExternalFieldStatus }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Every node of every JSON-LD block, `@graph` and arrays flattened; a broken block is skipped. */
function jsonLdNodes(doc: Document): Record<string, unknown>[] {
  // Stryker disable next-line ArrayDeclaration: a seeded string entry is never a JobPosting
  const nodes: Record<string, unknown>[] = []
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit)
    else if (v && typeof v === 'object') {
      nodes.push(v as Record<string, unknown>)
      visit((v as Record<string, unknown>)['@graph'])
    }
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

function readJsonLd(doc: Document): ProfileFields | null {
  const job = jsonLdNodes(doc).find((n) => {
    const type = n['@type']
    return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))
  })
  if (!job) return null
  const org = job.hiringOrganization
  const company = typeof org === 'string' ? org : str((org as { name?: unknown } | null)?.name)
  return {
    title: htmlText(str(job.title)),
    company: htmlText(company),
    description: htmlText(str(job.description)),
  }
}

function readGeneric(doc: Document, host: string): ProfileFields {
  const meta = (property: string): string =>
    doc.querySelector(`meta[property="${property}"]`)?.getAttribute('content')?.trim() ?? ''
  const blocks = Array.from(doc.querySelectorAll('main, article, [role="main"]')).map(nodeText)
  return {
    title: meta('og:title') || nodeText(doc.querySelector('h1')) || doc.title,
    company: meta('og:site_name') || host,
    description: blocks.reduce((a, b) => (b.length > a.length ? b : a), ''),
  }
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

/** The page text sent for the CRM's own parse when the page could not be read in full. */
function pageText(doc: Document): string {
  const body = doc.body?.cloneNode(true) as HTMLElement | undefined
  body?.querySelectorAll(PAGE_CHROME).forEach((el) => el.remove())
  return nodeText(body).slice(0, PAGE_TEXT_MAX)
}

/**
 * Reads a vacancy off the open page, first hit per field: the HR's selection (description only),
 * JSON-LD `JobPosting`, a known site's selectors, then a generic guess. It never throws on an odd
 * page and always returns an answer; `recognition` says how sure it is.
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
    // An opaque page URL: the generic path then has no host to name.
  }
  const picked = selection.trim()
  const selected = picked.length >= SELECTION_MIN
  const strong = [readJsonLd(doc), readProfile(doc, host)].filter(
    (f): f is ProfileFields => f !== null,
  )
  const generic = readGeneric(doc, host)

  const read = (field: Field): Read => {
    if (field === 'description' && selected) return { value: picked, status: 'found' }
    const hit = strong.find((f) => f[field])
    if (hit) return { value: hit[field], status: 'found' }
    return generic[field]
      ? { value: generic[field], status: 'guessed' }
      : { value: '', status: 'missing' }
  }
  const title = read('title')
  const company = read('company')
  const description = read('description')

  const recognized =
    selected || strong.length > 0 || (title.value !== '' && VACANCY_CUES.test(description.value))
  const complete = title.value !== '' && company.value !== '' && description.value !== ''
  const recognition = !recognized ? 'none' : complete ? 'recognized' : 'partial'

  const canonical = https(doc.querySelector('link[rel="canonical"]')?.getAttribute('href'), href)
  const url = canonical ?? https(href, href)
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
