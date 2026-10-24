import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ARBEITNOW_SOURCE_STATUS } from './arbeitnow.provider'
import { HN_SOURCE_STATUS } from './hn-hiring.provider'
import { JOBGETHER_SOURCE_STATUS } from './jobgether.provider'
import { REMOTIVE_SOURCE_STATUS } from './remotive.provider'
import { WORKINGNOMADS_SOURCE_STATUS } from './workingnomads.provider'

/**
 * The provenance contract of the phase-3 fixtures (`phase3-common.md`): Task 3.7 builds the
 * manifest from these files, so their shape is a contract, not a convention. Every fixture must
 * have a sibling provenance file, the recorded hash must describe the bytes actually committed,
 * and no file anywhere under `__fixtures__/` or `__raw-captures__/` may carry a stray e-mail address.
 *
 * ONE WALKER, TWO CHECKS: the e-mail scan used to read only the trimmed fixtures this file listed,
 * and three raw Hacker News captures with 462 commenters' addresses were committed unseen (PR
 * #1120). The scan below walks the whole tree, so the file nobody listed is still read.
 *
 * ADDING A SOURCE: append ONE row to `FIXTURES` (provider -> fixture name -> permission). There
 * is no global count to edit.
 *
 * HAND-OFF (Task 3.2 -> Task 3.3, PR #1117): `apps/api/src/test/fixture-provenance.ts` plus
 * `fixture-provenance.all.spec.ts` (one shared reader walking every `__fixtures__` directory) is
 * on `origin/main`. Moving the `FIXTURES` rows, the raw-capture hash rows and the e-mail scan below
 * into it, so that one reader remains, has NOT been done yet.
 */

// Under the mutation gate this file runs from a Stryker sandbox, whose copies of `.mjs` and `.html`
// files carry an injected `@ts-nocheck` that no committed byte has. The scan is about the COMMITTED
// bytes, so it reads them from the real directory (measured: 5 extra hits, 3 `.mjs` + 2 `.html`, all
// `@ts-nocheck`, and the dry run failed before any mutant). The directive is NOT allow-listed.
const SOURCES_DIR = __dirname.replace(/[/\\]\.stryker-tmp[/\\]sandbox-[^/\\]+/, '')
const ROOT = join(SOURCES_DIR, '__fixtures__')
// Evidence, not fixtures: kept outside __fixtures__ so the shared walk does not count it as a provider.
// The root is `__raw-captures__` itself (`phase3-common.md`: `__raw-captures__/<task>/`), so a later
// task's capture directory is scanned without editing this file.
const RAW_ROOT = join(SOURCES_DIR, '__raw-captures__')

type Permission =
  'PUBLIC_API_DOCUMENTED' | 'PUBLIC_FEED' | 'UNCLEAR' | 'PROHIBITED' | 'KEY_REQUIRED'

const FIXTURES: Record<string, Record<string, Permission>> = {
  remoteok: { feed: 'PUBLIC_API_DOCUMENTED' },
  remotive: { 'software-dev': 'UNCLEAR' },
  himalayas: {
    'browse-page1': 'PUBLIC_API_DOCUMENTED',
    'browse-page2': 'PUBLIC_API_DOCUMENTED',
    'search-page1': 'PUBLIC_API_DOCUMENTED',
  },
  jobicy: { 'seeded-page1': 'PUBLIC_API_DOCUMENTED', 'seeded-page2': 'PUBLIC_API_DOCUMENTED' },
  arbeitnow: { 'page-1': 'PUBLIC_API_DOCUMENTED', 'empty-page': 'PUBLIC_API_DOCUMENTED' },
  jobgether: {
    'page-1': 'UNCLEAR',
    'page-10': 'UNCLEAR',
    'no-results': 'UNCLEAR',
    'deprecated-path': 'UNCLEAR',
  },
  'hn-hiring': {
    search: 'UNCLEAR',
    'thread-2026-10': 'UNCLEAR',
    'thread-2026-09': 'UNCLEAR',
    'thread-2019-05': 'UNCLEAR',
  },
}

/**
 * `an-p1.raw.gz` is committed REDACTED, so it is not a row above. Convention (the one the Hacker News
 * redaction set, `trim-captures-3.2.mjs` header: "`rawSha256` is the sha256 of the bytes as RECEIVED"):
 * the provenance keeps the hash of what was fetched, the redaction is recorded in the notes, and the
 * committed bytes get their own pin here. Two named individuals' e-mail addresses, percent-encoded in
 * Outlook Safelinks parameters, were replaced by `x...x%40example.invalid` of the SAME length, so the
 * decoded size (4209793, the byte-cap evidence) is unchanged.
 */
const REDACTED_AN_P1 = {
  decodedBytes: 4209793,
  decodedSha256: '4f5e334fcd52f8fa49134f1c4dd9364869330a555cad19f8b981615a38ca5d1a',
}

/** Fixtures whose raw capture is still committed: the raw bytes must hash to `rawSha256`. */
const RAW_CAPTURES: Array<[provider: string, name: string, rawFile: string]> = [
  ['arbeitnow', 'empty-page', 'an-p100.raw'],
  ['jobgether', 'page-1', 'jg-p1.raw'],
  ['jobgether', 'page-10', 'jg-p10.raw'],
  ['jobgether', 'no-results', 'jg-none.raw'],
  ['jobgether', 'deprecated-path', 'jg-depr.raw'],
]

const provenanceSchema = z
  .object({
    url: z.string().url(),
    fetchedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    httpStatus: z.number().int(),
    rawSha256: z.string().regex(/^[0-9a-f]{64}$/),
    fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
    trimmedBy: z.string().min(1),
    termsUrl: z.string().url(),
    termsCheckedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    permission: z.enum([
      'PUBLIC_API_DOCUMENTED',
      'PUBLIC_FEED',
      'UNCLEAR',
      'PROHIBITED',
      'KEY_REQUIRED',
    ]),
    notes: z.string().min(1),
  })
  .strict()

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const provenanceOf = (provider: string, name: string) =>
  provenanceSchema.parse(
    JSON.parse(readFileSync(join(ROOT, provider, `${name}.provenance.json`), 'utf8')),
  )

const fixtures = Object.entries(FIXTURES).flatMap(([provider, names]) =>
  Object.keys(names).map((name) => ({ provider, name })),
)

describe('fixture provenance', () => {
  it.each(Object.entries(FIXTURES))(
    '%s: the committed fixtures are exactly the ones in the table',
    (provider, names) => {
      const onDisk = readdirSync(join(ROOT, provider))
        .filter((f) => f.endsWith('.json') && !f.endsWith('.provenance.json'))
        .map((f) => f.slice(0, -'.json'.length))
      expect(onDisk.sort()).toEqual(Object.keys(names).sort())
    },
  )

  it.each(fixtures.map((f) => [`${f.provider}/${f.name}`, f] as const))(
    '%s has a provenance file of exactly the contract shape whose fileSha256 matches the committed bytes',
    (_label, { provider, name }) => {
      const provenance = provenanceOf(provider, name)
      const committed = readFileSync(join(ROOT, provider, `${name}.json`))
      expect(sha256(committed)).toBe(provenance.fileSha256)
      expect(provenance.rawSha256).not.toBe(provenance.fileSha256)
      expect(provenance.trimmedBy).not.toMatch(/head -c/)
      expect(provenance.httpStatus).toBe(200)
    },
  )

  it.each(fixtures.map((f) => [`${f.provider}/${f.name}`, f] as const))(
    '%s records the permission the table states',
    (_label, { provider, name }) => {
      expect(provenanceOf(provider, name).permission).toBe(FIXTURES[provider]?.[name])
    },
  )

  it.each(RAW_CAPTURES)(
    '%s/%s: the committed raw capture %s hashes to the recorded rawSha256',
    (provider, name, rawFile) => {
      const raw = readFileSync(join(RAW_ROOT, '3.2', rawFile))
      const bytes = rawFile.endsWith('.gz') ? gunzipSync(raw) : raw
      expect(sha256(bytes)).toBe(provenanceOf(provider, name).rawSha256)
    },
  )

  it('arbeitnow/page-1: the committed capture is the redacted copy; rawSha256 still names what was fetched', () => {
    const bytes = gunzipSync(readFileSync(join(RAW_ROOT, '3.2', 'an-p1.raw.gz')))
    expect(bytes.length).toBe(REDACTED_AN_P1.decodedBytes)
    expect(sha256(bytes)).toBe(REDACTED_AN_P1.decodedSha256)
    const p = provenanceOf('arbeitnow', 'page-1')
    expect(p.rawSha256).not.toBe(REDACTED_AN_P1.decodedSha256)
    expect(p.notes).toContain('REDACTED COPY')
  })

  it('keeps no Working Nomads job data: its only artifact is the terms page, committed byte for byte', () => {
    const dir = join(ROOT, 'workingnomads')
    expect(readdirSync(dir).sort()).toEqual(['terms.html.provenance.json', 'terms.html.txt'])
    const p = provenanceSchema.parse(
      JSON.parse(readFileSync(join(dir, 'terms.html.provenance.json'), 'utf8')),
    )
    const digest = sha256(readFileSync(join(dir, 'terms.html.txt')))
    expect(p.fileSha256).toBe(digest)
    expect(p.rawSha256).toBe(digest)
    expect(p.permission).toBe('UNCLEAR')
  })
})

/**
 * EVERY `@`-EQUIVALENT TOKEN in the files under `sources/__fixtures__/` and `sources/__raw-captures__/`
 * (raw captures and scripts included, `.gz` decompressed) is reported as a HIT and must be allow-listed
 * by file, by value and by REASON in `ALLOWED_HITS`, or be the redaction placeholder.
 *
 * The scan is by TOKEN, not by address grammar, because grammar-guessing failed: it was widened for
 * seven review rounds (literal, `[at]`, `(at)`, entities) and still missed two named individuals'
 * addresses written `name%40domain` inside a tracking URL (PR #1120). Tokens: `@`, `%40`, `%2540`,
 * `&#0*64;`, `&#x0*40;`, `&commat;`, `@`. The text around the token is reported with it. The
 * bracket and paren forms `[at]` / `(at)` (spaces allowed, `(dot)` / `[dot]` between labels) carry no
 * such token, so they keep their own rule.
 *
 * PAIRED TESTS, edit both together: "finds no hit except ..." alone stays green if the regex is dead
 * (nothing is found, so nothing offends); "every allow-listed file ... carries exactly the hits listed"
 * is what fails then, because it requires the allow-listed hits to be FOUND.
 *
 * WHAT THIS MEASURES: addresses, NOT names. A green scan is not "no personal data": a named person
 * beside an allow-listed role mailbox (e.g. the managing director in an Impressum block) is personal
 * data this instrument never looks for.
 *
 * NOT COVERED (a scan that reads nothing passes like one that finds nothing, so the limits are stated):
 * the spelled-out form `x at y dot z` (none exists in the tree today); any compression but `.gz` (a
 * `.br` or `.zst` capture would pass unseen; none exists); and every directory outside the two roots,
 * e.g. `job-sourcing/__fixtures__` and `meeting-recorder/__fixtures__` (grepped by hand for literal
 * addresses, found clean).
 *
 * THE TOKEN LIST IS A DENYLIST OF ENCODINGS: it fails closed on a new occurrence of a listed token,
 * not on a new encoding. Probed and NOT matched, none in the tree today: `%252540`; `&#64` and `&#x40`
 * without the semicolon; `&amp;#64;` (the most plausible: double-escaping already occurs in this
 * corpus as `&amp;amp;`); `\x40`; `\u{40}`; fullwidth and small commercial-at; `{at}`; uppercase
 * `AT` as a word.
 */
const TOKEN = String.raw`(?:@|%40|%2540|&#0*64;|&#x0*40;|&commat;|\\u0040)`
const AT = String.raw`(?:\s*(?:\[at\]|\(at\))\s*)`
const DOT = String.raw`(?:\.|\s*(?:\[dot\]|\(dot\))\s*)`
const LABEL = String.raw`[A-Za-z0-9-]+`
const TOKEN_HIT = String.raw`[A-Za-z0-9._%+-]*${TOKEN}[A-Za-z0-9.-]*`
const OBFUSCATED_HIT = String.raw`[A-Za-z0-9._%+-]+${AT}${LABEL}(?:${DOT}${LABEL})*`
const HIT = new RegExp(`${TOKEN_HIT}|${OBFUSCATED_HIT}`, 'gi')
// The WHOLE placeholder, local part included: `redacted@example.invalid` (the parser's), or the
// same-length `x...x%40example.invalid` of the Safelinks redaction, which the hit grammar reaches with
// its `%7C` URL separators attached. A real local part on the reserved domain is NOT a placeholder:
// `Jane.Tan%40example.invalid` is the defect this scan exists to catch.
const isPlaceholder = (hit: string) =>
  /^redacted@example\.invalid$/i.test(hit) ||
  /^(?:[A-Za-z0-9._%+-]*%7C)?x+%40example\.invalid$/i.test(hit)

const SOCIAL = 'a social-media handle or at-mention in a job ad: no local part, not an address'
const ALLOWED_HITS: Array<{ file: string; reason: string; hits: string[] }> = [
  {
    file: 'workingnomads/terms.html.txt',
    reason:
      'the published role mailboxes of a third-party terms page, kept as evidence of a verdict',
    hits: ['hello@workingnomads.com', 'report@workingnomads.com'],
  },
  {
    file: 'workingnomads/terms.html.txt',
    reason: 'a CSS @media rule in the committed page',
    hits: ['@media'],
  },
  {
    file: 'wwr/unknown-category.challenge-403.html',
    reason: 'a CSS @media rule in a committed challenge page',
    hits: ['@media'],
  },
  {
    file: 'hn-hiring/thread-2026-10.json',
    reason: "an employer's contact line in a job post, obfuscated by the poster",
    hits: ['jobs[at]openeducation.foundation'],
  },
  {
    file: 'remotive/software-dev.json',
    reason: "Remotive's own contact for API questions, quoted in its feed",
    hits: ['hello(at)remotive(dot)io'],
  },
  {
    file: 'jobicy/seeded-page1.json',
    reason:
      'a domain naming where recruiter mail comes from ("an @banyansoftware.com address"): no local part',
    hits: ['@banyansoftware.com'],
  },
  {
    file: 'greenhouse/airbnb-board.json',
    reason: 'a bare @ in job-board text: no local part, not an address',
    hits: ['@'],
  },
  {
    file: '__raw-captures__/3.2/README.md',
    reason: 'the prose "HN @<handle>" and the encoding %40 named in the privacy record: no address',
    hits: ['%40', '@'],
  },
  {
    file: 'djinni/primary-keyword-rust.truncated.provenance.json',
    reason: 'the @truncate marker of the truncation record',
    hits: ['@truncate'],
  },
  {
    file: 'wwr/category-devops.truncated.provenance.json',
    reason: 'the @truncate marker of the truncation record',
    hits: ['@truncate'],
  },
  {
    file: 'euremotejobs/jobs-feed.truncated.provenance.json',
    reason: 'the @truncate-at-channel-close marker of the truncation record',
    hits: ['@truncate-at-channel-close'],
  },
  {
    file: 'trim-rss-items.py',
    reason: 'the @truncate markers the script writes',
    hits: ['@truncate', '@truncate-at-channel-close'],
  },
  {
    file: 'jobgether/deprecated-path.provenance.json',
    reason: 'a Sunset header value (@ + unix time), a date and not an address',
    hits: ['@1787875200'],
  },
  {
    file: '__raw-captures__/3.2/jg-depr.hdr',
    reason: 'a Sunset header value (@ + unix time), a date and not an address',
    hits: ['@1787875200'],
  },
  {
    file: 'trim-captures-3.2.mjs',
    reason: 'a Sunset header value (@ + unix time) and the regex source of the redaction',
    hits: ['+@', '@1787875200'],
  },
  {
    file: 'trim-captures.mjs',
    reason: 'the regex source of the redaction',
    hits: ['+@'],
  },
  {
    file: 'trim-ats-a-captures.mjs',
    reason: 'the regex source of the redaction',
    hits: ['+@'],
  },
  {
    file: '__raw-captures__/3.2/an-terms.html',
    reason: 'Alpine.js directives (@click, @mouseenter ...) in the committed terms page',
    hits: [
      '@arbeitnow',
      '@click',
      '@click.away',
      '@close-popover-group.window',
      '@keydown.escape',
      '@mouseenter',
      '@mouseleave',
    ],
  },
  {
    file: '__raw-captures__/3.2/an-p1.raw.gz',
    reason: SOCIAL,
    hits: ['@', '@Curatible', '@EURODYN', '@SoftOne', '@SotremoSA', '@lifeat12build', '@mention'],
  },
  {
    file: '__raw-captures__/3.2/an-p1.raw.gz',
    reason: 'CSS-framework class prefixes (@md, @sm) inside embedded markup',
    hits: ['@md', '@sm'],
  },
  {
    file: '__raw-captures__/3.2/an-p1.raw.gz',
    reason:
      'a benefits tag, a metric name and a company name that contain an @: no domain, not addresses',
    hits: ['Recall@k', 'Woman@capco'],
  },
  {
    file: '__raw-captures__/3.2/an-p1.raw.gz',
    reason: "an employer's published data-protection contact in its job ad (role mailbox)",
    hits: ['hr.dataprivacy(at)doctolib.com'],
  },
  {
    file: '__raw-captures__/3.2/an-p1.raw.gz',
    reason:
      'a platform\'s published security contact, written "security [at] perk .com" (role mailbox)',
    hits: ['security [at] perk'],
  },
  {
    file: '__raw-captures__/3.2/an-p1.raw.gz',
    reason: "the generic contact line of an employer's statutory imprint (role mailbox)",
    hits: ['contact (at) coni-partner.com'],
  },
  {
    file: '__raw-captures__/3.2/an-p2.raw.gz',
    reason: SOCIAL,
    hits: ['@', '@Curatible', '@InsideGeotab', '@SoftOne', '@SotremoSA', '@bluuwash', '@iwocauk'],
  },
  {
    file: '__raw-captures__/3.2/an-p2.raw.gz',
    reason: 'a CSS-framework class prefix (@sm) and a company name (Is@talent): not addresses',
    hits: ['@sm', 'Is@talent'],
  },
]
const allowedHitsOf = (label: string) =>
  ALLOWED_HITS.filter((e) => label === e.file).flatMap((e) => e.hits)

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

// DO NOT replace the derivation below with the literal '__raw-captures__/'. Deriving the prefix from
// RAW_ROOT is why narrowing RAW_ROOT to one task directory also breaks the raw-capture pin and the
// label round trip, not only the guard test; a literal would let the round trip pass under narrowing.
// A label is a path relative to `__fixtures__`, or relative to this directory when it starts with
// `__raw-captures__/`. One pair of functions, so a label and its file cannot be resolved differently.
const RAW_LABEL_PREFIX = `${basename(RAW_ROOT)}/`
const labelOf = (file: string) => relative(file.startsWith(RAW_ROOT) ? SOURCES_DIR : ROOT, file)
const pathOfLabel = (label: string) =>
  label.startsWith(RAW_LABEL_PREFIX) ? join(SOURCES_DIR, label) : join(ROOT, label)

function hitsOf(text: string): string[] {
  const hits = (text.match(HIT) ?? []).map((h) => h.replace(/\s+/g, ' ').replace(/[.-]+$/, ''))
  return [...new Set(hits)].sort()
}

function hitsIn(path: string): string[] {
  const raw = readFileSync(path)
  return hitsOf((path.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'))
}

describe('every @-equivalent token in the two scanned roots is the placeholder or allow-listed by reason', () => {
  const files = [...walk(ROOT), ...walk(RAW_ROOT)]
  const rel = files.map(labelOf)

  it('scans the whole tree: every provider directory, the raw captures and the scripts', () => {
    // A scanner that only saw a subset would pass the checks below too, so the scope is asserted.
    expect(rel.length).toBeGreaterThan(70)
    for (const dir of [...Object.keys(FIXTURES), 'workingnomads', '__raw-captures__/3.2']) {
      expect(rel.some((f) => f.startsWith(`${dir}/`))).toBe(true)
    }
    expect(rel).toContain('trim-captures-3.2.mjs')
    expect(rel).toContain('__raw-captures__/3.2/an-p1.raw.gz')
  })

  it('the scan root is __raw-captures__ itself, not one task directory under it', () => {
    // Weak on its own: a root renamed but still narrowed to one task passes this identically. The
    // listing test below is what carries the weight; this one only pins the constant's name.
    expect(basename(RAW_ROOT)).toBe('__raw-captures__')
  })

  it('every task directory under __raw-captures__ is reached by the scan', () => {
    // The property that matters, listed from the literal path without reading RAW_ROOT: a later
    // `3.4` directory the walk misses fails here.
    const taskDirs = readdirSync(join(SOURCES_DIR, '__raw-captures__'))
    expect(taskDirs).toContain('3.2')
    for (const dir of taskDirs) {
      expect(rel.some((f) => f.startsWith(`__raw-captures__/${dir}/`))).toBe(true)
    }
  })

  it.each([
    ['@', 'jane@example.com'],
    ['%40', 'jane%40example.com'],
    ['%2540', 'jane%2540example.com'],
    ['&#64;', 'jane&#64;example.com'],
    ['&#0064;', 'jane&#0064;example.com'],
    ['&#x40;', 'jane&#x40;example.com'],
    ['&#x0040;', 'jane&#x0040;example.com'],
    ['&commat;', 'jane&commat;example.com'],
    ['\\u0040', 'jane\\u0040example.com'],
    ['[at]/[dot]', 'jane [at] example[dot]com'],
    ['(at)/(dot)', 'jane(at)example(dot)com'],
  ])(
    'the hit grammar finds the %s form (positive control: drop a token and this fails)',
    (_form, text) => {
      expect(hitsOf(`mail ${text} now`)).toEqual([text])
    },
  )

  it.each([
    ['redacted@example.invalid', true],
    ['05%7C01%7Cxxxxxxxx%40example.invalid', true],
    ['xxxx%40example.invalid', true],
    ['Jane.Tan%40example.invalid', false],
    ['05%7C02%7CJane.Tan%40example.invalid', false],
    ['xxxxJane%40example.invalid', false],
    ['jane@example.invalid', false],
    ['xxxx@example.invalid', false],
    ['xxxx%40example.com', false],
  ])('placeholder %s: %s', (hit, expected) => {
    expect(isPlaceholder(hit)).toBe(expected)
  })

  it('a label resolves to the file it names, in either root (the allow-list path)', () => {
    // The case that used to throw ENOENT: an allow-listed raw-capture label joined against __fixtures__.
    const raw = '__raw-captures__/3.2/robots-workingnomads.txt'
    expect(rel).toContain(raw)
    expect(pathOfLabel(raw)).toBe(join(RAW_ROOT, '3.2', 'robots-workingnomads.txt'))
    expect(() => hitsIn(pathOfLabel(raw))).not.toThrow()
    expect(pathOfLabel('workingnomads/terms.html.txt')).toBe(
      join(ROOT, 'workingnomads', 'terms.html.txt'),
    )
    for (const file of files) expect(pathOfLabel(labelOf(file))).toBe(file)
  })

  it('finds no hit except the placeholder and the allow-listed ones', () => {
    const offenders = files.flatMap((file) => {
      const name = labelOf(file)
      const allowed = new Set(allowedHitsOf(name))
      return hitsIn(file)
        .filter((h) => !isPlaceholder(h) && !allowed.has(h))
        .map((h) => `${name}: ${h}`)
    })
    expect(offenders).toEqual([])
  })

  it('every allow-listed file exists and still carries exactly the hits listed for it', () => {
    // Pairs with the test above: that one is green when the pattern is dead, this one is not.
    const labels = [...new Set(ALLOWED_HITS.map((e) => e.file))]
    for (const name of labels) {
      expect(rel).toContain(name)
      expect(hitsIn(pathOfLabel(name)).filter((h) => !isPlaceholder(h))).toEqual(
        [...new Set(allowedHitsOf(name))].sort(),
      )
    }
  })

  it("the raw Hacker News thread captures are not committed (they hold commenters' addresses)", () => {
    // Any task directory under __raw-captures__, not only 3.2. The control proves the pattern can
    // match the label shape the walk produces, so an empty result is not an instrument that cannot see.
    const hnCapture = /^__raw-captures__\/[^/]+\/hn-/
    expect(hnCapture.test('__raw-captures__/3.2/hn-item-oct.raw')).toBe(true)
    expect(rel.filter((f) => hnCapture.test(f))).toEqual([])
  })
})

/**
 * A source can be PERMITTED and still BLOCKED: Arbeitnow's permission is PUBLIC_API_DOCUMENTED, but
 * its page does not fit the byte cap. Task 3.7 must not read readiness from `permission` alone, and
 * this table is what proves the two are different things: it compares what `permission` ALONE
 * would imply with what each source's own status constant says, and names the disagreement.
 */
const permissionImpliesReady = (permission: Permission) =>
  permission === 'PUBLIC_API_DOCUMENTED' || permission === 'PUBLIC_FEED'

const STATUSES: Array<[provider: string, name: string, blocked: boolean]> = [
  ['arbeitnow', 'page-1', ARBEITNOW_SOURCE_STATUS.blocked],
  ['jobgether', 'page-1', JOBGETHER_SOURCE_STATUS.blocked],
  ['hn-hiring', 'search', HN_SOURCE_STATUS.blocked],
  ['remotive', 'software-dev', REMOTIVE_SOURCE_STATUS.blocked],
  ['workingnomads', 'terms.html', WORKINGNOMADS_SOURCE_STATUS.blocked],
]

describe('readiness is not derivable from permission alone', () => {
  it('every Task 3.2 source and Remotive is blocked', () => {
    expect(STATUSES.filter(([, , blocked]) => !blocked)).toEqual([])
  })

  it('exactly one blocked source is nevertheless permitted by its provenance: Arbeitnow', () => {
    const permittedButBlocked = STATUSES.filter(([provider, name, blocked]) => {
      const permission = provenanceSchema.parse(
        JSON.parse(readFileSync(join(ROOT, provider, `${name}.provenance.json`), 'utf8')),
      ).permission
      return permissionImpliesReady(permission) && blocked
    }).map(([provider]) => provider)
    expect(permittedButBlocked).toEqual(['arbeitnow'])
  })

  it('permissionImpliesReady itself: only the two permitted values', () => {
    expect(
      (
        ['PUBLIC_API_DOCUMENTED', 'PUBLIC_FEED', 'UNCLEAR', 'PROHIBITED', 'KEY_REQUIRED'] as const
      ).map(permissionImpliesReady),
    ).toEqual([true, true, false, false, false])
  })
})
