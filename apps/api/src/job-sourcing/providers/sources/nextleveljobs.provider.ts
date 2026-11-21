import { type JsonLdJobPosting, selectByIdentity } from '../../structuring/json-ld'
import { definePagedProvider } from '../api-json.provider'
import { MIN_HOST_GAP_MS, realSleep } from '../html/html-ports'
import type { RawObservationFields } from '../../normalize/observation'
import {
  collectSitemapJsonLd,
  detailsToReadOf,
  hexIdCreatedAtMs,
  mapSitePosting,
  oneAtsHostedJob,
  parseSitemapOf,
  siteIdentityKey,
  type SitemapJob,
  type SitemapJsonLdDeps,
  type SitemapJsonLdSite,
  type SitemapResult,
  sitemapConfigSchema,
  sitemapLimits,
} from './sitemap-jsonld'

export type { SitemapJob, SitemapResult }

/**
 * Next Level Jobs (nextleveljobs.eu), sources-12: a job board that lists every posting in ONE
 * sitemap (`/jobs/sitemap.xml`, ~2 800 `<url>` elements, ~0.5 MB) and describes each on its own
 * page with one JSON-LD `JobPosting`. Parsed deterministically; no model.
 *
 * A DELTA SOURCE. The sitemap carries only URLs, and its `<lastmod>` is useless for freshness
 * (almost every entry is "today"), so a run reads the sitemap, asks the store which postings it
 * already holds (`ctx.heldIdentityKeys`), and fetches the detail page of at most `maxDetails` of
 * the rest, newest first (the 24-hex id starts with a Unix timestamp, so it orders by creation),
 * one slot in five turning through the older unseen ids (`detailsToRead`). A held posting is never
 * re-fetched by this adapter.
 *
 * REQUEST BUDGET (stated, AC1): 1 robots.txt + 1 sitemap + at most 25 detail pages = 27 requests
 * per run, each after the first behind a jittered gap of 3 to 4.5 s (`MIN_HOST_GAP_MS` +
 * `jitteredGapMs`, or the robots crawl-delay when longer), so the adapter never exceeds 0.34
 * requests a second. No redirect is followed (task sources-16, H-2), so none costs a request. The
 * manifest reserves 30 a run (3 to spare) with a host
 * budget of 30 a minute and 60 an hour, and schedules a run every 120 min in working hours.
 *
 * COVERAGE IS NEVER FULL. The run reads the sitemap whole but the details of only the unseen part,
 * so it ends `PAGE_CAP` with no query: SUCCEEDED, PARTIAL coverage. It must never claim
 * FULL_INVENTORY or WINDOW, because the postings it did not re-read would then be closed or
 * expired by the availability reconcilers. Closing a posting that left the sitemap is a follow-up.
 *
 * DEDUP AGAINST ATS SOURCES (AC3). The page's "Apply here" button links the employer's original
 * posting. When every such button names the same ATS-hosted job (`atsJobKey`, scope `ATS_HOSTED`),
 * that URL becomes the observation's `url` and `applicationUrl`: the identity resolver's strong
 * ATS_JOB_KEY then puts this record on the same opportunity as the ATS source's record of that job
 * (a separate source record still exists; it is one opportunity, not two). No button, a non-ATS
 * one, or two distinct jobs: the canonical nextleveljobs.eu URL, and no apply URL.
 *
 * ONLY THE BUTTON, never any link on the page: the description is employer-written HTML (the page
 * renders it as real anchors), and a link in it to ANOTHER job would merge this posting into that
 * job's opportunity. The button is an `<a>` with the `bg-lime-500` class token; the description's
 * anchors carry no class, so one that also reads "Apply here" is not read at all
 * (`applyButtonHrefs`).
 * The resolver's ATS_JOB_KEY match additionally needs the company or the title to agree.
 *
 * SALARY: the observation contract has no compensation field (as for Ashby), and the captured
 * pages carry no `baseSalary`; nothing is invented, and a page with one maps the same.
 */

export const NEXTLEVELJOBS_SOURCE_STATUS = {
  blocked: false,
  permission: 'UNCLEAR',
  reason:
    'permitted by the owner decision of 2026-11-20 (ACCEPT_RISK on UNCLEAR terms; nextleveljobs.eu/jobs/sitemap.xml and the job pages it lists only, no evasion of any block)',
} as const

export const NEXTLEVELJOBS_ADAPTER_VERSION = 'nextleveljobs-1'
export const NEXTLEVELJOBS_HOST = 'nextleveljobs.eu'
export const NEXTLEVELJOBS_SITEMAP_URL = `https://${NEXTLEVELJOBS_HOST}/jobs/sitemap.xml`
export const NEXTLEVELJOBS_NAMESPACE = 'nextleveljobs'
export const NEXTLEVELJOBS_ENDPOINT_VARIANT = 'jobs-sitemap'

export interface NextLevelJobsBounds {
  /** Detail pages fetched per run, at most. */
  readonly maxDetails: number
  /** The floor of the gap before every request after the first. */
  readonly minGapMs: number
}

export const NEXTLEVELJOBS_BOUNDS: NextLevelJobsBounds = {
  maxDetails: 25,
  minGapMs: MIN_HOST_GAP_MS,
}

/**
 * The sitemap's own cap: 4 MiB, about 8.5x the 493 815 bytes (2 840 URLs) captured on 2026-11-20
 * (see the fixture's provenance; a spec pins the ratio), so growth is not an outage.
 */
export const SITEMAP_MAX_BYTES = 4 * 1024 * 1024
const BUTTON_CLASS = 'bg-lime-500'
const BUTTON_TEXT = 'Apply here'
const HREF_MAX_CHARS = 2000
const isSpace = (ch: string | undefined): boolean => /\s/.test(ch ?? '')

/** Whether the `class="` value starting at `from` holds `bg-lime-500` as a whole token. */
function hasButtonClass(html: string, from: number): boolean {
  const close = html.indexOf('"', from)
  // Sliced, so a search for the token never runs past this one value.
  const value = html.slice(from, close === -1 ? html.length : close)
  for (let at = value.indexOf(BUTTON_CLASS); at !== -1; at = value.indexOf(BUTTON_CLASS, at + 1)) {
    const after = at + BUTTON_CLASS.length
    if ((at === 0 || isSpace(value[at - 1])) && (after === value.length || isSpace(value[after]))) {
      // At the value's end the token is followed by its closing quote, or by nothing at all.
      if (after < value.length || close !== -1) return true
    }
  }
  return false
}

/** The `https://` value of the `href="` at `from`, and where its closing quote is; or null. */
function hrefAt(html: string, from: number): { href: string; quote: number } | null {
  if (!html.startsWith('https://', from)) return null
  const start = from + 'https://'.length
  // Past the page's end `html[end]` is undefined: the bound alone ends the scan, with null.
  for (let end = start; end - start <= HREF_MAX_CHARS; end += 1) {
    if (html[end] === '"') return end > start ? { href: html.slice(from, end), quote: end } : null
    if (isSpace(html[end])) return null
  }
  return null
}

/** Where the `</a>` of `>\s*Apply here\s*</a>` that opens at `close` starts, or -1. */
function buttonTextEnd(html: string, close: number): number {
  let at = close + 1
  while (isSpace(html[at])) at += 1
  if (!html.startsWith(BUTTON_TEXT, at)) return -1
  at += BUTTON_TEXT.length
  while (isSpace(html[at])) at += 1
  return html.startsWith('</a>', at) ? at : -1
}

/** Every position in `region` (absolute from `from`) where whitespace and then `name="` stand. */
function attributesIn(html: string, region: string, from: number, name: string): number[] {
  const found: number[] = []
  // From 1: the whitespace before the name must itself lie in the region.
  for (let at = region.indexOf(name, 1); at !== -1; at = region.indexOf(name, at + 1)) {
    if (isSpace(region[at - 1])) found.push(from + at - 1)
  }
  return found
}

interface ButtonRegion {
  /** The first `>` at or after the region's start: no `<a ` tag in the region reads past it. */
  readonly close: number
  /** The button this region's first `<a ` makes, and where its `</a>` starts; or null. */
  readonly button: { readonly href: string; readonly end: number } | null
}

/**
 * The answer for the `<a ` whose tag text starts at `from`: the class and href candidates up to
 * the first `>`, read once. The old regex re-read them for every `<a` (quadratic).
 */
function regionAt(html: string, from: number): ButtonRegion | null {
  const close = html.indexOf('>', from)
  if (close === -1) return null
  const region = html.slice(from, close)
  const classes = attributesIn(html, region, from, 'class="')
  if (!classes.some((at) => hasButtonClass(html, at + ' class="'.length))) {
    return { close, button: null }
  }
  const hrefs = attributesIn(html, region, from, 'href="')
  // Every href whose value stops before `close` closes the tag at `close`: read its text once.
  const atClose = buttonTextEnd(html, close)
  // Greedy like the regex: the LAST href that makes a whole button wins.
  for (const at of [...hrefs].reverse()) {
    const value = hrefAt(html, at + ' href="'.length)
    if (value === null) continue
    // Only the last href's value can run past `close` (an earlier one stops at the next whitespace).
    // Stryker disable next-line EqualityOperator,ConditionalExpression: a quote is never the `>` at close, so `<` and `<=` agree; and for a value that stops before close the next `>` after its quote IS close, so always searching only costs time (quadratic on "one tag of many hrefs", which the 100 ms hostile-page budget fails outside Stryker). Both remaining paths are pinned by the differential spec
    const tagEnd = value.quote < close ? close : html.indexOf('>', value.quote + 1)
    const end = tagEnd === close ? atClose : tagEnd === -1 ? -1 : buttonTextEnd(html, tagEnd)
    if (end !== -1) return { close, button: { href: value.href, end } }
  }
  return { close, button: null }
}

/**
 * The page's own "Apply here" buttons, in page order: an `<a>` carrying the button's
 * `bg-lime-500` class token (both captured buttons do; the employer's description links render as
 * `<a target href>` with no class) and a real `href` attribute, whitespace before each so
 * `data-href` never reads. A linear scan (task sources-16, H-3): it answers exactly what the regex
 * `<a(?=\s)(?=[^>]*\sclass="(?:[^"]*\s)?bg-lime-500[\s"])[^>]*\shref="(https:\/\/[^"\s]{1,2000})"
 * [^>]*>\s*Apply here\s*<\/a>` did (a differential spec pins it), without its quadratic time.
 */
export function applyButtonHrefs(html: string): string[] {
  const hrefs: string[] = []
  for (let open = html.indexOf('<a'); open !== -1;) {
    let next = open + 1
    const from = open + 2
    if (isSpace(html[from])) {
      const region = regionAt(html, from)
      // No `>` after this `<a`: no tag can close, here or later.
      if (region === null) break
      if (region.button === null) {
        // A later `<a ` before `close` reads a subset of these attributes: it cannot match either.
        next = region.close
      } else {
        hrefs.push(region.button.href)
        next = region.button.end
      }
    }
    open = html.indexOf('<a', next)
  }
  return hrefs
}

/** The ONE ATS-hosted job every "Apply here" button names, or null (none, a non-ATS one, two jobs). */
export function employerAtsUrl(html: string): string | null {
  return oneAtsHostedJob(applyButtonHrefs(html).map((href) => href.replaceAll('&amp;', '&')))
}

/** Next Level Jobs on the shared sitemap + JSON-LD adapter (`sitemap-jsonld.ts`). */
export const NEXTLEVELJOBS_SITE: SitemapJsonLdSite = {
  type: 'NEXTLEVELJOBS_HTML',
  adapterVersion: NEXTLEVELJOBS_ADAPTER_VERSION,
  namespace: NEXTLEVELJOBS_NAMESPACE,
  sitemapUrl: NEXTLEVELJOBS_SITEMAP_URL,
  sitemapLimits: sitemapLimits(SITEMAP_MAX_BYTES),
  jobUrl: /^https:\/\/nextleveljobs\.eu\/companies\/[a-z0-9-]{1,100}\/jobs\/([0-9a-fA-F]{24})$/,
  order: 'ID',
  descriptionKind: 'text',
  createdAtMs: hexIdCreatedAtMs,
  select: (postings, job) => selectByIdentity(postings, { url: job.url }),
  applyUrl: employerAtsUrl,
  hasApplyButton: (html) => applyButtonHrefs(html).length > 0,
}

const configSchema = sitemapConfigSchema(NEXTLEVELJOBS_NAMESPACE, 'Next Level Jobs')

/** Every job URL of the sitemap, once each, in document order. A non-job `<loc>` is skipped. */
export const parseSitemap = (bodyText: string): SitemapResult =>
  parseSitemapOf(NEXTLEVELJOBS_SITE, bodyText)

/** The identity key a record of this posting is stored under (the same encoder the store uses). */
export const identityKeyOf = (id: string): string => siteIdentityKey(NEXTLEVELJOBS_SITE, id)

/** The jobs not held yet to read this run (newest first, plus the turning slots), at most `max`. */
export const detailsToRead = (
  jobs: readonly SitemapJob[],
  heldKeys: ReadonlySet<string>,
  max: number,
  turn: number,
): SitemapJob[] => detailsToReadOf(NEXTLEVELJOBS_SITE, jobs, heldKeys, max, turn)

/** The page's JobPosting, mapped, with the employer's ATS job as the apply URL. */
export const mapPosting = (
  posting: JsonLdJobPosting,
  job: SitemapJob,
  html: string,
): RawObservationFields => mapSitePosting(NEXTLEVELJOBS_SITE, posting, job, employerAtsUrl(html))

export type NextLevelJobsDeps = SitemapJsonLdDeps

export function createNextLevelJobsProvider(
  bounds: NextLevelJobsBounds = NEXTLEVELJOBS_BOUNDS,
  deps: NextLevelJobsDeps = { sleep: realSleep, random: Math.random },
) {
  // Stryker disable next-line StringLiteral,ObjectLiteral: manifest.drift.spec.ts reads this literal from the source text; instrumenting it hides the type from that scan, and the registry specs pin the type
  return definePagedProvider({ type: 'NEXTLEVELJOBS_HTML', configSchema }, (config, ctx) =>
    collectSitemapJsonLd(NEXTLEVELJOBS_SITE, bounds, deps, config, ctx),
  )
}

export const nextLevelJobsProvider = createNextLevelJobsProvider()

/** The one host this adapter's requests may reach; a transport is pinned to it. */
export const nextLevelJobsAllowedHosts = (): readonly string[] => [NEXTLEVELJOBS_HOST]
