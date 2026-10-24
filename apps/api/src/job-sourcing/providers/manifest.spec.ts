import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jobSourceTypeSchema } from '@crm/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../test/fake-collection-context'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import {
  type BuildInput,
  buildManifest,
  ManifestError,
  type ManifestErrorCode,
  ownershipCountOf,
  ownershipEvidenceOf,
  readinessAt,
  type TypeDefinition,
} from './manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from './manifest.adapters'
import { MANIFEST_DEFINITIONS } from './manifest.definitions'
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
const manifest = buildManifest(real())
const entry = (id: string) => manifest.entries.find((e) => e.id === id)!
const type = (t: string) => manifest.types.find((x) => x.type === t)!

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
/** The code a build is refused with, or NOT_REFUSED: asserted in the test body, never swallowed here. */
function codeOf(build: () => unknown): ManifestErrorCode | 'NOT_REFUSED' {
  try {
    build()
  } catch (e) {
    if (!(e instanceof ManifestError)) throw e
    return e.code
  }
  return 'NOT_REFUSED'
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
      codeOf(() =>
        buildManifest({
          ...real(),
          definitions: MANIFEST_DEFINITIONS.filter((d) => d.type !== 'WTTJ_HTML'),
        }),
      ),
    ).toBe('MISSING_DISPOSITION')
  })

  it('a type defined twice is refused', () => {
    expect(
      codeOf(() =>
        buildManifest({
          ...real(),
          definitions: [...MANIFEST_DEFINITIONS, MANIFEST_DEFINITIONS[0]!],
        }),
      ),
    ).toBe('DUPLICATE_DISPOSITION')
  })

  it('an entry on a type that is not implemented is refused', () => {
    expect(
      codeOf(() =>
        buildManifest({
          ...real(),
          definitions: MANIFEST_DEFINITIONS.map((d) =>
            d.type === 'DICE_HTML'
              ? { ...d, entries: [{ id: 'dice.html.x', config: {}, intervalHours: 24 }] }
              : d,
          ),
        }),
      ),
    ).toBe('NO_ADAPTER')
  })
})

describe('unknown providers', () => {
  it('a type name the schema does not know is refused', () => {
    expect(
      codeOf(() =>
        buildManifest({
          ...real(),
          definitions: [...MANIFEST_DEFINITIONS, { ...MANIFEST_DEFINITIONS[1]!, type: 'NOPE_API' }],
        }),
      ),
    ).toBe('UNKNOWN_PROVIDER')
  })

  it('a type declared implemented with no adapter supplied is refused', () => {
    const adapters = new Map(MANIFEST_VALIDATION_ADAPTERS)
    adapters.delete('REED_API')
    expect(codeOf(() => buildManifest({ ...real(), adapters }))).toBe('NO_ADAPTER')
  })

  it('an adapter that says it is another type is refused', () => {
    const adapters = new Map(MANIFEST_VALIDATION_ADAPTERS)
    adapters.set('REED_API', MANIFEST_VALIDATION_ADAPTERS.get('JOOBLE_API')!)
    expect(codeOf(() => buildManifest({ ...real(), adapters }))).toBe('UNKNOWN_PROVIDER')
  })
})

describe('identity and config', () => {
  it('the manifest holds 34 entries with 34 distinct ids', () => {
    expect(manifest.entries).toHaveLength(34)
    expect(new Set(manifest.entries.map((e) => e.id)).size).toBe(34)
  })

  it('a duplicate id is refused', () => {
    expect(
      codeOf(
        withDefinition('REMOTIVE_API', (d) => ({
          ...d,
          entries: d.entries.map((e) => ({ ...e, id: 'remotive.api.devops' })),
        })),
      ),
    ).toBe('DUPLICATE_ID')
  })

  it('two entries with the same (type, config) are refused, whatever order their keys are in', () => {
    expect(
      codeOf(
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
    ).toBe('DUPLICATE_CONFIG')
  })

  it.each(['has space', 'UPPER', '-leading', 'a'.repeat(101), 'abcdefghijklmnopqrstuvwxyz'])(
    'the id %j is refused (the column refuses it too)',
    (id) => {
      expect(
        codeOf(
          withDefinition('REMOTEOK_API', (d) => ({ ...d, entries: [{ ...d.entries[0]!, id }] })),
        ),
      ).toBe('ID_FORMAT')
    },
  )

  it('a 24-character unbroken run in an id is refused, 23 is not', () => {
    const withId = (id: string) =>
      withDefinition('REMOTEOK_API', (d) => ({ ...d, entries: [{ ...d.entries[0]!, id }] }))
    expect(codeOf(withId('a'.repeat(24)))).toBe('ID_FORMAT')
    expect(withId('a'.repeat(23))().entries.some((e) => e.id === 'a'.repeat(23))).toBe(true)
  })

  it.each(manifest.entries.map((e) => [e.id, e] as const))(
    "%s: the adapter's OWN parseConfig accepts the stored config plus its version",
    (_id, e) => {
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
      codeOf(
        withDefinition('REMOTIVE_API', (d) => ({
          ...d,
          entries: [{ ...d.entries[0]!, config: { category: 'Not A Slug!' } }],
        })),
      ),
    ).toBe('CONFIG_REJECTED')
  })

  it('a config that stores its own version or namespace is refused', () => {
    for (const extra of [{ configVersion: 1 }, { namespace: 'remotive' }]) {
      expect(
        codeOf(
          withDefinition('REMOTIVE_API', (d) => ({
            ...d,
            entries: [{ ...d.entries[0]!, config: { category: 'devops', ...extra } }],
          })),
        ),
      ).toBe('CONFIG_SHAPE')
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
    expect(codeOf(() => rebuildOn(root))).toBe('HASH_MISMATCH')
  })

  it('a provenance file whose fixture is gone, and a fixture with no provenance, are refused', () => {
    const noFixture = fixtureCopy()
    rmSync(join(noFixture, 'remoteok', 'feed.json'))
    expect(codeOf(() => rebuildOn(noFixture))).toBe('FIXTURE_MISSING')
    const noProvenance = fixtureCopy()
    rmSync(join(noProvenance, 'remoteok', 'feed.provenance.json'))
    expect(codeOf(() => rebuildOn(noProvenance))).toBe('FIXTURE_MISSING')
  })

  it('a provenance file that breaks the contract is refused', () => {
    const root = fixtureCopy()
    editJson(join(root, 'remoteok', 'feed.provenance.json'), (o) => {
      o['permission'] = 'MAYBE'
    })
    expect(codeOf(() => rebuildOn(root))).toBe('PROVENANCE_INVALID')
  })

  it('a fixture directory that is not there is refused', () => {
    const root = fixtureCopy()
    rmSync(join(root, 'remoteok'), { recursive: true })
    expect(codeOf(() => rebuildOn(root))).toBe('FIXTURE_DIR_MISSING')
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

  it('a source with documented permission but a blocked status constant (Arbeitnow) is NOT ready', () => {
    const t = type('ARBEITNOW_API')
    expect(t.permission).toBe('PUBLIC_API_DOCUMENTED')
    expect(t.status?.value.blocked).toBe(true)
    const r = readinessAt(entry('arbeitnow.api.feed'), NOW)
    expect(r.status).toBe('BLOCKED')
    expect(r.blockers.map((b) => b.code)).toEqual(['STATUS_CONSTANT_BLOCKED'])
    expect(r.blockers[0]!.detail).toContain('4209793 bytes')
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
    expect(codeOf(() => rebuildOn(root))).toBe('STATUS_CONSTANT_DISAGREES')
    // And the constant moved instead of the provenance.
    expect(
      codeOf(
        withDefinition('ARBEITNOW_API', (d) => ({
          ...d,
          status: {
            symbol: d.status!.symbol,
            value: { ...d.status!.value, permission: 'UNCLEAR' },
          },
        })),
      ),
    ).toBe('STATUS_CONSTANT_DISAGREES')
  })

  it('a constant that says "not blocked" over a provenance that is not ready fails the build', () => {
    expect(
      codeOf(
        withDefinition('REMOTIVE_API', (d) => ({
          ...d,
          status: { symbol: d.status!.symbol, value: { ...d.status!.value, blocked: false } },
        })),
      ),
    ).toBe('STATUS_CONSTANT_DISAGREES')
  })

  it('a constant for a type that has no fixture to reconcile with fails the build', () => {
    expect(
      codeOf(
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
    ).toBe('STATUS_CONSTANT_DISAGREES')
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
      codeOf(
        withDefinition('REMOTIVE_API', (d) => ({
          ...d,
          status: {
            symbol: d.status!.symbol,
            value: { ...d.status!.value, reason: 'x'.repeat(500) },
          },
        })),
      ),
    ).toBe('REASON_TOO_LONG')
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
    expect(codeOf(() => rebuildOn(root))).toBe('EVIDENCE_TOKEN_MISSING')
  })

  it('an employer that no fixture names, or a domain none mentions, is refused', () => {
    const board = (name: string, domain: string | null) =>
      withDefinition('GREENHOUSE_ATS', (d) => ({
        ...d,
        entries: [
          { ...d.entries[0]!, ownership: { fixtures: ['stripe-board.json'], name, domain } },
        ],
      }))
    expect(codeOf(board('Initech', null))).toBe('OWNER_NOT_IN_EVIDENCE')
    expect(codeOf(board('Stripe', 'example.org'))).toBe('OWNER_NOT_IN_EVIDENCE')
    expect(
      codeOf(
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
    ).toBe('FIXTURE_MISSING')
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
    expect(codeOf(withDefinition('RECRUITEE_ATS', (d) => ({ ...d, auth: 'NONE' })))).toBe(
      'DEADLINE_DISAGREES',
    )
    expect(
      codeOf(
        withDefinition('REMOTEOK_API', (d) => ({ ...d, auth: 'EMPLOYER_TOKEN_FROM_DEADLINE' })),
      ),
    ).toBe('DEADLINE_DISAGREES')
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
    expect(codeOf(withDefinition('JOOBLE_API', (d) => ({ ...d, auth: 'NONE' })))).toBe(
      'AUTH_DISAGREES',
    )
    expect(codeOf(withDefinition('REMOTEOK_API', (d) => ({ ...d, auth: 'API_KEY' })))).toBe(
      'AUTH_DISAGREES',
    )
  })

  it('an attribution duty needs a note recording it, and a recorded one needs declaring', () => {
    expect(
      codeOf(
        withDefinition('GREENHOUSE_ATS', (d) => ({ ...d, attribution: 'LINK_BACK_REQUIRED' })),
      ),
    ).toBe('ATTRIBUTION_UNSUPPORTED')
    expect(
      codeOf(withDefinition('REMOTEOK_API', (d) => ({ ...d, attribution: 'NONE_RECORDED' }))),
    ).toBe('ATTRIBUTION_UNDECLARED')
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
      codeOf(
        withDefinition('JSEARCH_API', (d) => ({
          ...d,
          entries: d.entries.map((e) => ({
            ...e,
            intervalHours: 6,
            budget: { limit: 200, window: 'MONTH' as const },
          })),
        })),
      ),
    ).toBe('QUOTA_INCONSISTENT')
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
    expect(codeOf(sized(599))).toBe('QUOTA_INCONSISTENT')
  })

  it('one account in two units is refused: a request counter and a record counter are not one counter', () => {
    expect(
      codeOf(
        withDefinition('THEIRSTACK_API', (d) => ({
          ...d,
          quota: { ...d.quota!, account: 'jooble:api-main', unit: 'RECORD' as const },
        })),
      ),
    ).toBe('QUOTA_INCONSISTENT')
  })

  it('a limit with no window, or a window with no limit, is refused', () => {
    expect(
      codeOf(
        withDefinition('JOOBLE_API', (d) => ({
          ...d,
          quota: { ...d.quota!, window: 'MONTH' as const },
        })),
      ),
    ).toBe('QUOTA_INCONSISTENT')
    expect(
      codeOf(
        withDefinition('JSEARCH_API', (d) => ({ ...d, quota: { ...d.quota!, window: null } })),
      ),
    ).toBe('QUOTA_INCONSISTENT')
  })

  it('a limit that is not a non-negative integer is refused', () => {
    for (const limit of [-1, 1.5]) {
      expect(
        codeOf(withDefinition('JSEARCH_API', (d) => ({ ...d, quota: { ...d.quota!, limit } }))),
      ).toBe('QUOTA_INCONSISTENT')
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
    expect(codeOf(at(5))).toBe('CADENCE_INVALID')
  })

  it.each([0, -1, 1.5])('refuses an interval of %s hours', (h) => {
    expect(
      codeOf(
        withDefinition('REMOTEOK_API', (d) => ({
          ...d,
          entries: [{ ...d.entries[0]!, intervalHours: h }],
        })),
      ),
    ).toBe('CADENCE_INVALID')
  })

  it('refuses a monthly budget the schedule would exhaust: at the budget is fine, one run over is not', () => {
    // 168 h apart is 4 runs a month.
    const budget = (limit: number) =>
      withDefinition('JOOBLE_API', (d) => ({
        ...d,
        entries: [{ ...d.entries[0]!, budget: { limit, window: 'MONTH' as const } }],
      }))
    expect(budget(4)).not.toThrow()
    expect(codeOf(budget(3))).toBe('CADENCE_INVALID')
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
