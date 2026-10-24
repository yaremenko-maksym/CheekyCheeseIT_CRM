// Builds the phase-3.3 (ATS A) fixtures from raw captures. Parser-based end to end: JSON.parse ->
// select whole records by identity -> redact personal data inside string values -> JSON.stringify.
// Never a byte cut. Usage: node trim-ats-a-captures.mjs <dir-with-raw-captures> <termsCheckedAt-ISO>
// The raw captures are NOT committed; their sha256 (bytes as received) is in each provenance file.
// Raw files are named <prefix>-<slug>.json with a sibling .hdr holding the response headers.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
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

const header = (hdrFile, name) => {
  const line = readFileSync(join(rawDir, hdrFile), 'utf8')
    .split(/\r?\n/)
    .find((l) => l.toLowerCase().startsWith(`${name}:`))
  return line.slice(name.length + 1).trim()
}
const statusOf = (hdrFile) => Number(readFileSync(join(rawDir, hdrFile), 'utf8').split(/\s/)[1])

// The repo's pre-commit hook runs prettier over committed JSON, so the bytes hashed as
// `fileSha256` must already be prettier-stable or the hash would describe a file never committed.
async function format(text, filepath) {
  const options = (await prettier.resolveConfig(filepath)) ?? {}
  return prettier.format(text, { ...options, filepath })
}

// produce: parsed JSON -> kept JSON. A `null` produce means "store the body verbatim" (a body that
// is not JSON, e.g. Ashby's plain-text 404, goes in a .txt file and is never reformatted).
async function emit(provider, name, rawFile, hdrFile, url, produce, meta) {
  const rawBytes = readFileSync(join(rawDir, rawFile))
  const dir = join(here, provider)
  mkdirSync(dir, { recursive: true })
  const ext = produce === null ? 'txt' : 'json'
  const file = join(dir, `${name}.${ext}`)
  const out =
    produce === null
      ? rawBytes.toString('utf8')
      : await format(JSON.stringify(redact(produce(JSON.parse(rawBytes.toString('utf8'))))), file)
  writeFileSync(file, out)
  const prov = {
    url,
    fetchedAt: new Date(header(hdrFile, 'date')).toISOString(),
    httpStatus: statusOf(hdrFile),
    rawSha256: sha(rawBytes),
    fileSha256: sha(Buffer.from(out)),
    trimmedBy:
      produce === null
        ? 'none: the body is stored exactly as received (a plain-text 404 is not JSON, hence .txt)'
        : `node trim-ats-a-captures.mjs (JSON.parse, whole-record selection by ${meta.select}, regex redaction of e-mail addresses and separator-bearing phone numbers inside string values, JSON.stringify, prettier); never a byte cut`,
    termsUrl: meta.termsUrl,
    termsCheckedAt,
    // Ashby is UNCLEAR, not PUBLIC_API_DOCUMENTED: the API is documented as public, but its host
    // gives no robots verdict at all (robots.txt answers 401), and Task 3.7 derives readiness from
    // this structured field, not from the notes. See the notes of every ashby file.
    permission: meta.permission ?? (provider === 'ashby' ? 'UNCLEAR' : 'PUBLIC_API_DOCUMENTED'),
    notes: meta.notes,
  }
  writeFileSync(
    join(dir, `${name}.provenance.json`),
    await format(JSON.stringify(prov), join(dir, `${name}.provenance.json`)),
  )
}

const pick = (key, ids) => (arr) =>
  ids.map((id) => {
    const hit = arr.find((x) => String(x[key]) === String(id))
    if (hit === undefined) throw new Error(`record ${id} not in capture`)
    return hit
  })
const REDACTION =
  'E-mail addresses and phone numbers inside string values were replaced by a parser; personal NAMES in free-text descriptions cannot be found by a parser and were not redacted (records were chosen with short descriptions to limit exposure).'

// ---------------------------------------------------------------- Greenhouse
const GH_TERMS = 'https://docs.greenhouse.io/job-board.html'
const ghNotes = (extra) =>
  `${extra} Documented (${GH_TERMS}): GET endpoints need no authentication ("Job Board data is publicly available"); only the application POST needs Basic auth. robots.txt of boards-api.greenhouse.io: User-agent * / Disallow: /embed/ only, so /v1/boards/{token}/jobs is allowed. The docs state no rate limit or terms of use. Job content is HTML-escaped by Greenhouse (entities) and the adapter decodes it once. company_name and first_published appear on every job of this response although the docs show them only in the single-job example. ${REDACTION}`
const ghBoard = (name, token, ids, captured, ownership) => ({
  name,
  raw: `gh-${token}`,
  url: `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`,
  ids,
  captured,
  ownership,
})
for (const b of [
  ghBoard(
    'airbnb-board',
    'airbnb',
    [8102684, 7789554, 8303135],
    '191 jobs captured, 3 kept: a plain city (Bangalore), a Legal job in Tokyo, and a Paris job whose location.name has a trailing space and whose first_published equals updated_at. Two e-mail addresses per body were redacted. Whole response 2.7 MB',
    'OWNERSHIP VERIFIED, EVIDENCE: PAYLOAD_FIELD (the per-job company_name): it is "Airbnb" on 191 of 191 jobs and absolute_url hosts are careers.airbnb.com with gh_jid.',
  ),
  ghBoard(
    'stripe-board',
    'stripe',
    [7984866, 7994330, 7557403, 8260980],
    '720 jobs captured, 4 kept: two multi-location strings ("US-Chicago, US-New York", "Seattle, New York, San Francisco"), a single city, and one with first_published equal to updated_at. Whole response 5.6 MB, 69,266 JSON nodes',
    'OWNERSHIP VERIFIED, EVIDENCE: PAYLOAD_FIELD (the per-job company_name): it is "Stripe" on 720 of 720 jobs; absolute_url is a company-hosted page (https://stripe.com/jobs/search?gh_jid=N) where gh_jid is the only identity in the URL.',
  ),
  ghBoard(
    'cloudflare-board',
    'cloudflare',
    [7421718, 8288769],
    '453 jobs captured, 2 kept: 7421718 carries a body that its author escaped TWICE (the visible text "&lt; 60% travel" arrives as "&amp;lt; 60% travel"), and 8288769 has location.name "Hybrid" (a workplace type in the location field). Whole response 8.0 MB, 28,539 JSON nodes',
    'OWNERSHIP VERIFIED, EVIDENCE: PAYLOAD_FIELD (the per-job company_name): it is "Cloudflare" on 453 of 453 jobs; absolute_url is boards.greenhouse.io/cloudflare/jobs/N?gh_jid=N.',
  ),
]) {
  await emit(
    'greenhouse',
    b.name,
    `${b.raw}.json`,
    `${b.raw}.hdr`,
    b.url,
    (o) => ({ ...o, jobs: pick('id', b.ids)(o.jobs), meta: { total: b.ids.length } }),
    {
      select: 'job id (meta.total rewritten to the kept count so the envelope stays self-consistent)',
      termsUrl: GH_TERMS,
      notes: ghNotes(`${b.captured}. ${b.ownership}`),
    },
  )
}
await emit(
  'greenhouse',
  'board-not-found',
  'nf-gh.json',
  'nf-gh.hdr',
  'https://boards-api.greenhouse.io/v1/boards/cheeky-nonexistent-board-0001/jobs?content=true',
  (o) => o,
  {
    select: 'nothing (whole body kept)',
    termsUrl: GH_TERMS,
    notes: ghNotes(
      'A token that does not exist answers HTTP 404 with a JSON body {"status":404,"error":"Job not found"}. The slug is deliberately fictitious. No empty-but-existing Greenhouse board was found among the tokens tried (greenhouse, example, acme, demo, testco, sandbox), so an empty board is covered by a unit case built from the documented shape, not by a capture.',
    ),
  },
)

// ---------------------------------------------------------------------- Lever
const LV_TERMS = 'https://github.com/lever/postings-api'
const lvNotes = (extra) =>
  `${extra} Documented (${LV_TERMS}): a public read API, HTTPS only, "Only published postings are public ... These jobs may be scraped by third parties"; the only documented rate limit is on application POSTs (not used). robots.txt of both api.lever.co and api.eu.lever.co: User-agent * / Allow: / / Crawl-delay: 1 - a longer gap than the 500 ms proposed in ats-config.ts. The payload carries NO employer name; employer evidence is the posting text naming the employer. Observed drift from the documentation: workplaceType is "onsite" on the live API, the README lists "on-site"; createdAt is present on every posting but is not in the README's field list. ${REDACTION}`
const lvPage = (name, rawName, url, ids, captured) => ({ name, rawName, url, ids, captured })
for (const p of [
  lvPage(
    'spotify-page1',
    'lvp-spotify-p1',
    'https://api.lever.co/v0/postings/spotify?mode=json&limit=50&skip=0',
    [
      'e2c7bbb8-f873-42c7-811f-0bd45bf452ae',
      '47aeb6ee-f8c9-4f1e-9197-25c4c5676e5d',
      '080868dd-fc8c-4648-b6ab-6780d8ca3d63',
      'c152d042-642d-4a48-862b-8be8d6cdc819',
      'cf13d272-92ac-407d-89bf-7f20d20f7961',
      '4e4ab485-06f1-46b1-88e0-44f3fda4b62a',
    ],
    'First page of the spotify site: a FULL page of 50 postings (so a next page is requested), 6 kept: workplaceType remote, hybrid (x3, two of them with two allLocations) and onsite. OWNERSHIP, EVIDENCE: TEXT_PARTIAL (no employer field in the payload; the posting text names the employer): 87 of the 90 postings on the board name Spotify somewhere (title, description, lists or closing text), 71 of them in the main description alone. The 3 that name it nowhere are the Ringer posting (1f56d4be-..., whose own text names The Ringer, a Spotify-owned podcast company) and two postings whose main description is empty (9f66e598-..., 9fd98cde-...), all three kept in these fixtures; the board is Spotify\'s by its URL (jobs.lever.co/spotify/<uuid>), not by those three. palantir was read once and 309 of 309 postings named Palantir, but that read is UNCAPTURED: no capture of it is committed, so treat that figure as unverified. The fixtures keep 6 of the 90, so the 87 cannot be re-derived from them.',
  ),
  lvPage(
    'spotify-page2',
    'lvp-spotify-p2',
    'https://api.lever.co/v0/postings/spotify?mode=json&limit=50&skip=50',
    [
      '9f66e598-8587-4a57-8552-2cdb8672014a',
      '9fd98cde-6a1b-419c-a27a-daae7a7483f0',
      '1f56d4be-4e54-441a-ad05-946b9efcc391',
    ],
    'Second page of the spotify site (skip=50): 40 postings captured, 3 kept; a SHORT page, which is how the end of the board is recognised. OWNERSHIP, EVIDENCE: TEXT_PARTIAL (no employer field in the payload): the same site as spotify-page1 (hostedUrl jobs.lever.co/spotify/<uuid>); the counts (87 of 90 postings name Spotify somewhere) are in that file\'s notes. All 3 postings that name Spotify nowhere are the 3 kept on this page: 9f66e598-... and 9fd98cde-... (empty main description) and 1f56d4be-... (the Ringer posting).',
  ),
  lvPage(
    'spotify-page3-empty',
    'lvp-spotify-p3',
    'https://api.lever.co/v0/postings/spotify?mode=json&limit=50&skip=100',
    null,
    'Third request (skip=100) past the end of the spotify site: HTTP 200 with the body [] (two bytes), kept whole.',
  ),
  lvPage(
    'siteimprove-eu-board',
    'lvp-siteimprove-eu',
    'https://api.eu.lever.co/v0/postings/siteimprove?mode=json&limit=50&skip=0',
    [
      '13ff0a37-3059-45b1-8017-8310b620ec5d',
      '0e1585af-dc06-4cc7-93a9-cae389ace737',
      '7c10202a-fb19-4566-9efe-c248ed4e320c',
    ],
    'EU deployment (api.eu.lever.co): the whole siteimprove site is 12 postings, 3 kept (one with salaryRange, one remote). The same slug on the GLOBAL host answers 404, measured the same day, so region is part of a board\'s identity. hostedUrl is jobs.eu.lever.co/siteimprove/<uuid>. OWNERSHIP, EVIDENCE: TEXT_FULL (no employer field in the payload): all 12 postings name Siteimprove somewhere in their text (11 in the main description). The fixtures keep 3 of the 12.',
  ),
  lvPage(
    'quantco-trailing-hyphen-board',
    'lvp-quantco-',
    'https://api.lever.co/v0/postings/quantco-?mode=json&limit=50&skip=0',
    ['f41c0733-033e-431e-8feb-3b044874308d', '3e18574e-ab5a-46a2-8714-a0221fb937e7'],
    'A real Lever site whose NAME ENDS IN A HYPHEN: quantco- answers 200, quantco answers 404 (measured). 14 postings captured, 2 kept (onsite and hybrid). OWNERSHIP, EVIDENCE: TEXT_FULL (no employer field in the payload): all 14 postings name QuantCo somewhere in their text (11 in the main description). The fixtures keep 2 of the 14.',
  ),
]) {
  await emit(
    'lever',
    p.name,
    `${p.rawName}.json`,
    `${p.rawName}.hdr`,
    p.url,
    p.ids === null ? (o) => o : (arr) => pick('id', p.ids)(arr),
    { select: p.ids === null ? 'nothing (whole body kept)' : 'posting id', termsUrl: LV_TERMS, notes: lvNotes(p.captured) },
  )
}
await emit(
  'lever',
  'board-not-found',
  'nf-lever.json',
  'nf-lever.hdr',
  'https://api.lever.co/v0/postings/cheeky-nonexistent-board-0001?mode=json&limit=50&skip=0',
  (o) => o,
  {
    select: 'nothing (whole body kept)',
    termsUrl: LV_TERMS,
    notes: lvNotes(
      'A site that does not exist answers HTTP 404 with {"ok":false,"error":"Document not found"}. The slug is deliberately fictitious.',
    ),
  },
)

// ------------------------------------------------------------------- Ashby
const AS_TERMS = 'https://developers.ashbyhq.com/docs/public-job-posting-api'
const asNotes = (extra) =>
  `PERMISSION IS UNCLEAR, NOT DOCUMENTED-PUBLIC: the endpoint is documented without credentials, but https://api.ashbyhq.com/robots.txt answers HTTP 401, so this host states no robots verdict and the permission field must not read stronger than that. ${extra} Documented (${AS_TERMS}): a public endpoint with no credentials in the example; the page states no rate limit or terms of use. robots.txt: https://api.ashbyhq.com/robots.txt answers HTTP 401, so NO robots verdict exists for the API host (recorded as such, not as permission). The payload carries NO employer name; employer evidence is the posting text naming the employer. includeCompensation=true was requested; every job carries a compensation object, empty tiers where the employer published none. isListed was true on every one of 1,612 postings across 10 non-empty boards, so no unlisted posting was ever captured. DECISION AND COST: publishedAt is documented as the last publish and is read as PUBLISHED; the content hash covers PUBLISHED, so an Ashby re-publish with identical content changes contentHash (reading it as UPDATED would keep the hash stable but leave Ashby vacancies without a publication date). ${REDACTION}`
for (const p of [
  {
    name: 'linear-board',
    raw: 'ash-linear',
    token: 'linear',
    ids: [
      'c97e034e-19a8-4ec7-89a5-c81987451da8',
      'f16dd5e9-ed10-4b8e-b5d7-1b8b5e3f002f',
      'cb8e77a6-4316-45c6-ac8d-7ade980cd65e',
      'aa0673c5-9e06-42f8-a720-6c2e43930c5a',
    ],
    captured:
      '34 jobs captured (0.46 MB), 4 kept: Remote with one location, Remote with a secondary location, Hybrid (isRemote is true for it, as documented), and a title with a trailing space. OWNERSHIP, EVIDENCE: TEXT_FULL (no employer field in the payload): descriptionPlain names Linear in 34 of 34 jobs ("At Linear, we\'re building ..."); jobUrl is jobs.ashbyhq.com/linear/<uuid>.',
  },
  {
    name: 'supabase-board',
    raw: 'ash-supabase',
    token: 'supabase',
    ids: [
      'a069c886-1107-408e-88b4-e1aa8d33d4bc',
      '68a397e7-8a1a-4566-ae41-e8c61dd6ed93',
      'cb04ae3a-3a47-4e21-928f-c2456b7b214e',
      'e4e3ccb7-7b7d-42a2-be0f-26cbb5ae4abd',
    ],
    captured:
      '59 jobs captured (0.82 MB), 4 kept: workplaceType null with isRemote null, a job with a published compensation tier ("$200K – $270K • Offers Equity"), a job with two secondary locations, and a Remote one. OWNERSHIP, EVIDENCE: TEXT_FULL (no employer field in the payload): descriptionPlain names Supabase in 59 of 59 jobs ("ABOUT SUPABASE: Supabase is the Postgres development platform ...").',
  },
]) {
  await emit(
    'ashby',
    p.name,
    `${p.raw}.json`,
    `${p.raw}.hdr`,
    `https://api.ashbyhq.com/posting-api/job-board/${p.token}?includeCompensation=true`,
    (o) => ({ ...o, jobs: pick('id', p.ids)(o.jobs) }),
    { select: 'job id', termsUrl: AS_TERMS, notes: asNotes(p.captured) },
  )
}
await emit(
  'ashby',
  'deel-empty-board',
  'ash-deel.json',
  'ash-deel.hdr',
  'https://api.ashbyhq.com/posting-api/job-board/deel?includeCompensation=true',
  (o) => o,
  {
    select: 'nothing (whole body kept)',
    termsUrl: AS_TERMS,
    notes: asNotes(
      'A board that exists but lists nothing: HTTP 200, {"jobs":[],"apiVersion":"1"}, kept whole. (vercel answered the same 28 bytes. Whether such a board is empty or has moved to another ATS cannot be told from the response.)',
    ),
  },
)
await emit(
  'ashby',
  'board-not-found',
  'nf-ashby.json',
  'nf-ashby.hdr',
  'https://api.ashbyhq.com/posting-api/job-board/cheeky-nonexistent-board-0001?includeCompensation=true',
  null,
  {
    select: 'nothing (stored as received)',
    termsUrl: AS_TERMS,
    notes: asNotes(
      'A board that does not exist answers HTTP 404 with the PLAIN TEXT body "Not Found" (content-type text/plain), not JSON - hence the .txt extension. The slug is deliberately fictitious.',
    ),
  },
)
