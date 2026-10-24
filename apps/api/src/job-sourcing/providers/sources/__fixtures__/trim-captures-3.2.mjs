// Builds the Task 3.2 fixtures from the raw captures committed in ../__raw-captures__/3.2 (gzip over
// 300 KB, lossless). Parser-based end to end: JSON.parse -> select WHOLE records by identity ->
// redact personal data inside string values -> JSON.stringify -> prettier. Never a byte cut.
// Usage: node trim-captures-3.2.mjs <termsCheckedAt-ISO>   (the committed fixtures used 2026-10-24T03:00:00.000Z;
// a different value rewrites `termsCheckedAt` in every provenance file it regenerates).
// `termsCheckedAt` is ONE value for every file: the DATE (2026-10-24) is when the terms were read, the time of day is a
// single stand-in, not a per-file clock reading.
// A section whose raw capture is not in __raw-captures__/3.2/ is SKIPPED, not failed: only the Jobgether,
// Arbeitnow empty-page and terms/robots captures are kept; the Hacker News, Working Nomads and Arbeitnow page ones are not.
// The Arbeitnow page 1/2 captures (an-p1, an-p2) are NOT committed any more: they held recruiters' personal
// data. IF YOU CAPTURE ANY OF THESE AGAIN LOCALLY AND RUN THIS SCRIPT, it regenerates files that were later
// edited by hand, and the new profile-link test will catch only part of it. Restore afterwards: (1) the RAW
// REMOVED sentence in arbeitnow/page-1.provenance.json; (2) the x-slug redactions of personal LinkedIn links
// in hn-hiring/thread-2026-10.json and thread-2019-05.json, with their fileSha256 and LATER HAND REDACTION
// notes; (3) the x-slug in __raw-captures__/3.2/an-terms.html. `git diff` after the run shows all of it.
// `rawSha256` is the sha256 of the bytes as RECEIVED (the decompressed capture).
//
// RAW CAPTURES THAT CARRY COMMENT OR OTHER USER-SUBMITTED TEXT ARE NEVER COMMITTED (task 3.1's
// script says the same of its captures). The first version of this directory committed the three
// Hacker News thread captures, which hold 462 other people's e-mail addresses, to a public
// repository (PR #1120): the trimmed fixtures were redacted and scanned, the raw directory sat
// outside every check. `fixture-provenance.spec.ts` now scans the whole tree and fails on any
// address. Consequently the three hn-hiring thread fixtures below are NOT reproducible from the
// repository: capture the threads again into __raw-captures__/3.2/ (locally, uncommitted), run this
// script, and delete the raw files before committing. Their provenance files record the hashes.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import * as prettier from 'prettier'

const [termsCheckedAt] = process.argv.slice(2)
const here = dirname(fileURLToPath(import.meta.url))
const rawDir = join(here, '..', '__raw-captures__', '3.2')
const sha = (b) => createHash('sha256').update(b).digest('hex')

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
// A phone needs a separator between digit groups, so bare ids inside URLs are left alone.
const PHONE =
  /\(\d{3}\)\s?\d{3}[ .-]\d{4}|(?<![\w/=.-])\+?\d{1,3}[ ().-]\(?\d{2,4}\)?[ .-]\d{2,4}(?:[ .-]\d{2,4})?(?![\w/])/g
const redactString = (s) =>
  s.replace(EMAIL, 'redacted@example.invalid').replace(PHONE, '[redacted-phone]')
const redact = (v) =>
  typeof v === 'string'
    ? redactString(v)
    : Array.isArray(v)
      ? v.map(redact)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)]))
        : v

/** The bytes as received: `<name>` or `<name>.gz` in the capture directory. */
function readRaw(name) {
  const plain = join(rawDir, name)
  if (existsSync(plain)) return readFileSync(plain)
  return existsSync(`${plain}.gz`) ? gunzipSync(readFileSync(`${plain}.gz`)) : null
}
const dateHeader = (hdrFile) => {
  const line = readFileSync(join(rawDir, hdrFile), 'utf8')
    .split(/\r?\n/)
    .find((l) => l.toLowerCase().startsWith('date:'))
  return new Date(line.slice(5).trim()).toISOString()
}

// The repo's pre-commit hook runs prettier over committed JSON, so the bytes hashed as
// `fileSha256` must already be prettier-stable or the hash would describe a file never committed.
async function format(text, filepath) {
  const options = (await prettier.resolveConfig(filepath)) ?? {}
  return prettier.format(text, { ...options, filepath })
}

async function emit(provider, name, rawFile, hdrFile, url, produce, meta) {
  const rawBytes = readRaw(rawFile)
  if (rawBytes === null) {
    console.log(`skipped ${provider}/${name}: ${rawFile} is not committed`)
    return
  }
  const dir = join(here, provider)
  mkdirSync(dir, { recursive: true })
  const out = await format(
    JSON.stringify(redact(produce(JSON.parse(rawBytes.toString('utf8'))))),
    join(dir, `${name}.json`),
  )
  writeFileSync(join(dir, `${name}.json`), out)
  const prov = {
    url,
    fetchedAt: dateHeader(hdrFile),
    httpStatus: 200,
    rawSha256: sha(rawBytes),
    fileSha256: sha(Buffer.from(out)),
    trimmedBy: `node trim-captures-3.2.mjs (JSON.parse, whole-record selection by ${meta.select}, regex redaction of e-mail addresses and separator-bearing phone numbers inside string values, JSON.stringify, prettier); never a byte cut`,
    termsUrl: meta.termsUrl,
    termsCheckedAt,
    permission: meta.permission,
    notes: meta.notes,
  }
  writeFileSync(
    join(dir, `${name}.provenance.json`),
    await format(JSON.stringify(prov), join(dir, `${name}.provenance.json`)),
  )
}

const REDACTION =
  'E-mail addresses and phone numbers inside string values were replaced by a parser; personal NAMES in free-text cannot be found by a parser and were not redacted (records were chosen with short text to limit exposure).'
const pick = (indexes) => (arr) => indexes.map((i) => arr[i])
const byIds = (ids, key) => (arr) => ids.map((id) => arr.find((x) => String(x[key]) === String(id)))

// ---- Arbeitnow ----
const AN_TERMS = 'https://www.arbeitnow.com/terms'
const UNV_AN =
  ' UNVERIFIABLE FROM THIS REPOSITORY (measured 2026-10-24, evidence not committed): that per_page, limit, page_size, size and perPage are ignored (the five responses were not kept), and the sizes of pages 10 (1510962 bytes), 20 (923504) and the emptiness of page 40; only pages 1, 2 and the empty page 100 are committed.'
const anNotes = (extra) =>
  `${extra} Terms section 11 (API): "You also agree to providing a link back to Arbeitnow.com on your platform. We may revoke the permission to use API at any time." The API envelope itself says: "This is a free public API for jobs, please do not abuse. I would appreciate linking back to the site." robots.txt (User-agent *) has an empty Disallow, plus Disallow: /*?__hstc. BLOCKED ON THE BYTE CAP: live page 1 is 4209793 bytes decoded (2 MiB cap = 2097152), page 2 is 2311796; the page size is not selectable (per_page, limit, page_size, size and perPage were tried and ignored; each returned the same ~1.83 MB gzip body); pages 10 and 20 fit (1510962, 923504). Pages are 300/300/250/150 items and \`links.last\` is always null.${UNV_AN} ${REDACTION}`
await emit(
  'arbeitnow',
  'page-1',
  'an-p1.raw',
  'an-p1.hdr',
  'https://www.arbeitnow.com/api/job-board-api?page=1',
  (o) => ({ ...o, data: pick([0, 207, 208, 204, 43, 180, 263])(o.data) }),
  {
    select: 'position in the 300-job page',
    termsUrl: AN_TERMS,
    permission: 'PUBLIC_API_DOCUMENTED',
    notes: anNotes(
      'Page 1: 300 jobs captured, 7 kept; meta and links retained as received (meta.per_page 300, meta.to 300).',
    ),
  },
)
await emit(
  'arbeitnow',
  'empty-page',
  'an-p100.raw',
  'an-p20.hdr',
  'https://www.arbeitnow.com/api/job-board-api?page=100',
  (o) => o,
  {
    select: 'none (whole body kept)',
    termsUrl: AN_TERMS,
    permission: 'PUBLIC_API_DOCUMENTED',
    notes: anNotes(
      'A page past the end: data is [], links.next is null, meta.per_page 0. The capture has no header file of its own, so fetchedAt is taken from the sibling an-p20 capture made in the same minute.',
    ),
  },
)

// ---- Jobgether ----
const JG_TERMS = 'https://jobgether.com/terms-of-use'
const UNV_JG =
  ' UNVERIFIABLE FROM THIS REPOSITORY (read 2026-10-24, not committed): the OpenAPI limits `limit` <= 25 and `page` capped at 10, and the llms.txt statements about versioning; the OpenAPI document itself was not kept. The 25-per-page figure is also visible in every committed page (pagination.limit 25), the cap of 10 only in the OpenAPI text and in page 10 still saying hasMore: true.'
const jgNotes = (extra) =>
  `${extra} CONTRADICTORY, hence UNCLEAR. Terms of use (read 2026-10-24 by an AI coding agent, not legal advice; no review by a lawyer or the owner is recorded here; last updated 7 September 2026) clause 4.5: "refrain from accessing the Platform or extracting its content by automated means (bots, scrapers, crawlers)" and "from using Platform content to train, fine-tune or operate machine-learning models"; section 9: "All acts of extraction, data mining, scraping and similar acts ... are strictly prohibited." Against that, the API itself is documented as public, unauthenticated and "intended for AI agents/assistants" (https://jobgether.com/llms.txt, https://jobgether.com/openapi.json, https://jobgether.com/astroapi/ai/jobs/docs). robots.txt Allows /astroapi/ai/jobs.json (with a query) and Disallows /*?* elsewhere, sets Crawl-delay: 2 and Content-Signal: search=yes, ai-input=yes, ai-train=no. UNVERIFIABLE FROM THIS REPOSITORY: the terms page returned HTTP 403 to this honest user agent, so the clause text was read by an AI coding agent through a separate fetch tool on 2026-10-24 (not legal advice; no review by a lawyer or the owner is recorded here) and no capture of it is committed; re-read https://jobgether.com/terms-of-use before relying on the quote. Rate limit header: ratelimit-policy "ai-jobs";q=60;w=60. The listing carries NO description; no detail endpoint is documented. No personal data: company names and job titles only.${UNV_JG}`
await emit(
  'jobgether',
  'page-1',
  'jg-p1.raw',
  'jg-p1.hdr',
  'https://jobgether.com/astroapi/ai/jobs.json?sort=date&limit=25&page=1',
  (o) => o,
  {
    select: 'none (whole page kept)',
    termsUrl: JG_TERMS,
    permission: 'UNCLEAR',
    notes: jgNotes(
      "Page 1 of the date-sorted browse: 25 jobs, hasMore true. The exact request URL was not recorded by the capturing session; the query is reconstructed from the response's own browseOnSiteUrl (limit=25&page=1&sort=date).",
    ),
  },
)
await emit(
  'jobgether',
  'page-10',
  'jg-p10.raw',
  'jg-p10.hdr',
  'https://jobgether.com/astroapi/ai/jobs.json?sort=date&limit=25&page=10',
  (o) => o,
  {
    select: 'none (whole page kept)',
    termsUrl: JG_TERMS,
    permission: 'UNCLEAR',
    notes: jgNotes(
      'Page 10, the last page the OpenAPI allows ("Capped at 10"): still hasMore true, so the cap, not the inventory, ends a walk (at most 250 jobs per query).',
    ),
  },
)
await emit(
  'jobgether',
  'no-results',
  'jg-none.raw',
  'jg-none.hdr',
  'https://jobgether.com/astroapi/ai/jobs.json?keyword=qzxwvkjh&limit=25&sort=date',
  (o) => o,
  {
    select: 'none (whole body kept)',
    termsUrl: JG_TERMS,
    permission: 'UNCLEAR',
    notes: jgNotes('A keyword nothing matches: jobs [], hasMore false.'),
  },
)
await emit(
  'jobgether',
  'deprecated-path',
  'jg-depr.raw',
  'jg-depr.hdr',
  'https://jobgether.com/astroapi/ai/jobs?limit=10',
  (o) => ({ ...o, jobs: pick([0, 1, 2])(o.jobs) }),
  {
    select: 'position in the 10-job page',
    termsUrl: JG_TERMS,
    permission: 'UNCLEAR',
    notes: jgNotes(
      'The SUPERSEDED path /astroapi/ai/jobs (the OpenAPI names it as the live deprecation example): same shape plus a deprecation object {deprecated, message, successor, since, sunset} and the Deprecation / Sunset / Link: rel="successor-version" headers (Deprecation: @1787875200, Sunset: Mon, 28 Sep 2026 00:00:00 GMT). 10 jobs captured, 3 kept; the exact request URL was not recorded and is reconstructed from the OpenAPI text and limit 10. ROBOTS: that URL (/astroapi/ai/jobs?limit=10) has a query string and is NOT the path robots.txt Allows (/astroapi/ai/jobs.json?*); Disallow: /*?* covers it, so this one capture was taken from a robots-disallowed URL. It is kept as the only authentic example of the deprecation object; the owner decides whether it stays (the second such capture in this phase, after Remotive).',
    ),
  },
)

// ---- Working Nomads: NO job fixture (permission UNCLEAR). The only artifact is the terms page. ----
const wnTerms = readRaw('wn-terms.html')
if (wnTerms !== null) {
  const bytes = wnTerms
  const dir = join(here, 'workingnomads')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'terms.html.txt'), bytes)
  writeFileSync(
    join(dir, 'terms.html.provenance.json'),
    await format(
      JSON.stringify({
        url: 'https://www.workingnomads.com/terms',
        // The capture has no header file; the minute is taken from the capture's modification time (05:06 local, UTC+3).
        fetchedAt: '2026-10-24T02:06:00.000Z',
        httpStatus: 200,
        rawSha256: sha(bytes),
        fileSha256: sha(bytes),
        trimmedBy:
          'none: the terms page is committed byte for byte (terms.html.txt); NO job data was captured or is kept for this source',
        termsUrl: 'https://www.workingnomads.com/terms',
        termsCheckedAt,
        permission: 'UNCLEAR',
        notes:
          'The artifact is the TERMS page, not a vacancy fixture: the plan blocks this source until documented/approved use, and "public JSON is not permission". The Terms of Service (headings 1-11: acceptance, user content, subscriptions, termination, liability, final provisions) contain no clause on automated access, scraping, an API or reuse of job listings either way; the only mention of automation is "We do not use automated decision-making tools". robots.txt (User-agent *) has an empty Disallow, i.e. allows everything. The site footer links "API" to /api/exposed_jobs/ - which is the JSON endpoint itself, not a documentation or terms page (a GET of it, kept out of the repository, answered 200 application/json, allow: GET, HEAD, OPTIONS, 189828 bytes, a bare array of listings with url/title/description). A link labelled API is a hint of intent, not a grant: no terms govern its use, so the owner must decide or ask the site. Clauses that bear on the owner\'s question although none addresses automation: 2.2 grants only "a limited, non-exclusive, non-transferable right to access and use the Platform and its functionalities for their intended purpose"; 3.1(b) forbids "Resell, sublicense, or otherwise commercially exploit the Service"; 3.1(d) forbids "Access or use the Service to build a competitive product or service". Whether feeding listings into a recruiting CRM falls under "intended purpose", "commercially exploit" or "competitive product" is a reading of those clauses, not something the page settles. VERDICT BASIS: headings 1-11 of this page were read on 2026-10-24 by an AI coding agent and confirmed by a reviewing agent (not legal advice; no review by a lawyer or the owner is recorded here), who found no clause on automated access, an API or reuse of listings; this file pins the page as read (fileSha256) and the unit tests only add a keyword screen, which is not a proof of absence.',
      }),
      join(dir, 'terms.html.provenance.json'),
    ),
  )
}

// ---- Hacker News (Algolia) ----
const HN_TERMS = 'https://www.ycombinator.com/legal/'
const UNV_HN =
  " UNVERIFIABLE FROM THIS REPOSITORY: that none of the 1331 top-level comments in the three threads read (816 + 266 + 249) was deleted; those captures were removed because they held commenters' e-mail addresses."
const hnNotes = (extra) =>
  `${extra} UNCLEAR: the Y Combinator terms (https://www.ycombinator.com/legal/, "Site") say "you will not engage in or use any data mining, robots, scraping or similar data gathering or extraction methods", while the HN Search API on Algolia (https://hn.algolia.com/api) is a public, unauthenticated, documented endpoint. No capture of the terms page is committed; the quote was read at that URL on 2026-10-24 by an AI coding agent (not legal advice; no review by a lawyer or the owner is recorded here) and is unverifiable from this repository. Whether that API counts as "the Site" is a question for the owner, which was put to him and is unanswered, so the source stays blocked. robots.txt of news.ycombinator.com sets Crawl-delay: 30 and does not disallow /item; hn.algolia.com serves no robots.txt (404). ${UNV_HN} Employers are NOT given by the API: a comment is free text whose first paragraph is a header, so every observation is tagged employer-unverified. ${REDACTION}`
await emit(
  'hn-hiring',
  'search',
  'hn-search.raw',
  'hn-search.hdr',
  'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10',
  (o) => ({ ...o, hits: pick([0, 1, 2, 3])(o.hits), hitsPerPage: 4 }),
  {
    select: 'position in the 10-hit page (hitsPerPage rewritten from 10 to the kept 4)',
    termsUrl: HN_TERMS,
    permission: 'UNCLEAR',
    notes: hnNotes(
      'search_by_date for the whoishiring account: 512 stories exist, the first page of 10 was captured, the newest 4 kept (October and September 2026, each as a "Who is hiring?" and a "Who wants to be hired?" pair).',
    ),
  },
)
await emit(
  'hn-hiring',
  'thread-2026-10',
  'hn-item-oct.raw',
  'hn-item-oct.hdr',
  'https://hn.algolia.com/api/v1/items/49922569',
  (o) => ({
    ...o,
    children: byIds(
      [49922584, 49922609, 49922615, 49922711, 49923426, 49924849, 49925544, 49926031],
      'id',
    )(o.children),
  }),
  {
    select: 'comment id (top-level, each with its nested replies as received)',
    termsUrl: HN_TERMS,
    permission: 'UNCLEAR',
    notes: hnNotes(
      'items/49922569, "Ask HN: Who is hiring? (October 2026)": 266 top-level comments (480084 bytes), 8 kept. They cover a header without a pipe (49922584, with one nested reply), pipe headers (49922609), multi-role headers (49922615, 49922711), a header whose first segment is the location (49923426), and two commentary comments that are not vacancies (49924849 with 5 nested replies, 49925544).',
    ),
  },
)
await emit(
  'hn-hiring',
  'thread-2026-09',
  'hn-item-sep.raw',
  'hn-item-sep.hdr',
  'https://hn.algolia.com/api/v1/items/49522897',
  (o) => ({ ...o, children: byIds([49540382, 49615973], 'id')(o.children) }),
  {
    select: 'comment id',
    termsUrl: HN_TERMS,
    permission: 'UNCLEAR',
    notes: hnNotes(
      'items/49522897, "Ask HN: Who is hiring? (September 2026)": 249 top-level comments, 2 kept, both with the location as the first segment ("NYC | ONSITE (hybrid) ...", "Remote (US) Close (...) | ...").',
    ),
  },
)
await emit(
  'hn-hiring',
  'thread-2019-05',
  'hn-item-2019.raw',
  'hn-item-2019.hdr',
  'https://hn.algolia.com/api/v1/items/19797594',
  (o) => ({ ...o, children: byIds([19797758, 19800045, 19815745, 19798344], 'id')(o.children) }),
  {
    select: 'comment id',
    termsUrl: HN_TERMS,
    permission: 'UNCLEAR',
    notes: hnNotes(
      'items/19797594, "Ask HN: Who is hiring? (May 2019)": 816 top-level comments (1402131 bytes, the largest thread seen), 4 kept: location-first ("London, UK | TESSIAN"), remote-negated ("Onsite Only", "ONSITE only") and a header where "Remote OK" is followed by "No Visa".',
    ),
  },
)
console.log('done')
