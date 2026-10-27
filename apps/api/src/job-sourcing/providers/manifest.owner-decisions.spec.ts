import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../test/fake-collection-context'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import {
  type BuildInput,
  buildManifest,
  ManifestError,
  type ManifestErrorCode,
  readinessAt,
  type TypeDefinition,
} from './manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from './manifest.adapters'
import { MANIFEST_DEFINITIONS } from './manifest.definitions'
import { attemptsIn } from './manifest.fetch-profile'
import {
  HN_OWNER_DECISION,
  isWellFormedDecision,
  JOBGETHER_OWNER_DECISION,
  liftsUnclear,
  type OwnerDecision,
  REMOTIVE_OWNER_DECISION,
  SMARTRECRUITERS_OWNER_DECISION,
  WORKABLE_OWNER_DECISION,
} from './owner-decisions'
import {
  createSmartRecruitersProvider,
  SMARTRECRUITERS_BOUNDS,
} from './sources/smartrecruiters.provider'

/**
 * Owner decisions (r5 Task 3.2c), tested at the manifest seam.
 *
 * Every expected value is a literal read from the task or from a provenance file; every "this is
 * what makes it ready" claim is proven by REMOVING or CHANGING the decision (or the provenance) in a
 * copy and watching readiness move. A decision is an ACCEPTED RISK: `UNCLEAR` stays `UNCLEAR`.
 */

const NOW = new Date('2026-10-24T00:00:00.000Z')

const real = (): BuildInput => ({
  definitions: MANIFEST_DEFINITIONS,
  adapters: MANIFEST_VALIDATION_ADAPTERS,
  fixtureRoot: FIXTURE_ROOT,
})

/** A thunk that builds the manifest with one type's definition changed. */
function build(typeName: string, change: (d: TypeDefinition) => TypeDefinition, root?: string) {
  return () =>
    buildManifest({
      ...real(),
      ...(root === undefined ? {} : { fixtureRoot: root }),
      definitions: MANIFEST_DEFINITIONS.map((d) => (d.type === typeName ? change(d) : d)),
    })
}
const typeOf = (m: ReturnType<typeof buildManifest>, t: string) =>
  m.types.find((x) => x.type === t)!
const entryOf = (m: ReturnType<typeof buildManifest>, id: string) =>
  m.entries.find((e) => e.id === id)!

function refusal(thunk: () => unknown): {
  code: ManifestErrorCode | 'NOT_REFUSED'
  message: string
} {
  try {
    thunk()
  } catch (e) {
    if (!(e instanceof ManifestError)) throw e
    return { code: e.code, message: e.message }
  }
  return { code: 'NOT_REFUSED', message: '' }
}

const trees: string[] = []
afterEach(() => {
  for (const t of trees.splice(0)) rmSync(t, { recursive: true, force: true })
})
function fixtureCopy(): string {
  const root = mkdtempSync(join(tmpdir(), 'manifest-owner-decisions-'))
  trees.push(root)
  cpSync(FIXTURE_ROOT, root, { recursive: true })
  return root
}
function setPermission(root: string, dir: string, permission: string): void {
  for (const f of ['search', 'thread-2026-10', 'thread-2026-09', 'thread-2019-05']) {
    if (dir !== 'hn-hiring') throw new Error('this helper edits the HN captures only')
    const path = join(root, dir, `${f}.provenance.json`)
    const o = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    o['permission'] = permission
    writeFileSync(path, `${JSON.stringify(o, null, 2)}\n`)
  }
}

/** The status constant as the type declares it, with fields changed. */
const withStatus =
  (patch: Record<string, unknown>) =>
  (d: TypeDefinition): TypeDefinition => ({
    ...d,
    status: { symbol: d.status!.symbol, value: { ...d.status!.value, ...patch } },
  })
const without = (d: TypeDefinition): TypeDefinition => ({ ...d, ownerDecisions: [] })
const both =
  (...fns: Array<(d: TypeDefinition) => TypeDefinition>) =>
  (d: TypeDefinition) =>
    fns.reduce((acc, f) => f(acc), d)

describe('HN: ready only with the decision record (AC1)', () => {
  it('with the decision the HN type and its entry are CANDIDATE; the record rides on the entry', () => {
    const m = buildManifest(real())
    expect(typeOf(m, 'HN_HIRING').blockers).toEqual([])
    const e = entryOf(m, 'hn-hiring.thread.latest')
    expect(readinessAt(e, NOW)).toEqual({ status: 'CANDIDATE', blockers: [] })
    expect(e.ownerDecisions).toEqual([
      expect.objectContaining({
        decidedAt: '2026-10-24',
        decision: 'ACCEPT_RISK',
        endpointVariant: 'algolia-who-is-hiring',
      }),
    ])
    const d = e.ownerDecisions[0]!
    expect(d.scope).toContain('two requests per run to hn.algolia.com')
    expect(d.scope).toContain('no use of news.ycombinator.com pages')
    expect(d.reference).toContain('no data mining, robots, scraping')
  })

  it('removing the decision makes it not ready: an unblocked constant over UNCLEAR fails the build', () => {
    expect(refusal(build('HN_HIRING', without))).toEqual({
      code: 'STATUS_CONSTANT_DISAGREES',
      message:
        'STATUS_CONSTANT_DISAGREES: HN_SOURCE_STATUS.blocked is false but the provenance permission UNCLEAR is not a ready one',
    })
  })

  it('removing the decision AND honouring the constant gives BLOCKED with PERMISSION_UNCLEAR', () => {
    const m = build('HN_HIRING', both(without, withStatus({ blocked: true })))()
    const r = readinessAt(entryOf(m, 'hn-hiring.thread.latest'), NOW)
    expect(r.status).toBe('BLOCKED')
    expect(r.blockers.map((b) => b.code)).toEqual(['PERMISSION_UNCLEAR', 'STATUS_CONSTANT_BLOCKED'])
  })

  it('a decision about another endpoint, or an informational one, does not lift UNCLEAR', () => {
    for (const other of [
      { ...HN_OWNER_DECISION, endpointVariant: 'items-only' },
      { ...HN_OWNER_DECISION, decision: 'INFORMATIONAL' as const },
    ]) {
      expect(refusal(build('HN_HIRING', (d) => ({ ...d, ownerDecisions: [other] }))).code).toBe(
        'STATUS_CONSTANT_DISAGREES',
      )
      const m = build(
        'HN_HIRING',
        both((d) => ({ ...d, ownerDecisions: [other] }), withStatus({ blocked: true })),
      )()
      expect(typeOf(m, 'HN_HIRING').blockers.map((b) => b.code)).toEqual([
        'PERMISSION_UNCLEAR',
        'STATUS_CONSTANT_BLOCKED',
      ])
    }
  })
})

describe('PROHIBITED is not overridable, with the decision still present (AC2)', () => {
  it('HN with its decision and PROHIBITED captures is BLOCKED by PERMISSION_PROHIBITED', () => {
    const root = fixtureCopy()
    setPermission(root, 'hn-hiring', 'PROHIBITED')
    // The constant is honest about the flipped provenance (the manifest refuses one that is not).
    const m = build('HN_HIRING', withStatus({ blocked: true, permission: 'PROHIBITED' }), root)()
    expect(HN_OWNER_DECISION.decision).toBe('ACCEPT_RISK')
    expect(typeOf(m, 'HN_HIRING').ownerDecisions).toEqual([HN_OWNER_DECISION])
    const r = readinessAt(entryOf(m, 'hn-hiring.thread.latest'), NOW)
    expect(r.status).toBe('BLOCKED')
    expect(r.blockers.map((b) => b.code)).toEqual([
      'PERMISSION_PROHIBITED',
      'STATUS_CONSTANT_BLOCKED',
    ])
  })

  it('and an unblocked constant over PROHIBITED fails the build: the decision does not make it a ready permission', () => {
    const root = fixtureCopy()
    setPermission(root, 'hn-hiring', 'PROHIBITED')
    expect(
      refusal(build('HN_HIRING', withStatus({ blocked: false, permission: 'PROHIBITED' }), root)),
    ).toEqual({
      code: 'STATUS_CONSTANT_DISAGREES',
      message:
        'STATUS_CONSTANT_DISAGREES: HN_SOURCE_STATUS.blocked is false but the provenance permission PROHIBITED is not a ready one',
    })
  })

  it('a mixed capture set (one PROHIBITED, the rest UNCLEAR) keeps the PROHIBITED blocker', () => {
    const root = fixtureCopy()
    const path = join(root, 'hn-hiring', 'search.provenance.json')
    const o = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    o['permission'] = 'PROHIBITED'
    writeFileSync(path, `${JSON.stringify(o, null, 2)}\n`)
    const m = build('HN_HIRING', withStatus({ blocked: true, permission: 'PROHIBITED' }), root)()
    expect(typeOf(m, 'HN_HIRING').blockers.map((b) => b.code)).toEqual([
      'PERMISSION_PROHIBITED',
      'STATUS_CONSTANT_BLOCKED',
    ])
  })
})

describe('Remotive and Jobgether, by name (AC3: the addendum gives both a decision)', () => {
  it.each([
    ['REMOTIVE_API', 'remotive.api.software-dev', REMOTIVE_OWNER_DECISION],
    ['JOBGETHER_API', 'jobgether.api.jobs', JOBGETHER_OWNER_DECISION],
  ] as const)(
    '%s is CANDIDATE with its decision and BLOCKED without it',
    (t, entryId, decision) => {
      const m = buildManifest(real())
      expect(typeOf(m, t).blockers).toEqual([])
      expect(readinessAt(entryOf(m, entryId), NOW).status).toBe('CANDIDATE')
      expect(typeOf(m, t).ownerDecisions).toEqual([decision])

      const stripped = build(t, both(without, withStatus({ blocked: true })))()
      expect(readinessAt(entryOf(stripped, entryId), NOW).status).toBe('BLOCKED')
      expect(typeOf(stripped, t).blockers.map((b) => b.code)).toEqual([
        'PERMISSION_UNCLEAR',
        'STATUS_CONSTANT_BLOCKED',
      ])
      expect(refusal(build(t, without)).code).toBe('STATUS_CONSTANT_DISAGREES')
    },
  )

  it("all three Remotive entries are lifted together: the decision is the source's, not an entry's", () => {
    const m = buildManifest(real())
    const ids = m.entries.filter((e) => e.type === 'REMOTIVE_API').map((e) => e.id)
    expect(ids).toEqual(['remotive.api.software-dev', 'remotive.api.devops', 'remotive.api.data'])
    for (const id of ids) expect(readinessAt(entryOf(m, id), NOW).status).toBe('CANDIDATE')
  })

  it('the Jobgether decision says the ML clause is accepted risk, not resolved', () => {
    expect(JOBGETHER_OWNER_DECISION.scope).toContain('/astroapi/ai/jobs.json')
    expect(JOBGETHER_OWNER_DECISION.scope).toContain('knowingly accepted as risk, NOT resolved')
  })

  /**
   * The most requests a rolling 24 h window can hold for one entry run every `intervalHours`: CEIL,
   * not floor (7 h apart fits 4 starts in 24 h, floor says 3).
   */
  const maxPerDay = (intervals: readonly number[], perRun: number) =>
    intervals.reduce((sum, h) => sum + Math.ceil(24 / h) * perRun, 0)

  it('Remotive vendor limits: the requests a day of all its entries, counted over a rolling window, stay within 4', () => {
    const m = buildManifest(real())
    const remotive = m.entries.filter((e) => e.type === 'REMOTIVE_API')
    const perRun = typeOf(m, 'REMOTIVE_API').requestsPerRun
    expect(perRun).toBe(1)
    // U1b: 3 categories, one fixed Kyiv slot each (09:00, 13:00, 17:00): a hand-counted 3, under
    // the vendor's "about 4 a day".
    expect(remotive.map((e) => e.fetchProfile?.fixedSlots?.times)).toEqual([
      ['09:00'],
      ['13:00'],
      ['17:00'],
    ])
    expect(remotive.reduce((n, e) => n + attemptsIn(e.fetchProfile, 24 * 60) * perRun, 0)).toBe(3)
    expect(REMOTIVE_OWNER_DECISION.scope).toContain('never more than 2 a minute')
  })

  it.each([
    // [intervals of the entries, hand-counted maximum starts in any 24 h, within 4 a day]
    [[24, 24, 24], 3, true],
    [[6], 4, true],
    [[7], 4, true],
    [[7, 7, 7], 12, false],
    [[10, 10, 10], 9, false],
    [[6, 6, 6], 12, false],
  ] as const)(
    'the daily count of entries every %j h is %i (%s within 4)',
    (intervals, count, ok) => {
      expect(maxPerDay(intervals, 1)).toBe(count)
      expect(maxPerDay(intervals, 1) <= 4).toBe(ok)
    },
  )

  it('the 6 h floor refuses 5 h for one entry, and (U1b) the host`s 4 a day now refuses the total', () => {
    const every = (h: number) => ({
      intervalMinutes: h * 60,
      offIntervalMinutes: null,
      window: null,
    })
    expect(
      refusal(
        build('REMOTIVE_API', (d) => ({
          ...d,
          entries: [{ ...d.entries[0]!, fetchProfile: every(5) }],
        })),
      ).code,
    ).toBe('CADENCE_INVALID')
    // Three entries at the floor: each passes the floor, together 12 a day against the host's 4.
    expect(maxPerDay([6, 6, 6], 1)).toBe(12)
    expect(
      refusal(
        build('REMOTIVE_API', (d) => ({
          ...d,
          entries: d.entries.map((e) => ({ ...e, fetchProfile: every(6) })),
        })),
      ).code,
    ).toBe('HOST_RATE_INVALID')
  })
})

describe('SmartRecruiters and Workable carry their decisions', () => {
  it('SmartRecruiters: the decision lifts the PERMISSION blocker only; the evidence blocker NO_API_CAPTURE stays', () => {
    const m = buildManifest(real())
    const t = typeOf(m, 'SMARTRECRUITERS_ATS')
    expect(t.ownerDecisions).toEqual([SMARTRECRUITERS_OWNER_DECISION])
    expect(t.endpointVariant).toBe(SMARTRECRUITERS_OWNER_DECISION.endpointVariant)
    expect(t.blockers.map((b) => b.code)).toEqual(['NO_API_CAPTURE'])
    expect(t.payloadVerified).toBe(false)
    expect(readinessAt(t, NOW).status).toBe('BLOCKED')
    expect(m.entries.filter((e) => e.type === 'SMARTRECRUITERS_ATS')).toEqual([])
    const stripped = build('SMARTRECRUITERS_ATS', without)()
    expect(typeOf(stripped, 'SMARTRECRUITERS_ATS').blockers.map((b) => b.code)).toEqual([
      'PERMISSION_UNCLEAR',
      'NO_API_CAPTURE',
    ])
  })

  it('NO_API_CAPTURE is DERIVED: a real postings payload capture in a copy clears it; a sentinel or a robots.txt does not', () => {
    const addPostings = (patch: Record<string, unknown>) => {
      const root = fixtureCopy()
      const body = '{"offset":0,"limit":100,"totalFound":0,"content":[]}\n'
      writeFileSync(join(root, 'smartrecruiters', 'postings-list.json'), body)
      writeFileSync(
        join(root, 'smartrecruiters', 'postings-list.provenance.json'),
        `${JSON.stringify(
          {
            url: 'https://api.smartrecruiters.com/v1/companies/acme/postings',
            fetchedAt: '2026-10-25T10:00:00.000Z',
            httpStatus: 200,
            rawSha256: createHash('sha256').update(body).digest('hex'),
            fileSha256: createHash('sha256').update(body).digest('hex'),
            trimmedBy: 'none: stored exactly as received',
            termsUrl: 'https://developers.smartrecruiters.com/docs/endpoints',
            termsCheckedAt: '2026-10-25T10:00:00.000Z',
            permission: 'UNCLEAR',
            notes: 'a controlled smoke within the owner decision of 2026-10-24',
            ...patch,
          },
          null,
          2,
        )}\n`,
      )
      return typeOf(build('SMARTRECRUITERS_ATS', (d) => d, root)(), 'SMARTRECRUITERS_ATS')
    }
    const captured = addPostings({})
    expect(captured.blockers).toEqual([])
    expect(captured.payloadVerified).toBe(true)
    // a sentinel payload does not count
    expect(addPostings({ httpStatus: 0 }).blockers.map((b) => b.code)).toEqual(['NO_API_CAPTURE'])
    expect(addPostings({ notes: 'SENTINEL: hand-written' }).blockers.map((b) => b.code)).toEqual([
      'NO_API_CAPTURE',
    ])
  })

  it('NO_API_CAPTURE: any ONE of several declared payload files clears it, and the detail names them all', () => {
    const declared = (names: string[]) => (d: TypeDefinition) => ({ ...d, payloadFixtures: names })
    const none = typeOf(
      build('SMARTRECRUITERS_ATS', declared(['a.json', 'b.json']))(),
      'SMARTRECRUITERS_ATS',
    )
    expect(none.blockers).toEqual([
      {
        code: 'NO_API_CAPTURE',
        detail: 'none of a.json, b.json is a real capture of the API payload',
      },
    ])
    // `api-robots.txt` is a real capture on disk, so naming it alongside an absent file clears the blocker.
    const one = typeOf(
      build('SMARTRECRUITERS_ATS', declared(['absent.json', 'api-robots.txt']))(),
      'SMARTRECRUITERS_ATS',
    )
    expect(one.blockers).toEqual([])
    // Declaring nothing asks for nothing.
    expect(
      typeOf(build('SMARTRECRUITERS_ATS', declared([]))(), 'SMARTRECRUITERS_ATS').blockers,
    ).toEqual([])
  })

  it('the decision the manifest attaches to SmartRecruiters IS the object the adapter is armed with (by reference)', async () => {
    const attached = typeOf(buildManifest(real()), 'SMARTRECRUITERS_ATS').ownerDecisions[0]
    expect(attached).toBe(SMARTRECRUITERS_OWNER_DECISION)
    const w = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: '{"content":[],"totalFound":0}' }],
    })
    const provider = createSmartRecruitersProvider(SMARTRECRUITERS_BOUNDS, {
      ownerDecision: attached,
    })
    await provider.collectReport(provider.parseConfig({ configVersion: 1, board: 'acme' }), w.ctx)
    expect(w.sent).toHaveLength(1)
  })

  it('Workable: informational, changes no readiness', () => {
    const m = buildManifest(real())
    const t = typeOf(m, 'WORKABLE_ATS')
    expect(t.ownerDecisions).toEqual([WORKABLE_OWNER_DECISION])
    expect(WORKABLE_OWNER_DECISION.decision).toBe('INFORMATIONAL')
    expect(t.permission).toBe('PUBLIC_API_DOCUMENTED')
    const stripped = typeOf(build('WORKABLE_ATS', without)(), 'WORKABLE_ATS')
    expect(stripped.blockers).toEqual(t.blockers)
    expect(t.blockers).toEqual([])
  })

  it('no decision exists for a source that has none: Muse stays BLOCKED', () => {
    const m = buildManifest(real())
    expect(typeOf(m, 'MUSE_API').ownerDecisions).toEqual([])
    expect(typeOf(m, 'MUSE_API').blockers.map((b) => b.code)).toEqual([
      'PERMISSION_UNCLEAR',
      'STATUS_CONSTANT_BLOCKED',
    ])
  })
})

describe('the provenance keeps saying UNCLEAR (AC4): the decision is recorded beside it, not over it', () => {
  const permissionOf = (dir: string, file: string) =>
    (
      JSON.parse(readFileSync(join(FIXTURE_ROOT, dir, `${file}.provenance.json`), 'utf8')) as {
        permission: string
      }
    ).permission

  it.each([
    ['hn-hiring', ['search', 'thread-2026-10', 'thread-2026-09', 'thread-2019-05']],
    ['jobgether', ['page-1', 'page-10', 'no-results', 'deprecated-path']],
    ['remotive', ['software-dev']],
    ['smartrecruiters', ['api-robots']],
  ])('%s: every provenance file says UNCLEAR', (dir, files) => {
    for (const f of files) expect(permissionOf(dir, f)).toBe('UNCLEAR')
  })

  it('the manifest still derives UNCLEAR for each decided type; the decision did not change the permission', () => {
    const m = buildManifest(real())
    for (const t of ['HN_HIRING', 'REMOTIVE_API', 'JOBGETHER_API', 'SMARTRECRUITERS_ATS']) {
      expect(typeOf(m, t).permission).toBe('UNCLEAR')
      expect(typeOf(m, t).fixtures.every((f) => f.permission === 'UNCLEAR')).toBe(true)
    }
  })

  it('the HN provenance bytes are the ones committed before the decision (hash pinned)', () => {
    const m = buildManifest(real())
    expect(
      typeOf(m, 'HN_HIRING').fixtures.map((f) => [f.provenanceFile, f.provenanceSha256]),
    ).toEqual(HN_PROVENANCE_PINS)
  })
})

describe('an owner decision is a well-formed record', () => {
  const ok: OwnerDecision = HN_OWNER_DECISION

  it('every recorded reference opens with the same dated note', () => {
    for (const d of [
      HN_OWNER_DECISION,
      REMOTIVE_OWNER_DECISION,
      JOBGETHER_OWNER_DECISION,
      SMARTRECRUITERS_OWNER_DECISION,
      WORKABLE_OWNER_DECISION,
    ]) {
      expect(
        d.reference.startsWith(
          'Owner decision, 2026-10-24 (answer given in the vacancy-sourcing session). Question: ',
        ),
      ).toBe(true)
    }
  })

  it('accepts the recorded decisions', () => {
    for (const d of [
      HN_OWNER_DECISION,
      REMOTIVE_OWNER_DECISION,
      JOBGETHER_OWNER_DECISION,
      SMARTRECRUITERS_OWNER_DECISION,
      WORKABLE_OWNER_DECISION,
    ]) {
      expect(isWellFormedDecision(d)).toBe(true)
    }
  })

  it.each([
    ['a free-text date', { decidedAt: 'yesterday' }],
    ['a date that does not exist', { decidedAt: '2026-02-30' }],
    ['a date without zero padding', { decidedAt: '2026-1-24' }],
    ['a timestamp, not a date', { decidedAt: '2026-10-24T00:00:00Z' }],
    ['a blank scope', { scope: '   ' }],
    ['a blank reference', { reference: '' }],
    ['a whitespace-only reference', { reference: '   ' }],
    ['a blank endpoint variant', { endpointVariant: ' ' }],
    ['a date with a trailing space', { decidedAt: '2026-10-24 ' }],
    ['a date with a leading text', { decidedAt: 'x2026-10-24' }],
  ])('refuses %s', (_name, patch) => {
    expect(isWellFormedDecision({ ...ok, ...patch })).toBe(false)
  })

  it('the builder refuses a malformed decision with its own code', () => {
    expect(
      refusal(
        build('HN_HIRING', (d) => ({
          ...d,
          ownerDecisions: [{ ...HN_OWNER_DECISION, scope: '' }],
        })),
      ),
    ).toEqual({
      code: 'OWNER_DECISION_INVALID',
      message:
        'OWNER_DECISION_INVALID: HN_HIRING: an owner decision needs an ISO date, an endpoint variant, a scope and a reference',
    })
  })

  it("liftsUnclear: only ACCEPT_RISK, only the decision's own endpoint variant, any of several", () => {
    const variant = HN_OWNER_DECISION.endpointVariant
    expect(liftsUnclear([], variant)).toBe(false)
    expect(liftsUnclear([HN_OWNER_DECISION], variant)).toBe(true)
    expect(liftsUnclear([HN_OWNER_DECISION], 'something-else')).toBe(false)
    expect(liftsUnclear([{ ...HN_OWNER_DECISION, decision: 'INFORMATIONAL' }], variant)).toBe(false)
    expect(
      liftsUnclear(
        [{ ...HN_OWNER_DECISION, decision: 'INFORMATIONAL' }, HN_OWNER_DECISION],
        variant,
      ),
    ).toBe(true)
  })

  it('each recorded decision names its endpoint variant, its date and says it is a risk, not a permission', () => {
    expect(
      [
        HN_OWNER_DECISION,
        REMOTIVE_OWNER_DECISION,
        JOBGETHER_OWNER_DECISION,
        SMARTRECRUITERS_OWNER_DECISION,
      ].map((d) => [
        d.endpointVariant,
        d.decidedAt,
        d.decision,
        d.reference.includes('Accepted risk, not a documented permission'),
      ]),
    ).toEqual([
      ['algolia-who-is-hiring', '2026-10-24', 'ACCEPT_RISK', true],
      ['category', '2026-10-24', 'ACCEPT_RISK', true],
      ['astroapi-ai-jobs', '2026-10-24', 'ACCEPT_RISK', true],
      ['posting-api', '2026-10-24', 'ACCEPT_RISK', true],
    ])
  })
})

/** sha256 of the HN provenance files exactly as committed (this task changes none of their bytes). */
const HN_PROVENANCE_PINS: Array<[string, string]> = [
  ['search.provenance.json', 'ac163cd0ed8f594592093ea85a7c0b058861145290d523b700cf57b7f369e778'],
  [
    'thread-2019-05.provenance.json',
    'd119fef017937f58c77212a5de69e348553b1e7ff20a9b26f7cd026a6143697d',
  ],
  [
    'thread-2026-09.provenance.json',
    '47afc82793646b87422db47dabe009777b24ba47c7da633c4f2debd03ac6ab1e',
  ],
  [
    'thread-2026-10.provenance.json',
    '3a3f8ee8e334fadf1cfa8e530c61344bd920406c97041b143fa37b54327b0e30',
  ],
]
