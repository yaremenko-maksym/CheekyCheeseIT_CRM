// Builds the Task 3.5b The Muse fixtures from raw captures. Parser-based end to end: JSON.parse ->
// select whole records by id -> redact personal data inside string values -> JSON.stringify.
// Never a byte cut. Usage: node trim-muse-captures.mjs <dir-with-raw-captures> <termsCheckedAt-ISO>
// The raw captures are NOT committed; their sha256 (bytes as received) is in each provenance file.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as prettier from 'prettier'

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

// The repo's pre-commit hook runs prettier over committed JSON, so the bytes hashed as
// `fileSha256` must already be prettier-stable or the hash would describe a file never committed.
async function format(text, filepath) {
  const options = (await prettier.resolveConfig(filepath)) ?? {}
  return prettier.format(text, { ...options, filepath })
}

const REDACTION =
  'E-mail addresses and phone numbers inside string values were replaced by a parser; personal NAMES in free-text descriptions cannot be found by a parser and were not redacted (records were chosen with short descriptions to limit exposure).'

const TERMS = [
  'Terms (https://www.themuse.com/developers/api/v2/terms, read 2026-10-24): section 2.2 requires the app to be REGISTERED through the developer portal before it accesses the API;',
  'section 3.1 grants a limited, revocable right to use Muse Content "to the extent needed to format and display Muse Content through the Apps";',
  'section 3.4 requires displayed content to link back to www.themuse.com; section 3.3(g) forbids cloning Muse Content; section 4.3(d) forbids scraping the website;',
  'section 4.2 forbids exceeding rate limits (500 requests/hour without a key, 3600 with one, per the developer page).',
  'Nothing in the terms addresses storing postings in an applicant-tracking database, and no registered app exists for this CRM, so permission to ingest is UNCLEAR.',
  'robots.txt (User-agent *) does not disallow /api/public/.',
].join(' ')

async function emit(name, rawFile, hdrFile, url, httpStatus, produce, notes) {
  const rawBytes = readFileSync(join(rawDir, rawFile))
  const dir = join(here, 'muse')
  mkdirSync(dir, { recursive: true })
  const out = await format(
    JSON.stringify(redact(produce(JSON.parse(rawBytes.toString('utf8'))))),
    join(dir, `${name}.json`),
  )
  writeFileSync(join(dir, `${name}.json`), out)
  const prov = {
    url,
    fetchedAt: dateHeader(hdrFile),
    httpStatus,
    rawSha256: sha(rawBytes),
    fileSha256: sha(Buffer.from(out)),
    trimmedBy: `node trim-muse-captures.mjs (JSON.parse, whole-record selection by id, regex redaction of e-mail addresses and separator-bearing phone numbers inside string values, JSON.stringify); never a byte cut`,
    termsUrl: 'https://www.themuse.com/developers/api/v2/terms',
    termsCheckedAt,
    permission: 'UNCLEAR',
    notes: `${notes} ${TERMS} ${REDACTION}`,
  }
  writeFileSync(
    join(dir, `${name}.provenance.json`),
    await format(JSON.stringify(prov), join(dir, `${name}.provenance.json`)),
  )
}

const keepIds = (ids) => (o) => ({
  ...o,
  results: ids.map((id) => o.results.find((r) => r.id === id)),
})

await emit(
  'seeded-page0',
  'seeded0.json',
  'seeded0.hdr',
  'https://www.themuse.com/api/public/jobs?page=0&category=Software%20Engineering&level=Senior%20Level',
  200,
  keepIds([18540547, 22039277, 20406944, 18400118, 22123640, 22171959]),
  'The seeded config (category "Software Engineering", level "Senior Level") page 0: 20 results, page_count 1792, total 35825; kept 6 whole records and left the envelope (page, page_count, items_per_page, total, took, timed_out, aggregations) as received. PAGES ARE 0-BASED (page=0 answers "page": 0). The category filter is not a partition: records tagged Software Engineering include a recruiter and civil-engineering roles. publication_date is a zoned UTC instant (2026-10-01T22:29:21Z). locations[] carry display names only ("New York, NY", "Sofia, Bulgaria"); no country code. refs.landing_page is the posting on themuse.com, and no separate application URL exists in the response. X-RateLimit-Limit 500 / Remaining 499 / Reset 3600 were returned without a key.',
)

await emit(
  'page-too-high',
  'oor.json',
  'oor.hdr',
  'https://www.themuse.com/api/public/jobs?page=99999&category=Software%20Engineering&level=Senior%20Level',
  400,
  (o) => o,
  'A page past page_count answers HTTP 400 {"code": 400, "error": "Value `page` is too high"} - NOT an empty result list as the developer page says ("Out-of-range pages return 0 results"). Kept whole.',
)
