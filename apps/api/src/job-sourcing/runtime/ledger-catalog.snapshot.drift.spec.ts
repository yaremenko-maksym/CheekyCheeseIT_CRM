import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import { buildManifest } from '../providers/manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from '../providers/manifest.adapters'
import { MANIFEST_DEFINITIONS } from '../providers/manifest.definitions'
import {
  LEDGER_CATALOG_SNAPSHOT_PATH,
  writeLedgerCatalogSnapshot,
} from '../providers/manifest.generate'
import {
  buildLedgerCatalog,
  buildLedgerCatalogSnapshot,
  generateLedgerCatalogSnapshotSource,
} from '../providers/manifest.ledger-catalog'
import { LEDGER_CATALOG_SNAPSHOT } from './ledger-catalog.snapshot'
import {
  catalogFromSnapshot,
  productionLedgerCatalog,
  snapshotReadinessAt,
} from './production-catalog'

/**
 * r5 Task 2.5 T7 — the production catalog is the manifest's, shipped as generated data.
 *
 * Two walls: the committed snapshot equals what the manifest produces NOW (regenerate with
 * `pnpm --filter @crm/api job-sources:manifest:generate` and prettier), and the production catalog
 * answers every question the ledger asks exactly as the manifest catalog does, at instants on
 * both sides of every deadline the manifest holds.
 */
const manifest = buildManifest({
  definitions: MANIFEST_DEFINITIONS,
  adapters: MANIFEST_VALIDATION_ADAPTERS,
  fixtureRoot: FIXTURE_ROOT,
})
const fromManifest = buildLedgerCatalog(manifest)
const production = productionLedgerCatalog()

const deadlineInstants = [...manifest.types, ...manifest.entries].flatMap((s) =>
  s.deadlines.flatMap((d) => [d.at.getTime() - 1, d.at.getTime()]),
)
const INSTANTS = [
  Date.parse('2026-10-24T00:00:00Z'),
  Date.parse('2099-01-01T00:00:00Z'),
  ...deadlineInstants,
].map((ms) => new Date(ms))

describe('the production ledger catalog (T7)', () => {
  it('the committed snapshot is what the manifest generates', () => {
    expect(LEDGER_CATALOG_SNAPSHOT).toEqual(buildLedgerCatalogSnapshot(manifest))
  })

  it('at least one deadline is exercised, so the comparison below crosses a readiness change', () => {
    expect(deadlineInstants.length).toBeGreaterThan(0)
  })

  it('answers every entry exactly as the manifest catalog does, around every deadline', () => {
    expect(manifest.entries.length).toBeGreaterThan(20)
    for (const e of manifest.entries) {
      const want = fromManifest.entry(e.id)
      const got = production.entry(e.id)
      expect(got, e.id).toBeDefined()
      expect({ ...got, activationFacts: 0, entryReadiness: 0 }).toEqual({
        ...want,
        activationFacts: 0,
        entryReadiness: 0,
      })
      for (const at of INSTANTS) {
        expect(got?.activationFacts(at), `${e.id} @ ${at.toISOString()}`).toEqual(
          want?.activationFacts(at),
        )
        expect(got?.entryReadiness(at)).toBe(want?.entryReadiness(at))
      }
    }
  })

  it('answers every host key exactly as the manifest does, and nothing for an unknown key', () => {
    const keys = new Set(manifest.entries.map((e) => e.hostKey))
    for (const key of keys) expect(production.hostPolicy(key)).toEqual(fromManifest.hostPolicy(key))
    expect(production.hostPolicy('no-such-host.example')).toBeUndefined()
    expect(production.entry('no.such.entry')).toBeUndefined()
  })

  it('Recruitee turns BLOCKED at its employer-token deadline (a literal from the manifest)', () => {
    const e =
      production.entry('recruitee.board.lemon-io') ??
      production.entry(manifest.entries.find((x) => x.type === 'RECRUITEE_ATS')?.id ?? '')
    expect(e?.activationFacts(new Date('2027-02-09T23:59:59.999Z')).readiness).toBe('CANDIDATE')
    expect(e?.activationFacts(new Date('2027-02-10T00:00:00.000Z'))).toMatchObject({
      readiness: 'BLOCKED',
      blockerCodes: ['AUTH_DEADLINE_PASSED'],
    })
    expect(e?.banScope).toBe('SOURCE')
  })

  it('a reached deadline blocks, and an entry of an undescribed type is not resolved', () => {
    expect(
      snapshotReadinessAt(
        {
          blockerCodes: ['KEY_REQUIRED'],
          deadlines: [{ kind: 'AUTH_REQUIRED_FROM', at: '2026-01-01T00:00:00.000Z' }],
        },
        new Date('2025-12-31T23:59:59.999Z'),
      ),
    ).toEqual({ status: 'BLOCKED', blockerCodes: ['KEY_REQUIRED'] })
    expect(
      snapshotReadinessAt(
        {
          blockerCodes: [],
          deadlines: [{ kind: 'POLICY_EXPIRES', at: '2026-01-01T00:00:00.000Z' }],
        },
        new Date('2026-01-01T00:00:00.000Z'),
      ),
    ).toEqual({ status: 'BLOCKED', blockerCodes: ['POLICY_EXPIRED'] })
    const orphan = catalogFromSnapshot({
      types: [],
      entries: [
        { id: 'x', type: 'REMOTIVE_API', blockerCodes: [], deadlines: [], intervalHours: 1 },
      ],
      hosts: [],
    })
    expect(orphan.entry('x')).toBeUndefined()
  })
})

describe('the generator writes the snapshot where production reads it (T7)', () => {
  it('the default path is this directory`s snapshot module', () => {
    expect(LEDGER_CATALOG_SNAPSHOT_PATH).toBe(join(__dirname, 'ledger-catalog.snapshot.ts'))
  })

  it('writes the generated module text, which declares the snapshot the catalog imports', () => {
    const dir = mkdtempSync(join(tmpdir(), 't7-snapshot-'))
    try {
      const path = join(dir, 'snapshot.ts')
      expect(writeLedgerCatalogSnapshot(path)).toBe(path)
      const text = readFileSync(path, 'utf8')
      expect(text).toBe(generateLedgerCatalogSnapshotSource(manifest))
      expect(text.split('\n').slice(0, 5)).toEqual([
        '// GENERATED by `pnpm --filter @crm/api job-sources:manifest:generate` -- do not edit by hand.',
        '// `ledger-catalog.snapshot.drift.spec.ts` fails when this differs from the manifest.',
        "import type { LedgerCatalogSnapshot } from './production-catalog'",
        '',
        'export const LEDGER_CATALOG_SNAPSHOT: LedgerCatalogSnapshot = {',
      ])
      expect(text.endsWith('}\n')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the production build ships what the worker imports (T7)', () => {
  const apiRoot = join(__dirname, '..', '..', '..')
  const build = JSON.parse(readFileSync(join(apiRoot, 'tsconfig.build.json'), 'utf8')) as {
    exclude: string[]
  }
  /** `tsconfig.build.json`'s exclude globs (`**`, `*`), matched against an api-relative path. */
  const excluded = (path: string) =>
    build.exclude.some((glob) => {
      const re = new RegExp(
        `^${glob
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*\//g, '\u0000')
          .replace(/\*\*/g, '\u0001')
          .replace(/\*/g, '[^/]*')
          .replace(/\u0000/g, '(.*/)?')
          .replace(/\u0001/g, '.*')}$`,
      )
      return re.test(path)
    })

  /**
   * CR-M-4: every file reachable through RELATIVE imports (static `import … from`, `export … from`,
   * side-effect `import '…'`, dynamic `import('…')`) from the files the production process runs.
   * Package imports are not followed: the build does not emit them.
   */
  function importGraph(entries: readonly string[]): Set<string> {
    const seen = new Set<string>()
    const queue = [...entries]
    while (queue.length > 0) {
      const file = queue.pop() as string
      if (seen.has(file)) continue
      seen.add(file)
      const text = readFileSync(file, 'utf8')
      const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)].map(
        (m) => m[1] as string,
      )
      for (const spec of specifiers) {
        const base = join(dirname(file), spec)
        const resolved = [`${base}.ts`, join(base, 'index.ts')].find((p) => existsSync(p))
        if (resolved === undefined) throw new Error(`unresolved import ${spec} in ${file}`)
        queue.push(resolved)
      }
    }
    return seen
  }

  const RUNTIME_ENTRIES = [
    'job-run-worker.ts',
    'collection-context.ts',
    'production-worker.ts',
    'production-catalog.ts',
  ].map((f) => join(__dirname, f))

  it('the exclude matcher reads the build`s globs as the build does', () => {
    expect(excluded('src/job-sourcing/runtime/ledger-catalog.snapshot.ts')).toBe(false)
    expect(excluded('src/job-sourcing/runtime/production-catalog.ts')).toBe(false)
    expect(excluded('src/job-sourcing/providers/manifest.ledger-catalog.ts')).toBe(true)
    expect(excluded('src/job-sourcing/runtime/__test-helpers__/runtime-harness.ts')).toBe(true)
    expect(excluded('src/job-sourcing/runtime/job-run-worker.spec.ts')).toBe(true)
    expect(excluded('src/test/ledger-fixtures.ts')).toBe(true)
  })

  it('nothing the production worker, context or catalog imports is a file the build drops', () => {
    const graph = [...importGraph(RUNTIME_ENTRIES)].map((p) => relative(apiRoot, p))
    // the walk really walked: the ledger, the meter store and the snapshot are reached
    expect(graph).toEqual(
      expect.arrayContaining([
        'src/job-sourcing/ownership/job-run-ledger.ts',
        'src/job-sourcing/metering/account-meter.store.ts',
        'src/job-sourcing/runtime/ledger-catalog.snapshot.ts',
      ]),
    )
    expect(graph.filter(excluded)).toEqual([])
  })
})
