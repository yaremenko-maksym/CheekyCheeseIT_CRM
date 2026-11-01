import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { SqlExecutor } from '../scheduling/host-state'
import {
  CLAIMABLE_KINDS,
  claimDetailFetchForSource,
  claimDirtyBatch,
  completeDirty,
  currentDerivedVersion,
  DETAIL_FETCH,
  enqueueDerivedDirty,
  DirtyKindUnsupportedError,
  DirtyWorkFencedError,
  type DirtyWorkHandle,
  dirtyWorkStatements,
  enqueueDirty,
  failDirty,
  recoverExpiredDirty,
} from './dirty-work.store'

/**
 * r5 Task 4.6 S3 — the dirty-work store against a scripted executor. The real-DB behaviour
 * (SKIP LOCKED, lease expiry, version comparison) is proven in the integration spec; this spec
 * pins validation, outcome mapping and the parameters each statement carries.
 */
const dialect = new PgDialect()
const render = (q: SQL) => dialect.sqlToQuery(q)

const ID = '0b6a6f6e-8f43-4c55-9c4a-6c3f3e1f2a10'
const ENTITY = '7d9b0d1c-2e5f-4a8b-9c6d-1e2f3a4b5c6d'

function scripted(rows: Record<string, unknown>[] = []) {
  const seen: { sql: string; params: unknown[] }[] = []
  const tx: SqlExecutor = {
    execute: (q: SQL) => {
      seen.push(render(q))
      return Promise.resolve({ rows })
    },
  }
  return { tx, seen }
}

const handle = (over: Partial<DirtyWorkHandle> = {}): DirtyWorkHandle => ({
  id: ID,
  owner: 'worker-1',
  fencingEpoch: 3,
  entityKind: 'OPPORTUNITY',
  ...over,
})

describe('enqueueDirty', () => {
  it('reports a returned row as inserted and no row (a duplicate) as a no-op', async () => {
    await expect(
      enqueueDirty(scripted([{ id: ID }]).tx, 'OPPORTUNITY', ENTITY, 2, 'R'),
    ).resolves.toEqual({ inserted: true })
    await expect(enqueueDirty(scripted([]).tx, 'OPPORTUNITY', ENTITY, 2, 'R')).resolves.toEqual({
      inserted: false,
    })
  })

  it('inserts with ON CONFLICT DO NOTHING on the unique key, with the given values', async () => {
    const { tx, seen } = scripted([{ id: ID }])
    await enqueueDirty(tx, 'SOURCE_RECORD', ENTITY, 7, 'SOURCE_REVISION')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.sql).toContain(
      'ON CONFLICT (entity_kind, entity_id, target_version, reason) DO NOTHING',
    )
    expect(seen[0]!.params).toEqual(['SOURCE_RECORD', ENTITY, 7, 'SOURCE_REVISION', null])
    expect(seen[0]!.sql).toContain('target_version, reason, cycle_id)')
  })

  it('carries a given cycle id (CR-M-3)', async () => {
    const { tx, seen } = scripted([{ id: ID }])
    await enqueueDirty(tx, 'SOURCE_RECORD', ENTITY, 7, 'SOURCE_REVISION', ID)
    expect(seen[0]!.params).toEqual(['SOURCE_RECORD', ENTITY, 7, 'SOURCE_REVISION', ID])
  })

  it.each([
    ['a non-uuid cycle id', 'nope'],
    ['a cycle id with a trailing character', `${ID}x`],
  ])('refuses %s before any SQL', async (_label, cycleId) => {
    const { tx, seen } = scripted([{ id: ID }])
    await expect(enqueueDirty(tx, 'OPPORTUNITY', ENTITY, 1, 'R', cycleId)).rejects.toThrow(
      new RangeError('cycleId must be a lowercase uuid'),
    )
    expect(seen).toHaveLength(0)
  })

  it('refuses an unknown kind before any SQL', async () => {
    const { tx, seen } = scripted()
    await expect(enqueueDirty(tx, 'NOPE' as 'OPPORTUNITY', ENTITY, 1, 'R')).rejects.toThrow()
    expect(seen).toHaveLength(0)
  })

  const UUID_MSG = 'entityId must be a lowercase uuid'
  const REASON_MSG = 'reason must be non-blank and at most 100 characters'
  it.each([
    ['a non-uuid entity', 'x', 1, 'R', UUID_MSG],
    ['a uuid with a leading character', `x${ENTITY}`, 1, 'R', UUID_MSG],
    ['a uuid with a trailing character', `${ENTITY}x`, 1, 'R', UUID_MSG],
    ['version 0', ENTITY, 0, 'R', 'version must be an integer in 1..9007199254740991, got 0'],
    [
      'a fractional version',
      ENTITY,
      1.5,
      'R',
      'version must be an integer in 1..9007199254740991, got 1.5',
    ],
    ['a blank reason', ENTITY, 1, '   ', REASON_MSG],
    ['a 101-character reason', ENTITY, 1, 'R'.repeat(101), REASON_MSG],
  ])('refuses %s before any SQL', async (_label, id, version, reason, message) => {
    const { tx, seen } = scripted()
    const err = enqueueDirty(tx, 'OPPORTUNITY', id, version, reason)
    await expect(err).rejects.toThrow(RangeError)
    await expect(err).rejects.toThrow(message)
    expect(seen).toHaveLength(0)
  })

  it('accepts a 100-character reason and version 1', async () => {
    const { tx, seen } = scripted([{ id: ID }])
    await enqueueDirty(tx, 'OPPORTUNITY', ENTITY, 1, 'R'.repeat(100))
    expect(seen).toHaveLength(1)
  })
})

describe('claimDirtyBatch', () => {
  const row = (id: string, epoch: number) => ({
    id,
    entity_kind: 'OPPORTUNITY',
    entity_id: ENTITY,
    target_version: '4',
    reason: 'CANONICAL_REVISION',
    fencing_epoch: String(epoch),
    retry_count: 1,
  })

  it('defaults to a batch of 200 and a five-minute lease, SKIP LOCKED', async () => {
    const { tx, seen } = scripted()
    await claimDirtyBatch(tx, { owner: 'w' })
    expect(seen[0]!.sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(seen[0]!.sql).toContain("WHERE status = 'PENDING'")
    expect(seen[0]!.sql).toContain('fencing_epoch = d.fencing_epoch + 1')
    // Default kinds: exactly those with a version source (CR-M-2); since S5, all five.
    expect(seen[0]!.sql).toContain('AND entity_kind IN ($1, $2, $3, $4, $5)')
    // SFS U10 (CR-M-1 / SPEC-M-2): the generic consumer never sweeps a DETAIL_FETCH row.
    expect(seen[0]!.sql).toContain('AND reason <> $6')
    expect(seen[0]!.params).toEqual([
      'SOURCE_RECORD',
      'OPPORTUNITY',
      'SENIOR',
      'EXCLUSION',
      'PROJECT_CLIENT',
      DETAIL_FETCH,
      200,
      'w',
      300_000,
    ])
  })

  it('passes an explicit batch size and lease', async () => {
    const { tx, seen } = scripted()
    await claimDirtyBatch(tx, { owner: 'w', batchSize: 1000, leaseMs: 3_600_000 })
    expect(seen[0]!.params).toEqual([
      'SOURCE_RECORD',
      'OPPORTUNITY',
      'SENIOR',
      'EXCLUSION',
      'PROJECT_CLIENT',
      DETAIL_FETCH,
      1000,
      'w',
      3_600_000,
    ])
  })

  it('claims only the kinds it is given', async () => {
    const { tx, seen } = scripted()
    await claimDirtyBatch(tx, { owner: 'w', kinds: ['OPPORTUNITY'] })
    expect(seen[0]!.sql).toContain('AND entity_kind IN ($1)')
    // CR-M-1: the DETAIL_FETCH exclusion rides on every generic claim, whatever the kinds.
    expect(seen[0]!.sql).toContain('AND reason <> $2')
    expect(seen[0]!.params).toEqual(['OPPORTUNITY', DETAIL_FETCH, 200, 'w', 300_000])
  })

  it('refuses an empty kind list before any SQL', async () => {
    const { tx, seen } = scripted()
    await expect(claimDirtyBatch(tx, { owner: 'w', kinds: [] })).rejects.toThrow(
      new RangeError('kinds must name at least one kind'),
    )
    expect(seen).toHaveLength(0)
  })

  it.each(['SENIOR', 'EXCLUSION', 'PROJECT_CLIENT'] as const)(
    'S5: claims kind %s now that it has a derived version source',
    async (kind) => {
      const { tx, seen } = scripted()
      await claimDirtyBatch(tx, { owner: 'w', kinds: ['OPPORTUNITY', kind] })
      expect(seen[0]!.params).toEqual(expect.arrayContaining(['OPPORTUNITY', kind]))
    },
  )

  it('S5: claims every kind by default, the derived ones included', () => {
    expect([...CLAIMABLE_KINDS].sort()).toEqual([
      'EXCLUSION',
      'OPPORTUNITY',
      'PROJECT_CLIENT',
      'SENIOR',
      'SOURCE_RECORD',
    ])
  })

  it('refuses an unknown kind before any SQL', async () => {
    const { tx, seen } = scripted()
    await expect(
      claimDirtyBatch(tx, { owner: 'w', kinds: ['NOPE' as 'OPPORTUNITY'] }),
    ).rejects.toThrow()
    expect(seen).toHaveLength(0)
  })

  it.each([
    ['batch 0', { batchSize: 0 }, 'batchSize must be an integer in 1..1000, got 0'],
    [
      'batch above the cap',
      { batchSize: 1001 },
      'batchSize must be an integer in 1..1000, got 1001',
    ],
    ['a fractional batch', { batchSize: 2.5 }, 'batchSize must be an integer in 1..1000, got 2.5'],
    ['lease 0', { leaseMs: 0 }, 'leaseMs must be an integer in 1..3600000, got 0'],
    [
      'a lease above an hour',
      { leaseMs: 3_600_001 },
      'leaseMs must be an integer in 1..3600000, got 3600001',
    ],
  ])('refuses %s before any SQL', async (_label, over, message) => {
    const { tx, seen } = scripted()
    const err = claimDirtyBatch(tx, { owner: 'w', ...over })
    await expect(err).rejects.toThrow(RangeError)
    await expect(err).rejects.toThrow(message)
    expect(seen).toHaveLength(0)
  })

  it.each([
    ['an empty owner', ''],
    ['a 201-character owner', 'o'.repeat(201)],
    ['a non-string owner', 42 as unknown as string],
  ])('refuses %s', async (_label, owner) => {
    const { tx, seen } = scripted()
    const err = claimDirtyBatch(tx, { owner })
    await expect(err).rejects.toThrow(RangeError)
    await expect(err).rejects.toThrow('owner must be 1..200 characters')
    expect(seen).toHaveLength(0)
  })

  it('accepts a 200-character owner', async () => {
    const { tx, seen } = scripted()
    await claimDirtyBatch(tx, { owner: 'o'.repeat(200) })
    expect(seen).toHaveLength(1)
  })

  it('maps rows to numeric handles carrying the owner', async () => {
    const later = '1b6a6f6e-8f43-4c55-9c4a-6c3f3e1f2a10'
    const { tx } = scripted([row(later, 5)])
    const got = await claimDirtyBatch(tx, { owner: 'w' })
    expect(got).toHaveLength(1)
    expect(got[0]).toEqual({
      id: later,
      owner: 'w',
      fencingEpoch: 5,
      entityKind: 'OPPORTUNITY',
      entityId: ENTITY,
      targetVersion: 4,
      reason: 'CANONICAL_REVISION',
      retryCount: 1,
    })
  })
})

describe('completeDirty', () => {
  it('returns DONE / DEFERRED as the statement reports', async () => {
    await expect(completeDirty(scripted([{ status: 'DONE' }]).tx, handle())).resolves.toBe('DONE')
    await expect(completeDirty(scripted([{ status: 'DEFERRED' }]).tx, handle())).resolves.toBe(
      'DEFERRED',
    )
  })

  it('refuses a stale handle (no row) as fenced', async () => {
    await expect(completeDirty(scripted([]).tx, handle())).rejects.toMatchObject({
      name: 'DirtyWorkFencedError',
      code: 'DIRTY_WORK_FENCED',
      message: 'the dirty-work row is not held by this claimer',
    })
  })

  it('names id, owner, epoch, kind, CLAIMED and a live lease, and reads the version by kind', async () => {
    const { tx, seen } = scripted([{ status: 'DONE' }])
    await completeDirty(tx, handle({ entityKind: 'SOURCE_RECORD' }))
    const s = seen[0]!.sql
    expect(s).toContain('FROM job_source_record_heads WHERE source_record_id = w.entity_id')
    expect(s).toContain('claim_owner = $')
    expect(s).toContain('fencing_epoch = $')
    expect(s).toContain("status = 'CLAIMED' AND lease_expires_at > clock_timestamp()")
    expect(seen[0]!.params).toEqual([
      ID,
      'ENTITY_MISSING',
      'VERSION_STALE',
      ID,
      'worker-1',
      3,
      'SOURCE_RECORD',
    ])
  })

  it('reads an opportunity version from job_opportunities.revision', async () => {
    const { tx, seen } = scripted([{ status: 'DONE' }])
    await completeDirty(tx, handle())
    expect(seen[0]!.sql).toContain('SELECT revision FROM job_opportunities WHERE id = w.entity_id')
  })

  it.each(['SENIOR', 'EXCLUSION', 'PROJECT_CLIENT'] as const)(
    'S5: reads kind %s at its derived version: the newest of its own dirty rows',
    async (entityKind) => {
      const { tx, seen } = scripted([{ status: 'DEFERRED' }])
      await expect(completeDirty(tx, handle({ entityKind }))).resolves.toBe('DEFERRED')
      expect(seen[0]!.sql).toContain(
        'SELECT max(d.target_version) FROM job_dirty_work d\n  WHERE d.entity_kind = w.entity_kind AND d.entity_id = w.entity_id',
      )
    },
  )

  it.each([
    ['a non-uuid id', { id: 'nope' }],
    ['an id with a leading character', { id: `x${ID}` }],
    ['an id with a trailing character', { id: `${ID}x` }],
    ['an empty owner', { owner: '' }],
    ['a 201-character owner', { owner: 'o'.repeat(201) }],
    ['a non-string owner', { owner: 42 as unknown as string }],
    ['epoch 0', { fencingEpoch: 0 }],
    ['a fractional epoch', { fencingEpoch: 1.5 }],
  ])('refuses %s as fenced before any SQL', async (_label, over) => {
    const { tx, seen } = scripted([{ status: 'DONE' }])
    const err = completeDirty(tx, handle(over))
    await expect(err).rejects.toBeInstanceOf(DirtyWorkFencedError)
    await expect(err).rejects.toThrow('a malformed dirty-work handle holds nothing')
    expect(seen).toHaveLength(0)
  })

  it('accepts epoch 1 and a 200-character owner', async () => {
    const { tx } = scripted([{ status: 'DONE' }])
    await expect(
      completeDirty(tx, handle({ fencingEpoch: 1, owner: 'o'.repeat(200) })),
    ).resolves.toBe('DONE')
  })
})

describe('failDirty', () => {
  it('maps PENDING to RETRY and FAILED to FAILED', async () => {
    await expect(
      failDirty(scripted([{ status: 'PENDING' }]).tx, handle(), 'HTTP_500'),
    ).resolves.toBe('RETRY')
    await expect(
      failDirty(scripted([{ status: 'FAILED' }]).tx, handle(), 'HTTP_500'),
    ).resolves.toBe('FAILED')
  })

  it('refuses a stale handle', async () => {
    await expect(failDirty(scripted([]).tx, handle(), 'HTTP_500')).rejects.toBeInstanceOf(
      DirtyWorkFencedError,
    )
  })

  it('carries the code and a default budget of 5 attempts', async () => {
    const { tx, seen } = scripted([{ status: 'PENDING' }])
    await failDirty(tx, handle(), 'HTTP_500')
    expect(seen[0]!.params.slice(0, 3)).toEqual([5, 5, 'HTTP_500'])
    expect(seen[0]!.sql).toContain('retry_count = retry_count + 1')
  })

  it('carries an explicit budget', async () => {
    const { tx, seen } = scripted([{ status: 'PENDING' }])
    await failDirty(tx, handle(), 'HTTP_500', { maxAttempts: 20 })
    expect(seen[0]!.params.slice(0, 2)).toEqual([20, 20])
  })

  it('refuses a lowercase code before any SQL', async () => {
    const { tx, seen } = scripted([{ status: 'PENDING' }])
    await expect(failDirty(tx, handle(), 'oops')).rejects.toThrow()
    expect(seen).toHaveLength(0)
  })

  it.each([
    ['budget 0', { maxAttempts: 0 }, 'maxAttempts must be an integer in 1..20, got 0'],
    ['a budget above 20', { maxAttempts: 21 }, 'maxAttempts must be an integer in 1..20, got 21'],
  ])('refuses %s before any SQL', async (_label, opts, message) => {
    const { tx, seen } = scripted([{ status: 'PENDING' }])
    const err = failDirty(tx, handle(), 'HTTP_500', opts)
    await expect(err).rejects.toThrow(RangeError)
    await expect(err).rejects.toThrow(message)
    expect(seen).toHaveLength(0)
  })

  it('refuses a malformed handle before any SQL', async () => {
    const { tx, seen } = scripted([{ status: 'PENDING' }])
    await expect(failDirty(tx, handle({ fencingEpoch: 0 }), 'HTTP_500')).rejects.toBeInstanceOf(
      DirtyWorkFencedError,
    )
    expect(seen).toHaveLength(0)
  })
})

describe('enqueueDerivedDirty (S5, decision D2)', () => {
  /** An executor holding one entity's dirty rows in memory: lock, max, insert. */
  function ledger() {
    const versions: number[] = []
    const seen: string[] = []
    const tx: SqlExecutor = {
      execute: (q: SQL) => {
        const { sql: text, params } = render(q)
        seen.push(text)
        if (text.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [{}] })
        if (text.includes('coalesce(max(target_version), 0)'))
          return Promise.resolve({ rows: [{ v: versions.length ? Math.max(...versions) : 0 }] })
        versions.push(Number(params[2]))
        return Promise.resolve({ rows: [{ id: ID }] })
      },
    }
    return { tx, versions, seen }
  }

  it('locks the entity, reads its version, inserts the next one', async () => {
    const { tx, seen, versions } = ledger()
    await expect(enqueueDerivedDirty(tx, 'SENIOR', ENTITY, 'senior.archive')).resolves.toEqual({
      inserted: true,
      version: 1,
    })
    expect(seen).toHaveLength(3)
    expect(seen[0]).toContain('pg_advisory_xact_lock(hashtextextended(')
    expect(seen[1]).toContain('WHERE entity_kind = $1 AND entity_id = $2::uuid')
    expect(seen[2]).toContain('INSERT INTO job_dirty_work')
    expect(versions).toEqual([1])
  })

  it('names the kind and entity in the lock key', () => {
    const q = render(dirtyWorkStatements.lockDerived('EXCLUSION', ENTITY))
    expect(q.params).toEqual([`job_dirty_work:EXCLUSION:${ENTITY}`])
  })

  it('AC 2 (property): any sequence of enqueues yields strictly increasing versions', async () => {
    const reasons = ['create', 'delete', 'archive', 'restore', 'create', 'create']
    for (let run = 0; run < 25; run += 1) {
      const { tx, versions } = ledger()
      // A pseudo-random sequence of writes, the same reason repeating (same-timestamp updates).
      const n = 1 + ((run * 7) % 13)
      for (let i = 0; i < n; i += 1)
        await enqueueDerivedDirty(
          tx,
          'PROJECT_CLIENT',
          ENTITY,
          reasons[(run + i) % reasons.length]!,
        )
      expect(versions).toEqual(Array.from({ length: n }, (_, i) => i + 1))
    }
  })

  it.each(['SOURCE_RECORD', 'OPPORTUNITY'] as const)(
    'refuses kind %s, which has its own version, before any SQL',
    async (kind) => {
      const { tx, seen } = ledger()
      const err = enqueueDerivedDirty(tx, kind, ENTITY, 'R')
      await expect(err).rejects.toBeInstanceOf(DirtyKindUnsupportedError)
      await expect(err).rejects.toThrow(`dirty work of kind ${kind} has no version source yet`)
      await expect(currentDerivedVersion(tx, kind, ENTITY)).rejects.toMatchObject({
        code: 'DIRTY_KIND_UNSUPPORTED',
      })
      expect(seen).toHaveLength(0)
    },
  )

  it('refuses a malformed entity id before any SQL', async () => {
    const { tx, seen } = ledger()
    await expect(enqueueDerivedDirty(tx, 'SENIOR', 'nope', 'R')).rejects.toThrow(
      new RangeError('entityId must be a lowercase uuid'),
    )
    await expect(currentDerivedVersion(tx, 'SENIOR', `x${ENTITY}`)).rejects.toThrow(
      new RangeError('entityId must be a lowercase uuid'),
    )
    expect(seen).toHaveLength(0)
  })

  it('reads 0 when the aggregate returns no row at all', async () => {
    await expect(currentDerivedVersion(scripted([]).tx, 'SENIOR', ENTITY)).resolves.toBe(0)
  })

  it('reads 0 for an entity with no rows', async () => {
    const { tx } = ledger()
    await expect(currentDerivedVersion(tx, 'EXCLUSION', ENTITY)).resolves.toBe(0)
  })
})

describe('recoverExpiredDirty', () => {
  it('counts requeued and failed rows', async () => {
    const { tx } = scripted([{ status: 'PENDING' }, { status: 'FAILED' }, { status: 'PENDING' }])
    await expect(recoverExpiredDirty(tx)).resolves.toEqual({ requeued: 2, failed: 1 })
  })

  it('bumps the epoch, counts the attempt, defaults to 200 rows and 5 attempts', async () => {
    const { tx, seen } = scripted()
    await expect(recoverExpiredDirty(tx)).resolves.toEqual({ requeued: 0, failed: 0 })
    const s = seen[0]!.sql
    expect(s).toContain("status = 'CLAIMED' AND lease_expires_at <= clock_timestamp()")
    expect(s).toContain('FOR UPDATE SKIP LOCKED')
    expect(s).toContain('fencing_epoch = d.fencing_epoch + 1')
    expect(s).toContain('retry_count = d.retry_count + 1')
    expect(seen[0]!.params).toEqual([200, 5, 5, 'LEASE_EXPIRED'])
  })

  it('carries explicit options and refuses out-of-range ones', async () => {
    const { tx, seen } = scripted()
    await recoverExpiredDirty(tx, { batchSize: 10, maxAttempts: 2 })
    expect(seen[0]!.params).toEqual([10, 2, 2, 'LEASE_EXPIRED'])
    await expect(recoverExpiredDirty(tx, { batchSize: 1001 })).rejects.toThrow(
      new RangeError('batchSize must be an integer in 1..1000, got 1001'),
    )
    await expect(recoverExpiredDirty(tx, { maxAttempts: 21 })).rejects.toThrow(
      new RangeError('maxAttempts must be an integer in 1..20, got 21'),
    )
    expect(seen).toHaveLength(1)
  })
})

describe('dirtyWorkStatements', () => {
  it('claims oldest-first within the batch limit', () => {
    const s = render(dirtyWorkStatements.claim('w', 5, 1000, ['OPPORTUNITY'])).sql
    expect(s).toContain('ORDER BY created_at, id')
    expect(s).toContain("SET status = 'CLAIMED'")
  })
})

/** SFS U10: the DETAIL_FETCH reason and the source-filtered claim statement. */
describe('DETAIL_FETCH source-filtered claim (U10)', () => {
  it('names the detail-fetch reason', () => {
    expect(DETAIL_FETCH).toBe('DETAIL_FETCH')
  })

  it('filters to one source by type + namespace, oldest-first, within the batch limit', () => {
    const { sql: s, params } = render(
      dirtyWorkStatements.claimDetailForSource('w', 'GREENHOUSE_ATS', 'acme-board', 5, 1000),
    )
    expect(s).toContain('JOIN job_source_records sr ON sr.id = d.entity_id')
    expect(s).toContain("d.entity_kind = 'SOURCE_RECORD'")
    expect(s).toContain('d.reason = $')
    expect(s).toContain('sr.source_type = $')
    expect(s).toContain('::job_source_type')
    expect(s).toContain('sr.namespace = $')
    expect(s).toContain('ORDER BY d.created_at, d.id')
    expect(s).toContain('FOR UPDATE OF d SKIP LOCKED')
    expect(s).toContain("SET status = 'CLAIMED'")
    expect(s).toContain('fencing_epoch = d.fencing_epoch + 1')
    // The reason, type and namespace are bound params (never inlined).
    expect(params).toContain('DETAIL_FETCH')
    expect(params).toContain('GREENHOUSE_ATS')
    expect(params).toContain('acme-board')
  })

  it('validates its arguments before touching the database', async () => {
    const src = { type: 'GREENHOUSE_ATS', namespace: 'x' } as const
    // A blank owner, a non-string namespace, and out-of-range batch/lease each throw by name.
    await expect(
      claimDetailFetchForSource(scripted().tx, { owner: '', source: src }),
    ).rejects.toThrow(RangeError)
    await expect(
      claimDetailFetchForSource(scripted().tx, {
        owner: 'w',
        source: { type: 'GREENHOUSE_ATS', namespace: 42 as unknown as string },
      }),
    ).rejects.toThrow(/namespace must be a string/)
    await expect(
      claimDetailFetchForSource(scripted().tx, { owner: 'w', source: src, batchSize: 0 }),
    ).rejects.toThrow(/batchSize must be an integer/)
    await expect(
      claimDetailFetchForSource(scripted().tx, { owner: 'w', source: src, leaseMs: 0 }),
    ).rejects.toThrow(/leaseMs must be an integer/)
  })

  it('maps the claimed rows to handles', async () => {
    const { tx } = scripted([
      {
        id: ID,
        entity_kind: 'SOURCE_RECORD',
        entity_id: ENTITY,
        target_version: 3,
        reason: DETAIL_FETCH,
        fencing_epoch: 2,
        retry_count: 0,
      },
    ])
    const claimed = await claimDetailFetchForSource(tx, {
      owner: 'w',
      source: { type: 'GREENHOUSE_ATS', namespace: 'acme-board' },
    })
    expect(claimed).toEqual([
      {
        id: ID,
        owner: 'w',
        fencingEpoch: 2,
        entityKind: 'SOURCE_RECORD',
        entityId: ENTITY,
        targetVersion: 3,
        reason: DETAIL_FETCH,
        retryCount: 0,
      },
    ])
  })
})
