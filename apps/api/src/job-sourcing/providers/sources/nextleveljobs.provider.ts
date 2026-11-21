import { z } from 'zod'
import { atsJobKey } from '../../identity/ats-job-key'
import { buildIdentity } from '../../normalize/identity-key'
import {
  buildSourceObservation,
  type RawObservationFields,
  type SourceObservation,
} from '../../normalize/observation'
import { type Random, jitteredGapMs } from '../../scheduling/jitter'
import {
  extractJobPostings,
  type JsonLdJobPosting,
  selectByIdentity,
} from '../../structuring/json-ld'
import { xmlPort } from '../../xml/bounded-xml-port'
import { DEFAULT_XML_LIMITS } from '../../xml/xml-limits'
import { findChildren } from '../../xml/xml-tree'
import { baseSourceConfigSchema, definePagedProvider } from '../api-json.provider'
import { MIN_HOST_GAP_MS, type Sleep, realSleep } from '../html/html-ports'
import {
  buildCollectionBatch,
  buildInvalidSample,
  buildRequestReport,
  type CollectionContext,
  type CollectionCounts,
  type InvalidSample,
  type RequestReport,
  type StopReason,
  type ValidatedCheckpoint,
} from '../reporting-provider'
import { decodeXmlBody } from '../xml-source.provider'
import { createMeteredFetch, type Failure } from './metered-fetch'

/**
 * Next Level Jobs (nextleveljobs.eu), sources-12: a job board that lists every posting in ONE
 * sitemap (`/jobs/sitemap.xml`, ~2 800 `<url>` elements, ~0.5 MB) and describes each on its own
 * page with one JSON-LD `JobPosting`. Parsed deterministically; no model.
 *
 * A DELTA SOURCE. The sitemap carries only URLs, and its `<lastmod>` is useless for freshness
 * (almost every entry is "today"), so a run reads the sitemap, asks the store which postings it
 * already holds (`ctx.heldIdentityKeys`), and fetches the detail page of at most `maxDetails` of
 * the rest, newest first (the 24-hex id starts with a Unix timestamp, so it orders by creation).
 * A held posting is never re-fetched by this adapter.
 *
 * REQUEST BUDGET (stated, AC1): 1 sitemap + at most 25 detail pages = 26 requests per run, each
 * after a jittered gap of 3 to 4.5 s (`MIN_HOST_GAP_MS` + `jitteredGapMs`), so the adapter never
 * exceeds 0.34 requests a second. The manifest reserves 30 a run (4 for redirects) with a host
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
 * job's opportunity. A description anchor that also reads "Apply here" and names a different job
 * makes two distinct jobs, so the answer is null: dedup is lost for that posting, never poisoned.
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

/** The sitemap's own cap: 8x the captured size, so growth is not an outage. */
export const SITEMAP_MAX_BYTES = 4 * 1024 * 1024
const SITEMAP_LIMITS = { ...DEFAULT_XML_LIMITS, maxBytes: SITEMAP_MAX_BYTES }
const JOB_URL = /^https:\/\/nextleveljobs\.eu\/companies\/[a-z0-9-]{1,100}\/jobs\/([0-9a-f]{24})$/
const APPLY_BUTTON = /<a\b[^>]*\bhref="(https:\/\/[^"\s]{1,2000})"[^>]*>\s*Apply here\s*<\/a>/g

const configSchema = baseSourceConfigSchema
  .extend({ namespace: z.literal(NEXTLEVELJOBS_NAMESPACE).default(NEXTLEVELJOBS_NAMESPACE) })
  .strict()
  .refine((c) => c.query === null, { message: 'Next Level Jobs has no search parameter' })
  .refine((c) => c.window === null, { message: 'Next Level Jobs has no date window' })
type Config = z.infer<typeof configSchema>

export interface SitemapJob {
  readonly id: string
  readonly url: string
}

export type SitemapResult =
  | { readonly ok: true; readonly jobs: SitemapJob[] }
  | { readonly ok: false; readonly message: string }

/** Every job URL of the sitemap, once each, in document order. A non-job `<loc>` is skipped. */
export function parseSitemap(bodyText: string): SitemapResult {
  const decoded = decodeXmlBody(bodyText, SITEMAP_LIMITS, xmlPort)
  if (!decoded.ok) return { ok: false, message: decoded.message }
  const root = decoded.value.root
  if (root.localName !== 'urlset') return { ok: false, message: `root is <${root.localName}>` }
  const seen = new Set<string>()
  const jobs: SitemapJob[] = []
  for (const entry of findChildren(root, 'url')) {
    const loc = findChildren(entry, 'loc')[0]
    // Stryker disable next-line StringLiteral: any fallback fails JOB_URL the same way; the missing-<loc> case is tested
    const url = loc?.text.trim() ?? ''
    const id = JOB_URL.exec(url)?.[1]
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    jobs.push({ id, url })
  }
  return { ok: true, jobs }
}

/** The identity key a record of this posting is stored under (the same encoder the store uses). */
export function identityKeyOf(id: string): string {
  const built = buildIdentity({
    provider: 'NEXTLEVELJOBS_HTML',
    namespace: NEXTLEVELJOBS_NAMESPACE,
    nativeId: id,
    url: null,
  })
  // Stryker disable next-line ConditionalExpression,StringLiteral: a 24-hex id under a constant namespace always builds; the throw (and its message) guards the encoder, not the input
  if (!built.ok) throw new Error(`no identity for ${id}: ${built.reason}`)
  return built.identity.identityKey
}

/** The jobs not held yet, newest id first, at most `max`. */
export function unseenNewestFirst(
  jobs: readonly SitemapJob[],
  heldKeys: ReadonlySet<string>,
  max: number,
): SitemapJob[] {
  return (
    jobs
      .filter((j) => !heldKeys.has(identityKeyOf(j.id)))
      // Lowercase hex ids: collation order is code-point order. A ternary comparator here has mutants
      // V8's insertion sort cannot tell apart (a 0 for "less" sorts the same as a 1).
      .sort((a, b) => b.id.localeCompare(a.id))
      .slice(0, max)
  )
}

/** The ONE ATS-hosted job every "Apply here" button names, or null (none, a non-ATS one, two jobs). */
export function employerAtsUrl(html: string): string | null {
  const found = new Map<string, string>()
  for (const match of html.matchAll(APPLY_BUTTON)) {
    const url = match[1]!.replaceAll('&amp;', '&')
    const key = atsJobKey(url)
    if (key === null || key.scope !== 'ATS_HOSTED') return null
    if (!found.has(key.key)) found.set(key.key, url)
  }
  return found.size === 1 ? [...found.values()][0]! : null
}

/** The page's JobPosting, mapped. `null` when the page has no posting for this URL. */
export function mapPosting(
  posting: JsonLdJobPosting,
  job: SitemapJob,
  html: string,
): RawObservationFields {
  const employer = employerAtsUrl(html)
  return {
    provider: 'NEXTLEVELJOBS_HTML',
    adapterVersion: NEXTLEVELJOBS_ADAPTER_VERSION,
    namespace: NEXTLEVELJOBS_NAMESPACE,
    nativeId: job.id,
    url: employer ?? posting.url ?? job.url,
    title: posting.title,
    companyName: posting.hiringOrganization,
    location: posting.jobLocations.length > 0 ? posting.jobLocations.join('; ') : null,
    description: posting.description,
    descriptionKind: 'text',
    remote: posting.jobLocationType === 'TELECOMMUTE' ? true : null,
    employmentType: posting.employmentType[0] ?? null,
    tags: posting.skills,
    applicationUrl: employer,
    dates: [
      ...(posting.datePosted === null
        ? []
        : [
            {
              raw: posting.datePosted.raw,
              contract: 'ISO_ZONED' as const,
              semantics: 'PUBLISHED' as const,
            },
          ]),
      ...(posting.validThrough === null
        ? []
        : [
            {
              raw: posting.validThrough.raw,
              contract: 'ISO_ZONED' as const,
              semantics: 'EXPIRY' as const,
            },
          ]),
    ],
  }
}

const emptyCounts = (): CollectionCounts => ({
  raw: 0,
  normalized: 0,
  invalid: 0,
  quarantined: 0,
  discarded: 0,
})

const scopeOf = (config: Config) => ({
  namespace: config.namespace,
  query: null,
  configVersion: config.configVersion,
  window: null,
})

export interface NextLevelJobsDeps {
  readonly sleep: Sleep
  readonly random: Random
}

async function collectNextLevelJobs(
  bounds: NextLevelJobsBounds,
  deps: NextLevelJobsDeps,
  config: Config,
  ctx: CollectionContext,
) {
  const scope = scopeOf(config)
  const observations: SourceObservation[] = []
  const requests: RequestReport[] = []
  const samples: InvalidSample[] = []
  const counts = emptyCounts()
  let checkpoint: ValidatedCheckpoint | null = null
  let pagesCompleted = 0
  let stop: StopReason = 'PAGE_CAP'

  const report = (
    at: number,
    url: string,
    status: number | null,
    startedAt: Date,
    cost: RequestReport['cost'],
    error: Failure | null,
  ) =>
    requests.push(
      buildRequestReport(
        {
          attempt: 1,
          page: at,
          url,
          status,
          startedAt,
          endedAt: ctx.now(),
          cost,
          error: error === null ? null : { code: error.code, message: error.message },
        },
        ctx.secrets,
      ),
    )
  const metered = createMeteredFetch(ctx, 1 + bounds.maxDetails, report)
  const finish = () =>
    buildCollectionBatch({
      observations,
      // Every run lists the sitemap whole and never resumes from a stored position. It always ends
      // on PAGE_CAP or a failure, so its coverage is PARTIAL whatever this flag says.
      // Stryker disable next-line BooleanLiteral: unobservable, see above (deriveCoverage)
      facts: { stop, pagesCompleted, counts, scope, resumed: false },
      requests,
      checkpoint,
      invalidSamples: samples,
    })

  const listed = await metered(
    1,
    {
      url: NEXTLEVELJOBS_SITEMAP_URL,
      headers: { accept: 'application/xml' },
      maxBytes: SITEMAP_MAX_BYTES,
    },
    false,
  )
  if (!listed.ok) {
    stop = listed.stop
    return finish()
  }
  const sitemap = parseSitemap(listed.bodyText)
  report(
    1,
    NEXTLEVELJOBS_SITEMAP_URL,
    listed.status,
    listed.startedAt,
    listed.cost,
    sitemap.ok
      ? null
      : { code: 'PARSE_DRIFT', message: `sitemap: ${sitemap.message}`, status: listed.status },
  )
  if (!sitemap.ok) {
    stop = 'ERROR'
    return finish()
  }

  let held: ReadonlySet<string>
  try {
    held = (await ctx.heldIdentityKeys?.(sitemap.jobs.map((j) => identityKeyOf(j.id)))) ?? new Set()
  } catch (error) {
    report(1, NEXTLEVELJOBS_SITEMAP_URL, listed.status, ctx.now(), null, {
      code: 'PERSISTENCE',
      message: `the held postings could not be read: ${error instanceof Error ? error.message : 'the store failed'}`,
      status: null,
    })
    stop = 'ERROR'
    return finish()
  }

  let page = 1
  for (const job of unseenNewestFirst(sitemap.jobs, held, bounds.maxDetails)) {
    page += 1
    try {
      await deps.sleep(jitteredGapMs(bounds.minGapMs, deps.random), ctx.signal)
    } catch {
      report(page, job.url, null, ctx.now(), null, {
        code: 'CANCELLED',
        message: 'the run was cancelled before this request',
        status: null,
      })
      stop = 'CANCELLED'
      break
    }
    const fetched = await metered(page, { url: job.url, headers: { accept: 'text/html' } }, true)
    if (!fetched.ok) {
      stop = fetched.stop
      break
    }
    report(page, job.url, fetched.status, fetched.startedAt, fetched.cost, null)
    // A 404 is an answer: the posting left between the sitemap and its page. Nothing to record.
    if (fetched.status === 404) continue
    counts.raw += 1
    const selected = selectByIdentity(
      extractJobPostings(fetched.bodyText, { now: ctx.now() }).postings,
      { url: job.url },
    )
    if (selected.kind !== 'match') {
      counts.invalid += 1
      samples.push(
        buildInvalidSample(page, `json-ld: ${selected.kind}`, { url: job.url }, ctx.secrets),
      )
      continue
    }
    const built = buildSourceObservation(mapPosting(selected.posting, job, fetched.bodyText), {
      now: ctx.now(),
    })
    if (!built.ok) {
      counts.quarantined += 1
      samples.push(buildInvalidSample(page, built.reason, { url: job.url }, ctx.secrets))
      continue
    }
    const next: ValidatedCheckpoint = {
      configVersion: config.configVersion,
      policyVersion: ctx.policyVersion,
      adapterVersion: NEXTLEVELJOBS_ADAPTER_VERSION,
      position: { kind: 'RESTART', page },
      completedAt: ctx.now(),
    }
    try {
      await ctx.checkpoints.savePage({ observations: [built.observation], checkpoint: next })
    } catch (error) {
      counts.discarded += 1
      report(page, job.url, fetched.status, ctx.now(), null, {
        code: 'PERSISTENCE',
        message: error instanceof Error ? error.message : 'the page could not be persisted',
        status: fetched.status,
      })
      stop = 'ERROR'
      break
    }
    counts.normalized += 1
    observations.push(built.observation)
    checkpoint = next
    pagesCompleted += 1
  }
  // Drift, not bad luck: most pages read had no usable posting. Fails the run so health sees it.
  if (stop === 'PAGE_CAP' && counts.invalid > counts.normalized && counts.invalid >= 3) {
    report(page, NEXTLEVELJOBS_SITEMAP_URL, null, ctx.now(), null, {
      code: 'PARSE_DRIFT',
      message: `${counts.invalid} of ${counts.raw} job pages had no matching JSON-LD JobPosting`,
      status: null,
    })
    stop = 'ERROR'
  }
  return finish()
}

export function createNextLevelJobsProvider(
  bounds: NextLevelJobsBounds = NEXTLEVELJOBS_BOUNDS,
  deps: NextLevelJobsDeps = { sleep: realSleep, random: Math.random },
) {
  // Stryker disable next-line StringLiteral,ObjectLiteral: manifest.drift.spec.ts reads this literal from the source text; instrumenting it hides the type from that scan, and the registry specs pin the type
  return definePagedProvider({ type: 'NEXTLEVELJOBS_HTML', configSchema }, (config, ctx) =>
    collectNextLevelJobs(bounds, deps, config, ctx),
  )
}

export const nextLevelJobsProvider = createNextLevelJobsProvider()

/** The one host this adapter's requests may reach; a transport is pinned to it. */
export const nextLevelJobsAllowedHosts = (): readonly string[] => [NEXTLEVELJOBS_HOST]
