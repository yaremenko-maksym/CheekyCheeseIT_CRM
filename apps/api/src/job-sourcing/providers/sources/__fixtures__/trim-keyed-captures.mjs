// Builds the Jooble, JSearch, Reed and TheirStack capture fixtures (task key-sources-smoke) from
// the raw bodies the owner-authorized controlled smoke kept LOCALLY
// (`CAPTURE_DIR=<dir> bash scripts/devops/check-job-source-credentials.sh <service>`: <svc>.body,
// <svc>.hdr = the Date: line only, <svc>.meta = http= and sha256=). Parser-based end to end:
// JSON.parse -> select whole records -> redact personal data inside string values ->
// JSON.stringify. Never a byte cut. Usage: node trim-keyed-captures.mjs <dir-with-raw-captures>
// The raw captures are NOT committed; their sha256 (bytes as received) is in each provenance file.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as prettier from 'prettier'

const [rawDir] = process.argv.slice(2)
const here = dirname(fileURLToPath(import.meta.url))
const sha = (b) => createHash('sha256').update(b).digest('hex')

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
// A phone needs a separator between digit groups, so bare ids inside URLs are left alone.
const PHONE =
  /\(\d{3}\)\s?\d{3}[ .-]\d{4}|(?<![\w/=.-])\+?\d{1,3}[ ().-]\(?\d{2,4}\)?[ .-]\d{2,4}(?:[ .-]\d{2,4})?(?![\w/])/g
const PERSON_PROFILE = /linkedin\.com\/in\//i
const redactString = (s) =>
  s.replace(EMAIL, 'redacted@example.invalid').replace(PHONE, '[redacted-phone]')
// A raw-JSON number (see `parse`) is a frozen object: walking it would rebuild it as
// `{ rawJSON: "<digits>" }` and turn the id into an object, so it is kept as it is.
const redact = (v) =>
  typeof v === 'string'
    ? redactString(v)
    : JSON.isRawJSON(v)
      ? v
      : Array.isArray(v)
        ? v.map(redact)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)]))
          : v

// Jooble ids are integers past 2^53 (some negative): a plain JSON.parse would round them, and the
// fixture must carry the digits the provider sent. JSON.rawJSON keeps the source text.
const parse = (text) =>
  JSON.parse(text, (_k, v, ctx) =>
    typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v)
      ? JSON.rawJSON(ctx.source)
      : v,
  )

const dateHeader = (svc) => {
  const line = readFileSync(join(rawDir, `${svc}.hdr`), 'utf8')
    .split(/\r?\n/)
    .find((l) => l.toLowerCase().startsWith('date:'))
  return new Date(line.slice(5).trim()).toISOString()
}
const metaOf = (svc) =>
  Object.fromEntries(
    readFileSync(join(rawDir, `${svc}.meta`), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => l.split('=')),
  )

// The repo's pre-commit hook runs prettier over committed JSON, so the bytes hashed as
// `fileSha256` must already be prettier-stable or the hash would describe a file never committed.
async function format(text, filepath) {
  const options = (await prettier.resolveConfig(filepath)) ?? {}
  return prettier.format(text, { ...options, filepath })
}

const REDACTION =
  'E-mail addresses and phone numbers inside string values were replaced by a parser; personal NAMES in free-text descriptions cannot be found by a parser and were not redacted.'
const SMOKE =
  "Taken by the owner-authorized controlled authenticated smoke (workflow verify-job-source-credentials.yml, run 43964860057, ONE request per source); the key travelled in a header, or (Jooble only) in the path of a request URL that was never logged, and the script refuses to keep a body or header in which the key appears. permission KEY_REQUIRED: the source answers only with the CRM's own key, which the runtime checks before every run."

async function emit({ dir, name, svc, url, produce, check, termsUrl, termsCheckedAt, notes }) {
  const rawBytes = readFileSync(join(rawDir, `${svc}.body`))
  const meta = metaOf(svc)
  if (meta.sha256 !== sha(rawBytes)) throw new Error(`${svc}: the body does not match its meta`)
  const value = redact(produce(parse(rawBytes.toString('utf8'))))
  const text = JSON.stringify(value)
  if (PERSON_PROFILE.test(text)) throw new Error(`${svc}: a kept record links a personal profile`)
  check?.(value)
  const outDir = join(here, dir)
  mkdirSync(outDir, { recursive: true })
  const out = await format(text, join(outDir, `${name}.json`))
  check?.(out)
  writeFileSync(join(outDir, `${name}.json`), out)
  const prov = {
    url,
    fetchedAt: dateHeader(svc),
    httpStatus: Number(meta.http),
    rawSha256: meta.sha256,
    fileSha256: sha(Buffer.from(out)),
    trimmedBy:
      'node trim-keyed-captures.mjs (JSON.parse keeping integers past 2^53 as written, whole-record selection, regex redaction of e-mail addresses and separator-bearing phone numbers inside string values, JSON.stringify); never a byte cut',
    termsUrl,
    termsCheckedAt,
    permission: 'KEY_REQUIRED',
    notes: `${notes} ${SMOKE} ${REDACTION}`,
  }
  writeFileSync(
    join(outDir, `${name}.provenance.json`),
    await format(JSON.stringify(prov), join(outDir, `${name}.provenance.json`)),
  )
}

// The Jooble id digits must survive the parse and prettier: assert them on the committed text.
const joobleIdsKept = (raw) => (v) => {
  if (typeof v !== 'string') return
  for (const id of raw.match(/"id":\s*(-?\d+)/g).map((m) => m.split(':')[1].trim())) {
    // As a JSON number, not merely its digits somewhere in the text.
    if (!new RegExp(`"id":\\s*${id}[,\\s}]`).test(v)) {
      throw new Error(`jooble id ${id} was not kept as written`)
    }
  }
}

await emit({
  dir: 'jooble',
  name: 'search-smoke',
  svc: 'jooble',
  url: 'https://jooble.org/api/<key> (POST {"keywords":"senior developer","location":"remote","page":1,"ResultOnPage":5})',
  produce: (o) => o,
  check: joobleIdsKept(readFileSync(join(rawDir, 'jooble.body'), 'utf8')),
  termsUrl: 'https://jooble.org/info/terms',
  termsCheckedAt: '2026-11-16T21:59:58.000Z',
  notes:
    'POST body {"keywords":"senior developer","location":"remote","page":1,"ResultOnPage":5}: totalCount 72531, 5 jobs, kept whole with the envelope. Every `id` is an integer past 2^53 and some are NEGATIVE (-5099382229872932738), so a JSON.parse rounds it and it cannot be an identity. `updated` carries no zone (2026-11-13T00:00:00.0000000). `link` is a jooble.org/away/ or /desc/ redirect, never the employer page. `type` is often the empty string; `salary` and `source` are present and not mapped. Terms (https://jooble.org/info/terms, effective 2019-01-08, read 2026-11-16) are site terms with no API clause: section 4(i) forbids copying content for republication without permission, 4(m) forbids bots or automatic access to the Site, 9(d) allows linking; the key itself is granted by Jooble for API access. Section 4(m) forbids bots on the website; the adapter uses the keyed REST API, the sanctioned access path, and never the website.',
})

await emit({
  dir: 'jsearch',
  name: 'search-v2-smoke',
  svc: 'rapidapi',
  url: 'https://jsearch.p.rapidapi.com/search-v2?query=senior%20backend%20developer%20remote&num_pages=1&country=us&date_posted=week&work_from_home=true',
  produce: (o) => ({ ...o, data: { ...o.data, jobs: [9, 0, 2].map((i) => o.data.jobs[i]) } }),
  termsUrl: 'https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch',
  termsCheckedAt: '2026-11-16T21:59:59.000Z',
  notes:
    'GET /search-v2 (the v1 /search path answers 404): 10 jobs; kept 3 whole records (the shortest) and the envelope as received (status, request_id, parameters, data.cursor). The envelope is {status, request_id, parameters, data: {jobs, cursor}}, NOT data: [...]. job_city, job_state and job_country are null for remote postings; job_location is the only location ("Anywhere"). job_posted_at_datetime_utc is a zoned instant. The next page is reached through data.cursor; the request parameter that takes it was not found in any readable documentation, so the adapter reads ONE page. Terms: https://rapidapi.com/terms returned no readable content on 2026-11-16 and again on 2026-11-17 (one GET each; the page body is rendered by script, only the title "RapidAPI" was served), the JSearch listing (rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch, one GET 2026-11-17) served only its title, and the OpenWeb Ninja product page (read 2026-11-16) states no terms or limits. The RapidAPI terms were NOT read: they are not readable without a browser, so the verdict is UNCLEAR (not PROHIBITED) and the source is accepted under the owner decision of 2026-11-16; Owner decision, 2026-11-16 (answer given in the vacancy-sourcing session): consent to use every source whose permission is unclear; accepted risk, not a documented permission. Nothing about storing results was read; the owner holds the RapidAPI subscription. The seed delta meters the account at 150 requests a month (an A1 default cap under the 200-request free plan, not an owner figure).',
})

await emit({
  dir: 'reed',
  name: 'search-smoke',
  svc: 'reed',
  url: 'https://www.reed.co.uk/api/1.0/search?keywords=senior%20developer&resultsToTake=5&resultsToSkip=0',
  produce: (o) => o,
  termsUrl: 'https://www.reed.co.uk/developers/jobseeker',
  termsCheckedAt: '2026-11-16T21:59:55.000Z',
  notes:
    'HTTP Basic (the key as username, empty password), keywords "senior developer", resultsToTake 5: totalResults 1039, 5 results, kept whole with the envelope (results, ambiguousLocations, totalResults). jobId is an integer; date and expirationDate are dd/MM/yyyy; jobDescription is a ~450-character snippet, not the posting; jobUrl is the posting on reed.co.uk. No locationName was sent, so the seeded "remote" location is NOT covered by this capture. The developer page (read 2026-11-16) states the authentication rule and the 100-results-per-request cap and no usage terms or rate limits. Terms: no usage terms were found, so the permission is UNCLEAR beyond the key; Owner decision, 2026-11-16 (answer given in the vacancy-sourcing session): consent to use every source whose permission is unclear; accepted risk, not a documented permission. The seed delta meters it at 50 requests a day (an A1 default cap, not an owner figure; Reed publishes none).',
})

await emit({
  dir: 'theirstack',
  name: 'jobs-search-smoke',
  svc: 'theirstack',
  url: 'https://api.theirstack.com/v1/jobs/search (POST {"page":0,"limit":3,"posted_at_max_age_days":7,"workplace_types_or":["remote"],"job_seniority_or":["senior"]})',
  // The middle record names a hiring-team member (a person): it is left out, not edited.
  produce: (o) => ({ ...o, data: [0, 2].map((i) => o.data[i]) }),
  check: (v) => {
    if (typeof v === 'string') return
    for (const r of v.data) {
      if ((r.hiring_team ?? []).length > 0) throw new Error('a kept record names a hiring team')
    }
  },
  termsUrl: 'https://theirstack.com/en/docs/legal/terms-and-conditions',
  termsCheckedAt: '2026-11-16T22:00:36.000Z',
  notes:
    "POST limit 3 (billed one API credit per returned job): 3 jobs; kept 2 whole records and the envelope (metadata, data). The record whose hiring_team named a person was left out. date_posted is a DATE only (2026-11-16); final_url is null in every record, url is the posting on the job board; remote is a boolean; company_object carries firmographics. Terms (read 2026-11-16): 4.3 allows use for recruiting and forbids building a competing product or reselling the dataset; 4.5 requires keeping information that identifies TheirStack as the origin of the records (the CRM stores the source namespace on every record); 4.10 and 4.12 cover retention and integration into the customer's own products.",
})
