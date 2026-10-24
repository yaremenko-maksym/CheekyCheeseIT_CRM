import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import { buildManifest, type Manifest } from './manifest'
import { fakeCollectionContext } from '../../test/fake-collection-context'
import { readQuotaCredential } from '../quota-credentials'
import { writeHostKeyDelta, writeSeedDelta } from './manifest.generate'
import { MANIFEST_VALIDATION_ADAPTERS } from './manifest.adapters'
import { MANIFEST_DEFINITIONS } from './manifest.definitions'
import {
  type HostObservation,
  hostKeyProblems,
  hostPolicyOf,
  isValidHostKey,
} from './manifest.hosts'
import {
  GENERATE_COMMAND,
  HOST_KEY_DELTA_FILE,
  SEED_CLOCK,
  SEED_DELTA_FILE,
  generateHostKeyDelta,
  generateSeedDelta,
  hostKeyDeltaLocations,
  hostKeyRowsOf,
  seedDeltaLocations,
  seedRowsOf,
} from './manifest.seed-sql'
import type { ReportingJobSourceProvider } from './reporting-provider'
import { createJoobleProvider } from './sources/jooble.provider'
import { createJSearchProvider } from './sources/jsearch.provider'
import { createReedProvider } from './sources/reed.provider'
import { createTheirStackProvider } from './sources/theirstack.provider'

/**
 * DRIFT: the manifest is a statement about the tree, so it must fail when the tree moves without it.
 * Each case here enumerates something the repository holds (adapters, status constants, deadline
 * constants, fixture directories, the committed SQL) and requires the manifest to account for every
 * member. Adding an adapter, a `*_SOURCE_STATUS` or a fixture directory without touching the
 * manifest fails a test instead of being discovered later as a source that went live by omission.
 */

const SOURCES = join(__dirname, 'sources')
const DRIZZLE = join(__dirname, '..', '..', '..', 'drizzle')
const providerFiles = readdirSync(SOURCES).filter((f) => f.endsWith('.provider.ts'))
const text = (f: string) => readFileSync(join(SOURCES, f), 'utf8')

// Built on first use inside a test (see manifest.spec.ts: a build that throws at import or in a hook
// is invisible to a mutation run, which reads it as "no test failed").
let built: Manifest | undefined
// A fresh build per test (see manifest.spec.ts: coverage is attributed per test).
beforeEach(() => {
  built = undefined
})
const manifest = {
  get entries() {
    return (built ??= buildOnce()).entries
  },
  get types() {
    return (built ??= buildOnce()).types
  },
}
function buildOnce(): Manifest {
  return buildManifest({
    definitions: MANIFEST_DEFINITIONS,
    adapters: MANIFEST_VALIDATION_ADAPTERS,
    fixtureRoot: FIXTURE_ROOT,
  })
}

describe('every adapter in the tree is accounted for', () => {
  it('the adapter modules declare exactly the 23 types the manifest marks implemented on the reporting contract', () => {
    // Adapters that are built through a factory name their type in `{ type: 'X', configSchema }`
    // or `type: 'X'` of a spec; both shapes are matched, and the quota/ATS helpers are skipped
    // because they carry no `type:` of their own.
    const declared = providerFiles
      .flatMap((f) => [...text(f).matchAll(/\btype: '([A-Z]+(?:_[A-Z]+)+)'/g)].map((m) => m[1]!))
      .sort()
    const implemented = manifest.types
      .filter((t) => t.disposition.kind === 'IMPLEMENTED' && t.disposition.contract === 'REPORTING')
      .map((t) => t.type)
      .sort()
    expect(new Set(declared)).toEqual(new Set(implemented))
    expect(implemented).toHaveLength(23)
  })

  it('the adapter map used for validation holds exactly those 23 and nothing else', () => {
    expect([...MANIFEST_VALIDATION_ADAPTERS.keys()].sort()).toEqual(
      manifest.types
        .filter(
          (t) => t.disposition.kind === 'IMPLEMENTED' && t.disposition.contract === 'REPORTING',
        )
        .map((t) => t.type)
        .sort(),
    )
  })
})

describe('every readiness constant is reconciled', () => {
  it('each exported *_SOURCE_STATUS in an adapter is the one a definition imports', () => {
    const exported = providerFiles
      .flatMap((f) =>
        [...text(f).matchAll(/export const ([A-Z]+_SOURCE_STATUS)\b/g)].map((m) => m[1]!),
      )
      .sort()
    const reconciled = manifest.types.flatMap((t) => (t.status ? [t.status.symbol] : [])).sort()
    expect(reconciled).toEqual(exported)
    expect(exported).toHaveLength(10)
  })

  it('each exported *_DEADLINE in an adapter is the date a definition reads', () => {
    const exported = providerFiles
      .flatMap((f) => [...text(f).matchAll(/export const ([A-Z_]+_DEADLINE)\b/g)].map((m) => m[1]!))
      .sort()
    const read = manifest.types.flatMap((t) => t.deadlines.map((d) => d.symbol)).sort()
    expect(read).toEqual(exported)
    expect(exported).toEqual(['RECRUITEE_TOKEN_DEADLINE'])
  })
})

describe('every fixture directory is accounted for', () => {
  it('the directories under __fixtures__ are exactly the ones the definitions name', () => {
    const dirs = readdirSync(FIXTURE_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    const named = MANIFEST_DEFINITIONS.flatMap((d) => (d.fixtureDir ? [d.fixtureDir] : [])).sort()
    expect(named).toEqual(dirs)
    expect(new Set(named).size).toBe(named.length)
  })

  it('raw captures live outside __fixtures__, so a directory of evidence never reaches the manifest as a source', () => {
    expect(existsSync(join(SOURCES, '__raw-captures__'))).toBe(true)
    expect(readdirSync(FIXTURE_ROOT)).not.toContain('__raw-captures__')
  })
})

describe('the generated seed delta', () => {
  // Resolved inside each test: a call that throws while the describe is being collected fails the
  // file to load, which a mutation run cannot tell from "no test failed".
  const where = () => {
    const { manual, staged } = seedDeltaLocations(DRIZZLE)
    return { manual, staged, committed: existsSync(manual) ? manual : staged }
  }

  it('lives in exactly one place', () => {
    const { manual, staged } = where()
    expect([existsSync(manual), existsSync(staged)].filter(Boolean)).toHaveLength(1)
  })

  it('is byte-for-byte what the generator produces (run the generate script if this fails)', () => {
    expect(readFileSync(where().committed, 'utf8'), GENERATE_COMMAND).toBe(
      generateSeedDelta(manifest, SEED_CLOCK),
    )
  })

  it('tells the applier to run it in ONE transaction, which the step-3b guard depends on', () => {
    const sql = generateSeedDelta(manifest)
    expect(sql).toContain('psql -v ON_ERROR_STOP=1 --single-transaction < <this file>')
    expect(sql).toContain('RAISE EXCEPTION')
  })

  it('has a generate script that runs the generator', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
    ) as {
      scripts: Record<string, string>
    }
    expect(GENERATE_COMMAND).toBe('pnpm --filter @crm/api job-sources:manifest:generate')
    expect(pkg.scripts['job-sources:manifest:generate']).toBe(
      'tsx src/job-sourcing/providers/manifest.generate.ts',
    )
    expect(SEED_DELTA_FILE).toBe('2026-10-24_job_sources_manifest_delta.sql')
  })

  it('never deletes or truncates, never owns its transaction, and never names the live database', () => {
    const sql = generateSeedDelta(manifest)
    expect(sql).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE)\b/i)
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im)
    expect(sql).not.toMatch(/crm_db/)
    // The only tables it drops are its own temporaries.
    const drops = [...sql.matchAll(/DROP TABLE (?:IF EXISTS )?(\S+?);/g)].map((m) => m[1])
    expect(drops.every((d) => /_jsm_(doc|sources|blocks)$/.test(d!))).toBe(true)
  })

  it('writes every inserted row disabled and no row that is VERIFIED', () => {
    const { sources } = seedRowsOf(manifest)
    expect(sources).toHaveLength(34)
    expect(new Set(sources.map((s) => s.readiness))).toEqual(new Set(['CANDIDATE', 'BLOCKED']))
    // The reason column's own bound, and its own rule: a blocked row has one.
    for (const s of sources) {
      expect(s.readiness_reason === null, s.manifest_id).toBe(s.readiness === 'CANDIDATE')
      expect((s.readiness_reason ?? '').length).toBeLessThanOrEqual(500)
    }
  })

  it('snapshots readiness at the clock it names, not at the day it is read', () => {
    const rows = seedRowsOf(manifest).sources
    expect(rows.find((s) => s.manifest_id === 'recruitee.board.bunq')!.readiness).toBe('CANDIDATE')
    const after = seedRowsOf(manifest, new Date('2027-02-10T00:00:00.000Z')).sources
    expect(after.find((s) => s.manifest_id === 'recruitee.board.bunq')!.readiness).toBe('BLOCKED')
  })

  it('blocks the types that are not ready, so a seeded row of one is not left a candidate', () => {
    const blocked = seedRowsOf(manifest).typeBlocks.map((b) => b.type)
    expect(blocked).toEqual([
      'WORKINGNOMADS_API',
      'ASHBY_ATS',
      'SMARTRECRUITERS_ATS',
      'JOOBLE_API',
      'JSEARCH_API',
      'THEIRSTACK_API',
      'MUSE_API',
      'REED_API',
      'DJINNI_RSS',
      'WWR_RSS',
      'EUREMOTEJOBS_RSS',
    ])
  })
})

describe('the generator writes the delta where the file already is', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })
  const tmpRoot = () => {
    const r = mkdtempSync(join(tmpdir(), 'manifest-drizzle-'))
    roots.push(r)
    return r
  }

  it('creates manual-staged/ and writes there while the file has not been moved', () => {
    const root = tmpRoot()
    const written = writeSeedDelta(root)
    const { manual, staged } = seedDeltaLocations(root)
    expect(written).toBe(staged)
    expect(existsSync(manual)).toBe(false)
    expect(readFileSync(staged, 'utf8')).toBe(
      readFileSync(seedDeltaLocations(DRIZZLE).staged, 'utf8'),
    )
  })

  it('writes to manual/ once DevOps has moved the file there, and leaves manual-staged/ alone', () => {
    const root = tmpRoot()
    const { manual, staged } = seedDeltaLocations(root)
    mkdirSync(join(root, 'manual'))
    writeFileSync(manual, 'stale')
    expect(writeSeedDelta(root)).toBe(manual)
    expect(readFileSync(manual, 'utf8')).not.toBe('stale')
    expect(existsSync(staged)).toBe(false)
  })
})

describe('the seed SQL generator', () => {
  const entryOf = (m: Manifest, id: string) => m.entries.find((e) => e.id === id)!

  it('locates the delta under manual/ or manual-staged/ of the root it is given', () => {
    expect(seedDeltaLocations('/r')).toEqual({
      manual: join('/r', 'manual', SEED_DELTA_FILE),
      staged: join('/r', 'manual-staged', SEED_DELTA_FILE),
    })
  })

  it('writes an empty list as [] and a list as one element per line', () => {
    const empty = generateSeedDelta({ types: [], entries: [] })
    expect(empty).toContain('{"sources":[],"typeBlocks":[]}')
    const one = generateSeedDelta({
      types: [],
      entries: [entryOf(manifest as Manifest, 'remoteok.api.latest')],
    })
    expect(one).toContain('{"sources":[\n  {"manifest_id":"remoteok.api.latest"')
  })

  it('refuses data that would end its own dollar-quoted literal', () => {
    const e = entryOf(manifest as Manifest, 'remoteok.api.latest')
    expect(() =>
      generateSeedDelta({ types: [], entries: [{ ...e, config: { x: '$manifest$' } }] }),
    ).toThrow('the manifest data contains $manifest$, which would end its own literal')
  })
})

// ---------------------------------------------------------------------------
// Task 2.5 T8: host keys, rates and ban scopes
// ---------------------------------------------------------------------------

const KEY = readQuotaCredential('jooble', () => 'drift-spec-key')
/** Every reporting adapter, the keyed ones built WITH a (fake) key so they reach the network port. */
const OBSERVERS: ReadonlyMap<string, ReportingJobSourceProvider> = new Map(
  [
    ...MANIFEST_VALIDATION_ADAPTERS.values(),
    createJoobleProvider({ credential: KEY }),
    createJSearchProvider({ credential: KEY }),
    createTheirStackProvider({ credential: KEY }),
    createReedProvider({ credential: KEY }),
  ].map((p) => [p.type, p as unknown as ReportingJobSourceProvider]),
)

/**
 * The hosts an entry's adapter ACTUALLY requests: its first request is recorded by a fake context
 * and refused, so nothing leaves the process. This is the measurement AC 14 rests on: the drift
 * rule compares keys over real request hosts, not over a second hand-written list of them.
 */
async function requestHostsOf(entry: Manifest['entries'][number]): Promise<string[]> {
  const adapter = OBSERVERS.get(entry.type)!
  const fake = fakeCollectionContext({ responses: [{ throws: new Error('drift-spec: stop') }] })
  const config = adapter.parseConfig({ ...entry.config, configVersion: entry.configVersion })
  await adapter.collectReport(config, fake.ctx).catch(() => undefined)
  return fake.sent.map((r) => new URL(r.url).host)
}

async function observations(m: Manifest): Promise<HostObservation[]> {
  const out: HostObservation[] = []
  for (const e of m.entries) {
    for (const requestHost of await requestHostsOf(e)) {
      out.push({ entryId: e.id, requestHost, hostKey: e.hostKey })
    }
  }
  return out
}

describe('T8: every reporting source has a host key that scopes what it really requests', () => {
  it('every entry carries a valid, non-empty key (the ADR drift rule)', () => {
    expect(manifest.entries).toHaveLength(34)
    for (const e of manifest.entries) expect(isValidHostKey(e.hostKey), e.id).toBe(true)
  })

  it('AC 14: the keys of real request hosts agree, and each key scopes its host', async () => {
    const obs = await observations(manifest as Manifest)
    // Non-vacuous: every entry reached its network port at least once.
    expect(new Set(obs.map((o) => o.entryId)).size).toBe(manifest.entries.length)
    expect(hostKeyProblems(obs)).toEqual([])
  })

  it('AC 14: tenants of one provider share one key (Workable, Personio, Greenhouse, Recruitee)', async () => {
    const keyOf = (id: string) => manifest.entries.find((e) => e.id === id)!.hostKey
    expect(keyOf('workable.board.huggingface')).toBe('apply.workable.com')
    expect(keyOf('workable.board.hirefellows')).toBe('apply.workable.com')
    expect(keyOf('personio.board.westwing')).toBe('personio.de')
    expect(keyOf('personio.board.personio')).toBe('personio.de')
    expect(keyOf('greenhouse.board.stripe')).toBe(keyOf('greenhouse.board.airbnb'))
    // Recruitee has one entry: its key is the apex, while its request host is the tenant's own.
    expect(keyOf('recruitee.board.bunq')).toBe('recruitee.com')
    const bunq = manifest.entries.find((e) => e.id === 'recruitee.board.bunq')!
    expect(await requestHostsOf(bunq)).toEqual(['bunq.recruitee.com'])
    const westwing = manifest.entries.find((e) => e.id === 'personio.board.westwing')!
    expect(await requestHostsOf(westwing)).toEqual(['westwing.jobs.personio.de'])
    // Lever's two regions are two API hosts and two data sets: two keys.
    expect(keyOf('lever.board.spotify')).toBe('api.lever.co')
    expect(keyOf('lever.board.eu.siteimprove')).toBe('api.eu.lever.co')
  })

  it('AC 14 positive control: a key that splits one real host fails the drift rule', async () => {
    const split = buildManifest({
      definitions: MANIFEST_DEFINITIONS.map((d) =>
        d.type === 'LEVER_ATS'
          ? {
              ...d,
              hostKey: (c) => (c['board'] === 'spotify' ? 'spotify.lever.co' : 'api.lever.co'),
            }
          : d,
      ),
      adapters: MANIFEST_VALIDATION_ADAPTERS,
      fixtureRoot: FIXTURE_ROOT,
    })
    // (It also files the EU board under the global key, a third problem the rule reports.)
    expect(hostKeyProblems(await observations(split))).toEqual([
      'lever.board.spotify: key spotify.lever.co does not scope its request host api.lever.co',
      'lever.board.eu.siteimprove: key api.lever.co does not scope its request host api.eu.lever.co',
      'api.lever.co is reached under 2 keys: api.lever.co, spotify.lever.co',
    ])
  })

  it('AC 13: the build refuses perDay on a type whose requestsPerRun is not 1', () => {
    const rebuilt = (type: string, over: Record<string, unknown>) => () =>
      buildManifest({
        definitions: MANIFEST_DEFINITIONS.map((d) => (d.type === type ? { ...d, ...over } : d)),
        adapters: MANIFEST_VALIDATION_ADAPTERS,
        fixtureRoot: FIXTURE_ROOT,
      })
    // Arbeitnow sends 5 requests a run.
    expect(rebuilt('ARBEITNOW_API', { hostRate: { perMinute: 2, perDay: 4 } })).toThrow(
      'HOST_RATE_INVALID: ARBEITNOW_API: perDay counts claims, and this type sends 5 requests a run',
    )
    // The same declaration on a one-request type builds.
    expect(rebuilt('REMOTEOK_API', { hostRate: { perMinute: 2, perDay: 4 } })).not.toThrow()
    expect(rebuilt('REMOTIVE_API', { hostRate: { perMinute: 0, perDay: 4 } })).toThrow(
      'HOST_RATE_INVALID',
    )
  })

  it('the build refuses a reporting type with no key, and an entry whose key is not a host name', () => {
    const rebuilt = (over: Record<string, unknown>) => () =>
      buildManifest({
        definitions: MANIFEST_DEFINITIONS.map((d) =>
          d.type === 'REMOTEOK_API' ? { ...d, ...over } : d,
        ),
        adapters: MANIFEST_VALIDATION_ADAPTERS,
        fixtureRoot: FIXTURE_ROOT,
      })
    expect(rebuilt({ hostKey: undefined })).toThrow(
      'HOST_KEY_MISSING: REMOTEOK_API declares no hostKey',
    )
    expect(rebuilt({ hostKey: () => '' })).toThrow(
      'HOST_KEY_INVALID: remoteok.api.latest: host key "" is not a lowercase host name',
    )
    expect(rebuilt({ hostKey: () => 'https://remoteok.com' })).toThrow('HOST_KEY_INVALID')
    expect(rebuilt({ minIntervalHoursFloor: 721 })).toThrow(
      'CADENCE_INVALID: REMOTEOK_API: minIntervalHoursFloor 721 is not an integer from 0 to 720',
    )
    expect(rebuilt({ minIntervalHoursFloor: -1 })).toThrow('CADENCE_INVALID')
    expect(rebuilt({ minIntervalHoursFloor: 1.5 })).toThrow('CADENCE_INVALID')
    expect(rebuilt({ minIntervalHoursFloor: 24 })).not.toThrow()
    expect(rebuilt({ minIntervalHoursFloor: 0 })).not.toThrow()
  })

  it('a non-reporting type needs no key: DOU stays outside the ledger', () => {
    const dou = MANIFEST_DEFINITIONS.find((d) => d.type === 'DOU_RSS')!
    expect(dou.hostKey).toBeUndefined()
    expect(manifest.entries.some((e) => e.type === 'DOU_RSS')).toBe(false)
  })

  it('carries rate, floor and ban scope onto the built types', () => {
    const t = (type: string) => manifest.types.find((x) => x.type === type)!
    expect([t('REMOTIVE_API').hostRate, t('REMOTIVE_API').minIntervalHoursFloor]).toEqual([
      { perMinute: 2, perDay: 4 },
      6,
    ])
    expect(t('RECRUITEE_ATS').banScope).toBe('SOURCE')
    expect(t('PERSONIO_ATS').banScope).toBe('SOURCE')
    expect(t('GREENHOUSE_ATS').banScope).toBe('HOST')
    expect(t('GREENHOUSE_ATS').hostRate).toBeNull()
    expect(t('GREENHOUSE_ATS').minIntervalHoursFloor).toBe(0)
    expect(manifest.types.filter((x) => x.hostRate !== null).map((x) => x.type)).toEqual([
      'REMOTIVE_API',
    ])
    expect(manifest.types.filter((x) => x.banScope === 'SOURCE').map((x) => x.type)).toEqual([
      'RECRUITEE_ATS',
      'PERSONIO_ATS',
    ])
    expect(hostPolicyOf(manifest, 'remotive.com')).toEqual({
      rate: { perMinute: 2, perDay: 4 },
      floorHours: 6,
    })
  })
})

describe('T8: the generated host-key delta', () => {
  const where = () => {
    const { manual, staged } = hostKeyDeltaLocations(DRIZZLE)
    return { manual, staged, committed: existsSync(manual) ? manual : staged }
  }

  it('lives in exactly one place, and is byte-for-byte what the generator produces', () => {
    const { manual, staged, committed } = where()
    expect([existsSync(manual), existsSync(staged)].filter(Boolean)).toHaveLength(1)
    expect(readFileSync(committed, 'utf8'), GENERATE_COMMAND).toBe(generateHostKeyDelta(manifest))
    expect(HOST_KEY_DELTA_FILE).toBe('2026-10-24_job_sources_host_keys.sql')
    expect(hostKeyDeltaLocations('/r')).toEqual({
      manual: join('/r', 'manual', HOST_KEY_DELTA_FILE),
      staged: join('/r', 'manual-staged', HOST_KEY_DELTA_FILE),
    })
  })

  it('writes one row per entry, and only fills a NULL key of a manifest-owned row', () => {
    expect(hostKeyRowsOf(manifest)).toEqual(
      manifest.entries.map((e) => ({ manifest_id: e.id, host_key: e.hostKey })),
    )
    const sql = generateHostKeyDelta(manifest)
    expect(sql).toContain('WHERE s.manifest_id = k.manifest_id\n  AND s.host_key IS NULL;')
    expect(sql).toContain('psql -v ON_ERROR_STOP=1 --single-transaction < <this file>')
    expect(sql).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|INSERT\s+INTO)\b/i)
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im)
    expect(sql).not.toMatch(/crm_db/)
    expect([...sql.matchAll(/DROP TABLE (?:IF EXISTS )?(\S+?);/g)].map((m) => m[1])).toEqual([
      'pg_temp._jsh_keys',
      '_jsh_keys',
    ])
  })

  it('an empty manifest writes an empty list, and data that would end its literal is refused', () => {
    expect(generateHostKeyDelta({ entries: [] })).toContain(
      'jsonb_to_recordset($hostkeys$[]$hostkeys$::jsonb)',
    )
    const e = manifest.entries[0]!
    expect(() => generateHostKeyDelta({ entries: [{ ...e, hostKey: '$hostkeys$' }] })).toThrow(
      'the manifest data contains $hostkeys$, which would end its own literal',
    )
  })

  it('the generator writes it where the file already is', () => {
    const root = mkdtempSync(join(tmpdir(), 'manifest-hostkeys-'))
    try {
      const { manual, staged } = hostKeyDeltaLocations(root)
      expect(writeHostKeyDelta(root)).toBe(staged)
      expect(readFileSync(staged, 'utf8')).toBe(readFileSync(where().committed, 'utf8'))
      mkdirSync(join(root, 'manual'))
      writeFileSync(manual, 'stale')
      expect(writeHostKeyDelta(root)).toBe(manual)
      expect(readFileSync(manual, 'utf8')).not.toBe('stale')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
