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

const ROOT = join(__dirname, '__fixtures__')
// Evidence, not fixtures: kept outside __fixtures__ so the shared walk does not count it as a provider.
// The root is `__raw-captures__` itself (`phase3-common.md`: `__raw-captures__/<task>/`), so a later
// task's capture directory is scanned without editing this file.
const RAW_ROOT = join(__dirname, '__raw-captures__')

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

/** Fixtures whose raw capture is still committed: the raw bytes must hash to `rawSha256`. */
const RAW_CAPTURES: Array<[provider: string, name: string, rawFile: string]> = [
  ['arbeitnow', 'page-1', 'an-p1.raw.gz'],
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
 * LITERAL and OBFUSCATED e-mail addresses in the files under `sources/__fixtures__/` and
 * `sources/__raw-captures__/`, raw captures and scripts included, `.gz` decompressed. The allow-list
 * is per FILE and per ADDRESS (an obfuscated one is listed by its whitespace-collapsed text): the
 * redaction placeholder, and the published role mailboxes kept as evidence. A new address in an
 * allow-listed file fails, as does any address in any other file.
 *
 * WHAT IS MATCHED: `local@domain.tld`; the bracket and paren forms `[at]` and `(at)` (spaces around
 * them allowed); the entities `&#64;`, `&#x40;`, `&commat;`; and `(dot)` / `[dot]` between domain labels.
 * Hacker News commenters obfuscate precisely to defeat a scanner, so the literal form alone is not enough.
 *
 * WHAT IS NOT COVERED (a scan that reads nothing passes like one that finds nothing, so the limits
 * are stated): the spelled-out form `x at y dot z` (none exists in the tree today); a JSON `\u0040`
 * escape; any compression but `.gz` (a `.br` or `.zst` capture would pass unseen; none exists); and
 * every directory outside the two roots above, e.g. `job-sourcing/__fixtures__` and
 * `meeting-recorder/__fixtures__`. The last was grepped for literal addresses by hand and found clean.
 */
const AT = String.raw`(?:\s*(?:\[at\]|\(at\))\s*|&#64;|&#x40;|&commat;)`
const DOT = String.raw`(?:\.|\s*(?:\[dot\]|\(dot\))\s*)`
const LABEL = String.raw`[A-Za-z0-9-]+`
const LITERAL_EMAIL = String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`
const OBFUSCATED_EMAIL = String.raw`[A-Za-z0-9._%+-]+${AT}${LABEL}(?:${DOT}${LABEL})*`
const EMAIL = new RegExp(`${LITERAL_EMAIL}|${OBFUSCATED_EMAIL}`, 'gi')
const PLACEHOLDER = 'redacted@example.invalid'
const PUBLISHED_CONTACTS: Record<string, string[]> = {
  'workingnomads/terms.html.txt': ['hello@workingnomads.com', 'report@workingnomads.com'],
  // Obfuscated, all published role mailboxes of an employer or a platform (checked by reading the context):
  // an employer's contact line in a job post.
  'hn-hiring/thread-2026-10.json': ['jobs[at]openeducation.foundation'],
  // Remotive's own contact for API questions, quoted in its feed.
  'remotive/software-dev.json': ['hello(at)remotive(dot)io'],
  '__raw-captures__/3.2/an-p1.raw.gz': [
    'contact (at) coni-partner.com', // the generic contact line of an employer's imprint block
    'hr.dataprivacy(at)doctolib.com', // an employer's data-protection contact in its job ad
    'security [at] perk', // a platform's published security contact ("security [at] perk .com")
  ],
}

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
const labelOf = (file: string) => relative(file.startsWith(RAW_ROOT) ? __dirname : ROOT, file)
const pathOfLabel = (label: string) =>
  label.startsWith(RAW_LABEL_PREFIX) ? join(__dirname, label) : join(ROOT, label)

function addressesIn(path: string): string[] {
  const raw = readFileSync(path)
  const text = (path.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8')
  return [...new Set((text.match(EMAIL) ?? []).map((a) => a.replace(/\s+/g, ' ')))].sort()
}

describe('no e-mail address, literal or obfuscated, in the two scanned roots except the allow-listed ones', () => {
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
    // A guard, not a probe: with the root narrowed back to `.../3.2` every label below would be
    // computed identically and nothing else in this file would notice. (Checked by hand once with a
    // `__raw-captures__/3.4/hn-probe.raw` file: both the offender scan and the hn- check failed.)
    expect(basename(RAW_ROOT)).toBe('__raw-captures__')
  })

  it('every task directory under __raw-captures__ is reached by the scan', () => {
    // The property that matters, listed from the literal path without reading RAW_ROOT: a later
    // `3.4` directory the walk misses fails here.
    const taskDirs = readdirSync(join(__dirname, '__raw-captures__'))
    expect(taskDirs).toContain('3.2')
    for (const dir of taskDirs) {
      expect(rel.some((f) => f.startsWith(`__raw-captures__/${dir}/`))).toBe(true)
    }
  })

  it('a label resolves to the file it names, in either root (the allow-list path)', () => {
    // The case that used to throw ENOENT: an allow-listed raw-capture label joined against __fixtures__.
    const raw = '__raw-captures__/3.2/robots-workingnomads.txt'
    expect(rel).toContain(raw)
    expect(pathOfLabel(raw)).toBe(join(RAW_ROOT, '3.2', 'robots-workingnomads.txt'))
    expect(() => addressesIn(pathOfLabel(raw))).not.toThrow()
    expect(pathOfLabel('workingnomads/terms.html.txt')).toBe(
      join(ROOT, 'workingnomads', 'terms.html.txt'),
    )
    for (const file of files) expect(pathOfLabel(labelOf(file))).toBe(file)
  })

  it('finds no address except the placeholder and the allow-listed published contacts', () => {
    const offenders = files.flatMap((file) => {
      const name = labelOf(file)
      const allowed = new Set([PLACEHOLDER, ...(PUBLISHED_CONTACTS[name] ?? [])])
      return addressesIn(file)
        .filter((a) => !allowed.has(a))
        .map((a) => `${name}: ${a}`)
    })
    expect(offenders).toEqual([])
  })

  it('every allow-listed file exists and still carries exactly the addresses listed for it', () => {
    for (const [name, expected] of Object.entries(PUBLISHED_CONTACTS)) {
      expect(rel).toContain(name)
      expect(addressesIn(pathOfLabel(name)).filter((a) => a !== PLACEHOLDER)).toEqual(
        [...expected].sort(),
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
