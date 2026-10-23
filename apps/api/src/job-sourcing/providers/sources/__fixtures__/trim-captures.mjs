// Builds the phase-3.1 fixtures from raw captures. Parser-based end to end: JSON.parse -> select
// whole records by identity -> redact personal data inside string values -> JSON.stringify.
// Never a byte cut. Usage: node trim-captures.mjs <dir-with-raw-captures> <termsCheckedAt-ISO>
// The raw captures are NOT committed; their sha256 (bytes as received) is in each provenance file.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [rawDir, termsCheckedAt] = process.argv.slice(2)
const here = dirname(fileURLToPath(import.meta.url))
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

const dateHeader = (hdrFile) => {
  const line = readFileSync(join(rawDir, hdrFile), 'utf8')
    .split(/\r?\n/)
    .find((l) => l.toLowerCase().startsWith('date:'))
  return new Date(line.slice(5).trim()).toISOString()
}

function emit(provider, name, rawFile, hdrFile, url, produce, meta) {
  const rawBytes = readFileSync(join(rawDir, rawFile))
  const out = JSON.stringify(redact(produce(JSON.parse(rawBytes.toString('utf8')))), null, 2) + '\n'
  const dir = join(here, provider)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.json`), out)
  const prov = {
    url,
    fetchedAt: dateHeader(hdrFile),
    httpStatus: 200,
    rawSha256: sha(rawBytes),
    fileSha256: sha(Buffer.from(out)),
    trimmedBy: `node trim-captures.mjs (JSON.parse, whole-record selection by ${meta.select}, regex redaction of e-mail addresses and separator-bearing phone numbers inside string values, JSON.stringify); never a byte cut`,
    termsUrl: meta.termsUrl,
    termsCheckedAt,
    permission: meta.permission,
    notes: meta.notes,
  }
  writeFileSync(join(dir, `${name}.provenance.json`), JSON.stringify(prov, null, 2) + '\n')
}

const byIds = (ids, key) => (arr) => ids.map((id) => arr.find((x) => String(x[key]) === String(id)))
const REDACTION =
  'E-mail addresses and phone numbers inside string values were replaced by a parser; personal NAMES in free-text descriptions cannot be found by a parser and were not redacted (records were chosen with short descriptions to limit exposure).'

// ---- RemoteOK ----
emit(
  'remoteok',
  'feed',
  'remoteok.json',
  'remoteok.hdr',
  'https://remoteok.com/api',
  (arr) => [arr[0], ...byIds([1137557, 1137550, 1137553, 1137545, 1137542, 1137544], 'id')(arr.slice(1))],
  {
    select: 'id (legal object kept verbatim as element 0)',
    termsUrl: 'https://remoteok.com/api',
    permission: 'PUBLIC_API_DOCUMENTED',
    notes: `Capture had 100 elements (1 legal object + 99 jobs); kept the legal object + 6 jobs. robots.txt (User-agent *) allows / and sets Crawl-delay: 1; it does not disallow /api. The legal object's own text is the terms: link back to the Remote OK URL "with follow, and without nofollow" and mention Remote OK as the source, else API access is suspended; do not use the logo. No pagination: one request returns the latest ~100 jobs. ${REDACTION}`,
  },
)

// ---- Remotive ----
emit(
  'remotive',
  'software-dev',
  'remotive-b.json',
  'remotive-b.hdr',
  'https://remotive.com/api/remote-jobs?category=software-dev',
  (o) => ({ ...o, jobs: byIds([2091158, 1185979, 1749306, 2091132, 2091133, 1680495], 'id')(o.jobs) }),
  {
    select: 'id',
    termsUrl: 'https://remotive.com/api-documentation',
    permission: 'UNCLEAR',
    notes: `Capture had 9 jobs ("job-count"/"total-job-count" 9 retained as received); kept 6. UNCLEAR because the documented API (README + the 0-legal-notice field) grants developer access, but robots.txt (User-agent *) says "Disallow: /api/*" and "Disallow: /*category=" - the two contradict each other and the owner must decide. Terms: link back to the Remotive URL AND mention Remotive as a source or access is terminated; do not submit Remotive jobs to third-party job sites; jobs are delayed by 24 hours; at most ~4 requests/day advised, >2/minute blocked. Observed: the category=software-dev response held jobs of other categories (Marketing, Sales, Writing, IT) and the optional limit=5 parameter was ignored, so the category filter is not a reliable partition of the inventory. publication_date has NO zone designator. ${REDACTION}`,
  },
)

// ---- Himalayas ----
const HIM_TERMS = 'https://himalayas.app/terms#api'
const himNotes = (extra) =>
  `${extra} Terms (API Users clause): every Apply must use applicationLink; show a visible Himalayas credit/link; show jobs only on sites you operate (no passing to other boards/aggregators); cache; remove expired jobs. Clause 30A exempts use of the public API in line with its documentation and rate limits. robots.txt allows /jobs/api (only ?page= HTML listings are disallowed). Data is cached server-side and refreshed every 24 h. Observed drift from the documented schema: locationRestrictions are plain strings (documented as {alpha2,name,slug} objects) and timezoneRestrictions are numbers (documented as strings). ${REDACTION}`
emit(
  'himalayas',
  'browse-page1',
  'him-browse1.json',
  'him-browse1.hdr',
  'https://himalayas.app/jobs/api?limit=20',
  (o) => ({ ...o, jobs: [0, 1, 5, 14, 18, 19].map((i) => o.jobs[i]) }),
  {
    select: 'position in the 20-job page',
    termsUrl: HIM_TERMS,
    permission: 'PUBLIC_API_DOCUMENTED',
    notes: himNotes('Browse endpoint, first page: 20 jobs captured, 6 kept; nextCursor retained as received.'),
  },
)
emit(
  'himalayas',
  'browse-page2',
  'him-browse2.json',
  'him-browse2.hdr',
  'https://himalayas.app/jobs/api?limit=20&cursor=<nextCursor of browse-page1>',
  (o) => ({ ...o, jobs: [0, 3, 15].map((i) => o.jobs[i]) }),
  {
    select: 'position in the 20-job page',
    termsUrl: HIM_TERMS,
    permission: 'PUBLIC_API_DOCUMENTED',
    notes: himNotes('Browse endpoint, second page (cursor taken from page 1 unchanged): 20 jobs captured, 3 kept; nextCursor retained as received.'),
  },
)
emit(
  'himalayas',
  'search-page1',
  'him-search1.json',
  'him-search1.hdr',
  'https://himalayas.app/jobs/api/search?q=python&seniority=Senior&sort=recent&page=1',
  (o) => ({ ...o, jobs: [0, 3, 6, 13].map((i) => o.jobs[i]) }),
  {
    select: 'position in the page',
    termsUrl: HIM_TERMS,
    permission: 'PUBLIC_API_DOCUMENTED',
    notes: himNotes('Search endpoint page 1: the page held 18 jobs although limit is 20 (documented: pages can hold fewer than the limit before the end; stop at the first EMPTY page); 4 kept. The search response carries no nextCursor.'),
  },
)

// ---- Jobicy ----
const JOB_TERMS = 'https://jobicy.com/jobs-rss-feed'
const jobNotes = (extra) =>
  `${extra} Terms (Fair use section): free for commercial use without approval; clearly credit Jobicy as the source with a direct link; application buttons must go to the listing url from the feed; do not present listings as your own postings. robots.txt (User-agent *) does not disallow /api/jobs. Public feed covers the last 7 days with a 3-hour publication delay. ${REDACTION}`
emit(
  'jobicy',
  'seeded-page1',
  'jobicy-seeded.json',
  'jobicy-seeded.hdr',
  'https://jobicy.com/api/jobs?count=100&industry=engineering&geo=europe',
  (o) => ({ ...o, jobCount: 4, jobs: byIds([156602, 156581, 156558, 156544], 'id')(o.jobs) }),
  {
    select: 'id (jobCount rewritten from 100 to the kept 4 so the envelope stays self-consistent)',
    termsUrl: JOB_TERMS,
    permission: 'PUBLIC_API_DOCUMENTED',
    notes: jobNotes('The seeded config query (count=100, industry=engineering, geo=europe) returned HTTP 200: 100 jobs, hasMore true, a 119-character nextCursor.'),
  },
)
emit(
  'jobicy',
  'seeded-page2',
  'jobicy-p2.json',
  'jobicy-p2.hdr',
  'https://jobicy.com/api/jobs?count=100&industry=engineering&geo=europe&cursor=<nextCursor of seeded-page1>',
  (o) => ({ ...o, jobCount: 3, jobs: byIds([155656, 150846, 150933], 'id')(o.jobs) }),
  {
    select: 'id (jobCount rewritten from 17 to the kept 3)',
    termsUrl: JOB_TERMS,
    permission: 'PUBLIC_API_DOCUMENTED',
    notes: jobNotes('Final page: 17 jobs captured, 3 kept; hasMore false, nextCursor null, appliedFilters echoes the incoming cursor. The batch status endpoint (/api/jobs/status) answers {id,status} with active|closed|unknown and is NOT used by this adapter (lifecycle belongs to Task 4.6).'),
  },
)
