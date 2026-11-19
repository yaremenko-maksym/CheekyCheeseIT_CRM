// Builds the task-04 Working Nomads and SmartRecruiters fixtures from raw captures. Parser-based end
// to end: JSON.parse -> select whole records -> redact personal data inside string values ->
// JSON.stringify. Never a byte cut.
// Usage: node trim-sources-04-captures.mjs <dir-with-raw-captures>
// The raw captures are NOT committed; their sha256 (bytes as received) is in each provenance file.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as prettier from 'prettier'

const [rawDir] = process.argv.slice(2)
if (rawDir === undefined) {
  throw new Error('usage: node trim-sources-04-captures.mjs <raw-dir>')
}
const here = dirname(fileURLToPath(import.meta.url))
const sha = (b) => createHash('sha256').update(b).digest('hex')

// The terms were read on 2026-10-24 and are COMMITTED in this repo (terms.html.txt,
// api-robots.txt). Their own provenance records which URL was read and when, so the new captures
// cite that recorded check rather than claiming a fresh reading that did not happen.
const terms = (file) => {
  const p = JSON.parse(readFileSync(join(here, file), 'utf8'))
  return { termsUrl: p.termsUrl, termsCheckedAt: p.termsCheckedAt }
}
const WN_TERMS = terms('workingnomads/terms.html.provenance.json')
const SR_TERMS_PROV = terms('smartrecruiters/api-robots.provenance.json')

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
// A phone needs a separator between digit groups, so bare ids inside URLs are left alone.
const PHONE =
  /\(\d{3}\)\s?\d{3}[ .-]\d{4}|(?<![\w/=.-])\+?\d{1,3}[ ().-]\(?\d{2,4}\)?[ .-]\d{2,4}(?:[ .-]\d{2,4})?(?![\w/])/g
const redactString = (s) =>
  s.replace(EMAIL, 'redacted@example.invalid').replace(PHONE, '[redacted-phone]')
// `creator` is the only object in any SmartRecruiters payload that names a HUMAN (a recruiter), and
// it appears on SOME list items as well as on every detail. It is dropped EVERYWHERE by key, not at
// a call site: a per-site drop is the one a later capture forgets, and these files are public.
const PERSON_KEYS = new Set(['creator'])
const redact = (v) =>
  typeof v === 'string'
    ? redactString(v)
    : Array.isArray(v)
      ? v.map(redact)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([k]) => !PERSON_KEYS.has(k))
              .map(([k, x]) => [k, redact(x)]),
          )
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
  'Every `creator` object (the only field naming a human) was dropped by key. E-mail addresses and phone numbers inside string values were replaced by a parser; personal NAMES in free-text descriptions cannot be found by a parser and were not redacted (records were chosen with short descriptions to limit exposure).'

async function emit({ dir, file, raw, headers, value, url, terms: t, permission, notes }) {
  const rawBytes = readFileSync(join(rawDir, raw))
  const text = await format(JSON.stringify(value), join(here, dir, file))
  const bytes = Buffer.from(text, 'utf8')
  mkdirSync(join(here, dir), { recursive: true })
  writeFileSync(join(here, dir, file), bytes)
  const provenance = {
    url,
    fetchedAt: dateHeader(headers),
    httpStatus: 200,
    rawSha256: sha(rawBytes),
    fileSha256: sha(bytes),
    trimmedBy:
      'node trim-sources-04-captures.mjs (JSON.parse, whole-record selection, regex redaction of e-mail addresses and separator-bearing phone numbers inside string values, JSON.stringify); never a byte cut',
    termsUrl: t.termsUrl,
    termsCheckedAt: t.termsCheckedAt,
    permission,
    notes: `${notes} ${REDACTION}`,
  }
  const provText = await format(
    JSON.stringify(provenance),
    join(here, dir, `${file.slice(0, file.lastIndexOf('.'))}.provenance.json`),
  )
  writeFileSync(
    join(here, dir, `${file.slice(0, file.lastIndexOf('.'))}.provenance.json`),
    Buffer.from(provText, 'utf8'),
  )
  console.log(`${dir}/${file}: ${bytes.length} bytes, raw ${rawBytes.length}`)
}

// ---------------------------------------------------------------------------
// Working Nomads: the whole exposed_jobs list, trimmed to whole records.
// ---------------------------------------------------------------------------
const wn = JSON.parse(readFileSync(join(rawDir, 'workingnomads-exposed-jobs.json'), 'utf8'))
// Development first (the seeded config collects that category), then one of each other category, so
// the fixture proves both the match and the non-match. Shortest descriptions first, to limit exposure.
const byCategory = new Map()
for (const job of [...wn].sort((a, b) => a.description.length - b.description.length)) {
  const list = byCategory.get(job.category_name) ?? []
  if (list.length < 2) list.push(job)
  byCategory.set(job.category_name, list)
}
const wnKept = [
  ...(byCategory.get('Development') ?? []),
  ...[...byCategory.entries()].filter(([k]) => k !== 'Development').map(([, v]) => v[0]),
].slice(0, 6)

await emit({
  dir: 'workingnomads',
  file: 'exposed-jobs.json',
  raw: 'workingnomads-exposed-jobs.json',
  headers: 'workingnomads-exposed-jobs.headers.txt',
  value: redact(wnKept),
  url: 'https://www.workingnomads.com/api/exposed_jobs/',
  terms: WN_TERMS,
  permission: 'UNCLEAR',
  notes: `The endpoint answers ONE unparameterised JSON ARRAY, not an envelope: ${wn.length} records, no page, count or cursor field of any kind, and the \`allow\` response header is "GET, HEAD, OPTIONS". There is therefore no pagination to drive and no server-side filter was sent (one plain GET, owner-approved 2026-11-19); the seeded config's \`categories\` is matched CLIENT-SIDE against \`category_name\`. Every record carries exactly eight STRING fields: url, title, description, company_name, category_name, tags, location, pub_date. \`category_name\` is Title Case ("Development", ${wn.length} records split across ${new Set(wn.map((j) => j.category_name)).size} categories), so the seeded lower-case "development" matches only case-insensitively. \`tags\` is ONE comma-separated string, not an array. \`pub_date\` is an OFFSET-bearing local instant ("2026-11-19T03:05:06-05:00"), never a bare date or a UTC Z. \`url\` is the redirect shape https://www.workingnomads.com/job/go/<id>/ and the trailing numeric segment is the only identity the payload carries; there is no id field. \`location\` is a free-text display string ("Anywhere in the world", "CET (+/- 3 hours)"), with no country code, so remoteness is not asserted from it. No field names a salary, a deadline or an application address. Kept ${wnKept.length} whole records (both shortest Development ones plus one of each other category, so the fixture exercises the category match AND the non-match) out of ${wn.length}; the array shape is as received. Terms of Service (committed byte for byte beside this file as terms.html.txt, read 2026-10-24): no clause on automated access, scraping, an API or reuse of listings, either way; clauses 2.2 ("intended purpose"), 3.1(b) (no commercial exploitation of the Service) and 3.1(d) (no competitive product) are the ones the owner's 2026-11-16 ACCEPT_RISK decision knowingly accepts. robots.txt allows everything, which is silence rather than a grant. No attribution obligation is stated anywhere in the terms or the response.`,
})

// ---------------------------------------------------------------------------
// SmartRecruiters: the postings list of each measured board, and one posting detail.
// ---------------------------------------------------------------------------
const srBoards = [
  {
    file: 'postings-list.json',
    raw: 'smartrecruiters-postings.json',
    board: 'smartrecruiters',
    employer: 'SmartRecruiters Inc',
  },
  {
    file: 'ubisoft2-postings-list.json',
    raw: 'ubisoft2-postings.json',
    board: 'ubisoft2',
    employer: 'Ubisoft',
  },
]
const SR_DOCS = SR_TERMS_PROV.termsUrl
const SR_NOTE = (b, env, kept) =>
  `OWNERSHIP: EVIDENCE: PAYLOAD_FIELD — every one of the ${kept.length} postings kept here carries \`company.name\` "${b.employer}" as a field of the provider's own payload, not as free text. MEASURED 2026-11-19, one plain GET (owner-approved), \`GET https://api.smartrecruiters.com/v1/companies/${b.board}/postings?limit=100&offset=0\` -> HTTP 200 application/json. THE IDENTIFIER IS CASE-INSENSITIVE ON THE WIRE AND CANONICALISED IN THE PAYLOAD: the request path carried the lower-case "${b.board}" and the response answers \`company.identifier\` "${env.content[0].company.identifier}". That is the measurement \`SMARTRECRUITERS_KIND\` in ats-config.ts was waiting for, and it is why the lower-case-only slug alphabet is sound rather than merely cautious. The envelope is \`{offset, limit, totalFound, content}\`: offset ${env.offset}, limit ${env.limit}, totalFound ${env.totalFound}, content ${env.content.length} items — \`totalFound\` is the board's whole count, so the end of the list is \`offset + content.length >= totalFound\` and no cursor is sent. Each list item carries id (a numeric string), name, uuid, jobAdId, defaultJobAd, refNumber, company{identifier,name}, releasedDate (a UTC Z instant), location{city,region,country,remote,hybrid,fullLocation and sometimes latitude/longitude}, industry/department/function/typeOfEmployment/experienceLevel each as {id,label}, language, customField[], visibility ("PUBLIC") and, on SOME items, \`creator\` - the ONE object in the payload that NAMES A HUMAN (a recruiter). Every \`creator\` was DROPPED BY KEY from the committed file, here and in the detail capture, because these fixtures are public; nothing else was removed from an item. THE LIST CARRIES NO DESCRIPTION and no \`postingUrl\`: both live only in the per-posting detail, which is one further request each. \`experienceLevel.label\` IS in the list ("Mid-Senior Level"), so seniority needs no detail request. Kept ${kept.length} whole postings out of ${env.content.length} on the page; the envelope's own fields are as received except \`content\`, whose length therefore describes the committed file rather than the live page. No GET was sent to any other host: jobs.smartrecruiters.com appears only as data inside the payload and was never requested. robots.txt of api.smartrecruiters.com (committed beside this file as api-robots.txt) disallows every agent except LinkedInBot; the documentation at ${SR_DOCS} calls the Posting API public and shows unauthenticated examples, states no terms of use and no rate limit, and the two conflict. The owner's 2026-10-24 ACCEPT_RISK decision knowingly accepts exactly that, "until banned"; nothing here was retried and no header was changed. No attribution obligation is stated in the documentation or the response.`

for (const b of srBoards) {
  const env = JSON.parse(readFileSync(join(rawDir, b.raw), 'utf8'))
  // Senior-first, then shortest names: the fixture should show the roles the board is listed for.
  const kept = [...env.content]
    .sort((x, y) => {
      const s = (n) => (/\bsenior|\blead\b|principal|staff/i.test(n.name) ? 0 : 1)
      return s(x) - s(y) || x.name.length - y.name.length
    })
    .slice(0, 6)
  await emit({
    dir: 'smartrecruiters',
    file: b.file,
    raw: b.raw,
    headers: b.raw.replace('.json', '.headers.txt'),
    value: redact({ ...env, content: kept }),
    url: `https://api.smartrecruiters.com/v1/companies/${b.board}/postings?limit=100&offset=0`,
    terms: SR_TERMS_PROV,
    permission: 'UNCLEAR',
    notes: SR_NOTE(b, env, kept),
  })
}

const detail = JSON.parse(readFileSync(join(rawDir, 'smartrecruiters-posting-detail.json'), 'utf8'))
await emit({
  dir: 'smartrecruiters',
  file: 'posting-detail.json',
  raw: 'smartrecruiters-posting-detail.json',
  headers: 'smartrecruiters-posting-detail.headers.txt',
  value: redact(detail),
  url: `https://api.smartrecruiters.com/v1/companies/smartrecruiters/postings/${detail.id}`,
  terms: SR_TERMS_PROV,
  permission: 'UNCLEAR',
  notes: `The PER-POSTING DETAIL, measured 2026-11-19 with one plain GET (owner-approved), \`GET https://api.smartrecruiters.com/v1/companies/smartrecruiters/postings/${detail.id}\` -> HTTP 200 application/json. It is the first measurement of this response: the adapter's detail schema was written from the documentation, whose own examples are not valid JSON. The detail adds, over the list item, \`jobAd.sections\` (companyDescription, jobDescription, qualifications, additionalInformation — each \`{title, text}\` with HTML in \`text\`), \`postingUrl\` ("${detail.postingUrl}"), \`applyUrl\`, \`referralUrl\`, \`jobId\` and \`active\` (${detail.active}); \`visibility\` is "${detail.visibility}". So the CANONICAL URL and the DESCRIPTION both come from here and from nowhere else, which is why a detail request per posting exists at all. A \`creator\` object ({name, avatarUrl}) is present in the live response and is the one field that can name a human; it came back EMPTY on this posting and was DROPPED from the committed file rather than stored, so no recruiter identity is committed and a future capture cannot copy an empty one by habit. Nothing else was removed. No GET was sent to jobs.smartrecruiters.com: \`postingUrl\` and \`applyUrl\` are data here, never a request target. robots.txt of api.smartrecruiters.com (committed beside this file as api-robots.txt) disallows every agent except LinkedInBot, while the documentation at ${SR_DOCS} calls the Posting API public and shows unauthenticated examples; this detail request rests on the SAME owner decision as the list one (2026-10-24 ACCEPT_RISK, "until banned"), and nothing here was retried and no header was changed.`,
})
