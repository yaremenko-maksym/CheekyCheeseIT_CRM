import type { ExternalFieldStatus, ExternalVacancyPrefill } from '@crm/shared'

import { COMPANY_MAX, DESCRIPTION_MAX, PAGE_TEXT_MAX, TITLE_MAX, URL_MAX } from './limits'
import { findPane, guessTitle } from './pane'
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

/** A JSON-LD amount over 0, given as a number or a numeric string. */
const amount = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : str(v).trim() ? Number(v) : NaN
  return n > 0 ? n : undefined
}

/** The pay periods a salary line names; any other `unitText` is left out. */
const UNITS = /^(hour|day|week|month|year)$/

/** The posting's pay as one line ("100000–140000 USD / year"), the site's data only: no words of ours. */
function salaryLine(job: Record<string, unknown>): string {
  const pay = (job.baseSalary ?? job.estimatedSalary) as Record<string, unknown> | undefined
  const raw = pay?.value
  const q = (raw && typeof raw === 'object' ? raw : { value: raw }) as Record<string, unknown>
  const [one, lo, hi] = [q.value, q.minValue, q.maxValue].map(amount)
  if (lo && hi && lo > hi) return ''
  const first = lo && hi ? lo : (one ?? lo ?? hi)
  if (!first) return ''
  const unit = str(q.unitText).toLowerCase()
  return [hi && hi > first ? `${first}–${hi}` : first, str(pay?.currency)]
    .filter(Boolean)
    .join(' ')
    .concat(UNITS.test(unit) ? ` / ${unit}` : '')
}

/** Whether a text already shows a salary line's first amount, however its digits are grouped. */
const showsPay = (text: string, line: string): boolean =>
  text.replace(/[\s,.]/g, '').includes(String(parseFloat(line)).replace('.', ''))

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
function readJsonLd(doc: Document): (ProfileFields & { salary: string }) | null {
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
    salary: salaryLine(job),
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
 * JSON-LD `JobPosting`, then a known site's selectors, then a guess from the vacancy pane (description,
 * and a title on any page that reads as a vacancy by itself); a field none of them gives stays empty
 * for the CRM's parse of the page text. It never throws on an odd page and always returns an answer;
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
  const ld = readJsonLd(doc)
  const strong = [ld, readProfile(doc, host)].filter((f): f is ProfileFields => f !== null)
  const visible = shown(isVisible)
  const pane = findPane(doc, visible)
  // The page itself reads as a vacancy; a selection alone vouches for its text, not for its headings.
  const vacancyPage = strong.length > 0 || looksLikeVacancy(doc) || pane?.cue === true
  const titleSees =
    (header: string): Visible =>
    (el) =>
      el.matches(header) ? isVisible(el) : visible(el)
  const guess: Record<Field, () => string> = {
    // Walks up from the pane, or from the body without one.
    // An article's own <header> holds the job h1, unlike the site header the page text drops.
    title: () =>
      vacancyPage
        ? guessTitle(
            doc,
            pane?.el ?? null,
            titleSees('main header, article header'),
            titleSees('header'),
          )
        : '',
    // Stryker disable next-line ArrowFunction: an undefined guess reads as missing, the same as ''
    company: () => '',
    description: () => pane?.text ?? '',
  }
  const read = (field: Field): Read => {
    if (field === 'description' && selected) return { value: picked, status: 'found' }
    const hit = strong.find((f) => f[field])
    // A JSON-LD text under half the cue pane is one the site cut short (RemoteOK: ~1000 chars).
    const cut =
      field === 'description' &&
      hit === ld &&
      pane?.cue &&
      hit.description.length * 2 < pane.text.length
    if (hit && !cut) return { value: hit[field], status: 'found' }
    const value = guess[field]()
    return { value, status: value ? 'guessed' : 'missing' }
  }
  const title = read('title')
  const company = read('company')
  const description = read('description')
  if (!selected && description.value) {
    // Pay a block beyond the pane's own siblings holds, then the JSON-LD salary, each only once.
    for (const block of pane?.more ?? []) {
      if (!description.value.includes(block)) description.value += `\n\n${block}`
    }
    const pay = ld?.salary
    if (pay && !showsPay(description.value, pay)) description.value += `\n\n${pay}`
  }

  const recognized = selected || vacancyPage
  // A guessed field leaves the page partial, so its page text still goes for the CRM's parse.
  const complete = [title, company, description].every((r) => r.status === 'found')
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
