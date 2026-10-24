// Builds the phase-3.4 (ATS B) fixtures from raw captures. Parser-based end to end:
//  - JSON: JSON.parse -> select whole records by identity -> redact personal data inside string
//    values -> JSON.stringify -> prettier;
//  - XML: @rgrove/parse-xml with offsets -> whole <position> elements are kept by their source
//    slice (the bytes of each kept element are exactly as received), the envelope around them is
//    re-written, e-mail addresses inside the kept text are replaced.
// Never a byte cut. Usage: node trim-ats-b-captures.mjs <dir-with-raw-captures> <termsCheckedAt-ISO>
// The raw captures are NOT committed; their sha256 (bytes as received) is in each provenance file.
// Raw files are <name>.body / <name>.hdr / <name>.meta.json, written by the capture script.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseXml } from '@rgrove/parse-xml'
import * as prettier from 'prettier'

const [rawDir, termsCheckedAt] = process.argv.slice(2)
const here = dirname(fileURLToPath(import.meta.url))
const sha = (b) => createHash('sha256').update(b).digest('hex')

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
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

const raw = (name) => ({
  bytes: readFileSync(join(rawDir, `${name}.body`)),
  meta: JSON.parse(readFileSync(join(rawDir, `${name}.meta.json`), 'utf8')),
})

async function format(text, filepath) {
  const options = (await prettier.resolveConfig(filepath)) ?? {}
  return prettier.format(text, { ...options, filepath })
}

async function writeProvenance(provider, name, ext, rawFile, out, trimmedBy, meta) {
  const dir = join(here, provider)
  const file = join(dir, `${name}.${ext}`)
  writeFileSync(file, out)
  const prov = {
    url: raw(rawFile).meta.url,
    fetchedAt: raw(rawFile).meta.fetchedAt,
    httpStatus: raw(rawFile).meta.status,
    rawSha256: sha(raw(rawFile).bytes),
    fileSha256: sha(Buffer.from(out)),
    trimmedBy,
    termsUrl: meta.termsUrl,
    termsCheckedAt,
    permission: meta.permission,
    notes: meta.notes,
  }
  const pfile = join(dir, `${name}.provenance.json`)
  writeFileSync(pfile, await format(JSON.stringify(prov), pfile))
}

const REDACTION_JSON =
  'E-mail addresses and phone numbers inside string values were replaced by a parser; personal NAMES in free-text descriptions cannot be found by a parser and were not redacted.'
const JSON_TRIM = (select) =>
  `node trim-ats-b-captures.mjs (JSON.parse, whole-record selection by ${select}, regex redaction of e-mail addresses and separator-bearing phone numbers inside string values, JSON.stringify, prettier); never a byte cut`
const NONE =
  'none: the body is stored exactly as received (it is not JSON or not worth re-serialising, hence the extension)'

async function emitJson(provider, name, rawFile, produce, select, meta) {
  const parsed = JSON.parse(raw(rawFile).bytes.toString('utf8'))
  const dir = join(here, provider)
  mkdirSync(dir, { recursive: true })
  const out = await format(JSON.stringify(redact(produce(parsed))), join(dir, `${name}.json`))
  await writeProvenance(provider, name, 'json', rawFile, out, JSON_TRIM(select), meta)
}
async function emitVerbatim(provider, name, ext, rawFile, meta) {
  mkdirSync(join(here, provider), { recursive: true })
  const out = raw(rawFile).bytes.toString('utf8')
  await writeProvenance(provider, name, ext, rawFile, out, NONE, meta)
}

// ------------------------------------------------------------------ Workable
const WK_TERMS = 'https://help.workable.com/hc/en-us/articles/115012771647'
const WK_COMMON =
  'ENDPOINT: the documented public form is https://www.workable.com/api/accounts/{subdomain}?details=true (Workable help center, which gives no field list, no rate limit and no terms for it); it answers HTTP 302 to https://apply.workable.com/api/v1/widget/accounts/{subdomain}?details=true (measured 2026-10-24, Location header), which is the address captured here and the only one the adapter calls, so the adapter has no need of a redirect (the page loop never reads Location; whether a transport follows one is the transport setting, pinned by the declared host of the adapter). The sibling https://apply.workable.com/api/v1/accounts/{subdomain} is the career-page account document (id, uid, logo, languages, details.overview) and carries no jobs. robots.txt: apply.workable.com is "User-agent: * / Disallow:" (empty, so nothing is disallowed) with "Content-Signal: search=yes, ai-input=yes, ai-train=no"; www.workable.com disallows only /user_password_resets, /admin, /auth/google and /j/ and carries the same content signal. Workable\'s terms (https://www.workable.com/terms, 2026-03-02) are written for customers; they contain no clause on automated access to public job data. The authenticated API https://{subdomain}.workable.com/spi/v3/ (bearer token) is a separate integration and was not called. The widget lists jobs only for accounts that publish them there: of 37 account slugs probed on 2026-10-24, 3 listed jobs (huggingface, hirefellows, flosum), 27 answered 200 with "jobs":[] (Hotjar, Deel, Typeform, Wise...) and 7 answered 404, so an empty list is common and is not a dead board.'
const WK_ENVELOPE =
  'Envelope: {name, description, jobs[]}; name is the account (employer) name as Workable holds it.'
const WK = { termsUrl: WK_TERMS, permission: 'PUBLIC_API_DOCUMENTED' }
const wkNotes = (extra) => `${extra} ${WK_ENVELOPE} ${WK_COMMON} ${REDACTION_JSON}`

await emitJson(
  'workable',
  'huggingface-account',
  'wk-huggingface',
  (o) => o,
  'nothing (all 6 jobs kept whole)',
  {
    ...WK,
    notes: wkNotes(
      'Hugging Face: 6 jobs, all kept. All are remote (telecommuting true) full-time jobs; three have a location with hidden:true, and three have a country-only location (empty city, region null). OWNERSHIP VERIFIED, EVIDENCE: PAYLOAD_FIELD (the envelope name is "Hugging Face"); job urls are apply.workable.com/j/{shortcode}.',
    ),
  },
)

const hirefellowsKeep = (jobs) => {
  const firstMatch = (label, pred) => {
    const hit = jobs.find(pred)
    if (hit === undefined) throw new Error(`no job for: ${label}`)
    return hit
  }
  const picked = [
    firstMatch('remote full-time', (j) => j.telecommuting === true),
    firstMatch('on-site, no employment type', (j) => j.telecommuting === false && j.employment_type === ''),
    firstMatch('two locations', (j) => j.locations.length > 1),
    firstMatch('on-site full-time', (j) => j.telecommuting === false && j.employment_type === 'Full-time' && j.locations.length === 1),
  ]
  return [...new Set(picked)]
}
await emitJson(
  'workable',
  'hirefellows-account',
  'wk-hirefellows',
  (o) => ({ ...o, jobs: hirefellowsKeep(o.jobs) }),
  'record predicate (the first remote job, the first with an empty employment_type, the first with two locations, the first plain on-site full-time job)',
  {
    ...WK,
    notes: wkNotes(
      'Hire Fellows: 23 jobs captured (21 on-site full-time, 1 remote, 1 on-site with employment_type ""), 3 kept: the one remote job (which is also the only one with several locations: six countries), the one with an empty employment type and an empty department, and a plain on-site full-time job. OWNERSHIP VERIFIED, EVIDENCE: PAYLOAD_FIELD (the envelope name is "Hire Fellows").',
    ),
  },
)
await emitJson('workable', 'hotjar-empty-account', 'wk-hotjar-empty', (o) => o, 'nothing (whole body kept)', {
  ...WK,
  notes: wkNotes(
    'Hotjar: an account that exists and lists no jobs: HTTP 200, {"name":"Hotjar","description":null,"jobs":[]}. This is a valid empty inventory, not a dead board (compare account-not-found).',
  ),
})
await emitVerbatim('workable', 'account-not-found', 'txt', 'wk-not-found', {
  ...WK,
  notes: wkNotes(
    'A subdomain that does not exist answers HTTP 404 with the plain text "Not Found" (9 bytes, content-type text/plain; not JSON). The subdomain is deliberately fictitious.',
  ),
})

// ----------------------------------------------------------------- Recruitee
const RT_TERMS = 'https://docs.recruitee.com/reference/authentication-1'
const RT_COMMON =
  'ENDPOINT: Careers Site API, https://{company}.recruitee.com/api/offers/ (docs.recruitee.com/reference/offers: the operation declares "security": [], query parameters department and tag, no pagination, no terms of use). TOKEN, checked 2026-10-24: docs.recruitee.com/reference/authentication-1 says a Careers Site API client "needs to authenticate first with a header" X-Careers-Sites-Token, that the token covers /offers, /offers/:id and /offers/:offer_slug/candidates, that "Deadline for introducing the token to calls is 10 February 2027" and that "Calls without the authorization header will return the 401 Unauthorized error". The token is generated by a USER OF THE EMPLOYER\'S OWN Recruitee account ("Careers API token only covers single account\'s Careers Site API"), so a third party can never hold one: from 2027-02-10 this source is KEY_REQUIRED for every tenant and the adapter refuses to run (it never sends the header). Before that date the endpoint answers WITHOUT the header, measured on three tenants the same day (bunq 200, tellent 200, an unknown tenant 404). robots.txt: tellent.recruitee.com answers "User-Agent: * / Disallow: /v/" (so /api/offers/ is allowed); bunq.recruitee.com/robots.txt redirects to the employer\'s own domain (careers.bunq.com/robots.txt: "User-agent: * / Allow: /"); api.recruitee.com (the authenticated ATS API, a different host) is "Disallow: /" and is not used.'
const RT = { termsUrl: RT_TERMS, permission: 'PUBLIC_API_DOCUMENTED' }
const rtNotes = (extra) => `${extra} ${RT_COMMON} ${REDACTION_JSON}`

await emitJson(
  'recruitee',
  'bunq-offers',
  'rt-bunq',
  (o) => ({
    ...o,
    offers: (() => {
      const bySize = [...o.offers].sort((a, b) => JSON.stringify(a).length - JSON.stringify(b).length)
      const fixedTerm = o.offers.find((x) => x.employment_type_code === 'fulltime_fixed_term')
      const smallest = bySize.filter((x) => x !== fixedTerm).slice(0, 2)
      return [...new Set([...smallest, ...(fixedTerm ? [fixedTerm] : [])])]
    })(),
  }),
  'record predicate (the two smallest offers and the one fixed-term offer)',
  {
    ...RT,
    notes: rtNotes(
      'bunq: 21 offers captured (620,703 bytes; all published, all hybrid), 3 kept whole. Every offer carries company_name "bunq", which is the ownership evidence (EVIDENCE: PAYLOAD_FIELD). careers_url is on the employer\'s own domain (careers.bunq.com/o/{slug}), not on recruitee.com, so the canonical posting URL must be taken from the data. mailbox_email (a per-offer job.<code> mailbox on bunq.recruitee.com) is an address and was replaced.',
    ),
  },
)
await emitJson('recruitee', 'tellent-empty-offers', 'rt-tellent-empty', (o) => o, 'nothing (whole body kept)', {
  ...RT,
  notes: rtNotes(
    'tellent: a tenant that exists and has no open offers: HTTP 200, {"offers":[]} (13 bytes). A valid empty inventory.',
  ),
})
await emitJson('recruitee', 'offers-not-found', 'rt-not-found', (o) => o, 'nothing (whole body kept)', {
  ...RT,
  notes: rtNotes(
    'A tenant that does not exist answers HTTP 404 with {"error":"Not Found"} (a different tenant-less address, recruitee.recruitee.com, answers 301 to https://recruitee.com/careers_not_hosted, which the adapter does not follow). The tenant is deliberately fictitious.',
  ),
})

// ------------------------------------------------------------------ Personio
const PE_TERMS = 'https://developer.personio.de/docs/integration-of-open-positions'
const PE_COMMON =
  'ENDPOINT: https://{company}.jobs.personio.de/xml?language={code} (developer.personio.de: language is one of de, en, fr, es, nl, it, pt "depending on the languages available for the Career Site"; the feed must be switched on per company in Settings > Recruiting > Career page > Activations, support.personio.de). HOSTS: the .de and .com hosts served byte-identical documents for both tenants tried (sha256 equal), so they are aliases of one data set, not two regions. NO POSTING URL IS IN THE FEED; the posting page is https://{company}.jobs.personio.de/job/{id} (measured for westwing: HTTP 200, canonical https://westwing.jobs.personio.de/job/2814781?language=en; the personio tenant\'s own position 1834171 answered 404 on the same pattern). LIMIT: the pattern is applied to EVERY position of EVERY company but was verified for one company of two, so a posting URL is unverified for any company other than Westwing and no second pattern is guessed. robots.txt of personio.jobs.personio.de: "User-agent: * / Allow: /". The docs state no rate limit or terms of use. A language the feed does not carry is NOT an error: language=xx answered the same 45,529 bytes as language=de, and the document without a language parameter equals language=en.'
const PE = { termsUrl: PE_TERMS, permission: 'PUBLIC_API_DOCUMENTED' }
const peNotes = (extra) => `${extra} ${PE_COMMON}`

/** Keep whole <position> elements by their source slice. */
function trimPositions(rawFile, keepIds) {
  const text = raw(rawFile).bytes.toString('utf8')
  const doc = parseXml(text, { includeOffsets: true })
  const positions = doc.root.children.filter((c) => c.type === 'element' && c.name === 'position')
  const idOf = (p) => p.children.find((c) => c.type === 'element' && c.name === 'id')?.text
  const kept = keepIds.map((id) => {
    const hit = positions.find((p) => idOf(p) === String(id))
    if (hit === undefined) throw new Error(`position ${id} not in capture`)
    return redactString(text.slice(hit.start, hit.end))
  })
  const head = text.slice(0, positions[0].start)
  const tail = text.slice(positions.at(-1).end)
  return { out: `${head}${kept.join('\n\n')}${tail}`, total: positions.length }
}
async function emitXml(name, rawFile, keepIds, meta) {
  const { out, total } = trimPositions(rawFile, keepIds)
  await writeProvenance(
    'personio',
    name,
    'xml',
    rawFile,
    out,
    `node trim-ats-b-captures.mjs (@rgrove/parse-xml with offsets, whole <position> elements kept by their source slice, e-mail addresses replaced, envelope text before the first and after the last position kept as received); never a byte cut. ${total} positions captured, ${keepIds.length} kept`,
    meta,
  )
}

mkdirSync(join(here, 'personio'), { recursive: true })
await emitVerbatim('personio', 'personio-en', 'xml', 'pe-personio-en', {
  ...PE,
  notes: peNotes(
    'The personio tenant (language=en): 1 position (id 1834171), stored exactly as received. It has an additionalOffices block, an apostrophe written as &#039; and an ampersand written as &amp; in a subcompany, and CDATA job descriptions. OWNERSHIP VERIFIED, EVIDENCE: PAYLOAD_FIELD (subcompany "Personio SE & Co. KG").',
  ),
})
await emitXml('westwing-en', 'pe-westwing-en', [2630474, 2703051, 2435528, 1968758, 2702093], {
  ...PE,
  notes: peNotes(
    'Westwing (language=en): 61 positions captured (674,732 bytes), 5 kept whole: a plain permanent full-time position (2630474), a fixed_term one (2703051), a freelance one with schedule full-or-part-time (2435528), a working_student part-time one (1968758) and one with NO <keywords> element (2702093; 60 of the 61 have one). OWNERSHIP VERIFIED, EVIDENCE: PAYLOAD_FIELD (subcompany "Westwing Group SE" on every kept position). No recruiter name or address is in the feed; an address in a description would have been replaced.',
  ),
})
await emitXml('westwing-de', 'pe-westwing-de', [2630474, 2702093], {
  ...PE,
  notes: peNotes(
    'Westwing (language=de): the SAME 61 positions with the SAME ids as language=en, but the German document carries no <jobDescriptions> content (~700 bytes per position against ~10,000), so the language parameter changes the text and not the identity; 2 kept (the same ids as the first and last of the English fixture). OWNERSHIP VERIFIED, EVIDENCE: PAYLOAD_FIELD (subcompany "Westwing Group SE").',
  ),
})
await emitVerbatim('personio', 'tenant-not-found', 'txt', 'pe-not-found', {
  ...PE,
  notes: peNotes(
    'A company that does not exist (or has not switched the XML feed on - the two are not distinguishable from outside) answers HTTP 404 with an HTML "Page Not Found" page (2,472 bytes, content-type text/html), stored exactly as received but as .txt: it is evidence of the status and the page, and an HTML file in a fixture directory would be rewritten by the mutation tooling. The tenant is deliberately fictitious. The fixture is the 404 BODY; the adapter never reads it.',
  ),
})

// ------------------------------------------------------------- SmartRecruiters
await emitVerbatim('smartrecruiters', 'api-robots', 'txt', 'sr-robots', {
  termsUrl: 'https://developers.smartrecruiters.com/docs/endpoints',
  permission: 'UNCLEAR',
  notes:
    'PERMISSION IS UNCLEAR, AND NO API CAPTURE WAS TAKEN. The robots.txt of api.smartrecruiters.com is "User-agent: LinkedInBot / Allow: /v1/companies/ / User-agent: * / Disallow: /": the Posting API path is allowed for one named crawler and DISALLOWED for every other agent, including this collector. The developer documentation (https://developers.smartrecruiters.com/docs/endpoints) calls the Posting API "public" and shows unauthenticated example requests, but states no terms of use and no rate limit, and the two statements conflict. The brief for this task says to stop when a path that is needed is disallowed, so no GET was sent to api.smartrecruiters.com other than this robots.txt. The adapter is written against the documented schema and tested on payloads built in its spec from that schema (the official examples on the documentation page are not valid JSON: missing commas, unterminated strings), and it must stay disabled until the owner decides.',
})
