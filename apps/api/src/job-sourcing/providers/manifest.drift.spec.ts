import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import { buildManifest } from './manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from './manifest.adapters'
import { MANIFEST_DEFINITIONS } from './manifest.definitions'
import {
  GENERATE_COMMAND,
  SEED_CLOCK,
  SEED_DELTA_FILE,
  generateSeedDelta,
  seedDeltaLocations,
  seedRowsOf,
} from './manifest.seed-sql'

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

const manifest = buildManifest({
  definitions: MANIFEST_DEFINITIONS,
  adapters: MANIFEST_VALIDATION_ADAPTERS,
  fixtureRoot: FIXTURE_ROOT,
})

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
  const { manual, staged } = seedDeltaLocations(DRIZZLE)
  const committedPath = existsSync(manual) ? manual : staged

  it('lives in exactly one place', () => {
    expect([existsSync(manual), existsSync(staged)].filter(Boolean)).toHaveLength(1)
  })

  it('is byte-for-byte what the generator produces (run the generate script if this fails)', () => {
    expect(readFileSync(committedPath, 'utf8'), GENERATE_COMMAND).toBe(
      generateSeedDelta(manifest, SEED_CLOCK),
    )
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
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\b/im)
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
      'REMOTIVE_API',
      'ARBEITNOW_API',
      'WORKINGNOMADS_API',
      'JOBGETHER_API',
      'HN_HIRING',
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
