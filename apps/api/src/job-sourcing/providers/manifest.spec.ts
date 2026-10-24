import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jobSourceTypeSchema } from '@crm/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../test/fake-collection-context'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import {
  type BuildInput,
  buildManifest,
  canonicalJson,
  isReporting,
  type Manifest,
  ManifestError,
  type ManifestErrorCode,
  ownershipCountOf,
  ownershipEvidenceOf,
  PERMISSION_STRENGTH,
  READINESS_REASON_MAX_CHARS,
  READY_PERMISSIONS,
  SHA256_OF_NOTHING,
  readinessAt,
  readinessReason,
  type TypeDefinition,
} from './manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from './manifest.adapters'
import { MANIFEST_DEFINITIONS } from './manifest.definitions'
import type { ReportingJobSourceProvider } from './reporting-provider'
import { RECRUITEE_TOKEN_DEADLINE, recruiteeProvider } from './sources/recruitee.provider'

/**
 * The manifest, tested at its seam: `buildManifest` over definitions, a fixture root and adapters.
 *
 * Expected values are written here as LITERALS, read by hand from the fixtures' provenance files
 * and the adapters' documented status; none comes from running the code under test. Every refusal
 * is asserted by its CODE, and every "derived, not retyped" claim is proven by CHANGING the thing it
 * is derived from (a copy of the fixture tree, or a doctored definition) and watching the manifest
 * move. A check that passes whether or not the fixture is read is the failure this phase kept
 * catching.
 */

const NOW = new Date('2026-10-24T00:00:00.000Z')
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

const real = (): BuildInput => ({
  definitions: MANIFEST_DEFINITIONS,
  adapters: MANIFEST_VALIDATION_ADAPTERS,
  fixtureRoot: FIXTURE_ROOT,
})
/**
 * Built on first use INSIDE a test, not at import and not in a hook. A build that throws at import
 * fails the FILE to load, and one that throws in `beforeAll` leaves its tests "skipped"; a mutation
 * run reads both as "no test failed", so a mutant that breaks the build would count as survived.
 * Thrown inside a test body it fails that test, which is what killing a mutant looks like.
 */
let built: Manifest | undefined
// A fresh build per test: a mutation run attributes a line to the tests that EXECUTED it, so a build
// cached across tests would be attributed to the first one alone and the assertions of every later
// test would never be run against a mutant of the build.
beforeEach(() => {
  built = undefined
})
const manifest = {
  get entries() {
    return (built ??= buildManifest(real())).entries
  },
  get types() {
    return (built ??= buildManifest(real())).types
  },
}
const entry = (id: string) => manifest.entries.find((e) => e.id === id)!
const type = (t: string) => manifest.types.find((x) => x.type === t)!

/** Written out, not derived: the 34 stable ids, in manifest order (types by schema order). */
const ENTRY_IDS = [
  'remoteok.api.latest',
  'remotive.api.software-dev',
  'remotive.api.devops',
  'remotive.api.data',
  'himalayas.api.browse',
  'jobicy.api.engineering-europe',
  'arbeitnow.api.feed',
  'jobgether.api.jobs',
  'hn-hiring.thread.latest',
  'greenhouse.board.stripe',
  'greenhouse.board.airbnb',
  'greenhouse.board.cloudflare',
  'lever.board.spotify',
  'lever.board.eu.siteimprove',
  'lever.board.quantco-',
  'ashby.board.linear',
  'ashby.board.supabase',
  'workable.board.huggingface',
  'workable.board.hirefellows',
  'recruitee.board.bunq',
  'personio.board.westwing',
  'personio.board.personio',
  'jooble.api.senior-developer-remote',
  'jsearch.rapidapi.backend',
  'jsearch.rapidapi.frontend',
  'jsearch.rapidapi.ai-engineer',
  'theirstack.api.senior',
  'muse.api.software-engineering-senior',
  'reed.api.senior-developer-remote',
  'djinni.rss.python',
  'djinni.rss.rust',
  'wwr.rss.all-jobs',
  'wwr.rss.devops',
  'euremotejobs.rss.feed',
]

const trees: string[] = []
afterEach(() => {
  for (const t of trees.splice(0)) rmSync(t, { recursive: true, force: true })
})

/** A private copy of the fixture tree, so a test can change a provenance file and nothing else. */
function fixtureCopy(): string {
  const root = mkdtempSync(join(tmpdir(), 'manifest-fixtures-'))
  trees.push(root)
  cpSync(FIXTURE_ROOT, root, { recursive: true })
  return root
}
function editJson(path: string, edit: (o: Record<string, unknown>) => void): void {
  const o = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  edit(o)
  writeFileSync(path, `${JSON.stringify(o, null, 2)}\n`)
}
const rebuildOn = (fixtureRoot: string) => buildManifest({ ...real(), fixtureRoot })

/** A thunk that builds the manifest with one type's definition changed. */
function withDefinition(typeName: string, change: (d: TypeDefinition) => TypeDefinition) {
  return () =>
    buildManifest({
      ...real(),
      definitions: MANIFEST_DEFINITIONS.map((d) => (d.type === typeName ? change(d) : d)),
    })
}
/** What a build is refused with: asserted in the test body, never swallowed here. */
function refusal(build: () => unknown): {
  code: ManifestErrorCode | 'NOT_REFUSED'
  message: string
} {
  try {
    build()
  } catch (e) {
    if (!(e instanceof ManifestError)) throw e
    return { code: e.code, message: e.message }
  }
  return { code: 'NOT_REFUSED', message: '' }
}

/**
 * The refusal a test expects. A string is the EXACT text after the code; a pattern is for the
 * messages that carry a hash, a count or a library's own wording. The message is asserted because a
 * refusal that names nothing is a finding in itself.
 */
function refused(code: ManifestErrorCode, tail: string | RegExp) {
  return {
    code,
    message: typeof tail === 'string' ? `${code}: ${tail}` : expect.stringMatching(tail),
  }
}

// ---------------------------------------------------------------------------

describe('the 31 types: one explicit disposition each', () => {
  const REPORTING = [
    'REMOTEOK_API',
    'REMOTIVE_API',
    'HIMALAYAS_API',
    'JOBICY_API',
    'ARBEITNOW_API',
    'WORKINGNOMADS_API',
    'JOBGETHER_API',
    'HN_HIRING',
    'GREENHOUSE_ATS',
    'LEVER_ATS',
    'ASHBY_ATS',
    'WORKABLE_ATS',
    'SMARTRECRUITERS_ATS',
    'RECRUITEE_ATS',
    'PERSONIO_ATS',
    'JOOBLE_API',
    'JSEARCH_API',
    'THEIRSTACK_API',
    'MUSE_API',
    'REED_API',
    'DJINNI_RSS',
    'WWR_RSS',
    'EUREMOTEJOBS_RSS',
  ]
  const HTML = [
    'JUSTJOIN_HTML',
    'NOFLUFF_HTML',
    'LANDINGJOBS_HTML',
    'NEXTLEVELJOBS_HTML',
    'DICE_HTML',
    'THEHUB_HTML',
    'WTTJ_HTML',
  ]

  it('lists all 31 types, each exactly once, in the schema order', () => {
    expect(manifest.types.map((t) => t.type)).toEqual([...jobSourceTypeSchema.options])
    expect(manifest.types).toHaveLength(31)
  })

  it('23 reporting adapters, DOU on the legacy path, 7 HTML blocked with their owner', () => {
    const byKind = (pred: (t: (typeof manifest.types)[number]) => boolean) =>
      manifest.types.filter(pred).map((t) => t.type)
    expect(
      byKind((t) => t.disposition.kind === 'IMPLEMENTED' && t.disposition.contract === 'REPORTING'),
    ).toEqual(REPORTING)
    expect(
      byKind((t) => t.disposition.kind === 'IMPLEMENTED' && t.disposition.contract === 'LEGACY'),
    ).toEqual(['DOU_RSS'])
    expect(byKind((t) => t.disposition.kind === 'BLOCKED')).toEqual(HTML)
    for (const t of HTML) {
      const d = type(t).disposition
      expect(d.kind === 'BLOCKED' && d.owner).toBe('plan Task 5.6')
      expect(type(t).blockers.map((b) => b.code)).toEqual(['NO_ADAPTER'])
    }
  })

  it('a type with no definition is a finding, not an omission', () => {
    expect(
      refusal(() =>
        buildManifest({
          ...real(),
          definitions: MANIFEST_DEFINITIONS.filter((d) => d.type !== 'WTTJ_HTML'),
        }),
      ),
    ).toEqual(refused('MISSING_DISPOSITION', 'WTTJ_HTML has no disposition'))
  })

  it('a type defined twice is refused', () => {
    expect(
      refusal(() =>
        buildManifest({
          ...real(),
          definitions: [...MANIFEST_DEFINITIONS, MANIFEST_DEFINITIONS[0]!],
        }),
      ),
    ).toEqual(refused('DUPLICATE_DISPOSITION', 'DOU_RSS has two dispositions'))
  })

  it('an entry on a type that is not implemented is refused', () => {
    expect(
      refusal(() =>
        buildManifest({
          ...real(),
          definitions: MANIFEST_DEFINITIONS.map((d) =>
            d.type === 'DICE_HTML'
              ? { ...d, entries: [{ id: 'dice.html.x', config: {}, intervalHours: 24 }] }
              : d,
          ),
        }),
      ),
    ).toEqual(
      refused(
        'NO_ADAPTER',
        'DICE_HTML is not implemented on the reporting contract and cannot carry entries',
      ),
    )
  })
})

describe('unknown providers', () => {
  it('a type name the schema does not know is refused', () => {
    expect(
      refusal(() =>
        buildManifest({
          ...real(),
          definitions: [...MANIFEST_DEFINITIONS, { ...MANIFEST_DEFINITIONS[1]!, type: 'NOPE_API' }],
        }),
      ),
    ).toEqual(refused('UNKNOWN_PROVIDER', 'NOPE_API is not a JobSourceType'))
  })

  it('a type declared implemented with no adapter supplied is refused', () => {
    const adapters = new Map(MANIFEST_VALIDATION_ADAPTERS)
    adapters.delete('REED_API')
    expect(refusal(() => buildManifest({ ...real(), adapters }))).toEqual(
      refused('NO_ADAPTER', 'REED_API is declared implemented and no adapter was supplied'),
    )
  })

  it('an adapter that says it is another type is refused', () => {
    const adapters = new Map(MANIFEST_VALIDATION_ADAPTERS)
    adapters.set('REED_API', MANIFEST_VALIDATION_ADAPTERS.get('JOOBLE_API')!)
    expect(refusal(() => buildManifest({ ...real(), adapters }))).toEqual(
      refused('UNKNOWN_PROVIDER', 'the adapter supplied for REED_API says it is JOOBLE_API'),
    )
  })
})

describe('identity and config', () => {
  it('the manifest holds these 34 entries, in this order, each id once', () => {
    expect(manifest.entries.map((e) => e.id)).toEqual(ENTRY_IDS)
    expect(new Set(ENTRY_IDS).size).toBe(34)
  })

  it('a duplicate id is refused', () => {
    expect(
      refusal(
        withDefinition('REMOTIVE_API', (d) => ({
          ...d,
          entries: d.entries.map((e) => ({ ...e, id: 'remotive.api.devops' })),
        })),
      ),
    ).toEqual(refused('DUPLICATE_ID', 'remotive.api.devops is declared twice'))
  })

  it('two entries with the same (type, config) are refused, whatever order their keys are in', () => {
    expect(
      refusal(
        withDefinition('JOBICY_API', (d) => ({
          ...d,
          entries: [
            d.entries[0]!,
            {
              ...d.entries[0]!,
              id: 'jobicy.api.same',
              config: { geo: 'europe', industry: 'engineering', count: 100 },
            },
          ],
        })),
      ),
    ).toEqual(refused('DUPLICATE_CONFIG', "jobicy.api.same repeats another entry's (type, config)"))
  })

  it.each(['has space', 'UPPER', '-leading', 'a'.repeat(101), 'abcdefghijklmnopqrstuvwxyz'])(
    'the id %j is refused (the column refuses it too)',
    (id) => {
      expect(
        refusal(
          withDefinition('REMOTEOK_API', (d) => ({ ...d, entries: [{ ...d.entries[0]!, id }] })),
        ),
      ).toEqual(
        refused(
          'ID_FORMAT',
          `${JSON.stringify(id)} must match /^[a-z0-9][a-z0-9._:-]{0,99}$/ and contain no unbroken run of 24 lowercase alphanumerics`,
        ),
      )
    },
  )

  it('a 24-character unbroken run in an id is refused, 23 is not', () => {
    const withId = (id: string) =>
      withDefinition('REMOTEOK_API', (d) => ({ ...d, entries: [{ ...d.entries[0]!, id }] }))
    expect(refusal(withId('a'.repeat(24)))).toEqual(
      refused(
        'ID_FORMAT',
        `${JSON.stringify('a'.repeat(24))} must match /^[a-z0-9][a-z0-9._:-]{0,99}$/ and contain no unbroken run of 24 lowercase alphanumerics`,
      ),
    )
    expect(withId('a'.repeat(23))().entries.some((e) => e.id === 'a'.repeat(23))).toBe(true)
  })

  it.each(ENTRY_IDS)(
    "%s: the adapter's OWN parseConfig accepts the stored config plus its version",
    (id) => {
      const e = entry(id)
      const parsed = MANIFEST_VALIDATION_ADAPTERS.get(e.type)!.parseConfig({
        ...e.config,
        configVersion: e.configVersion,
      }) as { namespace: string; configVersion: number }
      expect(parsed.namespace).toBe(e.namespace)
      expect(parsed.configVersion).toBe(e.configVersion)
    },
  )

  it('a config the adapter refuses is refused by the manifest', () => {
    expect(
      refusal(
        withDefinition('REMOTIVE_API', (d) => ({
          ...d,
          entries: [{ ...d.entries[0]!, config: { category: 'Not A Slug!' } }],
        })),
      ),
    ).toEqual(refused('CONFIG_REJECTED', /^CONFIG_REJECTED: remotive\.api\.software-dev: /))
  })

  it('a config that stores its own version or namespace is refused', () => {
    for (const extra of [{ configVersion: 1 }, { namespace: 'remotive' }]) {
      expect(
        refusal(
          withDefinition('REMOTIVE_API', (d) => ({
            ...d,
            entries: [{ ...d.entries[0]!, config: { category: 'devops', ...extra } }],
          })),
        ),
      ).toEqual(
        refused(
          'CONFIG_SHAPE',
          'remotive.api.software-dev: config stores neither configVersion (a column) nor namespace (derived)',
        ),
      )
    }
  })

  it('namespaces come from the adapter: derived for boards, constant for feeds, empty for two RSS feeds', () => {
    expect(entry('greenhouse.board.stripe').namespace).toBe('greenhouse:stripe')
    expect(entry('lever.board.eu.siteimprove').namespace).toBe('lever:eu:siteimprove')
    expect(entry('lever.board.quantco-').namespace).toBe('lever:global:quantco-')
    expect(entry('muse.api.software-engineering-senior').namespace).toBe('themuse')
    expect(entry('wwr.rss.all-jobs').namespace).toBe('')
    expect(entry('euremotejobs.rss.feed').namespace).toBe('')
  })

  it('exactly the 15 entries of the 2026-10-05 seed are marked as legacy', () => {
    expect(manifest.entries.filter((e) => e.legacySeed).map((e) => e.id)).toEqual([
      'remoteok.api.latest',
      'remotive.api.software-dev',
      'remotive.api.devops',
      'remotive.api.data',
      'jobicy.api.engineering-europe',
      'arbeitnow.api.feed',
      'hn-hiring.thread.latest',
      'jooble.api.senior-developer-remote',
      'jsearch.rapidapi.backend',
      'jsearch.rapidapi.frontend',
      'jsearch.rapidapi.ai-engineer',
      'theirstack.api.senior',
      'muse.api.software-engineering-senior',
      'reed.api.senior-developer-remote',
      'euremotejobs.rss.feed',
    ])
  })
})

// ---------------------------------------------------------------------------

describe('hashes are verified against the committed bytes', () => {
  it('every fixture record carries the hash of its own bytes, computed here independently', () => {
    const records = manifest.types.flatMap((t) => t.fixtures)
    expect(records).toHaveLength(61)
    for (const r of records) {
      expect(r.fileSha256, r.path).toBe(sha256(readFileSync(join(FIXTURE_ROOT, r.path))))
      expect(r.provenanceSha256, r.path).toBe(
        sha256(
          readFileSync(
            join(FIXTURE_ROOT, r.path.slice(0, r.path.lastIndexOf('.')) + '.provenance.json'),
          ),
        ),
      )
    }
  })

  it('one changed byte in a fixture is refused', () => {
    const root = fixtureCopy()
    const path = join(root, 'remoteok', 'feed.json')
    writeFileSync(path, `${readFileSync(path, 'utf8')} `)
    expect(refusal(() => rebuildOn(root))).toEqual(
      refused(
        'HASH_MISMATCH',
        /^HASH_MISMATCH: remoteok\/feed\.json: committed bytes hash to [0-9a-f]{64}, provenance says [0-9a-f]{64}$/,
      ),
    )
  })

  it('a provenance file whose fixture is gone, and a fixture with no provenance, are refused', () => {
    const noFixture = fixtureCopy()
    rmSync(join(noFixture, 'remoteok', 'feed.json'))
    expect(refusal(() => rebuildOn(noFixture))).toEqual(
      refused('FIXTURE_MISSING', 'remoteok/feed.provenance.json has no fixture beside it'),
    )
    const noProvenance = fixtureCopy()
    rmSync(join(noProvenance, 'remoteok', 'feed.provenance.json'))
    expect(refusal(() => rebuildOn(noProvenance))).toEqual(
      refused('FIXTURE_MISSING', 'remoteok/feed.json has no feed.provenance.json'),
    )
  })

  it('a provenance file that breaks the contract is refused', () => {
    const root = fixtureCopy()
    editJson(join(root, 'remoteok', 'feed.provenance.json'), (o) => {
      o['permission'] = 'MAYBE'
    })
    expect(refusal(() => rebuildOn(root))).toEqual(
      refused('PROVENANCE_INVALID', /^PROVENANCE_INVALID: remoteok\/feed\.provenance\.json: /),
    )
  })

  it('a fixture directory that is not there is refused', () => {
    const root = fixtureCopy()
    rmSync(join(root, 'remoteok'), { recursive: true })
    expect(refusal(() => rebuildOn(root))).toEqual(
      refused('FIXTURE_DIR_MISSING', 'remoteok is not under the fixture root'),
    )
  })
})

// ---------------------------------------------------------------------------

describe('readiness is derived from provenance, not retyped', () => {
  const READY_AT_SEED = [
    'remoteok.api.latest',
    'himalayas.api.browse',
    'jobicy.api.engineering-europe',
    'greenhouse.board.stripe',
    'lever.board.spotify',
    'workable.board.huggingface',
    'personio.board.westwing',
    'recruitee.board.bunq',
    'arbeitnow.api.feed',
  ]

  it('reads hand-checked sources as candidates and the documented-public ones only', () => {
    for (const id of READY_AT_SEED) {
      expect(readinessAt(entry(id), NOW), id).toEqual({ status: 'CANDIDATE', blockers: [] })
    }
  })

  it('flipping a provenance permission to UNCLEAR makes the entry stop being ready', () => {
    expect(readinessAt(entry('remoteok.api.latest'), NOW).status).toBe('CANDIDATE')
    const root = fixtureCopy()
    editJson(join(root, 'remoteok', 'feed.provenance.json'), (o) => {
      o['permission'] = 'UNCLEAR'
    })
    const flipped = rebuildOn(root).entries.find((e) => e.id === 'remoteok.api.latest')!
    const r = readinessAt(flipped, NOW)
    expect(r.status).toBe('BLOCKED')
    expect(r.blockers.map((b) => b.code)).toEqual(['PERMISSION_UNCLEAR'])
  })

  it('maps each non-ready permission to its own blocker', () => {
    const codeFor = (permission: string) => {
      const root = fixtureCopy()
      editJson(join(root, 'remoteok', 'feed.provenance.json'), (o) => {
        o['permission'] = permission
      })
      return readinessAt(
        rebuildOn(root).entries.find((e) => e.id === 'remoteok.api.latest')!,
        NOW,
      ).blockers.map((b) => b.code)
    }
    expect(codeFor('PROHIBITED')).toEqual(['PERMISSION_PROHIBITED'])
    expect(codeFor('PUBLIC_FEED')).toEqual([])
  })

  it('Arbeitnow (documented permission, status constant not blocked) is ready as a DERIVED consequence', () => {
    const t = type('ARBEITNOW_API')
    expect(t.permission).toBe('PUBLIC_API_DOCUMENTED')
    expect(t.status?.value.blocked).toBe(false)
    expect(readinessAt(entry('arbeitnow.api.feed'), NOW)).toEqual({
      status: 'CANDIDATE',
      blockers: [],
    })
  })

  it('flipping the Arbeitnow status constant back to blocked makes the entry stop being ready', () => {
    const rebuilt = withDefinition('ARBEITNOW_API', (d) => ({
      ...d,
      status: { symbol: d.status!.symbol, value: { ...d.status!.value, blocked: true } },
    }))()
    const r = readinessAt(
      rebuilt.entries.find((e) => e.id === 'arbeitnow.api.feed')!,
      NOW,
    )
    expect(r.status).toBe('BLOCKED')
    expect(r.blockers.map((b) => b.code)).toEqual(['STATUS_CONSTANT_BLOCKED'])
  })

  it('a constant that disagrees with the provenance fails the build, in either direction', () => {
    // Arbeitnow's provenance is PUBLIC_API_DOCUMENTED; flip it, and the constant (which still says
    // PUBLIC_API_DOCUMENTED) now disagrees. Neither may win.
    const root = fixtureCopy()
    for (const f of ['page-1', 'empty-page']) {
      editJson(join(root, 'arbeitnow', `${f}.provenance.json`), (o) => {
        o['permission'] = 'UNCLEAR'
      })
    }
    expect(refusal(() => rebuildOn(root))).toEqual(
      refused(
        'STATUS_CONSTANT_DISAGREES',
        'ARBEITNOW_SOURCE_STATUS.permission is PUBLIC_API_DOCUMENTED but the provenance of ARBEITNOW_API says UNCLEAR',
      ),
    )
    // And the constant moved instead of the provenance.
    expect(
      refusal(
        withDefinition('ARBEITNOW_API', (d) => ({
          ...d,
          status: {
            symbol: d.status!.symbol,
            value: { ...d.status!.value, permission: 'UNCLEAR' },
          },
        })),
      ),
    ).toEqual(
      refused(
        'STATUS_CONSTANT_DISAGREES',
        'ARBEITNOW_SOURCE_STATUS.permission is UNCLEAR but the provenance of ARBEITNOW_API says PUBLIC_API_DOCUMENTED',
      ),
    )
  })

  it('a constant that says "not blocked" over a provenance that is not ready fails the build', () => {
    expect(
      refusal(
        withDefinition('REMOTIVE_API', (d) => ({
          ...d,
          status: { symbol: d.status!.symbol, value: { ...d.status!.value, blocked: false } },
        })),
      ),
    ).toEqual(
      refused(
        'STATUS_CONSTANT_DISAGREES',
        'REMOTIVE_SOURCE_STATUS.blocked is false but the provenance permission UNCLEAR is not a ready one',
      ),
    )
  })

  it('a constant for a type that has no fixture to reconcile with fails the build', () => {
    expect(
      refusal(
        withDefinition('GREENHOUSE_ATS', (d) => {
          const { fixtureDir: _drop, ...rest } = d
          return {
            ...rest,
            entries: [],
            status: {
              symbol: 'X_SOURCE_STATUS',
              value: { blocked: true, permission: 'UNCLEAR', reason: 'x' },
            },
          }
        }),
      ),
    ).toEqual(
      refused(
        'STATUS_CONSTANT_DISAGREES',
        'X_SOURCE_STATUS exists but GREENHOUSE_ATS has no fixture to reconcile it with',
      ),
    )
  })

  it.each([
    ['REMOTIVE_API', ['PERMISSION_UNCLEAR', 'STATUS_CONSTANT_BLOCKED']],
    ['HN_HIRING', ['PERMISSION_UNCLEAR', 'STATUS_CONSTANT_BLOCKED']],
    ['JOBGETHER_API', ['PERMISSION_UNCLEAR', 'STATUS_CONSTANT_BLOCKED']],
    ['MUSE_API', ['PERMISSION_UNCLEAR', 'STATUS_CONSTANT_BLOCKED']],
    ['ASHBY_ATS', ['PERMISSION_UNCLEAR']],
    ['DJINNI_RSS', ['PERMISSION_UNCLEAR']],
    ['WWR_RSS', ['PERMISSION_UNCLEAR']],
    ['EUREMOTEJOBS_RSS', ['PERMISSION_UNCLEAR']],
    ['SMARTRECRUITERS_ATS', ['PERMISSION_UNCLEAR']],
    ['WORKINGNOMADS_API', ['PERMISSION_UNCLEAR', 'STATUS_CONSTANT_BLOCKED']],
    ['JOOBLE_API', ['KEY_REQUIRED', 'NO_CAPTURE', 'STATUS_CONSTANT_BLOCKED']],
    ['JSEARCH_API', ['KEY_REQUIRED', 'NO_CAPTURE', 'STATUS_CONSTANT_BLOCKED']],
    ['REED_API', ['KEY_REQUIRED', 'NO_CAPTURE', 'STATUS_CONSTANT_BLOCKED']],
    ['THEIRSTACK_API', ['KEY_REQUIRED', 'NO_CAPTURE', 'STATUS_CONSTANT_BLOCKED']],
  ])('%s is blocked for exactly these reasons', (t, codes) => {
    expect(type(t).blockers.map((b) => b.code)).toEqual(codes)
  })

  it('a reason too long for the column is refused rather than cut', () => {
    expect(
      refusal(
        withDefinition('REMOTIVE_API', (d) => ({
          ...d,
          status: {
            symbol: d.status!.symbol,
            value: { ...d.status!.value, reason: 'x'.repeat(500) },
          },
        })),
      ),
    ).toEqual(
      refused(
        'REASON_TOO_LONG',
        /^REASON_TOO_LONG: REMOTIVE_API: readiness reason is \d+ characters$/,
      ),
    )
  })
})

// ---------------------------------------------------------------------------

describe('the strength of an employer claim is read, and a partial one is not "verified"', () => {
  it('Greenhouse names the employer in the payload on every job: verified, with the count', () => {
    const o = entry('greenhouse.board.stripe').ownership!
    expect([o.strength, o.verified, o.count]).toEqual([
      'PAYLOAD_FIELD',
      true,
      { matched: 720, total: 720 },
    ])
    expect(entry('greenhouse.board.stripe').verifiedEmployer).toEqual({
      name: 'Stripe',
      domain: 'stripe.com',
    })
  })

  it('Spotify is TEXT_PARTIAL at 87 of 90: carried, and NOT recorded as verified', () => {
    const e = entry('lever.board.spotify')
    expect([e.ownership!.strength, e.ownership!.verified, e.ownership!.count]).toEqual([
      'TEXT_PARTIAL',
      false,
      { matched: 87, total: 90 },
    ])
    expect(e.verifiedEmployer).toBeNull()
    expect((e.config['employer'] as { evidence: string }).evidence).toBe('TEXT_PARTIAL (87 of 90)')
  })

  it('full-text boards are verified at their own counts', () => {
    expect(entry('lever.board.eu.siteimprove').ownership).toMatchObject({
      strength: 'TEXT_FULL',
      verified: true,
      count: { matched: 12, total: 12 },
    })
    expect(entry('lever.board.quantco-').ownership).toMatchObject({
      strength: 'TEXT_FULL',
      verified: true,
      count: { matched: 14, total: 14 },
    })
    expect(entry('ashby.board.linear').ownership).toMatchObject({
      strength: 'TEXT_FULL',
      count: { matched: 34, total: 34 },
    })
  })

  it("flipping a board's EVIDENCE token to TEXT_PARTIAL stops it claiming verified ownership", () => {
    expect(entry('greenhouse.board.airbnb').verifiedEmployer).not.toBeNull()
    const root = fixtureCopy()
    editJson(join(root, 'greenhouse', 'airbnb-board.provenance.json'), (o) => {
      o['notes'] = (o['notes'] as string).replace(
        'EVIDENCE: PAYLOAD_FIELD',
        'EVIDENCE: TEXT_PARTIAL',
      )
    })
    const e = rebuildOn(root).entries.find((x) => x.id === 'greenhouse.board.airbnb')!
    expect([e.ownership!.strength, e.ownership!.verified, e.verifiedEmployer]).toEqual([
      'TEXT_PARTIAL',
      false,
      null,
    ])
  })

  it("the weakest token across an entry's fixtures is the entry's strength", () => {
    const root = fixtureCopy()
    editJson(join(root, 'lever', 'spotify-page2.provenance.json'), (o) => {
      o['notes'] = (o['notes'] as string).replace('EVIDENCE: TEXT_PARTIAL', 'EVIDENCE: TEXT_FULL')
    })
    editJson(join(root, 'lever', 'spotify-page1.provenance.json'), (o) => {
      o['notes'] = (o['notes'] as string).replace(
        'EVIDENCE: TEXT_PARTIAL',
        'EVIDENCE: PAYLOAD_FIELD',
      )
    })
    const e = rebuildOn(root).entries.find((x) => x.id === 'lever.board.spotify')!
    expect(e.ownership!.strength).toBe('TEXT_FULL')
  })

  it('a board fixture with no EVIDENCE token is refused', () => {
    const root = fixtureCopy()
    editJson(join(root, 'greenhouse', 'airbnb-board.provenance.json'), (o) => {
      o['notes'] = (o['notes'] as string).replace('EVIDENCE: PAYLOAD_FIELD', 'EVIDENCE PAYLOAD')
    })
    expect(refusal(() => rebuildOn(root))).toEqual(
      refused('EVIDENCE_TOKEN_MISSING', 'greenhouse/airbnb-board.json carries no EVIDENCE: token'),
    )
  })

  it('an employer that no fixture names, or a domain none mentions, is refused', () => {
    const board = (name: string, domain: string | null) =>
      withDefinition('GREENHOUSE_ATS', (d) => ({
        ...d,
        entries: [
          { ...d.entries[0]!, ownership: { fixtures: ['stripe-board.json'], name, domain } },
        ],
      }))
    expect(refusal(board('Initech', null))).toEqual(
      refused(
        'OWNER_NOT_IN_EVIDENCE',
        'greenhouse.board.stripe: "Initech" appears in none of its fixtures\' notes',
      ),
    )
    expect(refusal(board('Stripe', 'example.org'))).toEqual(
      refused(
        'OWNER_NOT_IN_EVIDENCE',
        "greenhouse.board.stripe: domain example.org appears in none of its fixtures' notes",
      ),
    )
    expect(
      refusal(
        withDefinition('GREENHOUSE_ATS', (d) => ({
          ...d,
          entries: [
            {
              ...d.entries[0]!,
              ownership: { fixtures: ['nope.json'], name: 'Stripe', domain: null },
            },
          ],
        })),
      ),
    ).toEqual(
      refused(
        'FIXTURE_MISSING',
        'greenhouse.board.stripe: ownership fixture nope.json is not under greenhouse',
      ),
    )
  })

  describe('ownershipCountOf reads the sentence provenance writes', () => {
    it.each([
      [
        'OWNERSHIP, EVIDENCE: TEXT_PARTIAL (x): 87 of the 90 postings on the board name Spotify',
        { matched: 87, total: 90 },
      ],
      [
        'OWNERSHIP, EVIDENCE: TEXT_FULL (x): all 12 postings name Siteimprove somewhere',
        { matched: 12, total: 12 },
      ],
      [
        'OWNERSHIP VERIFIED, EVIDENCE: PAYLOAD_FIELD: it is "Stripe" on 720 of 720 jobs',
        { matched: 720, total: 720 },
      ],
      [
        'OWNERSHIP, EVIDENCE: TEXT_FULL: descriptionPlain names Linear in 34 of 34 jobs',
        { matched: 34, total: 34 },
      ],
    ])('%s', (notes, expected) => {
      expect(ownershipCountOf(notes)).toEqual(expected)
    })

    it('an unparsed sentence is unknown, not zero; a count before the OWNERSHIP marker is not read', () => {
      expect(
        ownershipCountOf(
          'OWNERSHIP, EVIDENCE: PAYLOAD_FIELD (the envelope name is "Hugging Face")',
        ),
      ).toBeNull()
      expect(
        ownershipCountOf(
          '23 jobs captured. 3 of 5 jobs kept. OWNERSHIP VERIFIED, EVIDENCE: PAYLOAD_FIELD (x)',
        ),
      ).toBeNull()
    })

    it('the token is read only in its exact form', () => {
      expect(ownershipEvidenceOf('x EVIDENCE: TEXT_FULL y')).toBe('TEXT_FULL')
      expect(ownershipEvidenceOf('x EVIDENCE: SOMETHING y')).toBeNull()
      expect(ownershipEvidenceOf('x evidence: TEXT_FULL y')).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------

describe('a provenance file that says "nothing was captured" is never read as a capture', () => {
  const KEYED = ['JOOBLE_API', 'JSEARCH_API', 'REED_API', 'THEIRSTACK_API']

  it.each(KEYED)('%s: sentinel evidence, no terms date, payload not verified', (t) => {
    const x = type(t)
    expect(x.payloadVerified).toBe(false)
    expect(x.fixtures.map((f) => [f.evidence, f.httpStatus, f.termsCheckedAt])).toEqual([
      ['SENTINEL', 0, null],
    ])
  })

  it('a real capture next to it is verified', () => {
    expect(type('REMOTEOK_API').payloadVerified).toBe(true)
    expect(type('REMOTEOK_API').fixtures[0]!.termsCheckedAt).toBe('2026-10-23T20:10:00.000Z')
  })

  const realCapture = (o: Record<string, unknown>) => {
    o['fetchedAt'] = '2026-10-25T09:00:00.000Z'
    o['termsCheckedAt'] = '2026-10-25T09:05:00.000Z'
    o['httpStatus'] = 200
    o['rawSha256'] = 'a'.repeat(64)
    o['trimmedBy'] = 'scripts/trim.mjs (parser based)'
    o['notes'] = "a real capture, taken by the owner's controlled smoke"
  }

  it("flipping a sentinel to a real capture changes the entry's status", () => {
    const root = fixtureCopy()
    editJson(join(root, 'jooble', 'doc-example.provenance.json'), realCapture)
    const flipped = rebuildOn(root)
    expect(flipped.types.find((t) => t.type === 'JOOBLE_API')!.payloadVerified).toBe(true)
    expect(flipped.types.find((t) => t.type === 'JOOBLE_API')!.blockers.map((b) => b.code)).toEqual(
      ['KEY_REQUIRED', 'STATUS_CONSTANT_BLOCKED'],
    )
  })

  it.each([
    [
      'only the timestamps',
      (o: Record<string, unknown>) => {
        o['fetchedAt'] = '2026-10-25T09:00:00.000Z'
        o['termsCheckedAt'] = '2026-10-25T09:05:00.000Z'
      },
    ],
    [
      'only the status',
      (o: Record<string, unknown>) => {
        o['httpStatus'] = 200
      },
    ],
    [
      'only the hash',
      (o: Record<string, unknown>) => {
        o['rawSha256'] = 'b'.repeat(64)
      },
    ],
    [
      'only the SENTINEL note',
      (o: Record<string, unknown>) => {
        o['notes'] = 'a note'
      },
    ],
    [
      'only trimmedBy',
      (o: Record<string, unknown>) => {
        o['trimmedBy'] = 'script'
      },
    ],
  ])('a half-flipped file (%s) still reads as a sentinel', (_what, edit) => {
    const root = fixtureCopy()
    editJson(join(root, 'jooble', 'doc-example.provenance.json'), edit)
    expect(rebuildOn(root).types.find((t) => t.type === 'JOOBLE_API')!.payloadVerified).toBe(false)
  })

  it('turning a real capture into a sentinel blocks a source that was ready', () => {
    const root = fixtureCopy()
    editJson(join(root, 'remoteok', 'feed.provenance.json'), (o) => {
      o['fetchedAt'] = '1970-01-01T00:00:00.000Z'
    })
    const e = rebuildOn(root).entries.find((x) => x.id === 'remoteok.api.latest')!
    expect(readinessAt(e, NOW).blockers.map((b) => b.code)).toEqual(['NO_CAPTURE'])
  })

  it('a source with no fixture at all is not ready either', () => {
    const noFixtures = withDefinition('GREENHOUSE_ATS', (d) => {
      const { fixtureDir: _drop, ...rest } = d
      return { ...rest, entries: [] }
    })()
    expect(
      noFixtures.types.find((t) => t.type === 'GREENHOUSE_ATS')!.blockers.map((b) => b.code),
    ).toEqual(['NO_CAPTURE'])
  })
})

// ---------------------------------------------------------------------------

describe('a readiness that changes on a date (Recruitee)', () => {
  const DEADLINE = RECRUITEE_TOKEN_DEADLINE.getTime()
  const at = (ms: number) => new Date(ms)
  const bunq = () => entry('recruitee.board.bunq')

  it("reads the date from the adapter's own constant, not a copy of it", () => {
    expect(type('RECRUITEE_ATS').deadlines).toHaveLength(1)
    expect(type('RECRUITEE_ATS').deadlines[0]).toEqual({
      kind: 'AUTH_REQUIRED_FROM',
      at: RECRUITEE_TOKEN_DEADLINE,
      symbol: 'RECRUITEE_TOKEN_DEADLINE',
    })
    expect(type('RECRUITEE_ATS').deadlines[0]!.at).toBe(RECRUITEE_TOKEN_DEADLINE)
    expect(bunq().deadlines[0]!.at).toBe(RECRUITEE_TOKEN_DEADLINE)
  })

  it('is ready one millisecond before, blocked at, and blocked after the deadline', () => {
    expect(readinessAt(bunq(), at(DEADLINE - 1))).toEqual({ status: 'CANDIDATE', blockers: [] })
    for (const t of [DEADLINE, DEADLINE + 1, DEADLINE + 365 * 24 * 3600 * 1000]) {
      const r = readinessAt(bunq(), at(t))
      expect(r.status).toBe('BLOCKED')
      expect(r.blockers.map((b) => b.code)).toEqual(['AUTH_DEADLINE_PASSED'])
      expect(r.blockers[0]!.detail).toContain('RECRUITEE_TOKEN_DEADLINE')
    }
  })

  it('and so does the type, which carries the same answer for the source as a whole', () => {
    expect(readinessAt(type('RECRUITEE_ATS'), at(DEADLINE - 1)).status).toBe('CANDIDATE')
    expect(readinessAt(type('RECRUITEE_ATS'), at(DEADLINE)).status).toBe('BLOCKED')
  })

  it('agrees with the adapter at the same instants: it sends a request exactly while the manifest says candidate', async () => {
    for (const t of [DEADLINE - 1, DEADLINE, DEADLINE + 1]) {
      const f = fakeCollectionContext({
        now: at(t),
        responses: [{ status: 200, bodyText: JSON.stringify({ offers: [] }) }],
      })
      await recruiteeProvider.collectReport(
        recruiteeProvider.parseConfig({ ...bunq().config, configVersion: bunq().configVersion }),
        f.ctx,
      )
      expect(f.sent.length > 0, `at ${t - DEADLINE} ms from the deadline`).toBe(
        readinessAt(bunq(), at(t)).status === 'CANDIDATE',
      )
    }
  })

  it('the seeded stories agree: nothing else in the manifest has a deadline', () => {
    expect(manifest.types.filter((t) => t.deadlines.length > 0).map((t) => t.type)).toEqual([
      'RECRUITEE_ATS',
    ])
  })

  it('an auth deadline needs the auth requirement to say so, and the reverse', () => {
    expect(refusal(withDefinition('RECRUITEE_ATS', (d) => ({ ...d, auth: 'NONE' })))).toEqual(
      refused(
        'DEADLINE_DISAGREES',
        'RECRUITEE_ATS: auth NONE does not match its AUTH_REQUIRED_FROM deadline',
      ),
    )
    expect(
      refusal(
        withDefinition('REMOTEOK_API', (d) => ({ ...d, auth: 'EMPLOYER_TOKEN_FROM_DEADLINE' })),
      ),
    ).toEqual(
      refused(
        'DEADLINE_DISAGREES',
        'REMOTEOK_API: auth EMPLOYER_TOKEN_FROM_DEADLINE does not match its AUTH_REQUIRED_FROM deadline',
      ),
    )
  })

  it('a policy expiry blocks from its instant, too', () => {
    const expiry = new Date('2026-12-01T00:00:00.000Z')
    const m = withDefinition('REMOTEOK_API', (d) => ({
      ...d,
      deadlines: [{ kind: 'POLICY_EXPIRES', at: expiry, symbol: 'TEST_POLICY_EXPIRY' }],
    }))()
    const e = m.entries.find((x) => x.id === 'remoteok.api.latest')!
    expect(readinessAt(e, new Date(expiry.getTime() - 1)).status).toBe('CANDIDATE')
    const r = readinessAt(e, expiry)
    expect([r.status, r.blockers.map((b) => b.code)]).toEqual(['BLOCKED', ['POLICY_EXPIRED']])
  })

  it('DOU stays on the legacy path whatever the clock says', () => {
    expect(readinessAt(type('DOU_RSS'), at(DEADLINE + 1))).toEqual({
      status: 'LEGACY',
      blockers: [],
    })
  })
})

// ---------------------------------------------------------------------------

describe('authentication and attribution agree with what the provenance says', () => {
  it('an API-key source must have KEY_REQUIRED provenance, and the reverse', () => {
    expect(refusal(withDefinition('JOOBLE_API', (d) => ({ ...d, auth: 'NONE' })))).toEqual(
      refused(
        'AUTH_DISAGREES',
        'JOOBLE_API: auth NONE against provenance permissions KEY_REQUIRED',
      ),
    )
    expect(refusal(withDefinition('REMOTEOK_API', (d) => ({ ...d, auth: 'API_KEY' })))).toEqual(
      refused(
        'AUTH_DISAGREES',
        'REMOTEOK_API: auth API_KEY against provenance permissions PUBLIC_API_DOCUMENTED',
      ),
    )
  })

  it('an attribution duty needs a note recording it, and a recorded one needs declaring', () => {
    expect(
      refusal(
        withDefinition('GREENHOUSE_ATS', (d) => ({ ...d, attribution: 'LINK_BACK_REQUIRED' })),
      ),
    ).toEqual(
      refused(
        'ATTRIBUTION_UNSUPPORTED',
        'GREENHOUSE_ATS declares LINK_BACK_REQUIRED and no provenance note records an obligation',
      ),
    )
    expect(
      refusal(withDefinition('REMOTEOK_API', (d) => ({ ...d, attribution: 'NONE_RECORDED' }))),
    ).toEqual(
      refused(
        'ATTRIBUTION_UNDECLARED',
        'REMOTEOK_API declares no attribution and a provenance note records one',
      ),
    )
  })

  it('records the attribution duties as the provenance states them', () => {
    expect(
      manifest.types
        .filter((t) => t.attribution !== 'NONE_RECORDED')
        .map((t) => [t.type, t.attribution]),
    ).toEqual([
      ['REMOTEOK_API', 'LINK_BACK_REQUIRED'],
      ['REMOTIVE_API', 'LINK_BACK_REQUIRED'],
      ['HIMALAYAS_API', 'CREDIT_REQUIRED'],
      ['JOBICY_API', 'CREDIT_REQUIRED'],
      ['ARBEITNOW_API', 'LINK_BACK_REQUIRED'],
      ['MUSE_API', 'LINK_BACK_REQUIRED'],
    ])
  })

  it('policy references: the terms URL and the date it was read, null for a sentinel', () => {
    expect(type('REMOTEOK_API').policyRefs).toEqual([
      { termsUrl: 'https://remoteok.com/api', termsCheckedAt: '2026-10-23T20:10:00.000Z' },
    ])
    expect(type('JSEARCH_API').policyRefs).toEqual([
      { termsUrl: 'https://www.openwebninja.com/api/jsearch', termsCheckedAt: null },
    ])
  })
})

// ---------------------------------------------------------------------------

describe("quota accounts: consistent units, and a limit that is the provider's, not a row count", () => {
  const accounts = () => {
    const m = new Map<string, Set<string>>()
    for (const t of manifest.types) {
      if (t.quota) m.set(t.quota.account, new Set([...(m.get(t.quota.account) ?? []), t.type]))
    }
    return m
  }

  it('four accounts, one per keyed provider, each in one unit', () => {
    expect(
      manifest.types
        .filter((t) => t.quota)
        .map((t) => [t.quota!.account, t.quota!.unit, t.quota!.window, t.quota!.limit]),
    ).toEqual([
      ['jooble:api-main', 'REQUEST', null, null],
      ['jsearch:rapidapi-main', 'REQUEST', 'MONTH', 200],
      ['theirstack:api-main', 'RECORD', null, null],
      ['reed:api-main', 'REQUEST', null, null],
    ])
    expect(accounts().size).toBe(4)
  })

  it("JSearch's three queries share ONE account whose limit is 200, not the 180 their rows add up to", () => {
    const jsearch = manifest.entries.filter((e) => e.type === 'JSEARCH_API')
    expect(jsearch).toHaveLength(3)
    expect(jsearch.reduce((n, e) => n + e.budget!.limit, 0)).toBe(180)
    expect(type('JSEARCH_API').quota!.limit).toBe(200)
  })

  it('the schedule fits the account: 3 sources daily is 90 requests a month against 200', () => {
    // 720 h / 24 h = 30 runs a month each, one request per run, three sources.
    expect(3 * Math.floor((30 * 24) / 24) * type('JSEARCH_API').requestsPerRun).toBe(90)
  })

  it('a schedule that outruns the account is refused', () => {
    expect(
      refusal(
        withDefinition('JSEARCH_API', (d) => ({
          ...d,
          entries: d.entries.map((e) => ({
            ...e,
            intervalHours: 6,
            budget: { limit: 200, window: 'MONTH' as const },
          })),
        })),
      ),
    ).toEqual(
      refused(
        'QUOTA_INCONSISTENT',
        'jsearch:rapidapi-main: the schedule needs 360 requests a month against a limit of 200',
      ),
    )
  })

  it('exactly at the limit is accepted and one request past it is refused', () => {
    // 5 requests a run, 6 h apart: 120 runs x 5 = 600 requests a month for one source.
    const sized = (limit: number) =>
      withDefinition('JSEARCH_API', (d) => ({
        ...d,
        requestsPerRun: 5,
        quota: { ...d.quota!, limit },
        entries: [
          { ...d.entries[0]!, intervalHours: 6, budget: { limit: 120, window: 'MONTH' as const } },
        ],
      }))
    expect(sized(600)).not.toThrow()
    expect(refusal(sized(599))).toEqual(
      refused(
        'QUOTA_INCONSISTENT',
        'jsearch:rapidapi-main: the schedule needs 600 requests a month against a limit of 599',
      ),
    )
  })

  it('one account in two units is refused: a request counter and a record counter are not one counter', () => {
    expect(
      refusal(
        withDefinition('THEIRSTACK_API', (d) => ({
          ...d,
          quota: { ...d.quota!, account: 'jooble:api-main', unit: 'RECORD' as const },
        })),
      ),
    ).toEqual(
      refused('QUOTA_INCONSISTENT', 'jooble:api-main is declared twice with different terms'),
    )
  })

  it('a limit with no window, or a window with no limit, is refused', () => {
    expect(
      refusal(
        withDefinition('JOOBLE_API', (d) => ({
          ...d,
          quota: { ...d.quota!, window: 'MONTH' as const },
        })),
      ),
    ).toEqual(
      refused('QUOTA_INCONSISTENT', 'jooble:api-main: limit and window are both set or both null'),
    )
    expect(
      refusal(
        withDefinition('JSEARCH_API', (d) => ({ ...d, quota: { ...d.quota!, window: null } })),
      ),
    ).toEqual(
      refused(
        'QUOTA_INCONSISTENT',
        'jsearch:rapidapi-main: limit and window are both set or both null',
      ),
    )
  })

  it('a limit that is not a non-negative integer is refused', () => {
    for (const limit of [-1, 1.5]) {
      expect(
        refusal(withDefinition('JSEARCH_API', (d) => ({ ...d, quota: { ...d.quota!, limit } }))),
      ).toEqual(
        refused(
          'QUOTA_INCONSISTENT',
          `jsearch:rapidapi-main: limit ${limit} is not a non-negative integer`,
        ),
      )
    }
  })
})

describe('cadence', () => {
  it('records the intentions: daily by default, Jooble weekly, TheirStack every 4 days', () => {
    expect(entry('remoteok.api.latest').intervalHours).toBe(24)
    expect(entry('jooble.api.senior-developer-remote').intervalHours).toBe(168)
    expect(entry('theirstack.api.senior').intervalHours).toBe(96)
  })

  it("refuses an interval under a provider's own floor, at the floor and one under it", () => {
    const at = (h: number) =>
      withDefinition('REMOTIVE_API', (d) => ({
        ...d,
        entries: [{ ...d.entries[0]!, intervalHours: h }],
      }))
    expect(at(6)).not.toThrow()
    expect(refusal(at(5))).toEqual(
      refused(
        'CADENCE_INVALID',
        "remotive.api.software-dev: 5 h is under the 6 h the provider's terms allow",
      ),
    )
  })

  it.each([0, -1, 1.5])('refuses an interval of %s hours', (h) => {
    expect(
      refusal(
        withDefinition('REMOTEOK_API', (d) => ({
          ...d,
          entries: [{ ...d.entries[0]!, intervalHours: h }],
        })),
      ),
    ).toEqual(
      refused(
        'CADENCE_INVALID',
        `remoteok.api.latest: intervalHours ${h} is not a positive integer`,
      ),
    )
  })

  it('refuses a monthly budget the schedule would exhaust: at the budget is fine, one run over is not', () => {
    // 168 h apart is 4 runs a month.
    const budget = (limit: number) =>
      withDefinition('JOOBLE_API', (d) => ({
        ...d,
        entries: [{ ...d.entries[0]!, budget: { limit, window: 'MONTH' as const } }],
      }))
    expect(budget(4)).not.toThrow()
    expect(refusal(budget(3))).toEqual(
      refused(
        'CADENCE_INVALID',
        'jooble.api.senior-developer-remote: 4 scheduled runs a month exceed its own budget of 3',
      ),
    )
  })
})

describe('the manifest stays out of the production build', () => {
  const SRC = join(__dirname, '..', '..')
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name)
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(p)
      return p.endsWith('.ts') ? [p] : []
    })
  const isTest = (p: string) =>
    /\.(spec|test)\.ts$/.test(p) || p.includes(`${join('src', 'test')}/`)
  const isManifest = (p: string) => /providers\/manifest[^/]*\.ts$/.test(p)

  it('the build tsconfig excludes every manifest module', () => {
    const build = JSON.parse(readFileSync(join(SRC, '..', 'tsconfig.build.json'), 'utf8')) as {
      exclude: string[]
    }
    expect(build.exclude).toContain('src/job-sourcing/providers/manifest*.ts')
  })

  it('no production source file anywhere in src imports a manifest module', () => {
    const all = sources(SRC)
    expect(all.filter(isManifest).length).toBeGreaterThanOrEqual(6)
    const importers = all
      .filter((p) => !isTest(p) && !isManifest(p))
      .filter((p) => /from\s+'[^']*\/manifest(\.[a-z-]+)?'/.test(readFileSync(p, 'utf8')))
    expect(importers).toEqual([])
  })
})

describe('the manifest is not a registry', () => {
  it('makes no source runnable: no module, service or cron imports the manifest or its adapter map', () => {
    const root = join(__dirname, '..')
    for (const f of [
      'job-sourcing.module.ts',
      'job-sourcing.service.ts',
      'job-sourcing.cron.ts',
      'job-sourcing.controller.ts',
    ]) {
      const text = readFileSync(join(root, f), 'utf8')
      expect(text, f).not.toMatch(/providers\/manifest/)
    }
  })
})

// ---------------------------------------------------------------------------
// Exact behaviour: the constants, the markers and the boundaries
// ---------------------------------------------------------------------------

describe('exact behaviour: constants, markers and boundaries', () => {
  const permissionOf = (root: string, t: string) =>
    rebuildOn(root).types.find((x) => x.type === t)!.permission
  const setPermission = (root: string, dir: string, file: string, permission: string) =>
    editJson(join(root, dir, `${file}.provenance.json`), (o) => {
      o['permission'] = permission
    })

  it('a ManifestError carries its code, a prefixed message and its name', () => {
    const e = new ManifestError('ID_FORMAT', 'nothing to see')
    expect([e.code, e.message, e.name]).toEqual([
      'ID_FORMAT',
      'ID_FORMAT: nothing to see',
      'ManifestError',
    ])
    expect(e).toBeInstanceOf(Error)
  })

  it('the permission order, weakest first, and the ready set are exactly these', () => {
    expect(PERMISSION_STRENGTH).toEqual([
      'PROHIBITED',
      'UNCLEAR',
      'KEY_REQUIRED',
      'PUBLIC_FEED',
      'PUBLIC_API_DOCUMENTED',
    ])
    expect([...READY_PERMISSIONS].sort()).toEqual(['PUBLIC_API_DOCUMENTED', 'PUBLIC_FEED'])
  })

  it("a source's permission is the WEAKEST of its fixtures'", () => {
    const himalayas = fixtureCopy()
    setPermission(himalayas, 'himalayas', 'browse-page2', 'PUBLIC_FEED')
    expect(permissionOf(himalayas, 'HIMALAYAS_API')).toBe('PUBLIC_FEED')

    const prohibited = fixtureCopy()
    setPermission(prohibited, 'ashby', 'linear-board', 'PROHIBITED')
    expect(permissionOf(prohibited, 'ASHBY_ATS')).toBe('PROHIBITED')

    const oneUnclear = fixtureCopy()
    for (const f of ['board-not-found', 'deel-empty-board', 'supabase-board']) {
      setPermission(oneUnclear, 'ashby', f, 'PUBLIC_API_DOCUMENTED')
    }
    expect(permissionOf(oneUnclear, 'ASHBY_ATS')).toBe('UNCLEAR')
  })

  it('a status constant that says "not blocked" over a ready permission adds no blocker', () => {
    for (const permission of ['PUBLIC_FEED', 'PUBLIC_API_DOCUMENTED'] as const) {
      const root = fixtureCopy()
      setPermission(root, 'remoteok', 'feed', permission)
      const m = buildManifest({
        ...real(),
        fixtureRoot: root,
        definitions: MANIFEST_DEFINITIONS.map((d) =>
          d.type === 'REMOTEOK_API'
            ? {
                ...d,
                status: {
                  symbol: 'TEST_SOURCE_STATUS',
                  value: { blocked: false, permission, reason: 'ready' },
                },
              }
            : d,
        ),
      })
      expect(m.types.find((t) => t.type === 'REMOTEOK_API')!.blockers).toEqual([])
    }
  })

  it('each permission blocker states what it found', () => {
    const root = fixtureCopy()
    setPermission(root, 'remoteok', 'feed', 'PROHIBITED')
    expect(rebuildOn(root).types.find((t) => t.type === 'REMOTEOK_API')!.blockers).toEqual([
      { code: 'PERMISSION_PROHIBITED', detail: 'a fixture records permission PROHIBITED' },
    ])
    expect(type('DJINNI_RSS').blockers).toEqual([
      { code: 'PERMISSION_UNCLEAR', detail: 'a fixture records permission UNCLEAR' },
    ])
    expect(type('JOOBLE_API').blockers[0]).toEqual({
      code: 'KEY_REQUIRED',
      detail: 'a fixture records permission KEY_REQUIRED',
    })
  })

  describe('the sentinel markers, each on its own', () => {
    const MARKERS: [string, (o: Record<string, unknown>) => void][] = [
      ['fetchedAt at the epoch', (o) => void (o['fetchedAt'] = '1970-01-01T00:00:00.000Z')],
      [
        'termsCheckedAt at the epoch',
        (o) => void (o['termsCheckedAt'] = '1970-01-01T00:00:00.000Z'),
      ],
      ['httpStatus 0', (o) => void (o['httpStatus'] = 0)],
      [
        'the hash of the empty string',
        (o) =>
          void (o['rawSha256'] =
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
      ],
      ['notes starting SENTINEL:', (o) => void (o['notes'] = `SENTINEL: ${o['notes'] as string}`)],
      [
        'trimmedBy starting "none: written by hand"',
        (o) => void (o['trimmedBy'] = 'none: written by hand from the documentation'),
      ],
    ]
    const remoteok = (root: string) => rebuildOn(root).types.find((t) => t.type === 'REMOTEOK_API')!

    it.each(MARKERS)('%s alone makes a real capture a sentinel', (_name, edit) => {
      const root = fixtureCopy()
      editJson(join(root, 'remoteok', 'feed.provenance.json'), edit)
      const t = remoteok(root)
      expect([t.fixtures[0]!.evidence, t.payloadVerified]).toEqual(['SENTINEL', false])
    })

    it('the two prefix markers are prefixes: the same words later in the text are a capture', () => {
      const root = fixtureCopy()
      editJson(join(root, 'remoteok', 'feed.provenance.json'), (o) => {
        o['notes'] = `${o['notes'] as string} (the previous file said SENTINEL:)`
        o['trimmedBy'] = 'a script; not "none: written by hand"'
      })
      expect(remoteok(root).fixtures[0]!.evidence).toBe('CAPTURE')
    })

    it('"none:" alone is not the marker: an untouched real response says so too', () => {
      const root = fixtureCopy()
      editJson(join(root, 'remoteok', 'feed.provenance.json'), (o) => {
        o['trimmedBy'] = 'none: the complete response, stored as received'
      })
      expect(remoteok(root).fixtures[0]!.evidence).toBe('CAPTURE')
    })

    it('the terms date is dropped only for a sentinel whose terms date IS the epoch', () => {
      const root = fixtureCopy()
      editJson(join(root, 'remoteok', 'feed.provenance.json'), (o) => {
        o['fetchedAt'] = '1970-01-01T00:00:00.000Z'
      })
      expect(remoteok(root).fixtures[0]!.termsCheckedAt).toBe('2026-10-23T20:10:00.000Z')
      editJson(join(root, 'remoteok', 'feed.provenance.json'), (o) => {
        o['termsCheckedAt'] = '1970-01-01T00:00:00.000Z'
      })
      expect(remoteok(root).fixtures[0]!.termsCheckedAt).toBeNull()
    })

    it('one sentinel among captures is not a blocker, but the payload is not verified', () => {
      const root = fixtureCopy()
      editJson(join(root, 'himalayas', 'browse-page2.provenance.json'), (o) => {
        o['httpStatus'] = 0
      })
      const t = rebuildOn(root).types.find((x) => x.type === 'HIMALAYAS_API')!
      expect(t.blockers).toEqual([])
      expect(t.payloadVerified).toBe(false)
      expect(t.fixtures.map((f) => f.evidence)).toEqual(['CAPTURE', 'SENTINEL', 'CAPTURE'])
    })

    it('a source with no fixture says so, and a sentinel-only one says that', () => {
      const none = withDefinition('GREENHOUSE_ATS', (d) => {
        const { fixtureDir: _drop, ...rest } = d
        return { ...rest, entries: [] }
      })()
      const g = none.types.find((t) => t.type === 'GREENHOUSE_ATS')!
      expect(g.blockers).toEqual([{ code: 'NO_CAPTURE', detail: 'no fixture was committed' }])
      expect(g.payloadVerified).toBe(false)
      expect(type('JSEARCH_API').blockers[1]).toEqual({
        code: 'NO_CAPTURE',
        detail: 'every fixture is a hand-written unit example',
      })
    })
  })

  it('the evidence token is null, not undefined, when absent', () => {
    expect(ownershipEvidenceOf('')).toBeNull()
    expect(ownershipEvidenceOf('EVIDENCE: TEXT_PARTIAL')).toBe('TEXT_PARTIAL')
  })

  it('a count is read from the whole text when it has no OWNERSHIP marker', () => {
    expect(ownershipCountOf('all 12 postings name the employer')).toEqual({
      matched: 12,
      total: 12,
    })
    expect(ownershipCountOf('3 of the 7 jobs')).toEqual({ matched: 3, total: 7 })
    expect(ownershipCountOf('nothing countable here')).toBeNull()
  })

  it('canonicalJson sorts keys at every depth and writes every value form', () => {
    expect(canonicalJson({ b: [1, { d: 2, c: null }], a: 'x' })).toBe(
      '{"a":"x","b":[1,{"c":null,"d":2}]}',
    )
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
    expect(canonicalJson([1, 'two', [3]])).toBe('[1,"two",[3]]')
    expect(canonicalJson([])).toBe('[]')
    expect(canonicalJson({})).toBe('{}')
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson('s')).toBe('"s"')
    expect(canonicalJson(5)).toBe('5')
  })

  it('a type with no fixtures and an API key says "none" in the auth refusal', () => {
    expect(
      refusal(
        withDefinition('GREENHOUSE_ATS', (d) => {
          const { fixtureDir: _drop, ...rest } = d
          return { ...rest, entries: [], auth: 'API_KEY' }
        }),
      ),
    ).toEqual(
      refused('AUTH_DISAGREES', 'GREENHOUSE_ATS: auth API_KEY against provenance permissions none'),
    )
  })

  describe('the reporting contract', () => {
    it('a legacy type cannot carry entries, and an adapter supplied for a non-reporting type is ignored', () => {
      expect(
        refusal(
          withDefinition('DOU_RSS', (d) => ({
            ...d,
            entries: [{ id: 'dou.rss.x', config: {}, intervalHours: 24 }],
          })),
        ),
      ).toEqual(
        refused(
          'NO_ADAPTER',
          'DOU_RSS is not implemented on the reporting contract and cannot carry entries',
        ),
      )
      const adapters = new Map(MANIFEST_VALIDATION_ADAPTERS)
      adapters.set('DICE_HTML', MANIFEST_VALIDATION_ADAPTERS.get('JOOBLE_API')!)
      adapters.set('DOU_RSS', MANIFEST_VALIDATION_ADAPTERS.get('JOOBLE_API')!)
      expect(buildManifest({ ...real(), adapters }).types).toHaveLength(31)
    })

    it('the legacy and the blocked types carry exactly their own blockers', () => {
      expect(type('DOU_RSS').blockers).toEqual([])
      expect(type('JUSTJOIN_HTML').blockers).toEqual([
        {
          code: 'NO_ADAPTER',
          detail: 'no adapter is implemented; the HTML adapters are plan Task 5.6',
        },
      ])
      expect(type('REMOTEOK_API').status).toBeNull()
      expect(type('REMOTIVE_API').status?.symbol).toBe('REMOTIVE_SOURCE_STATUS')
      expect(type('REMOTEOK_API').payloadVerified).toBe(true)
    })
  })

  describe('the readiness text', () => {
    it('is null for a ready entry and the joined blockers for a blocked one', () => {
      expect(readinessReason(readinessAt(entry('remoteok.api.latest'), NOW))).toBeNull()
      expect(readinessReason(readinessAt(type('ARBEITNOW_API'), NOW))).toBeNull()
      expect(
        readinessReason(readinessAt(type('REMOTIVE_API'), NOW))!.startsWith(
          'PERMISSION_UNCLEAR: a fixture records permission UNCLEAR; STATUS_CONSTANT_BLOCKED: robots.txt',
        ),
      ).toBe(true)
    })

    it('stops at 500 characters: 500 is accepted, 501 is refused', () => {
      const prefix =
        'PERMISSION_UNCLEAR: a fixture records permission UNCLEAR; STATUS_CONSTANT_BLOCKED: '
      expect(READINESS_REASON_MAX_CHARS).toBe(500)
      const reasonOf = (n: number) =>
        withDefinition('REMOTIVE_API', (d) => ({
          ...d,
          status: {
            symbol: d.status!.symbol,
            value: { ...d.status!.value, reason: 'x'.repeat(n) },
          },
        }))
      const ok = reasonOf(500 - prefix.length)()
      expect(
        readinessReason(
          readinessAt(
            ok.types.find((t) => t.type === 'REMOTIVE_API')!,
            NOW,
          ),
        ),
      ).toHaveLength(500)
      expect(refusal(reasonOf(501 - prefix.length)).code).toBe('REASON_TOO_LONG')
    })

    it('the clock-dependent blockers say what and when', () => {
      const expiry = new Date('2026-12-01T00:00:00.000Z')
      const m = withDefinition('REMOTEOK_API', (d) => ({
        ...d,
        deadlines: [{ kind: 'POLICY_EXPIRES', at: expiry, symbol: 'TEST_POLICY_EXPIRY' }],
      }))()
      expect(
        readinessAt(
          m.types.find((t) => t.type === 'REMOTEOK_API')!,
          expiry,
        ).blockers,
      ).toEqual([
        {
          code: 'POLICY_EXPIRED',
          detail: 'the policy lapsed at 2026-12-01T00:00:00.000Z (TEST_POLICY_EXPIRY)',
        },
      ])
      expect(readinessAt(type('RECRUITEE_ATS'), RECRUITEE_TOKEN_DEADLINE).blockers).toEqual([
        {
          code: 'AUTH_DEADLINE_PASSED',
          detail:
            'credentials the collector cannot hold are required from 2027-02-10T00:00:00.000Z (RECRUITEE_TOKEN_DEADLINE)',
        },
      ])
    })
  })

  describe('policy references', () => {
    const referencesRead = (dir: string) =>
      readdirSync(join(FIXTURE_ROOT, dir))
        .filter((f) => f.endsWith('.provenance.json'))
        .map(
          (f) =>
            JSON.parse(readFileSync(join(FIXTURE_ROOT, dir, f), 'utf8')) as {
              termsUrl: string
              termsCheckedAt: string
            },
        )
        .map((p) => `${p.termsUrl}|${p.termsCheckedAt}`)

    it.each([
      ['REMOTEOK_API', 'remoteok'],
      ['GREENHOUSE_ATS', 'greenhouse'],
      ['ASHBY_ATS', 'ashby'],
      ['LEVER_ATS', 'lever'],
      ['WWR_RSS', 'wwr'],
    ])('%s: the distinct (terms URL, date) pairs of its provenance files, once each', (t, dir) => {
      const expected = [...new Set(referencesRead(dir))].sort()
      const actual = type(t)
        .policyRefs.map((r) => `${r.termsUrl}|${r.termsCheckedAt}`)
        .sort()
      expect(actual).toEqual(expected)
      expect(new Set(actual).size).toBe(actual.length)
    })
  })

  describe('ownership with several fixtures', () => {
    const spotify = (name: string, domain: string | null) =>
      withDefinition('LEVER_ATS', (d) => ({
        ...d,
        entries: [
          {
            ...d.entries[0]!,
            ownership: { fixtures: ['spotify-page1.json', 'spotify-page2.json'], name, domain },
          },
        ],
      }))

    it('one fixture naming the employer is enough', () => {
      expect(
        spotify('palantir', null)().entries.find((e) => e.id === 'lever.board.spotify')!.ownership!
          .claimedName,
      ).toBe('palantir')
      expect(refusal(spotify('nobody-named-this', null)).code).toBe('OWNER_NOT_IN_EVIDENCE')
    })

    it('one fixture mentioning the domain is enough', () => {
      const root = fixtureCopy()
      editJson(join(root, 'lever', 'spotify-page2.provenance.json'), (o) => {
        o['notes'] = `${o['notes'] as string} See example-only.test.`
      })
      const m = buildManifest({
        ...real(),
        fixtureRoot: root,
        definitions: MANIFEST_DEFINITIONS.map((d) =>
          d.type === 'LEVER_ATS'
            ? {
                ...d,
                entries: [
                  {
                    ...d.entries[0]!,
                    ownership: {
                      fixtures: ['spotify-page1.json', 'spotify-page2.json'],
                      name: 'Spotify',
                      domain: 'example-only.test',
                    },
                  },
                ],
              }
            : d,
        ),
      })
      expect(m.entries.find((e) => e.id === 'lever.board.spotify')!.ownership!.claimedDomain).toBe(
        'example-only.test',
      )
    })
  })

  describe('quota arithmetic', () => {
    const shared = (limit: number) => ({
      account: 'shared:test',
      unit: 'REQUEST' as const,
      window: 'MONTH' as const,
      limit,
      limitSource: 'a test',
    })
    const sharedBy = (limit: number) => () =>
      buildManifest({
        ...real(),
        definitions: MANIFEST_DEFINITIONS.map((d) =>
          d.type === 'JOOBLE_API' || d.type === 'REED_API' ? { ...d, quota: shared(limit) } : d,
        ),
      })

    it('an account shared by two types is charged for both: 4 + 30 = 34 requests a month', () => {
      expect(sharedBy(34)().types.filter((t) => t.quota?.account === 'shared:test')).toHaveLength(2)
      expect(refusal(sharedBy(33))).toEqual(
        refused(
          'QUOTA_INCONSISTENT',
          'shared:test: the schedule needs 34 requests a month against a limit of 33',
        ),
      )
    })

    it('a record-counted account is not checked against a request schedule', () => {
      const m = withDefinition('THEIRSTACK_API', (d) => ({
        ...d,
        quota: { ...d.quota!, window: 'MONTH' as const, limit: 1 },
      }))()
      expect(m.types.find((t) => t.type === 'THEIRSTACK_API')!.quota!.limit).toBe(1)
    })

    it('a zero limit on a daily window is valid; the schedule arithmetic is monthly only', () => {
      const m = withDefinition('JSEARCH_API', (d) => ({
        ...d,
        quota: { ...d.quota!, window: 'DAY' as const, limit: 0 },
      }))()
      expect(m.types.find((t) => t.type === 'JSEARCH_API')!.quota!.limit).toBe(0)
    })
  })

  describe('cadence boundaries', () => {
    const remoteok = (intervalHours: number, budget?: { limit: number; window: 'DAY' | 'MONTH' }) =>
      withDefinition('REMOTEOK_API', (d) => ({
        ...d,
        entries: [{ ...d.entries[0]!, intervalHours, ...(budget ? { budget } : {}) }],
      }))

    it('an interval of one hour is valid', () => {
      expect(remoteok(1)().entries[0]!.intervalHours).toBe(1)
    })

    it('a daily budget is checked against runs a day: 2 runs fit a budget of 2, not of 1', () => {
      expect(remoteok(12, { limit: 2, window: 'DAY' })().entries[0]!.budget).toEqual({
        limit: 2,
        window: 'DAY',
      })
      expect(refusal(remoteok(12, { limit: 1, window: 'DAY' }))).toEqual(
        refused(
          'CADENCE_INVALID',
          'remoteok.api.latest: 2 scheduled runs a day exceed its own budget of 1',
        ),
      )
      expect(remoteok(24, { limit: 1, window: 'DAY' })().entries[0]!.budget!.limit).toBe(1)
    })
  })

  it('a refusal from an adapter is truncated to 300 characters of its own message', () => {
    const r = refusal(
      withDefinition('DJINNI_RSS', (d) => ({
        ...d,
        entries: [{ ...d.entries[0]!, config: { primaryKeyword: 'Not A Keyword' } }],
      })),
    )
    expect(r.code).toBe('CONFIG_REJECTED')
    expect(r.message).toHaveLength('CONFIG_REJECTED: djinni.rss.python: '.length + 300)
  })
})

describe('more exact behaviour', () => {
  it('an auth deadline is found among several deadlines, not only when it is the only one', () => {
    const m = withDefinition('RECRUITEE_ATS', (d) => ({
      ...d,
      deadlines: [
        ...d.deadlines!,
        { kind: 'POLICY_EXPIRES', at: new Date('2030-01-01T00:00:00.000Z'), symbol: 'TEST_EXPIRY' },
      ],
    }))()
    expect(m.types.find((t) => t.type === 'RECRUITEE_ATS')!.deadlines).toHaveLength(2)
  })

  it('the auth refusal lists every permission the fixtures hold, comma-separated', () => {
    const root = fixtureCopy()
    editJson(join(root, 'ashby', 'board-not-found.provenance.json'), (o) => {
      o['permission'] = 'PUBLIC_API_DOCUMENTED'
    })
    expect(
      refusal(() =>
        buildManifest({
          ...real(),
          fixtureRoot: root,
          definitions: MANIFEST_DEFINITIONS.map((d) =>
            d.type === 'ASHBY_ATS' ? { ...d, entries: [], auth: 'API_KEY' } : d,
          ),
        }),
      ),
    ).toEqual(
      refused(
        'AUTH_DISAGREES',
        'ASHBY_ATS: auth API_KEY against provenance permissions PUBLIC_API_DOCUMENTED,UNCLEAR',
      ),
    )
  })

  it('a verified employer is reported with exactly its name and domain', () => {
    expect(entry('lever.board.eu.siteimprove').verifiedEmployer).toEqual({
      name: 'Siteimprove',
      domain: null,
    })
    expect(entry('greenhouse.board.stripe').verifiedEmployer).toEqual({
      name: 'Stripe',
      domain: 'stripe.com',
    })
    expect(entry('recruitee.board.bunq').verifiedEmployer).toEqual({ name: 'bunq', domain: null })
    expect(entry('remoteok.api.latest').verifiedEmployer).toBeNull()
    expect(entry('remoteok.api.latest').ownership).toBeNull()
  })

  it('the adapter map cannot collect: an unconfigured key refuses before any request', async () => {
    for (const [t, id] of [
      ['JOOBLE_API', 'jooble.api.senior-developer-remote'],
      ['JSEARCH_API', 'jsearch.rapidapi.backend'],
      ['THEIRSTACK_API', 'theirstack.api.senior'],
      ['REED_API', 'reed.api.senior-developer-remote'],
    ] as const) {
      const adapter = MANIFEST_VALIDATION_ADAPTERS.get(t) as ReportingJobSourceProvider
      const e = entry(id)
      const f = fakeCollectionContext({
        responses: [{ status: 200, bodyText: '{}' }],
      })
      await expect(
        adapter.collectReport(adapter.parseConfig({ ...e.config, configVersion: 1 }), f.ctx),
      ).rejects.toThrow(/is not configured/)
      expect(f.sent, t).toEqual([])
    }
  })
})

describe('the last boundaries', () => {
  it('an orphan provenance file is refused even when other fixtures sit beside it', () => {
    const root = fixtureCopy()
    cpSync(
      join(root, 'remoteok', 'feed.provenance.json'),
      join(root, 'remoteok', 'orphan.provenance.json'),
    )
    expect(refusal(() => rebuildOn(root))).toEqual(
      refused('FIXTURE_MISSING', 'remoteok/orphan.provenance.json has no fixture beside it'),
    )
  })

  it('policy references keep distinct (URL, date) pairs apart', () => {
    const root = fixtureCopy()
    editJson(join(root, 'himalayas', 'browse-page2.provenance.json'), (o) => {
      o['termsCheckedAt'] = '2026-10-20T00:00:00.000Z'
    })
    const refs = rebuildOn(root).types.find((t) => t.type === 'HIMALAYAS_API')!.policyRefs
    expect(refs.map((r) => r.termsCheckedAt).sort()).toEqual([
      '2026-10-20T00:00:00.000Z',
      '2026-10-23T20:10:00.000Z',
    ])
  })

  it('only a type implemented on the reporting contract is "reporting"', () => {
    expect(isReporting({ kind: 'IMPLEMENTED', contract: 'REPORTING' })).toBe(true)
    expect(isReporting({ kind: 'IMPLEMENTED', contract: 'LEGACY', note: 'n' })).toBe(false)
    expect(isReporting({ kind: 'BLOCKED', reason: 'r', owner: 'o' })).toBe(false)
    // A blocked type that somehow carries the contract word is still not reporting.
    expect(
      isReporting({ kind: 'BLOCKED', contract: 'REPORTING', reason: 'r', owner: 'o' } as never),
    ).toBe(false)
  })

  it('the hash of nothing is the hash of zero bytes', () => {
    expect(SHA256_OF_NOTHING).toBe(createHash('sha256').update('').digest('hex'))
  })
})
